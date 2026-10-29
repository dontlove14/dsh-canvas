import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { CanvasService, routeDefinitions } from '../src/host/service'
import { BUILTIN_MODELS } from '../src/shared/modelCatalog'
import { FISH_TTS_ENDPOINT } from '../src/shared/contracts'
import { maskSecret } from '../src/shared/settingSecrets'
import { fakeFactory, initialize, storageInput } from './support/objectStorage'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
async function service() {
  const root = await mkdtemp(join(tmpdir(), 'canvas-secret-test-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const instance = new CanvasService({ dataDir: root, maxConcurrentTasks: 2, pollIntervalMs: 3000,
    requestTimeoutMs: 1000, maxMediaBytes: 1024 * 1024, maxReferenceBytes: 1024 * 1024 }, undefined, fakeFactory(root))
  await initialize(instance); cleanups.push(() => instance.close())
  return instance
}
function request(input: unknown, method = 'POST', suffix = 'settings-secret') {
  return new Request(`http://localhost/api/canvas/v2/${suffix}`, { method,
    ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) } : {}) })
}

it.each(['', 'a', '123456', '370-private-middle-117'])('partially masks long values and fully masks short value %s', (value) => {
  const masked = maskSecret(value)
  expect(masked).toBe(!value ? '' : value.length <= 6 ? '********' : '370********117')
  if (value) expect(masked).not.toContain(value)
})

it('reads only the requested current model key without modifying config, bindings or business tables', async () => {
  const instance = await service(), model = BUILTIN_MODELS[13]
  await instance.store.saveModel({ ...model, endpoint_id: 'ep-routing-one', api_key: 'model-original-secret' })
  await instance.store.saveModel({ ...BUILTIN_MODELS[0], api_key: 'other-private-value' })
  const ddl = await instance.store.db.all('SELECT type,name,sql FROM sqlite_master ORDER BY type,name')
  const paths = ['models.json', 'model-bindings.json']
  const before = await Promise.all(paths.map((name) => readFile(join(instance.config.dataDir, name))))
  const input = { scope: 'model', id: model.id, field: 'api_key' }
  const response = await instance.handle(request(input))
  expect(response.status).toBe(200); expect(response.headers.get('Cache-Control')).toBe('no-store')
  expect(await response.json()).toEqual({ value: 'model-original-secret' })
  const publicModels = instance.store.listModels()
  expect(JSON.stringify(publicModels)).not.toContain('model-original-secret')
  expect(publicModels.find((item) => item.id === model.id)!.api_key_mask).toBe('mod********ret')
  expect(await Promise.all(paths.map((name) => readFile(join(instance.config.dataDir, name))))).toEqual(before)
  expect(await instance.store.db.all('SELECT type,name,sql FROM sqlite_master ORDER BY type,name')).toEqual(ddl)
  await instance.store.saveModel({ ...model, api_key: 'model-rotated-secret' })
  expect(await (await instance.handle(request(input))).json()).toEqual({ value: 'model-rotated-secret' })
  await instance.store.saveModel({ ...model, api_key: '' })
  expect((await instance.handle(request(input))).status).toBe(404)
})

it('allows an incomplete official saved configuration to reveal its key for editing', async () => {
  const instance = await service(), model = BUILTIN_MODELS[13], store = instance.store as any
  store.models.push(model); store.keys[model.id] = 'incomplete-private-key'
  const response = await instance.handle(request({ scope: 'model', id: model.id, field: 'api_key' }))
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ value: 'incomplete-private-key' })
})

it('returns only the selected TTS or storage credential field and follows current read-credential rotation', async () => {
  const instance = await service()
  await instance.store.saveTtsSettings({ endpoint: FISH_TTS_ENDPOINT, revision: 0, api_key: 'fish-private-key' })
  expect(await (await instance.handle(request({ scope: 'tts', field: 'api_key' }))).json()).toEqual({ value: 'fish-private-key' })
  const settings = await instance.store.storage(), original = settings.providers[0]
  expect(await (await instance.handle(request({ scope: 'storage', id: original.id, field: 'accessKeySecret' }))).json()).toEqual({ value: 'test-sk' })
  await instance.store.setStorage({ ...storageInput(settings.revision), id: original.id,
    accessKeyId: '370-replacement-id-117', accessKeySecret: 'rotated-oss-secret' })
  expect(await (await instance.handle(request({ scope: 'storage', id: original.id, field: 'accessKeyId' }))).json()).toEqual({ value: '370-replacement-id-117' })
  const publicSettings = await instance.store.storage()
  expect(publicSettings.providers[0].accessKeyIdMask).toBe('370********117')
  expect(JSON.stringify(publicSettings)).not.toContain('rotated-oss-secret')
  expect(JSON.stringify(publicSettings)).not.toContain('370-replacement-id-117')
})

it('rejects GET, missing identities, arbitrary refs, task IDs, unknown fields and foreign storage without leaking values', async () => {
  const instance = await service()
  const input = { scope: 'model', id: BUILTIN_MODELS[0].id, field: 'api_key' }
  expect((await instance.handle(request(input, 'GET'))).status).toBe(404)
  for (const body of [{ ...input, ref: 'dsh-canvas/key-private' }, { ...input, taskId: randomUUID() },
    { ...input, field: 'credentialRef' }, { scope: 'storage', id: randomUUID(), field: 'accessKeySecret' }, input]) {
    const response = await instance.handle(request(body))
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(await response.text()).not.toMatch(/test-sk|key-private|credential_ref/)
  }
  expect((await instance.handle(request(input, 'POST', 'settings-secret?id=ignored'))).status).toBe(400)
  expect(routeDefinitions.find((route) => route.suffix === 'settings-secret')!.methods).toEqual(['POST'])
})
