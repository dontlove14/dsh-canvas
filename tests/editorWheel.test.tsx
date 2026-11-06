// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ReactFlow, ReactFlowProvider, useStoreApi } from '@xyflow/react'
import { afterEach, expect, it, vi } from 'vitest'
import { FloatingEditor } from '../src/client/Canvas'
import { GenerationSnapshotEditor } from '../src/client/GenerationSnapshotEditor'
import { CanvasApi } from '../src/client/api'
import { bindCanvasActionBarGestures, canvasScrollGestures } from '../src/client/gestures'
import { emptyGraph, type CanvasNode } from '../src/shared/contracts'
import { MOCK_MODELS, mockRecord } from '../src/shared/mockModels'

let root: Root | undefined
let removeGestures: (() => void) | undefined
afterEach(() => {
  removeGestures?.(); removeGestures = undefined
  act(() => root?.unmount()); root = undefined
  document.body.replaceChildren()
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

async function fixture(kind: 'editable' | 'inspection' | 'snapshot' = 'editable') {
  vi.useFakeTimers()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('navigator', { maxTouchPoints: 0, userAgent: 'Macintosh', platform: 'MacIntel' })
  vi.stubGlobal('ResizeObserver', class { observe() {}; unobserve() {}; disconnect() {} })
  const rect = () => ({ x: 10, y: 20, left: 10, top: 20, right: 1010, bottom: 720, width: 1000, height: 700, toJSON() {} })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(rect)
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(1000)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(700)
  const model = MOCK_MODELS.find((model) => model.kind === 'video')!
  const node: CanvasNode = { id: crypto.randomUUID(), kind: 'video-generation', title: '视频', position: { x: 400, y: 100 },
    modelId: model.id, prompt: '镜头向前移动', params: { size: '1280x720', seconds: 4, n: 1 }, assetId: null, selectedResultId: null }
  const graph = { ...emptyGraph(), nodes: [node] }, original = JSON.stringify(graph)
  const mutate = vi.fn(), onMoveEnd = vi.fn()
  const api = new CanvasApi()
  let store!: ReturnType<typeof useStoreApi>
  function Probe() { store = useStoreApi(); return null }
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  act(() => root!.render(<ReactFlowProvider>
    <ReactFlow nodes={[]} edges={[]} minZoom={.1} maxZoom={2.5} defaultViewport={{ x: 0, y: 0, zoom: 1 }}
      {...canvasScrollGestures} onMoveEnd={onMoveEnd}>
      <Probe />
      {kind === 'snapshot' ? <GenerationSnapshotEditor api={api} workspace="test"
        snapshot={{ model: mockRecord(model.id), prompt: node.prompt, params: { size: '1280x720', seconds: 4, n: 1 }, referenceIds: [] }}
        anchor={{ position: node.position, size: { width: 320, height: 180 } }} readOnly />
        : <FloatingEditor node={node} graph={graph} assets={[]} tasks={[]} models={[model]} api={api} workspace="test"
          readOnly={kind === 'inspection'} ttsConfigured ttsConfigurationError={false}
          patchNode={mutate} edit={mutate} generate={mutate} report={mutate} askImport={mutate}
          taskAction={mutate} onOpen={mutate} onResult={mutate} submitting={false} uploading={false} />}
    </ReactFlow>
  </ReactFlowProvider>))
  await act(async () => { await Promise.resolve() })
  const card = host.querySelector<HTMLElement>('.dc-editor')!
  const renderer = host.querySelector('.react-flow__renderer')!
  expect(card.parentElement).toBe(renderer.parentElement)
  expect(renderer.contains(card)).toBe(false)
  const viewport = () => store.getState().panZoom!.getViewport()
  const wheel = (target: Element, deltaX: number, deltaY: number, extra = {}) => {
    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX, deltaY, clientX: 510, clientY: 370, ...extra })
    act(() => { target.dispatchEvent(event) }); return event
  }
  const unchanged = () => { expect(JSON.stringify(graph)).toBe(original); expect(mutate).not.toHaveBeenCalled() }
  return { host, card, renderer, node, viewport, wheel, unchanged, onMoveEnd }
}

it.each(['editable', 'inspection', 'snapshot'] as const)('pans and pinches over the real sibling %s card through native ReactFlow', async (kind) => {
  const f = await fixture(kind)
  expect(f.wheel(f.card, 23.5, -40.25).defaultPrevented).toBe(false)
  expect(f.viewport()).toEqual({ x: 0, y: 0, zoom: 1 })
  removeGestures = bindCanvasActionBarGestures(f.host)
  const target = f.card.querySelector('svg, strong, input') ?? f.card
  expect(f.wheel(target, 23.5, -40.25).defaultPrevented).toBe(true)
  f.wheel(target, 1.5, -4.75)
  expect(f.viewport()).toEqual({ x: -25, y: 45, zoom: 1 })
  act(() => vi.advanceTimersByTime(200))
  expect(f.onMoveEnd).toHaveBeenLastCalledWith(expect.anything(), { x: -25, y: 45, zoom: 1 })
  f.wheel(target, -25, 45)
  f.wheel(target, 0, 3, { deltaMode: 1 })
  expect(f.viewport()).toEqual({ x: 0, y: -60, zoom: 1 })
  const before = f.viewport()
  expect(f.wheel(target, 0, -10, { ctrlKey: true }).defaultPrevented).toBe(true)
  const zoomed = f.viewport()
  expect(zoomed.zoom).toBeGreaterThan(before.zoom)
  expect(zoomed.x + (500 - before.x) / before.zoom * zoomed.zoom).toBeCloseTo(500)
  expect(zoomed.y + (350 - before.y) / before.zoom * zoomed.zoom).toBeCloseTo(350)
  f.wheel(target, 0, -100000, { ctrlKey: true }); expect(f.viewport().zoom).toBe(2.5)
  f.wheel(target, 0, 100000, { ctrlKey: true }); expect(f.viewport().zoom).toBe(.1)
  f.unchanged()
})

