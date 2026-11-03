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
import { BUILTIN_MODELS, providerFor } from '../src/shared/modelCatalog'
import { capabilitiesFor, defaultParams, emptyGraph, GenerationParamsSchema, validateGeneration,
  type Asset, type CanvasNode, type GenerationParams, type TaskSnapshot, type TaskStatus } from '../src/shared/contracts'
import { normalizeVideoGraphReferences, videoGenerationParams, validateVideoConnections } from '../src/shared/video'
import { resolveKlingPrompt, validateKlingPrompt } from '../src/shared/kling'
import { assetToken } from '../src/shared/promptMentions'
import { sql } from '../src/host/persistence/database'
import { createCanvasNode } from '../src/client/nodeCreation'
import { copyCanvasNodes, pasteCanvasNodes, readCanvasNodes } from '../src/client/nodeClipboard'
import { initialize, fakeFactory } from './support/objectStorage'

const models = BUILTIN_MODELS.filter((model) => model.protocol === 'kling-video')
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const snapshot = (model = models[0]): TaskSnapshot => ({ model, params: defaultParams(model), prompt: '镜头平移', referenceIds: [] })
function asset(kind: Asset['kind'] = 'image', fields: Partial<Asset> = {}): Asset {
  return { id: randomUUID(), kind, mime: kind === 'image' ? 'image/png' : kind === 'video' ? 'video/mp4' : 'audio/mpeg',
    filename: 'reference', bytes: 1000, createdAt: 1, nodeId: randomUUID(), taskId: null, width: 720, height: 720,
    ...(kind === 'video' ? { duration: 3 } : {}), ...fields }
}
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'kling-test-')); cleanup.push(() => rm(root, { recursive: true, force: true })); return root
}
const options = { requestTimeoutMs: 1000, maxMediaBytes: 1000000, maxReferenceBytes: 100 }
async function service(root: string) {
  const instance = new CanvasService({ dataDir: root, maxConcurrentTasks: 1, pollIntervalMs: 25, ...options }, undefined, fakeFactory(root))
  await initialize(instance, true); cleanup.push(() => instance.close()); return instance
}
async function wait(instance: CanvasService, id: string, status: TaskStatus) {
  await vi.waitFor(() => { const task = instance.store.state('w').tasks.find((task) => task.id === id)
    expect(task?.status, task?.error).toBe(status); expect(instance.runtime.isActive(id)).toBe(false) }, { timeout: 6000, interval: 20 })
  return instance.store.state('w').tasks.find((task) => task.id === id)!
}
function result(official: boolean, status: string, fields: Record<string, unknown> = {}, id = 'original-kling', query = false) {
  const task = { ...(official ? { id } : { task_id: id }), status, ...fields }
  return { code: 0, data: official && query ? [task] : task }
}
const provider = () => new Providers({ readMedia: vi.fn(), stagePath: (name) => name }, options, new AbortController().signal)
async function videoBytes(root: string, fps = 24) {
  const path = join(root, `${randomUUID()}.mp4`)
  await promisify(execFile)(ffmpeg.path, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', `color=c=blue:s=720x720:r=${fps}`, '-t', '3', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', path])
  return readFile(path)
}

