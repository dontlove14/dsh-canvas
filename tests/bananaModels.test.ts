import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Providers } from '../src/host/providers'
import { CanvasService } from '../src/host/service'
import { BUILTIN_MODELS, BANANA_MODELS, bananaSizePresets, providerFor } from '../src/shared/modelCatalog'
import { capabilitiesFor, defaultParams, emptyGraph, validateGeneration, type CanvasNode, type TaskSnapshot, type TaskStatus } from '../src/shared/contracts'
import { fakeFactory, initialize } from './support/objectStorage'

const models = BUILTIN_MODELS.filter((model) => model.protocol === 'gemini-image')
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZAAAAABJRU5ErkJggg==', 'base64')
const image = (data = png.toString('base64'), mime = 'image/png') => ({ type: 'image', mime_type: mime, data })
const response = (content: unknown[] = [image()]) => ({ status: 'completed', id: 'interaction', steps: [
  { type: 'thought', summary: [image(), { type: 'text', text: 'private reasoning' }] },
  { type: 'model_output', content },
] })
const generateContentResponse = (content: any[] = [image()]) => ({ candidates: [{ finishReason: 'STOP', content: { parts: [
  { thought: true, inlineData: { mimeType: 'image/png', data: png.toString('base64') } },
  ...content.map((part) => part.type === 'image'
    ? { inlineData: { mimeType: part.mime_type, data: part.data }, ...(part.uri ? { fileData: { fileUri: part.uri } } : {}) }
    : { text: part.text }),
] } }] })
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function service(root?: string) {
  if (!root) { root = await mkdtemp(join(tmpdir(), 'canvas-banana-')); const path = root; cleanup.push(() => rm(path, { recursive: true, force: true })) }
  const instance = new CanvasService({ dataDir: root, maxConcurrentTasks: 1, pollIntervalMs: 25, requestTimeoutMs: 3000,
    maxMediaBytes: 100000, maxReferenceBytes: 10000 }, undefined, fakeFactory(root))
  await initialize(instance, true); cleanup.push(() => instance.close()); return instance
}
async function provider(index = 0, referenceBytes = png) {
  const root = await mkdtemp(join(tmpdir(), 'canvas-banana-provider-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const read = vi.fn(async () => referenceBytes)
  const instance = new Providers({ readMedia: read, stagePath: (name) => join(root, name) },
    { requestTimeoutMs: 3000, maxMediaBytes: 100000, maxReferenceBytes: 10000 }, new AbortController().signal)
  const snapshot: TaskSnapshot = { model: models[index], params: defaultParams(models[index]), prompt: '画一棵树', referenceIds: [] }
  return { instance, snapshot, read, root }
}
async function generator(instance: CanvasService, index = 0) {
  const model = models[index]
  await instance.store.saveModel({ ...model, api_key: `banana-secret-${index}` })
  const node: CanvasNode = { id: randomUUID(), kind: 'image-generation', title: 'Banana', position: { x: 0, y: 0 },
    modelId: model.id, prompt: '画一棵树', params: defaultParams(model), assetId: null, selectedResultId: null }
  await instance.saveGraph('w', { ...emptyGraph(), nodes: [node] }, 0)
  return node
}
async function wait(instance: CanvasService, id: string, status: TaskStatus) {
  for (let i = 0; i < 400; i++) {
    const task = instance.store.state('w').tasks.find((item) => item.id === id)!
    if (task.status === status && !instance.runtime.isActive(id)) return task
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Expected ${status}; got ${instance.store.state('w').tasks.find((item) => item.id === id)?.status}`)
}

describe('Nano Banana model catalog and per-model parameters', () => {
  it('adds all four exact identities with two independent channels and preserves the four GPT UUIDs', () => {
    expect(BUILTIN_MODELS).toHaveLength(12); expect(models).toHaveLength(8)
    expect(models.map((model) => [model.model_id, model.name])).toEqual(BANANA_MODELS.flatMap((model) => [[model.id, model.name], [model.id, model.name]]))
    expect(new Set(BUILTIN_MODELS.map((model) => model.id)).size).toBe(12)
    expect(BUILTIN_MODELS.slice(0, 4).map((model) => model.id)).toEqual([1, 2, 3, 4].map((id) => `00000000-0000-4000-b000-00000000000${id}`))
    expect(models.map((model) => providerFor(model)?.id)).toEqual(Array(4).fill(['model-link', 'gemini']).flat())
  })
  it.each([0, 2, 4, 6])('exposes only model %s supported tiers, ordered ratios and references; defaults to 1K', (index) => {
    const model = models[index], caps = capabilitiesFor(model)
    expect(defaultParams(model)).toEqual({ size: '1024x1024', n: 1 })
    expect([...new Set(caps.sizePresets!.map((preset) => preset.resolution))]).toEqual(index === 4 ? ['1K'] : index === 2 ? ['0.5K', '1K', '2K', '4K'] : ['1K', '2K', '4K'])
    expect(caps.sizePresets!.filter((preset) => preset.resolution === '1K').map((preset) => preset.ratio))
      .toEqual(['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'])
    expect(caps.counts).toEqual([1]); expect(caps.maxReferences).toBe(index === 4 ? 1 : 14)
    expect(caps.backgrounds).toBeUndefined(); expect(caps.qualities).toBeUndefined()
    expect(() => validateGeneration({ model, params: { ...defaultParams(model), n: 2 }, prompt: 'x', referenceIds: [] }, [])).toThrow('数量')
    expect(() => validateGeneration({ model, params: { ...defaultParams(model), background: 'transparent' }, prompt: 'x', referenceIds: [] }, [])).toThrow('背景')
  })
})

describe('Nano Banana native requests and base64 outputs', () => {
  it.each(models.map((_, index) => index))('uses the documented provider endpoint, JSON and exclusive auth header on channel %s', async (index) => {
    const google = index % 2 === 1
    const fetch = vi.fn(async () => Response.json(google ? response() : generateContentResponse())); vi.stubGlobal('fetch', fetch)
    const { instance, snapshot } = await provider(index)
    const result = await instance.submit(snapshot, 'channel-private-key')
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(google ? `${models[index].api_base}/v1beta/interactions`
      : `${models[index].api_base}/v1/models/${models[index].model_id}:generateContent`)
    expect(JSON.parse(init.body as string)).toEqual(google
      ? { model: models[index].model_id, input: [{ type: 'text', text: snapshot.prompt }],
        store: false, response_format: { type: 'image', delivery: 'inline', mime_type: 'image/jpeg', aspect_ratio: '1:1', image_size: '1K' } }
      : { contents: [{ parts: [{ text: snapshot.prompt }] }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '1:1', imageSize: '1K' } } })
    const headers = new Headers(init.headers)
    expect(headers.get('x-goog-api-key')).toBe(index % 2 === 1 ? 'channel-private-key' : null)
    expect(headers.get('authorization')).toBe(index % 2 === 0 ? 'Bearer channel-private-key' : null)
    expect(init.redirect).toBe('error')
    expect(result.status).toBe('completed'); expect(result.outputs).toHaveLength(1)
    expect(result.outputs![0]).toMatchObject({ mime: 'image/png', filename: 'generated-image.png' })
    const chunks: Buffer[] = []
    for await (const chunk of await instance.outputStream(result.outputs![0], snapshot, 'channel-private-key')) chunks.push(Buffer.from(chunk))
    expect(Buffer.concat(chunks)).toEqual(png)
    expect(result.outputs![0].url).toBeUndefined(); expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('sends ordered OSS reference bytes inline and maps 0.5K to the documented 512 wire value', async () => {
    const fetch = vi.fn(async () => Response.json(generateContentResponse())); vi.stubGlobal('fetch', fetch)
    const { instance, snapshot, read } = await provider(2)
    const ids = Array.from({ length: 14 }, () => randomUUID())
    await instance.submit({ ...snapshot, params: { size: '688x384', n: 1 }, referenceIds: ids }, 'reference-secret')
    expect(read.mock.calls.map(([id]) => id)).toEqual(ids)
    const init = fetch.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string)
    expect(body.generationConfig.imageConfig).toEqual({ aspectRatio: '16:9', imageSize: '512' })
    expect(body.contents[0].parts.slice(1)).toEqual(ids.map(() => ({ inline_data: { mime_type: 'image/png', data: png.toString('base64') } })))
    expect(body).not.toHaveProperty('n'); expect(body).not.toHaveProperty('candidateCount')
  })
  it.each([
    ['invalid base64', image('invalid!!')], ['non-image bytes', image(Buffer.from('plain text').toString('base64'))],
    ['MIME mismatch', image(png.toString('base64'), 'image/jpeg')], ['URL-only output', { type: 'image', uri: 'https://image.invalid/file.png' }],
    ['over-size decoded bytes', image(Buffer.concat([png, Buffer.alloc(100000)]).toString('base64'))],
  ])('rejects %s and makes no media URL request or paid retry', async (_name, content) => {
    const fetch = vi.fn(async () => Response.json(generateContentResponse([content]))); vi.stubGlobal('fetch', fetch)
    const { instance, snapshot } = await provider()
    await expect(instance.submit(snapshot, 'private')).rejects.toMatchObject({ definitive: false })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('ignores thought images, rejects text-only success, and maps explicit provider failure', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json(generateContentResponse([{ type: 'text', text: 'cannot generate' }])))
      .mockResolvedValueOnce(Response.json({ promptFeedback: { blockReason: 'SAFETY' } }))
    vi.stubGlobal('fetch', fetch)
    const { instance, snapshot } = await provider()
    await expect(instance.submit(snapshot, 'private')).rejects.toMatchObject({ definitive: false })
    expect(await instance.submit(snapshot, 'private')).toMatchObject({ status: 'failed', errorCode: 'EXTERNAL_FAILED' })
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it('rejects unknown/incomplete states and oversized JSON as ambiguous results without retry', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [] } }] }))
      .mockResolvedValueOnce(Response.json(response()))
      .mockResolvedValueOnce(Response.json({ extra: 'x'.repeat(1200000) }))
    vi.stubGlobal('fetch', fetch)
    const { instance, snapshot } = await provider()
    for (let i = 0; i < 3; i++) await expect(instance.submit(snapshot, 'private')).rejects.toMatchObject({ definitive: false })
    expect(fetch).toHaveBeenCalledTimes(3)
  })
  it('reads snake_case inline images while skipping thoughts, text and alternative candidates', async () => {
    const fetch = vi.fn(async () => Response.json({ candidates: [
      { finish_reason: 'STOP', content: { parts: [
        { thought: true, inline_data: { mime_type: 'image/png', data: png.toString('base64') } },
        { text: 'final image' }, { inline_data: { mime_type: 'image/png', data: png.toString('base64') } },
      ] } },
      { finishReason: 'STOP', content: { parts: [{ inlineData: { mimeType: 'image/png', data: png.toString('base64') } }] } },
    ] }))
    vi.stubGlobal('fetch', fetch)
    const { instance, snapshot } = await provider(4)
    expect((await instance.submit(snapshot, 'private')).outputs).toHaveLength(1)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it.each(['IMAGE_SAFETY', 'NO_IMAGE'])('maps explicit %s finish reasons to failed without another request', async (finishReason) => {
    const fetch = vi.fn(async () => Response.json({ candidates: [{ finishReason, content: { parts: [] } }] }))
    vi.stubGlobal('fetch', fetch)
    const { instance, snapshot } = await provider(4)
    expect(await instance.submit(snapshot, 'private')).toMatchObject({ status: 'failed', errorCode: 'EXTERNAL_FAILED' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('rejects missing candidates, thought-only images and unknown finish reasons without a protocol fallback', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ candidates: [] }))
      .mockResolvedValueOnce(Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [
        { thought: true, inlineData: { mimeType: 'image/png', data: png.toString('base64') } },
      ] } }] }))
      .mockResolvedValueOnce(Response.json({ candidates: [{ finishReason: 'OTHER' }] }))
    vi.stubGlobal('fetch', fetch)
    const { instance, snapshot } = await provider(4)
    for (let i = 0; i < 3; i++) await expect(instance.submit(snapshot, 'private')).rejects.toMatchObject({ definitive: false })
    expect(fetch).toHaveBeenCalledTimes(3)
  })
  it('keeps Google Interactions status/error parsing and never switches it to generateContent', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ status: 'cancelled', errors: [{ message: 'cancelled by provider' }] }))
      .mockResolvedValueOnce(Response.json({ status: 'incomplete', steps: [] }))
    vi.stubGlobal('fetch', fetch)
    const { instance, snapshot } = await provider(1)
    expect(await instance.submit(snapshot, 'private')).toMatchObject({ status: 'failed', error: 'cancelled by provider' })
    await expect(instance.submit(snapshot, 'private')).rejects.toMatchObject({ definitive: false })
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(Array(2).fill('https://generativelanguage.googleapis.com/v1beta/interactions'))
  })
})

describe('Nano Banana durable canvas tasks', () => {
  it.each(['jpeg', 'webp'] as const)('saves actual %s dimensions and MIME from base64 rather than the requested nominal preset', async (format) => {
    const { default: sharp } = await import('sharp')
    const bytes = await sharp({ create: { width: 24, height: 16, channels: 3, background: '#789abc' } }).toFormat(format).toBuffer()
    const fetch = vi.fn(async () => Response.json(generateContentResponse([image(bytes.toString('base64'), `image/${format}`)])))
    vi.stubGlobal('fetch', fetch)
    const instance = await service(), node = await generator(instance)
    const accepted = await instance.generate('w', node.id, 1)
    const finished = await wait(instance, accepted.id, 'completed')
    expect(instance.store.state('w').assets[0]).toMatchObject({ width: 24, height: 16, mime: `image/${format}` })
    expect(await instance.store.readMedia(finished.resultIds[0], 1024)).toEqual(bytes)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('saves a base64 image to OSS, preserves dimensions and old schema, and keeps the accepted Google key after rotation', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const fetch = vi.fn(async () => { await gate; return Response.json(response()) }); vi.stubGlobal('fetch', fetch)
    const instance = await service(), node = await generator(instance, 1)
    const ddl = await instance.store.db.all('SELECT sql FROM sqlite_master ORDER BY name')
    const requestId = randomUUID(), accepted = await instance.generate('w', node.id, 1, requestId)
    await instance.store.saveModel({ ...models[1], api_key: 'rotated' })
    expect((await instance.generate('w', node.id, 1, requestId)).id).toBe(accepted.id)
    release()
    const task = await wait(instance, accepted.id, 'completed')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(new Headers((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].headers).get('x-goog-api-key')).toBe('banana-secret-1')
    expect(await instance.store.readMedia(task.resultIds[0], 1024)).toEqual(png)
    expect(instance.store.state('w').assets[0]).toMatchObject({ mime: 'image/png', width: 1, height: 1 })
    expect((await instance.store.locator('w', task.resultIds[0])).objectKey).toBeTruthy()
    expect(await instance.store.db.all('SELECT sql FROM sqlite_master ORDER BY name')).toEqual(ddl)
    expect(JSON.stringify(instance.store.listModels())).not.toMatch(/banana-secret|rotated/)
  })
  it('retains staged bytes on OSS publication failure and resumes the same output after restart without generating again', async () => {
    const fetch = vi.fn(async () => Response.json(generateContentResponse())); vi.stubGlobal('fetch', fetch)
    const instance = await service(), node = await generator(instance)
    instance.store.saveMedia = async (source) => { source.destroy(); throw new Error('OSS unavailable') }
    const accepted = await instance.generate('w', node.id, 1)
    await wait(instance, accepted.id, 'save_failed')
    const outputs = (await instance.store.taskPrivate(accepted.id)).outputs!
    expect(outputs[0].base64).toBeUndefined(); expect(outputs[0].stageFile).toBeTruthy()
    expect(await readFile(instance.store.stagePath(outputs[0].stageFile!))).toEqual(png)
    await instance.close()
    const reopened = await service(instance.config.dataDir)
    await reopened.taskAction('w', accepted.id, 'retry-save')
    const finished = await wait(reopened, accepted.id, 'completed')
    expect(finished.resultIds).toEqual([outputs[0].id]); expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('keeps channel keys separate and blocks cleared/unconfigured keys before creating a task', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    const instance = await service(), node = await generator(instance)
    await instance.store.saveModel({ ...models[1], api_key: 'google-only' })
    await instance.store.saveModel({ ...models[0], api_key: '' })
    expect(instance.store.model(models[1].id).key).toBe('google-only')
    await expect(instance.generate('w', node.id, 1)).rejects.toMatchObject({ code: 'MODEL_NOT_CONFIGURED' })
    expect(instance.store.state('w').tasks).toEqual([]); expect(fetch).not.toHaveBeenCalled()
  })
  it.each([401, 500])('maps HTTP %s safely without leaking the auth key or automatically repeating a request', async (status) => {
    const fetch = vi.fn(async () => Response.json({ error: { message: 'request failed banana-secret-0' } }, { status })); vi.stubGlobal('fetch', fetch)
    const instance = await service(), node = await generator(instance)
    const accepted = await instance.generate('w', node.id, 1)
    const task = await wait(instance, accepted.id, status === 401 ? 'failed' : 'unknown')
    expect(task.error).not.toContain('banana-secret-0'); expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('preserves a definitively failed gateway task after restart instead of submitting it with the new endpoint', async () => {
    const fetch = vi.fn(async () => Response.json({ error: { message: 'Invalid URL (POST /v1beta/interactions)' } }, { status: 404 }))
    vi.stubGlobal('fetch', fetch)
    const original = await service(), node = await generator(original, 4)
    const accepted = await original.generate('w', node.id, 1)
    const failed = await wait(original, accepted.id, 'failed')
    await original.close()
    const reopened = await service(original.config.dataDir)
    expect(reopened.store.state('w').tasks.find((task) => task.id === accepted.id)).toEqual(failed)
    expect(reopened.runtime.isActive(accepted.id)).toBe(false)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
