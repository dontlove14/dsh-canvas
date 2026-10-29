import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { CanvasService } from '../src/host/service'
import { fakeFactory, initialize, cloudPath, remoteBody, storageInput } from './support/objectStorage'
import { Store } from '../src/host/store'
import { apply } from '../src/host/index'
import { assetToken } from '../src/shared/promptMentions'
import { emptyGraph, defaultParams, validateGraph, type CanvasNode, type Task, type CanvasGraph, type ModelInput } from '../src/shared/contracts'

// A real 1×1 PNG; video fixture only exercises streaming/range transport.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZAAAAABJRU5ErkJggg==', 'base64')
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom0000isommp42'), Buffer.alloc(80)])
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })
async function temp() { const path = await mkdtemp(join(tmpdir(), 'dsh-canvas-test-')); cleanup.push(() => rm(path, { force: true, recursive: true })); return path }
async function stub(handler: Parameters<typeof createServer>[0]) {
  const server = createServer(handler as any)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }))
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
}
async function service(dataDir?: string) {
  const root = dataDir ?? await temp()
  const instance = new CanvasService({ dataDir: root, maxConcurrentTasks: 2, pollIntervalMs: 50, requestTimeoutMs: 1500, maxMediaBytes: 1024 * 1024, maxReferenceBytes: 256 * 1024 }, undefined, fakeFactory(root))
  await initialize(instance, true); cleanup.push(() => instance.close()); return instance
}
async function model(instance: CanvasService, base: string, kind: 'image' | 'video' = 'image', key = 'secret-test-key') {
  // Seed a retained pre-catalog configuration to exercise legacy task protocols.
  // New user configuration goes through the fixed catalog, tested in imageModels.
  const record = { id: randomUUID(), kind, name: `${kind} model`, model_id: kind === 'image' ? 'gpt-image-1' : 'sora-2', protocol: kind === 'image' ? 'openai-image' as const : 'openai-video' as const, api_base: base }
  const store = instance.store as any
  store.models.push(record); store.bindings[record.id] = await store.vault.put(key); store.keys[record.id] = key
  await writeFile(join(instance.config.dataDir, 'models.json'), JSON.stringify(store.models), { mode: 0o600 })
  await writeFile(join(instance.config.dataDir, 'model-bindings.json'), JSON.stringify(store.bindings), { mode: 0o600 })
  return instance.store.listModels().find((item) => item.id === record.id)!
}
function node(kind: CanvasNode['kind'] = 'image-generation'): CanvasNode {
  return { id: randomUUID(), kind, title: '测试节点', position: { x: 0, y: 0 }, modelId: null, prompt: 'a tree', params: null, assetId: null, selectedResultId: null }
}
async function addGenerator(instance: CanvasService, base: string, kind: 'image' | 'video' = 'image') {
  const config = await model(instance, base, kind)
  const generator = { ...node(`${kind}-generation`), modelId: config.id, params: defaultParams(config) }
  const graph = emptyGraph(); graph.nodes.push(generator)
  const state = await instance.saveGraph('w', graph, 0)
  return { config, generator, state }
}
async function waitFor(instance: CanvasService, id: string, status: Task['status']) {
  const start = Date.now()
  for (;;) {
    const task = instance.store.state('w').tasks.find((task) => task.id === id)
    if (task?.status === status) return task
    if (Date.now() - start > 8000) throw new Error(`Expected ${status}, got ${task?.status}: ${task?.error}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}
function request(path: string, method = 'GET', body?: unknown) {
  return new Request(`http://localhost/api/canvas/v2/${path}`, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
}
async function upload(instance: CanvasService, bytes: Buffer | string, kind = 'image') {
  await instance.store.ensureCanvas('w')
  const session = await (await instance.handle(request('upload-start?canvas=w', 'POST', { requestId: randomUUID(), filename: 'reference.png', kind, position: { x: -420, y: 0 } }))).json()
  return instance.handle(new Request(`http://localhost/api/canvas/v2/upload?canvas=w&kind=${kind}&id=${session.id}`, { method: 'POST', body: bytes, headers: { 'x-canvas-filename': 'reference.png' } }))
}
async function waitImport(instance: CanvasService, taskId: string) {
  for (let i = 0; i < 100; i++) {
    const output = await instance.store.db.get('SELECT asset_id FROM task_outputs WHERE task_id=?', [taskId])
    if (output) return instance.store.state('w').assets.find((a) => a.id === output.asset_id)!
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('Import did not complete')
}

describe('local configuration and graph writes', () => {
  it('never returns full saved keys in model lists, preserves blank edits and uses restricted files', async () => {
    const instance = await service()
    const config = await model(instance, 'http://localhost/v1')
    const response = await (await instance.handle(request('models'))).text()
    expect(response).not.toContain('secret-test-key')
    expect(response).toContain('sec********key')
    await instance.store.saveModel({ id: config.id, kind: config.kind, name: config.name, model_id: config.model_id, api_base: config.api_base, protocol: config.protocol })
    expect(instance.store.model(config.id).key).toBe('secret-test-key')
    const contents = await readFile(join(instance.config.dataDir, 'models.json'), 'utf8')
    expect(contents).not.toContain('secret-test-key')
    const binding = instance.store.model(config.id).credentialRef
    expect((await stat(join(instance.config.dataDir, 'vault', `${binding}.json`))).mode & 0o777).toBe(0o600)
    expect(await instance.store.db.get("SELECT COUNT(*) AS count FROM task_details WHERE credential_ref LIKE '%secret%'")).toMatchObject({ count: 0 })
    await instance.store.saveModel({ id: config.id, kind: config.kind, name: config.name, model_id: config.model_id, api_base: config.api_base, protocol: config.protocol, api_key: '' })
    expect(instance.store.model(config.id).key).toBe('')
  })
  it('rejects stale graph saves and retains the committed graph', async () => {
    const instance = await service()
    const graph = emptyGraph(); graph.nodes.push(node())
    await instance.saveGraph('w', graph, 0)
    await expect(instance.saveGraph('w', emptyGraph(), 0)).rejects.toMatchObject({ code: 'GRAPH_CONFLICT' })
    expect(instance.store.state('w').graph.nodes).toHaveLength(1)
  })
  it('isolates workspaces and refuses a second writer', async () => {
    const instance = await service()
    const graph = emptyGraph(); graph.nodes.push(node())
    await instance.saveGraph('../workspace/秘密', graph, 0)
    expect(instance.store.state('other').graph.nodes).toHaveLength(0)
    const other = new Store(instance.config.dataDir)
    await expect(other.init()).rejects.toMatchObject({ code: 'STORE_LOCKED' })
  })
  it('does not expose invalid API keys through validation errors', async () => {
    const instance = await service()
    const response = await instance.handle(request('models', 'POST', { api_key: 'raw-new-key', kind: 'image' }))
    expect(response.status).toBe(400)
    expect(await response.text()).not.toContain('raw-new-key')
  })
})

describe('generation protocol and task state', () => {
  it('saves image results locally and graph saves cannot erase them', async () => {
    let calls = 0
    const base = await stub(async (req: any, res: any) => {
      calls++; expect(req.headers.authorization).toBe('Bearer secret-test-key')
      let text = ''; for await (const chunk of req) text += chunk
      expect(JSON.parse(text)).toMatchObject({ model: 'gpt-image-1', prompt: 'a tree', n: 1 })
      expect(JSON.parse(text)).not.toHaveProperty('response_format')
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }))
    })
    const instance = await service()
    const { generator, state } = await addGenerator(instance, base)
    const requestId = randomUUID()
    const task = await instance.generate('w', generator.id, state.graphRevision, requestId)
    expect((await instance.generate('w', generator.id, state.graphRevision, requestId)).id).toBe(task.id)
    await expect(instance.store.deleteModel(generator.modelId!)).rejects.toMatchObject({ code: 'MODEL_IN_USE' })
    const completed = await waitFor(instance, task.id, 'completed')
    expect(calls).toBe(1); expect(completed.resultIds).toHaveLength(1)
    expect(await instance.store.readMedia(completed.resultIds[0], 1024)).toEqual(png)
    await instance.saveGraph('w', state.graph, state.graphRevision)
    expect(instance.store.state('w').assets).toHaveLength(1)
    expect(instance.store.state('w').tasks[0].status).toBe('completed')
    expect(JSON.stringify(instance.store.state('w'))).not.toContain('secret-test-key')
    const detail = await instance.store.taskDetail('w', task.id)
    expect(detail.successAt).toBeGreaterThan(0)
    expect(detail.phase).toBe('completed')
    expect(JSON.stringify(detail)).not.toContain('secret-test-key')
  })
  it.each(['image', 'video'] as const)('accepts another %s while the first is running and preserves both results when the newest finishes first', async (kind) => {
    let posts = 0, finishFirst = () => {}
    const base = await stub(async (req: any, res: any) => {
      if (req.method === 'POST') {
        posts++
        let body = ''; for await (const chunk of req) body += chunk
        const first = JSON.parse(body).prompt === 'a tree'
        const finish = () => res.end(JSON.stringify(kind === 'image' ? { data: [{ b64_json: png.toString('base64') }] }
          : { id: first ? 'first-video' : 'second-video', status: 'queued' }))
        if (first) finishFirst = finish
        else finish()
      } else if (req.url.endsWith('/content')) res.end(mp4)
      else res.end(JSON.stringify({ id: req.url.includes('first-video') ? 'first-video' : 'second-video', status: 'completed' }))
    })
    const instance = await service(); const { generator, state } = await addGenerator(instance, base, kind)
    const requestId = randomUUID()
    const first = await instance.generate('w', generator.id, state.graphRevision, requestId)
    await waitFor(instance, first.id, 'generating')
    const current = instance.store.state('w')
    const saved = await instance.saveGraph('w', { ...current.graph, nodes: current.graph.nodes.map((node) => ({ ...node, prompt: 'a mountain' })) }, current.graphRevision)
    const second = await instance.generate('w', generator.id, saved.graphRevision)
    const completedSecond = await waitFor(instance, second.id, 'completed')
    expect(instance.store.state('w').tasks.find((task) => task.id === first.id)?.status).toBe('generating')
    await expect(instance.saveGraph('w', emptyGraph(), instance.store.state('w').graphRevision)).rejects.toMatchObject({ code: 'NODE_BUSY' })
    expect((await instance.generate('w', generator.id, state.graphRevision, requestId)).id).toBe(first.id)
    finishFirst()
    const completedFirst = await waitFor(instance, first.id, 'completed')
    expect(posts).toBe(2)
    expect(completedFirst.snapshot.prompt).toBe('a tree'); expect(completedSecond.snapshot.prompt).toBe('a mountain')
    expect(new Set([...completedFirst.resultIds, ...completedSecond.resultIds]).size).toBe(2)
    const snapshot = await instance.store.snapshot('w')
    expect(snapshot.tasks.map((task) => task.id)).toEqual([first.id, second.id])
    expect(snapshot.tasks[0].requestId).toBe(requestId)
    expect(snapshot.assets.map((asset) => asset.taskId).sort()).toEqual([first.id, second.id].sort())
  })
  it.each(['image', 'video'] as const)('pins each queued %s snapshot, model key, reference and storage target separately', async (kind) => {
    const instance = await service(); const { generator } = await addGenerator(instance, 'http://127.0.0.1:1/v1', kind)
    const imported = await (await upload(instance, png)).json()
    const reference = await waitImport(instance, imported.taskId)
    await instance.runtime.close()
    const ddl = await instance.store.db.all("SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name")
    const current = instance.store.state('w')
    const source = current.graph.nodes.find((node) => node.id === imported.nodeId)!
    const edge = { id: randomUUID(), source: source.id, target: generator.id, assetId: reference.id }
    const saved = await instance.saveGraph('w', { ...current.graph, edges: [edge] }, current.graphRevision)
    const oldTarget = (await instance.store.storage()).activeProviderId
    const first = await instance.generate('w', generator.id, saved.graphRevision)
    const config = await model(instance, 'http://127.0.0.1:2/v1', kind, 'second-model-key')
    const revision = (await instance.store.storage()).revision
    await instance.store.setStorage(storageInput(revision, 'new-task-bucket'))
    const graph = instance.store.state('w')
    const secondInput = await instance.saveGraph('w', { ...graph.graph, edges: [], nodes: graph.graph.nodes.map((node) =>
      node.id === generator.id ? { ...node, modelId: config.id, params: { ...defaultParams(config), size: kind === 'image' ? '1536x1024' : '1280x720' }, prompt: 'new prompt' } : node) }, graph.graphRevision)
    const requestId = randomUUID()
    const [second, replay] = await Promise.all([instance.generate('w', generator.id, secondInput.graphRevision, requestId), instance.generate('w', generator.id, secondInput.graphRevision, requestId)])
    expect(second.id).toBe(replay.id)
    expect(first.snapshot).toMatchObject({ prompt: 'a tree', model: { id: generator.modelId }, referenceIds: [reference.id] })
    expect(second.snapshot).toMatchObject({ prompt: 'new prompt', model: { id: config.id }, referenceIds: [] })
    expect((await instance.store.taskPrivate(first.id)).key).toBe('secret-test-key')
    expect((await instance.store.taskPrivate(second.id)).key).toBe('second-model-key')
    const targetSql = 'SELECT l.root_id FROM storage_targets t JOIN canvas_storage_locations l ON l.canvas_id=t.canvas_id AND l.id=t.storage_id WHERE t.task_id=?'
    expect(await instance.store.db.get(targetSql, [first.id])).toEqual({ root_id: oldTarget })
    expect(await instance.store.db.get(targetSql, [second.id])).toEqual({ root_id: (await instance.store.storage()).activeProviderId })
    await instance.store.update('w', (state) => { state.tasks.find((task) => task.id === second.id)!.status = 'failed' })
    await expect(instance.saveGraph('w', emptyGraph(), instance.store.state('w').graphRevision)).rejects.toMatchObject({ code: 'NODE_BUSY' })
    expect(await instance.store.db.all("SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name")).toEqual(ddl)
  })
  it('uses multipart edits for image references without rebinding old edges', async () => {
    let multipart = ''
    const base = await stub(async (req: any, res: any) => {
      expect(req.url).toBe('/v1/images/edits')
      expect(req.headers['content-type']).toContain('multipart/form-data')
      for await (const chunk of req) multipart += chunk.toString()
      res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }))
    })
    const instance = await service()
    const { generator, state } = await addGenerator(instance, base)
    const accepted = await (await upload(instance, png)).json()
    const asset = await waitImport(instance, accepted.taskId)
    const current = instance.store.state('w')
    const resource = current.graph.nodes.find((n) => n.id === accepted.nodeId)!
    const prompt = `参考${assetToken(asset.id)}画一棵树`
    const graph = { ...current.graph, nodes: current.graph.nodes.map((node) => node.id === generator.id ? { ...node, prompt } : node), edges: [{ id: randomUUID(), source: resource.id, target: generator.id, assetId: asset.id }] }
    const saved = await instance.saveGraph('w', graph, current.graphRevision)
    const task = await instance.generate('w', generator.id, saved.graphRevision)
    await waitFor(instance, task.id, 'completed')
    expect(multipart).toContain('name="image[]"')
    expect(multipart).toContain('参考[参考图1]画一棵树')
    expect(multipart).not.toContain(assetToken(asset.id))
    expect(task.snapshot.prompt).toBe('参考[参考图1]画一棵树')
    expect(instance.store.state('w').graph.nodes.find((node) => node.id === generator.id)?.prompt).toBe(prompt)
    expect(instance.store.state('w').graph.edges[0].assetId).toBe(asset.id)
  })
  it('polls video jobs and downloads content with the original credentials', async () => {
    let posts = 0; let polls = 0
    const base = await stub(async (req: any, res: any) => {
      expect(req.headers.authorization).toBe('Bearer secret-test-key')
      if (req.method === 'POST') {
        posts++; let text = ''; for await (const chunk of req) text += chunk
        expect(JSON.parse(text).seconds).toBe('4')
        res.end(JSON.stringify({ id: 'video-1', status: 'queued' }))
      } else if (req.url.endsWith('/content')) { res.setHeader('content-type', 'video/mp4'); res.end(mp4) }
      else { polls++; res.end(JSON.stringify({ id: 'video-1', status: polls === 1 ? 'in_progress' : 'completed', progress: polls === 1 ? 50 : 100 })) }
    })
    const instance = await service()
    const { generator, state } = await addGenerator(instance, base, 'video')
    const task = await instance.generate('w', generator.id, state.graphRevision)
    const completed = await waitFor(instance, task.id, 'completed')
    expect(posts).toBe(1); expect(polls).toBe(2)
    const response = await instance.handle(new Request(`http://localhost/api/canvas/v2/media?canvas=w&id=${completed.resultIds[0]}`, { headers: { range: 'bytes=4-11' } }))
    expect(response.status).toBe(307)
    expect((await remoteBody(instance.store, response)).subarray(4, 12)).toEqual(mp4.subarray(4, 12))
  })
  it('marks no-result submissions failed, unlocks the node and never automatically submits again', async () => {
    let calls = 0
    const base = await stub((_req: any, res: any) => { calls++; res.writeHead(503); res.end(JSON.stringify({ error: { message: 'timeout secret-test-key' } })) })
    const instance = await service()
    const { generator, state } = await addGenerator(instance, base)
    const task = await instance.generate('w', generator.id, state.graphRevision)
    const failed = await waitFor(instance, task.id, 'failed')
    expect(failed.error).not.toContain('secret-test-key')
    await new Promise((resolve) => setTimeout(resolve, 550)); expect(calls).toBe(1)
    await instance.saveGraph('w', emptyGraph(), state.graphRevision)
  })
  it('definitive provider errors are redacted and unlock the node', async () => {
    const base = await stub((_req: any, res: any) => { res.writeHead(400); res.end(JSON.stringify({ error: { message: 'bad secret-test-key Bearer secret-other' } })) })
    const instance = await service()
    const { generator, state } = await addGenerator(instance, base)
    const task = await instance.generate('w', generator.id, state.graphRevision)
    const failed = await waitFor(instance, task.id, 'failed')
    expect(failed.error).not.toContain('secret-test-key'); expect(failed.error).not.toContain('secret-other')
    await instance.store.deleteModel(generator.modelId!)
  })
  it.each([{}, { data: [] }, { data: [{ b64_json: 'not-an-image' }] }])('ends a successful HTTP response with no usable output as failed', async (body) => {
    let calls = 0
    const base = await stub((_req: any, res: any) => { calls++; res.end(JSON.stringify(body)) })
    const instance = await service(), { generator, state } = await addGenerator(instance, base)
    const task = await instance.generate('w', generator.id, state.graphRevision)
    expect((await waitFor(instance, task.id, 'failed')).resultIds).toEqual([])
    await new Promise((resolve) => setTimeout(resolve, 350))
    expect(calls).toBe(1); expect((await instance.store.taskPrivate(task.id)).issued).toBe(true)
  })
  it('retries downloading the same result without another paid submission', async () => {
    let posts = 0; let downloads = 0; let base = ''
    base = await stub((req: any, res: any) => {
      if (req.method === 'POST') { posts++; res.end(JSON.stringify({ data: [{ url: `${base}/image-result` }] })) }
      else {
        expect(req.headers.authorization).toBeUndefined()
        downloads++; if (downloads === 1) { res.writeHead(500); res.end('failed') } else res.end(png)
      }
    })
    const instance = await service()
    const { generator, state } = await addGenerator(instance, base)
    const task = await instance.generate('w', generator.id, state.graphRevision)
    await waitFor(instance, task.id, 'save_failed')
    const failed = await instance.store.taskDetail('w', task.id)
    expect(failed.externalCompletedAt).toBeGreaterThan(0)
    expect(failed.failureStage).toBe('storage')
    await instance.taskAction('w', task.id, 'retry-save')
    await waitFor(instance, task.id, 'completed')
    expect(posts).toBe(1); expect(downloads).toBe(2)
    expect((await instance.store.taskDetail('w', task.id)).attempts.some((a) => a.outcome === 'failed')).toBe(true)
  })
  it('allows explicitly resuming a failed video query without submitting again', async () => {
    let posts = 0; let polls = 0
    const base = await stub((req: any, res: any) => {
      if (req.method === 'POST') { posts++; res.end(JSON.stringify({ id: 'query-video', status: 'queued' })) }
      else if (req.url.endsWith('/content')) res.end(mp4)
      else {
        polls++
        if (polls === 1) { res.writeHead(401); res.end(JSON.stringify({ error: { message: 'temporary permission issue' } })) }
        else res.end(JSON.stringify({ id: 'query-video', status: 'completed' }))
      }
    })
    const instance = await service()
    const { generator, state } = await addGenerator(instance, base, 'video')
    const task = await instance.generate('w', generator.id, state.graphRevision)
    const unknown = await waitFor(instance, task.id, 'unknown')
    expect(unknown.providerTaskId).toBe('query-video')
    await instance.taskAction('w', task.id, 'resume-query')
    await waitFor(instance, task.id, 'completed')
    expect(posts).toBe(1); expect(polls).toBe(2)
  })
  it('records external failure identity and reason separately from storage failures', async () => {
    const base = await stub((req: any, res: any) => {
      res.end(JSON.stringify(req.method === 'POST' ? { id: 'failed-video', status: 'queued' } : { id: 'failed-video', status: 'failed', error: { code: 'policy_rejected', message: 'external rejected secret-test-key' } }))
    })
    const instance = await service(); const { generator, state } = await addGenerator(instance, base, 'video')
    const task = await instance.generate('w', generator.id, state.graphRevision)
    await waitFor(instance, task.id, 'failed')
    expect(await instance.store.taskDetail('w', task.id)).toMatchObject({ externalTaskId: 'failed-video', phase: 'failed', failureStage: 'provider', failureCode: 'policy_rejected', successAt: null })
    expect(JSON.stringify(await instance.store.taskDetail('w', task.id))).not.toContain('secret-test-key')
  })
  it('preserves external completion when persisting the returned output fails', async () => {
    let posts = 0
    const base = await stub((_req: any, res: any) => { posts++; res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] })) })
    const instance = await service(); const { generator, state } = await addGenerator(instance, base)
    const write = instance.store.writeTaskPrivate.bind(instance.store)
    instance.store.writeTaskPrivate = async (id, data) => { if (data.outputs) throw new Error('simulated full staging disk'); await write(id, data) }
    const task = await instance.generate('w', generator.id, state.graphRevision)
    await waitFor(instance, task.id, 'save_failed')
    const detail = await instance.store.taskDetail('w', task.id)
    expect(detail.externalCompletedAt).toBeGreaterThan(0); expect(detail.failureStage).toBe('storage')
    await expect(instance.taskAction('w', task.id, 'retry-save')).rejects.toMatchObject({ code: 'RESULT_UNAVAILABLE' })
    expect(posts).toBe(1)
  })
  it('continues a committed generation after its HTTP request disconnects', async () => {
    const base = await stub(async (_req: any, res: any) => {
      await new Promise((resolve) => setTimeout(resolve, 150))
      res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }))
    })
    const instance = await service(); const { generator, state } = await addGenerator(instance, base)
    const controller = new AbortController()
    const response = await instance.handle(new Request('http://localhost/api/canvas/v2/generate?canvas=w', { method: 'POST', signal: controller.signal, body: JSON.stringify({ nodeId: generator.id, revision: state.graphRevision, requestId: randomUUID() }) }))
    expect(response.status).toBe(202)
    const accepted = await response.json(); controller.abort()
    await waitFor(instance, accepted.id, 'completed')
  })
  it('recovers the crash window between file publication and output relationship commit', async () => {
    let posts = 0
    const base = await stub((_req: any, res: any) => { posts++; res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] })) })
    const instance = await service(); const { generator, state } = await addGenerator(instance, base)
    const task = await instance.generate('w', generator.id, state.graphRevision)
    const completed = await waitFor(instance, task.id, 'completed'); const id = completed.resultIds[0]
    while (instance.runtime.isActive(task.id)) await new Promise((resolve) => setTimeout(resolve, 10))
    await instance.store.writeTaskPrivate(task.id, { key: 'secret-test-key', issued: true, outputs: [{ id, mime: 'image/png', filename: 'generated.png', url: 'http://127.0.0.1:1/must-not-fetch' }] })
    await instance.store.update('w', (current) => { current.assets = []; current.tasks[0].status = 'saving'; current.tasks[0].resultIds = [] })
    instance.runtime.wake()
    const recovered = await waitFor(instance, task.id, 'completed')
    expect(recovered.resultIds).toEqual([id]); expect(posts).toBe(1)
  })
})

