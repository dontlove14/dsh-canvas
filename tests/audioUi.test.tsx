// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ReactFlowProvider } from '@xyflow/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AudioPlayer, AudioWaveform } from '../src/client/AudioPlayer'
import { AudioNode } from '../src/client/AudioNode'
import { FloatingEditor } from '../src/client/Canvas'
import { CanvasApi } from '../src/client/api'
import { defaultParams, emptyGraph, type Asset, type CanvasNode } from '../src/shared/contracts'
import { MOCK_MODELS } from '../src/shared/mockModels'
import { nodeEditorVisible } from '../src/client/generationLayout'

const roots: Root[] = []
afterEach(() => {
  act(() => { for (const root of roots.splice(0)) root.unmount() })
  document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
function render(element: React.ReactNode) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container); roots.push(root)
  act(() => root.render(element))
  return { root, container }
}
const asset: Asset = { id: '00000000-0000-4000-a000-000000000014', kind: 'audio', mime: 'audio/wav', filename: 'music.wav', bytes: 100, createdAt: 0, nodeId: null, taskId: null }
describe('audio controls and compact generation editor', () => {
  it('renders measured bars, played highlights and a proportional playhead', () => {
    const peaks = Array.from({ length: 96 }, (_, i) => i / 95)
    const { container } = render(<AudioWaveform peaks={peaks} time={15} duration={30} onSeek={() => {}} onToggle={() => {}} />)
    expect(container.querySelectorAll('rect')).toHaveLength(96)
    expect(container.querySelectorAll('.played')).toHaveLength(48)
    expect(Number(container.querySelectorAll('rect')[0].getAttribute('height'))).toBeLessThan(Number(container.querySelectorAll('rect')[95].getAttribute('height')))
    expect(container.querySelector('line')?.getAttribute('x1')).toBe('160')
    expect(container.querySelector('[role="slider"]')?.getAttribute('aria-valuetext')).toBe('00:15 / 00:30')
  })
  it('seeks with pointer dragging and keyboard, clamps edges and isolates canvas keys', () => {
    const onSeek = vi.fn(), onToggle = vi.fn(), canvasKey = vi.fn()
    const { container } = render(<AudioWaveform peaks={[.2, .8]} time={15} duration={30} onSeek={onSeek} onToggle={onToggle} />)
    const slider = container.querySelector<HTMLDivElement>('[role="slider"]')!
    vi.spyOn(slider, 'getBoundingClientRect').mockReturnValue({ left: 10, width: 300 } as DOMRect)
    const pointer = (type: string, x: number) => {
      const event = new Event(type, { bubbles: true, cancelable: true })
      Object.defineProperties(event, { clientX: { value: x }, button: { value: 0 }, pointerId: { value: 1 } })
      act(() => { slider.dispatchEvent(event) })
    }
    pointer('pointerdown', 160); expect(onSeek).toHaveBeenLastCalledWith(15)
    pointer('pointermove', 400); expect(onSeek).toHaveBeenLastCalledWith(30)
    pointer('pointerup', 400); pointer('pointermove', 10)
    expect(onSeek).toHaveBeenCalledTimes(2)
    window.addEventListener('keydown', canvasKey)
    for (const key of ['ArrowRight', 'Home', 'End', ' ']) act(() => { slider.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })) })
    window.removeEventListener('keydown', canvasKey)
    expect(onSeek.mock.calls.slice(-3).map((call) => call[0])).toEqual([20, 0, 30])
    expect(onToggle).toHaveBeenCalledTimes(1); expect(canvasKey).not.toHaveBeenCalled()
  })
  it('uses real metadata/custom controls, pauses on deactivation and ignores waveform results after unmount', async () => {
    let resolveWave!: (value: any) => void
    const api = new CanvasApi()
    const load = vi.spyOn(api, 'waveform').mockReturnValue(new Promise((resolve) => { resolveWave = resolve }))
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
    const onPlay = vi.fn()
    const { root, container } = render(<AudioPlayer asset={asset} api={api} workspace="w" label="音乐" active onPlay={onPlay} />)
    const audio = container.querySelector('audio')!
    expect(audio.hasAttribute('controls')).toBe(false)
    Object.defineProperties(audio, { duration: { value: 6, configurable: true }, currentTime: { value: 1, configurable: true, writable: true } })
    act(() => { audio.dispatchEvent(new Event('loadedmetadata')) })
    expect(container.textContent).toContain('00:01'); expect(container.textContent).toContain('00:06')
    act(() => { container.querySelector<HTMLButtonElement>('button')!.click() })
    expect(onPlay).toHaveBeenCalledTimes(1); expect(play).toHaveBeenCalledTimes(1)
    act(() => root.render(<AudioPlayer asset={asset} api={api} workspace="w" label="音乐" active={false} onPlay={onPlay} />))
    expect(audio.pause).toHaveBeenCalled()
    act(() => root.unmount()); roots.pop()
    expect(load.mock.calls[0][2]?.aborted).toBe(true)
    await act(async () => { resolveWave({ version: 1, duration: 6, peaks: Array(96).fill(.5) }); await Promise.resolve() })
    expect(container.children).toHaveLength(0)
  })
  it('mounts the waveform audio card with one output and updates its fixed geometry', async () => {
    vi.stubGlobal('IntersectionObserver', class {
      constructor(private notify: (entries: Array<{ isIntersecting: boolean }>) => void) {}
      observe() { this.notify([{ isIntersecting: true }]) }; disconnect() {}
    })
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    const api = new CanvasApi()
    vi.spyOn(api, 'waveform').mockResolvedValue({ version: 1, duration: 6, peaks: Array(96).fill(.5) })
    const onSize = vi.fn()
    const node: CanvasNode = { id: crypto.randomUUID(), kind: 'audio-asset', title: '音乐', position: { x: 0, y: 0 }, assetId: asset.id, selectedResultId: null, modelId: null, prompt: '', params: null }
    const { container } = render(<ReactFlowProvider><AudioNode node={node} asset={asset} api={api} workspace="w" selected={false} playing={false}
      onPlay={() => {}} onStop={() => {}} onRename={() => {}} onSize={onSize} /></ReactFlowProvider>)
    await act(async () => { await Promise.resolve() })
    expect(container.querySelector('.dc-audio-node')).toBeTruthy()
    expect(container.querySelector('.dc-node-heading')).toBeNull(); expect(container.querySelector('.dc-node-foot')).toBeNull()
    expect(container.querySelectorAll('.react-flow__handle-right')).toHaveLength(1)
    expect(container.querySelectorAll('.react-flow__handle-left')).toHaveLength(0)
    expect(container.querySelectorAll('rect')).toHaveLength(96)
    expect(onSize).toHaveBeenCalledWith(node.id, 360, 180)
  })
  it.each(['image', 'video'] as const)('ends the %s editor at the parameter controls even after task success', (kind) => {
    vi.stubGlobal('ResizeObserver', class { observe() {}; disconnect() {} })
    const model = MOCK_MODELS.find((model) => model.kind === kind)!
    const node: CanvasNode = { id: crypto.randomUUID(), kind: `${kind}-generation`, title: '生成', position: { x: 0, y: 0 }, modelId: model.id, prompt: '画面', params: defaultParams(model), assetId: null, selectedResultId: null }
    const graph = { ...emptyGraph(), nodes: [node] }
    const task = { id: crypto.randomUUID(), nodeId: node.id, workspaceId: 'w', status: 'completed' as const, resultIds: [], createdAt: 1, updatedAt: 1 }
    const noop = () => {}
    const { container } = render(<ReactFlowProvider><FloatingEditor node={node} graph={graph} assets={[]} tasks={[task]} models={MOCK_MODELS} api={new CanvasApi()} workspace="w"
      container={{ current: null }} patchNode={noop} edit={noop} generate={async () => {}} report={noop} uploading={false} submitting={false}
      askImport={noop} taskAction={async () => {}} onOpen={noop} onResult={noop} /></ReactFlowProvider>)
    expect(container.querySelector('.dc-task-details')).toBeNull()
    expect(container.querySelector('.dc-editor')?.lastElementChild?.className).toBe('dc-editor-bottom')
    expect(container.querySelector('.dc-editor-bottom [aria-label="生成"]')).toBeTruthy()
    expect(nodeEditorVisible({ ...node, kind: 'audio-asset', assetId: asset.id }, asset, false)).toBe(false)
  })
})
