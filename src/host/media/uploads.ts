import { createHash, randomUUID } from 'node:crypto'
import { addAbortSignal, Readable } from 'node:stream'
import { rm } from 'node:fs/promises'
import type { Store } from '../store'
import { CanvasError } from '../store'
import { hash, sql } from '../persistence/database'
import { receive, fileHash } from './files'
import type { MediaKind, CanvasNode } from '../../shared/contracts'
import { NameSchema } from '../../shared/v2'
import { UPLOAD_CHUNK_BYTES, type UploadStart, type UploadStatus } from '../../shared/uploads'
import { openStage, readJournal, verifyStage, writeJournal, type UploadJournal } from './uploadJournal'

export class Uploads {
  private work = new Map<string, Promise<unknown>>()
  private controller = new AbortController()
  constructor(private store: Store, private limit: number, private chunkBytes = UPLOAD_CHUNK_BYTES) {}
  private exclusive<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.work.get(id) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(() => {
      if (this.controller.signal.aborted) throw new CanvasError('宿主正在停止，请等待自动恢复', 503, 'UPLOAD_INTERRUPTED')
      return operation()
    }).catch((error) => {
      if (error instanceof CanvasError) throw error
      throw new CanvasError('上传暂时中断，等待自动恢复', 503, 'UPLOAD_INTERRUPTED')
    })
    this.work.set(id, next)
    void next.finally(() => { if (this.work.get(id) === next) this.work.delete(id) }).catch(() => {})
    return next
  }
  private journalPath(id: string) { return this.store.stagePath(`${id}.resume.json`) }
  private async session(canvas: string, id: string) {
    const session = await this.store.db.get('SELECT * FROM upload_sessions WHERE canvas_id=? AND id=?', [canvas, id])
    if (!session) throw new CanvasError('上传会话不存在', 404, 'UPLOAD_NOT_FOUND')
    return session
  }
  private async journal(canvas: string, id: string): Promise<UploadJournal | null> {
    const journal = await readJournal(this.journalPath(id))
    if (journal && (journal.canvas !== canvas || journal.id !== id)) throw new CanvasError('上传会话不匹配', 409, 'UPLOAD_CORRUPT')
    return journal
  }
  async start(canvas: string, input: UploadStart, guard?: () => void) {
    return this.exclusive(input.requestId, () => { guard?.(); return this.startSession(canvas, input, guard) })
  }
  private async startSession(canvas: string, input: UploadStart, guard?: () => void) {
    if (input.size !== undefined && input.size > this.limit) throw new CanvasError('媒体文件超过大小限制', 413, 'MEDIA_TOO_LARGE')
    const title = NameSchema.parse(input.filename.replace(/\.[^.]+$/, '') || '上传素材')
    const node: CanvasNode = { id: randomUUID(), kind: `${input.kind}-asset`, title, position: input.position, modelId: null, prompt: '', params: null, assetId: null, selectedResultId: null }
    const requestHash = hash({ canvas, ...input })
    let result = { id: input.requestId, nodeId: node.id }; let replay = false
    let storage = ''
    await this.store.update(canvas, async (state) => {
      const existing = await this.store.db.get('SELECT request_hash,result_json FROM catalog_mutations WHERE owner_id=? AND request_id=?', [this.store.owner, input.requestId])
      if (existing) {
        if (existing.request_hash !== requestHash) throw new CanvasError('上传请求 ID 已用于其他内容', 409, 'REQUEST_REUSED')
        result = JSON.parse(existing.result_json); replay = true; return
      }
      storage = await this.store.currentStorageTarget(canvas)
      if (input.size !== undefined) {
        const existingJournal = await this.journal(canvas, input.requestId)
        if (existingJournal && (existingJournal.size !== input.size || existingJournal.kind !== input.kind || existingJournal.filename !== input.filename))
          throw new CanvasError('上传请求 ID 已用于其他内容', 409, 'REQUEST_REUSED')
        if (!existingJournal) await writeJournal(this.journalPath(input.requestId), {
          version: 1, canvas, id: input.requestId, filename: input.filename, kind: input.kind,
          size: input.size, chunkBytes: this.chunkBytes, offset: 0, hashes: [],
        })
      }
      state.graph.nodes.push(node); state.graphRevision++
    }, () => replay ? [] : [
      sql("INSERT INTO upload_sessions(id,canvas_id,node_id,state,stage_file,storage_id,created_at,updated_at) VALUES(?,?,?,'receiving',?,?,?,?)", [input.requestId, canvas, node.id, `${input.requestId}.upload`, storage, Date.now(), Date.now()]),
      sql('INSERT INTO catalog_mutations VALUES(?,?,?,?,?,?,?,?)', [this.store.owner, input.requestId, 'upload-start', 'upload', input.requestId, requestHash, JSON.stringify(result), Date.now()]),
    ], guard)
    return result
  }
  async status(canvas: string, id: string): Promise<UploadStatus> {
    return this.exclusive(id, () => this.getStatus(canvas, id))
  }
  private async getStatus(canvas: string, id: string): Promise<UploadStatus> {
    const session = await this.session(canvas, id)
    if (session.task_id) return { id, nodeId: session.node_id, size: session.bytes, offset: session.bytes, chunkBytes: this.chunkBytes, state: 'received', taskId: session.task_id }
    if (session.state === 'failed') return { id, nodeId: session.node_id, size: 0, offset: 0, chunkBytes: this.chunkBytes, state: 'failed' }
    const journal = await this.journal(canvas, id)
    if (!journal) throw new CanvasError('旧上传不支持续传，请重新上传', 409, 'UPLOAD_LEGACY')
    const handle = await openStage(this.store.stagePath(session.stage_file), journal)
    await handle.close()
    return { id, nodeId: session.node_id, size: journal.size, offset: journal.offset, chunkBytes: journal.chunkBytes, state: 'receiving' }
  }
  async chunk(canvas: string, id: string, body: Readable, kind: MediaKind, filename: string, offset: number, checksum: string, signal?: AbortSignal) {
    const combined = AbortSignal.any([this.controller.signal, AbortSignal.timeout(120000), ...(signal ? [signal] : [])])
    addAbortSignal(combined, body)
    return this.exclusive(id, async () => {
      combined.throwIfAborted()
      const session = await this.session(canvas, id), journal = await this.journal(canvas, id)
      if (session.task_id) { body.destroy(); return this.getStatus(canvas, id) }
      if (session.state !== 'receiving' || !journal) throw new CanvasError('上传不可继续', 409, 'UPLOAD_FAILED')
      if (journal.kind !== kind || journal.filename !== filename) throw new CanvasError('上传文件信息不一致', 409, 'REQUEST_REUSED')
      if (offset !== journal.offset || offset === journal.size) throw new CanvasError('上传进度已变化，请同步后继续', 409, 'UPLOAD_OFFSET_MISMATCH')
      const path = this.store.stagePath(session.stage_file), handle = await openStage(path, journal)
      const expected = Math.min(journal.chunkBytes, journal.size - offset), digest = createHash('sha256')
      let bytes = 0
      try {
        for await (const value of body) {
          combined.throwIfAborted()
          const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
          if (bytes + chunk.length > expected) throw new CanvasError('上传分块长度不一致', 400, 'UPLOAD_CHUNK_SIZE')
          digest.update(chunk)
          let written = 0
          while (written < chunk.length) {
            const result = await handle.write(chunk, written, chunk.length - written, offset + bytes + written)
            if (!result.bytesWritten) throw new Error('上传暂存写入未完成')
            written += result.bytesWritten
          }
          bytes += chunk.length
        }
        if (bytes !== expected) throw new CanvasError('上传分块中断，等待自动恢复', 503, 'UPLOAD_INTERRUPTED')
        if (digest.digest('hex') !== checksum) throw new CanvasError('上传分块校验失败', 400, 'UPLOAD_CHECKSUM')
        await handle.sync()
        await writeJournal(this.journalPath(id), { ...journal, offset: offset + bytes, hashes: [...journal.hashes, checksum] })
      } catch (error) {
        // Rename can succeed before an fsync/response error: re-read the commit, never erase it.
        const committed = await this.journal(canvas, id)
        if (committed) { await handle.truncate(committed.offset); await handle.sync() }
        if (combined.aborted) throw new CanvasError('上传连接中断，等待自动恢复', 503, 'UPLOAD_INTERRUPTED')
        throw error
      } finally { await handle.close(); body.destroy() }
      return this.getStatus(canvas, id)
    }).finally(() => body.destroy())
  }
  async complete(canvas: string, id: string) {
    return this.exclusive(id, async () => {
      const session = await this.session(canvas, id)
      if (session.task_id) return { taskId: session.task_id, nodeId: session.node_id }
      const journal = await this.journal(canvas, id)
      if (session.state !== 'receiving' || !journal) throw new CanvasError('上传不可继续', 409, 'UPLOAD_FAILED')
      if (journal.offset !== journal.size) throw new CanvasError('文件尚未接收完成', 409, 'UPLOAD_OFFSET_MISMATCH')
      const info = await verifyStage(this.store.stagePath(session.stage_file), journal, this.controller.signal)
      if (!info.detected || info.detected.kind !== journal.kind) {
        await this.fail(id); throw new CanvasError('不支持的文件格式，或文件类型与节点不一致', 415, 'UNSUPPORTED_MEDIA')
      }
      const { detected, ...rest } = info
      return this.enqueue(canvas, id, session, journal.kind, journal.filename, { ...rest, mime: detected.mime })
    })
  }
  private async fail(id: string) {
    await this.store.db.batch([sql("UPDATE upload_sessions SET state='failed',updated_at=? WHERE id=? AND task_id IS NULL", [Date.now(), id])])
  }
  async cancel(canvas: string, id: string) {
    return this.exclusive(id, async () => {
      const session = await this.session(canvas, id)
      if (session.task_id) return { ok: true }
      await this.fail(id)
      await rm(this.store.stagePath(session.stage_file), { force: true })
      await rm(this.journalPath(id), { force: true })
      return { ok: true }
    })
  }
  async recover() {
    const pending = await this.store.db.all("SELECT * FROM upload_sessions WHERE state='receiving'")
    for (const session of pending) {
      try {
        const journal = await this.journal(session.canvas_id, session.id)
        if (!journal) { await this.fail(session.id); continue }
        await verifyStage(this.store.stagePath(session.stage_file), journal, this.controller.signal)
      } catch (error) {
        if (error instanceof CanvasError && error.code === 'UPLOAD_CORRUPT') await this.fail(session.id)
        else throw error
      }
    }
  }
  async close() { this.controller.abort(); await Promise.allSettled([...this.work.values()]) }
  async accept(canvas: string, id: string, body: Readable, kind: MediaKind, filename: string, signal?: AbortSignal, guard?: () => void) {
    const combined = AbortSignal.any([this.controller.signal, ...(signal ? [signal] : [])])
    addAbortSignal(combined, body)
    return this.exclusive(id, () => { guard?.(); return this.receive(canvas, id, body, kind, filename, combined, guard) }).finally(() => body.destroy())
  }
  private async receive(canvas: string, id: string, body: Readable, kind: MediaKind, filename: string, signal?: AbortSignal, guard?: () => void) {
    const session = await this.store.db.get('SELECT * FROM upload_sessions WHERE canvas_id=? AND id=?', [canvas, id])
    if (!session) throw new CanvasError('上传会话不存在', 404)
    if (session.state !== 'receiving') {
      if (session.task_id) return { taskId: session.task_id, nodeId: session.node_id }
      throw new CanvasError('上传已中断，请重新上传', 409)
    }
    const node = this.store.state(canvas).graph.nodes.find((n) => n.id === session.node_id)
    if (node?.kind !== `${kind}-asset`) throw new CanvasError('上传类型不一致')
    const path = this.store.stagePath(session.stage_file)
    if (await this.journal(canvas, id)) throw new CanvasError('请使用分块上传接口', 409, 'UPLOAD_RESUMABLE')
    try {
      const info = await receive(body, path, this.limit, kind, signal)
      return await this.enqueue(canvas, id, session, kind, filename, info, guard)
    } catch (error) {
      await this.fail(id)
      throw error
    }
  }
  private async enqueue(canvas: string, id: string, session: any, kind: MediaKind, filename: string, info: { bytes: number; mime: string; fileHash: string; width?: number; height?: number }, guard?: () => void) {
    try {
      const node = this.store.state(canvas).graph.nodes.find((n) => n.id === session.node_id)
      if (!node || node.kind !== `${kind}-asset`) throw new CanvasError('上传节点已不存在', 409, 'UPLOAD_FAILED')
      const taskId = randomUUID()
      const descriptor = { id: randomUUID(), kind, filename, nodeId: session.node_id, taskId, createdAt: Date.now(), stageFile: session.stage_file, ...info }
      await this.store.serial(async () => {
        guard?.()
        await this.store.db.batch([
          sql("INSERT INTO task_catalog(id,canvas_id,node_id,kind,title,queue_seq,status,created_at,updated_at) VALUES(?,?,?,'import',?,(SELECT COALESCE(MAX(queue_seq),0)+1 FROM task_catalog),'queued',?,?)", [taskId, canvas, session.node_id, node.title, Date.now(), Date.now()]),
          sql("INSERT INTO task_details(task_id,request_id,request_hash,phase,import_json,updated_at) VALUES(?,?,?,'import',?,?)", [taskId, id, hash({ kind, filename, ...info }), JSON.stringify(descriptor), Date.now()]),
          sql('INSERT INTO storage_targets VALUES(?,?,?)', [taskId, canvas, session.storage_id]),
          sql("UPDATE upload_sessions SET state='received',bytes=?,file_hash=?,task_id=?,updated_at=? WHERE id=? AND state='receiving'", [info.bytes, info.fileHash, taskId, Date.now(), id], 'run', 1),
        ])
      })
      return { taskId, nodeId: session.node_id }
    } catch (error) {
      const committed = await this.session(canvas, id)
      if (committed.task_id) return { taskId: committed.task_id, nodeId: committed.node_id }
      throw error
    }
  }
  async run(signal?: AbortSignal): Promise<void> {
    const tasks = await this.store.db.all("SELECT c.*,d.import_json,d.request_id FROM task_catalog c JOIN task_details d ON d.task_id=c.id WHERE c.kind='import' AND c.status IN ('queued','saving') ORDER BY c.queue_seq LIMIT 2")
    for (const task of tasks) {
      signal?.throwIfAborted()
      const descriptor = JSON.parse(task.import_json)
      try {
        await this.store.db.batch([sql("UPDATE task_catalog SET status='saving',updated_at=? WHERE id=?", [Date.now(), task.id])])
        const path = this.store.stagePath(descriptor.stageFile)
        const existing = await this.store.publishedAsset(task.canvas_id, descriptor.id)
        if (!existing && await fileHash(path, signal) !== descriptor.fileHash) throw new CanvasError('上传暂存文件校验失败')
        const asset = existing ?? await this.store.publish(task.canvas_id, descriptor, path, descriptor, signal)
        await this.store.update(task.canvas_id, (state) => {
          if (!state.assets.some((a) => a.id === asset.id)) state.assets.push(asset)
          const node = state.graph.nodes.find((n) => n.id === task.node_id)
          if (!node) throw new CanvasError('上传节点已不存在', 409)
          node.assetId = asset.id; state.graphRevision++
        }, () => [
          sql('INSERT OR IGNORE INTO task_outputs VALUES(?,0,?,?)', [task.id, task.canvas_id, asset.id]),
          sql("UPDATE task_catalog SET status='succeeded',progress=100,finished_at=?,updated_at=? WHERE id=?", [Date.now(), Date.now(), task.id]),
          sql("UPDATE task_details SET success_at=?,phase='completed',updated_at=? WHERE task_id=?", [Date.now(), Date.now(), task.id]),
        ])
        await rm(path, { force: true })
        if (task.request_id) await rm(this.journalPath(task.request_id), { force: true })
      } catch (error) {
        if (signal?.aborted) throw error
        await this.store.db.batch([
          sql("UPDATE task_catalog SET status='save_failed',updated_at=? WHERE id=?", [Date.now(), task.id]),
          sql("UPDATE task_details SET failure_stage='storage',failure_code='IMPORT_FAILED',failure_message=?,updated_at=? WHERE task_id=?", [this.store.redact(String(error)), Date.now(), task.id]),
        ])
      }
    }
  }
}
