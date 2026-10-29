import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { Providers } from '../src/host/providers'
import { CanvasService } from '../src/host/service'
import { BUILTIN_MODELS, SEEDREAM_MODELS, providerFor, seedreamRequiresEndpoint, seedreamSizePresets } from '../src/shared/modelCatalog'
import { capabilitiesFor, defaultParams, emptyGraph, ModelInputSchema, validateGeneration, type CanvasNode, type Task, type TaskSnapshot, type TaskStatus } from '../src/shared/contracts'
import { fakeFactory, initialize } from './support/objectStorage'

const models = BUILTIN_MODELS.filter((model) => model.protocol === 'seedream-image')
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function bytes(format: 'png' | 'jpeg' | 'webp' = 'png', width = 32, height = 24) {
  return sharp({ create: { width, height, channels: 3, background: '#678abc' } }).toFormat(format).toBuffer()
}
function snapshot(index = 0): TaskSnapshot {
  const model = models[index]
  return { model: { ...model, ...(seedreamRequiresEndpoint(model) ? { endpoint_id: `ep-channel-${index}` } : {}) },
    params: defaultParams(model), prompt: '画一棵树', referenceIds: [] }
}
async function provider(index = 0, reference?: Buffer) {
  const root = await mkdtemp(join(tmpdir(), 'seedream-provider-')); cleanup.push(() => rm(root, { recursive: true, force: true }))
  reference ??= await bytes()
  const read = vi.fn(async () => reference)
  const instance = new Providers({ readMedia: read, stagePath: (name) => join(root, name) },
    { requestTimeoutMs: 2000, maxMediaBytes: 100000, maxReferenceBytes: 20000 }, new AbortController().signal)
  return { instance, input: snapshot(index), read }
}
async function service(root?: string) {
  if (!root) { root = await mkdtemp(join(tmpdir(), 'seedream-service-')); const path = root; cleanup.push(() => rm(path, { recursive: true, force: true })) }
  const instance = new CanvasService({ dataDir: root, maxConcurrentTasks: 1, pollIntervalMs: 25, requestTimeoutMs: 1000,
    maxMediaBytes: 100000, maxReferenceBytes: 20000 }, undefined, fakeFactory(root))
  await initialize(instance, true); cleanup.push(() => instance.close()); return instance
}
async function generator(instance: CanvasService, index = 1) {
  const input = snapshot(index)
  await instance.store.saveModel({ ...input.model, api_key: `channel-key-${index}` })
  const node: CanvasNode = { id: randomUUID(), kind: 'image-generation', title: input.model.name, position: { x: 0, y: 0 },
    modelId: input.model.id, prompt: input.prompt, params: input.params, assetId: null, selectedResultId: null }
  await instance.saveGraph('w', { ...emptyGraph(), nodes: [node] }, 0); return node
}
async function wait(instance: CanvasService, id: string, status: TaskStatus) {
  for (let i = 0; i < 400; i++) {
    const task = instance.store.state('w').tasks.find((item) => item.id === id)!
    if (task.status === status && !instance.runtime.isActive(id)) return task
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Expected ${status}; got ${instance.store.state('w').tasks.find((item) => item.id === id)?.status}`)
}

describe('Seedream identities and independent configuration', () => {
  it('adds six exact combinations, preserves all twelve previous UUIDs and keeps Dola on BytePlus only', () => {
    expect(models).toHaveLength(6)
    expect(models.map((model) => [model.model_id, model.name, providerFor(model)?.id])).toEqual(SEEDREAM_MODELS.flatMap((model, index) =>
      (index < 2 ? ['model-link', 'bytedance'] : ['byteplus']).map((provider) => [model.id, model.name, provider])))
    expect(BUILTIN_MODELS.slice(0, 12).map((model) => model.id)).toEqual(Array.from({ length: 12 }, (_, i) =>
      `00000000-0000-4000-b000-${(i + 1).toString(16).padStart(12, '0')}`))
    expect(new Set(BUILTIN_MODELS.map((model) => model.id)).size).toBe(30)
    expect(SEEDREAM_MODELS.map((model) => model.id)).toEqual([
      'doubao-seedream-5-0-260128', 'doubao-seedream-5-0-pro-260628',
      'dola-seedream-5-0-260128', 'dola-seedream-5-0-pro-260628',
    ])
  })
  it('corrects shipped Lite IDs on disk once, preserving UUIDs, keys, EP, graph, snapshots and schema', async () => {
    const instance = await service()
    for (const index of [0, 1, 4]) await instance.store.saveModel({ ...snapshot(index).model, api_key: `channel-key-${index}` })
    const root = instance.config.dataDir
    const ddl = await instance.store.db.all('SELECT sql FROM sqlite_master ORDER BY name')
    const bindings = await readFile(join(root, 'model-bindings.json'), 'utf8')
    const config = JSON.parse(await readFile(join(root, 'models.json'), 'utf8'))
    const old = config.map((model: any) => ({ ...model, model_id: model.model_id.startsWith('dola-') ? 'dola-seedream-5-0-lite-260628' : 'doubao-seedream-5-0-lite-260628' }))
    const custom = { ...old[0], id: randomUUID(), name: 'Retained custom model' }
    const historical: Task = { id: randomUUID(), workspaceId: 'w', nodeId: randomUUID(),
      snapshot: { ...snapshot(0), model: old[0] }, status: 'failed', resultIds: [], createdAt: Date.now(), updatedAt: Date.now(), error: 'Original rejection' }
    await instance.store.update('w', (state) => { state.tasks.push(historical) })
    await instance.store.writeTaskPrivate(historical.id, { key: 'channel-key-0', issued: true })
    const committed = instance.store.state('w')
    const catalog = await instance.store.db.all('SELECT * FROM task_catalog ORDER BY queue_seq')
    committed.tasks[0].updatedAt = catalog[0].updated_at
    const details = await instance.store.db.all('SELECT * FROM task_details ORDER BY task_id')
    await instance.close()
    await writeFile(join(root, 'models.json'), JSON.stringify([...old, custom]), { mode: 0o600 })
    const reopened = await service(root)
    expect(JSON.parse(await readFile(join(root, 'models.json'), 'utf8'))).toEqual([...config, custom])
    for (const index of [0, 1, 4]) {
      expect(reopened.store.model(models[index].id).key).toBe(`channel-key-${index}`)
      expect(reopened.store.model(models[index].id).model).toEqual(snapshot(index).model)
    }
    // The custom record obtains its own binding; every prior binding remains intact.
    expect(JSON.parse(await readFile(join(root, 'model-bindings.json'), 'utf8'))).toMatchObject(JSON.parse(bindings))
    expect(await reopened.store.db.all('SELECT sql FROM sqlite_master ORDER BY name')).toEqual(ddl)
    expect(reopened.store.state('w')).toEqual(committed)
    expect(capabilitiesFor(committed.tasks[0].snapshot.model)).toEqual(capabilitiesFor(models[0]))
    expect(await reopened.store.db.all('SELECT * FROM task_catalog ORDER BY queue_seq')).toEqual(catalog)
    expect(await reopened.store.db.all('SELECT * FROM task_details ORDER BY task_id')).toEqual(details)
    expect(await reopened.store.taskPrivate(historical.id)).toMatchObject({ key: 'channel-key-0', issued: true })
    const first = await readFile(join(root, 'models.json'), 'utf8')
    await reopened.close()
    const twice = await service(root)
    expect(await readFile(join(root, 'models.json'), 'utf8')).toBe(first)
    expect(twice.store.state('w')).toEqual(committed)
  })
  it.each(SEEDREAM_MODELS)('exposes only supported $name sizes, references and single output', (model) => {
    const definition = models.find((item) => item.model_id === model.id)!, pro = model.id.includes('-pro-')
    const caps = capabilitiesFor(definition), presets = seedreamSizePresets(model.id)
    expect(defaultParams(definition)).toEqual({ size: '2048x2048', n: 1 })
    expect(presets).toHaveLength(24)
    expect([...new Set(presets.map((preset) => preset.resolution))]).toEqual(pro ? ['1K', '1.5K', '2K'] : ['2K', '3K', '4K'])
    for (const preset of presets) {
      expect(preset.width * preset.height).toBeGreaterThanOrEqual(pro ? 921600 : 3686400)
      expect(preset.width * preset.height).toBeLessThanOrEqual(pro ? 4624220 : 16777216)
    }
    expect(caps.counts).toEqual([1]); expect(caps.maxReferences).toBe(pro ? 10 : 14)
    for (const params of [{ size: '1024x768', n: 1 }, { size: '2048x2048', n: 2 }, { size: '2048x2048', n: 1, background: 'auto' as const }])
      expect(() => validateGeneration({ model: definition, params, prompt: 'x', referenceIds: [] }, [])).toThrow()
  })
  it('requires official EP before credential changes, rejects crossed channels and isolates all six keys', async () => {
    const instance = await service(), put = vi.spyOn(instance.store.vault, 'put')
    await expect(instance.store.saveModel({ ...models[1], api_key: 'bad-key' })).rejects.toMatchObject({ code: 'MODEL_NOT_CONFIGURED' })
    expect(put).not.toHaveBeenCalled()
    for (const index of [1, 3, 4, 5]) expect(ModelInputSchema.safeParse({ ...models[index], endpoint_id: 'not-ep' }).success).toBe(false)
    for (let index = 0; index < models.length; index++) await instance.store.saveModel({ ...snapshot(index).model, api_key: `key-${index}` })
    await expect(instance.store.saveModel({ ...models[0], endpoint_id: 'ep-wrong', api_key: 'overwrite' })).rejects.toThrow('Model ID')
    await expect(instance.store.saveModel({ ...models[0], api_base: models[4].api_base, api_key: 'overwrite' })).rejects.toMatchObject({ code: 'MODEL_NOT_SUPPORTED' })
    await expect(instance.store.saveModel({ ...models[4], api_base: models[1].api_base, api_key: 'overwrite' })).rejects.toMatchObject({ code: 'MODEL_NOT_SUPPORTED' })
    await instance.store.saveModel({ ...models[1] })
    expect(instance.store.model(models[1].id).model.endpoint_id).toBe('ep-channel-1')
    await instance.store.saveModel({ ...models[1], api_key: '' })
    expect(() => instance.store.model(models[1].id)).toThrow('配置模型')
    for (const index of [0, 2, 3, 4, 5]) expect(instance.store.model(models[index].id).key).toBe(`key-${index}`)
    expect(JSON.stringify(instance.store.listModels())).not.toMatch(/key-[0-5]|overwrite/)
  })
})

describe('Seedream native image protocol', () => {
  it.each(models.map((_, index) => index))('sends text and ordered image references using correct routing on channel %s', async (index) => {
    const png = await bytes(), fetch = vi.fn(async () => Response.json({ data: [{ b64_json: png.toString('base64') }] }))
    vi.stubGlobal('fetch', fetch)
    const { instance, input, read } = await provider(index, png)
    for (const count of [0, 1, input.model.model_id.includes('-pro-') ? 10 : 14]) {
      const ids = Array.from({ length: count }, () => randomUUID())
      const result = await instance.submit({ ...input, referenceIds: ids }, `private-${index}`)
      const [url, init] = fetch.mock.calls.at(-1)! as unknown as [string, RequestInit]
      expect(url).toBe(`${input.model.api_base}/images/generations`)
      expect(new Headers(init.headers).get('authorization')).toBe(`Bearer private-${index}`)
      const payload = JSON.parse(init.body as string)
      expect(payload).toEqual({ model: input.model.endpoint_id ?? input.model.model_id, prompt: input.prompt, size: '2048x2048',
        response_format: 'b64_json', output_format: 'png', ...(!input.model.model_id.includes('-pro-') ? { sequential_image_generation: 'disabled' } : {}),
        ...(count ? { image: count === 1 ? `data:image/png;base64,${png.toString('base64')}` : ids.map(() => `data:image/png;base64,${png.toString('base64')}`) } : {}) })
      expect(result.outputs![0]).toMatchObject({ mime: 'image/png', width: 32, height: 24 })
      if (count) expect(read.mock.calls.slice(-count).map(([id]) => id)).toEqual(ids)
    }
    expect(fetch).toHaveBeenCalledTimes(3)
  })
  it.each(['png', 'jpeg', 'webp'] as const)('keeps actual %s format, decoded dimensions and bytes', async (format) => {
    const data = await bytes(format), fetch = vi.fn(async () => Response.json({ data: [{ b64_json: data.toString('base64'), size: '999x999' }] }))
    vi.stubGlobal('fetch', fetch)
    const { instance, input } = await provider()
    const output = (await instance.submit(input, 'private')).outputs![0]
    expect(output).toMatchObject({ mime: `image/${format}`, width: 32, height: 24 })
    const chunks: Buffer[] = []
    for await (const chunk of await instance.outputStream(output, input, 'private')) chunks.push(Buffer.from(chunk))
    expect(Buffer.concat(chunks)).toEqual(data); expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('rejects invalid routing, parameters, reference counts and pixel dimensions before fetching', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    const { instance, input } = await provider(3, await bytes('png', 14, 20))
    for (const next of [
      { ...input, model: { ...input.model, endpoint_id: undefined } }, { ...input, params: { ...input.params, n: 2 } },
      { ...input, referenceIds: Array.from({ length: 11 }, () => randomUUID()) }, { ...input, referenceIds: [randomUUID()] },
    ]) await expect(instance.submit(next, 'private')).rejects.toMatchObject({ definitive: true })
    expect(fetch).not.toHaveBeenCalled()
  })
  it.each([{ data: [] }, { data: [{ b64_json: 'invalid!' }] }, { data: [{ b64_json: Buffer.from('text').toString('base64') }] },
    { data: [{ url: 'https://user:pass@invalid/image' }] }, { data: [{ url: 'file:///image.png' }] }])('keeps ambiguous %j results without retry', async (body) => {
    const fetch = vi.fn(async () => Response.json(body)); vi.stubGlobal('fetch', fetch)
    const { instance, input } = await provider()
    await expect(instance.submit(input, 'private')).rejects.toMatchObject({ definitive: false })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('downloads URL fallback without forwarding provider credentials', async () => {
    const png = await bytes(), fetch = vi.fn().mockResolvedValueOnce(Response.json({ data: [{ url: 'https://result.invalid/image.png' }] }))
      .mockResolvedValueOnce(new Response(new Uint8Array(png)))
    vi.stubGlobal('fetch', fetch)
    const { instance, input } = await provider()
    const result = await instance.submit(input, 'private')
    const stream = await instance.outputStream(result.outputs![0], input, 'private')
    for await (const _chunk of stream) {}
    expect(new Headers(fetch.mock.calls[1][1].headers).get('authorization')).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})

describe('Seedream durable tasks and OSS', () => {
  it('freezes accepted EP, logical identity and key through rotation and restart while preserving the DDL', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve }), png = await bytes()
    const fetch = vi.fn(async () => { await gate; return Response.json({ data: [{ b64_json: png.toString('base64') }] }) })
    vi.stubGlobal('fetch', fetch)
    const instance = await service(), node = await generator(instance)
    const ddl = await instance.store.db.all('SELECT sql FROM sqlite_master ORDER BY name'), requestId = randomUUID()
    const accepted = await instance.generate('w', node.id, 1, requestId)
    await instance.store.saveModel({ ...models[1], endpoint_id: 'ep-rotated', api_key: 'rotated-key' })
    expect((await instance.generate('w', node.id, 1, requestId)).id).toBe(accepted.id)
    release()
    const finished = await wait(instance, accepted.id, 'completed')
    const init = fetch.mock.calls[0][1] as RequestInit
    expect(JSON.parse(init.body as string).model).toBe('ep-channel-1')
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer channel-key-1')
    expect(finished.snapshot.model).toMatchObject({ model_id: models[1].model_id, name: models[1].name, endpoint_id: 'ep-channel-1' })
    expect(instance.store.state('w').assets[0]).toMatchObject({ mime: 'image/png', width: 32, height: 24 })
    expect(await instance.store.readMedia(finished.resultIds[0], 10000)).toEqual(png)
    expect(await instance.store.db.all('SELECT sql FROM sqlite_master ORDER BY name')).toEqual(ddl)
    await instance.close()
    const reopened = await service(instance.config.dataDir)
    expect(reopened.store.state('w').tasks[0]).toEqual(finished)
    expect(reopened.store.model(models[1].id).model.endpoint_id).toBe('ep-rotated')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('retries only the original OSS publication after restart, preserving result identity', async () => {
    const png = await bytes(), fetch = vi.fn(async () => Response.json({ data: [{ b64_json: png.toString('base64') }] }))
    vi.stubGlobal('fetch', fetch)
    const instance = await service(), node = await generator(instance, 4)
    instance.store.saveMedia = async (source) => { source.destroy(); throw new Error('OSS unavailable') }
    const accepted = await instance.generate('w', node.id, 1)
    await wait(instance, accepted.id, 'save_failed')
    const outputs = (await instance.store.taskPrivate(accepted.id)).outputs!
    expect(await readFile(instance.store.stagePath(outputs[0].stageFile!))).toEqual(png)
    await instance.close()
    const reopened = await service(instance.config.dataDir)
    await reopened.taskAction('w', accepted.id, 'retry-save')
    expect((await wait(reopened, accepted.id, 'completed')).resultIds).toEqual([outputs[0].id])
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it.each([401, 500, 200])('records HTTP %s errors safely without repeating a paid request', async (status) => {
    const fetch = vi.fn(async () => Response.json({ error: { message: 'provider rejected channel-key-1', code: 'Rejected' } }, { status }))
    vi.stubGlobal('fetch', fetch)
    const instance = await service(), node = await generator(instance)
    const task = await wait(instance, (await instance.generate('w', node.id, 1)).id, 'failed')
    expect(task.error).not.toContain('channel-key-1'); expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('preserves timed out submission identity and never automatically resubmits after restart', async () => {
    const fetch = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
    }))
    vi.stubGlobal('fetch', fetch)
    const instance = await service(), node = await generator(instance)
    const failed = await wait(instance, (await instance.generate('w', node.id, 1)).id, 'failed')
    await instance.close()
    const reopened = await service(instance.config.dataDir)
    expect(reopened.store.state('w').tasks[0]).toEqual(failed); expect(fetch).toHaveBeenCalledTimes(1)
  })
})
