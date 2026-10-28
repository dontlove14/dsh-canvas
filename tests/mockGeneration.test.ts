import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { CanvasService } from '../src/host/service'
import { fakeFactory, initialize, cloudPath, remoteBody } from './support/objectStorage'
import { mockOutputId } from '../src/host/mockGeneration'
import { videoFirstFrame } from '../src/host/media/previews'
import { MOCK_MODELS, mockRecord, validateMockGeneration } from '../src/shared/mockModels'
import { defaultParams, emptyGraph, GenerationParamsSchema, supportsVideoDuration, type CanvasNode, type Task } from '../src/shared/contracts'
import { generationFrame, connectionAsset } from '../src/client/generationLayout'
import { chooseResolution, sizeChoices } from '../src/client/generationParams'
import { assetToken } from '../src/shared/promptMentions'
import { BUILTIN_MODELS } from '../src/shared/modelCatalog'

const dispose: Array<() => Promise<void>> = []
afterEach(async () => { vi.unstubAllGlobals(); for (const cleanup of dispose.splice(0).reverse()) await cleanup() })
async function service(root?: string) {
  if (!root) { root = await mkdtemp(join(tmpdir(), 'canvas-mock-')); const path = root; dispose.push(() => rm(path, { recursive: true, force: true })) }
  const instance = new CanvasService({ dataDir: root, maxConcurrentTasks: 1, pollIntervalMs: 50, requestTimeoutMs: 3000, maxMediaBytes: 8_000_000, maxReferenceBytes: 1_000_000 }, undefined, fakeFactory(root))
  await initialize(instance, true); dispose.push(() => instance.close())
  return instance
}
function generator(index = 0, count = 4): CanvasNode {
  const model = MOCK_MODELS[index]
  return { id: randomUUID(), kind: `${model.kind}-generation`, title: 'Mock test', position: { x: 0, y: 0 }, modelId: model.id,
    prompt: 'a quiet mountain lake', params: { ...defaultParams(model), n: count }, assetId: null, selectedResultId: null }
}
async function finished(instance: CanvasService, id: string) {
  const deadline = Date.now() + 20000
  for (;;) {
    const task = instance.store.state('w').tasks.find((task) => task.id === id)!
    if (task.status === 'completed' && !instance.runtime.isActive(id)) return task
    if (['unknown', 'failed', 'save_failed'].includes(task.status) || Date.now() > deadline) throw new Error(`${task.status}: ${task.error}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

describe('Mock task pipeline', () => {
  it('creates distinct local PNGs without fetch/credentials and keeps concrete edges when the main result changes', async () => {
    const network = vi.fn(() => { throw new Error('Mock must not fetch') }); vi.stubGlobal('fetch', network)
    const instance = await service(); const node = generator()
    const state = await instance.saveGraph('w', { ...emptyGraph(), nodes: [node] }, 0)
    const requestId = randomUUID()
    const response = await instance.handle(new Request('http://localhost/api/canvas/v2/mock-generate?canvas=w', {
      method: 'POST', body: JSON.stringify({ nodeId: node.id, revision: state.graphRevision, requestId }),
    }))
    expect(response.status).toBe(202)
    const task = await response.json()
    expect(task).not.toHaveProperty('snapshot')
    expect((await instance.generate('w', node.id, state.graphRevision, requestId, true)).id).toBe(task.id)
    await expect(instance.generate('w', node.id, state.graphRevision, requestId)).rejects.toMatchObject({ code: 'REQUEST_REUSED' })
    const completed = await finished(instance, task.id)
    expect(completed.resultIds).toEqual([0, 1, 2, 3].map((i) => mockOutputId(task.id, i)))
    const buffers = await Promise.all(completed.resultIds.map((id) => instance.store.readMedia(id, 8000000)))
    expect(new Set(buffers.map((buffer) => buffer.toString('base64'))).size).toBe(4)
    expect(await sharp(buffers[0]).metadata()).toMatchObject({ format: 'png', width: 1024, height: 1024 })
    expect(await instance.store.db.get('SELECT credential_ref,submit_issued,external_completed_at FROM task_details WHERE task_id=?', [task.id])).toMatchObject({ credential_ref: null, submit_issued: 0, external_completed_at: null })
    expect(network).not.toHaveBeenCalled()
    expect(instance.store.listModels().every((model) => !model.has_api_key)).toBe(true)
    expect(instance.store.listModels().map((model) => model.id)).toEqual(BUILTIN_MODELS.map((model) => model.id))
    const next = instance.store.state('w'); const target = generator()
    const edge = { id: randomUUID(), source: node.id, target: target.id, assetId: completed.resultIds[0] }
    const saved = await instance.saveGraph('w', { ...next.graph, nodes: [{ ...node, selectedResultId: completed.resultIds[2] }, target], edges: [edge] }, next.graphRevision)
    expect(saved.graph.edges).toEqual([edge])
    const result = await instance.handle(new Request(`http://localhost/api/canvas/v2/media?canvas=w&id=${completed.resultIds[0]}&variant=preview&v=1`))
    expect(result.status).toBe(307); expect(await sharp(await remoteBody(instance.store, result)).metadata()).toMatchObject({ format: 'webp' })
  })
  it('rejects stale revisions, unsupported params and real configured models on the Mock route', async () => {
    const instance = await service(); const node = { ...generator(1, 4), params: { ...defaultParams(MOCK_MODELS[1]), size: '2048x2048' } }
    await instance.saveGraph('w', { ...emptyGraph(), nodes: [node] }, 0)
    await expect(instance.generate('w', node.id, 0, randomUUID(), true)).rejects.toMatchObject({ code: 'GRAPH_CONFLICT' })
    await expect(instance.generate('w', node.id, 1, randomUUID(), true)).rejects.toThrow('尺寸')
    const real = (await instance.store.saveModel({ ...BUILTIN_MODELS[0], api_key: 'test' }))[0]
    await instance.saveGraph('w', { ...emptyGraph(), nodes: [{ ...node, modelId: real.id }] }, 1)
    await expect(instance.generate('w', node.id, 2, randomUUID(), true)).rejects.toThrow('Mock')
    expect(instance.store.state('w').tasks).toHaveLength(0)
  })
  it('recovers an accepted Mock task after shutdown without a credential and preserves primary selection', async () => {
    const original = await service(); const node = generator()
    const task: Task = { id: randomUUID(), nodeId: node.id, workspaceId: 'w', snapshot: { model: mockRecord(node.modelId!), prompt: node.prompt, params: node.params!, referenceIds: [] },
      status: 'submitted', resultIds: [], createdAt: Date.now(), updatedAt: Date.now() }
    await original.store.update('w', (state) => { state.graph.nodes.push(node); state.tasks.push(task) })
    await original.close()
    const recovered = await service(original.config.dataDir)
    const completed = await finished(recovered, task.id)
    const state = recovered.store.state('w')
    await recovered.saveGraph('w', { ...state.graph, nodes: [{ ...node, selectedResultId: completed.resultIds[3] }] }, state.graphRevision)
    await recovered.close()
    const reopened = await service(original.config.dataDir)
    expect(reopened.store.state('w').graph.nodes[0].selectedResultId).toBe(completed.resultIds[3])
    expect(reopened.store.state('w').tasks[0].resultIds).toEqual(completed.resultIds)
  })
  it('renders a playable video at the selected dimensions and duration', async () => {
    const network = vi.fn(() => { throw new Error('Mock must not fetch') }); vi.stubGlobal('fetch', network)
    const instance = await service(); const node = generator(2, 1)
    const state = await instance.saveGraph('w', { ...emptyGraph(), nodes: [node] }, 0)
    const task = await instance.generate('w', node.id, state.graphRevision, randomUUID(), true)
    const completed = await finished(instance, task.id)
    const asset = instance.store.state('w').assets.find((asset) => asset.id === completed.resultIds[0])!
    expect(asset).toMatchObject({ kind: 'video', mime: 'video/mp4', width: 1280, height: 720 })
    expect(asset.duration).toBeCloseTo(4, 0)
    await expect(stat(instance.store.stagePath(`${asset.id}.raw`))).rejects.toMatchObject({ code: 'ENOENT' })
    const frame = await videoFirstFrame(await cloudPath(instance.store, asset.id), new AbortController().signal)
    expect(await sharp(frame).metadata()).toMatchObject({ format: 'png' })
    expect(network).not.toHaveBeenCalled()
  }, 25000)
  it.each([0, 3])('saves ten distinct outputs in order and persists the tenth primary result (preset %s)', async (index) => {
    const network = vi.fn(() => { throw new Error('Mock must not fetch') }); vi.stubGlobal('fetch', network)
    const instance = await service(); const node = generator(index, 10)
    const saved = await instance.saveGraph('w', { ...emptyGraph(), nodes: [node] }, 0)
    const completed = await finished(instance, (await instance.generate('w', node.id, saved.graphRevision, randomUUID(), true)).id)
    const ids = Array.from({ length: 10 }, (_, i) => mockOutputId(completed.id, i))
    expect(completed.resultIds).toEqual(ids)
    const assets = instance.store.state('w').assets.filter((asset) => ids.includes(asset.id))
    expect(assets).toHaveLength(10)
    const bytes = await Promise.all(ids.map((id) => instance.store.readMedia(id, 8000000)))
    expect(new Set(bytes.map((buffer) => buffer.toString('base64'))).size).toBe(10)
    if (index === 3) {
      expect(assets.every((asset) => asset.kind === 'video' && Math.abs(asset.duration! - 1) < .1)).toBe(true)
      expect(await sharp(await videoFirstFrame(await cloudPath(instance.store, ids[9]), new AbortController().signal)).metadata()).toMatchObject({ format: 'png' })
    }
    const state = instance.store.state('w')
    await instance.saveGraph('w', { ...state.graph, nodes: [{ ...node, selectedResultId: ids[9] }] }, state.graphRevision)
    await instance.close()
    const reopened = await service(instance.config.dataDir)
    expect(reopened.store.state('w').tasks[0].resultIds).toEqual(ids)
    expect(reopened.store.state('w').graph.nodes[0]).toMatchObject({ selectedResultId: ids[9], params: { n: 10 } })
    expect(network).not.toHaveBeenCalled()
  }, 30000)
  it('saves a zero-second draft but refuses generation without creating a task', async () => {
    const instance = await service(); const node = generator(3, 1); node.params!.seconds = 0
    const saved = await instance.saveGraph('w', { ...emptyGraph(), nodes: [node] }, 0)
    expect(saved.graph.nodes[0].params?.seconds).toBe(0)
    await expect(instance.generate('w', node.id, saved.graphRevision, randomUUID(), true)).rejects.toThrow('大于 0')
    expect(instance.store.state('w').tasks).toHaveLength(0)
  })
  it('resolves image/video prompt mentions against saved inputs and rejects a disconnected chip', async () => {
    const network = vi.fn(() => { throw new Error('Mock must not fetch') }); vi.stubGlobal('fetch', network)
    const instance = await service(); const upstream = generator(0, 1)
    const initial = await instance.saveGraph('w', { ...emptyGraph(), nodes: [upstream] }, 0)
    const output = await finished(instance, (await instance.generate('w', upstream.id, initial.graphRevision, randomUUID(), true)).id)
    const assetId = output.resultIds[0]
    for (const index of [0, 2]) {
      const target = generator(index, 1)
      target.prompt = `围绕${assetToken(assetId)}创作`
      const state = instance.store.state('w')
      const graph = { ...state.graph, nodes: [...state.graph.nodes, target], edges: [...state.graph.edges, { id: randomUUID(), source: upstream.id, target: target.id, assetId }] }
      const saved = await instance.saveGraph('w', graph, state.graphRevision)
      const task = await instance.generate('w', target.id, saved.graphRevision, randomUUID(), true)
      expect(task.snapshot.prompt).toBe('围绕[参考图1]创作')
      expect(task.snapshot.referenceIds).toEqual([assetId])
      await finished(instance, task.id)
      const current = instance.store.state('w')
      expect(current.graph.nodes.find((node) => node.id === target.id)?.prompt).toBe(target.prompt)
      const disconnected = await instance.saveGraph('w', { ...current.graph, edges: current.graph.edges.filter((edge) => edge.target !== target.id) }, current.graphRevision)
      const count = instance.store.state('w').tasks.length
      await expect(instance.generate('w', target.id, disconnected.graphRevision, randomUUID(), true)).rejects.toThrow('未连接')
      expect(instance.store.state('w').tasks).toHaveLength(count)
    }
    expect(network).not.toHaveBeenCalled()
  }, 30000)
  it('retries publishing the same staged Mock outputs without rerendering or creating credentials', async () => {
    const instance = await service(); const node = generator()
    const state = await instance.saveGraph('w', { ...emptyGraph(), nodes: [node] }, 0)
    const save = instance.store.saveMedia.bind(instance.store)
    let fail = true
    instance.store.saveMedia = async (...args) => { if (fail) { args[0].destroy(); throw new Error('simulated publication failure') }; return save(...args) }
    const task = await instance.generate('w', node.id, state.graphRevision, randomUUID(), true)
    for (let i = 0; i < 200 && instance.store.state('w').tasks[0].status !== 'save_failed'; i++) await new Promise((resolve) => setTimeout(resolve, 25))
    expect(instance.store.state('w').tasks[0].status).toBe('save_failed')
    while (instance.runtime.isActive(task.id)) await new Promise((resolve) => setTimeout(resolve, 10))
    fail = false
    await instance.taskAction('w', task.id, 'retry-save')
    const completed = await finished(instance, task.id)
    expect(completed.resultIds).toEqual([0, 1, 2, 3].map((i) => mockOutputId(task.id, i)))
    expect((await instance.store.taskDetail('w', task.id)).attempts.filter((attempt) => attempt.step === 'mock-render')).toHaveLength(1)
    expect((await instance.store.taskPrivate(task.id)).key).toBe('')
  })
})
describe('capability and group behavior', () => {
  it('every offered size, resolution and count stays inside its selected preset', () => {
    for (const model of MOCK_MODELS) {
      const choices = sizeChoices(model)
      for (const choice of choices) for (const resolution of new Set(choices.map((item) => item.resolution))) {
        const size = chooseResolution(choices, choice.size, resolution)
        expect(model.capabilities.sizes).toContain(size)
        expect(() => validateMockGeneration({ model: mockRecord(model.id), prompt: 'test', params: { ...defaultParams(model), size }, referenceIds: [] }, [])).not.toThrow()
      }
    }
    for (const model of MOCK_MODELS) {
      expect(model.capabilities.counts).toEqual(Array.from({ length: 10 }, (_, i) => i + 1))
      for (const n of model.capabilities.counts) expect(() => validateMockGeneration({ model: mockRecord(model.id), prompt: 'test', params: { ...defaultParams(model), n }, referenceIds: [] }, [])).not.toThrow()
    }
    expect(GenerationParamsSchema.safeParse({ size: '1024x1024', n: 10 }).success).toBe(true)
    for (const n of [0, 11, 1.5]) expect(GenerationParamsSchema.safeParse({ size: '1024x1024', n }).success).toBe(false)
  })
  it('selects valid range defaults and rejects unsupported discrete, range and step durations', () => {
    const fixed = MOCK_MODELS[2], ranged = MOCK_MODELS[3]
    expect(defaultParams(fixed).seconds).toBe(4)
    expect(defaultParams(ranged).seconds).toBe(1)
    for (const seconds of [0, 1, 7, 12]) expect(supportsVideoDuration(ranged.capabilities, seconds)).toBe(true)
    for (const seconds of [undefined, -1, 13, 4.5, NaN]) expect(supportsVideoDuration(ranged.capabilities, seconds)).toBe(false)
    for (const seconds of [4, 8, 12]) expect(supportsVideoDuration(fixed.capabilities, seconds)).toBe(true)
    expect(supportsVideoDuration(fixed.capabilities, 6)).toBe(false)
    const caps = { ...ranged.capabilities, secondsRange: { min: 2, max: 12, step: 2 } }
    expect(defaultParams({ ...ranged, capabilities: caps }).seconds).toBe(2)
    expect(supportsVideoDuration(caps, 5)).toBe(false); expect(supportsVideoDuration(caps, 6)).toBe(true)
  })
  it('new connections use only the main result and never mutate an existing edge', () => {
    const node = generator()
    const assets = [0, 1, 2, 3].map((i) => ({ id: mockOutputId(node.id, i), kind: 'image' as const, mime: 'image/png', filename: 'test.png', bytes: 10, createdAt: 0, nodeId: node.id, taskId: null, width: 1024, height: 1024 }))
    const edge = { id: randomUUID(), source: node.id, target: randomUUID(), assetId: assets[2].id }
    expect(connectionAsset({ ...node, selectedResultId: assets[0].id }, assets, assets, null)).toEqual(assets[0])
    expect(connectionAsset({ ...node, selectedResultId: assets[3].id }, assets, assets, null)).toEqual(assets[3])
    expect(connectionAsset(node, assets, assets, `result:${assets[2].id}`)).toBeUndefined()
    expect(generationFrame(assets[0], 4, true)).toMatchObject({ width: 650, height: 650, columns: 2 })
    expect(generationFrame(assets[0], 4, false)).toMatchObject({ width: 320, height: 320, columns: 1 })
    expect(edge.assetId).toBe(assets[2].id)
  })
})
