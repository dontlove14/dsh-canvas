// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ReactFlow, ReactFlowProvider, useStoreApi, type NodeProps, type Node } from '@xyflow/react'
import { afterEach, expect, it, vi } from 'vitest'
import { HistoryNode } from '../src/client/HistoryNode'
import { generationHistory, historyFrame, resultHandle } from '../src/client/generationHistory'
import { CanvasHandle } from '../src/client/CanvasHandle'
import { CanvasApi } from '../src/client/api'
import type { Asset, CanvasNode } from '../src/shared/contracts'
import type { TaskSummary } from '../src/shared/v2'

let root: Root | undefined
const noop = () => {}
afterEach(() => {
  act(() => root?.unmount()); root = undefined
  document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

it('registers real XYFlow handles per result, preserves old edges with invisible collapsed anchors and restores ports on expansion', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const frames = new Map<number, FrameRequestCallback>(); let frameId = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  const observers: Array<() => void> = []
  vi.stubGlobal('ResizeObserver', class {
    constructor(private notify: ResizeObserverCallback) {}
    observe(target: Element) { observers.push(() => this.notify([{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry], this as unknown as ResizeObserver)) }
    unobserve() {}; disconnect() {}
  })
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private notify: (entries: Array<{ isIntersecting: boolean }>) => void) {}
    observe() { this.notify([{ isIntersecting: true }]) }; disconnect() {}
  })
  vi.stubGlobal('DOMMatrixReadOnly', class { m22 = 1 })
  const bounds = function (this: HTMLElement) {
    const handle = this.classList.contains('react-flow__handle')
    const index = this.closest('[data-asset-id]')?.getAttribute('data-asset-id') === 'old-result' ? 1 : 0
    const width = handle ? 20 : Number.parseFloat(this.style.width) || 1000
    const height = handle ? 20 : Number.parseFloat(this.style.height) || 800
    return { x: handle ? 310 : 0, y: handle ? 80 + index * 196 : 0, left: handle ? 310 : 0,
      top: handle ? 80 + index * 196 : 0, right: width, bottom: height, width, height, toJSON: noop }
  }
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(bounds)
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function () { return bounds.call(this).width })
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function () { return bounds.call(this).height })
  const node: CanvasNode = { id: 'source', kind: 'image-generation', title: '历史', position: { x: 0, y: 0 },
    modelId: null, prompt: '', params: null, assetId: null, selectedResultId: 'new-result' }
  const tasks: TaskSummary[] = [1, 2].map((createdAt) => ({ id: `task-${createdAt}`, nodeId: node.id, workspaceId: 'w',
    status: 'completed', resultIds: [createdAt === 1 ? 'old-result' : 'new-result'], createdAt, updatedAt: 9 - createdAt }))
  const assets: Asset[] = ['old-result', 'new-result'].map((id) => ({ id, kind: 'image', mime: 'image/png', filename: id,
    bytes: 100, nodeId: node.id, taskId: null, width: 320, height: 180, createdAt: 1 }))
  const api = new CanvasApi()
  vi.spyOn(api, 'mediaUrls').mockImplementation(async (_canvas, items) => ({ items: items.map((item) => ({
    ...item, url: `https://test.invalid/${item.assetId}`, expiresAt: Date.now() + 3600000,
  })) }))
  let expanded = false, position = { x: 0, y: 0 }, store!: ReturnType<typeof useStoreApi>
  function Capture() { store = useStoreApi(); return null }
  function History({ data }: NodeProps<Node<Record<string, unknown>>>) {
    return <HistoryNode node={node} cards={generationHistory(node.id, tasks, assets)} connectedAssets={['old-result']} selected expanded={!!data.expanded}
      api={api} workspace="w" playing={false} onPlay={noop} onStop={noop} onRename={noop} onExpand={noop} onOpen={noop} onSize={noop} />
  }
  function Target() { return <CanvasHandle type="target" /> }
  const nodeTypes = { history: History, target: Target }
  const storedEdge = { id: 'edge', source: node.id, target: 'target', assetId: 'old-result' }
  const original = JSON.stringify(storedEdge)
  const view = () => {
    const size = historyFrame(generationHistory(node.id, tasks, assets), false, expanded)
    return <ReactFlowProvider><ReactFlow nodeTypes={nodeTypes} nodes={[
      { id: node.id, type: 'history', position, width: size.width, height: size.height, data: { expanded } },
      { id: 'target', type: 'target', position: { x: 600, y: 0 }, width: 320, height: 180, data: {} },
    ]} edges={[{ ...storedEdge, sourceHandle: resultHandle(storedEdge.assetId) }]}>
      <Capture />
    </ReactFlow></ReactFlowProvider>
  }
  const container = document.createElement('div'); document.body.append(container)
  root = createRoot(container)
  const show = async () => {
    await act(async () => { root!.render(view()); await Promise.resolve() })
    for (let tick = 0; tick < 4; tick++) await act(async () => {
      for (const notify of observers.splice(0)) notify()
      const queued = [...frames.values()]; frames.clear()
      for (const callback of queued) callback(tick * 16)
      await Promise.resolve()
    })
  }
  await show()
  const handles = () => store.getState().nodeLookup.get(node.id)!.internals.handleBounds?.source ?? []
  expect(handles().map((handle) => handle.id)).toEqual([resultHandle('old-result')])
  expect(container.querySelector('.dc-history-anchor')?.getAttribute('aria-hidden')).toBe('true')
  expect(container.querySelectorAll('.dc-history-node .connectable.source')).toHaveLength(0)
  expect(container.querySelector('path.react-flow__edge-path')).toBeTruthy()
  expanded = true; await show()
  expect(handles().map((handle) => handle.id)).toEqual([resultHandle('new-result'), resultHandle('old-result')])
  expect(handles()[0].y).not.toBe(handles()[1].y)
  expect(container.querySelectorAll('.dc-history-node .connectable.source')).toHaveLength(2)
  expect(store.getState().edges[0].sourceHandle).toBe(resultHandle('old-result'))
  const path = container.querySelector('path.react-flow__edge-path')!.getAttribute('d')
  position = { x: 170, y: 90 }; await show()
  expect(store.getState().nodeLookup.get(node.id)!.internals.positionAbsolute).toEqual(position)
  expect(container.querySelector('path.react-flow__edge-path')!.getAttribute('d')).not.toBe(path)
  expect(store.getState().edges[0].sourceHandle).toBe(resultHandle('old-result'))
  expanded = false; await show()
  expect(handles().map((handle) => handle.id)).toEqual([resultHandle('old-result')])
  expect(container.querySelector('path.react-flow__edge-path')).toBeTruthy()
  expect(JSON.stringify(storedEdge)).toBe(original)
})
