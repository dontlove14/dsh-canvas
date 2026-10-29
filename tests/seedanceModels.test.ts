import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID, createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import sharp from 'sharp'
import ffmpeg from '@ffmpeg-installer/ffmpeg'
import { Providers } from '../src/host/providers'
import { CanvasService } from '../src/host/service'
import { inspectSeedanceReference } from '../src/host/media/seedanceReferences'
import { BUILTIN_MODELS, SEEDANCE_MODELS, providerFor, seedanceRequiresEndpoint } from '../src/shared/modelCatalog'
import { capabilitiesFor, defaultParams, emptyGraph, ModelInputSchema, validateGeneration,
  type Asset, type CanvasNode, type TaskSnapshot, type TaskStatus } from '../src/shared/contracts'
import { normalizeSeedanceGraphReferences, seedanceGenerationParams, seedanceFrameParams, validateSeedanceConnections } from '../src/shared/seedance'
import { sql } from '../src/host/persistence/database'
import { initialize, fakeFactory } from './support/objectStorage'

const models = BUILTIN_MODELS.filter((model) => model.protocol === 'seedance-video')
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'seedance-test-'))
  cleanup.push(() => rm(root, { recursive: true, force: true })); return root
}
function snapshot(index = 0): TaskSnapshot {
  const model = models[index]
  return { model: { ...model, ...(seedanceRequiresEndpoint(model) ? { endpoint_id: `ep-channel-${index}` } : {}) },
    params: defaultParams(model), prompt: '生成一段新视频', referenceIds: [] }
}
function asset(kind: Asset['kind'] = 'image', changes: Partial<Asset> = {}): Asset {
  return { id: randomUUID(), kind, mime: { image: 'image/png', audio: 'audio/mpeg', video: 'video/mp4' }[kind],
    filename: 'reference', bytes: 1000, nodeId: null, taskId: null, createdAt: 1,
    ...(kind === 'image' ? { width: 600, height: 600 } : kind === 'video' ? { width: 640, height: 720, duration: 2 } : { duration: 2 }),
    ...changes }
}
async function service(root?: string) {
  root ??= await directory()
  const instance = new CanvasService({ dataDir: root, maxConcurrentTasks: 1, pollIntervalMs: 25, requestTimeoutMs: 1000,
    maxMediaBytes: 1000000, maxReferenceBytes: 20000 }, undefined, fakeFactory(root))
  await initialize(instance, true); cleanup.push(() => instance.close()); return instance
}
async function node(instance: CanvasService, index = 1) {
  const input = snapshot(index)
  await instance.store.saveModel({ ...input.model, api_key: `key-${index}` })
  const node: CanvasNode = { id: randomUUID(), kind: 'video-generation', title: input.model.name, position: { x: 0, y: 0 },
    modelId: input.model.id, params: input.params, prompt: input.prompt, assetId: null, selectedResultId: null }
  await instance.saveGraph('w', { ...emptyGraph(), nodes: [node] }, 0); return node
}
async function wait(instance: CanvasService, id: string, status: TaskStatus) {
  for (let i = 0; i < 800; i++) {
    const task = instance.store.state('w').tasks.find((task) => task.id === id)!
    if (task.status === status && !instance.runtime.isActive(id)) return task
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  const current = instance.store.state('w').tasks.find((task) => task.id === id)!
  throw new Error(`Expected ${status}, got ${current.status}: ${current.error}`)
}
async function videoBytes(root: string, duration = 2) {
  const path = join(root, `${randomUUID()}.mp4`)
  await promisify(execFile)(ffmpeg.path, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'color=c=blue:s=640x720:r=24', '-t', String(duration), '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', path])
  return readFile(path)
}

