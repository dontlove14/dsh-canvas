// @vitest-environment jsdom
import { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { useCanvasPresentation } from '../src/client/useCanvasPresentation'
import { CanvasPresentationClient } from '../src/client/presentation'
import { emptyGraph, type CanvasNode } from '../src/shared/contracts'
import type { PresentationIntent } from '../src/shared/presentation'

let root: Root | undefined
afterEach(() => { act(() => root?.unmount()); document.body.replaceChildren(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); sessionStorage.clear() })
it('reports the expanded container center at the actual zoom and acknowledges only after node and readonly inputs render', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame'] }); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  let viewport = { x: 50, y: -60, zoom: .4 }
  let canvasWidth = 800
  const resizeCallbacks: Array<() => void> = []
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resizeCallbacks.push(callback) }; observe() {}; disconnect() {} })
  const rect = (x: number, y: number, width: number, height: number) => ({ x, y, left: x, top: y, right: x + width, bottom: y + height, width, height, toJSON: () => ({}) })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    if (this.classList.contains('area')) return rect(100, 50, canvasWidth, 700) as DOMRect
    if (this.hasAttribute('data-id')) return rect(100 + viewport.x + 400 * viewport.zoom, 50 + viewport.y + 600 * viewport.zoom, 320 * viewport.zoom, 180 * viewport.zoom) as DOMRect
    return rect(235, 50 + viewport.y + 780 * viewport.zoom + 18, 530, 210) as DOMRect
  })
  const client = new CanvasPresentationClient()
  const intent: PresentationIntent = { id: 'create', sessionId: 'session', canvasId: 'canvas', epoch: 1, action: 'create', graphRevision: 1, nodeIds: ['node'], createdAt: 1 }
  client.receive({ intent })
  const node: CanvasNode = { id: 'node', kind: 'image-generation', title: '节点', prompt: '输入', params: null, modelId: null, assetId: null, selectedResultId: null, position: { x: 400, y: 600 } }
  const reportView = vi.fn(async () => ({ ok: true })), ack = vi.fn(async () => ({ ok: true })), focus = vi.fn()
  const api = { reportView, acknowledgePresentation: ack } as any
  const flow = { viewportInitialized: true, getViewport: () => viewport,
    screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x: (x - 100 - viewport.x) / viewport.zoom, y: (y - 50 - viewport.y) / viewport.zoom }),
    getNodes: () => [{ id: 'node', width: 320, height: 180 }], setViewport: vi.fn(async (next) => { viewport = next; return true }) } as any
  let follow!: ReturnType<typeof useCanvasPresentation>
  function Probe({ card, revision = 1 }: { card: boolean; revision?: number }) {
    const container = useRef<HTMLDivElement>(null)
    follow = useCanvasPresentation({ api, presentation: client, viewId: 'view', sessionId: 'session', workspace: 'canvas', active: true,
      control: { canvasId: 'canvas', sessionId: 'session', mode: 'agent', epoch: 1, updatedAt: 1 }, revision,
      graph: { ...emptyGraph(), nodes: [node] }, flow, container, focus })
    return <div className="area" ref={container}><div data-id="node">实际节点</div>{card && <div className="dc-editor"><div data-dc-current-inspection="node">只读输入</div></div>}</div>
  }
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => { root!.render(<Probe card={false} />) })
  await act(async () => { await vi.advanceTimersByTimeAsync(64) })
  expect(reportView.mock.calls[0][0]).toMatchObject({ center: { x: 875, y: 1025 }, width: 800, height: 700, zoom: .4, visible: true })
  expect(focus).toHaveBeenCalledWith(['node'])
  expect(flow.setViewport).toHaveBeenLastCalledWith({ x: 176, y: 74, zoom: .4 })
  expect(follow.highlighted.has('node')).toBe(true)
  expect(node.position).toEqual({ x: 400, y: 600 })
  expect(ack).not.toHaveBeenCalled()
  await act(async () => { root!.render(<Probe card />) })
  await act(async () => { await vi.advanceTimersByTimeAsync(64) })
  expect(ack).toHaveBeenCalledTimes(1)
  expect(ack.mock.calls[0][0]).toMatchObject({ status: 'presented', presentationId: 'create', graphRevision: 1 })
  expect(reportView.mock.calls.at(-1)![0]).toMatchObject({ center: { x: 560, y: 690 } })
  canvasWidth = 1000
  act(() => resizeCallbacks.forEach((callback) => callback()))
  await act(async () => { await vi.advanceTimersByTimeAsync(64) })
  expect(flow.setViewport).toHaveBeenLastCalledWith({ x: 276, y: 74, zoom: .4 })
  expect(node.position).toEqual({ x: 400, y: 600 })
  expect(ack).toHaveBeenCalledTimes(1)
  act(() => client.activity())
  act(() => client.receive({ intent: { ...intent, id: 'update', graphRevision: 2, action: 'update', createdAt: 2 } }))
  await act(async () => { root!.render(<Probe card revision={2} />); await vi.advanceTimersByTimeAsync(64) })
  expect(focus).toHaveBeenCalledTimes(1)
  expect(ack).toHaveBeenCalledTimes(1)
  await act(async () => { await vi.advanceTimersByTimeAsync(10_001) })
  await act(async () => { await vi.advanceTimersByTimeAsync(64) })
  expect(ack).toHaveBeenCalledTimes(2)
  expect(ack.mock.calls[1][0]).toMatchObject({ presentationId: 'update', graphRevision: 2 })
  const moveCount = flow.setViewport.mock.calls.length
  act(() => client.receive({ intent: client.getSnapshot(), running: false }))
  expect(follow.following).toBe(false)
  await act(async () => { await vi.advanceTimersByTimeAsync(12_000) })
  expect(follow.following).toBe(false)
  expect(follow.highlighted.size).toBe(0)
  expect(flow.setViewport).toHaveBeenCalledTimes(moveCount)
})

