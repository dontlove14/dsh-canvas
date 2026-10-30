import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CanvasService } from '../src/host/service'
import { fakeFactory, initialize } from './support/objectStorage'
import { sql } from '../src/host/persistence/database'
import { parseTaskSearchParams } from '../src/shared/v2'
import { BUILTIN_MODELS } from '../src/shared/modelCatalog'
import { FISH_TTS_ENDPOINT, defaultParams, defaultTtsParams } from '../src/shared/contracts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })
async function fixture(validSnapshots = false) {
  const root = await mkdtemp(join(tmpdir(), 'canvas-task-search-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const service = new CanvasService({ dataDir: root, maxConcurrentTasks: 1, pollIntervalMs: 50, requestTimeoutMs: 1000, maxMediaBytes: 1024, maxReferenceBytes: 1024 }, undefined, fakeFactory(root))
  await initialize(service); cleanup.push(() => service.close())
  const store = service.store
  const folder = await store.catalogCommand({ operation: 'folder-create', name: '文件夹%_素材', requestId: randomUUID() })
  const main = await store.catalogCommand({ operation: 'canvas-create', name: '画布%_测试', folderId: folder.id, requestId: randomUUID() })
  const other = await store.catalogCommand({ operation: 'canvas-create', name: '画布XX测试', requestId: randomUUID() })
  const deleted = await store.catalogCommand({ operation: 'canvas-create', name: '已删除', requestId: randomUUID() })
  const foreign = await store.catalogCommand({ operation: 'canvas-create', name: '其他用户', requestId: randomUUID() })
  await store.db.batch([sql('UPDATE canvases SET deleted_at=1 WHERE id=?', [deleted.id]), sql("UPDATE canvases SET owner_id='another-owner' WHERE id=?", [foreign.id])])
  const ids: string[] = []
  const insert = async (seq: number, canvas = main.id, type: 'image' | 'video' | 'tts' | 'import' = 'image') => {
    const id = randomUUID(); ids.push(id)
    const model = type === 'tts' ? { id: randomUUID(), kind: 'audio' as const, name: 'FishTTS', model_id: 'fish-tts', protocol: 'fish-tts', api_base: FISH_TTS_ENDPOINT }
      : BUILTIN_MODELS.find((item) => item.kind === type) ?? BUILTIN_MODELS[0]
    const snapshot = type === 'import' ? null : JSON.stringify(validSnapshots
      ? { model, prompt: 'private prompt', params: type === 'tts' ? defaultTtsParams() : defaultParams(model as typeof BUILTIN_MODELS[number]), referenceIds: [] }
      : { model: { kind: type === 'tts' ? 'audio' : type, protocol: type === 'tts' ? 'fish-tts' : 'openai', api_base: 'https://private.example' }, prompt: 'private prompt' })
    await store.db.batch([
      sql('INSERT INTO task_catalog(id,canvas_id,node_id,kind,title,queue_seq,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?, ?,?)',
        [id, canvas, randomUUID(), type === 'import' ? 'import' : 'generation', `提交时节点${seq}`, seq, seq % 2 ? 'succeeded' : 'failed', seq * 1000, seq * 1000 + 30000]),
      sql('INSERT INTO task_details(task_id,request_id,request_hash,snapshot_json,credential_ref,phase,updated_at) VALUES(?,?,?,?,?,?,?)',
        [id, randomUUID(), 'hash', snapshot, 'private credential ref', 'completed', seq * 1000]),
    ])
    return id
  }
  for (let seq = 1; seq <= 25; seq++) await insert(seq)
  const video = await insert(26, main.id, 'video')
  const tts = await insert(27, main.id, 'tts')
  const imported = await insert(28, other.id, 'import')
  await insert(29, deleted.id); await insert(30, foreign.id)
  const get = (query = '') => service.handle(new Request(`http://localhost/api/canvas/v2/task-search${query ? `?${query}` : ''}`))
  return { root, store, service, main, other, folder, ids, insert, get, video, tts, imported }
}
describe('task search contract and SQL pagination', () => {
  it('returns directory-only owner-scoped rows, preserves database and graph, and maps public status', async () => {
    const { store, main, get } = await fixture()
    const schema = await store.db.all('SELECT sql FROM sqlite_master ORDER BY name')
    const graph = store.state(main.id).graph
    const response = await get()
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store')
    const result = await response.json()
    expect(result).toMatchObject({ total: 28, page: 1, pageSize: 10, upperBound: 28 })
    expect(result.items).toHaveLength(10)
    expect(result.items[0]).toMatchObject({ nodeName: '提交时节点28', status: 'failed', type: 'import', folderName: '未归档', modelName: '-', providerName: '-' })
    expect(result.items[1]).toMatchObject({ nodeName: '提交时节点27', status: 'completed', type: 'tts', folderName: '文件夹%_素材', canvasName: '画布%_测试', modelName: '-', providerName: '-' })
    expect(Object.keys(result.items[0]).sort()).toEqual(['id', 'canvasId', 'nodeId', 'folderName', 'canvasName', 'nodeName', 'modelName', 'providerName', 'type', 'status', 'createdAt', 'updatedAt'].sort())
    expect(JSON.stringify(result)).not.toMatch(/private|snapshot|credential|api_base|prompt|queue_seq/)
    expect(await store.db.all('SELECT sql FROM sqlite_master ORDER BY name')).toEqual(schema)
    expect(store.state(main.id).graph).toEqual(graph)
  })
  it('reads submitted model/provider from details for every channel and keeps identity after configuration changes and restart', async () => {
    const { root, store, service, main, insert, tts, imported, other, get } = await fixture(true)
    const models = [BUILTIN_MODELS[0], BUILTIN_MODELS[1],
      ...BUILTIN_MODELS.filter((model) => ['wan-video', 'minimax-video', 'seedance-video', 'seedream-image'].includes(model.protocol))]
    const expected = []
    for (const [index, model] of models.entries()) {
      const id = await insert(32 + index)
      const snapshot = { model: { ...model, ...(model.api_base.includes('ark.') ? { endpoint_id: 'ep-hidden-value' } : {}) },
        prompt: 'private prompt', params: defaultParams(model), referenceIds: [] }
      await store.db.batch([sql('UPDATE task_details SET snapshot_json=? WHERE task_id=?', [JSON.stringify(snapshot), id])])
      const identity = { modelName: model.name, providerName: model.api_base.includes('modellink') ? 'Model Link'
        : model.api_base.includes('qianwen') ? 'Aliyun' : model.api_base.includes('minimax') ? 'MiniMax'
          : model.api_base.includes('bytepluses') ? 'BytePlus' : model.api_base.includes('volces') ? 'ByteDance' : 'OpenAI' }
      const listed = await (await get(`taskId=${id}`)).json()
      expect(listed.items[0]).toMatchObject(identity)
      expect(await store.taskDetail(main.id, id)).toMatchObject(identity)
      expect(JSON.stringify(listed)).not.toMatch(/api_base|endpoint_id|ep-hidden|private prompt/)
      expected.push(listed.items[0])
    }
    expect((await (await get(`taskId=${tts}`)).json()).items[0]).toMatchObject({ modelName: 'FishTTS', providerName: 'Model Link' })
    expect(await store.taskDetail(main.id, tts)).toMatchObject({ modelName: 'FishTTS', providerName: 'Model Link' })
    expect(await store.taskDetail(other.id, imported)).toMatchObject({ modelName: '-', providerName: '-' })
    await store.saveModel({ ...models[0], api_key: 'offline-key-rotated' })
    await store.deleteModel(models[0].id)
    expect((await (await get(`taskId=${expected[0].id}`)).json()).items[0]).toEqual(expected[0])
    await service.close()
    const reopened = new CanvasService({ dataDir: root, maxConcurrentTasks: 1, pollIntervalMs: 50, requestTimeoutMs: 1000, maxMediaBytes: 1024, maxReferenceBytes: 1024 }, undefined, fakeFactory(root))
    await reopened.init(); cleanup.push(() => reopened.close())
    for (const identity of expected) {
      expect((await reopened.store.searchTasks({ taskId: identity.id })).items[0]).toEqual(identity)
      expect(await reopened.store.taskDetail(main.id, identity.id)).toMatchObject({ modelName: identity.modelName, providerName: identity.providerName })
    }
  })
  it('AND combines exact ID, literal fuzzy names, type and inclusive submitted-time bounds', async () => {
    const { video, tts, imported, get } = await fixture()
    const query = new URLSearchParams({ taskId: video.toUpperCase(), folderName: '%_', canvasName: '布%_', type: 'video', startTime: '26000', endTime: '26000' })
    expect((await (await get(query.toString())).json()).items.map((row: any) => row.id)).toEqual([video])
    query.set('endTime', '25999')
    expect((await get(query.toString())).status).toBe(400)
    query.set('startTime', '25999'); query.set('endTime', '25999')
    expect((await (await get(query.toString())).json()).total).toBe(0)
    expect((await (await get('type=tts&startTime=27000')).json()).items.map((row: any) => row.id)).toEqual([tts])
    expect((await (await get('type=import&endTime=28000')).json()).items.map((row: any) => row.id)).toEqual([imported])
    expect((await (await get(`taskId=${video.slice(0, 8)}`)).json()).code).toBe('INVALID_REQUEST')
    expect((await (await get('canvasName=%25_')).json()).total).toBe(27)
    expect((await (await get('folderName=%25_')).json()).total).toBe(27)
    expect((await (await get('canvasName=%27%20OR%201%3D1--')).json()).total).toBe(0)
  })
  it('keeps deterministic pages across new inserts, supports page sizes and clamps out-of-range pages', async () => {
    const { get, insert } = await fixture()
    const first = await (await get('pageSize=10')).json()
    expect(first.items.map((row: any) => row.nodeName)).toEqual(Array.from({ length: 10 }, (_, index) => `提交时节点${28 - index}`))
    await insert(31)
    const second = await (await get(`page=2&pageSize=10&upperBound=${first.upperBound}`)).json()
    expect(second).toMatchObject({ page: 2, total: 28, upperBound: 28 })
    expect(second.items.map((row: any) => row.nodeName)).toEqual(Array.from({ length: 10 }, (_, index) => `提交时节点${18 - index}`))
    const last = await (await get('page=100&pageSize=10&upperBound=28')).json()
    expect(last).toMatchObject({ page: 3, total: 28 }); expect(last.items).toHaveLength(8)
    const fresh = await (await get('pageSize=100')).json()
    expect(fresh).toMatchObject({ total: 29, upperBound: 31 }); expect(fresh.items).toHaveLength(29)
    expect((await (await get('upperBound=0&page=4')).json())).toMatchObject({ page: 1, total: 0, items: [] })
  })
  it('rejects duplicate, unknown and malformed parameters, while keeping the old cursor endpoint', async () => {
    const { get, service, main } = await fixture()
    for (const query of ['page=0', 'page=-1', 'page=1.5', 'page=1e2', 'pageSize=11', 'page=100000001', 'upperBound=9007199254740992',
      'startTime=', 'startTime=NaN', 'startTime=2&endTime=1', 'type=audio', 'taskId=abc', 'canvasName=', 'page=1&page=2', 'unexpected=1', '__proto__=1']) {
      expect((await get(query)).status, query).toBe(400)
    }
    const old = await service.handle(new Request(`http://localhost/api/canvas/v2/tasks?canvas=${main.id}&cursor=0`))
    expect(old.status).toBe(200); expect((await old.json()).items[0]).toMatchObject({ sequence: 1, title: '提交时节点1', status: 'succeeded' })
    expect(parseTaskSearchParams(new URLSearchParams('canvasName=%20测试%20'))).toEqual({ canvasName: '测试', page: 1, pageSize: 10 })
  })
})
