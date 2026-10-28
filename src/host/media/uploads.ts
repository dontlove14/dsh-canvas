import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { rm } from 'node:fs/promises'
import type { Store } from '../store'
import { CanvasError } from '../store'
import { hash, sql } from '../persistence/database'
import { receive, fileHash } from './files'
import type { MediaKind, CanvasNode } from '../../shared/contracts'
import { NameSchema } from '../../shared/v2'

export class Uploads {
  private receiving = new Set<string>()
  constructor(private store: Store, private limit: number) {}
  async start(canvas: string, input: { requestId: string; filename: string; kind: MediaKind; position: { x: number; y: number } }) {
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
      state.graph.nodes.push(node); state.graphRevision++
    }, () => replay ? [] : [
      sql("INSERT INTO upload_sessions(id,canvas_id,node_id,state,stage_file,storage_id,created_at,updated_at) VALUES(?,?,?,'receiving',?,?,?,?)", [input.requestId, canvas, node.id, `${input.requestId}.upload`, storage, Date.now(), Date.now()]),
      sql('INSERT INTO catalog_mutations VALUES(?,?,?,?,?,?,?,?)', [this.store.owner, input.requestId, 'upload-start', 'upload', input.requestId, requestHash, JSON.stringify(result), Date.now()]),
    ])
    return result
  }
  async accept(canvas: string, id: string, body: Readable, kind: MediaKind, filename: string, signal?: AbortSignal) {
    if (this.receiving.has(id)) throw new CanvasError('这个上传正在接收', 409, 'UPLOAD_BUSY')
    this.receiving.add(id)
    try { return await this.receive(canvas, id, body, kind, filename, signal) }
    finally { this.receiving.delete(id) }
  }
  private async receive(canvas: string, id: string, body: Readable, kind: MediaKind, filename: string, signal?: AbortSignal) {
    const session = await this.store.db.get('SELECT * FROM upload_sessions WHERE canvas_id=? AND id=?', [canvas, id])
    if (!session) throw new CanvasError('上传会话不存在', 404)
    if (session.state !== 'receiving') {
      if (session.task_id) return { taskId: session.task_id, nodeId: session.node_id }
      throw new CanvasError('上传已中断，请重新上传', 409)
    }
    const node = this.store.state(canvas).graph.nodes.find((n) => n.id === session.node_id)
    if (node?.kind !== `${kind}-asset`) throw new CanvasError('上传类型不一致')
    const path = this.store.stagePath(session.stage_file)
    try {
      const info = await receive(body, path, this.limit, kind, signal)
      const taskId = randomUUID()
      const descriptor = { id: randomUUID(), kind, filename, nodeId: session.node_id, taskId, createdAt: Date.now(), stageFile: session.stage_file, ...info }
      await this.store.serial(async () => {
        await this.store.db.batch([
          sql("INSERT INTO task_catalog(id,canvas_id,node_id,kind,title,queue_seq,status,created_at,updated_at) VALUES(?,?,?,'import',?,(SELECT COALESCE(MAX(queue_seq),0)+1 FROM task_catalog),'queued',?,?)", [taskId, canvas, session.node_id, node.title, Date.now(), Date.now()]),
          sql("INSERT INTO task_details(task_id,request_id,request_hash,phase,import_json,updated_at) VALUES(?,?,?,'import',?,?)", [taskId, id, hash({ kind, filename, ...info }), JSON.stringify(descriptor), Date.now()]),
          sql('INSERT INTO storage_targets VALUES(?,?,?)', [taskId, canvas, session.storage_id]),
          sql("UPDATE upload_sessions SET state='received',bytes=?,file_hash=?,task_id=?,updated_at=? WHERE id=? AND state='receiving'", [info.bytes, info.fileHash, taskId, Date.now(), id], 'run', 1),
        ])
      })
      return { taskId, nodeId: session.node_id }
    } catch (error) {
      await this.store.db.batch([sql("UPDATE upload_sessions SET state='failed',updated_at=? WHERE id=?", [Date.now(), id])])
      throw error
    }
  }
  async run(signal?: AbortSignal): Promise<void> {
    const tasks = await this.store.db.all("SELECT c.*,d.import_json FROM task_catalog c JOIN task_details d ON d.task_id=c.id WHERE c.kind='import' AND c.status IN ('queued','saving') ORDER BY c.queue_seq LIMIT 2")
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
