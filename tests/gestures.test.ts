import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { XYPanZoom } from '@xyflow/system'
import { canvasScrollGestures } from '../src/client/gestures'

// Minimal event surface; viewport changes are handled by the real XYFlow/D3 implementation.
class Pane extends EventTarget {
  clientLeft = 0
  clientTop = 0
  getBoundingClientRect() { return { left: 0, top: 0, width: 1000, height: 700 } }
  closest(): Pane | null { return null }
}

function setup(zoomActivationKeyPressed = false, panning = false) {
  const pane = new Pane()
  const onEnd = vi.fn()
  const panZoom = XYPanZoom({
    domNode: pane as unknown as HTMLDivElement,
    minZoom: 0.1, maxZoom: 2.5,
    translateExtent: [[-Infinity, -Infinity], [Infinity, Infinity]],
    viewport: { x: 0, y: 0, zoom: 1 }, onPanZoomEnd: onEnd, onDraggingChange: vi.fn(),
  })
  panZoom.update({
    ...canvasScrollGestures,
    panActivationKeyPressed: panning, zoomActivationKeyPressed,
    panOnDrag: panning ? true : [1, 2], selectionOnDrag: !panning,
    zoomOnDoubleClick: true, userSelectionActive: false, connectionInProgress: false,
    preventScrolling: true, noWheelClassName: 'nowheel', noPanClassName: 'nopan',
    lib: 'react', paneClickDistance: 0, onTransformChange: vi.fn(),
  })
  const wheel = (deltaX: number, deltaY: number, options: Record<string, unknown> = {}) => {
    const event = new Event('wheel', { cancelable: true })
    Object.assign(event, { deltaX, deltaY, deltaMode: 0, clientX: 500, clientY: 350, ctrlKey: false, metaKey: false, shiftKey: false, button: 0 }, options)
    pane.dispatchEvent(event)
    return event
  }
  return { pane, panZoom, wheel, onEnd }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('navigator', { maxTouchPoints: 0, userAgent: 'Macintosh', platform: 'MacIntel' })
})
afterEach(() => { vi.runAllTimers(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('native canvas wheel gestures', () => {
  it.each([120, -120])('pans vertically without zoom for an ordinary wheel (%s)', (delta) => {
    const { wheel, panZoom, onEnd } = setup()
    expect(wheel(0, delta).defaultPrevented).toBe(true)
    expect(panZoom.getViewport()).toEqual({ x: 0, y: -delta, zoom: 1 })
    vi.runAllTimers()
    expect(onEnd).toHaveBeenLastCalledWith(expect.anything(), { x: 0, y: -delta, zoom: 1 })
  })

  it('pans both axes for fractional trackpad movement and inertia', () => {
    const { wheel, panZoom } = setup()
    wheel(23.5, -40.25); wheel(1.5, -4.75)
    expect(panZoom.getViewport()).toEqual({ x: -25, y: 45, zoom: 1 })
  })

  it('keeps Space plus wheel as vertical pan', () => {
    const { wheel, panZoom } = setup(false, true)
    wheel(0, 75)
    expect(panZoom.getViewport()).toEqual({ x: 0, y: -75, zoom: 1 })
  })

  it.each(['Meta', 'Control'])('zooms around the pointer while %s is pressed', (key) => {
    const { wheel, panZoom } = setup(true)
    wheel(0, -60, { metaKey: key === 'Meta', ctrlKey: key === 'Control' })
    const viewport = panZoom.getViewport()
    expect(viewport.zoom).toBeGreaterThan(1)
    expect(viewport.x + 500 * viewport.zoom).toBeCloseTo(500)
    expect(viewport.y + 350 * viewport.zoom).toBeCloseTo(350)
    wheel(0, 100000, { metaKey: key === 'Meta', ctrlKey: key === 'Control' })
    expect(panZoom.getViewport().zoom).toBe(0.1)
  })

  it('preserves trackpad pinch zoom encoded as Ctrl plus wheel', () => {
    const { wheel, panZoom } = setup()
    wheel(0, -10, { ctrlKey: true })
    expect(panZoom.getViewport().zoom).toBeGreaterThan(1)
  })

  it('does not move the viewport when scrolling editor or player controls', () => {
    const { pane, wheel, panZoom } = setup()
    pane.closest = () => pane
    expect(wheel(0, 80).defaultPrevented).toBe(false)
    expect(panZoom.getViewport()).toEqual({ x: 0, y: 0, zoom: 1 })
    expect(wheel(0, -10, { ctrlKey: true }).defaultPrevented).toBe(true)
    expect(panZoom.getViewport()).toEqual({ x: 0, y: 0, zoom: 1 })
  })

  it('normalizes line-mode wheel events without changing zoom', () => {
    const { wheel, panZoom } = setup()
    wheel(0, 3, { deltaMode: 1 })
    expect(panZoom.getViewport()).toEqual({ x: 0, y: -60, zoom: 1 })
  })
})