describe('restart recovery', () => {
  it('recovers by video ID without another submission or newer model credentials', async () => {
    let posts = 0; let polls = 0
    const base = await stub((req: any, res: any) => {
      expect(req.headers.authorization).toBe('Bearer original-key')
      if (req.method === 'POST') posts++
      if (req.url.endsWith('/content')) res.end(mp4)
      else { polls++; res.end(JSON.stringify({ id: 'old-video', status: 'completed' })) }
    })
    const root = await temp()
    const original = await service(root)
    const config = await model(original, base, 'video', 'original-key')
    const generator = { ...node('video-generation'), modelId: config.id, params: defaultParams(config) }
    const task: Task = { id: randomUUID(), workspaceId: 'w', nodeId: generator.id, snapshot: { model: original.store.model(config.id).model, prompt: 'old prompt', params: generator.params!, referenceIds: [] }, status: 'queued', providerTaskId: 'old-video', resultIds: [], createdAt: Date.now(), updatedAt: Date.now() }
    await original.store.update('w', (state) => { state.graph.nodes.push(generator); state.tasks.push(task) })
    await original.store.writeTaskPrivate(task.id, { key: 'original-key', issued: true })
    await original.store.saveModel({ id: config.id, name: config.name, kind: config.kind, model_id: config.model_id, protocol: config.protocol, api_base: config.api_base, api_key: 'new-key' })
    await original.close()
    const recovered = await service(root)
    await waitFor(recovered, task.id, 'completed')
    expect(posts).toBe(0); expect(polls).toBe(1)
  })
  it.each(['submitted', 'unknown'] as const)('ends an interrupted %s submission as failed without network traffic or changing its snapshot', async (status) => {
    let calls = 0
    const base = await stub((_req: any, res: any) => { calls++; res.end('{}') })
    const root = await temp(); const original = await service(root)
    const { generator, config } = await addGenerator(original, base)
    const task: Task = { id: randomUUID(), workspaceId: 'w', nodeId: generator.id, snapshot: { model: original.store.model(config.id).model, prompt: 'prompt', params: generator.params!, referenceIds: [] }, status, resultIds: [], createdAt: Date.now(), updatedAt: Date.now(), ...(status === 'unknown' ? { error: 'Original timeout' } : {}) }
    await original.store.update('w', (state) => { state.tasks.push(task) })
    await original.store.writeTaskPrivate(task.id, { key: 'secret-test-key', issued: true })
    const detail = await original.store.taskDetail('w', task.id)
    const graph = original.store.state('w').graph
    await original.close()
    const recovered = await service(root)
    expect(recovered.store.state('w').tasks[0]).toMatchObject({ id: task.id, status: 'failed', snapshot: task.snapshot, createdAt: task.createdAt, resultIds: [] })
    expect(recovered.store.state('w').graph).toEqual(graph)
    expect(await recovered.store.taskPrivate(task.id)).toMatchObject({ key: 'secret-test-key', issued: true })
    expect((await recovered.store.taskDetail('w', task.id)).attempts).toEqual(detail.attempts)
    if (status === 'unknown') expect(recovered.store.state('w').tasks[0].error).toBe('Original timeout')
    await new Promise((resolve) => setTimeout(resolve, 350)); expect(calls).toBe(0)
  })
  it('keeps a queryable unknown external task and a save failure recoverable on restart', async () => {
    let calls = 0
    const base = await stub((_req: any, res: any) => { calls++; res.end('{}') })
    const root = await temp(), original = await service(root)
    const { generator, config } = await addGenerator(original, base)
    const snapshot = { model: original.store.model(config.id).model, prompt: 'prompt', params: generator.params!, referenceIds: [] }
    const query: Task = { id: randomUUID(), workspaceId: 'w', nodeId: generator.id, snapshot, status: 'unknown', providerTaskId: 'recoverable-id', resultIds: [], createdAt: 1, updatedAt: 1 }
    const save: Task = { ...query, id: randomUUID(), providerTaskId: undefined, status: 'save_failed' }
    await original.store.update('w', (state) => { state.tasks.push(query, save) })
    for (const task of [query, save]) await original.store.writeTaskPrivate(task.id, { key: 'secret-test-key', issued: true })
    const committed = original.store.state('w').tasks
    const catalog = await original.store.db.all('SELECT * FROM task_catalog ORDER BY queue_seq')
    const details = await original.store.db.all('SELECT * FROM task_details ORDER BY task_id')
    for (const task of committed) task.updatedAt = catalog.find((row) => row.id === task.id)!.updated_at
    await original.close()
    const recovered = await service(root)
    expect(recovered.store.state('w').tasks).toEqual(JSON.parse(JSON.stringify(committed)))
    expect(await recovered.store.db.all('SELECT * FROM task_catalog ORDER BY queue_seq')).toEqual(catalog)
    expect(await recovered.store.db.all('SELECT * FROM task_details ORDER BY task_id')).toEqual(details)
    await new Promise((resolve) => setTimeout(resolve, 350)); expect(calls).toBe(0)
  })
})

