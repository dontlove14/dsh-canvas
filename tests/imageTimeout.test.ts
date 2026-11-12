import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import sharp from 'sharp'
import { getGlobalDispatcher } from 'undici'
import { Config } from '../src/host/index'
import { Providers, type ProviderOptions } from '../src/host/providers'
import { CanvasService } from '../src/host/service'
import { BUILTIN_MODELS, providerFor, seedreamRequiresEndpoint } from '../src/shared/modelCatalog'
import { defaultParams, defaultTtsParams, emptyGraph, FISH_TTS_ENDPOINT, type CanvasNode, type TaskSnapshot, type TtsTaskSnapshot } from '../src/shared/contracts'
import { fakeFactory, initialize } from './support/objectStorage'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})
const options: ProviderOptions = { requestTimeoutMs: 120000, maxMediaBytes: 100000, maxReferenceBytes: 20000 }
const models = BUILTIN_MODELS.filter((model) => model.kind === 'image')
const imageBytes = () => sharp({ create: { width: 32, height: 32, channels: 3, background: '#678abc' } }).png().toBuffer()
function input(model = models[0]): TaskSnapshot {
  return { model: { ...model, ...(seedreamRequiresEndpoint(model) ? { endpoint_id: 'ep-timeout-fixture' } : {}) },
    prompt: '画一棵树', params: defaultParams(model), referenceIds: [] }
}
function provider(bytes: Buffer, config = options, signal = new AbortController().signal) {
  return new Providers({ readMedia: async () => bytes, stagePath: (name) => name }, config, signal)
}
function imageResponse(snapshot: TaskSnapshot, bytes: Buffer) {
  const data = bytes.toString('base64')
  if (snapshot.model.protocol !== 'gemini-image') return { data: [{ b64_json: data }] }
  return providerFor(snapshot.model)?.id === 'model-link'
    ? { candidates: [{ finishReason: 'STOP', content: { parts: [{ inlineData: { mimeType: 'image/png', data } }] } }] }
    : { status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'image', mime_type: 'image/png', data }] }] }
}
function ttsInput(): TtsTaskSnapshot {
  return { model: { id: randomUUID(), kind: 'audio', name: 'FishTTS', model_id: 's1', protocol: 'fish-tts', api_base: FISH_TTS_ENDPOINT },
    prompt: '你好', params: { ...defaultTtsParams(), reference_id: 'fixture-voice' }, referenceIds: [] }
}
function pendingFetch() {
  return vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const signal = init.signal!
    if (signal.aborted) reject(signal.reason)
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  }))
}
async function eventually(check: () => boolean) {
  const deadline = Date.now() + 3000
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Expected task state was not reached')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('image request deadlines', () => {
  it('defaults image requests to 600 seconds without changing the generic default and validates bounds', () => {
    expect(Config.parse({})).toMatchObject({ requestTimeoutMs: 120000, imageRequestTimeoutMs: 600000 })
    expect(Config.parse({ requestTimeoutMs: 2000 }).imageRequestTimeoutMs).toBe(600000)
    for (const value of [1000, 600000]) expect(Config.parse({ imageRequestTimeoutMs: value }).imageRequestTimeoutMs).toBe(value)
    for (const value of [999, 600001, 1000.5]) expect(Config.safeParse({ imageRequestTimeoutMs: value }).success).toBe(false)
  })
  it.each(models.flatMap((model) => [false, true].map((references) => ({ model, references }))))(
    '$model.name / $model.api_base references=$references uses 600000ms',
    async ({ model, references }) => {
      const bytes = await imageBytes(), snapshot = input(model)
      if (references) snapshot.referenceIds = [randomUUID()]
      const fetch = vi.fn(async () => Response.json(imageResponse(snapshot, bytes))); vi.stubGlobal('fetch', fetch)
      const timeout = vi.spyOn(AbortSignal, 'timeout')
      const result = await provider(bytes).submit(snapshot, 'fixture-key')
      expect(result.status).toBe('completed'); expect(result.outputs).toHaveLength(1)
      expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([600000])
      expect(fetch).toHaveBeenCalledTimes(1)
      const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
      expect(init.redirect).toBe('error')
      expect(init).toHaveProperty('dispatcher')
      if (references && model.protocol === 'openai-image') {
        expect(url).toMatch(/images\/edits$/); expect(init.body).toBeInstanceOf(FormData)
      }
    })
  it('honors an explicit image deadline independently of the generic timeout', async () => {
    const bytes = await imageBytes(), snapshot = input(), timeout = vi.spyOn(AbortSignal, 'timeout')
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(imageResponse(snapshot, bytes))))
    await provider(bytes, { ...options, imageRequestTimeoutMs: 450000 }).submit(snapshot, 'fixture')
    expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([450000])
  })
  it.each([600000, 450000])('passes %i ms to Node header/body timeouts on a real loopback request', async (imageRequestTimeoutMs) => {
    const bytes = await imageBytes(), snapshot = input()
    const server = createServer((_request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(imageResponse(snapshot, bytes)))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }))
    snapshot.model.api_base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
    const original = getGlobalDispatcher(), dispatch = vi.spyOn(original, 'dispatch')
    const result = await provider(bytes, { ...options, imageRequestTimeoutMs }).submit(snapshot, 'fixture')
    expect(result.status).toBe('completed')
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch.mock.calls[0][0]).toMatchObject({ headersTimeout: imageRequestTimeoutMs, bodyTimeout: imageRequestTimeoutMs })
    expect(getGlobalDispatcher()).toBe(original)
  })
  it('keeps video submission and polling on the generic timeout', async () => {
    const snapshot: TaskSnapshot = { model: { id: randomUUID(), kind: 'video', name: 'Retained Sora',
      model_id: 'sora-2', protocol: 'openai-video', api_base: 'https://video.invalid/v1' },
      prompt: '树', params: { size: '1280x720', n: 1, seconds: 4 }, referenceIds: [] }
    const fetch = vi.fn(async () => Response.json({ id: 'fixture-video', status: 'queued' })); vi.stubGlobal('fetch', fetch)
    const timeout = vi.spyOn(AbortSignal, 'timeout'), instance = provider(Buffer.alloc(0))
    await instance.submit(snapshot, 'fixture')
    await instance.poll(snapshot, 'fixture', 'fixture-video')
    expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([120000, 120000])
    expect(fetch).toHaveBeenCalledTimes(2)
    for (const call of fetch.mock.calls) expect(call[1]).not.toHaveProperty('dispatcher')
  })
  it('keeps FishTTS on the generic timeout', async () => {
    const fetch = vi.fn(async () => Response.json({ message: 'fixture refusal' }, { status: 422 })); vi.stubGlobal('fetch', fetch)
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    await expect(provider(Buffer.alloc(0)).submit(ttsInput(), 'fixture')).rejects.toThrow('fixture refusal')
    expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([120000])
    expect(fetch.mock.calls[0][1]).not.toHaveProperty('dispatcher')
  })
  it('keeps output downloads on the generic timeout and sends no model key', async () => {
    const bytes = await imageBytes(), fetch = vi.fn(async () => new Response(bytes)); vi.stubGlobal('fetch', fetch)
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    const stream = await provider(bytes).outputStream({ id: randomUUID(), mime: 'image/png', filename: 'fixture.png',
      url: 'https://output.invalid/fixture.png' }, input(), 'fixture-key')
    const chunks = []
    for await (const chunk of stream) chunks.push(Buffer.from(chunk))
    expect(Buffer.concat(chunks)).toEqual(bytes)
    expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([120000])
    expect(new Headers((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].headers).has('authorization')).toBe(false)
    expect(fetch.mock.calls[0][1]).not.toHaveProperty('dispatcher')
  })
  it('still cancels an image request immediately when the host stops', async () => {
    const host = new AbortController(), fetch = pendingFetch(); vi.stubGlobal('fetch', fetch)
    const pending = provider(Buffer.alloc(0), options, host.signal).submit(input(), 'fixture', new Map())
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await eventually(() => fetch.mock.calls.length === 1)
    host.abort(); await rejected
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('applies the image deadline through response body consumption', async () => {
    const deadline = new AbortController(), timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
    const fetch = vi.fn(async (_url: string, init: RequestInit) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"data":['))
        init.signal!.addEventListener('abort', () => controller.error(init.signal!.reason), { once: true })
      },
    }))); vi.stubGlobal('fetch', fetch)
    const pending = provider(Buffer.alloc(0)).submit(input(), 'fixture', new Map())
    const rejected = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' })
    await eventually(() => fetch.mock.calls.length === 1)
    deadline.abort(new DOMException('Image deadline reached', 'TimeoutError')); await rejected
    expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([600000])
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe('image runtime lease and timeout recovery', () => {
  it.each([
    { kind: 'image' as const, imageRequestTimeoutMs: undefined, requestTimeoutMs: 120000, lease: 600000 * 8 },
    { kind: 'image' as const, imageRequestTimeoutMs: 450000, requestTimeoutMs: 120000, lease: 450000 * 8 },
    { kind: 'image' as const, imageRequestTimeoutMs: 1000, requestTimeoutMs: 120000, lease: 120000 * 8 },
    { kind: 'audio' as const, imageRequestTimeoutMs: undefined, requestTimeoutMs: 120000, lease: 120000 * 8 },
  ])('$kind lease covers $lease ms and failed submission is not repeated', async (config) => {
    const root = await mkdtemp(join(tmpdir(), 'image-timeout-')); cleanups.push(() => rm(root, { recursive: true, force: true }))
    const serviceConfig = { ...options, dataDir: root, maxConcurrentTasks: 1, pollIntervalMs: 25,
      requestTimeoutMs: config.requestTimeoutMs, imageRequestTimeoutMs: config.imageRequestTimeoutMs }
    const instance = new CanvasService(serviceConfig, undefined, fakeFactory(root))
    await initialize(instance, true); cleanups.push(() => instance.close())
    if (config.kind === 'image') await instance.store.saveModel({ ...models[0], api_key: 'fixture-key' })
    else await instance.store.saveTtsSettings({ endpoint: FISH_TTS_ENDPOINT, revision: 0, api_key: 'fixture-key' })
    const node: CanvasNode = { id: randomUUID(), kind: config.kind === 'image' ? 'image-generation' : 'tts-generation',
      title: '等待测试', position: { x: 0, y: 0 }, prompt: '树', modelId: config.kind === 'image' ? models[0].id : null,
      params: config.kind === 'image' ? defaultParams(models[0]) : ttsInput().params, assetId: null, selectedResultId: null }
    await instance.saveGraph('w', { ...emptyGraph(), nodes: [node] }, 0)
    const deadline = new AbortController(); vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
    const fetch = pendingFetch(); vi.stubGlobal('fetch', fetch)
    const startedAt = Date.now(), accepted = await instance.generate('w', node.id, 1, randomUUID(), false, config.kind === 'audio')
    await eventually(() => fetch.mock.calls.length === 1)
    const detail = await instance.store.db.get('SELECT lease_owner,lease_until FROM task_details WHERE task_id=?', [accepted.id])
    expect(detail!.lease_owner).toBe(instance.store.db.token)
    expect(detail!.lease_until).toBeGreaterThanOrEqual(startedAt + config.lease)
    expect(detail!.lease_until).toBeLessThanOrEqual(Date.now() + config.lease)
    deadline.abort(new DOMException('Fixture deadline reached', 'TimeoutError'))
    await eventually(() => instance.store.state('w').tasks[0].status === 'failed' && !instance.runtime.isActive(accepted.id))
    expect((await instance.store.taskPrivate(accepted.id)).issued).toBe(true)
    expect(await instance.store.db.all("SELECT step,outcome FROM task_attempts WHERE task_id=? AND step='submit'", [accepted.id]))
      .toEqual([{ step: 'submit', outcome: 'failed' }])
    instance.runtime.wake(); await instance.close()
    const reopened = new CanvasService(serviceConfig, undefined, fakeFactory(root))
    await initialize(reopened, true); cleanups.push(() => reopened.close())
    expect(reopened.store.state('w').tasks[0]).toMatchObject({ id: accepted.id, status: 'failed', resultIds: [] })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect((await reopened.store.taskPrivate(accepted.id)).issued).toBe(true)
  })
})
