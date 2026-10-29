import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { capabilitiesFor, emptyGraph, NodeLabels, isGeneration, type Asset, type CanvasNode, type PublicModel } from '../src/shared/contracts'
import { BUILTIN_MODELS } from '../src/shared/modelCatalog'
import { CREATABLE_NODES, connectReference, createCanvasNode, nodeCreationChoices, resolveOutput, outputAvailable, type NodeCreationEnvironment } from '../src/client/nodeCreation'
import type { TaskSummary } from '../src/shared/v2'

function fixture(kind: Asset['kind'] = 'image') {
  const source: CanvasNode = { id: randomUUID(), kind: `${kind}-asset`, title: '来源', position: { x: 0, y: 0 },
    assetId: randomUUID(), modelId: null, prompt: '', params: null, selectedResultId: null }
  const asset: Asset = { id: source.assetId!, nodeId: source.id, kind, mime: { image: 'image/png', video: 'video/mp4', audio: 'audio/mpeg' }[kind],
    filename: '素材', bytes: 1, createdAt: 1 }
  const graph = { ...emptyGraph(), nodes: [source] }
  const env: NodeCreationEnvironment = { assets: [asset], tasks: [], models: [], expandedGroups: {} }
  const reference = resolveOutput(graph, source.id, null, env)!
  return { source, asset, graph, env, reference }
}
function model(kind: PublicModel['kind'], protocol?: PublicModel['protocol']): PublicModel {
  const record = BUILTIN_MODELS.find((model) => model.kind === kind && (!protocol || model.protocol === protocol))!
  return { ...record, has_api_key: true, endpoint_id: 'ep-fixture', capabilities: capabilitiesFor(record) }
}
describe('creation policy shared by the dock and both canvas menus', () => {
  it('keeps the full registry, defaults, sequential names and exact flow coordinates', () => {
    const f = fixture(), point = { x: -400.25, y: 700.5 }
    expect(CREATABLE_NODES.map((entry) => entry.kind).sort()).toEqual(Object.keys(NodeLabels).filter((kind) => isGeneration(kind as CanvasNode['kind'])).sort())
    expect(nodeCreationChoices(f.graph, point, f.env).map((entry) => entry.kind)).toEqual(CREATABLE_NODES.map((entry) => entry.kind))
    for (const entry of CREATABLE_NODES) {
      const first = createCanvasNode(f.graph, entry.kind, point, f.env)
      const second = createCanvasNode(first.graph, entry.kind, point, f.env)
      expect(first.node.position).toEqual(point); expect(second.node.title).toMatch(/ 2$/)
      expect(first.graph.edges).toBe(f.graph.edges); expect(first.node.prompt).toBe('')
      if (entry.kind === 'tts-generation') expect(first.node.params).toEqual({ type: 'tts', reference_id: '', speed: 1, volume: 0 })
    }
  })
  it('adds node and fixed-asset edge atomically, leaving the input unchanged', () => {
    const f = fixture(), before = structuredClone(f.graph)
    const result = createCanvasNode(f.graph, 'image-generation', { x: 1, y: 2 }, f.env, f.reference)
    expect(result.graph.edges).toEqual([{ id: expect.any(String), source: f.source.id, target: result.node.id, assetId: f.asset.id }])
    expect(f.graph).toEqual(before)
    const choices = nodeCreationChoices(f.graph, { x: 0, y: 0 }, f.env, f.reference)
    expect(choices.map((item) => item.kind)).toEqual(['image-generation', 'video-generation'])
    expect(() => createCanvasNode(f.graph, 'tts-generation', { x: 0, y: 0 }, f.env, f.reference)).toThrow('不支持输入')
    expect(f.graph).toEqual(before)
  })
  it.each(['video', 'audio'] as const)('selects a compatible configured model for %s; missing models hide creation choices', (kind) => {
    const f = fixture(kind), video = model('video'), incompatible = { ...video, id: 'incompatible', capabilities: { ...video.capabilities, maxReferences: 0 } }
    expect(nodeCreationChoices(f.graph, { x: 0, y: 0 }, f.env, f.reference)).toEqual([])
    const environment = { ...f.env, models: [incompatible as PublicModel, video] }
    expect(nodeCreationChoices(f.graph, { x: 0, y: 0 }, environment, f.reference).map((item) => item.kind)).toEqual(['video-generation'])
    const result = createCanvasNode(f.graph, 'video-generation', { x: 0, y: 0 }, environment, f.reference)
    expect(result.node.modelId).toBe(video.id); expect(result.graph.edges[0].assetId).toBe(f.asset.id)
    // Audio alone may be connected before an image arrives; generate-time validation is separate.
    expect(result.node.kind).toBe('video-generation')
  })
  it('retains direct-wire duplicate, cycle, MIME and reference-count protection', () => {
    const f = fixture(), video = model('video')
    const env = { ...f.env, models: [video] }
    const result = createCanvasNode(f.graph, 'video-generation', { x: 0, y: 0 }, env, f.reference)
    expect(() => connectReference(result.graph, f.reference, result.node.id, env)).toThrow('重复引用')
    expect(() => createCanvasNode(f.graph, 'image-generation', { x: 0, y: 0 }, { ...env, assets: [{ ...f.asset, mime: 'image/gif' }] }, f.reference)).toThrow('PNG')
    const noReferences = { ...video, capabilities: { ...video.capabilities, maxReferences: 0 } }
    expect(() => createCanvasNode(f.graph, 'video-generation', { x: 0, y: 0 }, { ...env, models: [noReferences] }, f.reference)).toThrow('上限')
    const generatedSource = { ...f.source, kind: 'image-generation' as const, assetId: null }
    const tasks: TaskSummary[] = [{ id: 't', nodeId: f.source.id, workspaceId: 'w', status: 'completed', resultIds: [f.asset.id], createdAt: 1, updatedAt: 1 }]
    const cyclic = { ...result.graph, nodes: [generatedSource, result.node], edges: [...result.graph.edges, { id: randomUUID(), source: result.node.id, target: f.source.id, assetId: 'downstream' }] }
    const downstream = { ...f.asset, id: 'downstream', nodeId: result.node.id }
    expect(() => connectReference({ ...cyclic, edges: cyclic.edges.slice(1) }, f.reference, result.node.id,
      { ...env, assets: [f.asset, downstream], tasks: [...tasks, { ...tasks[0], id: 'd', nodeId: result.node.id, resultIds: [downstream.id] }] })).toThrow('循环')
  })
  it('fixes a selected batch result, requires explicit expanded history ports, and rechecks latest ownership', () => {
    const f = fixture(), second = { ...f.asset, id: randomUUID() }
    const source = { ...f.source, kind: 'image-generation' as const, assetId: null, selectedResultId: second.id }
    const graph = { ...f.graph, nodes: [source] }
    const task: TaskSummary = { id: 'task', nodeId: source.id, workspaceId: 'w', status: 'completed', resultIds: [f.asset.id, second.id], createdAt: 1, updatedAt: 1 }
    const env = { ...f.env, assets: [f.asset, second], tasks: [task] }
    const picked = resolveOutput(graph, source.id, null, env)!
    expect(picked.assetId).toBe(second.id)
    expect(outputAvailable({ ...graph, nodes: [{ ...source, selectedResultId: f.asset.id }] }, picked, env)).toBe(true)
    const history = { ...env, tasks: [task, { ...task, id: 'task2', resultIds: [f.asset.id] }], expandedGroups: { [source.id]: true } }
    expect(resolveOutput(graph, source.id, null, history)).toBeUndefined()
    const explicit = resolveOutput(graph, source.id, `result:${second.id}`, history)!
    expect(explicit.assetId).toBe(second.id)
    expect(outputAvailable(graph, explicit, { ...history, expandedGroups: {} })).toBe(false)
    expect(outputAvailable(graph, picked, { ...env, tasks: [] })).toBe(false)
    expect(outputAvailable({ ...graph, nodes: [] }, picked, env)).toBe(false)
  })
})