describe('Seedance identity, compatibility and configuration', () => {
  it('adds exactly twelve combinations with independent UUIDs and preserves the preceding eighteen identities', () => {
    expect(models).toHaveLength(12)
    expect(models.map((model) => [model.model_id, model.name, providerFor(model)?.id])).toEqual(SEEDANCE_MODELS.flatMap((model, index) =>
      (index < 4 ? ['model-link', 'bytedance'] : ['byteplus']).map((provider) => [model.id, model.name, provider])))
    expect(BUILTIN_MODELS.slice(0, 18).map((model) => model.id)).toEqual(Array.from({ length: 18 }, (_, i) =>
      `00000000-0000-4000-b000-${(i + 1).toString(16).padStart(12, '0')}`))
    expect(new Set(BUILTIN_MODELS.map((model) => model.id)).size).toBe(30)
  })
  it.each(SEEDANCE_MODELS)('exposes supported duration, resolution, modes and defaults for $name', (model) => {
    const definition = models.find((item) => item.model_id === model.id)!, caps = capabilitiesFor(definition)
    const lite = model.id.includes('-mini-') || model.id.includes('-fast-'), newer = model.id.includes('-2-5-')
    expect([...new Set(caps.sizePresets!.map((preset) => preset.resolution))]).toEqual(lite ? ['480p', '720p'] : newer ? ['480p', '720p', '1080p'] : ['480p', '720p', '1080p', '4k'])
    expect(caps.secondsRange).toEqual({ min: 4, max: newer ? 30 : 15, step: 1 })
    expect(defaultParams(definition)).toEqual({ size: '720p/16:9', n: 1, seconds: 5, videoMode: 'text', generateAudio: true })
    expect(caps.videoModes?.map((mode) => mode.value)).toEqual(['text', 'reference', 'frames'])
    expect(ModelInputSchema.safeParse(definition).success).toBe(true)
    for (const params of [{ ...defaultParams(definition), seconds: 3 }, { ...defaultParams(definition), seconds: newer ? 31 : 16 },
      { ...defaultParams(definition), n: 2 }, { ...defaultParams(definition), quality: 'high' as const }])
      expect(() => validateGeneration({ model: definition, params, prompt: 'x', referenceIds: [] }, [])).toThrow()
  })
  it('requires official EP before writing secrets, isolates twelve credentials, and forbids crossed NSFW providers', async () => {
    const instance = await service(), put = vi.spyOn(instance.store.vault, 'put')
    await expect(instance.store.saveModel({ ...models[1], api_key: 'invalid' })).rejects.toMatchObject({ code: 'MODEL_NOT_CONFIGURED' })
    expect(put).not.toHaveBeenCalled()
    for (let i = 0; i < models.length; i++) await instance.store.saveModel({ ...snapshot(i).model, api_key: `key-${i}` })
    await expect(instance.store.saveModel({ ...models[0], endpoint_id: 'ep-invalid' })).rejects.toThrow('Model ID')
    await expect(instance.store.saveModel({ ...models[0], api_base: models[8].api_base })).rejects.toMatchObject({ code: 'MODEL_NOT_SUPPORTED' })
    await expect(instance.store.saveModel({ ...models[8], api_base: models[1].api_base })).rejects.toMatchObject({ code: 'MODEL_NOT_SUPPORTED' })
    await instance.store.saveModel({ ...models[1] })
    expect(instance.store.model(models[1].id).model.endpoint_id).toBe('ep-channel-1')
    await instance.store.saveModel({ ...models[1], api_key: '' })
    expect(() => instance.store.model(models[1].id)).toThrow('配置模型')
    for (let i = 0; i < models.length; i++) if (i !== 1) expect(instance.store.model(models[i].id).key).toBe(`key-${i}`)
    expect(JSON.stringify(instance.store.listModels())).not.toMatch(/key-\d/)
  })
})

