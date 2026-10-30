import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import {
  emptyGraph, capabilitiesFor, defaultParams, type CanvasNode, type Asset, type PublicModel,
} from '../src/shared/contracts'
import type { NodeCreationEnvironment } from '../src/client/nodeCreation'
import { copyCanvasNodes, readCanvasNodes, pasteCanvasNodes } from '../src/client/nodeClipboard'
import { BUILTIN_MODELS } from '../src/shared/modelCatalog'

function fixture() {
  const source: CanvasNode = { id: randomUUID(), title: '素材', kind: 'image-asset', position: { x: -100, y: 30 },
    assetId: randomUUID(), selectedResultId: null, modelId: null, params: null, prompt: '' }
  const external = { ...source, id: randomUUID(), assetId: randomUUID(), position: { x: 0, y: -400 } }
  const target: CanvasNode = { ...source, id: randomUUID(), kind: 'image-generation', assetId: null,
    position: { x: 400, y: 130 }, params: { size: '1024x1024', n: 2 },
    prompt: `原始 @[${source.assetId}] 和 @[${external.assetId}]  文字\n`, selectedResultId: randomUUID() }
  const downstream = { ...target, id: randomUUID() }
  const asset: Asset = { id: source.assetId!, nodeId: source.id, kind: 'image', filename: '图.png', mime: 'image/png', bytes: 1, createdAt: 1 }
  const result = { ...asset, id: target.selectedResultId!, nodeId: target.id }
  const env: NodeCreationEnvironment = { assets: [asset, { ...asset, id: external.assetId!, nodeId: external.id }, result],
    tasks: [{ id: randomUUID(), nodeId: target.id, workspaceId: 'w', status: 'completed', resultIds: [result.id], createdAt: 1, updatedAt: 1 }],
    models: [], expandedGroups: { [target.id]: true } }
  const graph = { ...emptyGraph(), nodes: [source, external, target, downstream], edges: [
    { id: randomUUID(), source: external.id, target: target.id, assetId: external.assetId! },
    { id: randomUUID(), source: source.id, target: target.id, assetId: asset.id },
    { id: randomUUID(), source: target.id, target: downstream.id, assetId: result.id },
  ] }
  const packet = () => readCanvasNodes(copyCanvasNodes(graph, [source.id, target.id], 'w', 'https://local'), 'w', 'https://local')
  return { graph, env, source, external, target, asset, packet }
}
it('keeps all original sources and input order, creates drafts with new identities, and adds no outgoing wires', () => {
  const f = fixture(), original = structuredClone(f.graph), packet = f.packet()
  const result = pasteCanvasNodes(f.graph, packet, { x: 800, y: 500 }, f.env)
  const [source, target] = result.graph.nodes.slice(-2), edges = result.graph.edges.slice(f.graph.edges.length)
  expect(source.position).toEqual({ x: 800, y: 500 }); expect(target.position).toEqual({ x: 1300, y: 600 })
  expect(source.assetId).toBe(f.source.assetId); expect(source.title).toBe('素材 副本')
  expect(target.prompt).toBe(f.target.prompt); expect(target.params).toEqual(f.target.params)
  expect(target.selectedResultId).toBeNull(); expect(target.assetId).toBeNull()
  expect(edges.map((edge) => [edge.source, edge.target, edge.assetId])).toEqual([
    [f.external.id, target.id, f.external.assetId], [f.source.id, target.id, f.source.assetId],
  ])
  expect(new Set(result.graph.nodes.map((node) => node.id)).size).toBe(result.graph.nodes.length)
  expect(result.ids).toEqual([source.id, target.id]); expect(f.graph).toEqual(original)
  expect(result.graph.viewport).toBe(f.graph.viewport)
  expect(f.env.tasks).toHaveLength(1)
})
it('freezes nodes, prompt and references at copy time, and gives each paste separate params and identities', () => {
  const f = fixture(), packet = f.packet()
  f.target.prompt = '已修改'; f.target.params!.size = '512x512'; f.graph.edges.reverse()
  const first = pasteCanvasNodes(f.graph, packet, { x: 0, y: 0 }, f.env)
  const second = pasteCanvasNodes(first.graph, packet, { x: 20, y: 20 }, f.env)
  const a = first.graph.nodes.at(-1)!, b = second.graph.nodes.at(-1)!
  expect(a.prompt).not.toBe(f.target.prompt); expect(a.params!.size).toBe('1024x1024')
  expect(a.params).not.toBe(b.params); expect(a.id).not.toBe(b.id)
  expect(second.graph.edges.at(-2)!.source).toBe(f.external.id)
  expect(JSON.stringify(packet)).not.toContain('resultIds')
})
it('uses original generated upstream outputs even when that upstream is copied in the same batch', () => {
  const f = fixture(), downstream = f.graph.nodes.at(-1)!
  Object.assign(f.target, { playing: true, history: ['runtime'], taskId: 'runtime-task' })
  const packet = readCanvasNodes(copyCanvasNodes(f.graph, [f.target.id, downstream.id], 'w', 'https://local'), 'w', 'https://local')
  const result = pasteCanvasNodes(f.graph, packet, { x: 0, y: 0 }, f.env)
  expect(result.graph.nodes.slice(-2).every((node) => node.assetId === null && node.selectedResultId === null)).toBe(true)
  expect(result.graph.edges.at(-1)).toMatchObject({ source: f.target.id, target: result.ids[1], assetId: f.target.selectedResultId })
  expect(JSON.stringify(packet)).not.toContain('runtime')
})
it('checks current model input limits without changing the copied parameters', () => {
  const f = fixture(), record = BUILTIN_MODELS.find((model) => model.protocol === 'gemini-image')!
  f.target.modelId = record.id
  const packet = f.packet(), before = structuredClone(packet)
  f.env.models = [{ ...record, capabilities: { ...capabilitiesFor(record), maxReferences: 1 }, has_api_key: true, api_key_mask: '' }]
  expect(() => pasteCanvasNodes(f.graph, packet, { x: 0, y: 0 }, f.env)).toThrow('模型要求')
  expect(packet).toEqual(before)
})
it.each(['missing source', 'changed source asset', 'missing input asset', 'missing task ownership', 'missing resource'])(
  'rejects the entire paste on %s without mutating the graph', (failure) => {
    const f = fixture(), packet = f.packet()
    if (failure === 'missing source') f.graph.nodes = f.graph.nodes.filter((node) => node.id !== f.source.id)
    if (failure === 'changed source asset') f.source.assetId = randomUUID()
    if (failure === 'missing input asset') f.env.assets = f.env.assets.filter((asset) => asset.id !== f.external.assetId)
    if (failure === 'missing task ownership') {
      f.graph.nodes[0] = { ...f.source, kind: 'image-generation', assetId: null }; f.env.tasks = []
    }
    if (failure === 'missing resource') { packet.edges = []; f.env.assets = f.env.assets.filter((asset) => asset.id !== f.source.assetId) }
    const before = structuredClone(f.graph)
    expect(() => pasteCanvasNodes(f.graph, packet, { x: 0, y: 0 }, f.env)).toThrow()
    expect(f.graph).toEqual(before)
  })
