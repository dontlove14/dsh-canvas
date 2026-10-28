import { createHash, randomUUID } from 'node:crypto'
import { readdir, readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

const root = fileURLToPath(new URL('..', import.meta.url))
process.chdir(root)
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
async function files(directory) {
  const result = []
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name)
    if (item.isDirectory()) result.push(...await files(path))
    else result.push(path)
  }
  return result.sort()
}
async function hashes(paths) { return Object.fromEntries(await Promise.all(paths.map(async (path) => [path, digest(await readFile(path))]))) }
const pkg = JSON.parse(await readFile('package.json', 'utf8'))
const checkDir = process.env.CANVAS_ARTIFACT_CHECK_DIR ?? join(tmpdir(), `${pkg.name}-artifact-${pkg.version}`)
await mkdir(checkDir, { recursive: true })
const lib = await hashes(await files('lib'))
for (const name of ['lib/index.js', 'lib/client.js', 'lib/worker.mjs', 'lib/schema.sql']) assert(lib[name], `missing ${name}`)
if (process.argv[2] === 'record') {
  await writeFile(join(checkDir, 'lib-first.json'), JSON.stringify(lib, null, 2))
  console.log(`Recorded ${Object.keys(lib).length} built files`)
} else {
  assert.deepEqual(lib, JSON.parse(await readFile(join(checkDir, 'lib-first.json'), 'utf8')), 'Build output changed')
  const dataDir = await mkdtemp(join(checkDir, 'runtime-'))
  const routes = new Map(); const cleanup = []; const records = new Map()
  try {
    const { apply } = await import('../lib/index.js')
    await apply({
      effect: (setup) => { cleanup.push(setup()) },
      credentials: { readRecord: async (id) => records.get(id), modifyRecord: async (id, mutate) => { const next = await mutate(records.get(id)); records.set(id, next); return next } },
      connection: { fetch: { register: (route) => { routes.set(route.path, route); return () => routes.delete(route.path) } } },
    }, { dataDir })
    const route = routes.get('/api/canvas/v2/catalog')
    assert(route, 'missing catalog route')
    const create = await route.fetch(new Request('http://localhost/api/canvas/v2/catalog', { method: 'POST', body: JSON.stringify({ requestId: randomUUID(), operation: 'canvas-create', name: 'Artifact smoke' }) }))
    assert.equal(create.status, 409)
    assert.deepEqual(await create.json(), { error: '请前往设置页面设置对象存储', code: 'STORAGE_NOT_CONFIGURED' })
    assert.deepEqual(await (await route.fetch(new Request('http://localhost/api/canvas/v2/catalog'))).json(), { folders: [], canvases: [] })
    const storageRoute = routes.get('/api/canvas/v2/storage')
    assert.equal((await (await storageRoute.fetch(new Request('http://localhost/api/canvas/v2/storage'))).json()).configured, false)
    // Seed only this isolated database after closing the compiled Host. No network or real AK.
    for (const dispose of cleanup.splice(0).reverse()) await dispose()
    const providerId = randomUUID(), credentialRef = `dsh-canvas/key-${randomUUID()}`
    records.set(credentialRef, { kind: 'api-key', key: JSON.stringify({ accessKeyId: 'offline-smoke-ak', accessKeySecret: 'offline-smoke-sk' }) })
    const config = { id: providerId, type: 'aliyun-oss', name: 'Offline smoke', region: 'oss-cn-hangzhou', bucket: 'offline-smoke-bucket',
      endpoint: 'https://oss-cn-hangzhou.aliyuncs.com', prefix: 'dsh-canvas', revision: 1, verifiedAt: Date.now(), credentialRef }
    const database = new DatabaseSync(join(dataDir, 'canvas.sqlite'))
    try {
      database.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE')
      database.prepare('INSERT INTO storage_providers VALUES(?,?,?,?,?,?)').run(providerId, 'local-owner', JSON.stringify(config), credentialRef, credentialRef, Date.now())
      database.prepare('UPDATE owner_settings SET active_storage_provider_id=?,storage_revision=1 WHERE owner_id=?').run(providerId, 'local-owner')
      database.exec('COMMIT')
    } finally { database.close() }
    await apply({
      effect: (setup) => { cleanup.push(setup()) },
      credentials: { readRecord: async (id) => records.get(id), modifyRecord: async (id, mutate) => { const next = await mutate(records.get(id)); records.set(id, next); return next } },
      connection: { fetch: { register: (route) => { routes.set(route.path, route); return () => routes.delete(route.path) } } },
    }, { dataDir })
    const configuredCreate = await routes.get('/api/canvas/v2/catalog').fetch(new Request('http://localhost/api/canvas/v2/catalog', {
      method: 'POST', body: JSON.stringify({ requestId: randomUUID(), operation: 'canvas-create', name: 'Artifact smoke' }),
    }))
    assert.equal(configuredCreate.status, 200)
    const { id } = await configuredCreate.json()
    const graph = await routes.get('/api/canvas/v2/graph').fetch(new Request(`http://localhost/api/canvas/v2/graph?canvas=${id}`))
    assert.equal(graph.status, 200); assert.equal((await graph.json()).graphRevision, 0)
    assert.equal(routes.size, 19)
    const imageModels = await routes.get('/api/canvas/v2/models').fetch(new Request('http://localhost/api/canvas/v2/models'))
    assert.equal(imageModels.status, 200)
    const catalog = (await imageModels.json()).models
    assert.equal(catalog.length, 12)
    assert(catalog.every((model) => model.configurable && !model.has_api_key))
    const gptCatalog = catalog.filter((model) => model.protocol === 'openai-image')
    assert.equal(gptCatalog.length, 4)
    assert(gptCatalog.every((model) => model.capabilities.sizePresets.length === 23))
    for (const model of gptCatalog) {
      const oneK = model.capabilities.sizePresets.filter((preset) => preset.resolution === '1K')
      for (const [ratio, size] of [['16:9', '1280x720'], ['9:16', '720x1280'], ['21:9', '1344x576']])
        assert(oneK.some((preset) => preset.ratio === ratio && preset.size === size))
    }
    const bananaCatalog = catalog.filter((model) => model.protocol === 'gemini-image')
    assert.equal(bananaCatalog.length, 8)
    for (const model of bananaCatalog) {
      assert(['https://generativelanguage.googleapis.com', 'https://api.modellink.online'].includes(model.api_base))
      assert.deepEqual(model.capabilities.counts, [1])
      assert.equal(model.capabilities.defaultSize, '1024x1024')
      const presets = model.capabilities.sizePresets
      assert.equal(presets.length, model.model_id === 'gemini-3.1-flash-lite-image' ? 10 : model.model_id === 'gemini-3.1-flash-image' ? 40 : 30)
      assert(presets.some((preset) => preset.ratio === '21:9' && preset.resolution === '1K' && preset.size === '1584x672'))
    }
    const taskSearch = await routes.get('/api/canvas/v2/task-search').fetch(new Request('http://localhost/api/canvas/v2/task-search?page=1&pageSize=10'))
    assert.equal(taskSearch.status, 200)
    assert.deepEqual(await taskSearch.json(), { items: [], total: 0, page: 1, pageSize: 10, upperBound: 0 })
    const ttsSettings = await routes.get('/api/canvas/v2/tts-settings').fetch(new Request('http://localhost/api/canvas/v2/tts-settings'))
    assert.equal((await ttsSettings.json()).configured, false)
    const node = { id: randomUUID(), kind: 'tts-generation', title: 'TTS smoke', position: { x: 0, y: 0 }, modelId: null,
      prompt: '(happy) Hello', params: { type: 'tts', reference_id: '', speed: 1, volume: 0 }, assetId: null, selectedResultId: null }
    const canonical = (value) => value === null || typeof value !== 'object' ? JSON.stringify(value)
      : Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
      : `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
    const mutation = await routes.get('/api/canvas/v2/graph').fetch(new Request(`http://localhost/api/canvas/v2/graph?canvas=${id}`, {
      method: 'POST', body: JSON.stringify({ mutationId: randomUUID(), baseRevision: 0, nodes: [{ value: node, hash: digest(canonical(node)) }], edges: [], deleteNodes: [], deleteEdges: [] }),
    }))
    assert.equal(mutation.status, 200); assert.deepEqual((await mutation.json()).graph.nodes, [node])
    const noService = await routes.get('/api/canvas/v2/tts-generate').fetch(new Request(`http://localhost/api/canvas/v2/tts-generate?canvas=${id}`, {
      method: 'POST', body: JSON.stringify({ requestId: randomUUID(), nodeId: node.id, revision: 1 }),
    }))
    assert.equal(noService.status, 400); assert.equal((await noService.json()).code, 'TTS_NOT_CONFIGURED')
    // Exercise the compiled same-origin waveform branch offline, before any OSS read.
    for (const dispose of cleanup.splice(0).reverse()) await dispose()
    const audioId = randomUUID(), audioHash = digest('offline-audio')
    const audioDb = new DatabaseSync(join(dataDir, 'canvas.sqlite'))
    try {
      const location = audioDb.prepare('SELECT id FROM canvas_storage_locations WHERE canvas_id=?').get(id)
      audioDb.prepare(`INSERT INTO canvas_assets(canvas_id,id,kind,origin_kind,name_snapshot,storage_id,file_name,file_name_key,
        object_key,mime,bytes,file_hash,file_state,content_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, audioId, 'audio', 'upload', 'Smoke audio', location.id, 'smoke.mp3', 'smoke.mp3',
          'dsh-canvas/offline/smoke.mp3', 'audio/mpeg', 64, audioHash, 'ready', audioHash, 1, 1)
      audioDb.prepare('INSERT INTO asset_variants VALUES(?,?,?,?)').run(id, audioId, 'waveform',
        JSON.stringify({ providerId, objectKey: 'dsh-canvas/offline/waveform.json', mime: 'application/json', bytes: 8193, sha256: audioHash }))
    } finally { audioDb.close() }
    await apply({
      effect: (setup) => { cleanup.push(setup()) },
      credentials: { readRecord: async (key) => records.get(key), modifyRecord: async (key, mutate) => { const next = await mutate(records.get(key)); records.set(key, next); return next } },
      connection: { fetch: { register: (route) => { routes.set(route.path, route); return () => routes.delete(route.path) } } },
    }, { dataDir })
    const waveform = await routes.get('/api/canvas/v2/media').fetch(new Request(`http://localhost/api/canvas/v2/media?canvas=${id}&id=${audioId}&variant=waveform`))
    assert.equal(waveform.status, 422); assert.equal((await waveform.json()).code, 'WAVEFORM_UNAVAILABLE')
    assert.equal(waveform.headers.get('location'), null)
    const original = await routes.get('/api/canvas/v2/media').fetch(new Request(`http://localhost/api/canvas/v2/media?canvas=${id}&id=${audioId}`))
    assert.equal(original.status, 307)
    const sourcePaths = [...await files('src'), ...await files('scripts'), ...await files('tests'), ...await files('docs'), 'README.md', 'AGENTS.md', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.base.json', 'tsconfig.host.json', 'tsconfig.client.json', 'cordis.patch.yml']
    const source = await hashes(sourcePaths)
    const manifest = { name: pkg.name, version: pkg.version, node: process.version, npm: execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim(), source, sourceHash: digest(JSON.stringify(source)), lib, libHash: digest(JSON.stringify(lib)), reproducible: true, compiledHostSmoke: 'passed' }
    await writeFile(`${pkg.name}-${pkg.version}.manifest.json`, JSON.stringify(manifest, null, 2))
    console.log(`Reproducible lib ${manifest.libHash}; compiled Host/Worker/schema startup passed`)
  } finally {
    for (const dispose of cleanup.reverse()) await dispose()
    await rm(dataDir, { recursive: true, force: true })
  }
}
