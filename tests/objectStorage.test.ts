import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { DatabaseSync } from 'node:sqlite'
import { CanvasService } from '../src/host/service'
import { ObjectStorage } from '../src/host/object-storage/service'
import { AliyunStorage } from '../src/host/object-storage/aliyun'
import { StorageInputSchema, STORAGE_REQUIRED, type ObjectLocator } from '../src/shared/objectStorage'
import { emptyGraph, defaultParams, type CanvasNode } from '../src/shared/contracts'
import { BUILTIN_MODELS } from '../src/shared/modelCatalog'
import { fakeFactory, storageInput } from './support/objectStorage'
import type { StorageFactory } from '../src/host/object-storage/types'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZAAAAABJRU5ErkJggg==', 'base64')
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const dispose of cleanup.splice(0).reverse()) await dispose() })
async function fixture(wrap?: (factory: StorageFactory) => StorageFactory) {
  const root = await mkdtemp(join(tmpdir(), 'canvas-objects-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const factory = fakeFactory(root)
  const service = new CanvasService({ dataDir: root, maxConcurrentTasks: 1, pollIntervalMs: 25, requestTimeoutMs: 1000, maxMediaBytes: 100000, maxReferenceBytes: 10000 }, undefined, wrap ? wrap(factory) : factory)
  await service.store.init(); cleanup.push(() => service.close())
  return service
}
async function resource(service: CanvasService) {
  await service.store.ensureCanvas('w', '测试画布')
  const node: CanvasNode = { id: randomUUID(), kind: 'image-asset', title: '参考图', position: { x: 0, y: 0 }, modelId: null, params: null, prompt: '', assetId: null, selectedResultId: null }
  await service.store.update('w', (state) => state.graph.nodes.push(node))
  const asset = await service.store.saveMedia(Readable.from([png]), { id: randomUUID(), kind: 'image', filename: 'reference.png', nodeId: node.id, taskId: null, createdAt: Date.now() }, 10000, 'image')
  await service.store.update('w', (state) => { state.assets.push(asset); state.graph.nodes[0].assetId = asset.id })
  return { node, asset }
}
describe('object storage invariants', () => {
  it('starts unconfigured, guards direct canvas creation and refuses old schemas without deleting them', async () => {
    const service = await fixture()
    expect(await service.store.storage()).toMatchObject({ configured: false, activeProviderId: null, revision: 0, providers: [] })
    const denied = await service.handle(new Request('http://localhost/api/canvas/v2/catalog', { method: 'POST', body: JSON.stringify({ operation: 'canvas-create', requestId: randomUUID(), name: 'test' }) }))
    expect(denied.status).toBe(409); expect(await denied.json()).toEqual({ error: STORAGE_REQUIRED, code: 'STORAGE_NOT_CONFIGURED' })
    expect((await service.store.catalog()).canvases).toEqual([])
    expect(await readdir(service.config.dataDir)).not.toContain('media')
    await service.close()
    const db = new DatabaseSync(join(service.config.dataDir, 'canvas.sqlite')); db.exec('PRAGMA user_version=2'); db.close()
    await expect(new CanvasService(service.config).init()).rejects.toThrow('OSS 版本不自动导入')
    const unchanged = new DatabaseSync(join(service.config.dataDir, 'canvas.sqlite'))
    expect(unchanged.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 2 }); unchanged.close()
  })
  it('validates standard external endpoints and paths without disclosing newly entered credentials', async () => {
    const service = await fixture()
    expect(StorageInputSchema.safeParse({ ...storageInput(), endpoint: 'https://oss-cn-hangzhou-internal.aliyuncs.com' }).success).toBe(false)
    expect(StorageInputSchema.safeParse({ ...storageInput(), region: 'oss-cn-hangzhou-internal', endpoint: 'https://oss-cn-hangzhou-internal.aliyuncs.com' }).success).toBe(false)
    expect(StorageInputSchema.safeParse({ ...storageInput(), prefix: '../outside' }).success).toBe(false)
    const response = await service.handle(new Request('http://localhost/api/canvas/v2/storage', { method: 'POST', body: JSON.stringify({ ...storageInput(), endpoint: 'http://127.0.0.1', accessKeySecret: 'raw-new-secret' }) }))
    expect(response.status).toBe(400); expect(await response.text()).not.toContain('raw-new-secret')
  })
  it('probes outside the writer queue, keeps one active pointer and preserves the old configuration on failure/conflict', async () => {
    let fail = false
    const service = await fixture((factory) => (record, keys) => {
      const adapter = factory(record, keys)
      return { ...adapter, put: async (...args) => { if (fail) throw new Error('probe failed'); return adapter.put(...args) } }
    })
    const first = await service.store.setStorage(storageInput())
    const input = storageInput(1, 'second-bucket')
    const switched = await service.store.setStorage(input)
    expect(switched.providers.filter((p) => p.active)).toHaveLength(1)
    expect(switched.providers.find((p) => p.id === first.activeProviderId)?.active).toBe(false)
    expect(await service.store.setStorage(input)).toEqual(switched)
    fail = true
    await expect(service.store.setStorage(storageInput(2, 'third-bucket'))).rejects.toThrow('probe failed')
    expect((await service.store.storage()).activeProviderId).toBe(switched.activeProviderId)
    fail = false
    await expect(service.store.setStorage(storageInput(0, 'third-bucket'))).rejects.toMatchObject({ code: 'STORAGE_CONFLICT' })
    const publicBody = JSON.stringify(await service.store.storage())
    expect(publicBody).not.toContain('test-ak'); expect(publicBody).not.toContain('test-sk'); expect(publicBody).not.toContain('credentialRef')
  })
  it('pins uploads at acceptance and directs later uploads to the newly active provider', async () => {
    const service = await fixture()
    const first = await service.store.setStorage(storageInput())
    await service.store.ensureCanvas('w')
    const begin = () => service.runtime.uploads.start('w', { requestId: randomUUID(), filename: '参考.png', kind: 'image', position: { x: 0, y: 0 } })
    const old = await begin()
    const second = await service.store.setStorage(storageInput(1, 'second-bucket'))
    await service.runtime.uploads.accept('w', old.id, Readable.from([png]), 'image', '参考.png')
    await service.runtime.uploads.run()
    const newer = await begin(); await service.runtime.uploads.accept('w', newer.id, Readable.from([png]), 'image', '参考.png'); await service.runtime.uploads.run()
    const state = service.store.state('w')
    expect((await service.store.locator('w', state.assets[0].id)).providerId).toBe(first.activeProviderId)
    expect((await service.store.locator('w', state.assets[1].id)).providerId).toBe(second.activeProviderId)
    expect(await readdir(join(service.config.dataDir, 'staging'))).toEqual([])
    expect(await service.store.readMedia(state.assets[0].id, 10000)).toEqual(png)
    await service.store.update('w', (draft) => { draft.graph.nodes.find((n) => n.id === newer.nodeId)!.title = '新资源名称' })
    await service.store.runMoves()
    const renamed = await service.store.locator('w', state.assets[1].id)
    expect(renamed.providerId).toBe(second.activeProviderId); expect(renamed.objectKey).toContain('新资源名称__')
    expect(await service.store.readMedia(state.assets[1].id, 10000)).toEqual(png)
  })
  it('rotates historical reads and cached signatures while retaining the accepted output credential version', async () => {
    const keysUsed: string[] = []
    const service = await fixture((factory) => (record, keys) => {
      keysUsed.push(keys.accessKeyId)
      return factory(record, keys)
    })
    const first = await service.store.setStorage(storageInput())
    const { asset } = await resource(service)
    const locator = await service.store.locator('w', asset.id)
    const before = await service.store.objects.sign(locator, { method: 'GET', ttl: 3600 })
    const oldRecord = await service.store.storageRecord(first.activeProviderId!)
    await service.store.setStorage({ ...storageInput(1), id: first.activeProviderId!, accessKeyId: 'new-ak', accessKeySecret: 'new-sk' })
    const record = await service.store.storageRecord(first.activeProviderId!)
    expect(record.credentialRef).toBe(oldRecord.credentialRef)
    expect(record.readCredentialRef).not.toBe(oldRecord.credentialRef)
    const after = await service.store.objects.sign(locator, { method: 'GET', ttl: 3600 })
    expect(after.url).not.toBe(before.url)
    expect(await service.store.readMedia(asset.id, 10000)).toEqual(png)
    expect(keysUsed).toContain('new-ak')
    await service.store.objects.adapter(record.id, oldRecord.credentialRef)
    expect(JSON.parse(await service.store.vault.read(oldRecord.credentialRef)).accessKeyId).toBe('test-ak')
  })
  it('recovers a published object after database ACK failure without a second upload or key', async () => {
    let writes = 0
    const service = await fixture((factory) => (record, keys) => {
      const adapter = factory(record, keys)
      return { ...adapter, put: async (...args) => { if (!args[0].includes('/_probe/')) writes++; return adapter.put(...args) } }
    })
    await service.store.setStorage(storageInput()); await service.store.ensureCanvas('w')
    const session = await service.runtime.uploads.start('w', { requestId: randomUUID(), filename: '恢复.png', kind: 'image', position: { x: 0, y: 0 } })
    const accepted = await service.runtime.uploads.accept('w', session.id, Readable.from([png]), 'image', '恢复.png')
    const batch = service.store.db.batch.bind(service.store.db)
    const failure = vi.spyOn(service.store.db, 'batch').mockImplementation(async (...args) => {
      if (args[0].some((s) => s.sql.includes("SET file_state='ready'"))) { failure.mockRestore(); throw new Error('DB ACK failed') }
      return batch(...args)
    })
    await service.runtime.uploads.run()
    expect(await service.store.db.get('SELECT status FROM task_catalog WHERE id=?', [accepted.taskId])).toMatchObject({ status: 'save_failed' })
    await service.taskAction('w', accepted.taskId, 'retry-save')
    for (let i = 0; i < 100 && (await service.store.db.get('SELECT status FROM task_catalog WHERE id=?', [accepted.taskId])).status !== 'succeeded'; i++) {
      await service.runtime.uploads.run(); await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(writes).toBe(1); expect(service.store.state('w').assets).toHaveLength(1)
  })
  it('copies named folders/canvases while accepted task references keep their immutable old locator', async () => {
    const service = await fixture()
    await service.store.setStorage(storageInput())
    const { node, asset } = await resource(service)
    await service.store.saveModel({ ...BUILTIN_MODELS[0], api_key: 'model-key' })
    const generator: CanvasNode = { ...node, id: randomUUID(), kind: 'image-generation', title: '生成', modelId: BUILTIN_MODELS[0].id, params: defaultParams(BUILTIN_MODELS[0]), prompt: 'test', assetId: null }
    await service.store.update('w', (state) => { state.graph.nodes.push(generator); state.graph.edges.push({ id: randomUUID(), source: node.id, target: generator.id, assetId: asset.id }) })
    // Accept without running paid work.
    vi.spyOn(service.runtime, 'wake').mockImplementation(() => {})
    const task = await service.generate('w', generator.id, service.store.state('w').graphRevision)
    const old = await service.store.locator('w', asset.id)
    const folder = await service.store.catalogCommand({ operation: 'folder-create', requestId: randomUUID(), name: '产品素材' })
    await service.store.catalogCommand({ operation: 'canvas-move', requestId: randomUUID(), id: 'w', folderId: folder.id, revision: 0 })
    await service.store.runMoves()
    const moved = await service.store.locator('w', asset.id)
    expect(moved.objectKey).toContain(`产品素材__${folder.id}/测试画布__w/参考图__${asset.id}`)
    expect(moved.objectKey).not.toBe(old.objectKey)
    expect(JSON.parse((await service.store.db.get('SELECT locator_json FROM task_references WHERE task_id=?', [task.id])).locator_json)).toMatchObject(old)
    expect(await service.store.readMedia(asset.id, 10000, task.id)).toEqual(png)
    await service.store.catalogCommand({ operation: 'folder-rename', requestId: randomUUID(), id: folder.id, name: '新素材', revision: 0 })
    await service.store.runMoves()
    expect((await service.store.locator('w', asset.id)).objectKey).toContain('新素材__')
  })
  it('prepares references before issued and sends no paid request after preparation failure', async () => {
    const service = await fixture(); await service.store.setStorage(storageInput())
    await service.store.saveModel({ ...BUILTIN_MODELS[0], api_key: 'model-key' })
    const node: CanvasNode = { id: randomUUID(), kind: 'image-generation', title: '生成', position: { x: 0, y: 0 }, modelId: BUILTIN_MODELS[0].id, params: defaultParams(BUILTIN_MODELS[0]), prompt: 'test', assetId: null, selectedResultId: null }
    await service.saveGraph('w', { ...emptyGraph(), nodes: [node] }, 0)
    vi.spyOn((service.runtime as any).providers, 'prepare').mockRejectedValue(new Error('reference read failed'))
    const network = vi.fn(); vi.stubGlobal('fetch', network)
    await service.runtime.start()
    const task = await service.generate('w', node.id, 1)
    for (let i = 0; i < 100 && service.store.state('w').tasks[0].status !== 'failed'; i++) await new Promise((resolve) => setTimeout(resolve, 10))
    expect(await service.store.db.get('SELECT submit_issued FROM task_details WHERE task_id=?', [task.id])).toMatchObject({ submit_issued: 0 })
    expect(service.store.state('w').tasks[0].status).toBe('failed'); expect(network).not.toHaveBeenCalled()
  })
  it('retries only staged publication after an OSS outage, without submitting or downloading an expired result again', async () => {
    let unavailable = false
    const service = await fixture((factory) => (record, keys) => {
      const adapter = factory(record, keys)
      return { ...adapter, put: async (...args) => {
        if (unavailable && !args[0].includes('/_probe/')) throw new Error('OSS outage')
        return adapter.put(...args)
      } }
    })
    await service.store.setStorage(storageInput())
    await service.store.saveModel({ ...BUILTIN_MODELS[0], api_key: 'model-key' })
    const node: CanvasNode = { id: randomUUID(), kind: 'image-generation', title: '生成', position: { x: 0, y: 0 }, modelId: BUILTIN_MODELS[0].id, params: defaultParams(BUILTIN_MODELS[0]), prompt: 'test', assetId: null, selectedResultId: null }
    await service.saveGraph('w', { ...emptyGraph(), nodes: [node] }, 0)
    const providers = (service.runtime as any).providers
    const submit = vi.spyOn(providers, 'submit').mockResolvedValue({ status: 'completed', outputs: [{ id: randomUUID(), mime: 'image/png', filename: 'output.png', url: 'https://expired.invalid/result' }] })
    let downloads = 0
    vi.spyOn(providers, 'outputStream').mockImplementation(async () => {
      if (++downloads > 1) throw new Error('Result URL expired')
      return Readable.from([png])
    })
    unavailable = true
    await service.runtime.start()
    const task = await service.generate('w', node.id, 1)
    for (let i = 0; i < 100 && (service.store.state('w').tasks[0].status !== 'save_failed' || service.runtime.isActive(task.id)); i++) await new Promise((resolve) => setTimeout(resolve, 10))
    expect(service.store.state('w').tasks[0].status).toBe('save_failed')
    unavailable = false
    await service.taskAction('w', task.id, 'retry-save')
    for (let i = 0; i < 100 && (service.store.state('w').tasks[0].status !== 'completed' || service.runtime.isActive(task.id)); i++) await new Promise((resolve) => setTimeout(resolve, 10))
    expect(service.store.state('w').tasks[0].status).toBe('completed')
    expect(submit).toHaveBeenCalledTimes(1); expect(downloads).toBe(1)
    expect(await readdir(join(service.config.dataDir, 'staging'))).toEqual([])
  })
  it('does not sign during graph reads, limits batches and isolates cross-canvas media IDs', async () => {
    const service = await fixture(); await service.store.setStorage(storageInput())
    const { asset } = await resource(service)
    const adapter = await service.store.objects.adapter((await service.store.locator('w', asset.id)).providerId)
    const sign = vi.spyOn(adapter, 'signRead')
    await service.store.snapshot('w'); expect(sign).not.toHaveBeenCalled()
    const request = (items: any[]) => service.handle(new Request('http://localhost/api/canvas/v2/media-urls?canvas=w', { method: 'POST', body: JSON.stringify({ items }) }))
    const response = await request([{ assetId: asset.id, variant: 'original' }])
    expect(response.status).toBe(200); expect(sign).toHaveBeenCalledTimes(1)
    await request([{ assetId: asset.id, variant: 'original' }]); expect(sign).toHaveBeenCalledTimes(1)
    expect((await request(Array.from({ length: 101 }, () => ({ assetId: asset.id })))).status).toBe(400)
    const invalid = await request([{ assetId: randomUUID(), variant: 'original' }])
    expect((await invalid.json()).items[0]).toHaveProperty('error')
    expect(JSON.stringify(await service.store.db.all('SELECT * FROM canvas_assets'))).not.toContain('signature')
  })
  it('refreshes expiring cached links, signs model URLs freshly and uses local V4 signing without network', async () => {
    const service = await fixture(); const saved = await service.store.setStorage(storageInput())
    const record = await service.store.storageRecord(saved.activeProviderId!)
    let now = Date.now()
    const objects = new ObjectStorage(service.store.vault, () => Promise.resolve(record), fakeFactory(service.config.dataDir), () => now)
    const locator: ObjectLocator = { providerId: record.id, objectKey: 'test/key.png', bytes: 1, mime: 'image/png', sha256: 'hash' }
    const options = { method: 'GET' as const, ttl: 3600 }
    const first = await objects.sign(locator, options)
    expect(await objects.sign(locator, options)).toEqual(first)
    now += 56 * 60000
    expect((await objects.sign(locator, options)).url).not.toBe(first.url)
    expect((await objects.sign(locator, { ...options, ttl: 86400 }, true)).url).not.toBe((await objects.sign(locator, { ...options, ttl: 86400 }, true)).url)
    const network = vi.fn(); vi.stubGlobal('fetch', network)
    const aliyun = new AliyunStorage(record, { accessKeyId: 'test-access-key', accessKeySecret: 'test-secret' })
    const durations: number[] = []
    for (let sample = 0; sample < 30; sample++) {
      const start = performance.now()
      for (let i = 0; i < 100; i++) await aliyun.signRead(`dsh-canvas/test/${i}.png`, options)
      durations.push(performance.now() - start)
    }
    const url = new URL(await aliyun.signRead('dsh-canvas/test.png', { method: 'HEAD', ttl: 60 }))
    expect(url.protocol).toBe('https:'); expect(url.searchParams.get('x-oss-signature-version')).toBe('OSS4-HMAC-SHA256')
    expect(network).not.toHaveBeenCalled()
    expect(durations.sort((a, b) => a - b)[28]).toBeLessThan(200)
  })
})
