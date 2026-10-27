// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ReactFlowProvider } from '@xyflow/react'
import { XYDrag, type InternalNodeBase, type NodeBase } from '@xyflow/system'
import { afterEach, expect, it, vi } from 'vitest'
import { AudioNode } from '../src/client/AudioNode'
import { CanvasApi } from '../src/client/api'
import type { Asset, CanvasNode } from '../src/shared/contracts'
import type { AudioWaveform } from '../src/shared/audioWaveform'

let root: Root | undefined
let driver: ReturnType<typeof XYDrag> | undefined
afterEach(() => {
  driver?.destroy(); driver = undefined
  act(() => root?.unmount()); root = undefined
  document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
it.each([['audio-asset', 1], ['tts-generation', 2]] as const)(
  'drags %s from footer whitespace and timestamps at zoom %s while isolating seek and playback',
  async (kind, zoom) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal('IntersectionObserver', class {
      constructor(private notify: (entries: Array<{ isIntersecting: boolean }>) => void) {}
      observe() { this.notify([{ isIntersecting: true }]) }; disconnect() {}
    })
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
    const api = new CanvasApi()
    let resolveWave!: (value: AudioWaveform) => void
    vi.spyOn(api, 'waveform').mockReturnValue(new Promise((resolve) => { resolveWave = resolve }))
    const asset: Asset = { id: crypto.randomUUID(), kind: 'audio', mime: 'audio/wav', filename: 'test.wav', bytes: 100, duration: 6, createdAt: 0, nodeId: null, taskId: null }
    const node: CanvasNode = { id: crypto.randomUUID(), kind, title: '音频', position: { x: 0, y: 0 },
      assetId: kind === 'audio-asset' ? asset.id : null, selectedResultId: null, modelId: null,
      params: kind === 'tts-generation' ? { type: 'tts', reference_id: '', speed: 1, volume: 0 } : null, prompt: '' }
    const onPlay = vi.fn(), nodeClick = vi.fn(), nodeDoubleClick = vi.fn()
    const pane = document.createElement('div'); document.body.append(pane)
    root = createRoot(pane)
    act(() => root!.render(<ReactFlowProvider><div className="react-flow__node" onClick={nodeClick} onDoubleClick={nodeDoubleClick}>
      <AudioNode node={node} asset={asset} api={api} workspace="w" selected={false} playing={false}
        onPlay={onPlay} onStop={() => {}} onRename={() => {}} onSize={() => {}} />
    </div></ReactFlowProvider>))
    const userNode: NodeBase = { id: node.id, position: { x: 0, y: 0 }, data: {} }
    const internal: InternalNodeBase = { ...userNode, measured: { width: 360, height: 180 },
      internals: { positionAbsolute: { x: 0, y: 0 }, z: 0, userNode } }
    const nodeLookup = new Map([[node.id, internal]])
    const update = vi.fn((items: Map<string, { position: { x: number; y: number }; internals: { positionAbsolute: { x: number; y: number } } }>) => {
      for (const item of items.values()) { internal.position = { ...item.position }; internal.internals.positionAbsolute = { ...item.internals.positionAbsolute } }
    })
    driver = XYDrag({ getStoreItems: () => ({
      nodes: [userNode], edges: [], nodeLookup, nodeExtent: [[-Infinity, -Infinity], [Infinity, Infinity]],
      snapGrid: [15, 15], snapToGrid: false, nodeOrigin: [0, 0], multiSelectionActive: false,
      domNode: pane, transform: [0, 0, zoom], autoPanOnNodeDrag: false, nodesDraggable: true,
      selectNodesOnDrag: true, nodeDragThreshold: 1, panBy: async () => false,
      unselectNodesAndEdges: () => {}, updateNodePositions: update,
    }) })
    driver.update({ domNode: pane.querySelector('.react-flow__node')!, nodeId: node.id, noDragClassName: 'nodrag', isSelectable: true })
    const view = pane.ownerDocument.defaultView!
    const mouse = (type: string, x: number, y: number, buttons: number) => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons, clientX: x, clientY: y })
      // Vitest wraps Window; D3 needs the event's owner view, beyond jsdom's constructor identity check.
      Object.defineProperty(event, 'view', { value: view })
      return event
    }
    const drag = (target: Element) => {
      act(() => {
        target.dispatchEvent(mouse('mousedown', 20, 30, 1))
        view.dispatchEvent(mouse('mousemove', 22, 32, 1))
        view.dispatchEvent(mouse('mousemove', 62, 52, 1))
        view.dispatchEvent(mouse('mouseup', 62, 52, 0))
      })
    }
    // The timestamp row remains a drag surface while waveform data is loading.
    drag(pane.querySelector('.dc-audio-controls>span')!)
    expect(internal.position).toEqual({ x: 40 / zoom, y: 20 / zoom })
    await act(async () => { resolveWave({ version: 1, duration: 6, peaks: Array(96).fill(.5) }) })
    const audio = pane.querySelector('audio')!
    Object.defineProperty(audio, 'currentTime', { value: 3, writable: true, configurable: true })
    for (const target of [pane.querySelector('.dc-audio-controls')!, pane.querySelector('.dc-audio-controls>span:last-child')!]) drag(target)
    expect(internal.position).toEqual({ x: 120 / zoom, y: 60 / zoom })
    expect(audio.currentTime).toBe(3); expect(play).not.toHaveBeenCalled()
    const calls = update.mock.calls.length, position = { ...internal.position }
    for (const target of [pane.querySelector('.dc-audio-waveform rect')!, pane.querySelector('.dc-audio-toggle svg')!]) drag(target)
    expect(update).toHaveBeenCalledTimes(calls); expect(internal.position).toEqual(position)
    // Real D3 suppresses the click immediately after a moved drag; wait for its one-tick cleanup.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    act(() => pane.querySelector<HTMLButtonElement>('.dc-audio-toggle')!.click())
    expect(onPlay).toHaveBeenCalledTimes(1); expect(play).toHaveBeenCalledTimes(1); expect(nodeClick).not.toHaveBeenCalled()
    act(() => pane.querySelector('.dc-audio-controls>span')!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(nodeClick).toHaveBeenCalledTimes(1)
    act(() => pane.querySelector('.dc-audio-controls')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })))
    expect(nodeDoubleClick).not.toHaveBeenCalled()
  },
)
