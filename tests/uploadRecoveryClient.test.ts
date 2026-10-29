import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { IndexedUploadCache, type CachedUpload, type UploadCache } from '../src/client/uploadCache'
import { ApiError, ResumableUploads, type UploadTransport } from '../src/client/resumableUploads'
import type { UploadStatus, UploadResult } from '../src/shared/uploads'

const cache = () => new IndexedUploadCache(`upload-test-${randomUUID()}`)
const position = { x: 100, y: 200 }
function backend() {
  const stored = new Map<string, { job: any; bytes: number[]; result?: UploadResult }>()
  const starts: string[] = [], chunks: number[] = [], links: CachedUpload[] = []
  const status = (id: string): UploadStatus => {
    const session = stored.get(id)!
    return { id, nodeId: `node-${id}`, offset: session.bytes.length, size: session.job.size, chunkBytes: 4,
      state: session.result ? 'received' : 'receiving', ...(session.result ? { taskId: session.result.taskId } : {}) }
  }
  const transport: UploadTransport = {
    start: async (_canvas, input) => {
      starts.push(input.requestId)
      if (!stored.has(input.requestId)) stored.set(input.requestId, { job: input, bytes: [] })
    },
    status: async (_canvas, id) => status(id),
    chunk: async (job, offset, blob, _checksum, progress) => {
      const value = stored.get(job.requestId)!
      if (offset !== value.bytes.length) throw new ApiError('Offset changed', 'UPLOAD_OFFSET_MISMATCH', 409)
      chunks.push(offset)
      value.bytes.push(...new Uint8Array(await blob.arrayBuffer()))
      progress(blob.size)
      return status(job.requestId)
    },
    complete: async (_canvas, id) => {
      const value = stored.get(id)!
      return value.result ??= { taskId: `task-${id}`, nodeId: `node-${id}` }
    },
    cancel: async () => ({}),
    link: async (job) => { links.push(job) },
  }
  return { stored, starts, chunks, links, transport }
}
async function settled(manager: ResumableUploads, canvas = 'w') {
  for (let count = 0; count < 200; count++) {
    if (!manager.activities(canvas).length) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('Upload did not settle')
}
describe('persistent browser upload recovery', () => {
  it('restores exact cached Blob and original request/target after page refresh, sending only remaining bytes', async () => {
    const storage = cache(), server = backend()
    const file = new File(['abcdefghij'], 'test.mp4', { type: 'video/mp4' })
    const job: CachedUpload = { requestId: randomUUID(), canvas: 'w', filename: file.name, kind: 'video', size: file.size, file, position, target: randomUUID() }
    await storage.put(job)
    await server.transport.start('w', job)
    server.stored.get(job.requestId)!.bytes = [97, 98, 99, 100]
    // A fresh adapter + manager represents a refreshed page, without a File picker.
    const restored = new IndexedUploadCache((storage as any).name)
    const manager = new ResumableUploads(server.transport, restored, 1)
    await manager.restore(); await manager.restore(); await settled(manager)
    expect(server.chunks).toEqual([4, 8])
    expect(new Uint8Array(server.stored.get(job.requestId)!.bytes)).toEqual(new Uint8Array(await file.arrayBuffer()))
    expect(new Set(server.starts)).toEqual(new Set([job.requestId]))
    expect(server.links).toHaveLength(1)
    expect(server.links[0].target).toBe(job.target)
    expect(await storage.list()).toEqual([])
  })
  it('reconciles lost start, chunk and completion responses without changing identity or resending committed chunks', async () => {
    const server = backend(), storage = cache()
    const transport = { ...server.transport }
    const originalStart = transport.start, originalChunk = transport.chunk, originalComplete = transport.complete
    let startLost = true, chunkLost = true, completionLost = true
    transport.start = async (...args) => { const result = await originalStart(...args); if (startLost) { startLost = false; throw new Error('Lost start ACK') } return result }
    transport.chunk = async (...args) => { const result = await originalChunk(...args); if (chunkLost) { chunkLost = false; throw new Error('Lost chunk ACK') } return result }
    transport.complete = async (...args) => { const result = await originalComplete(...args); if (completionLost) { completionLost = false; throw new Error('Lost complete ACK') } return result }
    const manager = new ResumableUploads(transport, storage, 1)
    const progress: number[] = []
    await manager.upload('w', new File(['abcdefghij'], 'test.png'), 'image', position, { progress: (value) => progress.push(value) })
    expect(new Set(server.starts).size).toBe(1)
    expect(server.chunks).toEqual([0, 4, 8])
    expect(progress.at(-1)).toBe(100)
    expect(await storage.list()).toEqual([])
  })
  it('lets users append another upload while an earlier transfer is pending and separates progress', async () => {
    const server = backend(), storage = cache()
    let release!: () => void
    const hold = new Promise<void>((resolve) => { release = resolve })
    const original = server.transport.chunk
    server.transport.chunk = async (...args) => { if (args[0].filename === 'first.png') await hold; return original(...args) }
    const manager = new ResumableUploads(server.transport, storage, 1)
    const first = manager.upload('w', new File(['abcdefgh'], 'first.png'), 'image', position, {})
    while (!manager.activities('w').length) await new Promise((resolve) => setTimeout(resolve, 1))
    await manager.upload('w', new File(['xyz'], 'second.png'), 'image', position, {})
    expect(manager.activities('w').map((job) => job.filename)).toEqual(['first.png'])
    expect(server.stored.size).toBe(2)
    release(); await first
  })
  it('pauses authorization failures and wakes on online/focus using the original cached file', async () => {
    const server = backend(), storage = cache(), events = new EventTarget()
    let authorized = false
    const original = server.transport.status
    server.transport.status = async (...args) => { if (!authorized) throw new ApiError('Login required', 'AUTH', 401); return original(...args) }
    const manager = new ResumableUploads(server.transport, storage, 15000, events)
    const work = manager.upload('w', new File(['abcd'], 'a.png'), 'image', position, {})
    while (!manager.activities('w')[0]?.waiting) await new Promise((resolve) => setTimeout(resolve, 1))
    expect(manager.activities('w')[0].error).toContain('登录')
    expect(await storage.list()).toHaveLength(1)
    authorized = true; events.dispatchEvent(new Event('online'))
    await work
    expect(await storage.list()).toEqual([])
  })
  it('fails cache quota before creating any server node and cleans up terminal unsupported uploads', async () => {
    const server = backend()
    const broken: UploadCache = { list: async () => [], remove: async () => {}, put: async () => { throw new Error('QuotaExceededError') } }
    const manager = new ResumableUploads(server.transport, broken, 1)
    await expect(manager.upload('w', new File(['abcd'], 'a.png'), 'image', position, {})).rejects.toThrow('存储空间')
    expect(server.starts).toEqual([])
    const storage = cache()
    let cancelled = 0
    server.transport.complete = async () => { throw new ApiError('Unsupported', 'UNSUPPORTED_MEDIA', 415) }
    server.transport.cancel = async () => { cancelled++; return {} }
    const invalid = new ResumableUploads(server.transport, storage, 1)
    await expect(invalid.upload('w', new File(['abcd'], 'bad.png'), 'image', position, {})).rejects.toMatchObject({ status: 415 })
    expect(cancelled).toBe(1); expect(await storage.list()).toEqual([])
  })
  it('retains accepted upload identity while a restored reference link has a transient failure', async () => {
    const server = backend(), storage = cache(), file = new File(['abcd'], 'a.png')
    const job: CachedUpload = { requestId: randomUUID(), canvas: 'w', filename: file.name, kind: 'image', file, size: 4, position,
      target: randomUUID(), result: { taskId: 'accepted-task', nodeId: 'accepted-node' } }
    await storage.put(job)
    let attempts = 0
    server.transport.link = async (value) => { expect(value.result).toEqual(job.result); if (!attempts++) throw new Error('Network interrupted') }
    const manager = new ResumableUploads(server.transport, storage, 1)
    await manager.restore(); await settled(manager)
    expect(attempts).toBe(2); expect(server.starts).toEqual([]); expect(await storage.list()).toEqual([])
  })
  it('holds exactly five transfer slots for a hundred cached files and drains every file under reordered completions', async () => {
    const server = backend(), storage = cache()
    const waitFor = (check: () => void) => vi.waitFor(check, { interval: 2, timeout: 1000 })
    const pending = new Map<string, () => void>()
    let active = 0, peak = 0
    const original = server.transport.chunk
    server.transport.chunk = async (...args) => {
      active++; peak = Math.max(peak, active)
      try {
        await new Promise<void>((resolve) => pending.set(args[0].requestId, resolve))
        return await original(...args)
      } finally { active--; pending.delete(args[0].requestId) }
    }
    const manager = new ResumableUploads(server.transport, storage, 1)
    const work = Promise.all(Array.from({ length: 100 }, (_, index) =>
      manager.upload('w', new File(['abcd'], `${index}.png`), 'image', position, {})))
    await waitFor(() => expect(manager.activities('w')).toHaveLength(100))
    await waitFor(() => expect(pending.size).toBe(5))
    expect(server.starts).toHaveLength(5)
    // Reproducible completion interleavings, without releasing the whole batch.
    let seed = 0x6500cafe, completed = 0
    while (completed < 100) {
      await waitFor(() => expect(pending.size).toBeGreaterThan(0))
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      const keys = [...pending.keys()], id = keys[seed % keys.length]
      pending.get(id)!()
      completed++
      await waitFor(() => expect(manager.activities('w')).toHaveLength(100 - completed))
      expect(active).toBeLessThanOrEqual(5)
      expect(server.starts.length).toBeLessThanOrEqual(completed + 5)
    }
    await work
    expect(peak).toBe(5)
    expect(server.starts).toHaveLength(100)
    expect(new Set(server.starts).size).toBe(100)
    expect(await storage.list()).toEqual([])
  })
  it('releases a slot after a terminal failure so queued uploads can continue', async () => {
    const server = backend(), storage = cache(), pending = new Map<string, () => void>()
    const original = server.transport.chunk
    server.transport.chunk = async (...args) => {
      await new Promise<void>((resolve) => pending.set(args[0].requestId, resolve))
      pending.delete(args[0].requestId)
      if (args[0].filename === '0.png') throw new ApiError('Unsupported', 'UNSUPPORTED_MEDIA', 415)
      return original(...args)
    }
    const manager = new ResumableUploads(server.transport, storage, 1)
    const work = Promise.allSettled(Array.from({ length: 6 }, (_, index) =>
      manager.upload('w', new File(['abcd'], `${index}.png`), 'image', position, {})))
    await vi.waitFor(() => expect(pending.size).toBe(5))
    const failed = [...server.stored.entries()].find(([, value]) => value.job.filename === '0.png')![0]
    pending.get(failed)!()
    await vi.waitFor(() => expect(server.starts).toHaveLength(6))
    for (const release of pending.values()) release()
    const results = await work
    expect(results.filter((item) => item.status === 'rejected')).toHaveLength(1)
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(5)
    expect(manager.activities('w')).toEqual([])
    expect(await storage.list()).toEqual([])
  })
})
