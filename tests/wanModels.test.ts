import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import ffmpeg from '@ffmpeg-installer/ffmpeg'
import { Providers } from '../src/host/providers'
import { CanvasService } from '../src/host/service'
import { inspectSeedanceReference } from '../src/host/media/seedanceReferences'
import { BUILTIN_MODELS, WAN_MODELS, providerFor } from '../src/shared/modelCatalog'
import { capabilitiesFor, defaultParams, emptyGraph, ModelInputSchema, validateGeneration,
  type Asset, type CanvasNode, type TaskSnapshot, type TaskStatus } from '../src/shared/contracts'
import { normalizeVideoGraphReferences, videoGenerationParams, validateVideoConnections } from '../src/shared/video'
import { sql } from '../src/host/persistence/database'
import { createCanvasNode } from '../src/client/nodeCreation'
import { initialize, fakeFactory } from './support/objectStorage'

const models = BUILTIN_MODELS.filter((model) => model.protocol === 'wan-video')
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const snapshot = (index = 0): TaskSnapshot => ({ model: models[index], params: defaultParams(models[index]), prompt: '生成一段视频', referenceIds: [] })
function asset(kind: Asset['kind'] = 'image', fields: Partial<Asset> = {}): Asset {
  return { id: randomUUID(), kind, mime: { image: 'image/png', video: 'video/mp4', audio: 'audio/mpeg' }[kind],
    filename: 'reference', bytes: 1000, createdAt: 1, nodeId: null, taskId: null,
    ...(kind === 'image' ? { width: 600, height: 400 } : kind === 'video' ? { width: 640, height: 720, duration: 2 } : { duration: 2 }), ...fields }
}
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'wan-test-'))
  cleanup.push(() => rm(root, { recursive: true, force: true })); return root
}
async function service(root: string) {
  const instance = new CanvasService({ dataDir: root, maxConcurrentTasks: 1, pollIntervalMs: 25,
    requestTimeoutMs: 1000, maxMediaBytes: 1000000, maxReferenceBytes: 100 }, undefined, fakeFactory(root))
  await initialize(instance, true); cleanup.push(() => instance.close()); return instance
}
async function generator(instance: CanvasService) {
  await instance.store.saveModel({ ...models[0], api_key: 'original-wan-key' })
  const node: CanvasNode = { id: randomUUID(), kind: 'video-generation', title: 'Wan', position: { x: 0, y: 0 },
    modelId: models[0].id, params: defaultParams(models[0]), prompt: '镜头缓慢推进', assetId: null, selectedResultId: null }
  await instance.saveGraph('w', { ...emptyGraph(), nodes: [node] }, 0); return node
}
async function wait(instance: CanvasService, id: string, status: TaskStatus) {
  await vi.waitFor(() => {
    const task = instance.store.state('w').tasks.find((task) => task.id === id)
    expect(task?.status, task?.error ?? '').toBe(status)
    expect(instance.runtime.isActive(id)).toBe(false)
  }, { timeout: 6000, interval: 20 })
  return instance.store.state('w').tasks.find((task) => task.id === id)!
}
async function videoBytes(root: string, fps = 24) {
  const path = join(root, `${randomUUID()}.mp4`)
  await promisify(execFile)(ffmpeg.path, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', `color=c=blue:s=640x720:r=${fps}`, '-t', '2', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', path])
  return readFile(path)
}
const options = { requestTimeoutMs: 1000, maxMediaBytes: 1000000, maxReferenceBytes: 100 }

