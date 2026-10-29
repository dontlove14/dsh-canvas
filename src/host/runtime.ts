import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { Store } from './store'
import { Providers, ProviderFailure, type ProviderResult, type ReviewReferenceResolver } from './providers'
import { BUSY_STATUSES, TRACKED_STATUSES, isTtsSnapshot, type Task, type TaskStatus } from '../shared/contracts'
import { sql, type Statement } from './persistence/database'
import { Uploads } from './media/uploads'
import { isMockModel } from '../shared/mockModels'
import { renderMock } from './mockGeneration'
import { isBananaImage, isSeedreamImage } from '../shared/modelCatalog'

export interface RuntimeConfig { maxConcurrentTasks: number; pollIntervalMs: number; requestTimeoutMs: number; maxMediaBytes: number; maxReferenceBytes: number }
/** Long-lived host lifecycle. Neither a request signal nor a Peer owns this controller. */
export class CanvasRuntime {
  private controller = new AbortController()
  private providers: Providers
  private active = new Map<string, Promise<void>>()
  private timer?: ReturnType<typeof setInterval>
  private scanning = false
  private scanWork?: Promise<void>
  private maintenance?: Promise<void>
  readonly uploads: Uploads
  constructor(readonly store: Store, private config: RuntimeConfig, reviewReferences?: ReviewReferenceResolver) {
    this.providers = new Providers(store, config, this.controller.signal, reviewReferences)
    this.uploads = new Uploads(store, config.maxMediaBytes)
  }
  async start(): Promise<void> {
    await this.uploads.recover()
    for (const state of this.store.allStates()) for (const task of state.tasks) {
      if (!TRACKED_STATUSES.has(task.status)) continue
      const data = await this.store.taskPrivate(task.id).catch(() => null)
      if (task.status === 'unknown') {
        // Upgrade historical no-result submissions without issuing another request.
        // Local failure does not assert that the provider performed no side effect.
        if (!task.providerTaskId && data?.issued && !data.outputs?.length && !task.resultIds.length) {
          const detail = await this.store.taskDetail(task.workspaceId, task.id)
          if (!detail.externalCompletedAt) await this.patch(task, { status: 'failed' })
        }
        continue
      }
      if (!BUSY_STATUSES.has(task.status)) continue
      if (!data) await this.patch(task, { status: task.providerTaskId ? 'save_failed' : 'failed', error: '任务恢复凭据版本缺失，请检查备份' })
      else if (!task.providerTaskId && data.issued && !data.outputs?.length) {
        const detail = await this.store.taskDetail(task.workspaceId, task.id)
        await this.patch(task, { status: detail.externalCompletedAt ? 'save_failed' : 'failed', error: detail.externalCompletedAt ? '外部已完成，但原结果描述未能持久保存；请核对后结束本地等待' : '上次提交中断，未取得可用结果；不会自动重提' })
      }
    }
    this.timer = setInterval(() => this.wake(), 250); this.timer.unref(); this.wake()
  }
  isActive(id: string): boolean { return this.active.has(id) }
  private pollDelay(task: Task): number {
    return task.snapshot.model.protocol === 'seedance-video' ? Math.max(3000, this.config.pollIntervalMs) : this.config.pollIntervalMs
  }
  wake(): void {
    if (this.controller.signal.aborted) return
    if (!this.scanning) {
      this.scanning = true
      this.scanWork = this.scan().catch(() => {}).finally(() => { this.scanning = false })
    }
    if (!this.maintenance) this.maintenance = this.runMaintenance().catch(() => {}).finally(() => { this.maintenance = undefined })
  }
  private async runMaintenance(): Promise<void> {
    await this.uploads.run(this.controller.signal)
    await this.store.runMoves(this.controller.signal)
  }
  private async scan(): Promise<void> {
    const due = await this.store.db.all("SELECT c.id FROM task_catalog c JOIN task_details d ON d.task_id=c.id WHERE c.kind='generation' AND c.status IN ('queued','running','external_wait','saving') AND d.next_run_at<=? ORDER BY c.queue_seq LIMIT 100", [Date.now()])
    const ready = new Set(due.map((d) => d.id))
    for (const task of this.store.pendingTasks()) {
      if (this.active.size >= this.config.maxConcurrentTasks) return
      if (!ready.has(task.id) || this.active.has(task.id)) continue
      const running = this.execute(task).catch(async (error) => {
        const current = this.store.state(task.workspaceId).tasks.find((t) => t.id === task.id)
        if (!current || !BUSY_STATUSES.has(current.status)) return
        const data = await this.store.taskPrivate(task.id).catch(() => null)
        if (this.controller.signal.aborted) {
          // Preserve known external identity or downloaded descriptors; never label shutdown as provider failure.
          if (!current.providerTaskId && data?.issued && !data.outputs) await this.patch(current, { status: 'failed', error: '宿主停止时未取得提交结果；不会自动重提' })
          return
        }
        const message = this.store.redact(error instanceof Error ? error.message : '任务执行失败', [data?.key ?? ''])
        const saving = !!data?.outputs || current.status === 'saving'
        let status: TaskStatus = saving ? 'save_failed' : 'failed'
        if (current.providerTaskId && !data?.outputs && !saving) status = error instanceof ProviderFailure && error.definitive ? 'unknown' : current.status
        await this.patch(current, { status, error: message }, [sql("UPDATE task_details SET failure_stage=?,failure_code=?,failure_message=?,next_run_at=? WHERE task_id=?", [saving ? 'storage' : current.providerTaskId ? 'poll' : 'submit', error instanceof ProviderFailure ? 'PROVIDER_ERROR' : 'TRANSPORT_OR_STORAGE_ERROR', message, Date.now() + this.pollDelay(current), task.id])])
      }).catch(() => {}).finally(async () => {
        try { await this.store.db.batch([sql('UPDATE task_details SET lease_owner=NULL,lease_until=NULL WHERE task_id=? AND lease_owner=?', [task.id, this.store.db.token])]) } catch {}
        this.active.delete(task.id)
      })
      this.active.set(task.id, running)
    }
  }
  private async patch(task: Task, changes: Partial<Task>, extra: Statement[] = []): Promise<void> {
    await this.store.update(task.workspaceId, (state) => {
      const current = state.tasks.find((t) => t.id === task.id)
      if (current) Object.assign(current, changes, { updatedAt: Date.now() })
    }, () => extra)
  }
  private async attempt<T>(task: Task, step: string, operation: () => Promise<T>): Promise<T> {
    const id = randomUUID()
    await this.store.db.batch([sql('INSERT INTO task_attempts(id,task_id,step,issued_at) VALUES(?,?,?,?)', [id, task.id, step, Date.now()]), sql('UPDATE task_details SET phase=?,updated_at=? WHERE task_id=?', [step, Date.now(), task.id])])
    try {
      const value = await operation()
      await this.store.db.batch([sql("UPDATE task_attempts SET finished_at=?,outcome='received' WHERE id=?", [Date.now(), id])])
      return value
    } catch (error) {
      const data = await this.store.taskPrivate(task.id).catch(() => null)
      await this.store.db.batch([sql('UPDATE task_attempts SET finished_at=?,outcome=?,error=? WHERE id=?', [Date.now(), this.controller.signal.aborted ? 'interrupted' : 'failed', this.store.redact(String(error), [data?.key ?? '']), id])])
      throw error
    }
  }
  private async execute(task: Task): Promise<void> {
    await this.store.db.batch([sql('UPDATE task_details SET lease_owner=?,lease_until=? WHERE task_id=? AND (lease_owner IS NULL OR lease_until<?)', [this.store.db.token, Date.now() + this.config.requestTimeoutMs * 8, task.id, Date.now()], 'run', 1)])
    let data = await this.store.taskPrivate(task.id)
    let result: ProviderResult
    if (!data.outputs) {
      if (isMockModel(task.snapshot.model)) {
        await this.store.verifyReferences(task.id)
        await this.patch(task, { status: 'generating', progress: 5 })
        result = { status: 'completed', outputs: await this.attempt(task, 'mock-render', () => renderMock(task, this.store, this.controller.signal, (progress) => this.patch(task, { progress }))) }
      } else if (task.providerTaskId) result = await this.attempt(task, 'poll', () => this.providers.poll(task.snapshot, data.key, task.providerTaskId!))
      else {
        if (data.issued) { await this.patch(task, { status: 'failed', error: '之前的提交未取得可用结果；不会自动重提' }); return }
        await this.store.verifyReferences(task.id)
        const prepared = await this.attempt(task, 'prepare-references', () => this.providers.prepare(task.snapshot, task.id))
        data.issued = true
        await this.store.writeTaskPrivate(task.id, data)
        await this.patch(task, { status: 'generating' })
        result = await this.attempt(task, 'submit', () => this.providers.submit(task.snapshot, data.key, prepared))
      }
      await this.patch(task, { ...(result.id ? { providerTaskId: result.id } : {}), status: result.outputs ? 'saving' : result.status, progress: result.progress, error: result.error ? this.store.redact(result.error, [data.key]) : undefined }, [
        sql('UPDATE task_details SET external_status=?,next_run_at=? WHERE task_id=?', [result.status, Date.now() + this.pollDelay(task), task.id]),
        ...(result.status === 'failed' ? [sql("UPDATE task_details SET phase='failed',failure_stage='provider',failure_code=?,failure_message=? WHERE task_id=?", [this.store.redact(result.errorCode ?? 'EXTERNAL_FAILED', [data.key]), this.store.redact(result.error ?? '外部生成失败', [data.key]), task.id])] : []),
      ])
      if (result.outputs) {
        data.outputs = result.outputs
        await this.store.writeTaskPrivate(task.id, data)
        data = await this.store.taskPrivate(task.id)
      }
      if (result.status === 'failed' || !data.outputs) return
    }
    await this.patch(task, { status: 'saving', error: undefined })
    const saveErrors: string[] = []
    for (const output of data.outputs!) {
      try {
        const existing = await this.store.publishedAsset(task.workspaceId, output.id)
        const asset = existing ?? await this.attempt(task, 'publish', async () => {
          const staged = await this.store.db.get('SELECT id FROM canvas_assets WHERE canvas_id=? AND id=?', [task.workspaceId, output.id])
          const source = staged ? Readable.from([]) : await this.providers.outputStream(output, task.snapshot, data.key)
          const [width, height] = isTtsSnapshot(task.snapshot) ? [] : task.snapshot.params.size.split('x').map(Number)
          const dimensions = !isTtsSnapshot(task.snapshot) && isMockModel(task.snapshot.model) ? { width, height, ...(task.snapshot.model.kind === 'video' ? { duration: task.snapshot.params.seconds } : {}) }
            : (isBananaImage(task.snapshot.model) || isSeedreamImage(task.snapshot.model)) && output.width && output.height ? { width: output.width, height: output.height } : {}
          return this.store.saveMedia(source, { id: output.id, kind: task.snapshot.model.kind, filename: output.filename, createdAt: Date.now(), nodeId: task.nodeId, taskId: task.id, ...dimensions }, this.config.maxMediaBytes, task.snapshot.model.kind, this.controller.signal)
        })
        await this.store.update(task.workspaceId, (state) => {
          if (!state.assets.some((a) => a.id === asset.id)) state.assets.push(asset)
          const current = state.tasks.find((t) => t.id === task.id)!
          if (!current.resultIds.includes(asset.id)) current.resultIds.push(asset.id)
        })
      } catch (error) {
        if (this.controller.signal.aborted) throw error
        saveErrors.push(this.store.redact(error instanceof Error ? error.message : '保存失败', [data.key]))
      }
    }
    if (saveErrors.length) throw new Error(`${saveErrors.length} 份结果保存失败：${saveErrors[0]}`)
    const expected = !isTtsSnapshot(task.snapshot) && task.snapshot.model.kind === 'image' ? task.snapshot.params.n : data.outputs!.length
    const partial = data.outputs!.length !== expected
    const error = partial ? `部分失败：请求 ${expected} 张，已保存 ${data.outputs!.length} 张；未自动重提` : undefined
    await this.patch(task, { status: partial ? 'failed' : 'completed', progress: 100, error }, partial ? [
      sql("UPDATE task_details SET phase='failed',failure_stage='provider',failure_code='PARTIAL_RESULT',failure_message=? WHERE task_id=?", [error!, task.id]),
    ] : [])
    await this.store.removeTaskPrivate(task.id)
  }
  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.controller.abort()
    await this.uploads.close()
    await this.scanWork
    await this.maintenance
    await Promise.allSettled([...this.active.values()])
  }
}