it.each(['Meta', 'Control'])('tracks native %s zoom while the prompt is focused without leaking editing keys', async (key) => {
  const f = await fixture()
  removeGestures = bindCanvasActionBarGestures(f.host)
  const prompt = f.card.querySelector<HTMLElement>('[role="textbox"]')!
  act(() => prompt.focus())
  const bubbles = vi.fn(); document.addEventListener('keydown', bubbles)
  try {
    act(() => prompt.dispatchEvent(new KeyboardEvent('keydown', { key, code: `${key}Left`, metaKey: key === 'Meta',
      ctrlKey: key === 'Control', bubbles: true, cancelable: true })))
    expect(bubbles).toHaveBeenCalledTimes(1)
    expect(f.wheel(prompt, 0, -60, { metaKey: key === 'Meta', ctrlKey: key === 'Control' }).defaultPrevented).toBe(true)
    expect(f.viewport().zoom).toBeGreaterThan(1)
    act(() => prompt.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true })))
    for (const key of ['Delete', 'Backspace', ' ', 'a']) {
      act(() => prompt.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })))
    }
    expect(bubbles).toHaveBeenCalledTimes(1)
    const before = f.viewport()
    f.wheel(prompt, 17, 25)
    expect(f.viewport()).toEqual({ ...before, x: before.x - 17, y: before.y - 25 })
    expect(prompt.textContent).toBe(f.node.prompt); expect(document.activeElement).toBe(prompt)
    f.unchanged()
  } finally { document.removeEventListener('keydown', bubbles) }
})

it('preserves inner scrolling until its directional boundary, but always forwards pinch', async () => {
  const f = await fixture()
  removeGestures = bindCanvasActionBarGestures(f.host)
  const prompt = f.card.querySelector<HTMLElement>('[role="textbox"]')!
  prompt.style.overflowY = 'auto'
  Object.defineProperties(prompt, { clientHeight: { value: 100 }, scrollHeight: { value: 500 } })
  prompt.scrollTop = 100
  expect(f.wheel(prompt, 0, 20).defaultPrevented).toBe(false)
  expect(f.wheel(prompt, 0, -20).defaultPrevented).toBe(false)
  expect(f.viewport()).toEqual({ x: 0, y: 0, zoom: 1 })
  // A vertical-only scroller cannot consume horizontal movement.
  expect(f.wheel(prompt, 25, 0).defaultPrevented).toBe(true)
  prompt.scrollTop = 400
  expect(f.wheel(prompt, 0, 20).defaultPrevented).toBe(true)
  expect(f.wheel(prompt, 0, -20).defaultPrevented).toBe(false)
  prompt.scrollTop = 0
  expect(f.wheel(prompt, 0, -20).defaultPrevented).toBe(true)
  prompt.scrollTop = 100
  expect(f.wheel(prompt, 0, -10, { ctrlKey: true }).defaultPrevented).toBe(true)
  expect(f.viewport().zoom).toBeGreaterThan(1)
  f.unchanged()
})

it('keeps horizontal lists native, isolates other canvases and portals, and cleans up', async () => {
  const f = await fixture()
  removeGestures = bindCanvasActionBarGestures(f.host)
  const list = document.createElement('div'), child = document.createElement('button')
  list.append(child); f.card.append(list); list.style.overflowX = 'auto'
  Object.defineProperties(list, { clientWidth: { value: 100 }, scrollWidth: { value: 400 } })
  list.scrollLeft = 100
  expect(f.wheel(child, 20, 0).defaultPrevented).toBe(false)
  expect(f.wheel(child, -20, 0).defaultPrevented).toBe(false)
  list.scrollLeft = 300
  expect(f.wheel(child, 20, 0).defaultPrevented).toBe(true)
  const before = f.viewport()
  const otherFlow = document.createElement('div'); otherFlow.className = 'react-flow'
  const orphan = f.card.cloneNode(false) as HTMLElement
  otherFlow.append(orphan); f.host.append(otherFlow)
  expect(f.wheel(orphan, 25, 25, { ctrlKey: true }).defaultPrevented).toBe(false)
  const popup = document.createElement('div'); popup.className = 'dc-model-picker nowheel'; f.host.append(popup)
  expect(f.wheel(popup, 0, -10, { ctrlKey: true }).defaultPrevented).toBe(false)
  const portal = f.card.cloneNode(false); document.body.append(portal)
  expect(f.wheel(portal as Element, 0, -10, { ctrlKey: true }).defaultPrevented).toBe(false)
  expect(f.viewport()).toEqual(before)
  removeGestures(); removeGestures = undefined
  expect(f.wheel(f.card, 25, 25, { ctrlKey: true }).defaultPrevented).toBe(false)
  expect(f.viewport()).toEqual(before)
  f.unchanged()
})