describe('Seedance exclusive modes and media limits', () => {
  it('infers modes only from current references and manual frames, without altering unrelated nodes during graph edits', () => {
    const id = randomUUID(), reference = randomUUID(), params = defaultParams(models[0])
    const generation: CanvasNode = { id, kind: 'video-generation', title: 'Video', position: { x: 0, y: 0 }, modelId: models[0].id,
      params, prompt: 'x', assetId: null, selectedResultId: null }
    const other = { ...generation, id: randomUUID() }
    const graph = { ...emptyGraph(), nodes: [generation, other] }
    const connected = normalizeSeedanceGraphReferences(graph, { ...graph, edges: [{ id: randomUUID(), source: other.id, target: id, assetId: reference }] }, models)
    expect(connected.nodes[0].params).toMatchObject({ videoMode: 'reference' })
    expect(connected.nodes[1]).toBe(other)
    const frames = { ...connected, nodes: connected.nodes.map((node) => node.id === id ? { ...node, params: { ...params, videoMode: 'frames' as const, firstFrameId: reference } } : node) }
    const cleared = normalizeSeedanceGraphReferences(frames, { ...frames, edges: [] }, models)
    expect(cleared.nodes[0].params).toEqual(params)
    const reconnected = normalizeSeedanceGraphReferences(cleared, { ...cleared, edges: connected.edges }, models)
    expect(reconnected.nodes[0].params).toMatchObject({ videoMode: 'reference' })
    const moved = { ...frames, nodes: frames.nodes.map((node) => node.id === id ? { ...node, position: { x: 10, y: 20 } } : node) }
    expect(normalizeSeedanceGraphReferences(frames, moved, models)).toBe(moved)
    expect(seedanceGenerationParams({ ...params, videoMode: 'frames', firstFrameId: reference }, [])).toEqual(params)
  })
  it('defaults first/last frames in connection order and retains explicit swaps as references change', () => {
    const [first, last, next] = [randomUUID(), randomUUID(), randomUUID()]
    const params = { ...snapshot().params, videoMode: 'frames' as const }
    expect(seedanceFrameParams(params, [])).toEqual(params)
    expect(seedanceFrameParams(params, [first])).toEqual({ ...params, firstFrameId: first })
    expect(seedanceFrameParams(params, [first, last])).toEqual({ ...params, firstFrameId: first, lastFrameId: last })
    const swapped = { ...params, firstFrameId: last, lastFrameId: first }
    expect(seedanceFrameParams(swapped, [first, last])).toBe(swapped)
    expect(seedanceFrameParams(swapped, [first])).toEqual({ ...params, firstFrameId: first })
    expect(seedanceFrameParams(swapped, [last, next])).toEqual({ ...params, firstFrameId: last, lastFrameId: next })
  })
  it('allows mixed references, audio-only only on 2.5, and explicit first/last assignments in either connection order', () => {
    const image = asset(), tail = asset(), video = asset('video'), audio = asset('audio'), input = snapshot()
    const mixed = [audio, image, video]
    expect(() => validateGeneration({ ...input, params: { ...input.params, videoMode: 'reference' }, referenceIds: mixed.map((asset) => asset.id) }, mixed)).not.toThrow()
    const audioOnly = { ...input, params: { ...input.params, videoMode: 'reference' as const }, referenceIds: [audio.id] }
    expect(() => validateGeneration(audioOnly, [audio])).toThrow('不能仅参考音频')
    expect(() => validateGeneration({ ...audioOnly, model: snapshot(6).model }, [audio])).not.toThrow()
    const frames = { ...input, params: { ...input.params, videoMode: 'frames' as const, firstFrameId: image.id, lastFrameId: tail.id }, referenceIds: [tail.id, image.id] }
    expect(() => validateGeneration(frames, [image, tail])).not.toThrow()
    expect(() => validateGeneration({ ...frames, params: { ...frames.params, lastFrameId: undefined } }, [image, tail])).toThrow('尾帧')
    expect(() => validateGeneration({ ...frames, model: snapshot(6).model }, [image, tail])).toThrow('跟随首帧')
    expect(() => validateGeneration({ ...frames, model: snapshot(6).model, params: { ...frames.params, size: '720p/adaptive' } }, [image, tail])).not.toThrow()
    expect(() => validateGeneration({ ...frames, referenceIds: [image.id], params: { ...frames.params, lastFrameId: undefined } }, [image])).not.toThrow()
  })
  it('rejects all mixed/over-limit frame modes, wrong roles, duplicate assets, incompatible formats and duration budgets', () => {
    const input = snapshot(), image = asset(), tail = asset(), third = asset(), audio = asset('audio'), video = asset('video')
    const frames = { ...input.params, videoMode: 'frames' as const, firstFrameId: image.id, lastFrameId: tail.id }
    for (const references of [[image, tail, third], [image, video], [image, audio]])
      expect(() => validateSeedanceConnections(frames, references, input.model.model_id)).toThrow('最多连接两张')
    for (const [params, references] of [
      [input.params, [image]], [{ ...frames, firstFrameId: tail.id, lastFrameId: tail.id }, [image, tail]],
      [{ ...input.params, videoMode: 'reference', firstFrameId: image.id }, [image]],
      [{ ...input.params, videoMode: 'reference' }, [image, image]],
      [{ ...input.params, videoMode: 'reference' }, [asset('video', { mime: 'video/webm' })]],
      [{ ...input.params, videoMode: 'reference' }, [asset('audio', { mime: 'audio/ogg' }), image]],
      [{ ...input.params, videoMode: 'reference' }, [asset('video', { duration: 1 })]],
      [{ ...input.params, videoMode: 'reference' }, [asset('video', { duration: 8 }), asset('video', { duration: 8 })]],
      [{ ...input.params, videoMode: 'reference' }, [asset('image', { width: 299 })]],
    ] as const) expect(() => validateGeneration({ ...input, params, referenceIds: references.map((asset) => asset.id) }, references)).toThrow()
    expect(() => validateSeedanceConnections({ ...input.params, videoMode: 'reference' }, Array.from({ length: 10 }, () => asset()), input.model.model_id)).toThrow('9')
    expect(() => validateSeedanceConnections({ ...input.params, videoMode: 'reference' }, Array.from({ length: 4 }, () => asset('video')), input.model.model_id)).toThrow('3')
  })
})

