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
  vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const rect = (x: number, y: number, width: number, height: number) => ({ x, y, left: x, top: y, right: x + width, bottom: y + height, width, height, toJSON: () => ({}) })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    if (this.classList.contains('area')) return rect(100, 50, 800, 700) as DOMRect
    if (this.hasAttribute('data-id')) return rect(340, 115, 320, 180) as DOMRect
    if (this.classList.contains('dc-editor')) return rect(235, 315, 530, 210) as DOMRect
    return rect(235, 315, 530, 210) as DOMRect
  })
  const client = new CanvasPresentationClient()
  const intent: PresentationIntent = { id: 'create', sessionId: 'session', canvasId: 'canvas', epoch: 1, action: 'create', graphRevision: 1, nodeIds: ['node'], createdAt: 1 }
  client.receive({ intent })
  const node: CanvasNode = { id: 'node', kind: 'image-generation', title: '节点', prompt: '输入', params: null, modelId: null, assetId: null, selectedResultId: null, position: { x: 400, y: 600 } }
  const reportView = vi.fn(async () => ({ ok: true })), ack = vi.fn(async () => ({ ok: true })), focus = vi.fn()
  const api = { reportView, acknowledgePresentation: ack } as any
  const flow = { viewportInitialized: true, getViewport: () => ({ x: 50, y: -60, zoom: .4 }),
    screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x: (x - 100 - 50) / .4, y: (y - 50 + 60) / .4 }),
    getNodes: () => [{ id: 'node', width: 320, height: 180 }], setViewport: vi.fn(async () => true) } as any
  let follow!: ReturnType<typeof useCanvasPresentation>
  function Probe({ card, revision = 1 }: { card: boolean; revision?: number }) {
    const container = useRef<HTMLDivElement>(null)
    follow = useCanvasPresentation({ api, presentation: client, viewId: 'view', sessionId: 'session', workspace: 'canvas', active: true,
      control: { canvasId: 'canvas', sessionId: 'session', mode: 'agent', epoch: 1, updatedAt: 1 }, revision,
      graph: { ...emptyGraph(), nodes: [node] }, flow, container, focus })
    return <div className="area" ref={container}><div data-id="node">实际节点</div>{card && <div className="dc-editor"><div data-dc-current-inspection="node">只读输入</div></div>}</div>
  }
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => { root!.render(<Probe card={false} />); await vi.advanceTimersByTimeAsync(32) })
  expect(reportView.mock.calls[0][0]).toMatchObject({ center: { x: 875, y: 1025 }, width: 800, height: 700, zoom: .4, visible: true })
  expect(focus).toHaveBeenCalledWith(['node'])
  expect(ack).not.toHaveBeenCalled()
  await act(async () => { root!.render(<Probe card />); await vi.advanceTimersByTimeAsync(32) })
  expect(ack).toHaveBeenCalledTimes(1)
  expect(ack.mock.calls[0][0]).toMatchObject({ status: 'presented', presentationId: 'create', graphRevision: 1 })
  act(() => follow.pause())
  act(() => client.receive({ intent: { ...intent, id: 'update', graphRevision: 2, action: 'update', createdAt: 2 } }))
  await act(async () => { root!.render(<Probe card revision={2} />); await vi.advanceTimersByTimeAsync(64) })
  expect(focus).toHaveBeenCalledTimes(1)
  expect(ack).toHaveBeenCalledTimes(1)
  act(() => follow.resume())
  await act(async () => { await vi.advanceTimersByTimeAsync(64) })
  expect(ack).toHaveBeenCalledTimes(2)
  expect(ack.mock.calls[1][0]).toMatchObject({ presentationId: 'update', graphRevision: 2 })
})
