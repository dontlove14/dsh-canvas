// @vitest-environment jsdom
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Position, ReactFlowProvider, useStoreApi, getBezierPath, type EdgeProps } from '@xyflow/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RelationshipEdge, relationshipEdges, type RelationshipFlowEdge } from '../src/client/RelationshipEdge'
import { CanvasWorkspace } from '../src/client/Canvas'
import { CanvasApi } from '../src/client/api'
import { emptyGraph, type CanvasNode } from '../src/shared/contracts'
import type { CanvasSnapshot } from '../src/shared/v2'

let store: ReturnType<typeof useStoreApi>
vi.mock('@xyflow/react', async (importOriginal) => {
  const original = await importOriginal<typeof import('@xyflow/react')>()
  return {
    ...original,
    Background: () => null, Controls: () => null, MiniMap: () => null,
    ReactFlow: ({ nodes, edges, edgeTypes, onNodesChange, onEdgesChange, onEdgeClick, onPaneClick }: any) => {
      store = original.useStoreApi()
      useEffect(() => {
        store.getState().setNodes(nodes)
        store.getState().setEdges(edges)
      }, [nodes, edges])
      return <div>
        {nodes.map((node: any) => <button key={node.id} data-node={node.id} onClick={(event) => onNodesChange([
          ...(!event.shiftKey ? nodes.filter((item: any) => item.selected).map((item: any) => ({ type: 'select', id: item.id, selected: false })) : []),
          { type: 'select', id: node.id, selected: true },
        ])}>{node.id}</button>)}
        <button data-clear onClick={onPaneClick}>清空选择</button>
        <svg>{edges.map((edge: any) => {
          const Component = edgeTypes[edge.type]
          return <g key={edge.id} data-edge={edge.id} onClick={(event) => {
            onEdgesChange([
              ...(!event.shiftKey ? edges.filter((item: any) => item.selected).map((item: any) => ({ type: 'select', id: item.id, selected: false })) : []),
              { type: 'select', id: edge.id, selected: true },
            ])
            onEdgeClick(event, edge)
          }}><Component {...edge} sourceX={0} sourceY={0} targetX={200} targetY={80}
            sourcePosition={original.Position.Right} targetPosition={original.Position.Left} /></g>
        })}</svg>
      </div>
    },
  }
})
vi.mock('../src/client/useGpu', () => ({ useGpuCapability: () => ({ enabled: false, reason: 'test' }) }))

const connections: RelationshipFlowEdge[] = [
  { id: 'ab', source: 'a', target: 'b', type: 'relationship' },
  { id: 'bc', source: 'b', target: 'c', type: 'relationship' },
  { id: 'cd', source: 'c', target: 'd', type: 'relationship' },
  { id: 'xa', source: 'x', target: 'a', type: 'relationship' },
]
const roots: Root[] = []
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Object.defineProperty(SVGElement.prototype, 'getBBox', { configurable: true, value: () => ({ x: 0, y: 0, width: 20, height: 10 }) })
})
afterEach(() => {
  act(() => { for (const root of roots.splice(0)) root.unmount() })
  delete (SVGElement.prototype as any).getBBox
  document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
async function workspace() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const nodes: CanvasNode[] = ['a', 'b', 'c', 'd', 'x'].map((id) => ({
    id, kind: 'image-asset', title: id, position: { x: 0, y: 0 }, modelId: null,
    prompt: '', params: null, assetId: null, selectedResultId: null,
  }))
  const graph = { ...emptyGraph(), nodes, edges: connections.map(({ id, source, target }) => ({ id, source, target, assetId: 'asset-' + id })) }
  const snapshot: CanvasSnapshot = { version: 1, workspaceId: 'w', graphRevision: 1, graph, assets: [], tasks: [],
    updatedAt: 1, commitHash: 'a'.repeat(64), hashes: { nodes: {}, edges: {}, viewport: '' } }
  const original = JSON.stringify(snapshot)
  const api = new CanvasApi()
  vi.spyOn(api, 'state').mockResolvedValue(snapshot)
  const save = vi.spyOn(api, 'save')
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container); roots.push(root)
  const show = async (active: boolean) => act(async () => {
    root.render(<ReactFlowProvider><CanvasWorkspace api={api} active={active} workspace="w" title="关系测试" onBack={() => {}} /></ReactFlowProvider>)
    await Promise.resolve()
  })
  await show(true)
  const click = (id: string, shiftKey = false) => act(() => {
    container.querySelector(`[data-node="${id}"]`)!.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey }))
  })
  const flowing = () => [...container.querySelectorAll('[data-edge]')].filter((edge) => edge.querySelector('.dc-edge-flow')).map((edge) => edge.getAttribute('data-edge'))
  const clickEdge = (id: string, shiftKey = false) => act(() => {
    container.querySelector(`[data-edge="${id}"]`)!.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey }))
  })
  return { container, click, clickEdge, flowing, show, snapshot, original, api, save }
}