describe('media and plugin boundaries', () => {
  it('rejects SVG/non-media and oversized streamed uploads', async () => {
    const instance = await service()
    const invalid = await upload(instance, '<svg onload="alert(1)"/>')
    expect(invalid.status).toBe(415)
    const large = await upload(instance, Buffer.alloc(1024 * 1024 + 1))
    expect(large.status).toBe(413)
    expect(instance.store.state('w').assets).toHaveLength(0)
  })
  it('enforces asset ownership, unique references and cycles', () => {
    const first = { ...node('image-asset'), assetId: randomUUID() }; const second = node(); const third = node()
    const asset = { id: first.assetId!, kind: 'image' as const, mime: 'image/png', filename: 'a.png', bytes: 1, createdAt: 1, nodeId: null, taskId: null }
    const edge = { id: randomUUID(), source: first.id, target: second.id, assetId: asset.id }
    const graph = { ...emptyGraph(), nodes: [first, second, third], edges: [edge] }
    expect(() => validateGraph(graph, [asset], [])).not.toThrow()
    expect(() => validateGraph({ ...graph, edges: [edge, { ...edge, id: randomUUID() }] }, [asset], [])).toThrow('重复引用')
    expect(() => validateGraph({ ...graph, edges: [{ ...edge, source: third.id }] }, [asset], [])).toThrow('不属于')
    expect(() => validateGraph({ ...graph, nodes: [first, second, second] }, [asset], [])).toThrow('重复节点')
  })
  it('registers authenticated Harness routes with supported methods and disposes them', async () => {
    const paths: string[] = []; const disposers: Array<() => unknown> = []; const removed: string[] = []
    const context = {
      effect: (setup: () => () => unknown) => { disposers.push(setup()) },
      credentials: { readRecord: async () => undefined, modifyRecord: async (_key: string, mutate: any) => mutate(undefined) },
      connection: { fetch: { register: (route: any) => { paths.push(route.path); expect(route.methods.every((method: string) => ['GET', 'HEAD', 'POST'].includes(method))).toBe(true); return async () => { removed.push(route.path) } } } },
    }
    await apply(context as any, { dataDir: await temp() })
    expect(paths).toContain('/api/canvas/v2/media'); expect(paths).toContain('/api/canvas/v2/upload')
    for (const dispose of disposers.reverse()) await dispose()
    expect(removed).toHaveLength(paths.length)
  })
})
