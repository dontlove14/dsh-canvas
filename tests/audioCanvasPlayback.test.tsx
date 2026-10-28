// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ReactFlowProvider } from '@xyflow/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CanvasWorkspace } from '../src/client/Canvas'
import { CanvasApi } from '../src/client/api'
import { defaultTtsParams, emptyGraph, FISH_TTS_ENDPOINT, type Asset, type CanvasNode } from '../src/shared/contracts'
import type { CanvasSnapshot } from '../src/shared/v2'

// Stand in only for canvas layout/gestures. Workspace selection and playback,
// media nodes, controllers, buttons, state loading and media events stay real.
vi.mock('@xyflow/react', async (importOriginal) => {
  const original = await importOriginal<typeof import('@xyflow/react')>()
  return {
    ...original,
    Background: () => null, Controls: () => null, MiniMap: () => null,
    ReactFlow: ({ nodes, nodeTypes, children, onPaneClick }: any) => <div data-test-pane onClick={(event) => {
      if (event.target === event.currentTarget) onPaneClick()
    }}>
      {nodes.map((node: any) => {
        const Component = nodeTypes[node.type]
        return <div key={node.id} data-test-node={node.id}><Component id={node.id} data={node.data} selected={node.selected} /></div>
      })}
      {children}
    </div>,
  }
})
vi.mock('../src/client/useGpu', () => ({ useGpuCapability: () => ({ enabled: false, reason: 'test' }) }))
const roots: Root[] = []
afterEach(() => {
  act(() => { for (const root of roots.splice(0)) root.unmount() })
  document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
async function setup(tts = false, history = false) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private notify: (entries: Array<{ isIntersecting: boolean }>) => void) {}
    observe() { this.notify([{ isIntersecting: true }]) }; disconnect() {}
  })
  vi.stubGlobal('ResizeObserver', class { observe() {}; disconnect() {} })
  const paused = new WeakMap<HTMLMediaElement, boolean>()
  vi.spyOn(HTMLMediaElement.prototype, 'paused', 'get').mockImplementation(function () { return paused.get(this) ?? true })
  const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async function () {
    paused.set(this, false); this.dispatchEvent(new Event('play'))
  })
  const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function () {
    if (paused.get(this) === false) { paused.set(this, true); this.dispatchEvent(new Event('pause')) }
  })
  const nodes: CanvasNode[] = ['音乐A', '音乐B'].map((title) => ({
    id: crypto.randomUUID(), kind: 'audio-asset', title, position: { x: 0, y: 0 }, modelId: null,
    prompt: '', params: null, assetId: crypto.randomUUID(), selectedResultId: null,
  }))
  const assets: Asset[] = nodes.map((node) => ({
    id: node.assetId!, kind: 'audio', mime: 'audio/wav', filename: 'music.wav', bytes: 100,
    createdAt: 1, nodeId: node.id, taskId: null,
  }))
  if (tts) for (const node of nodes) { node.kind = 'tts-generation'; node.assetId = null; node.params = defaultTtsParams(); node.prompt = '(happy) 你好' }
  if (history) assets.push({ ...assets[0], id: crypto.randomUUID(), nodeId: nodes[0].id })
  const snapshot: CanvasSnapshot = {
    version: 1, workspaceId: 'w', graphRevision: 1, graph: { ...emptyGraph(), nodes }, assets, tasks: tts ? nodes.map((node, index) => ({
      id: crypto.randomUUID(), nodeId: node.id, workspaceId: 'w', status: 'completed' as const, resultIds: [assets[index].id], createdAt: 1, updatedAt: 1,
    })) : [],
    updatedAt: 1, commitHash: 'a'.repeat(64), hashes: { nodes: {}, edges: {}, viewport: '' },
  }
  if (history) snapshot.tasks.push({ id: crypto.randomUUID(), nodeId: nodes[0].id, workspaceId: 'w', status: 'completed',
    resultIds: [assets[2].id], createdAt: 2, updatedAt: 2 })
  const api = new CanvasApi()
  vi.spyOn(api, 'state').mockResolvedValue(snapshot)
  vi.spyOn(api, 'models').mockResolvedValue([])
  vi.spyOn(api, 'ttsSettings').mockResolvedValue({ endpoint: FISH_TTS_ENDPOINT, revision: 0, configured: false, has_api_key: false, api_key_mask: '' })
  vi.spyOn(api, 'taskDetail').mockImplementation(async (_canvas, id) => {
    const task = snapshot.tasks.find((task) => task.id === id)!
    return { task: { ...task, snapshot: { model: { id: crypto.randomUUID(), kind: 'audio', name: 'FishTTS', model_id: 'fish-tts',
      protocol: 'fish-tts', api_base: FISH_TTS_ENDPOINT }, prompt: '(happy) 你好', params: defaultTtsParams(), referenceIds: [] } } } as any
  })
  vi.spyOn(api, 'waveform').mockResolvedValue({ version: 1, duration: 10, peaks: Array(96).fill(.5) })
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container); roots.push(root)
  const show = async (active: boolean) => act(async () => {
    root.render(<ReactFlowProvider><CanvasWorkspace api={api} active={active} workspace="w" title="测试画布" onBack={() => {}} /></ReactFlowProvider>)
    await Promise.resolve()
  })
  await show(true)
  const cards = nodes.map((node) => container.querySelector<HTMLDivElement>(`[data-test-node="${node.id}"]`)!)
  const audio = cards.map((card) => card.querySelector<HTMLAudioElement>('audio')!)
  act(() => {
    for (const element of audio) {
      Object.defineProperties(element, { duration: { value: 10, configurable: true }, currentTime: { value: 0, configurable: true, writable: true } })
      element.dispatchEvent(new Event('loadedmetadata'))
    }
  })
  const click = (index: number) => act(() => { cards[index].querySelector<HTMLButtonElement>('.dc-audio-toggle')!.click() })
  return { container, cards, audio, click, pause, play, show, api }
}
describe('canvas-owned audio playback', () => {
  it('plays one expanded TTS history result at a time and stops on collapse or hiding without losing historical audio', async () => {
    const { container, cards, click, show } = await setup(true, true)
    click(0)
    act(() => cards[0].querySelector<HTMLButtonElement>('button[title="展开提交记录"]')!.click())
    const audio = [...cards[0].querySelectorAll<HTMLAudioElement>('audio')]
    expect(audio).toHaveLength(2)
    act(() => {
      for (const element of audio) {
        Object.defineProperties(element, { duration: { value: 10, configurable: true }, currentTime: { value: 0, configurable: true, writable: true } })
        element.dispatchEvent(new Event('loadedmetadata'))
      }
    })
    const buttons = [...cards[0].querySelectorAll<HTMLButtonElement>('.dc-audio-toggle')]
    act(() => buttons[0].click()); expect(audio[0].paused).toBe(false)
    act(() => buttons[1].click()); expect(audio[0].paused).toBe(true); expect(audio[1].paused).toBe(false)
    expect(cards[0].querySelectorAll('.react-flow__handle.source')).toHaveLength(2)
    expect(cards[0].textContent).not.toContain('设为主图')
    await show(false)
    expect(audio[1].paused).toBe(true); expect(cards[0].querySelectorAll('audio')).toHaveLength(2)
    await show(true)
    expect(audio.every((element) => element.paused)).toBe(true)
    act(() => buttons[1].click()); expect(audio[1].paused).toBe(false)
    await act(async () => [...cards[0].querySelectorAll<HTMLButtonElement>('.dc-group-actions button')].find((button) => button.textContent === '收起')!.click())
    expect(audio[1].paused).toBe(true)
    expect(cards[0].querySelectorAll('audio')).toHaveLength(1)
    expect(container.querySelector('.dc-editor')).toBeNull()
    await act(async () => cards[0].querySelector<HTMLElement>('.dc-history-card')!.click())
    expect(container.querySelector('.dc-tts-editor')).toBeTruthy()
  })
  it('loads FishTTS readiness into the actual editor and refreshes it when the retained canvas becomes visible', async () => {
    const { container, click, show, api } = await setup(true)
    click(0)
    const textBefore = container.querySelector('[role="textbox"]')!.textContent
    expect(container.querySelector('.dc-tts-configuration')!.textContent).toBe('请前往设置页面配置模型')
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="生成语音"]')!.disabled).toBe(true)
    vi.mocked(api.ttsSettings).mockResolvedValue({ endpoint: FISH_TTS_ENDPOINT, revision: 1, configured: true, has_api_key: true, api_key_mask: '••••••••' })
    await show(false); await show(true)
    expect(container.querySelector('.dc-tts-configuration')).toBeNull()
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="生成语音"]')!.disabled).toBe(false)
    vi.mocked(api.ttsSettings).mockResolvedValue({ endpoint: FISH_TTS_ENDPOINT, revision: 2, configured: true, has_api_key: false, api_key_mask: '' })
    await show(false); await show(true)
    expect(container.querySelector('.dc-tts-configuration')!.textContent).toBe('请前往设置页面配置模型')
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="生成语音"]')!.disabled).toBe(true)
    expect(container.querySelector('[role="textbox"]')!.textContent).toBe(textBefore)
    expect(api.state).toHaveBeenCalledTimes(1)
  })
  it.each([false, true])('pauses a hidden retained sidebar (TTS=%s), keeps selection and audio DOM, and does not reload the graph or autoplay on return', async (tts) => {
    const { container, cards, audio, click, show, api } = await setup(tts)
    click(0)
    expect(audio[0].paused).toBe(false)
    await show(false)
    expect(audio[0].paused).toBe(true)
    expect(container.querySelector('.dc-editor')).toBeNull()
    expect(cards[0].querySelector('.selected')).toBeTruthy()
    expect(container.querySelector('audio')).toBe(audio[0])
    const chat = document.createElement('div'); document.body.append(chat)
    const chatSpace = new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true, cancelable: true })
    act(() => { chat.dispatchEvent(chatSpace) })
    expect(chatSpace.defaultPrevented).toBe(false)
    await show(true)
    expect(api.state).toHaveBeenCalledTimes(1)
    expect(container.querySelector('audio')).toBe(audio[0])
    expect(audio[0].paused).toBe(true)
    const visibleChatSpace = new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true, cancelable: true })
    act(() => { chat.dispatchEvent(visibleChatSpace) })
    expect(visibleChatSpace.defaultPrevented).toBe(false)
    const canvasSpace = new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true, cancelable: true })
    act(() => { container.querySelector('.dc-canvas-area')!.dispatchEvent(canvasSpace) })
    expect(canvasSpace.defaultPrevented).toBe(true)
    click(0); expect(audio[0].paused).toBe(false)
  })
  it('renders TTS results with only an output, preserves audio playback and keeps the text editor without model choices', async () => {
    const { container, cards, audio, click } = await setup(true)
    expect(cards[0].querySelector('.react-flow__handle.source')).toBeTruthy()
    expect(cards[0].querySelector('.react-flow__handle.target')).toBeNull()
    click(0); expect(audio[0].paused).toBe(false)
    expect(container.querySelector('.dc-tts-editor [role="textbox"]')?.getAttribute('aria-label')).toBe('文字内容')
    expect(container.querySelector('.dc-tts-editor [role="combobox"]')).toBeNull()
    expect(cards[0].querySelector('.dc-tts-audio-badge')).toBeTruthy()
    act(() => { audio[0].currentTime = 2; audio[0].dispatchEvent(new Event('timeupdate')) })
    expect(audio[0].paused).toBe(false)
    click(1); expect(audio[0].paused).toBe(true); expect(audio[1].paused).toBe(false)
  })
  it('keeps audio playing when its button is clicked directly on an unselected node', async () => {
    const { cards, audio, click, pause, play } = await setup()
    expect(cards[0].querySelector('.selected')).toBeNull()
    const initialPauses = pause.mock.calls.length
    click(0)
    expect(play).toHaveBeenCalledTimes(1)
    expect(audio[0].paused).toBe(false)
    expect(cards[0].querySelector('.selected')).toBeTruthy()
    for (const time of [.25, 1, 3]) act(() => {
      audio[0].currentTime = time; audio[0].dispatchEvent(new Event('timeupdate'))
    })
    expect(audio[0].paused).toBe(false)
    expect(pause.mock.calls.length).toBe(initialPauses)
    expect(cards[0].textContent).toContain('00:03')
    expect(cards[0].querySelector('.dc-audio-toggle')?.getAttribute('aria-label')).toBe('暂停音频')
    click(0); expect(audio[0].paused).toBe(true)
  })
  it('switches the active audio, stops on a pane click and allows replay after ended', async () => {
    const { container, audio, click } = await setup()
    click(0); click(1)
    expect(audio[0].paused).toBe(true); expect(audio[1].paused).toBe(false)
    act(() => { container.querySelector<HTMLDivElement>('[data-test-pane]')!.click() })
    expect(audio[1].paused).toBe(true)
    click(1)
    expect(audio[1].paused).toBe(false)
    act(() => { audio[1].pause(); audio[1].dispatchEvent(new Event('ended')) })
    expect(audio[1].paused).toBe(true)
    click(1); expect(audio[1].paused).toBe(false)
  })
})
