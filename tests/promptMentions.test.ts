import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { assetToken, mentionQuery, promptParts, resolvePrompt } from '../src/shared/promptMentions'
import { connectedPromptReferences, insertPromptReference, promptCandidates } from '../src/client/promptReferences'
import { defaultParams, emptyGraph, type Asset, type CanvasNode } from '../src/shared/contracts'
import { MOCK_MODELS, mockRecord, validateMockGeneration } from '../src/shared/mockModels'

function fixture() {
  const model = MOCK_MODELS[0]
  const asset: Asset = { id: randomUUID(), kind: 'image', mime: 'image/png', filename: 'reference.png', bytes: 10, createdAt: 0, nodeId: null, taskId: null }
  const source: CanvasNode = { id: randomUUID(), kind: 'image-asset', title: '远山', position: { x: 0, y: 0 }, modelId: null, prompt: '', params: null, assetId: asset.id, selectedResultId: null }
  const target: CanvasNode = { ...source, id: randomUUID(), kind: 'image-generation', title: '生成', modelId: model.id, params: defaultParams(model), assetId: null }
  return { model, asset, source, target, graph: { ...emptyGraph(), nodes: [source, target] } }
}
describe('stable prompt references', () => {
  it('preserves ordinary text and resolves repeated tokens using the input order', () => {
    const { asset } = fixture()
    const other = { ...asset, id: randomUUID() }
    const raw = `结合${assetToken(asset.id)}和${assetToken(other.id)}\n再次用${assetToken(asset.id)}`
    expect(resolvePrompt(raw, [other.id, asset.id], [asset, other])).toBe('结合[参考图2]和[参考图1]\n再次用[参考图2]')
    expect(resolvePrompt('邮件 a@b.com，中文\n😀', [], [])).toBe('邮件 a@b.com，中文\n😀')
    expect(promptParts(raw).map((part) => part.value).join('')).toBe(raw)
  })
  it('rejects missing, disconnected and malformed references before creating a task', () => {
    const { asset, model } = fixture()
    expect(() => resolvePrompt(assetToken(asset.id), [], [asset])).toThrow('未连接')
    expect(() => resolvePrompt(assetToken(asset.id), [asset.id], [])).toThrow('丢失')
    expect(() => resolvePrompt('{{asset:garbage}}', [], [])).toThrow('丢失')
    expect(() => validateMockGeneration({ model: mockRecord(model.id), prompt: assetToken(asset.id), params: defaultParams(model), referenceIds: [] }, [asset])).toThrow('未连接')
  })
  it('finds the @ query at a caret without matching email addresses or previous chips', () => {
    expect(mentionQuery('远景，@山', 5)).toMatchObject({ start: 3, end: 5, query: '山' })
    expect(mentionQuery('a@b.com', 7)).toBeNull()
    expect(mentionQuery('前文 @山 后文', 5)).toMatchObject({ start: 3, end: 5, query: '山' })
    const prefix = assetToken(randomUUID())
    expect(mentionQuery(prefix + '@', prefix.length + 1)).toMatchObject({ start: prefix.length, query: '' })
    expect(mentionQuery(prefix, 10)).toBeNull()
  })
  it('connects and stores one reference atomically, without adding duplicate edges', () => {
    const { graph, target, asset, model } = fixture()
    const item = promptCandidates(graph, target.id, [asset], [], model.capabilities)[0]
    const inserted = insertPromptReference(graph, target.id, item, '借鉴' + item.token, [asset], [], model.capabilities)
    expect(inserted.graph.edges).toHaveLength(1)
    expect(inserted.graph.nodes[1].prompt).toBe('借鉴' + item.token)
    expect(inserted.reference).toMatchObject({ label: '参考图1', connected: true })
    const again = insertPromptReference(inserted.graph, target.id, inserted.reference, item.token + item.token, [asset], [], model.capabilities)
    expect(again.graph.edges).toBe(inserted.graph.edges)
    expect(graph.edges).toHaveLength(0)
  })
  it('updates labels after rename while preserving IDs and linked historical outputs', () => {
    const { graph, target, asset, source, model } = fixture()
    const old = { ...asset, id: randomUUID() }
    graph.nodes[0] = { ...source, kind: 'image-generation', assetId: null, selectedResultId: asset.id }
    graph.edges.push({ id: randomUUID(), source: source.id, target: target.id, assetId: old.id })
    const tasks = [{ nodeId: source.id, resultIds: [old.id, asset.id] }]
    let items = promptCandidates(graph, target.id, [asset, old], tasks, model.capabilities)
    expect(items.map((item) => item.assetId)).toEqual([old.id, asset.id])
    graph.nodes[0].title = '改名远山'
    const reference = connectedPromptReferences(graph, target.id, [asset, old])[0]
    expect(reference).toMatchObject({ assetId: old.id, name: '改名远山', token: assetToken(old.id) })
    graph.nodes[0].selectedResultId = old.id
    items = promptCandidates(graph, target.id, [asset, old], tasks, model.capabilities)
    expect(items.map((item) => item.assetId)).toEqual([old.id])
    expect(graph.edges[0].assetId).toBe(old.id)
  })
  it('limits candidates by capability, reference count, ownership and cycles', () => {
    const { graph, target, asset, source, model } = fixture()
    expect(promptCandidates(graph, target.id, [{ ...asset, mime: 'image/gif' }], [], model.capabilities)).toEqual([])
    expect(promptCandidates(graph, target.id, [asset], [], { ...model.capabilities, maxReferences: 0 })).toEqual([])
    expect(promptCandidates(graph, target.id, [asset], [], { ...model.capabilities, referenceKinds: [] })).toEqual([])
    const downstream = { ...target, id: randomUUID(), selectedResultId: asset.id }
    graph.nodes.push(downstream)
    graph.edges.push({ id: randomUUID(), source: target.id, target: downstream.id, assetId: randomUUID() })
    expect(promptCandidates(graph, target.id, [asset], [{ nodeId: downstream.id, resultIds: [asset.id] }], model.capabilities).map((item) => item.sourceId)).toEqual([source.id])
    const item = promptCandidates(graph, target.id, [asset], [], model.capabilities)[0]
    graph.nodes = graph.nodes.filter((node) => node.id !== source.id)
    expect(() => insertPromptReference(graph, target.id, item, item.token, [asset], [], model.capabilities)).toThrow('不可引用')
  })
})
