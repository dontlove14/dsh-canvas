import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CanvasService } from '../src/host/service'
import { fakeFactory, initialize } from './support/objectStorage'
import { Providers } from '../src/host/providers'
import { BUILTIN_MODELS, GPT_IMAGE_SIZES, validGptImageSize } from '../src/shared/modelCatalog'
import { capabilitiesFor, defaultParams, emptyGraph, validateGeneration, type CanvasNode, type TaskSnapshot, type TaskStatus } from '../src/shared/contracts'
import { sizeChoices, chooseResolution } from '../src/client/generationParams'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZAAAAABJRU5ErkJggg==', 'base64')
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); vi.unstubAllGlobals() })
async function service(root?: string) {
  if (!root) { root = await mkdtemp(join(tmpdir(), 'canvas-images-')); const dir = root; cleanup.push(() => rm(dir, { recursive: true, force: true })) }
  const instance = new CanvasService({ dataDir: root, maxConcurrentTasks: 2, pollIntervalMs: 25, requestTimeoutMs: 3000, maxMediaBytes: 100000, maxReferenceBytes: 10000 }, undefined, fakeFactory(root))
  await initialize(instance, true); cleanup.push(() => instance.close()); return instance
}
async function generator(instance: CanvasService, index = 0, n = 1) {
  const definition = BUILTIN_MODELS[index]
  await instance.store.saveModel({ ...definition, api_key: `key-${index}` })
  const node: CanvasNode = { id: randomUUID(), kind: 'image-generation', title: '生成', position: { x: 0, y: 0 },
    modelId: definition.id, params: { ...defaultParams(definition), n }, prompt: 'a tree', assetId: null, selectedResultId: null }
  await instance.saveGraph('w', { ...emptyGraph(), nodes: [node] }, 0)
  return node
}
async function wait(instance: CanvasService, id: string, status: TaskStatus) {
  for (let i = 0; i < 400; i++) {
    const task = instance.store.state('w').tasks.find((task) => task.id === id)!
    if (task.status === status && !instance.runtime.isActive(id)) return task
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`Expected ${status}: ${JSON.stringify(instance.store.state('w').tasks.map((t) => ({ status: t.status, error: t.error })))}`)
}
describe('fixed image catalog and dimensions', () => {
  it('offers model-first channels, independent secrets and rejects custom or changed identities', async () => {
    const instance = await service()
    expect(instance.store.listModels().map((m) => [m.model_id, m.api_base, m.has_api_key])).toEqual(BUILTIN_MODELS.map((m) => [m.model_id, m.api_base, false]))
    await instance.store.saveModel({ ...BUILTIN_MODELS[0], api_key: 'link-secret' })
    await instance.store.saveModel({ ...BUILTIN_MODELS[1], api_key: 'official-secret' })
    await instance.store.saveModel({ ...BUILTIN_MODELS[0] })
    expect(instance.store.model(BUILTIN_MODELS[0].id).key).toBe('link-secret')
    expect(instance.store.model(BUILTIN_MODELS[1].id).key).toBe('official-secret')
    expect(instance.store.listModels()[2].has_api_key).toBe(false)
    for (const input of [
      { ...BUILTIN_MODELS[0], api_base: 'https://custom.example/v1' },
      { ...BUILTIN_MODELS[0], model_id: 'made-up-model' },
      { ...BUILTIN_MODELS[1], id: BUILTIN_MODELS[0].id },
    ]) await expect(instance.store.saveModel(input)).rejects.toThrow()
    const invalid = await instance.handle(new Request('http://localhost/api/canvas/v2/models', { method: 'POST',
      body: JSON.stringify({ ...BUILTIN_MODELS[0], api_base: 'http://localhost/v1', api_key: 'new-private-key' }) }))
    expect(invalid.status).toBe(400); expect(await invalid.text()).not.toContain('new-private-key')
    expect(JSON.stringify(instance.store.listModels())).not.toMatch(/link-secret|official-secret/)
    await instance.store.saveModel({ ...BUILTIN_MODELS[0], api_key: '' })
    expect(instance.store.listModels()[0].has_api_key).toBe(false)
    expect(instance.store.model(BUILTIN_MODELS[1].id).key).toBe('official-secret')
  })
  it('offers legal wide 1K presets while preserving existing sizes and model limits', () => {
    expect(GPT_IMAGE_SIZES).toHaveLength(23)
    expect(GPT_IMAGE_SIZES.every((p) => validGptImageSize(p.width, p.height))).toBe(true)
    expect(GPT_IMAGE_SIZES.filter((p) => p.resolution === '4K').map((p) => [p.ratio, p.size])).toEqual([
      ['16:9', '3840x2160'], ['9:16', '2160x3840'], ['21:9', '3840x1648'],
    ])
    expect(GPT_IMAGE_SIZES.filter((p) => p.resolution === '1K' && ['16:9', '9:16', '21:9'].includes(p.ratio)).map((p) => [p.ratio, p.size])).toEqual([
      ['16:9', '1280x720'], ['9:16', '720x1280'], ['21:9', '1344x576'],
    ])
    expect(validGptImageSize(4096, 4096)).toBe(false)
    expect(validGptImageSize(1024, 576)).toBe(false)
    expect(validGptImageSize(3840, 2176)).toBe(false)
    const model = { ...BUILTIN_MODELS[0], has_api_key: true, api_key_mask: '', capabilities: { ...defaultCapabilities() } }
    const choices = sizeChoices(model)
    expect(choices.find((c) => c.size === '1024x688')?.ratio).toBe('3:2')
    expect(chooseResolution(choices, '2048x1152', '4K')).toBe('3840x2160')
    expect(chooseResolution(choices, '2048x1152', '1K')).toBe('1280x720')
    expect(chooseResolution(choices, '1152x2048', '1K')).toBe('720x1280')
    expect(choices.find((c) => c.size === '2048x880')?.ratio).toBe('21:9')
    expect(chooseResolution(choices, '2048x880', '1K')).toBe('1344x576')
    expect(chooseResolution(choices, '2048x2048', '4K')).toBe('3840x2160')
    expect(GPT_IMAGE_SIZES.some((p) => ['9:25', '25:9'].includes(p.ratio))).toBe(false)
    expect(() => validateGeneration({ model: BUILTIN_MODELS[0], prompt: 'x', params: { size: '4096x4096', n: 1 }, referenceIds: [] }, [])).toThrow('尺寸')
  })
})
function defaultCapabilities() { return capabilitiesFor(BUILTIN_MODELS[0]) }
describe('GPT Image 2.5 requests and durable outcomes', () => {
  it.each([0, 1, 2, 3])('passes all wide 1K dimensions unchanged to image generation and editing on channel %s', async (index) => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ data: [{ b64_json: png.toString('base64') }] })); vi.stubGlobal('fetch', fetch)
    const root = await mkdtemp(join(tmpdir(), 'canvas-wide-images-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const config = { dataDir: root, maxConcurrentTasks: 1, pollIntervalMs: 25, requestTimeoutMs: 3000, maxMediaBytes: 100000, maxReferenceBytes: 10000 }
    const provider = new Providers({ readMedia: async () => png, stagePath: (name) => join(root, name) }, config, new AbortController().signal)
    const model = BUILTIN_MODELS[index], referenceId = randomUUID()
    for (const size of ['1280x720', '720x1280', '1344x576']) {
      const snapshot: TaskSnapshot = { model, prompt: 'wide composition', params: { ...defaultParams(model), size }, referenceIds: [] }
      expect(() => validateGeneration(snapshot, [])).not.toThrow()
      await provider.submit(snapshot, 'wide-key')
      const [url, init] = fetch.mock.calls.at(-1)!
      expect(url).toBe(`${model.api_base}/images/generations`)
      expect(JSON.parse(init.body as string).size).toBe(size)
      await provider.submit({ ...snapshot, referenceIds: [referenceId] }, 'wide-key')
      const [editUrl, editInit] = fetch.mock.calls.at(-1)!
      expect(editUrl).toBe(`${model.api_base}/images/edits`)
      expect((editInit.body as FormData).get('size')).toBe(size)
      expect((editInit.body as FormData).getAll('image[]')).toHaveLength(1)
      expect(new Headers(editInit.headers).get('authorization')).toBe('Bearer wide-key')
    }
    expect(fetch).toHaveBeenCalledTimes(6)
  })
  it.each([0, 1, 2, 3])('uses exact JSON and Bearer on channel %s without excluded fields', async (index) => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ data: [{ b64_json: png.toString('base64') }] })); vi.stubGlobal('fetch', fetch)
    const instance = await service(), node = await generator(instance, index)
    await instance.saveGraph('w', { ...instance.store.state('w').graph, nodes: [{ ...node, params: { size: '2048x1152', n: 1, quality: 'max', background: 'transparent' } }] }, 1)
    const task = await instance.generate('w', node.id, 2)
    await wait(instance, task.id, 'completed')
    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe(`${BUILTIN_MODELS[index].api_base}/images/generations`)
    expect(init.headers).toEqual({ 'Content-Type': 'application/json', Authorization: `Bearer key-${index}` })
    expect(JSON.parse(init.body as string)).toEqual({ model: BUILTIN_MODELS[index].model_id, prompt: 'a tree', size: '2048x1152', n: 1, quality: 'max', background: 'transparent', output_format: 'png' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it.each([0, 1])('sends all sixteen ordered references as multipart on provider %s', async (index) => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ data: [{ b64_json: png.toString('base64') }] })); vi.stubGlobal('fetch', fetch)
    const instance = await service()
    const references = Array.from({ length: 16 }, () => randomUUID())
    const paths = new Map<string, string>()
    const { writeFile } = await import('node:fs/promises')
    for (const id of references) {
      const path = join(instance.config.dataDir, `${id}.png`); await writeFile(path, png); paths.set(id, path)
    }
    const provider = new Providers({ readMedia: (id) => readFile(paths.get(id)!), stagePath: (name) => join(instance.config.dataDir, name) }, instance.config, new AbortController().signal)
    const snapshot: TaskSnapshot = { model: BUILTIN_MODELS[index], prompt: 'edit', params: defaultParams(BUILTIN_MODELS[index]), referenceIds: references }
    await provider.submit(snapshot, 'reference-key')
    const [url, init] = fetch.mock.calls[0]; const form = init.body as FormData
    expect(url).toBe(`${BUILTIN_MODELS[index].api_base}/images/edits`)
    expect(form.getAll('image[]').map((file) => (file as File).name)).toEqual(references.map((id) => `${id}.png`))
    expect([...form.keys()].filter((key) => key !== 'image[]')).toEqual(['model', 'prompt', 'size', 'n', 'output_format', 'background', 'quality'])
    expect(form.get('output_format')).toBe('png'); expect(form.get('background')).toBe('auto'); expect(form.get('quality')).toBe('auto')
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer reference-key')
    const assets = references.map((id) => ({ id, kind: 'image' as const, mime: 'image/png', filename: 'r.png', bytes: png.length, createdAt: 1, nodeId: null, taskId: null }))
    expect(() => validateGeneration(snapshot, assets)).not.toThrow()
    expect(() => validateGeneration({ ...snapshot, referenceIds: [...references, randomUUID()] }, assets)).toThrow('16')
  })
  it('retains successful partial results, records failure and does not repeat the batch after restart', async () => {
    const fetch = vi.fn(async () => Response.json({ data: [{ b64_json: png.toString('base64') }, { b64_json: 'invalid' }, { b64_json: png.toString('base64') }] })); vi.stubGlobal('fetch', fetch)
    const instance = await service(), node = await generator(instance, 0, 3)
    const task = await instance.generate('w', node.id, 1), finished = await wait(instance, task.id, 'failed')
    expect(finished.resultIds).toHaveLength(2); expect(finished.error).toContain('部分失败')
    expect(await instance.store.taskDetail('w', task.id)).toMatchObject({ failureCode: 'PARTIAL_RESULT' })
    const state = instance.store.state('w')
    expect(state.graph.edges).toEqual([]); expect(state.graph.nodes[0].selectedResultId).toBeNull()
    await instance.close()
    const reopened = await service(instance.config.dataDir)
    expect(reopened.store.state('w').tasks[0].resultIds).toEqual(finished.resultIds)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('saves other outputs even when one publication fails, then retries only the original outputs', async () => {
    const fetch = vi.fn(async () => Response.json({ data: Array.from({ length: 3 }, () => ({ b64_json: png.toString('base64') })) })); vi.stubGlobal('fetch', fetch)
    const instance = await service(), node = await generator(instance, 0, 3)
    const save = instance.store.saveMedia.bind(instance.store)
    let calls = 0
    instance.store.saveMedia = async (...args) => { if (++calls === 2) { args[0].destroy(); throw new Error('disk unavailable') } return save(...args) }
    const task = await instance.generate('w', node.id, 1), failed = await wait(instance, task.id, 'save_failed')
    expect(failed.resultIds).toHaveLength(2)
    const outputIds = (await instance.store.taskPrivate(task.id)).outputs!.map((item) => item.id)
    instance.store.saveMedia = save
    await instance.taskAction('w', task.id, 'retry-save')
    const finished = await wait(instance, task.id, 'completed')
    expect(new Set(finished.resultIds)).toEqual(new Set(outputIds)); expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('continues after caller abort and pins the accepted provider/key while configurations change', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => { await gate; return Response.json({ data: [{ b64_json: png.toString('base64') }] }) }); vi.stubGlobal('fetch', fetch)
    const instance = await service(), node = await generator(instance)
    const controller = new AbortController(), requestId = randomUUID()
    const req = new Request('http://localhost/api/canvas/v2/generate?canvas=w', { method: 'POST', signal: controller.signal, body: JSON.stringify({ nodeId: node.id, revision: 1, requestId }) })
    const response = await instance.handle(req); expect(response.status).toBe(202)
    const accepted = await response.json(); controller.abort()
    await instance.store.saveModel({ ...BUILTIN_MODELS[0], api_key: 'rotated-key' })
    expect((await instance.generate('w', node.id, 1, requestId)).id).toBe(accepted.id)
    release(); await wait(instance, accepted.id, 'completed')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(new Headers(fetch.mock.calls[0][1].headers).get('authorization')).toBe('Bearer key-0')
    expect(fetch.mock.calls[0][1].signal?.aborted).toBe(false)
    expect(await instance.store.readMedia(instance.store.state('w').tasks[0].resultIds[0], 1024)).toEqual(png)
  })
  it('refuses unconfigured keys before accepting a task and keeps the database schema unchanged', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    const instance = await service()
    const ddl = await instance.store.db.all('SELECT sql FROM sqlite_master ORDER BY name')
    const node = await generator(instance)
    await instance.store.saveModel({ ...BUILTIN_MODELS[0], api_key: '' })
    await expect(instance.generate('w', node.id, 1)).rejects.toMatchObject({ code: 'MODEL_NOT_CONFIGURED' })
    expect(instance.store.state('w').tasks).toEqual([]); expect(fetch).not.toHaveBeenCalled()
    expect(await instance.store.db.all('SELECT sql FROM sqlite_master ORDER BY name')).toEqual(ddl)
  })
})