it('allows copying an unconfigured empty draft and retains preexisting dangling mentions', () => {
  const f = fixture()
  f.target.prompt = `@[${randomUUID()}]`; f.target.params = null; f.graph.edges = []
  const packet = readCanvasNodes(copyCanvasNodes(f.graph, [f.target.id], 'w', 'https://local'), 'w', 'https://local')
  expect(pasteCanvasNodes(f.graph, packet, { x: 0, y: 0 }, f.env).graph.nodes.at(-1)!.prompt).toBe(f.target.prompt)
})
it.each(['seedance-video', 'wan-video', 'minimax-video'] as const)('keeps %s frames, roles and size exactly and checks copied limits', (protocol) => {
  const f = fixture(), record = BUILTIN_MODELS.find((model) => model.protocol === protocol)!
  const model: PublicModel = { ...record, has_api_key: false, api_key_mask: '', capabilities: capabilitiesFor(record) }
  f.target.kind = 'video-generation'; f.target.modelId = model.id
  f.target.params = { ...defaultParams(model), videoMode: 'frames', firstFrameId: f.external.assetId!, lastFrameId: f.source.assetId! }
  f.env.models = [model]
  const packet = f.packet(), pasted = pasteCanvasNodes(f.graph, packet, { x: 0, y: 0 }, f.env).graph.nodes.at(-1)!
  expect(pasted.params).toEqual(f.target.params)
  f.env.models = [{ ...model, capabilities: { ...model.capabilities, referenceKinds: [] } }]
  // Frames have native image-only capabilities; three input frames still fail.
  const source = { ...f.source, id: randomUUID(), assetId: randomUUID() }
  f.graph.nodes.push(source); f.env.assets = [...f.env.assets, { ...f.asset, id: source.assetId!, nodeId: source.id }]
  const extra = { ...packet.edges[0], id: randomUUID(), source: source.id, assetId: source.assetId! }
  packet.edges.push(extra)
  expect(() => pasteCanvasNodes(f.graph, packet, { x: 0, y: 0 }, f.env)).toThrow()
})
it('copies TTS controls and text while clearing playback, results and all task identities', () => {
  const f = fixture()
  f.target.kind = 'tts-generation'; f.target.params = { type: 'tts', reference_id: 'voice', speed: 1.2, volume: -3 }
  f.target.prompt = '(happy) 你好'; f.graph.edges = []
  const packet = readCanvasNodes(copyCanvasNodes(f.graph, [f.target.id], 'w', 'https://local'), 'w', 'https://local')
  const pasted = pasteCanvasNodes(f.graph, packet, { x: 0, y: 0 }, f.env).graph.nodes.at(-1)!
  expect(pasted).toMatchObject({ params: f.target.params, prompt: f.target.prompt, assetId: null, selectedResultId: null, modelId: null })
  expect(f.env.tasks.some((task) => task.nodeId === pasted.id)).toBe(false)
})
it.each(['workspace', 'origin', 'version', 'extra field', 'duplicate nodes', 'foreign target', 'malformed', 'oversized'])(
  'rejects %s clipboard packets', (boundary) => {
    const f = fixture(), packet: any = f.packet()
    if (boundary === 'workspace') packet.workspace = 'other'
    if (boundary === 'origin') packet.origin = 'https://other'
    if (boundary === 'version') packet.version = 2
    if (boundary === 'extra field') packet.nodes[0].taskId = randomUUID()
    if (boundary === 'duplicate nodes') packet.nodes.push(packet.nodes[0])
    if (boundary === 'foreign target') packet.edges[0].target = randomUUID()
    const text = boundary === 'malformed' ? 'hello' : boundary === 'oversized' ? 'x'.repeat(8 * 1024 * 1024 + 1) : JSON.stringify(packet)
    expect(() => readCanvasNodes(text, 'w', 'https://local')).toThrow()
  })