describe('Seedance native submit/query protocol', () => {
  it.each(models.map((_, i) => i))('sends all three modes and original routing/auth on channel %s', async (index) => {
    const input = snapshot(index), image = asset(), tail = asset(), video = asset('video'), audio = asset('audio')
    const byId = new Map([image, tail, video, audio].map((asset) => [asset.id, asset]))
    const inspect = vi.fn(async (_task: string, id: string) => byId.get(id)!)
    const sign = vi.fn(async (_task: string, id: string) => `https://objects.invalid/${id}?ttl=86400`)
    const read = vi.fn(), fetch = vi.fn(async () => Response.json({ id: 'cgt-test' }))
    vi.stubGlobal('fetch', fetch)
    const provider = new Providers({ readMedia: read, stagePath: (name) => name, inspectReference: inspect, modelReferenceUrl: sign },
      { requestTimeoutMs: 1000, maxMediaBytes: 100000, maxReferenceBytes: 20000 }, new AbortController().signal)
    for (const mode of ['text', 'reference', 'frames'] as const) {
      const references = mode === 'text' ? [] : mode === 'frames' ? [tail, image] : [image, video, audio]
      const next = { ...input, params: { ...input.params, videoMode: mode, generateAudio: false,
        ...(mode === 'frames' ? { firstFrameId: image.id, lastFrameId: tail.id, ...(input.model.model_id.includes('-2-5-') ? { size: '720p/adaptive' } : {}) } : {}) },
        referenceIds: references.map((asset) => asset.id) }
      const prepared = await provider.prepare(next, 'local-task')
      expect(await provider.submit(next, `private-${index}`, prepared)).toEqual({ id: 'cgt-test', status: 'queued' })
      const [url, init] = fetch.mock.calls.at(-1)! as unknown as [string, RequestInit]
      expect(url).toBe(`${input.model.api_base}/contents/generations/tasks`)
      expect(new Headers(init.headers).get('authorization')).toBe(`Bearer private-${index}`)
      const payload = JSON.parse(init.body as string)
      expect(payload).toEqual({ model: input.model.endpoint_id ?? input.model.model_id, duration: 5, ratio: next.params.size.split('/')[1],
        resolution: '720p', generate_audio: false, watermark: false,
        ...(mode === 'reference' && input.model.model_id.includes('-2-5-') ? { omni_reference_task_type: 'reference' } : {}),
        content: [{ type: 'text', text: input.prompt }, ...references.map((asset) => ({ type: `${asset.kind}_url`,
          [`${asset.kind}_url`]: { url: `https://objects.invalid/${asset.id}?ttl=86400` },
          role: mode === 'frames' ? asset.id === image.id ? 'first_frame' : 'last_frame' : `reference_${asset.kind}` }))] })
      expect(payload).not.toHaveProperty('draft'); expect(payload).not.toHaveProperty('frames'); expect(payload).not.toHaveProperty('callback_url')
    }
    expect(read).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledTimes(3)
    for (let i = 0; i < inspect.mock.invocationCallOrder.length; i++) {
      const group = i < 3 ? 0 : 3
      expect(inspect.mock.invocationCallOrder[i]).toBeLessThan(sign.mock.invocationCallOrder[group])
    }
  })
  it.each(['queued', 'running', 'succeeded', 'failed', 'expired', 'cancelled'])('maps %s with matching task identity and public result URL', async (status) => {
    const fetch = vi.fn(async () => Response.json({ id: 'cgt-safe', status, content: status === 'succeeded' ? { video_url: 'https://cdn.invalid/result.mp4' } : null }))
    vi.stubGlobal('fetch', fetch)
    const provider = new Providers({ readMedia: vi.fn(), stagePath: (name) => name }, { requestTimeoutMs: 1000, maxMediaBytes: 10000, maxReferenceBytes: 10000 }, new AbortController().signal)
    const result = await provider.poll(snapshot(), 'private', 'cgt-safe')
    expect(result.status).toBe(status === 'running' ? 'generating' : status === 'succeeded' ? 'completed' : ['expired', 'cancelled'].includes(status) ? 'failed' : status)
    expect(fetch.mock.calls[0][0]).toBe(`${models[0].api_base}/contents/generations/tasks/cgt-safe`)
    if (status === 'succeeded') expect(result.outputs![0]).toMatchObject({ url: 'https://cdn.invalid/result.mp4', authenticated: false })
  })
  it.each([{ id: 'wrong', status: 'running' }, { id: 'cgt-safe', status: 'new-status' }, { id: 'cgt-safe', status: 'succeeded' },
    { id: 'cgt-safe', status: 'succeeded', content: { video_url: 'file:///result' } }])('rejects malformed query %j without creating replacements', async (body) => {
    const fetch = vi.fn(async () => Response.json(body)); vi.stubGlobal('fetch', fetch)
    const provider = new Providers({ readMedia: vi.fn(), stagePath: (name) => name }, { requestTimeoutMs: 1000, maxMediaBytes: 10000, maxReferenceBytes: 10000 }, new AbortController().signal)
    await expect(provider.poll(snapshot(), 'private', 'cgt-safe')).rejects.toMatchObject({ definitive: false })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe('Seedance exact reference inspection and durable OSS tasks', () => {
  it('submits empty reference/frame drafts as text generation and keeps idempotent task identity', async () => {
    const instance = await service(), generator = await node(instance, 6)
    const graph = instance.store.state('w').graph
    await instance.saveGraph('w', { ...graph, nodes: [{ ...generator, params: { ...generator.params as TaskSnapshot['params'],
      videoMode: 'frames', firstFrameId: randomUUID(), lastFrameId: randomUUID() } }] }, 1)
    const fetch = vi.fn(async () => Response.json({ id: 'cgt-empty' })); vi.stubGlobal('fetch', fetch)
    const requestId = randomUUID(), accepted = await instance.generate('w', generator.id, 2, requestId)
    const queued = await wait(instance, accepted.id, 'queued')
    expect(queued.snapshot.params).toMatchObject({ videoMode: 'text' })
    expect(queued.snapshot.params).not.toHaveProperty('firstFrameId'); expect(queued.snapshot.params).not.toHaveProperty('lastFrameId')
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string).content).toEqual([{ type: 'text', text: generator.prompt }])
    expect((await instance.generate('w', generator.id, 2, requestId)).id).toBe(accepted.id)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('waits at least three seconds between queries, including transport errors, without resubmitting', async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit = {}) => {
      if (init.method === 'POST') return Response.json({ id: 'cgt-delay' })
      throw new Error('temporary query failure')
    })
    vi.stubGlobal('fetch', fetch)
    const instance = await service(), generator = await node(instance)
    const accepted = await instance.generate('w', generator.id, 1)
    await wait(instance, accepted.id, 'queued')
    const delay = await instance.store.db.get('SELECT next_run_at FROM task_details WHERE task_id=?', [accepted.id])
    expect(delay.next_run_at - Date.now()).toBeGreaterThan(2800)
    expect(fetch).toHaveBeenCalledTimes(1)
    await instance.store.db.batch([sql('UPDATE task_details SET next_run_at=0 WHERE task_id=?', [accepted.id])])
    instance.runtime.wake()
    for (let i = 0; i < 100; i++) {
      const detail = await instance.store.db.get('SELECT failure_stage,next_run_at FROM task_details WHERE task_id=?', [accepted.id])
      if (detail.failure_stage === 'poll' && !instance.runtime.isActive(accepted.id)) {
        expect(detail.next_run_at - Date.now()).toBeGreaterThan(2800)
        expect(fetch).toHaveBeenCalledTimes(2)
        expect(instance.store.state('w').tasks.find((task) => task.id === accepted.id)?.providerTaskId).toBe('cgt-delay')
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error('Original query did not finish')
  })
  it('reads actual image/video/audio metadata, validates hashes, and cleans temporary files', async () => {
    const root = await directory(), image = await sharp({ create: { width: 600, height: 400, channels: 3, background: 'blue' } }).png().toBuffer()
    const video = await videoBytes(root)
    const audioPath = join(root, 'audio.wav')
    await promisify(execFile)(ffmpeg.path, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', audioPath])
    const audio = await readFile(audioPath)
    for (const [kind, bytes, mime] of [['image', image, 'image/png'], ['video', video, 'video/mp4'], ['audio', audio, 'audio/wav']] as const) {
      const input = asset(kind, { bytes: bytes.length, mime, width: undefined, height: undefined, duration: undefined })
      const hash = createHash('sha256').update(bytes).digest('hex')
      const result = await inspectSeedanceReference(Readable.from([bytes]), input, hash, new AbortController().signal)
      if (kind === 'image') expect(result).toMatchObject({ width: 600, height: 400 })
      else expect(result.duration).toBeCloseTo(2, 1)
      if (kind === 'video') expect(result).toMatchObject({ width: 640, height: 720, frameRate: 24, videoCodec: 'h264' })
      await expect(inspectSeedanceReference(Readable.from([bytes]), input, 'a'.repeat(64), new AbortController().signal)).rejects.toMatchObject({ code: 'MEDIA_CHANGED' })
    }
  })
  it('freezes EP/key, restores only the original query after restart, and downloads without forwarding the key', async () => {
    const root = await directory(), output = await videoBytes(root)
    const fetch = vi.fn(async (_url: string, init: RequestInit = {}) => init.method === 'POST'
      ? Response.json({ id: 'cgt-resume' }) : Response.json({ id: 'cgt-resume', status: 'running' }))
    vi.stubGlobal('fetch', fetch)
    const instance = await service(root), generator = await node(instance), requestId = randomUUID()
    const ddl = await instance.store.db.all('SELECT sql FROM sqlite_master ORDER BY name')
    const accepted = await instance.generate('w', generator.id, 1, requestId)
    const waiting = await wait(instance, accepted.id, 'queued')
    await instance.store.saveModel({ ...models[1], endpoint_id: 'ep-rotated', api_key: 'rotated-key' })
    expect((await instance.generate('w', generator.id, 1, requestId)).id).toBe(accepted.id)
    expect(waiting.providerTaskId).toBe('cgt-resume')
    await instance.close()
    fetch.mockImplementation(async (url: string, init: RequestInit = {}) => {
      expect(init.method).not.toBe('POST')
      if (String(url) === 'https://cdn.invalid/generated.mp4') return new Response(new Uint8Array(output))
      return Response.json({ id: 'cgt-resume', status: 'succeeded', content: { video_url: 'https://cdn.invalid/generated.mp4' } })
    })
    const resumed = await service(root), completed = await wait(resumed, accepted.id, 'completed')
    expect(completed.id).toBe(accepted.id); expect(completed.snapshot.model).toMatchObject({ name: models[1].name, model_id: models[1].model_id, endpoint_id: 'ep-channel-1' })
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
    const queries = fetch.mock.calls.filter(([url]) => String(url).includes('/contents/generations/tasks/'))
    for (const [, init] of queries) expect(new Headers(init?.headers).get('authorization')).toBe('Bearer key-1')
    const download = fetch.mock.calls.find(([url]) => String(url) === 'https://cdn.invalid/generated.mp4')!
    expect(new Headers(download[1]?.headers).get('authorization')).toBeNull()
    expect(await resumed.store.readMedia(completed.resultIds[0], 1000000)).toEqual(output)
    expect(await resumed.store.db.all('SELECT sql FROM sqlite_master ORDER BY name')).toEqual(ddl)
  })
  it('pins input objects, signs them fresh, and bypasses the image byte budget for streamed video inputs', async () => {
    const root = await directory()
    const video = await videoBytes(root), instance = await service(root), generator = await node(instance)
    instance.config.maxReferenceBytes = 1
    const source: CanvasNode = { ...generator, id: randomUUID(), kind: 'video-asset', modelId: null, params: null, prompt: '' }
    await instance.saveGraph('w', { ...emptyGraph(), nodes: [generator, source] }, 1)
    const imported = await instance.store.saveMedia(Readable.from([video]), { id: randomUUID(), kind: 'video', filename: 'input.mp4', nodeId: source.id, taskId: null, createdAt: 1 }, 1000000, 'video')
    await instance.store.update('w', (state) => { state.assets.push(imported) })
    const graph = instance.store.state('w').graph
    await instance.saveGraph('w', { ...graph, nodes: graph.nodes.map((item) => item.id === source.id ? { ...item, assetId: imported.id }
      : { ...item, params: generator.params }),
      edges: [{ id: randomUUID(), source: source.id, target: generator.id, assetId: imported.id }] }, 2)
    const submit = vi.fn(async () => Response.json({ id: 'cgt-input' })); vi.stubGlobal('fetch', submit)
    const sign = vi.spyOn(instance.store, 'modelReferenceUrl')
    const read = vi.spyOn(instance.store, 'readMedia')
    const task = await instance.generate('w', generator.id, 3)
    const queued = await wait(instance, task.id, 'queued')
    expect(queued.snapshot.params).toMatchObject({ videoMode: 'reference' })
    expect(read).not.toHaveBeenCalled(); expect(sign).toHaveBeenCalledWith(task.id, imported.id)
    const [url, init] = submit.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${models[1].api_base}/contents/generations/tasks`)
    expect(JSON.parse(init.body as string).content[1]).toMatchObject({ type: 'video_url', role: 'reference_video' })
    expect(await instance.store.db.all('SELECT asset_id FROM task_references WHERE task_id=?', [task.id])).toEqual([{ asset_id: imported.id }])
  })
  it('persists automatically assigned frame roles in the accepted snapshot and sends them in connection order', async () => {
    const root = await directory(), instance = await service(root), generator = await node(instance)
    const bytes = await sharp({ create: { width: 600, height: 400, channels: 3, background: 'blue' } }).png().toBuffer()
    const sources = [0, 1].map(() => ({ ...generator, id: randomUUID(), kind: 'image-asset' as const, modelId: null, params: null, prompt: '' }))
    await instance.saveGraph('w', { ...emptyGraph(), nodes: [generator, ...sources] }, 1)
    const images: Asset[] = []
    for (const source of sources) {
      const image = await instance.store.saveMedia(Readable.from([bytes]), { id: randomUUID(), kind: 'image', filename: 'frame.png', nodeId: source.id, taskId: null, createdAt: 1 }, 1000000, 'image')
      await instance.store.update('w', (state) => { state.assets.push(image) })
      images.push(image)
    }
    const graph = instance.store.state('w').graph
    await instance.saveGraph('w', { ...graph, nodes: graph.nodes.map((item) => item.id === generator.id
      ? { ...item, params: { ...generator.params as TaskSnapshot['params'], videoMode: 'frames' } }
      : { ...item, assetId: images.find((image) => image.nodeId === item.id)!.id }),
      edges: images.map((image) => ({ id: randomUUID(), source: image.nodeId!, target: generator.id, assetId: image.id })) }, 2)
    const fetch = vi.fn(async () => Response.json({ id: 'cgt-auto-frames' })); vi.stubGlobal('fetch', fetch)
    const accepted = await instance.generate('w', generator.id, 3)
    const queued = await wait(instance, accepted.id, 'queued')
    expect(queued.snapshot.params).toMatchObject({ videoMode: 'frames', firstFrameId: images[0].id, lastFrameId: images[1].id })
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string).content.slice(1).map((part: { role: string }) => part.role)).toEqual(['first_frame', 'last_frame'])
    expect(instance.store.state('w').graph.nodes.find((item) => item.id === generator.id)?.params).not.toHaveProperty('firstFrameId')
  })
  it('preserves a downloaded result through save failure and retries only OSS publication after restart', async () => {
    const root = await directory(), output = await videoBytes(root)
    const fetch = vi.fn(async (url: string, init: RequestInit = {}) => init.method === 'POST' ? Response.json({ id: 'cgt-save' })
      : String(url) === 'https://cdn.invalid/video.mp4' ? new Response(new Uint8Array(output)) : Response.json({ id: 'cgt-save', status: 'succeeded', content: { video_url: 'https://cdn.invalid/video.mp4' } }))
    vi.stubGlobal('fetch', fetch)
    const instance = await service(root), generator = await node(instance)
    const publish = vi.spyOn(instance.store.objects, 'publish').mockRejectedValue(new Error('OSS down'))
    const accepted = await instance.generate('w', generator.id, 1)
    await wait(instance, accepted.id, 'save_failed')
    const outputs = (await instance.store.taskPrivate(accepted.id)).outputs!
    await instance.close(); publish.mockRestore()
    const calls = fetch.mock.calls.length, resumed = await service(root)
    await resumed.taskAction('w', accepted.id, 'retry-save')
    expect((await wait(resumed, accepted.id, 'completed')).resultIds).toEqual([outputs[0].id])
    expect(fetch).toHaveBeenCalledTimes(calls)
    expect(await resumed.store.readMedia(outputs[0].id, 1000000)).toEqual(output)
  })
})