describe('Kling provider isolation and native capabilities', () => {
  it('keeps two UUIDs, independent keys and routes, and does not expose keys', async () => {
    expect(models.map((model) => [model.id, providerFor(model)?.id])).toEqual([
      ['00000000-0000-4000-b000-00000000002b', 'model-link'], ['00000000-0000-4000-b000-00000000002c', 'klingai']])
    const instance = await service(await directory())
    for (const [index, model] of models.entries()) {
      await instance.store.saveModel({ ...model, api_key: `separate-key-${index}` })
      await instance.store.saveModel(model)
      expect(instance.store.model(model.id).key).toBe(`separate-key-${index}`)
      await expect(instance.store.saveModel({ ...model, endpoint_id: 'ep-invalid' })).rejects.toThrow('Model ID')
      await expect(instance.store.saveModel({ ...model, api_base: 'https://api.klingai.com/v1' })).rejects.toMatchObject({ code: 'MODEL_NOT_SUPPORTED' })
    }
    expect(JSON.stringify(instance.store.listModels())).not.toContain('separate-key-')
    await instance.store.saveModel({ ...models[1], api_key: '' })
    expect(() => instance.store.model(models[1].id)).toThrow('配置模型')
    expect(instance.store.model(models[0].id).key).toBe('separate-key-0')
    expect(instance.store.listModels().find((model) => model.id === models[0].id)!.has_api_key).toBe(true)
  })
  it.each(models)('shares only the payload contract, with legal modes and boundaries for $api_base', (model) => {
    expect(capabilitiesFor(model)).toMatchObject({ counts: [1], secondsRange: { min: 3, max: 30, step: 1 },
      referenceKinds: ['image', 'video'], supportsAudioToggle: false, videoModes: [{ value: 'text' }, { value: 'reference' }] })
    expect(defaultParams(model)).toEqual({ size: '1080p/16:9', n: 1, seconds: 10, videoMode: 'text' })
    for (const seconds of [3, 30]) expect(() => validateGeneration({ ...snapshot(model), params: { ...defaultParams(model), seconds } }, [])).not.toThrow()
    for (const seconds of [2, 31]) expect(() => validateGeneration({ ...snapshot(model), params: { ...defaultParams(model), seconds } }, [])).toThrow('时长')
    expect(() => validateGeneration({ ...snapshot(model), params: { ...defaultParams(model), size: '1080p/adaptive' } }, [])).toThrow('比例')
    expect(() => validateGeneration({ ...snapshot(model), params: { ...defaultParams(model), generateAudio: false } }, [])).toThrow('音频开关')
  })
  it('infers Omni and text, prunes removed roles, and preserves clipboard roles and original upstream edges', () => {
    const model = { ...models[0], has_api_key: true, api_key_mask: '', capabilities: capabilitiesFor(models[0]) }, input = asset()
    const source: CanvasNode = { id: input.nodeId!, kind: 'image-asset', title: 'image', position: { x: 0, y: 0 },
      modelId: null, params: null, prompt: '', assetId: input.id, selectedResultId: null }
    const env = { assets: [input], tasks: [], models: [model], expandedGroups: {} }, graph = { ...emptyGraph(), nodes: [source] }
    const created = createCanvasNode(graph, 'video-generation', { x: 100, y: 100 }, env,
      { sourceId: source.id, assetId: input.id, handleId: null, history: false })
    const normalized = normalizeVideoGraphReferences(graph, created.graph, [model])
    const node = normalized.nodes[1]
    expect(node.params).toMatchObject({ videoMode: 'reference' })
    node.params = { ...defaultParams(model), videoMode: 'reference', size: '1080p/adaptive', klingReferenceRoles: { [input.id]: 'middle_frame' } }
    node.prompt = `使用${assetToken(input.id)}`
    const packet = readCanvasNodes(copyCanvasNodes(normalized, [source.id, node.id], 'w', 'origin'), 'w', 'origin')
    const pasted = pasteCanvasNodes(normalized, packet, { x: 400, y: 400 }, env)
    expect(pasted.graph.nodes.at(-1)).toMatchObject({ prompt: node.prompt, params: node.params, selectedResultId: null })
    expect(pasted.graph.edges.at(-1)).toMatchObject({ source: source.id, assetId: input.id, target: pasted.ids[1] })
    expect(videoGenerationParams(node.params, [], model)).toMatchObject({ size: '1080p/16:9', videoMode: 'text' })
    expect(videoGenerationParams(node.params, [], model).klingReferenceRoles).toBeUndefined()
    expect(GenerationParamsSchema.safeParse({ ...node.params, klingReferenceRoles: { [input.id]: 'voice' } }).success).toBe(false)
  })
  it('validates roles, counts, actual media dimensions, sizes and duration budget', () => {
    const validate = (assets: Asset[], fields: Partial<GenerationParams> = {}) => validateGeneration({
      ...snapshot(), params: { ...snapshot().params, videoMode: 'reference', ...fields }, referenceIds: assets.map((asset) => asset.id) }, assets)
    const image = asset(), video = asset('video')
    expect(() => validate([image, video], { klingReferenceRoles: { [image.id]: 'first_frame', [video.id]: 'base_video' } })).not.toThrow()
    for (const fields of [{ mime: 'image/webp' }, { bytes: 30 * 1024 * 1024 + 1 }, { width: 299 }, { height: 1801 }])
      expect(() => validate([asset('image', fields)])).toThrow()
    for (const fields of [{ mime: 'video/webm' }, { bytes: 300 * 1024 * 1024 + 1 }, { width: 699 }, { width: 4554 },
      { width: 3000, height: 3000 }, { duration: 2.99 }, { duration: 30.01 }])
      expect(() => validate([asset('video', fields)])).toThrow()
    for (const [kind, count] of [['image', 11], ['video', 6]] as const)
      expect(() => validate(Array.from({ length: count }, () => asset(kind)))).toThrow()
    expect(() => validate([asset('video', { duration: 16 }), asset('video', { duration: 15 })])).toThrow('总时长')
    expect(() => validate([asset('audio')])).toThrow()
    expect(() => validate([image], { klingReferenceRoles: { [image.id]: 'feature_video' } })).toThrow('用途')
    expect(() => validate([image], { klingReferenceRoles: { [randomUUID()]: 'refer_image' } })).toThrow('用途')
    const other = asset('video')
    expect(() => validate([video, other], { klingReferenceRoles: { [video.id]: 'base_video', [other.id]: 'base_video' } })).toThrow('一份')
    expect(() => validateVideoConnections({ ...snapshot().params, videoMode: 'frames' }, [image], models[0])).toThrow('Omni')
    expect(() => validateGeneration({ ...snapshot(BUILTIN_MODELS.find((model) => model.protocol === 'wan-video')!),
      params: { ...defaultParams(BUILTIN_MODELS.find((model) => model.protocol === 'wan-video')!), klingReferenceRoles: {} } }, [])).toThrow('Kling')
  })
  it('translates only bound mentions and applies the weighted text limit after translation', () => {
    const image = asset(), video = asset('video'), ids = [video.id, image.id]
    expect(resolveKlingPrompt(`用${assetToken(image.id)}参考${assetToken(video.id)}，保留[参考图2]`, ids, [image, video]))
      .toBe('用@image_2参考@video_1，保留[参考图2]')
    expect(() => validateKlingPrompt('a'.repeat(13000) + '中'.repeat(5500))).not.toThrow()
    expect(() => validateKlingPrompt('a'.repeat(13000) + '中'.repeat(5501))).toThrow('超限')
    expect(() => validateKlingPrompt('中'.repeat(11000))).not.toThrow()
    expect(() => validateKlingPrompt('中'.repeat(11001))).toThrow('超限')
    expect(() => resolveKlingPrompt(assetToken(randomUUID()), ids, [image, video])).toThrow()
  })
})