describe('selected node relationship flow', () => {
  it('projects only direct incoming/outgoing edges, reuses unrelated references and never mutates graph edges', () => {
    const edges = structuredClone(connections)
    const before = structuredClone(edges)
    const focused = relationshipEdges(edges, 'b')
    expect(focused.filter((edge) => edge.data?.flowing).map((edge) => edge.id)).toEqual(['ab', 'bc'])
    expect(focused[2]).toBe(edges[2]); expect(focused[3]).toBe(edges[3])
    expect(edges).toEqual(before)
    expect(relationshipEdges(edges, null)).toBe(edges)
    expect(relationshipEdges(edges, 'c').filter((edge) => edge.data?.flowing).map((edge) => edge.id)).toEqual(['bc', 'cd'])
  })
  it('projects selected edges independently and preserves their stored identity', () => {
    const edges = connections.map((edge) => ({ ...edge, selected: edge.id === 'cd' }))
    const original = structuredClone(edges)
    const focused = relationshipEdges(edges, null, true)
    expect(focused.filter((edge) => edge.data?.flowing).map((edge) => edge.id)).toEqual(['cd'])
    expect(focused[0]).toBe(edges[0]); expect(focused[1]).toBe(edges[1])
    expect(edges).toEqual(original)
    expect(relationshipEdges(edges, null)).toBe(edges)
  })
  it.each([false, true])('keeps source-to-target geometry, labels, markers and hitbox when destination is to the left=%s', (reverse) => {
    const props: EdgeProps<RelationshipFlowEdge> = {
      id: 'test', source: 'a', target: 'b', type: 'relationship', data: { flowing: true },
      sourceX: reverse ? 300 : 0, sourceY: 60, targetX: reverse ? 0 : 300, targetY: 140,
      sourcePosition: Position.Right, targetPosition: Position.Left, label: '素材',
      markerStart: 'url(#start)', markerEnd: 'url(#end)', interactionWidth: 30, pathOptions: { curvature: .4 },
    }
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container); roots.push(root)
    act(() => { root.render(<ReactFlowProvider><svg><RelationshipEdge {...props} /></svg></ReactFlowProvider>) })
    const [path] = getBezierPath({ ...props, curvature: .4 })
    expect([...container.querySelectorAll('path')].every((item) => item.getAttribute('d') === path)).toBe(true)
    expect(path.startsWith(`M${props.sourceX},${props.sourceY}`)).toBe(true)
    expect(container.querySelector('#test')?.getAttribute('marker-start')).toBe('url(#start)')
    expect(container.querySelector('#test')?.getAttribute('marker-end')).toBe('url(#end)')
    expect(container.querySelector('.react-flow__edge-interaction')?.getAttribute('stroke-width')).toBe('30')
    expect(container.querySelector('text')?.textContent).toBe('素材')
    expect(container.querySelector('.dc-edge-flow')?.getAttribute('pointer-events')).toBe('none')
    expect(container.querySelector('.dc-edge-flow')?.getAttribute('aria-hidden')).toBe('true')
    expect(container.querySelectorAll('.dc-edge-flow path')).toHaveLength(3)
    expect(container.querySelector('svg')?.lastElementChild?.classList.contains('react-flow__edge-textwrapper')).toBe(true)
  })
  it('switches direct relationships on single selection and stops on multiselect or clear without saving the graph', async () => {
    const { container, click, flowing, snapshot, original, save } = await workspace()
    expect(flowing()).toEqual([])
    click('b'); expect(flowing()).toEqual(['ab', 'bc'])
    click('c'); expect(flowing()).toEqual(['bc', 'cd'])
    click('a', true); expect(flowing()).toEqual([])
    act(() => { container.querySelector<HTMLButtonElement>('[data-clear]')!.click() })
    expect(flowing()).toEqual([])
    expect(JSON.stringify(snapshot)).toBe(original); expect(save).not.toHaveBeenCalled()
  })
  it('suspends hidden sidebar/document effects and restores the same selection without reloading or persisting it', async () => {
    const { click, flowing, show, api, save } = await workspace()
    click('b'); expect(flowing()).toEqual(['ab', 'bc'])
    await show(false); expect(flowing()).toEqual([])
    await show(true); expect(flowing()).toEqual(['ab', 'bc'])
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(flowing()).toEqual([])
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(flowing()).toEqual(['ab', 'bc'])
    expect(api.state).toHaveBeenCalledTimes(1); expect(save).not.toHaveBeenCalled()
  })
  it('switches flow from a node to clicked edges and clears it without saving', async () => {
    const { container, click, clickEdge, flowing, save, snapshot, original } = await workspace()
    click('b'); expect(flowing()).toEqual(['ab', 'bc'])
    clickEdge('cd'); expect(flowing()).toEqual(['cd'])
    clickEdge('xa'); expect(flowing()).toEqual(['xa'])
    clickEdge('ab', true); expect(flowing()).toEqual(['ab', 'xa'])
    act(() => { container.querySelector<HTMLButtonElement>('[data-clear]')!.click() })
    expect(flowing()).toEqual([])
    expect(save).not.toHaveBeenCalled(); expect(JSON.stringify(snapshot)).toBe(original)
  })
  it('suspends selected edge flow while hidden or during a marquee and restores it on cancellation', async () => {
    const { clickEdge, flowing, show, save } = await workspace()
    clickEdge('ab'); expect(flowing()).toEqual(['ab'])
    await show(false); expect(flowing()).toEqual([])
    await show(true); expect(flowing()).toEqual(['ab'])
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(flowing()).toEqual([])
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(flowing()).toEqual(['ab'])
    act(() => { store.setState({ userSelectionRect: { x: 1000, y: 1000, width: 50, height: 50, startX: 1000, startY: 1000 } }) })
    expect(flowing()).toEqual([])
    act(() => { window.dispatchEvent(new Event('blur')) })
    expect(flowing()).toEqual(['ab'])
    expect(save).not.toHaveBeenCalled()
  })
  it('hides flow during an actual marquee gesture and restores it when that gesture is cancelled', async () => {
    const { click, flowing, save } = await workspace()
    click('b'); expect(flowing()).toEqual(['ab', 'bc'])
    act(() => { store.setState({ userSelectionRect: { x: 1000, y: 1000, width: 50, height: 50, startX: 1000, startY: 1000 } }) })
    expect(flowing()).toEqual([])
    act(() => { window.dispatchEvent(new Event('blur')) })
    expect(flowing()).toEqual(['ab', 'bc'])
    expect(save).not.toHaveBeenCalled()
  })
})
