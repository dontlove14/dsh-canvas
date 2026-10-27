// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ReactFlowProvider } from '@xyflow/react'
import { XYPanZoom } from '@xyflow/system'
import { afterEach, expect, it, vi } from 'vitest'
import { AudioNode } from '../src/client/AudioNode'
import { CanvasApi } from '../src/client/api'
import { canvasScrollGestures } from '../src/client/gestures'
import { UiSlider } from '../src/client/UiSlider'
import type { Asset, CanvasNode } from '../src/shared/contracts'
import type { AudioWaveform } from '../src/shared/audioWaveform'

let root: Root | undefined
let panZoom: ReturnType<typeof XYPanZoom> | undefined
afterEach(() => {
  panZoom?.destroy(); panZoom = undefined
  act(() => root?.unmount()); root = undefined
  document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
it('pans through audio loading, waveform bars and playback controls using real bubbled XYFlow wheels', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private notify: (entries: Array<{ isIntersecting: boolean }>) => void) {}
    observe() { this.notify([{ isIntersecting: true }]) }; disconnect() {}
  })
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  const api = new CanvasApi()
  let resolve!: (wave: AudioWaveform) => void
  vi.spyOn(api, 'waveform').mockReturnValue(new Promise((done) => { resolve = done }))
  const asset: Asset = { id: crypto.randomUUID(), kind: 'audio', mime: 'audio/wav', filename: 'test.wav', bytes: 100, createdAt: 0, nodeId: null, taskId: null }
  const node: CanvasNode = { id: crypto.randomUUID(), kind: 'audio-asset', title: '声音', position: { x: 0, y: 0 }, assetId: asset.id, selectedResultId: null, modelId: null, params: null, prompt: '' }
  const pane = document.createElement('div'); document.body.append(pane)
  root = createRoot(pane)
  act(() => root!.render(<ReactFlowProvider><div className="react-flow__node">
    <AudioNode node={node} asset={asset} api={api} workspace="w" selected playing={false}
      onPlay={() => {}} onStop={() => {}} onRename={() => {}} onSize={() => {}} />
  </div><UiSlider label="生成数量" min={1} max={10} value={1} onChange={() => {}} /></ReactFlowProvider>))
  panZoom = XYPanZoom({ domNode: pane, minZoom: .1, maxZoom: 2.5, translateExtent: [[-Infinity, -Infinity], [Infinity, Infinity]],
    viewport: { x: 0, y: 0, zoom: 1 }, onPanZoomEnd: () => {}, onDraggingChange: () => {} })
  panZoom.update({ ...canvasScrollGestures, panActivationKeyPressed: false, zoomActivationKeyPressed: false,
    panOnDrag: [1, 2], selectionOnDrag: true, zoomOnDoubleClick: true, userSelectionActive: false, connectionInProgress: false,
    preventScrolling: true, noWheelClassName: 'nowheel', noPanClassName: 'nopan', lib: 'react', paneClickDistance: 0, onTransformChange: () => {} })
  const wheel = (element: Element, deltaX = 23.5, deltaY = -40.25) => {
    const event = new WheelEvent('wheel', { deltaX, deltaY, bubbles: true, cancelable: true })
    act(() => { element.dispatchEvent(event) }); return event
  }
  expect(wheel(pane.querySelector('.dc-audio-wave-message')!).defaultPrevented).toBe(true)
  await act(async () => { resolve({ version: 1, duration: 8, peaks: Array(96).fill(.5) }); await Promise.resolve() })
  for (const selector of ['.dc-audio-player', '.dc-audio-waveform', '.dc-audio-waveform rect', '.dc-audio-toggle', '.dc-audio-controls span']) {
    expect(wheel(pane.querySelector(selector)!).defaultPrevented).toBe(true)
  }
  expect(panZoom.getViewport()).toEqual({ x: -141, y: 241.5, zoom: 1 })
  expect(wheel(pane.querySelector('.dc-ui-slider input')!).defaultPrevented).toBe(false)
  expect(panZoom.getViewport()).toEqual({ x: -141, y: 241.5, zoom: 1 })
  // A drag surface inside the player must not become a native D3 double-click zoom surface.
  await act(async () => {
    pane.querySelector('.dc-audio-controls>span')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: 30, clientY: 40 }))
    await new Promise((resolve) => setTimeout(resolve, 350))
  })
  expect(panZoom.getViewport()).toEqual({ x: -141, y: 241.5, zoom: 1 })
})
