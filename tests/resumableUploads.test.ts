import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { PassThrough, Readable } from 'node:stream'
import { CanvasService } from '../src/host/service'
import { Uploads } from '../src/host/media/uploads'
import * as journals from '../src/host/media/uploadJournal'
import { fakeFactory, initialize, cloudPath } from './support/objectStorage'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZAAAAABJRU5ErkJggg==', 'base64')
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })
async function setup(root?: string) {
  if (!root) {
    root = await mkdtemp(join(tmpdir(), 'canvas-resume-test-'))
    const directory = root; cleanup.push(() => rm(directory, { recursive: true, force: true }))
  }
  const service = new CanvasService({ dataDir: root, maxConcurrentTasks: 2, pollIntervalMs: 100, requestTimeoutMs: 1000, maxMediaBytes: 100000, maxReferenceBytes: 100000 }, undefined, fakeFactory(root))
  await initialize(service); await service.store.ensureCanvas('w')
  const uploads = new Uploads(service.store, 100000, 32)
  cleanup.push(() => service.close()); cleanup.push(() => uploads.close())
  return { service, uploads, root }
}
function input(bytes = png) { return { requestId: randomUUID(), filename: 'test.png', kind: 'image' as const, position: { x: 0, y: 0 }, size: bytes.length } }
async function send(uploads: Uploads, id: string, bytes: Buffer, offset: number) {
  const part = bytes.subarray(offset, Math.min(offset + 32, bytes.length))
  return uploads.chunk('w', id, Readable.from([part]), 'image', 'test.png', offset, sha(part))
}
async function finish(uploads: Uploads, id: string, bytes = png) {
  for (;;) {
    const status = await uploads.status('w', id)
    if (status.offset === status.size) break
    await send(uploads, id, bytes, status.offset)
  }
  return uploads.complete('w', id)
}
describe('durable resumable upload protocol', () => {
  it.each([
    { kind: 'image', bytes: png },
    { kind: 'video', bytes: Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom0000isommp42'), Buffer.alloc(80)]) },
    { kind: 'audio', bytes: Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(64)]) },
  ] as const)('serves resumable HTTP start, status, chunk and idempotent completion for $kind', async ({ kind, bytes }) => {
    const { service } = await setup()
    const post = (suffix: string, body: unknown) => service.handle(new Request(`http://localhost/api/canvas/v2/${suffix}?canvas=w`, { method: 'POST', body: JSON.stringify(body) }))
    const request = { ...input(bytes), kind }
    const started = await post('upload-start', request)
    expect(started.status).toBe(201)
    const session = await started.json()
    const url = `http://localhost/api/canvas/v2/upload?canvas=w&id=${session.id}`
    expect(await (await service.handle(new Request(url.replace('/upload?', '/upload-status?')))).json()).toMatchObject({ offset: 0, size: bytes.length })
    const received = await service.handle(new Request(`${url}&kind=${kind}&offset=0`, {
      method: 'POST', body: bytes, headers: { 'x-canvas-filename': 'test.png', 'x-canvas-chunk-sha256': sha(bytes) },
    }))
    expect(received.status).toBe(200)
    expect(await received.json()).toMatchObject({ offset: bytes.length, state: 'receiving' })
    const accepted = await post('upload-complete', { id: session.id })
    expect(accepted.status).toBe(202)
    expect(await (await post('upload-complete', { id: session.id })).json()).toEqual(await accepted.json())
    expect((await post('upload-cancel', { id: session.id })).status).toBe(200)
    expect(await service.store.db.get('SELECT COUNT(*) AS n FROM task_catalog')).toEqual({ n: 1 })
  })
  it('reconciles duplicate start/chunk/complete and publishes one exact original without schema changes', async () => {
    const { service, uploads } = await setup()
    const schema = await service.store.db.all("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name")
    const request = input(), session = await uploads.start('w', request)
    expect(await uploads.start('w', request)).toEqual(session)
    await expect(uploads.start('w', { ...request, size: request.size + 1 })).rejects.toMatchObject({ code: 'REQUEST_REUSED' })
    const concurrent = await Promise.allSettled([send(uploads, session.id, png, 0), send(uploads, session.id, png, 0)])
    expect(concurrent.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(concurrent.filter((result) => result.status === 'rejected')).toHaveLength(1)
    await expect(send(uploads, session.id, png, 0)).rejects.toMatchObject({ code: 'UPLOAD_OFFSET_MISMATCH' })
    await expect(uploads.status('other', session.id)).rejects.toMatchObject({ status: 404 })
    await expect(uploads.complete('w', session.id)).rejects.toMatchObject({ code: 'UPLOAD_OFFSET_MISMATCH' })
    const accepted = await finish(uploads, session.id)
    const replay = await Promise.all([uploads.complete('w', session.id), uploads.complete('w', session.id)])
    expect(replay).toEqual([accepted, accepted])
    await uploads.cancel('w', session.id)
    expect(await service.store.db.get('SELECT COUNT(*) AS n FROM task_catalog')).toEqual({ n: 1 })
    expect(service.store.state('w').graph.nodes).toHaveLength(1)
    await uploads.run()
    const asset = service.store.state('w').assets[0]
    expect(await readFile(await cloudPath(service.store, asset.id))).toEqual(png)
    expect(await uploads.status('w', session.id)).toMatchObject({ state: 'received', taskId: accepted.taskId, offset: png.length })
    await expect(stat(service.store.stagePath(`${session.id}.resume.json`))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await service.store.db.all("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name")).toEqual(schema)
  })
  it('keeps acknowledged chunks after partial body, bad checksum, oversize and interrupted journal acknowledgement', async () => {
    const { service, uploads } = await setup(), session = await uploads.start('w', input())
    await send(uploads, session.id, png, 0)
    await expect(uploads.chunk('w', session.id, Readable.from([png.subarray(32, 40)]), 'image', 'test.png', 32, sha(png.subarray(32, 64)))).rejects.toMatchObject({ status: 503 })
    await expect(uploads.chunk('w', session.id, Readable.from([png.subarray(32, 64)]), 'image', 'test.png', 32, '0'.repeat(64))).rejects.toMatchObject({ code: 'UPLOAD_CHECKSUM' })
    await expect(uploads.chunk('w', session.id, Readable.from([Buffer.alloc(33)]), 'image', 'test.png', 32, sha(Buffer.alloc(33)))).rejects.toMatchObject({ code: 'UPLOAD_CHUNK_SIZE' })
    expect((await uploads.status('w', session.id)).offset).toBe(32)
    const original = journals.writeJournal
    vi.spyOn(journals, 'writeJournal').mockImplementationOnce(async (...args) => { await original(...args); throw new Error('Lost fsync acknowledgement after rename') })
    await expect(send(uploads, session.id, png, 32)).rejects.toMatchObject({ status: 503 })
    expect((await uploads.status('w', session.id)).offset).toBe(64)
    expect(await readFile(service.store.stagePath(`${session.id}.upload`))).toEqual(png.subarray(0, 64))
    await finish(uploads, session.id)
  })
  it('restarts from the durable offset and discards only an uncommitted crash tail', async () => {
    const first = await setup(), request = input(), session = await first.uploads.start('w', request)
    await send(first.uploads, session.id, png, 0)
    await writeFile(first.service.store.stagePath(`${session.id}.upload`), png.subarray(0, 44))
    await first.uploads.close(); await first.service.close()
    const second = await setup(first.root)
    await second.uploads.recover()
    expect(await second.uploads.start('w', request)).toEqual(session)
    expect((await second.uploads.status('w', session.id)).offset).toBe(32)
    expect((await stat(second.service.store.stagePath(`${session.id}.upload`))).size).toBe(32)
    const result = await finish(second.uploads, session.id)
    await second.uploads.run()
    expect((await second.uploads.status('w', session.id)).taskId).toBe(result.taskId)
  })
  it('rejects same-size corruption after restart and fails old interrupted legacy sessions', async () => {
    const { service, uploads } = await setup(), session = await uploads.start('w', input())
    await send(uploads, session.id, png, 0)
    await writeFile(service.store.stagePath(`${session.id}.upload`), Buffer.alloc(32, 1))
    const legacy = await uploads.start('w', { ...input(), requestId: randomUUID(), size: undefined })
    await uploads.recover()
    expect((await uploads.status('w', session.id)).state).toBe('failed')
    expect((await uploads.status('w', legacy.id)).state).toBe('failed')
    expect(await service.store.db.get('SELECT COUNT(*) AS n FROM task_catalog')).toEqual({ n: 0 })
    await uploads.cancel('w', session.id)
    expect(await service.store.hasUnfinished('w', session.nodeId)).toBe(false)
  })
  it('aborts and waits for a stalled body on host shutdown, then resumes the same upload', async () => {
    const first = await setup(), session = await first.uploads.start('w', input())
    await send(first.uploads, session.id, png, 0)
    const stalled = new PassThrough()
    const work = first.uploads.chunk('w', session.id, stalled, 'image', 'test.png', 32, sha(png.subarray(32, 64)))
    const observed = expect(work).rejects.toMatchObject({ status: 503 })
    stalled.write(png.subarray(32, 40))
    await new Promise((resolve) => setTimeout(resolve, 20))
    await first.uploads.close(); await observed; await first.service.close()
    const second = await setup(first.root)
    await second.uploads.recover()
    expect((await second.uploads.status('w', session.id)).offset).toBe(32)
    await finish(second.uploads, session.id)
  })
  it('reconciles a committed database transaction whose acknowledgement is lost', async () => {
    const { service, uploads } = await setup(), session = await uploads.start('w', input())
    for (let offset = 0; offset < png.length; offset += 32) await send(uploads, session.id, png, offset)
    const batch = service.store.db.batch.bind(service.store.db)
    let lost = false
    vi.spyOn(service.store.db, 'batch').mockImplementation(async (...args) => {
      const result = await batch(...args)
      if (!lost && args[0].some((statement) => statement.sql.startsWith('INSERT INTO task_catalog'))) {
        lost = true; throw new Error('Lost COMMIT acknowledgement')
      }
      return result
    })
    const result = await uploads.complete('w', session.id)
    expect(await uploads.complete('w', session.id)).toEqual(result)
    expect(await service.store.db.get('SELECT COUNT(*) AS n FROM task_catalog')).toEqual({ n: 1 })
  })
  it('searches reproducible two-actor schedules with partial writes, duplicate/reordered requests, lost ACKs and restarts (seed 0x63c0ffee)', async () => {
    let seed = 0x63c0ffee
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed }
    const bytes = Buffer.concat([png, Buffer.alloc(250, 7)]), request = input(bytes)
    let current = await setup()
    const session = await current.uploads.start('w', request), offsets = [0, 0]
    for (let step = 0; step < 35; step++) {
      const actor = random() % 2, choice = random() % 5
      if (choice === 0) {
        await current.uploads.close(); await current.service.close()
        current = await setup(current.root); await current.uploads.recover()
      } else if (choice === 1) {
        offsets[actor] = (await current.uploads.status('w', session.id)).offset
      } else if (choice === 2) {
        const offset = (await current.uploads.status('w', session.id)).offset
        if (offset < bytes.length) {
          const partial = bytes.subarray(offset, Math.min(offset + 10, bytes.length))
          await current.uploads.chunk('w', session.id, Readable.from([partial]), 'image', 'test.png', offset, sha(partial)).catch(() => {})
        }
      } else {
        await current.uploads.start('w', request)
        // Ignore ACK deliberately. This actor still retries its previous offset.
        if (offsets[actor] < bytes.length) await send(current.uploads, session.id, bytes, offsets[actor]).catch(() => {})
      }
      const status = await current.uploads.status('w', session.id)
      expect(await readFile(current.service.store.stagePath(`${session.id}.upload`))).toEqual(bytes.subarray(0, status.offset))
      expect(current.service.store.state('w').graph.nodes).toHaveLength(1)
      expect(await current.service.store.db.get('SELECT COUNT(*) AS n FROM task_catalog')).toEqual({ n: 0 })
    }
    // Once faults stop, the same request must eventually publish the exact original.
    await finish(current.uploads, session.id, bytes); await current.uploads.run()
    expect(await readFile(await cloudPath(current.service.store, current.service.store.state('w').assets[0].id))).toEqual(bytes)
  }, 20000)
})
