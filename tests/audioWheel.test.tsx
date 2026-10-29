// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ReactFlowProvider } from '@xyflow/react'
import { XYPanZoom } from '@xyflow/system'
import { afterEach, expect, it, vi } from 'vitest'
import { AudioNode } from '../src/client/AudioNode'
import { CanvasApi } from '../src/client/api'
import { bindCanvasActionBarGestures, canvasScrollGestures } from '../src/client/gestures'
import { UiSlider } from '../src/client/UiSlider'
import type { Asset, CanvasNode } from '../src/shared/contracts'
import type { AudioWaveform } from '../src/shared/audioWaveform'

let root: Root | undefined
let panZoom: ReturnType<typeof XYPanZoom> | undefined
let removeGestures: (() => void) | undefined
afterEach(() => {
  removeGestures?.(); removeGestures = undefined
  panZoom?.destroy(); panZoom = undefined
  act(() => root?.unmount()); root = undefined
  document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

it.each([
  ['dc-group-actions', 'ctrlKey'], ['dc-group-actions', 'metaKey'],
  ['dc-resource-toolbar', 'ctrlKey'], ['dc-resource-toolbar', 'metaKey'],
] as const)('zooms the native canvas over %s with %s without browser zoom, pointer drift or button clicks', (toolbarClass, modifier) => {
  vi.stubGlobal('navigator', { maxTouchPoints: 0, userAgent: 'Macintosh', platform: 'MacIntel' })
  const root = document.createElement('div'), renderer = document.createElement('div')
  renderer.className = 'react-flow__renderer'; root.append(renderer); document.body.append(root)
  renderer.getBoundingClientRect = () => ({ x: 10, y: 20, left: 10, top: 20, right: 1010, bottom: 720, width: 1000, height: 700, toJSON: () => {} })
  const toolbar = document.createElement('div'); toolbar.className = `${toolbarClass} nodrag nopan nowheel`
  const button = document.createElement('button'), svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  button.append(svg); toolbar.append(button); renderer.append(toolbar)
  const click = vi.fn(); button.addEventListener('click', click)
  const editor = document.createElement('div'); editor.className = 'dc-editor nowheel nopan'; renderer.append(editor)
  panZoom = XYPanZoom({ domNode: renderer, minZoom: .1, maxZoom: 2.5, translateExtent: [[-Infinity, -Infinity], [Infinity, Infinity]],
    viewport: { x: 0, y: 0, zoom: 1 }, onPanZoomEnd: () => {}, onDraggingChange: () => {} })
  panZoom.update({ ...canvasScrollGestures, panActivationKeyPressed: false, zoomActivationKeyPressed: modifier === 'metaKey',
    panOnDrag: [1, 2], selectionOnDrag: true, zoomOnDoubleClick: true, userSelectionActive: false, connectionInProgress: false,
    preventScrolling: true, noWheelClassName: 'nowheel', noPanClassName: 'nopan', lib: 'react', paneClickDistance: 0, onTransformChange: () => {} })
  const wheel = (target: Element, deltaY: number) => {
    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY, clientX: 510, clientY: 370, [modifier]: true })
    target.dispatchEvent(event); return event
  }
  wheel(svg, -10)
  expect(panZoom.getViewport().zoom).toBe(1)
  removeGestures = bindCanvasActionBarGestures(root)
  expect(wheel(svg, -10).defaultPrevented).toBe(true)
  const viewport = panZoom.getViewport()
  expect(viewport.zoom).toBeGreaterThan(1)
  expect(viewport.x + 500 * viewport.zoom).toBeCloseTo(500)
  expect(viewport.y + 350 * viewport.zoom).toBeCloseTo(350)
  wheel(button, -100000)
  expect(panZoom.getViewport().zoom).toBe(2.5)
  const before = panZoom.getViewport()
  wheel(editor, 50)
  expect(panZoom.getViewport()).toEqual(before)
  expect(click).not.toHaveBeenCalled()
  button.click(); expect(click).toHaveBeenCalledTimes(1)
  removeGestures(); removeGestures = undefined
  wheel(button, 50)
  expect(panZoom.getViewport()).toEqual(before)
})
it.each(['dc-group-actions', 'dc-resource-toolbar'])('pans both trackpad axes and inertia over %s without changing zoom or intercepting editor scroll', (toolbarClass) => {
  vi.stubGlobal('navigator', { maxTouchPoints: 0, userAgent: 'Macintosh', platform: 'MacIntel' })
  const root = document.createElement('div'), renderer = document.createElement('div')
  renderer.className = 'react-flow__renderer'; root.append(renderer); document.body.append(root)
  const toolbar = document.createElement('div'); toolbar.className = `${toolbarClass} nodrag nopan nowheel`
  const button = document.createElement('button'), svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  button.append(svg); toolbar.append(button); renderer.append(toolbar)
  const editor = document.createElement('div'); editor.className = 'dc-editor nowheel nopan'; renderer.append(editor)
  const click = vi.fn(); button.addEventListener('click', click)
  panZoom = XYPanZoom({ domNode: renderer, minZoom: .1, maxZoom: 2.5, translateExtent: [[-Infinity, -Infinity], [Infinity, Infinity]],
    viewport: { x: 0, y: 0, zoom: 1 }, onPanZoomEnd: () => {}, onDraggingChange: () => {} })
  panZoom.update({ ...canvasScrollGestures, panActivationKeyPressed: false, zoomActivationKeyPressed: false,
    panOnDrag: [1, 2], selectionOnDrag: true, zoomOnDoubleClick: true, userSelectionActive: false, connectionInProgress: false,
    preventScrolling: true, noWheelClassName: 'nowheel', noPanClassName: 'nopan', lib: 'react', paneClickDistance: 0, onTransformChange: () => {} })
  const wheel = (target: Element, deltaX: number, deltaY: number, deltaMode = 0) => {
    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX, deltaY, deltaMode })
    target.dispatchEvent(event); return event
  }
  wheel(button, 23.5, -40.25)
  expect(panZoom.getViewport()).toEqual({ x: 0, y: 0, zoom: 1 })
  removeGestures = bindCanvasActionBarGestures(root)
  expect(wheel(svg, 23.5, -40.25).defaultPrevented).toBe(true)
  expect(wheel(button, 1.5, -4.75).defaultPrevented).toBe(true)
  expect(panZoom.getViewport()).toEqual({ x: -25, y: 45, zoom: 1 })
  wheel(toolbar, -25, 45)
  expect(panZoom.getViewport()).toEqual({ x: 0, y: 0, zoom: 1 })
  wheel(button, 0, 3, 1)
  expect(panZoom.getViewport()).toEqual({ x: 0, y: -60, zoom: 1 })
  expect(wheel(editor, 10, 10).defaultPrevented).toBe(false)
  expect(panZoom.getViewport()).toEqual({ x: 0, y: -60, zoom: 1 })
  expect(click).not.toHaveBeenCalled()
  button.click(); expect(click).toHaveBeenCalledTimes(1)
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
