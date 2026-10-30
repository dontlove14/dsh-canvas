import { afterEach, expect, it, vi } from 'vitest'
import { randomUUID, createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import ffmpeg from '@ffmpeg-installer/ffmpeg'
import { Providers } from '../src/host/providers'
import { CanvasService } from '../src/host/service'
import { inspectSeedanceReference } from '../src/host/media/seedanceReferences'
import { BUILTIN_MODELS, MINIMAX_H3_MODELS, providerFor } from '../src/shared/modelCatalog'
import { capabilitiesFor, defaultParams, emptyGraph, validateGeneration, ModelInputSchema, type Asset, type TaskSnapshot } from '../src/shared/contracts'
import { videoGenerationParams } from '../src/shared/video'
import { sql } from '../src/host/persistence/database'
import { CanvasApi } from '../src/client/api'
import { initialize, fakeFactory } from './support/objectStorage'

const models = BUILTIN_MODELS.filter((model) => model.protocol === 'minimax-video')
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const options = { requestTimeoutMs: 1000, maxMediaBytes: 1000000, maxReferenceBytes: 100 }
const snapshot = (model = models[0]): TaskSnapshot => ({ model, params: defaultParams(model), prompt: '镜头缓缓推进', referenceIds: [] })
const asset = (kind: Asset['kind'] = 'image', fields: Partial<Asset> = {}): Asset => ({
  id: randomUUID(), kind, bytes: 1000, filename: 'reference', mime: { image: 'image/png', video: 'video/mp4', audio: 'audio/mpeg' }[kind],
  createdAt: 1, nodeId: null, taskId: null, ...(kind === 'audio' ? { duration: 2 } : { width: 640, height: 720, ...(kind === 'video' ? { duration: 2 } : {}) }), ...fields,
})
async function root() { const path = await mkdtemp(join(tmpdir(), 'minimax-test-')); cleanup.push(() => rm(path, { recursive: true, force: true })); return path }
async function service(path: string) {
  const instance = new CanvasService({ dataDir: path, maxConcurrentTasks: 1, pollIntervalMs: 25, ...options }, undefined, fakeFactory(path))
  await initialize(instance, true); cleanup.push(() => instance.close()); return instance
}

it.each(BUILTIN_MODELS.filter((model) => ['wan-video', 'minimax-video'].includes(model.protocol)))('links recovered uploads with native frame constraints via $api_base ($model_id)', async (model) => {
  const api = new CanvasApi(), nodeId = randomUUID(), targetId = randomUUID()
  const input = asset('video'), source = { id: nodeId, kind: 'video-asset', assetId: input.id }
  const target = { id: targetId, modelId: model.id, params: defaultParams(model) }
  const state = { graph: { ...emptyGraph(), nodes: [source, target] }, assets: [input], graphRevision: 1 }
  const request = vi.spyOn(api as any, 'request').mockImplementation(async (path: unknown) => path === 'graph' ? state
    : { models: [{ ...model, capabilities: capabilitiesFor(model) }] })
  const save = vi.spyOn(api, 'save').mockResolvedValue({} as any)
  const job = { canvas: 'w', requestId: randomUUID(), target: targetId }
  await (api as any).linkUpload(job, nodeId)
  expect(save.mock.calls[0][1].edges[0].value).toEqual({ id: job.requestId, source: nodeId, target: targetId, assetId: input.id })
  target.params = { ...defaultParams(model), videoMode: 'frames' }
  const first = asset(), second = asset()
  state.assets.push(first, second)
  state.graph.edges = [first, second].map((item) => ({ id: randomUUID(), source: randomUUID(), target: targetId, assetId: item.id }))
  save.mockClear()
  await expect((api as any).linkUpload(job, nodeId)).rejects.toMatchObject({ code: 'REFERENCE_INVALID' })
  expect(save).not.toHaveBeenCalled(); request.mockRestore()
})

it('registers standard H3 for Model Link and four variants for MiniMax with separate credentials', async () => {
  expect(models.map((model) => [model.model_id, providerFor(model)?.id])).toEqual(MINIMAX_H3_MODELS.flatMap((model) =>
    (model.id === 'MiniMax-H3' ? ['model-link', 'minimax'] : ['minimax']).map((provider) => [model.id, provider])))
  expect(models.map((model) => model.id.slice(-2))).toEqual(['23', '24', '26', '28', '2a'])
  const instance = await service(await root())
  for (const [index, model] of models.entries()) {
    expect(ModelInputSchema.safeParse(model).success).toBe(true)
    await instance.store.saveModel({ ...model, api_key: `h3-key-${index}` })
    await instance.store.saveModel(model)
    expect(instance.store.model(model.id).key).toBe(`h3-key-${index}`)
    await expect(instance.store.saveModel({ ...model, endpoint_id: 'ep-invalid' })).rejects.toThrow('Model ID')
    await expect(instance.store.saveModel({ ...model, api_base: 'https://maas.qianwenaiapi.com/api/v1' })).rejects.toMatchObject({ code: 'MODEL_NOT_SUPPORTED' })
  }
  expect(JSON.stringify(instance.store.listModels())).not.toContain('h3-key-')
  await instance.store.saveModel({ ...models[1], api_key: '' })
  expect(() => instance.store.model(models[1].id)).toThrow('配置模型')
  expect(instance.store.model(models[0].id).key).toBe('h3-key-0')
})
it('preserves retired Model Link configurations, credentials and history while rejecting new use before submission', async () => {
  const path = await root()
  const retired = MINIMAX_H3_MODELS.slice(1).map((model, index) => ({
    ...models[0], id: `00000000-0000-4000-b000-${(37 + index * 2).toString(16).padStart(12, '0')}`,
    model_id: model.id, name: model.name,
  }))
  await writeFile(join(path, 'models.json'), JSON.stringify(retired))
  await writeFile(join(path, 'credentials.json'), JSON.stringify({ models: Object.fromEntries(retired.map((model) => [model.id, 'retained-key'])) }))
  const instance = await service(path), nodeId = randomUUID()
  await instance.store.saveModel({ ...models[0], api_key: 'standard-key' })
  const node = { id: nodeId, kind: 'video-generation' as const, title: '历史 H3', position: { x: 0, y: 0 },
    modelId: models[0].id, params: defaultParams(models[0]), prompt: '旧任务', assetId: null, selectedResultId: null }
  await instance.saveGraph('w', { ...emptyGraph(), nodes: [node] }, 0)
  const fetch = vi.fn(async () => Response.json({ error: { code: 'InvalidInput', message: 'historic rejection' } }))
  vi.stubGlobal('fetch', fetch)
  const history = await instance.generate('w', nodeId, 1)
  await vi.waitFor(() => expect(instance.store.state('w').tasks[0].status).toBe('failed'))
  const historicalSnapshot = { ...history.snapshot, model: retired[1] }
  await instance.store.db.batch([sql('UPDATE task_details SET snapshot_json=? WHERE task_id=?', [JSON.stringify(historicalSnapshot), history.id])])
  const ddl = await instance.store.db.all('SELECT sql FROM sqlite_master ORDER BY name')
  const records = await readFile(join(path, 'models.json'), 'utf8'), bindings = await readFile(join(path, 'model-bindings.json'), 'utf8')
  await instance.close()
  fetch.mockClear()
  const resumed = await service(path)
  const tasks = await resumed.store.db.all('SELECT * FROM task_catalog')
  expect(resumed.store.state('w').tasks[0]).toMatchObject({ id: history.id, status: 'failed', snapshot: historicalSnapshot })
  expect(resumed.store.listModels()).toHaveLength(42)
  for (const model of retired) {
    expect(resumed.store.listModels().find((item) => item.id === model.id)).toMatchObject({ ...model, has_api_key: true, configurable: false })
    expect(() => resumed.store.model(model.id)).toThrow('仅支持 MiniMax-H3')
    await expect(resumed.store.saveModel({ ...model, api_key: 'replacement' })).rejects.toMatchObject({ code: 'MODEL_NOT_SUPPORTED' })
    await resumed.saveGraph('w', { ...emptyGraph(), nodes: [{ ...node, modelId: model.id }] }, resumed.store.state('w').graphRevision)
    await expect(resumed.generate('w', nodeId, resumed.store.state('w').graphRevision)).rejects.toMatchObject({ code: 'MODEL_NOT_SUPPORTED' })
    expect(await resumed.store.vault.read(JSON.parse(bindings)[model.id])).toBe('retained-key')
  }
  expect(fetch).not.toHaveBeenCalled()
  expect(await readFile(join(path, 'models.json'), 'utf8')).toBe(records)
  expect(await readFile(join(path, 'model-bindings.json'), 'utf8')).toBe(bindings)
  expect(await resumed.store.db.all('SELECT * FROM task_catalog')).toEqual(tasks)
  expect(await resumed.store.db.all('SELECT sql FROM sqlite_master ORDER BY name')).toEqual(ddl)
})
it.each(models)('uses the documented output tiers and durations for $model_id via $api_base', (model) => {
  const caps = capabilitiesFor(model)
  expect([...new Set(caps.sizePresets!.map((item) => item.resolution))]).toEqual(model.model_id === 'MiniMax-H3' ? ['768P', '2K']
    : model.model_id === 'MiniMax-H3-Highspeed' ? ['768P'] : ['480P', '768P'])
  expect(caps.secondsRange).toEqual({ min: model.model_id === 'MiniMax-H3-Max' ? 5 : 4, max: 15, step: 1 })
  expect(caps.supportsAudioToggle).toBe(false)
  expect(defaultParams(model)).toEqual({ size: '768P/16:9', seconds: 5, n: 1, videoMode: 'text' })
  expect(() => validateGeneration({ ...snapshot(model), params: { ...defaultParams(model), generateAudio: true } }, [])).toThrow('音频开关')
})
it('normalizes H3 mode-specific ratios and validates reference counts, dimensions, bytes and durations', () => {
  const model = models[0], lite = models.find((item) => item.model_id === 'MiniMax-H3-Lite')!, image = asset()
  const base = { ...defaultParams(model), size: '768P/adaptive' }
  expect(videoGenerationParams(base, [], model)).toMatchObject({ videoMode: 'text', size: '768P/16:9' })
  expect(videoGenerationParams({ ...base, videoMode: 'frames' }, [image.id], model)).toMatchObject({ firstFrameId: image.id, size: '768P/adaptive' })
  expect(videoGenerationParams({ ...base, videoMode: 'frames' }, [image.id], lite).size).toBe('768P/adaptive')
  expect(videoGenerationParams(base, [image.id], lite)).toMatchObject({ videoMode: 'reference', size: '768P/16:9' })
  const validate = (assets: Asset[]) => validateGeneration({ ...snapshot(), params: { ...defaultParams(model), videoMode: 'reference' }, referenceIds: assets.map((item) => item.id) }, assets)
  expect(() => validate([asset('audio')])).not.toThrow()
  for (const [kind, count] of [['image', 10], ['video', 4], ['audio', 4]] as const)
    expect(() => validate(Array.from({ length: count }, () => asset(kind)))).toThrow(`最多接受 ${count - 1}`)
  for (const input of [asset('image', { width: 255 }), asset('video', { height: 5761 }), asset('image', { width: 256, height: 1000 }),
    asset('image', { bytes: 30 * 1024 * 1024 + 1 }), asset('video', { bytes: 50 * 1024 * 1024 + 1 }), asset('audio', { bytes: 15 * 1024 * 1024 + 1 }),
    asset('video', { duration: 1.99 }), asset('audio', { duration: 15.01 })]) expect(() => validate([input])).toThrow()
  expect(() => validate([asset('video', { duration: 8 }), asset('video', { duration: 8 })])).toThrow('15秒')
  expect(() => validateGeneration({ ...snapshot(), params: base }, [])).toThrow('比例')
})
it.each(models)('submits text, mixed references and ordered frame roles via $api_base ($model_id)', async (model) => {
  const assets = [asset(), asset(), asset('video'), asset('audio')]
  const fetch = vi.fn(async () => Response.json({ task_id: 'h3-task' })); vi.stubGlobal('fetch', fetch)
  const read = vi.fn(), review = vi.fn(), inspect = vi.fn(async (_task: string, id: string) => assets.find((item) => item.id === id)!)
  const provider = new Providers({ readMedia: read, stagePath: (name) => name, inspectReference: inspect,
    modelReferenceUrl: async (_task, id) => `https://objects.invalid/${id}` }, options, new AbortController().signal, review)
  for (const mode of ['text', 'reference', 'frames'] as const) {
    const references = mode === 'text' ? [] : mode === 'frames' ? [assets[1], assets[0]] : assets.slice(1)
    const input = { ...snapshot(model), referenceIds: references.map((item) => item.id),
      params: { ...defaultParams(model), videoMode: mode, ...(mode === 'frames' ? { size: '768P/adaptive', firstFrameId: assets[0].id, lastFrameId: assets[1].id } : {}) } }
    const prepared = await provider.prepare(input, 'local-task')
    expect(await provider.submit(input, 'h3-secret', prepared)).toEqual({ id: 'h3-task', status: 'queued' })
    const [url, init] = fetch.mock.calls.at(-1)! as unknown as [string, RequestInit]
    expect(url).toBe(`${model.api_base}/v2/video_generation`)
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer h3-secret')
    expect(JSON.parse(init.body as string)).toEqual({ model: model.model_id, resolution: '768P', ratio: mode === 'frames' ? 'adaptive' : '16:9', duration: 5,
      ...(providerFor(model)?.id === 'minimax' ? { aigc_watermark: false } : {}),
      content: [{ type: 'text', text: input.prompt }, ...references.map((item) => ({
        type: `${item.kind}_url`, [`${item.kind}_url`]: { url: `https://objects.invalid/${item.id}` },
        role: mode === 'frames' ? item.id === assets[0].id ? 'first_frame' : 'last_frame' : `reference_${item.kind}`,
      }))] })
  }
  expect(read).not.toHaveBeenCalled(); expect(review).not.toHaveBeenCalled()
  expect(inspect).toHaveBeenCalledWith('local-task', assets[1].id, expect.any(AbortSignal), 'minimax-video')
})
it.each([models[0], models[1]])('queries the original task via $api_base and maps all statuses and malformed results', async (model) => {
  let body: object = {}
  const fetch = vi.fn(async () => Response.json(body)); vi.stubGlobal('fetch', fetch)
  const provider = new Providers({ readMedia: vi.fn(), stagePath: (name) => name }, options, new AbortController().signal)
  for (const [status, local] of [['queued', 'queued'], ['running', 'generating'], ['failed', 'failed'], ['cancelled', 'failed']] as const) {
    body = { task: { id: 'h3/id', status, error: { code: 'InvalidInput', message: 'provider error' } } }
    expect(await provider.poll(snapshot(model), 'secret', 'h3/id')).toMatchObject({ id: 'h3/id', status: local })
  }
  expect(fetch.mock.calls.at(-1)![0]).toBe(`${model.api_base}/v2/query/video_generation/h3%2Fid`)
  for (const task of [{}, { id: 'wrong', status: 'running' }, { id: 'h3/id', status: 'unknown' },
    { id: 'h3/id', status: 'succeeded', content: { url: 'javascript:alert(1)' } }]) {
    body = { task }; await expect(provider.poll(snapshot(model), 'secret', 'h3/id')).rejects.toMatchObject({ definitive: false })
  }
  body = { task: { id: 'h3/id', status: 'succeeded', content: { url: 'https://cdn.invalid/video.mp4' } } }
  const result = await provider.poll(snapshot(model), 'secret', 'h3/id')
  fetch.mockImplementation(async () => new Response('video'))
  const stream = await provider.outputStream(result.outputs![0], snapshot(model), 'secret'); stream.destroy()
  expect(new Headers((fetch.mock.calls.at(-1)! as unknown as [string, RequestInit])[1].headers).get('authorization')).toBeNull()
})
it('rejects references and errors before ambiguous submissions are repeated', async () => {
  const fetch = vi.fn(async () => Response.json({ error: { code: 'InvalidInput', message: 'bad input' } })); vi.stubGlobal('fetch', fetch)
  const provider = new Providers({ readMedia: vi.fn(), stagePath: (name) => name }, options, new AbortController().signal), image = asset()
  expect(await provider.submit(snapshot(), 'secret')).toMatchObject({ status: 'failed', error: 'bad input', errorCode: 'InvalidInput' })
  fetch.mockClear()
  await expect(provider.submit({ ...snapshot(), params: { ...defaultParams(models[0]), videoMode: 'reference' }, referenceIds: [image.id] }, 'secret',
    new Map([[image.id, { asset: image, url: 'asset://review-id', approvedAsset: true }]]))).rejects.toMatchObject({ definitive: true })
  expect(fetch).not.toHaveBeenCalled()
  fetch.mockImplementation(async () => Response.json({}))
  await expect(provider.submit(snapshot(), 'secret')).rejects.toMatchObject({ definitive: false })
})
it('inspects 23.976 FPS actual bytes for H3 and preserves strict Seedance validation', async () => {
  const path = await root(), file = join(path, 'video.mp4')
  await promisify(execFile)(ffmpeg.path, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=640x720:r=24000/1001',
    '-t', '2', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', file])
  const bytes = await readFile(file), input = asset('video', { bytes: bytes.length }), hash = createHash('sha256').update(bytes).digest('hex')
  const signal = new AbortController().signal
  expect(await inspectSeedanceReference(Readable.from([bytes]), input, hash, signal, 'minimax-video')).toMatchObject({ videoCodec: 'h264', frameRate: 23.98 })
  await expect(inspectSeedanceReference(Readable.from([bytes]), input, hash, signal)).rejects.toThrow('24至60')
})
it('resumes H3 by original query and credentials after restart with unchanged database schema', async () => {
  const path = await root(), instance = await service(path), nodeId = randomUUID()
  await instance.store.saveModel({ ...models[0], api_key: 'original-h3-key' })
  await instance.saveGraph('w', { ...emptyGraph(), nodes: [{ id: nodeId, kind: 'video-generation', title: 'H3', position: { x: 0, y: 0 },
    modelId: models[0].id, params: defaultParams(models[0]), prompt: '镜头推进', assetId: null, selectedResultId: null }] }, 0)
  const fetch = vi.fn(async () => Response.json({ task_id: 'h3-resume' })); vi.stubGlobal('fetch', fetch)
  const request = randomUUID(), task = await instance.generate('w', nodeId, 1, request)
  await vi.waitFor(() => { expect(instance.store.state('w').tasks[0]).toMatchObject({ status: 'queued', providerTaskId: 'h3-resume' }); expect(instance.runtime.isActive(task.id)).toBe(false) })
  expect((await instance.generate('w', nodeId, 1, request)).id).toBe(task.id)
  await instance.store.saveModel({ ...models[0], api_key: 'rotated-h3-key' })
  const ddl = await instance.store.db.all('SELECT sql FROM sqlite_master ORDER BY name')
  await instance.close()
  fetch.mockImplementation(async (_url?: string, init?: RequestInit) => {
    expect(init?.method).not.toBe('POST')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer original-h3-key')
    return Response.json({ task: { id: 'h3-resume', status: 'failed', error: { code: 'ContentRejected', message: 'review failed' } } })
  })
  const resumed = await service(path)
  await resumed.store.db.batch([sql('UPDATE task_details SET next_run_at=0 WHERE task_id=?', [task.id])]); resumed.runtime.wake()
  await vi.waitFor(() => expect(resumed.store.state('w').tasks[0]).toMatchObject({ status: 'failed', providerTaskId: 'h3-resume', error: 'review failed' }), { timeout: 6000 })
  expect(fetch.mock.calls.filter((call) => (call as unknown as [string, RequestInit])[1]?.method === 'POST')).toHaveLength(1)
  expect(await resumed.store.db.all('SELECT sql FROM sqlite_master ORDER BY name')).toEqual(ddl)
}, 10000)
