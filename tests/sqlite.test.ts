import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { CanvasService } from '../src/host/service'
import { fakeFactory, initialize, cloudPath, storageInput } from './support/objectStorage'
import { Store } from '../src/host/store'
import { LocalVault } from '../src/host/credentials'
import { hash, sql } from '../src/host/persistence/database'
import { checkedDirectory, copyVerified, fileHash } from '../src/host/media/files'
import { emptyGraph, defaultParams, type CanvasNode, type WorkspaceState } from '../src/shared/contracts'
import type { GraphMutation } from '../src/shared/v2'
import { MOCK_MODELS, mockRecord } from '../src/shared/mockModels'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZAAAAABJRU5ErkJggg==', 'base64')
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })
async function temp() { const path = await mkdtemp(join(tmpdir(), 'canvas-sqlite-')); cleanup.push(() => rm(path, { force: true, recursive: true })); return path }
async function service() {
  const root = await temp()
  const instance = new CanvasService({ dataDir: root, maxConcurrentTasks: 2, pollIntervalMs: 50, requestTimeoutMs: 1000, maxMediaBytes: 1024 * 1024, maxReferenceBytes: 1024 * 1024 }, undefined, fakeFactory(root))
  await initialize(instance); cleanup.push(() => instance.close())
  await instance.store.ensureCanvas('w')
  return instance
}
function node(): CanvasNode {
  return { id: randomUUID(), kind: 'image-generation', title: '生成节点', position: { x: 0, y: 0 }, modelId: null, prompt: '', params: null, assetId: null, selectedResultId: null }
}
function mutation(revision: number, nodes: CanvasNode[] = []): GraphMutation {
  return { mutationId: randomUUID(), baseRevision: revision, nodes: nodes.map((value) => ({ value, hash: hash(value) })), edges: [], deleteNodes: [], deleteEdges: [] }
}
async function asset(instance: CanvasService) {
  const resource = { ...node(), kind: 'image-asset' as const, title: '原素材' }
  await instance.store.update('w', (state) => { state.graph.nodes.push(resource) })
  const result = await instance.store.saveMedia(Readable.from([png]), { id: randomUUID(), kind: 'image', filename: 'source.png', nodeId: resource.id, taskId: null, createdAt: 1 }, 1024, 'image')
  await instance.store.update('w', (state) => { state.assets.push(result); state.graph.nodes[0].assetId = result.id })
  return { resource, result }
}