describe('Wan catalog, modes and input boundaries', () => {
  it('adds Wan through Model Link and Aliyun, preserving all thirty previous identities', async () => {
    expect(models.map((model) => [model.model_id, model.name, providerFor(model)?.id])).toEqual(WAN_MODELS.flatMap((model) =>
      ['model-link', 'aliyun'].map((provider) => [model.id, model.name, provider])))
    expect(BUILTIN_MODELS.slice(0, 30).map((model) => model.id)).toEqual(Array.from({ length: 30 }, (_, i) => `00000000-0000-4000-b000-${(i + 1).toString(16).padStart(12, '0')}`))
    expect(new Set(BUILTIN_MODELS.map((model) => model.id)).size).toBe(39)
    const instance = await service(await directory())
    for (const [index, model] of models.entries()) {
      expect(ModelInputSchema.safeParse(model).success).toBe(true)
      await instance.store.saveModel({ ...model, api_key: `wan-key-${index}` })
      await instance.store.saveModel(model)
      expect(instance.store.model(model.id).key).toBe(`wan-key-${index}`)
      await expect(instance.store.saveModel({ ...model, endpoint_id: 'ep-invalid' })).rejects.toThrow('Model ID')
      await expect(instance.store.saveModel({ ...model, api_base: 'https://unsupported.invalid/api/v1' })).rejects.toMatchObject({ code: 'MODEL_NOT_SUPPORTED' })
    }
    expect(JSON.stringify(instance.store.listModels())).not.toContain('wan-key-')
    await instance.store.saveModel({ ...models[1], api_key: '' })
    expect(() => instance.store.model(models[1].id)).toThrow('配置模型')
    expect(instance.store.model(models[0].id).key).toBe('wan-key-0')
  })
  it.each(models)('exposes the native resolutions, durations and one output for $name', (model) => {
    const caps = capabilitiesFor(model)
    expect([...new Set(caps.sizePresets!.map((preset) => preset.resolution))]).toEqual(['480P', '720P', '1080P'])
    expect(caps.sizes).toHaveLength(21)
    expect(caps.secondsRange).toEqual({ min: 2, max: 30, step: 1 })
    expect(defaultParams(model)).toEqual({ size: '720P/16:9', n: 1, seconds: 5, videoMode: 'text', generateAudio: true })
    for (const seconds of [1, 31, -1]) expect(() => validateGeneration({ ...snapshot(), model, params: { ...defaultParams(model), seconds } }, [])).toThrow('时长')
  })
  it('infers reference/text, assigns frames, and commits mode with a new reference without changing positions', () => {
    const model = { ...models[0], has_api_key: true, api_key_mask: '', capabilities: capabilitiesFor(models[0]) }, input = asset('audio')
    const source: CanvasNode = { id: randomUUID(), kind: 'audio-asset', title: 'audio', position: { x: 0, y: 0 },
      modelId: null, params: null, prompt: '', assetId: input.id, selectedResultId: null }
    const graph = { ...emptyGraph(), nodes: [source] }, env = { assets: [input], tasks: [], models: [model], expandedGroups: {} }
    const created = createCanvasNode(graph, 'video-generation', { x: 120, y: 160 }, env,
      { sourceId: source.id, assetId: input.id, handleId: null, history: false })
    const normalized = normalizeVideoGraphReferences(graph, created.graph, [model])
    expect(normalized.nodes[1]).toMatchObject({ position: { x: 120, y: 160 }, params: { videoMode: 'reference' } })
    expect(normalized.edges[0].assetId).toBe(input.id)
    expect(normalizeVideoGraphReferences(normalized, { ...normalized, nodes: [...normalized.nodes] }, [model]).nodes[1]).toBe(normalized.nodes[1])
    const removed = normalizeVideoGraphReferences(normalized, { ...normalized, edges: [] }, [model])
    expect(removed.nodes[1].params).toMatchObject({ videoMode: 'text' })
    const ids = [randomUUID(), randomUUID()]
    expect(videoGenerationParams({ ...snapshot().params, videoMode: 'frames' }, ids, model)).toMatchObject({ firstFrameId: ids[0], lastFrameId: ids[1] })
  })
  it('allows mixed or audio-only reference input but rejects exclusive modes, per-kind counts, bytes and duration budgets', () => {
    const input = snapshot(), image = asset(), audio = asset('audio'), video = asset('video'), tail = asset()
    const validate = (assets: Asset[], params = { ...input.params, videoMode: 'reference' as const }) =>
      validateGeneration({ ...input, params, referenceIds: assets.map((asset) => asset.id) }, assets)
    expect(() => validate([image, audio, video])).not.toThrow()
    expect(() => validate([audio])).not.toThrow()
    const frames = { ...input.params, videoMode: 'frames' as const, firstFrameId: image.id, lastFrameId: tail.id }
    expect(() => validate([tail, image], frames)).not.toThrow()
    expect(() => validateVideoConnections(frames, [image, video], input.model)).toThrow('首尾帧')
    for (const [kind, count] of [['image', 11], ['video', 6], ['audio', 6]] as const)
      expect(() => validate(Array.from({ length: count }, () => asset(kind)))).toThrow(`最多接受 ${count - 1}`)
    for (const item of [asset('image', { bytes: 20 * 1024 * 1024 + 1 }), asset('video', { bytes: 100 * 1024 * 1024 + 1 }),
      asset('audio', { bytes: 15 * 1024 * 1024 + 1 }), asset('video', { mime: 'video/webm' }), asset('audio', { mime: 'audio/ogg' })])
      expect(() => validate([item])).toThrow()
    expect(() => validate([asset('video', { duration: 8 }), asset('video', { duration: 8 })])).toThrow('15秒')
    expect(() => validate([video], { ...input.params, videoMode: 'reference', seconds: 29 })).toThrow('30秒')
    expect(() => validate([image, image])).toThrow('重复')
    expect(() => validate([image], { ...input.params, videoMode: 'frames', firstFrameId: tail.id })).toThrow('首帧')
    expect(() => validateGeneration({ ...input, prompt: 'x'.repeat(20001) }, [])).toThrow('20000')
  })
})