describe('Kling wire contract and restart safety', () => {
  it.each(models)('streams references and submits only text/Omni via $api_base using its own bearer', async (model) => {
    const official = providerFor(model)?.id === 'klingai', inputs = [asset(), asset(), asset(), asset(), asset('video'), asset('video')]
    const inspect = vi.fn(async (_task: string, id: string) => inputs.find((asset) => asset.id === id)!)
    const sign = vi.fn(async (_task: string, id: string) => `https://objects.invalid/${id}?ttl=86400`)
    const read = vi.fn(), review = vi.fn(), fetch = vi.fn(async () => Response.json(result(official, official ? 'submitted' : 'SUBMITTED')))
    vi.stubGlobal('fetch', fetch)
    const instance = new Providers({ readMedia: read, stagePath: (name) => name, inspectReference: inspect, modelReferenceUrl: sign },
      options, new AbortController().signal, review)
    expect(await instance.submit(snapshot(model), official ? 'official-only' : 'gateway-only')).toMatchObject({ status: 'queued' })
    const roles = ['first_frame', 'middle_frame', 'last_frame', 'refer_image', 'feature_video', 'base_video'] as const
    const input = { ...snapshot(model), prompt: `主角${assetToken(inputs[3].id)}，动作${assetToken(inputs[4].id)}`,
      referenceIds: inputs.map((asset) => asset.id), params: { ...defaultParams(model), videoMode: 'reference' as const,
        klingReferenceRoles: Object.fromEntries(inputs.map((asset, i) => [asset.id, roles[i]])) } }
    const prepared = await instance.prepare(input, 'accepted-task')
    expect(await instance.submit(input, official ? 'official-only' : 'gateway-only', prepared)).toMatchObject({ id: 'original-kling', status: 'queued' })
    const calls = fetch.mock.calls as unknown as [string, RequestInit][]
    expect(calls.map(([url]) => url)).toEqual(['text-to-video', 'omni-video'].map((path) => `${model.api_base}/${official ? '' : 'klingapi/'}${path}/kling-4.0`))
    const body = JSON.parse(calls[1][1].body as string)
    expect(body).toEqual({ contents: [{ type: 'prompt', text: '主角@image_4，动作@video_5' },
      ...inputs.map((asset, i) => ({ type: roles[i], url: `https://objects.invalid/${asset.id}?ttl=86400`, id: `${asset.kind}_${i + 1}` }))],
      settings: { duration: 10, resolution: '1080p', aspect_ratio: '16:9' }, options: { watermark_info: { enabled: false } } })
    expect(JSON.parse(calls[0][1].body as string).prompt).toBe('镜头平移')
    expect(calls.every(([, init]) => new Headers(init.headers).get('authorization') === `Bearer ${official ? 'official-only' : 'gateway-only'}`)).toBe(true)
    expect(inspect).toHaveBeenCalledTimes(6); expect(sign).toHaveBeenCalledTimes(6)
    expect(read).not.toHaveBeenCalled(); expect(review).not.toHaveBeenCalled()
    expect(inspect.mock.invocationCallOrder.at(-1)).toBeLessThan(sign.mock.invocationCallOrder[0])
  })
  it.each(models)('queries only its own task ID and maps all statuses via $api_base', async (model) => {
    const official = providerFor(model)?.id === 'klingai', fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    for (const [state, status] of official ? [['submitted', 'queued'], ['processing', 'generating'], ['succeeded', 'completed'], ['failed', 'failed']]
      : [['SUBMITTED', 'queued'], ['IN_PROGRESS', 'generating'], ['SUCCESS', 'completed'], ['FAILURE', 'failed']]) {
      fetch.mockResolvedValueOnce(Response.json(result(official, state, { outputs: [{ type: 'video', url: 'https://cdn.invalid/out.mp4' }],
        progress: '20%', message: 'reason', fail_reason: 'reason' }, 'id/with space', true)))
      const response = await provider().poll(snapshot(model), 'pinned-key', 'id/with space')
      expect(response).toMatchObject({ status, id: 'id/with space' })
      if (status === 'completed') expect(response.outputs![0]).toMatchObject({ authenticated: false, url: 'https://cdn.invalid/out.mp4' })
      if (status === 'failed') expect(response.error).toBe('reason')
      const [url, init] = fetch.mock.calls.at(-1)!
      expect(url).toBe(`${model.api_base}/${official ? 'tasks?task_ids=' : 'klingapi/tasks/'}id%2Fwith%20space`)
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer pinned-key')
    }
    for (const body of [result(official, official ? 'succeeded' : 'SUCCESS', {}, 'original-kling', true),
      result(official, 'unknown', {}, 'original-kling', true), result(official, official ? 'submitted' : 'SUBMITTED', {}, 'another-task', true),
      result(!official, official ? 'submitted' : 'SUBMITTED', {}, 'original-kling', true), { code: 1001, message: 'error' }]) {
      fetch.mockResolvedValueOnce(Response.json(body))
      await expect(provider().poll(snapshot(model), 'pinned-key', 'original-kling')).rejects.toMatchObject({ definitive: false })
    }
    fetch.mockResolvedValueOnce(Response.json({ message: 'wrong provider key' }, { status: 401 }))
    await expect(provider().poll(snapshot(model), 'pinned-key', 'original-kling')).rejects.toMatchObject({ definitive: true })
  })
  it('checks FPS from pinned bytes with Kling rules, without trusting stored metadata', async () => {
    const root = await directory(), signal = new AbortController().signal
    for (const fps of [24, 16]) {
      const bytes = await videoBytes(root, fps), input = asset('video', { bytes: bytes.length })
      const hash = createHash('sha256').update(bytes).digest('hex')
      if (fps === 24) expect(await inspectSeedanceReference(Readable.from([bytes]), input, hash, signal, 'kling-video')).toMatchObject({ frameRate: 24, duration: 3, width: 720 })
      else await expect(inspectSeedanceReference(Readable.from([bytes]), input, hash, signal, 'kling-video')).rejects.toThrow('24至60')
    }
  })
  it.each(models)('pins provider/key/references across restart and retries storage without another POST: $api_base', async (model) => {
    const official = providerFor(model)?.id === 'klingai', root = await directory(), bytes = await videoBytes(root)
    const fetch = vi.fn(async (_url: string, init: RequestInit = {}) => Response.json(result(official, official ? 'submitted' : 'SUBMITTED', {}, 'original-kling', init.method !== 'POST')))
    vi.stubGlobal('fetch', fetch)
    const instance = await service(root)
    await instance.store.saveModel({ ...model, api_key: 'original-own-key' })
    const node: CanvasNode = { id: randomUUID(), kind: 'video-generation', title: 'Kling', position: { x: 0, y: 0 },
      modelId: model.id, params: defaultParams(model), prompt: '镜头平移', assetId: null, selectedResultId: null }
    await instance.saveGraph('w', { ...emptyGraph(), nodes: [node] }, 0)
    const reference = await instance.store.saveMedia(Readable.from([bytes]), { id: randomUUID(), kind: 'video', filename: 'ref.mp4',
      nodeId: node.id, taskId: null, createdAt: 1 }, 1000000, 'video')
    const source: CanvasNode = { ...node, id: randomUUID(), kind: 'video-asset', modelId: null, params: null, assetId: reference.id }
    node.params = { ...defaultParams(model), videoMode: 'reference', klingReferenceRoles: { [reference.id]: 'base_video' } }
    node.prompt = `编辑${assetToken(reference.id)}`
    await instance.store.update('w', (state) => { state.assets.push(reference) })
    await instance.saveGraph('w', { ...emptyGraph(), nodes: [node, source], edges: [{ id: randomUUID(), source: source.id, target: node.id, assetId: reference.id }] },
      instance.store.state('w').graphRevision)
    const revision = instance.store.state('w').graphRevision, requestId = randomUUID()
    const accepted = await instance.generate('w', node.id, revision, requestId), waiting = await wait(instance, accepted.id, 'queued')
    expect(waiting.snapshot.prompt).toBe('编辑@video_1')
    expect(waiting.snapshot.params).toEqual(node.params)
    expect((await instance.store.db.get('SELECT next_run_at FROM task_details WHERE task_id=?', [accepted.id])).next_run_at - Date.now()).toBeGreaterThan(4500)
    await instance.store.saveModel({ ...model, api_key: 'rotated-own-key' })
    await instance.store.saveModel({ ...models.find((other) => other.id !== model.id)!, api_key: 'other-provider-key' })
    expect((await instance.generate('w', node.id, revision, requestId)).id).toBe(accepted.id)
    const ddl = await instance.store.db.all('SELECT sql FROM sqlite_master ORDER BY name')
    await instance.close()
    let downloads = 0
    fetch.mockImplementation(async (url: string, init: RequestInit = {}) => {
      expect(init.method).not.toBe('POST')
      if (String(url) === 'https://cdn.invalid/output.mp4') {
        expect(new Headers(init.headers).get('authorization')).toBeNull()
        return ++downloads === 1 ? new Response('retry download', { status: 503 }) : new Response(new Uint8Array(bytes))
      }
      expect(url).toBe(`${model.api_base}/${official ? 'tasks?task_ids=original-kling' : 'klingapi/tasks/original-kling'}`)
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer original-own-key')
      return Response.json(result(official, official ? 'succeeded' : 'SUCCESS', { outputs: [{ type: 'video', url: 'https://cdn.invalid/output.mp4' }] }, 'original-kling', true))
    })
    const resumed = await service(root)
    await resumed.store.db.batch([sql('UPDATE task_details SET next_run_at=0 WHERE task_id=?', [accepted.id])]); resumed.runtime.wake()
    await wait(resumed, accepted.id, 'save_failed')
    await resumed.taskAction('w', accepted.id, 'retry-save')
    const completed = await wait(resumed, accepted.id, 'completed')
    expect(completed.providerTaskId).toBe('original-kling'); expect(completed.snapshot.model).toEqual(model)
    expect(fetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1)
    expect(await resumed.store.readMedia(completed.resultIds[0], 1000000)).toEqual(bytes)
    expect(await resumed.store.db.all('SELECT sql FROM sqlite_master ORDER BY name')).toEqual(ddl)
  }, 15000)
  it('never automatically resubmits an ambiguous acceptance or unsupported reference', async () => {
    const fetch = vi.fn(async () => Response.json({ code: 0, data: {} })); vi.stubGlobal('fetch', fetch)
    const instance = await service(await directory())
    await instance.store.saveModel({ ...models[0], api_key: 'own-key' })
    const node: CanvasNode = { id: randomUUID(), kind: 'video-generation', title: 'Kling', position: { x: 0, y: 0 },
      modelId: models[0].id, params: defaultParams(models[0]), prompt: '镜头平移', assetId: null, selectedResultId: null }
    await instance.saveGraph('w', { ...emptyGraph(), nodes: [node] }, 0)
    const task = await instance.generate('w', node.id, 1); await wait(instance, task.id, 'failed'); instance.runtime.wake()
    expect(fetch).toHaveBeenCalledTimes(1)
    fetch.mockClear()
    const image = asset('image', { mime: 'image/webp' })
    await expect(provider().submit({ ...snapshot(), referenceIds: [image.id], params: { ...defaultParams(models[0]), videoMode: 'reference' } },
      'own-key', new Map([[image.id, { asset: image, url: 'https://objects.invalid/ref.webp' }]]))).rejects.toMatchObject({ definitive: true })
    expect(fetch).not.toHaveBeenCalled()
  })
})
