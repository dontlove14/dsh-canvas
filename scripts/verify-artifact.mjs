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
for (const name of ['lib/index.js', 'lib/client.js', 'lib/worker.mjs', 'lib/schema.sql', 'lib/review-worker.mjs',
  'lib/review-schema.sql', 'lib/vendor/volcengine-signer.cjs', 'lib/volcengine-signer-LICENSE', 'lib/volcengine-signer-source.json']) assert(lib[name], `missing ${name}`)
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
    // Harness0.2.1-rc.2's streaming bridge always adds a body; WHATWG
    // Request rejects GET/HEAD bodies before the plugin handler is reached.
    for (const entry of routes.values()) if (entry.requestBody === 'streaming')
      assert(entry.methods.every((method) => !['GET', 'HEAD'].includes(method)), 'Bodyless methods must use a buffered route')
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
    assert.equal(routes.size, 29)
    const reviewSettings = routes.get('/api/canvas/v2/seedance-review-settings')
    const masked = await reviewSettings.fetch(new Request('http://localhost/api/canvas/v2/seedance-review-settings'))
    assert.equal(masked.status, 200)
    assert.equal((await masked.json()).profiles.length, 2)
    const reviewPage = await routes.get('/api/canvas/v2/asset-reviews').fetch(new Request(`http://localhost/api/canvas/v2/asset-reviews?canvas=${id}`))
    assert.deepEqual(await reviewPage.json(), { items: [], revision: 0, busy: false })
    // Invoke the compiled ESM Host + native CJS signer using offline credentials.
    const originalFetch = globalThis.fetch, signedCalls = []
    globalThis.fetch = async (url, init) => {
      const endpoint = new URL(String(url)), body = JSON.parse(init.body)
      assert.equal(endpoint.searchParams.get('Action'), 'ListAssetGroups')
      assert.equal(body.ProjectName, 'offline-project')
      assert.deepEqual(body.Filter, { GroupType: 'AIGC' })
      assert.equal(body.MaxResults, 1)
      const region = endpoint.hostname.includes('byteplus') ? 'ap-southeast-1' : 'cn-beijing'
      assert(String(init.headers.Authorization).includes(`/${region}/ark/request`))
      assert.equal(init.headers['X-Content-Sha256'], digest(init.body))
      signedCalls.push(region)
      return Response.json({ Result: { Items: [] } })
    }
    try {
      for (const provider of ['bytedance', 'byteplus']) {
        const saved = await reviewSettings.fetch(new Request('http://localhost/api/canvas/v2/seedance-review-settings', {
          method: 'POST', body: JSON.stringify({ provider, revision: 0, projectName: 'offline-project',
            accessKeyId: 'offline-review-ak', accessKeySecret: 'offline-review-sk' }),
        }))
        assert.equal(saved.status, 200)
        const value = await saved.json()
        assert(!JSON.stringify(value).includes('offline-project') && !JSON.stringify(value).includes('offline-review'))
        const test = await routes.get('/api/canvas/v2/seedance-review-settings-test').fetch(new Request('http://localhost/api/canvas/v2/seedance-review-settings-test', {
          method: 'POST', body: JSON.stringify({ provider }),
        }))
        assert.equal(test.status, 200, JSON.stringify(await test.json()))
        const reveal = await routes.get('/api/canvas/v2/settings-secret').fetch(new Request('http://localhost/api/canvas/v2/settings-secret', {
          method: 'POST', body: JSON.stringify({ scope: 'seedance-review', provider, field: 'projectName' }),
        }))
        assert.equal(reveal.headers.get('Cache-Control'), 'no-store')
        assert.deepEqual(await reveal.json(), { value: 'offline-project' })
      }
      assert.deepEqual(signedCalls, ['cn-beijing', 'ap-southeast-1'])
    } finally {
      for (const dispose of cleanup.splice(0).reverse()) await dispose()
      globalThis.fetch = originalFetch
    }
    // Remove only the isolated offline fixture profiles before further smoke checks.
    const reviewDb = new DatabaseSync(join(dataDir, 'seedance-review.sqlite'))
    reviewDb.prepare('DELETE FROM review_profiles').run(); reviewDb.close()
    await apply({
      effect: (setup) => { cleanup.push(setup()) },
      credentials: { readRecord: async (key) => records.get(key), modifyRecord: async (key, mutate) => { const next = await mutate(records.get(key)); records.set(key, next); return next } },
      connection: { fetch: { register: (route) => { routes.set(route.path, route); return () => routes.delete(route.path) } } },
    }, { dataDir })
    const imageModels = await routes.get('/api/canvas/v2/models').fetch(new Request('http://localhost/api/canvas/v2/models'))
    assert.equal(imageModels.status, 200)
    const catalog = (await imageModels.json()).models
    assert.equal(catalog.length, 39)
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
    const seedreamCatalog = catalog.filter((model) => model.protocol === 'seedream-image')
    assert.equal(seedreamCatalog.length, 6)
    for (const model of seedreamCatalog) {
      const dola = model.model_id.startsWith('dola-'), pro = model.model_id.includes('-pro-')
      assert.equal(model.model_id, `${dola ? 'dola' : 'doubao'}-seedream-5-0-${pro ? 'pro-260628' : '260128'}`)
      assert(dola ? model.api_base === 'https://ark.ap-southeast.bytepluses.com/api/v3'
        : ['https://api.modellink.online/v1', 'https://ark.cn-beijing.volces.com/api/v3'].includes(model.api_base))
      assert.equal(model.capabilities.sizePresets.length, 24)
      assert.equal(model.capabilities.defaultSize, '2048x2048')
      assert.equal(model.capabilities.maxReferences, pro ? 10 : 14)
      assert.deepEqual(model.capabilities.counts, [1])
      const { capabilities, has_api_key, api_key_mask, configurable, ...record } = model
      const official = model.api_base !== 'https://api.modellink.online/v1'
      const configure = (input) => routes.get('/api/canvas/v2/models').fetch(new Request('http://localhost/api/canvas/v2/models', {
        method: 'POST', body: JSON.stringify(input),
      }))
      if (official) assert.equal((await configure({ ...record, api_key: 'offline-smoke-key' })).status, 400)
      const saved = await configure({ ...record, api_key: 'offline-smoke-key', ...(official ? { endpoint_id: 'ep-offline-smoke' } : {}) })
      assert.equal(saved.status, 200)
      const actual = (await saved.json()).models.find((item) => item.id === model.id)
      assert.equal(actual.model_id, model.model_id); assert.equal(actual.name, model.name); assert.equal(actual.has_api_key, true)
      assert.equal(actual.endpoint_id, official ? 'ep-offline-smoke' : undefined)
      const reveal = await routes.get('/api/canvas/v2/settings-secret').fetch(new Request('http://localhost/api/canvas/v2/settings-secret', {
        method: 'POST', body: JSON.stringify({ scope: 'model', id: model.id, field: 'api_key' }),
      }))
      assert.equal(reveal.status, 200); assert.equal(reveal.headers.get('Cache-Control'), 'no-store')
      assert.deepEqual(await reveal.json(), { value: 'offline-smoke-key' })
    }
    const videoCatalog = catalog.filter((model) => model.protocol === 'seedance-video')
    assert.equal(videoCatalog.length, 12)
    for (const model of videoCatalog) {
      assert.equal(model.kind, 'video')
      const nsfw = model.model_id.startsWith('dreamina-')
      assert(nsfw ? model.api_base === 'https://ark.ap-southeast.bytepluses.com/api/v3'
        : ['https://api.modellink.online/seedance/api/v3', 'https://ark.cn-beijing.volces.com/api/v3'].includes(model.api_base))
      assert.equal(model.capabilities.secondsRange.max, model.model_id.includes('-2-5-') ? 30 : 15)
      assert.deepEqual(model.capabilities.referenceKinds, ['image', 'video', 'audio'])
      assert.deepEqual(model.capabilities.counts, [1])
      const { capabilities, has_api_key, api_key_mask, configurable, ...record } = model
      const configure = (input) => routes.get('/api/canvas/v2/models').fetch(new Request('http://localhost/api/canvas/v2/models', {
        method: 'POST', body: JSON.stringify(input),
      }))
      const official = !model.api_base.includes('modellink')
      if (official) assert.equal((await configure({ ...record, api_key: 'offline-video-key' })).status, 400)
      const response = await configure({ ...record, api_key: 'offline-video-key', ...(official ? { endpoint_id: 'ep-offline-video' } : {}) })
      assert.equal(response.status, 200)
      const actual = (await response.json()).models.find((item) => item.id === model.id)
      assert.equal(actual.name, model.name); assert.equal(actual.model_id, model.model_id)
      assert.equal(actual.endpoint_id, official ? 'ep-offline-video' : undefined)
    }
    const wanCatalog = catalog.filter((model) => model.protocol === 'wan-video')
    assert.equal(wanCatalog.length, 4)
    for (const model of wanCatalog) {
      assert(['https://api.modellink.online/wan/api/v1', 'https://maas.qianwenaiapi.com/api/v1'].includes(model.api_base))
      assert.deepEqual(model.capabilities.secondsRange, { min: 2, max: 30, step: 1 })
      assert.equal(model.capabilities.sizePresets.length, 21)
      assert.deepEqual(model.capabilities.referenceKinds, ['image', 'video', 'audio'])
      const { capabilities, has_api_key, api_key_mask, configurable, ...record } = model
      const saved = await routes.get('/api/canvas/v2/models').fetch(new Request('http://localhost/api/canvas/v2/models', {
        method: 'POST', body: JSON.stringify({ ...record, api_key: 'offline-wan-key' }),
      }))
      assert.equal(saved.status, 200)
      const configured = (await saved.json()).models.find((item) => item.id === model.id)
      assert.equal(configured.model_id, model.model_id); assert.equal(configured.has_api_key, true)
      assert.equal(configured.endpoint_id, undefined)
    }
    const h3Catalog = catalog.filter((model) => model.protocol === 'minimax-video')
    assert.equal(h3Catalog.length, 5)
    assert.deepEqual(h3Catalog.filter((model) => model.api_base.includes('modellink')).map((model) => model.model_id), ['MiniMax-H3'])
    for (const model of h3Catalog) {
      assert(['https://api.modellink.online/hailuo', 'https://api.minimax.cn'].includes(model.api_base))
      assert.equal(model.capabilities.secondsRange.min, model.model_id === 'MiniMax-H3-Max' ? 5 : 4)
      assert.equal(model.capabilities.secondsRange.max, 15)
      assert.equal(model.capabilities.supportsAudioToggle, false)
      const { capabilities, has_api_key, api_key_mask, configurable, ...record } = model
      const saved = await routes.get('/api/canvas/v2/models').fetch(new Request('http://localhost/api/canvas/v2/models', {
        method: 'POST', body: JSON.stringify({ ...record, api_key: 'offline-h3-key' }),
      }))
      assert.equal(saved.status, 200)
      const configured = (await saved.json()).models.find((item) => item.id === model.id)
      assert.equal(configured.has_api_key, true); assert.equal(configured.api_base, model.api_base)
      assert.equal(configured.endpoint_id, undefined)
    }
    const taskSearch = await routes.get('/api/canvas/v2/task-search').fetch(new Request('http://localhost/api/canvas/v2/task-search'))
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
    // Compiled streaming resume survives a full Host / Worker restart. Invalid bytes
    // make final format rejection offline: no object upload or model call is issued.
    const uploadId = randomUUID(), chunkBytes = 4 * 1024 * 1024
    const uploadStart = await routes.get('/api/canvas/v2/upload-start').fetch(new Request(`http://localhost/api/canvas/v2/upload-start?canvas=${id}`, {
      method: 'POST', body: JSON.stringify({ requestId: uploadId, filename: 'offline.png', kind: 'image', size: chunkBytes + 4, position: { x: 0, y: 0 } }),
    }))
    assert.equal(uploadStart.status, 201)
    const firstChunk = Buffer.alloc(chunkBytes, 3)
    const receiveChunk = await routes.get('/api/canvas/v2/upload').fetch(new Request(`http://localhost/api/canvas/v2/upload?canvas=${id}&id=${uploadId}&kind=image&offset=0`, {
      method: 'POST', body: firstChunk, headers: { 'x-canvas-filename': 'offline.png', 'x-canvas-chunk-sha256': digest(firstChunk) },
    }))
    assert.equal(receiveChunk.status, 200)
    assert.equal((await receiveChunk.json()).offset, chunkBytes)
    for (const dispose of cleanup.splice(0).reverse()) await dispose()
    await apply({
      effect: (setup) => { cleanup.push(setup()) },
      credentials: { readRecord: async (key) => records.get(key), modifyRecord: async (key, mutate) => { const next = await mutate(records.get(key)); records.set(key, next); return next } },
      connection: { fetch: { register: (route) => { routes.set(route.path, route); return () => routes.delete(route.path) } } },
    }, { dataDir })
    const resumed = await routes.get('/api/canvas/v2/upload-status').fetch(new Request(`http://localhost/api/canvas/v2/upload-status?canvas=${id}&id=${uploadId}`))
    assert.equal(resumed.status, 200); assert.equal((await resumed.json()).offset, chunkBytes)
    const lastChunk = Buffer.alloc(4, 3)
    assert.equal((await routes.get('/api/canvas/v2/upload').fetch(new Request(`http://localhost/api/canvas/v2/upload?canvas=${id}&id=${uploadId}&kind=image&offset=${chunkBytes}`, {
      method: 'POST', body: lastChunk, headers: { 'x-canvas-filename': 'offline.png', 'x-canvas-chunk-sha256': digest(lastChunk) },
    }))).status, 200)
    const rejected = await routes.get('/api/canvas/v2/upload-complete').fetch(new Request(`http://localhost/api/canvas/v2/upload-complete?canvas=${id}`, {
      method: 'POST', body: JSON.stringify({ id: uploadId }),
    }))
    assert.equal(rejected.status, 415); assert.equal((await rejected.json()).code, 'UNSUPPORTED_MEDIA')
    assert.equal((await routes.get('/api/canvas/v2/upload-cancel').fetch(new Request(`http://localhost/api/canvas/v2/upload-cancel?canvas=${id}`, {
      method: 'POST', body: JSON.stringify({ id: uploadId }),
    }))).status, 200)
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
    const sourcePaths = [...await files('src'), ...await files('scripts'), ...await files('tests'), ...await files('docs'), ...await files('designs'), 'README.md', 'AGENTS.md', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.base.json', 'tsconfig.host.json', 'tsconfig.client.json', 'vitest.config.ts', 'cordis.patch.yml']
    const source = await hashes(sourcePaths)
    const manifest = { name: pkg.name, version: pkg.version, node: process.version, npm: execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim(), source, sourceHash: digest(JSON.stringify(source)), lib, libHash: digest(JSON.stringify(lib)), reproducible: true, compiledHostSmoke: 'passed' }
    await writeFile(`${pkg.name}-${pkg.version}.manifest.json`, JSON.stringify(manifest, null, 2))
    console.log(`Reproducible lib ${manifest.libHash}; compiled Host/Worker/schema startup passed`)
  } finally {
    for (const dispose of cleanup.reverse()) await dispose()
    await rm(dataDir, { recursive: true, force: true })
  }
}
