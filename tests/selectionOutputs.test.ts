import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { capabilitiesFor, emptyGraph, type Asset, type CanvasNode } from '../src/shared/contracts'
import { BUILTIN_MODELS } from '../src/shared/modelCatalog'
import { createCanvasNode, resolveOutput, type NodeCreationEnvironment } from '../src/client/nodeCreation'
import { connectSelection, selectionDownloads, selectionOutputs } from '../src/client/selectionOutputs'

function fixture() {
  const nodes: CanvasNode[] = ['image', 'audio', 'image', 'image'].map((kind, index) => ({
    id: randomUUID(), kind: `${kind}-asset` as CanvasNode['kind'], title: `来源${index}`, position: { x: index * 350, y: 0 },
    assetId: randomUUID(), modelId: null, params: null, prompt: '', selectedResultId: null,
  }))
  const assets: Asset[] = nodes.map((node) => ({ id: node.assetId!, nodeId: node.id, kind: node.kind === 'audio-asset' ? 'audio' : 'image',
    mime: node.kind === 'audio-asset' ? 'audio/mpeg' : 'image/png', filename: node.title, bytes: 1, createdAt: 1 }))
  const record = BUILTIN_MODELS.find((model) => model.kind === 'image')!
  const model = { ...record, has_api_key: true, capabilities: { ...capabilitiesFor(record), maxReferences: 2 } }
  const env: NodeCreationEnvironment = { assets, tasks: [], models: [model], expandedGroups: {} }
  const created = createCanvasNode({ ...emptyGraph(), nodes }, 'image-generation', { x: 0, y: 400 }, env)
  return { nodes, assets, env, graph: created.graph, target: created.node }
}
it('accepts in graph order, skips types/duplicates and enforces the progressively consumed limit without mutating input', () => {
  const f = fixture(), before = structuredClone(f.graph)
  const outputs = selectionOutputs(f.graph, f.nodes.map((node) => node.id).reverse(), f.env)
  const graph = connectSelection(f.graph, outputs, f.target.id, f.env)
  expect(graph.edges.map((edge) => edge.assetId)).toEqual([f.assets[0].id, f.assets[2].id])
  expect(connectSelection(graph, outputs, f.target.id, f.env)).toBe(graph)
  expect(connectSelection(f.graph, outputs, 'missing', f.env)).toBe(f.graph)
  expect(f.graph).toEqual(before)
})
it('continues after invalid MIME and removed sources, while preserving the frozen main output', () => {
  const f = fixture(), outputs = selectionOutputs(f.graph, f.nodes.map((node) => node.id), f.env)
  const env = { ...f.env, assets: f.assets.map((asset, index) => index === 0 ? { ...asset, mime: 'image/gif' } : asset) }
  expect(connectSelection(f.graph, outputs, f.target.id, env).edges.map((edge) => edge.assetId)).toEqual([f.assets[2].id, f.assets[3].id])
  const removed = { ...f.graph, nodes: f.graph.nodes.filter((node) => node.id !== f.nodes[2].id) }
  expect(connectSelection(removed, outputs, f.target.id, f.env).edges.map((edge) => edge.assetId)).toEqual([f.assets[0].id, f.assets[3].id])
})
it('includes a single batch main, expanded history explicit ports, and only visible download results, deduplicated', () => {
  const f = fixture(), node = { ...f.nodes[0], kind: 'image-generation' as const, assetId: null, selectedResultId: f.assets[2].id }
  const assets = [f.assets[0], { ...f.assets[2], nodeId: node.id }]
  const task = { id: randomUUID(), nodeId: node.id, workspaceId: 'w', status: 'completed' as const, resultIds: assets.map((asset) => asset.id), createdAt: 1, updatedAt: 1 }
  const graph = { ...emptyGraph(), nodes: [node] }, env = { ...f.env, assets, tasks: [task] }
  const picked = selectionOutputs(graph, [node.id], env)
  expect(picked.map((ref) => ref.assetId)).toEqual([assets[1].id])
  const changed = { ...graph, nodes: [{ ...node, selectedResultId: assets[0].id }] }
  expect(picked[0]).toEqual(resolveOutput(graph, node.id, null, env))
  expect(connectSelection({ ...changed, nodes: [...changed.nodes, f.target] }, picked, f.target.id, env).edges[0].assetId).toBe(assets[1].id)
  expect(selectionDownloads(graph, [node.id], env).map((asset) => asset.id)).toEqual([assets[1].id])
  expect(selectionDownloads(graph, [node.id], { ...env, expandedGroups: { [node.id]: true } })).toEqual(assets)
  const history = { ...env, tasks: [task, { ...task, id: randomUUID(), createdAt: 2, resultIds: [assets[0].id] }] }
  expect(selectionOutputs(graph, [node.id], history)).toEqual([])
  expect(selectionDownloads(graph, [node.id], history)).toEqual([assets[0]])
  const pending = { ...history, tasks: [...history.tasks, { ...task, id: randomUUID(), status: 'generating' as const, createdAt: 3, resultIds: [] }] }
  expect(selectionDownloads(graph, [node.id], pending)).toEqual([])
  expect(selectionDownloads(graph, [node.id], { ...pending, expandedGroups: { [node.id]: true } })).toEqual(assets)
  const expanded = { ...history, expandedGroups: { [node.id]: true } }
  const references = selectionOutputs(graph, [node.id], expanded)
  expect(references.map((ref) => [ref.assetId, ref.handleId, ref.history])).toEqual([
    [assets[0].id, `result:${assets[0].id}`, true], [assets[1].id, `result:${assets[1].id}`, true],
  ])
  expect(selectionDownloads(graph, [node.id], expanded).map((asset) => asset.id)).toEqual(assets.map((asset) => asset.id))
  expect(connectSelection({ ...graph, nodes: [node, f.target] }, references, f.target.id, history).edges).toEqual([])
})
it('skips cyclic sources and self connections and still connects the next valid source', () => {
  const f = fixture(), generated = { ...f.nodes[0], kind: 'image-generation' as const, assetId: null }
  const output = { ...f.assets[0], id: randomUUID(), nodeId: f.target.id }
  const tasks = [generated, f.target].map((node, index) => ({
    id: randomUUID(), nodeId: node.id, workspaceId: 'w', status: 'completed' as const,
    resultIds: [index ? output.id : f.assets[0].id], createdAt: 1, updatedAt: 1,
  }))
  const graph = { ...f.graph, nodes: f.graph.nodes.map((node) => node.id === generated.id ? generated : node),
    edges: [{ id: randomUUID(), source: f.target.id, target: generated.id, assetId: output.id }] }
  const env = { ...f.env, assets: [...f.assets, output], tasks }
  const outputs = selectionOutputs(graph, [generated.id, f.nodes[2].id, f.target.id], env)
  const next = connectSelection(graph, outputs, f.target.id, env)
  expect(next.edges.slice(1).map((edge) => edge.assetId)).toEqual([f.assets[2].id])
})