it('keeps real manual canvas registration alive without an intent, flushes edits then delegates with the current epoch', async () => {
  vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const client = new CanvasPresentationClient(), flush = vi.fn(async () => 7), refresh = vi.fn(async () => {}), report = vi.fn()
  client.observeConversation({ sessionId: 'session', running: false, pendingSubmissions: [], removed: false, openState: 'open', promptError: null } as any, true)
  const delegate = vi.fn(async () => ({ mode: 'agent' })), api = { delegate } as any
  const control = { canvasId: 'canvas', sessionId: 'session', mode: 'manual' as const, epoch: 4, updatedAt: 1 }
  function Probe() {
    const container = useRef<HTMLDivElement>(null)
    const follow = useCanvasPresentation({ api, presentation: client, viewId: 'view', sessionId: 'session', workspace: 'canvas', active: true,
      control, revision: 7, graph: emptyGraph(), flow: {} as any, container, focus: () => {}, flush, refresh, report })
    return <div ref={container} data-follow={follow.following}>人工操作</div>
  }
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => { root!.render(<Probe />) })
  act(() => client.receive({ intent: null }))
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
  expect(delegate).not.toHaveBeenCalled()
  await act(async () => { await vi.advanceTimersByTimeAsync(1) })
  expect(flush).toHaveBeenCalledTimes(1)
  expect(delegate).toHaveBeenCalledWith('canvas', 'session', 7, 4, undefined)
  expect(refresh).toHaveBeenCalledTimes(1)
  expect(container.querySelector('[data-follow]')?.getAttribute('data-follow')).toBe('false')
  expect(report).not.toHaveBeenCalled()
  act(() => root!.unmount()); root = undefined
  await vi.advanceTimersByTimeAsync(20_000)
  expect(delegate).toHaveBeenCalledTimes(1)
  client.clear()
})
