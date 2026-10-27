import { createHash, randomUUID } from 'node:crypto'
import { readdir, readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

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
    assert.equal(create.status, 200)
    const { id } = await create.json()
    const graph = await routes.get('/api/canvas/v2/graph').fetch(new Request(`http://localhost/api/canvas/v2/graph?canvas=${id}`))
    assert.equal(graph.status, 200); assert.equal((await graph.json()).graphRevision, 0)
    assert.equal(routes.size, 17)
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
