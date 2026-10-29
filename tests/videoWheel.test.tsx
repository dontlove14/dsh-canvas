// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useKeyPress } from '@xyflow/react'
import { XYPanZoom } from '@xyflow/system'
import { afterEach, expect, it, vi } from 'vitest'
import { VideoPlayer } from '../src/client/VideoPlayer'
import { bindCanvasActionBarGestures, canvasScrollGestures } from '../src/client/gestures'

let root: Root | undefined
let panZoom: ReturnType<typeof XYPanZoom> | undefined
let removeGestures: (() => void) | undefined
afterEach(() => {
  removeGestures?.(); removeGestures = undefined
  panZoom?.destroy(); panZoom = undefined
  act(() => root?.unmount()); root = undefined
  document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
it.each([['video-asset', 'ctrlKey'], ['video-generation', 'metaKey']] as const)(
  'pans and zooms the native canvas over a playing %s video and controls (%s)', async (kind, modifier) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal('navigator', { maxTouchPoints: 0, userAgent: 'Macintosh', platform: 'MacIntel' })
    vi.stubGlobal('IntersectionObserver', class {
      constructor(private notify: (entries: Array<{ isIntersecting: boolean }>) => void) {}
      observe() { this.notify([{ isIntersecting: true }]) }; disconnect() {}
    })
    const paused = new WeakMap<HTMLMediaElement, boolean>()
    vi.spyOn(HTMLMediaElement.prototype, 'paused', 'get').mockImplementation(function () { return paused.get(this) ?? true })
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async function () {
      paused.set(this, false); this.dispatchEvent(new Event('play'))
    })
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function () {
      if (paused.get(this) === false) { paused.set(this, true); this.dispatchEvent(new Event('pause')) }
    })
    const canvas = document.createElement('div'), renderer = document.createElement('div')
    renderer.className = 'react-flow__renderer'; canvas.append(renderer); document.body.append(canvas)
    renderer.getBoundingClientRect = () => ({ x: 10, y: 20, left: 10, top: 20, right: 1010, bottom: 720, width: 1000, height: 700, toJSON() {} })
    root = createRoot(renderer)
    let zoomKeyPressed = false
    function NativeZoomKeys() {
      zoomKeyPressed = useKeyPress(['Meta', 'Control'])
      return null
    }
    act(() => root!.render(<>
      <NativeZoomKeys />
      <article className={`dc-node ${kind}`}><VideoPlayer src="/clip.mp4" label="视频" autoPlay /></article>
      <div className="dc-editor"><VideoPlayer src="/editor.mp4" label="编辑预览" /></div>
      <VideoPlayer src="/preview.mp4" label="原视频预览" preview />
    </>))
    await act(async () => { await Promise.resolve() })
    const video = renderer.querySelector('article video')!
    Object.defineProperties(video, { duration: { value: 10, configurable: true }, currentTime: { value: 3, writable: true, configurable: true } })
    act(() => { video.dispatchEvent(new Event('loadedmetadata')); video.dispatchEvent(new Event('loadeddata')) })
    const plays = play.mock.calls.length, pauses = pause.mock.calls.length
    panZoom = XYPanZoom({ domNode: renderer, minZoom: .1, maxZoom: 2.5, translateExtent: [[-Infinity, -Infinity], [Infinity, Infinity]],
      viewport: { x: 0, y: 0, zoom: 1 }, onPanZoomEnd: () => {}, onDraggingChange: () => {} })
    const configure = () => panZoom!.update({
      ...canvasScrollGestures, panActivationKeyPressed: false, zoomActivationKeyPressed: zoomKeyPressed,
      panOnDrag: [1, 2], selectionOnDrag: true, zoomOnDoubleClick: true, userSelectionActive: false, connectionInProgress: false,
      preventScrolling: true, noWheelClassName: 'nowheel', noPanClassName: 'nopan', lib: 'react', paneClickDistance: 0, onTransformChange: () => {},
    })
    configure()
    const wheel = (target: Element, x: number, y: number, modifiers = {}, mode = 0) => {
      const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: x, deltaY: y, deltaMode: mode,
        clientX: 510, clientY: 370, ...modifiers })
      act(() => { target.dispatchEvent(event) }); return event
    }
    wheel(video, 23.5, -40.25)
    expect(panZoom.getViewport()).toEqual({ x: 0, y: 0, zoom: 1 })
    removeGestures = bindCanvasActionBarGestures(canvas)
    for (const selector of ['video', '.dc-video-player', '.dc-video-controls', '.dc-video-toggle svg', '.dc-video-progress', '.dc-video-time']) {
      expect(wheel(renderer.querySelector(`article ${selector}`)!, 23.5, -40.25).defaultPrevented).toBe(true)
    }
    expect(panZoom.getViewport()).toEqual({ x: -141, y: 241.5, zoom: 1 })
    wheel(video, -141, 241.5)
    expect(panZoom.getViewport()).toEqual({ x: 0, y: 0, zoom: 1 })
    wheel(video, 0, 3, {}, 1)
    expect(panZoom.getViewport()).toEqual({ x: 0, y: -60, zoom: 1 })
    // Ctrl-wheel is pinch even without the keyboard zoom activation flag.
    if (modifier === 'metaKey') {
      act(() => renderer.querySelector('article .dc-video-progress')!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Meta', code: 'MetaLeft', metaKey: true, bubbles: true, cancelable: true }),
      ))
      expect(zoomKeyPressed).toBe(true)
    }
    configure()
    const before = panZoom.getViewport()
    expect(wheel(renderer.querySelector('article .dc-video-progress')!, 0, -10, { [modifier]: true }).defaultPrevented).toBe(true)
    const zoomed = panZoom.getViewport()
    expect(zoomed.zoom).toBeGreaterThan(before.zoom)
    const anchorX = (500 - before.x) / before.zoom, anchorY = (350 - before.y) / before.zoom
    expect(zoomed.x + anchorX * zoomed.zoom).toBeCloseTo(500)
    expect(zoomed.y + anchorY * zoomed.zoom).toBeCloseTo(350)
    wheel(video, 0, -100000, { [modifier]: true })
    expect(panZoom.getViewport().zoom).toBe(2.5)
    const current = panZoom.getViewport()
    for (const selector of ['.dc-editor video', '.dc-video-player.preview video']) {
      expect(wheel(renderer.querySelector(selector)!, 23, 40).defaultPrevented).toBe(false)
      // XYFlow itself may suppress browser pinch zoom over a nowheel element;
      // the important boundary is that the underlying canvas never moves.
      wheel(renderer.querySelector(selector)!, 0, -10, { [modifier]: true })
    }
    expect(panZoom.getViewport()).toEqual(current)
    expect(renderer.querySelector('article video')).toBe(video)
    expect(video.currentTime).toBe(3); expect(video.paused).toBe(false)
    expect(play).toHaveBeenCalledTimes(plays); expect(pause).toHaveBeenCalledTimes(pauses)
    removeGestures(); removeGestures = undefined
    wheel(video, 23, 40)
    expect(panZoom.getViewport()).toEqual(current)
  },
)