describe('SQLite atomic deltas and identities', () => {
  it('upgrades the old active-task index atomically, preserves schema-3 records and reopens with multiple pending tasks', async () => {
    const instance = await service(); await instance.runtime.close()
    const { result } = await asset(instance)
    const generator = { ...node(), modelId: MOCK_MODELS[0].id, params: defaultParams(MOCK_MODELS[0]), prompt: 'old draft' }
    const current = instance.store.state('w')
    await instance.saveGraph('w', { ...current.graph, nodes: [...current.graph.nodes, generator] }, current.graphRevision)
    const first = { id: randomUUID(), nodeId: generator.id, workspaceId: 'w', status: 'submitted' as const, resultIds: [],
      snapshot: { model: mockRecord(generator.modelId), prompt: generator.prompt, params: generator.params, referenceIds: [] }, createdAt: 1, updatedAt: 1 }
    await instance.store.update('w', (state) => { state.tasks.push(first) })
    await instance.store.db.batch([
      sql('DROP INDEX task_active_node'),
      sql("CREATE UNIQUE INDEX task_active_node ON task_catalog(canvas_id,node_id) WHERE status IN ('queued','running','external_wait','saving','needs_attention','save_failed')"),
    ])
    const tables = await instance.store.db.all("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name")
    const before = await instance.store.snapshot('w')
    before.tasks[0].updatedAt = (await instance.store.db.get('SELECT updated_at FROM task_catalog WHERE id=?', [first.id])).updated_at
    const root = instance.config.dataDir
    await instance.close()
    const reopened = new Store(root, undefined, fakeFactory(root)); await reopened.init(); cleanup.push(() => reopened.close())
    expect(await reopened.snapshot('w')).toEqual(before)
    expect(await reopened.readMedia(result.id, 1024)).toEqual(png)
    expect(await reopened.db.get('PRAGMA user_version')).toEqual({ user_version: 3 })
    expect(await reopened.db.all("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name")).toEqual(tables)
    expect((await reopened.db.all("PRAGMA index_list('task_catalog')")).find((index) => index.name === 'task_active_node').unique).toBe(0)
    await reopened.update('w', (state) => { state.tasks.push({ ...first, id: randomUUID(), createdAt: 2, snapshot: { ...first.snapshot, prompt: 'second draft' } }) })
    const both = await reopened.snapshot('w')
    both.tasks[1].updatedAt = (await reopened.db.get('SELECT updated_at FROM task_catalog WHERE id=?', [both.tasks[1].id])).updated_at
    await reopened.close()
    const again = new Store(root, undefined, fakeFactory(root)); await again.init(); cleanup.push(() => again.close())
    expect(await again.snapshot('w')).toEqual(both)
    expect(both.tasks).toHaveLength(2)
    expect(await again.db.all("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name")).toEqual(tables)
  })
  it('changes only edited rows and chains user/host commits, including no-op and replay', async () => {
    const instance = await service(); const first = node(); const second = node()
    const initial = await instance.mutateGraph('w', mutation(0, [first, second]))
    const edit = mutation(1, [{ ...first, position: { x: 5, y: 8 } }])
    const saved = await instance.mutateGraph('w', edit)
    const rows = await instance.store.db.all('SELECT id,row_version FROM canvas_nodes WHERE canvas_id=?', ['w'])
    expect(rows.find((r) => r.id === first.id).row_version).toBe(1)
    expect(rows.find((r) => r.id === second.id).row_version).toBe(0)
    expect((await instance.store.graphChanges('w', 1)).changes[0].prevCommitHash).toBe(initial.commitHash)
    const noop = await instance.mutateGraph('w', mutation(2, [{ ...first, position: { x: 5, y: 8 } }]))
    expect(noop.graphRevision).toBe(2); expect(noop.commitHash).toBe(saved.commitHash)
    await instance.store.update('w', (state) => { state.graph.viewport.x = 10 })
    const replay = await instance.mutateGraph('w', edit)
    expect(replay.graphRevision).toBe(3)
    expect(replay.mutation).toMatchObject({ replay: true, revision: 2, commitHash: saved.commitHash })
    const deltas = await instance.store.graphChanges('w', 0)
    expect(deltas.changes.map((r: any) => r.actor)).toEqual(['user', 'user', 'host'])
    for (const entry of deltas.changes) expect(entry.commitHash).toBe(hash({ prevCommitHash: entry.prevCommitHash, revision: entry.revision, changes: entry.changes }))
  })
  it('rejects invalid hash, stale revision and reused request identity without publishing drafts', async () => {
    const instance = await service(); const change = mutation(0, [node()])
    await instance.mutateGraph('w', change)
    await expect(instance.mutateGraph('w', { ...change, nodes: [] })).rejects.toMatchObject({ code: 'REQUEST_REUSED' })
    await expect(instance.mutateGraph('w', mutation(0, [node()]))).rejects.toMatchObject({ code: 'GRAPH_CONFLICT' })
    const bad = mutation(1, [node()]); bad.nodes[0].hash = '0'.repeat(64)
    await expect(instance.mutateGraph('w', bad)).rejects.toMatchObject({ code: 'HASH_MISMATCH' })
    expect(instance.store.state('w').graph.nodes).toHaveLength(1)
  })
  it('rolls back every SQL statement on FK or CAS failure and fences a superseded writer', async () => {
    const instance = await service()
    await expect(instance.store.db.batch([
      sql('UPDATE canvases SET name=? WHERE id=?', ['should rollback', 'w']),
      sql('UPDATE canvases SET folder_id=? WHERE id=?', [randomUUID(), 'w']),
    ])).rejects.toThrow('FOREIGN KEY')
    expect((await instance.store.catalog()).canvases[0].name).toBe('w')
    await expect(instance.store.db.batch([
      sql('UPDATE canvases SET name=? WHERE id=?', ['should rollback', 'w']),
      sql('UPDATE canvases SET graph_revision=5 WHERE id=? AND graph_revision=9', ['w'], 'run', 1),
    ])).rejects.toThrow('CAS_CONFLICT')
    expect((await instance.store.catalog()).canvases[0].name).toBe('w')
    await instance.store.db.batch([sql('UPDATE owner_settings SET runtime_token=?', ['other-runtime'])], true, true)
    await expect(instance.store.db.batch([sql('UPDATE canvases SET name=? WHERE id=?', ['fenced', 'w'])])).rejects.toThrow('WRITER_FENCED')
  })
  it('enforces one-level directory uniqueness, revisions, receipt reuse and nonempty folders', async () => {
    const instance = await service()
    const folder = await instance.store.catalogCommand({ operation: 'folder-create', name: '素材', requestId: randomUUID() })
    await expect(instance.store.catalogCommand({ operation: 'folder-create', name: '素材', requestId: randomUUID() })).rejects.toMatchObject({ code: 'NAME_EXISTS' })
    const input = { operation: 'canvas-create', name: '画布', folderId: folder.id, requestId: randomUUID() }
    const canvas = await instance.store.catalogCommand(input)
    expect(await instance.store.catalogCommand(input)).toEqual(canvas)
    await expect(instance.store.catalogCommand({ ...input, name: '其他' })).rejects.toMatchObject({ code: 'REQUEST_REUSED' })
    await expect(instance.store.catalogCommand({ operation: 'folder-delete', id: folder.id, revision: 0, requestId: randomUUID() })).rejects.toMatchObject({ code: 'FOLDER_NOT_EMPTY' })
    await instance.store.catalogCommand({ operation: 'canvas-delete', id: canvas.id, revision: 0, requestId: randomUUID() })
    await instance.store.catalogCommand({ operation: 'folder-delete', id: folder.id, revision: 0, requestId: randomUUID() })
    expect((await instance.store.catalog()).folders).toHaveLength(0)
  })
  it('rejects cross-canvas asset references inside the database', async () => {
    const instance = await service(); const { result } = await asset(instance)
    await instance.store.ensureCanvas('other')
    await expect(instance.store.db.batch([sql('INSERT INTO canvas_edges(canvas_id,id,asset_id,sort_order,content_hash,created_at,updated_at) VALUES(?,?,?,0,?,0,0)', ['other', randomUUID(), result.id, hash({})])])).rejects.toThrow('FOREIGN KEY')
  })
  it('ships all relational tables/indexes and returns JSON for missing media and incremental reads', async () => {
    const instance = await service()
    expect(await instance.store.db.get("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")).toMatchObject({ count: 23 })
    expect(await instance.store.db.get("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='index' AND sql IS NOT NULL")).toMatchObject({ count: 39 })
    const { result } = await asset(instance)
    await rm(await cloudPath(instance.store, result.id))
    const response = await instance.handle(new Request(`http://localhost/api/canvas/v2/media?canvas=w&id=${result.id}`))
    expect(response.status).toBe(307)
    await expect(instance.store.readMedia(result.id, 1024)).rejects.toMatchObject({ code: 'OBJECT_CHANGED' })
    const changes = await instance.handle(new Request('http://localhost/api/canvas/v2/graph?canvas=w&afterRevision=0'))
    expect((await changes.json()).changes).toHaveLength(2)
  })
})