describe('Wan native wire protocol and durable runtime', () => {
  it.each(models)('submits text, mixed reference and reversed frame order through $model_id', async (model) => {
    const references = [asset(), asset(), asset('video'), asset('audio')], byId = new Map(references.map((asset) => [asset.id, asset]))
    const inspect = vi.fn(async (_task: string, id: string) => byId.get(id)!), sign = vi.fn(async (_task: string, id: string) => `https://objects.invalid/${id}?ttl=86400`)
    const read = vi.fn(), review = vi.fn(), fetch = vi.fn(async () => Response.json({ output: { task_id: 'wan-task', task_status: 'PENDING' } }))
    vi.stubGlobal('fetch', fetch)
    const provider = new Providers({ readMedia: read, stagePath: (name) => name, inspectReference: inspect, modelReferenceUrl: sign }, options, new AbortController().signal, review)
    for (const mode of ['text', 'reference', 'frames'] as const) {
      const assets = mode === 'text' ? [] : mode === 'frames' ? [references[1], references[0]] : references.slice(1)
      const input: TaskSnapshot = { ...snapshot(), model, params: { ...defaultParams(model), videoMode: mode, generateAudio: false,
        ...(mode === 'frames' ? { firstFrameId: references[0].id, lastFrameId: references[1].id } : {}) }, referenceIds: assets.map((asset) => asset.id) }
      const prepared = await provider.prepare(input, 'local-task')
      expect(await provider.submit(input, 'private-wan-key', prepared)).toEqual({ id: 'wan-task', status: 'queued' })
      const [url, init] = fetch.mock.calls.at(-1)! as unknown as [string, RequestInit]
      expect(url).toBe(`${model.api_base}/services/aigc/video-generation/video-synthesis`)
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer private-wan-key')
      expect(new Headers(init.headers).get('X-DashScope-Async')).toBe('enable')
      const body = JSON.parse(init.body as string)
      expect(body.model).toBe(model.model_id)
      expect(body.parameters).toEqual({ resolution: '720P', ratio: '16:9', duration: 5, audio: false, prompt_extend: true, watermark: false })
      if (mode === 'text') expect(body.input).toEqual({ prompt: input.prompt })
      else expect(body.input.media).toEqual(assets.map((asset) => ({
        type: mode === 'frames' ? asset.id === references[0].id ? 'first_frame' : 'last_frame' : `reference_${asset.kind}`,
        url: `https://objects.invalid/${asset.id}?ttl=86400`,
      })))
    }
    expect(read).not.toHaveBeenCalled(); expect(review).not.toHaveBeenCalled()
    expect(inspect.mock.invocationCallOrder[0]).toBeLessThan(sign.mock.invocationCallOrder[0])
  })
  it('maps query states, checks original identity and never forwards credentials to the result CDN', async () => {
    let body: object = {}, fetch = vi.fn(async () => Response.json(body))
    vi.stubGlobal('fetch', fetch)
    const provider = new Providers({ readMedia: vi.fn(), stagePath: (name) => name }, options, new AbortController().signal)
    for (const [remote, local] of [['PENDING', 'queued'], ['RUNNING', 'generating'], ['FAILED', 'failed'], ['CANCELED', 'failed'], ['UNKNOWN', 'failed']] as const) {
      body = { output: { task_id: 'wan/id', task_status: remote, code: 'InvalidInput', message: 'provider error' } }
      expect(await provider.poll(snapshot(), 'secret', 'wan/id')).toMatchObject({ id: 'wan/id', status: local })
    }
    expect(fetch.mock.calls.at(-1)![0]).toBe('https://api.modellink.online/wan/api/v1/tasks/wan%2Fid')
    for (const output of [{}, { task_id: 'wrong', task_status: 'RUNNING' }, { task_id: 'wan/id', task_status: 'OTHER' },
      { task_id: 'wan/id', task_status: 'SUCCEEDED', video_url: 'javascript:alert(1)' }]) {
      body = { output }; await expect(provider.poll(snapshot(), 'secret', 'wan/id')).rejects.toMatchObject({ definitive: false })
    }
    body = { output: { task_id: 'wan/id', task_status: 'SUCCEEDED', video_url: 'https://cdn.invalid/output.mp4' } }
    const result = await provider.poll(snapshot(), 'secret', 'wan/id')
    fetch.mockImplementation(async () => new Response('video'))
    const stream = await provider.outputStream(result.outputs![0], snapshot(), 'secret'); stream.destroy()
    expect(new Headers((fetch.mock.calls.at(-1)! as unknown as [string, RequestInit])[1].headers).get('authorization')).toBeNull()
  })
  it('rejects invalid references before POST and surfaces both body and HTTP provider errors', async () => {
    const image = asset(), fetch = vi.fn(async () => Response.json({ code: 'InvalidParameter', message: 'bad media' }))
    vi.stubGlobal('fetch', fetch)
    const provider = new Providers({ readMedia: vi.fn(), stagePath: (name) => name }, options, new AbortController().signal)
    expect(await provider.submit(snapshot(), 'secret')).toMatchObject({ status: 'failed', errorCode: 'InvalidParameter', error: 'bad media' })
    fetch.mockClear()
    await expect(provider.submit({ ...snapshot(), params: { ...snapshot().params, videoMode: 'reference' }, referenceIds: [image.id] }, 'secret',
      new Map([[image.id, { asset: image, url: 'https://user:password@objects.invalid/image' }]]))).rejects.toMatchObject({ definitive: true })
    expect(fetch).not.toHaveBeenCalled()
    fetch.mockImplementation(async () => Response.json({ code: 'InvalidApiKey', message: 'invalid key' }, { status: 401 }))
    await expect(provider.submit(snapshot(), 'secret')).rejects.toMatchObject({ definitive: true, message: 'invalid key' })
  })
  it('uses Wan FPS limits on actual pinned bytes while preserving Seedance limits and identity checks', async () => {
    const root = await directory(), bytes = await videoBytes(root, 16), input = asset('video', { bytes: bytes.length })
    const hash = createHash('sha256').update(bytes).digest('hex'), signal = new AbortController().signal
    expect(await inspectSeedanceReference(Readable.from([bytes]), input, hash, signal, 'wan-video')).toMatchObject({ frameRate: 16, videoCodec: 'h264' })
    await expect(inspectSeedanceReference(Readable.from([bytes]), input, hash, signal)).rejects.toThrow('24至60')
    await expect(inspectSeedanceReference(Readable.from([bytes]), input, 'a'.repeat(64), signal, 'wan-video')).rejects.toMatchObject({ code: 'MEDIA_CHANGED' })
  })
  it('deduplicates acceptance, pins streamed references and old credentials, and only queries after restart', async () => {
    const root = await directory(), bytes = await videoBytes(root)
    const fetch = vi.fn(async (_url: string, init: RequestInit = {}) => init.method === 'POST'
      ? Response.json({ output: { task_id: 'wan-resume', task_status: 'PENDING' } }) : Response.json({ output: { task_id: 'wan-resume', task_status: 'RUNNING' } }))
    vi.stubGlobal('fetch', fetch)
    const instance = await service(root), node = await generator(instance)
    const reference = await instance.store.saveMedia(Readable.from([bytes]), { id: randomUUID(), kind: 'video', filename: 'ref.mp4', nodeId: node.id, taskId: null, createdAt: 1 }, 1000000, 'video')
    await instance.store.update('w', (state) => { state.assets.push(reference) })
    const state = instance.store.state('w'), source: CanvasNode = { ...node, id: randomUUID(), kind: 'video-asset', modelId: null, params: null, assetId: reference.id }
    await instance.saveGraph('w', { ...state.graph, nodes: [...state.graph.nodes, source],
      edges: [{ id: randomUUID(), source: source.id, target: node.id, assetId: reference.id }] }, state.graphRevision)
    const revision = instance.store.state('w').graphRevision, requestId = randomUUID()
    const accepted = await instance.generate('w', node.id, revision, requestId)
    const waiting = await wait(instance, accepted.id, 'queued')
    expect(waiting.snapshot.params).toMatchObject({ videoMode: 'reference' })
    expect(waiting.snapshot.referenceIds).toEqual([reference.id])
    expect((await instance.store.db.get('SELECT next_run_at FROM task_details WHERE task_id=?', [accepted.id])).next_run_at - Date.now()).toBeGreaterThan(2700)
    expect(await instance.store.db.all('SELECT asset_id FROM task_references WHERE task_id=?', [accepted.id])).toEqual([{ asset_id: reference.id }])
    expect(JSON.parse(fetch.mock.calls[0][1].body as string).input.media[0].url).toContain('expires=86400')
    await instance.store.saveModel({ ...models[0], api_key: 'rotated-key' })
    expect((await instance.generate('w', node.id, revision, requestId)).id).toBe(accepted.id)
    const ddl = await instance.store.db.all('SELECT sql FROM sqlite_master ORDER BY name')
    await instance.close()
    let downloads = 0
    fetch.mockImplementation(async (url: string, init: RequestInit = {}) => {
      expect(init.method).not.toBe('POST')
      if (String(url) === 'https://cdn.invalid/output.mp4') {
        expect(new Headers(init.headers).get('authorization')).toBeNull()
        if (++downloads === 1) return new Response('retry storage download', { status: 503 })
        return new Response(new Uint8Array(bytes))
      }
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer original-wan-key')
      return Response.json({ output: { task_id: 'wan-resume', task_status: 'SUCCEEDED', video_url: 'https://cdn.invalid/output.mp4' } })
    })
    const resumed = await service(root)
    await resumed.store.db.batch([sql('UPDATE task_details SET next_run_at=0 WHERE task_id=?', [accepted.id])]); resumed.runtime.wake()
    await wait(resumed, accepted.id, 'save_failed')
    await resumed.taskAction('w', accepted.id, 'retry-save')
    const completed = await wait(resumed, accepted.id, 'completed')
    expect(completed.providerTaskId).toBe('wan-resume'); expect(completed.snapshot.model).toEqual(models[0])
    expect(fetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1)
    expect(await resumed.store.readMedia(completed.resultIds[0], 1000000)).toEqual(bytes)
    expect(await resumed.store.db.all('SELECT sql FROM sqlite_master ORDER BY name')).toEqual(ddl)
  }, 15000)
  it('does not resubmit when POST returns no usable task identity', async () => {
    const fetch = vi.fn(async () => Response.json({ output: {} })); vi.stubGlobal('fetch', fetch)
    const instance = await service(await directory()), node = await generator(instance)
    const task = await instance.generate('w', node.id, 1)
    await wait(instance, task.id, 'failed')
    instance.runtime.wake()
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
