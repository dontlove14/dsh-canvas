import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { CanvasNodeSchema, defaultTtsParams, emptyGraph, NodeKindSchema, nodeResults, type Asset } from '../src/shared/contracts'
import type { TaskSummary } from '../src/shared/v2'
import { ReferenceCatalog } from '../src/shared/referenceCatalog'
import { ChatReferenceSchema, referenceSpans, referenceText } from '../src/shared/chatReferences'

function fixture() {
  const nodes = NodeKindSchema.options.map((kind) => CanvasNodeSchema.parse({ id: randomUUID(), kind, title: kind, position: { x: 0, y: 0 },
    ...(kind === 'tts-generation' ? { params: defaultTtsParams() } : {}) }))
  const graph = { ...emptyGraph(), nodes }
  const snapshot = { workspaceId: randomUUID(), graphRevision: 5, graph, assets: [] as Asset[], tasks: [] as TaskSummary[] }
  const node = nodes[0]
  const task = (createdAt: number, status: TaskSummary['status'] = 'completed'): TaskSummary => ({
    id: randomUUID(), nodeId: node.id, workspaceId: snapshot.workspaceId, resultIds: [], createdAt, updatedAt: 100 - createdAt, status,
  })
  const asset = (task: TaskSummary, filename: string): Asset => ({
    id: randomUUID(), nodeId: node.id, taskId: task.id, kind: 'image', mime: 'image/png', filename, bytes: 10, createdAt: 20,
  })
  const old = task(1), current = task(2), running = task(2, 'generating')
  const assets = [asset(old, '历史人物.png'), asset(current, '当前1.png'), asset(current, '当前2.png')]
  old.resultIds = [assets[0].id]; current.resultIds = [assets[2].id, assets[1].id]
  snapshot.assets = [assets[1], assets[2], assets[0]] // Deliberately unlike preview/result order.
  snapshot.tasks = [old, current, running]
  return { snapshot, node, nodes, old, current, running, assets }
}
describe('Unified node and exact-media references', () => {
  it('admits all six empty node kinds, never inventing an asset, and keeps title-only markers', () => {
    const f = fixture()
    f.snapshot.assets = []; f.snapshot.tasks = []
    const rows = new ReferenceCatalog(f.snapshot).items('session', '画布', '')
    expect(rows.map((row) => row.type)).toEqual(Array(6).fill('node'))
    for (const row of rows) {
      expect(row.type === 'node' && row.hasMedia).toBe(false)
      if (row.type === 'node') {
        expect(referenceSpans(`前${referenceText(row.ref)}后`)[0].ref).toEqual(row.ref)
        expect(row.ref).not.toHaveProperty('assetId')
        expect(row.ref.label).toBe(row.ref.kind === 'node' ? row.label : '')
      }
    }
    expect(ChatReferenceSchema.safeParse({ version: 1, kind: 'node', label: '节点' }).success).toBe(false)
    expect(ChatReferenceSchema.safeParse({ version: 3, kind: 'node', label: '节点' }).success).toBe(false)
  })
  it('matches the real preview, preserves resultIds order and the prior batch during pending or failed generation', () => {
    const f = fixture()
    for (const selected of [f.assets[1].id, f.assets[0].id, null]) {
      f.node.selectedResultId = selected
      const index = new ReferenceCatalog(f.snapshot)
      const expected = nodeResults(f.node.id, f.snapshot.tasks, f.snapshot.assets).find((asset) => asset.id === selected) ??
        nodeResults(f.node.id, f.snapshot.tasks, f.snapshot.assets)[0]
      expect(index.current(f.node)).toEqual(expected)
      const rows = index.items('session', '画布', '', f.node.id)
      expect(rows.map((row) => row.type)).toEqual(['media', 'media', 'directory'])
      expect(rows.flatMap((row) => row.type === 'media' ? [row.ref.assetId] : [])).toEqual(f.current.resultIds)
      expect(rows.filter((row) => row.type === 'media' && row.current)).toHaveLength(1)
      expect(rows[2]).toMatchObject({ taskId: f.old.id })
      expect(index.items('session', '画布', '', f.node.id, f.old.id)).toMatchObject([{ ref: { assetId: f.assets[0].id }, current: false }])
      f.running.status = 'save_failed'
      expect(index.context(f.node).tasks[0].status).toBe('save_failed')
    }
  })
  it('finds historical media by filename and title without converting its identity to the current output', () => {
    const f = fixture(), index = new ReferenceCatalog(f.snapshot)
    expect(index.items('session', '画布', '历史人物')).toMatchObject([{ type: 'media', ref: { assetId: f.assets[0].id, nodeId: f.node.id }, current: false }])
    const rows = index.items('session', '画布', f.node.title)
    expect(rows[0]).toMatchObject({ type: 'node' })
    expect(rows.filter((row) => row.type === 'media')).toHaveLength(3)
  })
  it('reads exact old-edge inputs and direct downstream, limiting asset access to self and incoming edges', () => {
    const f = fixture(), target = f.nodes[1], downstream = { ...f.node, id: randomUUID(), title: '下游' }
    f.snapshot.graph.nodes.push(downstream)
    f.snapshot.graph.edges = [
      { id: randomUUID(), source: f.node.id, target: target.id, assetId: f.assets[0].id },
      { id: randomUUID(), source: target.id, target: downstream.id, assetId: f.assets[1].id },
    ]
    const index = new ReferenceCatalog(f.snapshot), context = index.context(target)
    expect(context.upstream).toMatchObject([{ source: { nodeId: f.node.id }, assetId: f.assets[0].id }])
    expect(context.downstream).toMatchObject([{ target: { nodeId: downstream.id }, assetId: f.assets[1].id }])
    expect(index.related(target, f.assets[0].id)).toEqual(f.assets[0])
    expect(index.related(target, f.assets[1].id)).toBeUndefined()
    expect(index.context(f.node).currentOutput!.id).toBe(f.assets[2].id)
    f.snapshot.assets = f.snapshot.assets.filter((asset) => asset.id !== f.assets[0].id)
    expect(new ReferenceCatalog(f.snapshot).context(target).upstream[0]).toMatchObject({ asset: null, available: false })
  })
  it('binds a resource to its original asset even if other media carry its nodeId', () => {
    const f = fixture(), resource = f.nodes[2]
    f.assets[0].nodeId = resource.id; resource.assetId = f.assets[0].id
    f.assets[1].nodeId = resource.id
    const index = new ReferenceCatalog(f.snapshot)
    expect(index.media(resource)).toEqual([f.assets[0]])
    expect(index.related(resource, f.assets[1].id)).toBeUndefined()
  })
})
