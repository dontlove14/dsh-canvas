// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ReactFlowProvider } from '@xyflow/react'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FloatingEditor } from '../src/client/Canvas'
import { ResourceNode } from '../src/client/ResourceNode'
import { AudioNode } from '../src/client/AudioNode'
import { CanvasApi } from '../src/client/api'
import { defaultParams, defaultTtsParams, emptyGraph, type Asset, type CanvasNode } from '../src/shared/contracts'
import { NODE_OVERLAY_STYLE } from '../src/client/nodeOverlayLayout'
import { BUILTIN_MODELS } from '../src/shared/modelCatalog'
import { MOCK_MODELS } from '../src/shared/mockModels'

let viewport = { x: 0, y: 0, zoom: 1 }
const toolbarProps: Array<Record<string, any>> = []
const resizeCallbacks: Array<() => void> = []
vi.mock('@xyflow/react', async (original) => ({
  ...await original<typeof import('@xyflow/react')>(),
  useViewport: () => viewport,
  NodeToolbar: ({ children, ...props }: { children: ReactNode; [key: string]: any }) => {
    toolbarProps.push(props)
    return <div data-test-toolbar style={props.style}>{children}</div>
  },
}))
const roots: Root[] = []
beforeEach(() => {
  viewport = { x: 0, y: 0, zoom: 1 }; toolbarProps.length = 0; resizeCallbacks.length = 0
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resizeCallbacks.push(callback) }; observe() {}; disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private notify: (entries: Array<{ isIntersecting: boolean }>) => void) {}
    observe() { this.notify([{ isIntersecting: true }]) }; disconnect() {}
  })
})
afterEach(() => { act(() => roots.splice(0).forEach((root) => root.unmount())); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
function mount(element: ReactNode, container = document.createElement('div')) {
  document.body.append(container)
  const root = createRoot(container); roots.push(root)
  act(() => root.render(<ReactFlowProvider>{element}</ReactFlowProvider>))
  return { root, container }
}
const noop = () => {}
function node(kind: CanvasNode['kind']): CanvasNode {
  return { id: crypto.randomUUID(), kind, title: '节点', position: { x: 750, y: 1000 }, modelId: null,
    prompt: '原有文字', params: kind === 'tts-generation' ? defaultTtsParams() : { size: '1024x1024', n: 1 }, assetId: null, selectedResultId: null }
}
describe('node-anchored attachments', () => {
  it.each(['image-generation', 'video-generation'] as const)('keeps %s editing and generation available during earlier tasks, locking only the dispatch window', (kind) => {
    const model = MOCK_MODELS.find((model) => model.kind === kind.split('-')[0])!
    const value = { ...node(kind), modelId: model.id, params: defaultParams(model) }
    const task = { id: crypto.randomUUID(), nodeId: value.id, workspaceId: 'w', status: 'generating' as const, createdAt: 1, updatedAt: 1, resultIds: [] }
    const props = { node: value, graph: { ...emptyGraph(), nodes: [value] }, assets: [], tasks: [task], models: [model], api: new CanvasApi(), workspace: 'w',
      ttsConfigured: false, ttsConfigurationError: false, onResult: noop, patchNode: vi.fn(), edit: noop, report: noop, generate: vi.fn(async () => {}),
      uploading: false, askImport: noop, taskAction: async () => {}, onOpen: noop }
    const { root, container } = mount(<FloatingEditor {...props} submitting={false} />)
    expect(container.querySelector('[role="textbox"]')?.getAttribute('contenteditable')).toBe('true')
    expect(container.querySelector<HTMLButtonElement>('[aria-label="生成"]')!.disabled).toBe(false)
    act(() => root.render(<ReactFlowProvider><FloatingEditor {...props} submitting /></ReactFlowProvider>))
    expect(container.querySelector('[role="textbox"]')?.getAttribute('contenteditable')).toBe('false')
    expect(container.querySelector<HTMLButtonElement>('[aria-label="生成"]')!.disabled).toBe(true)
  })
  it.each(['image-generation', 'video-generation', 'tts-generation'] as const)('keeps the %s editor below its node through resizing, content growth, pan and zoom', (kind) => {
    const value = node(kind), before = JSON.stringify(value), patch = vi.fn(), host = document.createElement('div')
    let screenWidth = 1000, screenHeight = 700, panelHeight = 300
    Object.defineProperties(host, { clientWidth: { get: () => screenWidth }, clientHeight: { get: () => screenHeight } })
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(() => panelHeight)
    const graph = { ...emptyGraph(), nodes: [value] }
    const props = { node: value, graph, assets: [], tasks: [], models: [], api: new CanvasApi(), workspace: 'w',
      container: { current: host }, nodeSize: { width: 320, height: 180 }, ttsConfigured: true, ttsConfigurationError: false,
      onResult: noop, patchNode: patch, edit: noop, report: noop, generate: async () => {}, uploading: false, submitting: false,
      askImport: noop, taskAction: async () => {}, onOpen: noop }
    const view = (prompt = value.prompt) => <FloatingEditor {...props} node={{ ...value, prompt }} />
    const { root, container } = mount(view(), host)
    const position = () => {
      const editor = container.querySelector<HTMLElement>('.dc-editor')!
      return [editor.style.left, editor.style.top, editor.style.width]
    }
    expect(position()).toEqual(['645px', '1198px', '530px'])
    screenWidth = 220; screenHeight = 180; panelHeight = 2000
    act(() => { window.dispatchEvent(new Event('resize')); resizeCallbacks.forEach((callback) => callback()) })
    act(() => root.render(<ReactFlowProvider>{view('长文字'.repeat(500))}</ReactFlowProvider>))
    expect(position()).toEqual(['645px', '1198px', '530px'])
    viewport = { x: -1800, y: -2400, zoom: 2 }
    act(() => root.render(<ReactFlowProvider>{view()}</ReactFlowProvider>))
    expect(position()).toEqual(['-245px', '-22px', '530px'])
    expect(JSON.stringify(value)).toBe(before); expect(patch).not.toHaveBeenCalled()
  })
  it.each(['image-generation', 'video-generation'] as const)('shows the settings prompt for every unconfigured %s editor without filling a model', (kind) => {
    const value = node(kind), patch = vi.fn(), generate = vi.fn(async () => {})
    const props = { graph: emptyGraph(), assets: [], tasks: [], models: [], api: new CanvasApi(), workspace: 'w',
      ttsConfigured: false, ttsConfigurationError: false, onResult: noop, patchNode: patch, edit: noop, report: noop,
      generate, uploading: false, submitting: false, askImport: noop, taskAction: async () => {}, onOpen: noop }
    const { root, container } = mount(<FloatingEditor {...props} node={value} />)
    for (const modelId of [null, BUILTIN_MODELS[0].id, MOCK_MODELS.find((model) => model.kind === kind.split('-')[0])!.id]) {
      const saved = { ...value, modelId, params: modelId ? value.params : null }, before = JSON.stringify(saved)
      act(() => root.render(<ReactFlowProvider><FloatingEditor {...props} node={saved} /></ReactFlowProvider>))
      const picker = container.querySelector<HTMLButtonElement>('[aria-label="生成模型"]')!
      expect(picker.querySelector('span')!.textContent).toBe('请前往设置页面配置模型')
      expect(picker.disabled).toBe(true)
      expect(container.querySelector<HTMLButtonElement>('[aria-label="生成"]')!.disabled).toBe(true)
      expect(container.querySelector('.dc-model-picker')).toBeNull()
      expect(container.textContent).not.toContain('Mock')
      act(() => { picker.click(); container.querySelector<HTMLButtonElement>('[aria-label="生成"]')!.click() })
      expect(document.querySelector('[role="dialog"]')).toBeNull()
      expect(JSON.stringify(saved)).toBe(before)
    }
    expect(patch).not.toHaveBeenCalled(); expect(generate).not.toHaveBeenCalled()
  })
  it.each(['image', 'video', 'audio'] as const)('keeps the %s action bar at the top of the node with a fixed layer', async (kind) => {
    const value = node(`${kind}-asset`), asset: Asset = { id: crypto.randomUUID(), kind, mime: kind === 'image' ? 'image/png' : kind === 'video' ? 'video/mp4' : 'audio/wav',
      filename: '原文件', bytes: 100, createdAt: 1, nodeId: value.id, taskId: null, width: 1024, height: 1024 }
    const api = new CanvasApi()
    vi.spyOn(api, 'waveform').mockResolvedValue({ version: 1, duration: 10, peaks: Array(96).fill(.5) })
    const common = { node: value, asset, selected: true, api, workspace: 'w', playing: false,
      onPlay: noop, onStop: noop, onRename: noop, onSize: noop }
    mount(kind === 'audio' ? <AudioNode {...common} /> : <ResourceNode {...common} rotation={0} onRotate={noop} onOpen={noop} onFocus={noop} />)
    await act(async () => { await Promise.resolve() })
    expect(toolbarProps.at(-1)).toMatchObject({ position: 'top', align: 'end', offset: 42, style: NODE_OVERLAY_STYLE })
    expect(toolbarProps.at(-1)!.style.zIndex).toBe('var(--dc-node-overlay-layer)')
  })
  it('places attachments below both fixed control bars and removes viewport height constraints', () => {
    const css = readFileSync('src/client/styles.css', 'utf8')
    const area = css.match(/\.dc-canvas-area\{([^}]+)\}/)![1]
    const overlay = Number(area.match(/--dc-node-overlay-layer:(\d+)/)![1])
    const tools = Number(area.match(/--dc-canvas-tools-layer:(\d+)/)![1])
    expect(overlay).toBeLessThan(tools)
    const editor = css.match(/\.dc-editor\{([^}]+)\}/)![1]
    expect(editor).toContain('z-index:var(--dc-node-overlay-layer)')
    expect(editor).toContain('max-height:none'); expect(editor).toContain('overflow:visible')
    for (const selector of [/\.dc-tools\{([^}]+)\}/, /\.dc-canvas-area \.react-flow__controls\{([^}]+)\}/]) {
      expect(css.match(selector)![1]).toContain('z-index:var(--dc-canvas-tools-layer)')
    }
    expect(css).not.toMatch(/\.dc-editor\{[^}]*max-height:calc\(/)
  })
})