describe('durable files, uploads and migration', () => {
  it('keeps IDs and original bytes through successive renames, supersedes stale moves and restores paths', async () => {
    const instance = await service(); const { result } = await asset(instance); const original = await cloudPath(instance.store, result.id)
    await instance.store.update('w', (state) => { state.graph.nodes[0].title = '第一次改名' })
    await instance.store.update('w', (state) => { state.graph.nodes[0].title = '最终名称' })
    await instance.store.runMoves()
    expect(await readFile(original)).toEqual(png)
    expect(await instance.store.readMedia(result.id, 1024)).toEqual(png)
    expect((await instance.store.locator('w', result.id)).objectKey).toContain('最终名称')
    expect(await instance.store.db.get("SELECT COUNT(*) AS count FROM file_operation_items WHERE state='superseded'")).toMatchObject({ count: 1 })
    const provider = (await instance.store.locator('w', result.id)).providerId
    await instance.store.setStorage(storageInput(1, 'second-bucket'))
    await instance.store.runMoves()
    expect((await instance.store.locator('w', result.id)).providerId).toBe(provider)
    const dataRoot = instance.config.dataDir; await instance.close()
    const restored = new Store(dataRoot, undefined, fakeFactory(dataRoot)); await restored.init(); cleanup.push(() => restored.close())
    expect(restored.state('w').assets[0].id).toBe(result.id)
    expect(await restored.readMedia(result.id, 1024)).toEqual(png)
  })
  it('never replaces foreign bytes and rejects directory symlinks outside the media root', async () => {
    const root = await temp(); const outside = await temp()
    const source = join(root, 'a.png'); const target = join(root, 'b.png')
    await writeFile(source, png); await writeFile(target, 'foreign')
    await expect(copyVerified(source, target, await fileHash(source))).rejects.toMatchObject({ code: 'FILE_COLLISION' })
    expect(await readFile(target, 'utf8')).toBe('foreign')
    await symlink(outside, join(root, 'escape'))
    await expect(checkedDirectory(root, 'escape')).rejects.toMatchObject({ code: 'UNSAFE_PATH' })
  })
  it('deduplicates upload starts, commits import ownership, and completes with no request lifecycle', async () => {
    const instance = await service()
    const input = { requestId: randomUUID(), filename: '声音.png', kind: 'image' as const, position: { x: 2, y: 3 } }
    const session = await instance.runtime.uploads.start('w', input)
    expect(await instance.runtime.uploads.start('w', input)).toEqual(session)
    await expect(instance.runtime.uploads.start('w', { ...input, filename: 'different.png' })).rejects.toMatchObject({ code: 'REQUEST_REUSED' })
    const accepted = await instance.runtime.uploads.accept('w', session.id, Readable.from([png]), 'image', input.filename)
    await instance.runtime.uploads.run()
    expect(instance.store.state('w').graph.nodes).toHaveLength(1)
    expect(instance.store.state('w').graph.nodes[0].assetId).toBeTruthy()
    expect(await instance.store.db.get('SELECT status FROM task_catalog WHERE id=?', [accepted.taskId])).toMatchObject({ status: 'succeeded' })
    expect((await instance.store.graphChanges('w', 0)).changes.map((c: any) => c.actor)).toEqual(['host', 'host'])
  })
  it('repairs output publication from the manifest without allocating a second file', async () => {
    const instance = await service(); const { result } = await asset(instance)
    const published = await instance.store.publishedAsset('w', result.id)
    expect(published?.id).toBe(result.id)
    const path = await cloudPath(instance.store, result.id)
    await writeFile(path, 'tampered')
    await expect(instance.store.publishedAsset('w', result.id)).rejects.toMatchObject({ code: 'OBJECT_CHANGED' })
  })
  it('does not resurrect legacy JSON, tasks or local media during startup', async () => {
    const root = await temp(); await mkdir(join(root, 'workspaces')); await mkdir(join(root, 'media')); await mkdir(join(root, 'tasks'))
    const resource = { ...node(), kind: 'image-asset' as const, assetId: randomUUID() }
    const generator = node()
    const model = { id: randomUUID(), kind: 'image' as const, name: 'old', model_id: 'gpt-image-1', api_base: 'http://localhost/v1', protocol: 'openai-image' as const }
    const taskId = randomUUID()
    const legacy: WorkspaceState = { version: 1, workspaceId: 'old', graphRevision: 7, graph: { ...emptyGraph(), nodes: [resource, generator] },
      assets: [{ id: resource.assetId!, kind: 'image', filename: 'old.png', bytes: png.length, mime: 'image/png', nodeId: resource.id, taskId: null, createdAt: 1 }],
      tasks: [{ id: taskId, workspaceId: 'old', nodeId: generator.id, snapshot: { model, prompt: 'old prompt', params: defaultParams(model), referenceIds: [] }, status: 'submitted', resultIds: [], createdAt: 1, updatedAt: 1 }], updatedAt: 1 }
    const source = join(root, 'workspaces', 'old.json'); const privateFile = join(root, 'tasks', `${taskId}.json`)
    await writeFile(source, JSON.stringify(legacy)); await writeFile(join(root, 'media', resource.assetId!), png)
    await writeFile(privateFile, JSON.stringify({ key: 'legacy-secret', issued: true }))
    const digest = await fileHash(source); const keyDigest = await fileHash(privateFile)
    const restored = new Store(root, new LocalVault(root)); await restored.init(); cleanup.push(() => restored.close())
    expect((await restored.catalog()).canvases).toEqual([])
    expect(restored.allStates()).toEqual([])
    expect(await fileHash(source)).toBe(digest); expect(await fileHash(privateFile)).toBe(keyDigest)
    expect(await readFile(join(root, 'media', resource.assetId!))).toEqual(png)
    expect(await restored.db.get('SELECT COUNT(*) AS count FROM migration_imports')).toMatchObject({ count: 0 })
    await restored.close()
    await writeFile(source, JSON.stringify({ ...legacy, updatedAt: 2 }))
    const again = new Store(root); await again.init(); cleanup.push(() => again.close())
    expect(again.allStates()).toEqual([])
  })
})
