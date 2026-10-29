import type { MediaKind } from '../shared/contracts'
import { UPLOAD_CHUNK_BYTES, UPLOAD_CONCURRENCY, type UploadStart, type UploadStatus, type UploadResult } from '../shared/uploads'
import { IndexedUploadCache, type CachedUpload, type UploadCache } from './uploadCache'

export class ApiError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) { super(message) }
}
export interface UploadTransport {
  start(canvas: string, input: UploadStart): Promise<unknown>
  status(canvas: string, id: string): Promise<UploadStatus>
  chunk(job: CachedUpload, offset: number, blob: Blob, checksum: string, progress: (bytes: number) => void): Promise<UploadStatus>
  complete(canvas: string, id: string): Promise<UploadResult>
  cancel(canvas: string, id: string): Promise<unknown>
  link(job: CachedUpload, result: UploadResult): Promise<void>
}
export interface UploadActivity { id: string; canvas: string; filename: string; progress: number; waiting: boolean; error?: string }
type Hooks = { started?: () => Promise<void>; progress?: (value: number) => void }
export class ResumableUploads {
  private jobs = new Map<string, Promise<UploadResult>>()
  private activity = new Map<string, UploadActivity>()
  private listeners = new Set<() => void>()
  private restoreWork?: Promise<void>
  private wakes = new Set<() => void>()
  private active = 0
  private queued: Array<() => void> = []
  constructor(private transport: UploadTransport, private cache: UploadCache,
    private retryMs = 1000, private events: EventTarget | undefined = typeof window === 'undefined' ? undefined : window) {
    const wake = () => { for (const callback of this.wakes) callback() }
    events?.addEventListener('online', wake); events?.addEventListener('focus', wake)
  }
  subscribe(callback: () => void) { this.listeners.add(callback); return () => { this.listeners.delete(callback) } }
  activities(canvas: string) { return [...this.activity.values()].filter((job) => job.canvas === canvas) }
  private update(job: CachedUpload, progress: number, waiting: boolean, error?: string, hooks?: Hooks) {
    this.activity.set(job.requestId, { id: job.requestId, canvas: job.canvas, filename: job.filename, progress, waiting, error })
    hooks?.progress?.(progress)
    for (const listener of this.listeners) listener()
  }
  async restore() {
    if (this.restoreWork) return this.restoreWork
    const restoring = (async () => {
      for (const job of await this.cache.list()) void this.run(job).catch(() => {})
    })()
    this.restoreWork = restoring
    try { await restoring } finally { if (this.restoreWork === restoring) this.restoreWork = undefined }
  }
  async upload(canvas: string, file: File, kind: MediaKind, position: { x: number; y: number }, hooks: Hooks, target?: string) {
    if (!file.size) throw new Error('不能上传空文件')
    const job: CachedUpload = { requestId: crypto.randomUUID(), canvas, file, filename: file.name, kind, position, size: file.size, ...(target ? { target } : {}) }
    try { await this.cache.put(job) }
    catch { throw new Error('无法保存上传恢复缓存，请检查浏览器存储空间和权限后重试') }
    return this.run(job, hooks)
  }
  private run(job: CachedUpload, hooks: Hooks = {}): Promise<UploadResult> {
    const existing = this.jobs.get(job.requestId)
    if (existing) return existing
    this.update(job, 0, false, undefined, hooks)
    const slot = this.active < UPLOAD_CONCURRENCY ? (this.active++, Promise.resolve()) : new Promise<void>((resolve) => this.queued.push(resolve))
    const promise = slot.then(() => this.transfer(job, hooks)).finally(() => {
      const next = this.queued.shift()
      if (next) next(); else this.active--
      this.jobs.delete(job.requestId); this.activity.delete(job.requestId)
      for (const listener of this.listeners) listener()
    })
    this.jobs.set(job.requestId, promise)
    return promise
  }
  private retry(error: unknown) {
    return !(error instanceof ApiError) || [401, 403, 408, 429].includes(error.status)
      || error.status >= 500 || ['UPLOAD_OFFSET_MISMATCH', 'UPLOAD_BUSY'].includes(error.code)
  }
  private wait(ms: number) {
    return new Promise<void>((resolve) => {
      const done = () => { clearTimeout(timer); this.wakes.delete(done); resolve() }
      const timer = setTimeout(done, ms)
      this.wakes.add(done)
    })
  }
  private async transfer(job: CachedUpload, hooks: Hooks): Promise<UploadResult> {
    let attempts = 0, started = false, acknowledged = false, progress = 0
    for (;;) {
      try {
        let result = job.result
        if (!result) {
          const { canvas, file: _f, target: _t, result: _r, ...input } = job
          if (!acknowledged) { await this.transport.start(canvas, input); acknowledged = true }
          if (!started) { started = true; await hooks.started?.().catch(() => {}) }
          const state = await this.transport.status(canvas, job.requestId)
          if (state.state === 'failed') throw new ApiError('上传暂存数据已失效，请重新上传', 'UPLOAD_FAILED', 409)
          if (state.size !== job.file.size || state.chunkBytes < 1 || state.chunkBytes > UPLOAD_CHUNK_BYTES || state.offset < 0 || state.offset > state.size)
            throw new ApiError('上传恢复数据与原文件不一致', 'UPLOAD_CORRUPT', 409)
          progress = Math.floor(state.offset / state.size * 100)
          this.update(job, progress, false, undefined, hooks)
          if (state.taskId) result = { taskId: state.taskId, nodeId: state.nodeId }
          else if (state.offset < state.size) {
            const blob = job.file.slice(state.offset, Math.min(state.offset + state.chunkBytes, state.size))
            const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
            const checksum = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
            const accepted = await this.transport.chunk(job, state.offset, blob, checksum, (bytes) => {
              progress = Math.floor((state.offset + bytes) / state.size * 100)
              this.update(job, progress, false, undefined, hooks)
            })
            progress = Math.floor(accepted.offset / state.size * 100)
            this.update(job, progress, false, undefined, hooks)
            attempts = 0; continue
          } else result = await this.transport.complete(canvas, job.requestId)
          job = { ...job, result }
          await this.cache.put(job)
        }
        this.update(job, 100, false, undefined, hooks)
        if (job.target) await this.transport.link(job, result)
        await this.cache.remove(job.requestId)
        return result
      } catch (error) {
        if (!this.retry(error)) {
          if (!job.result) await this.transport.cancel(job.canvas, job.requestId).catch(() => {})
          await this.cache.remove(job.requestId)
          throw error
        }
        this.update(job, progress, true, error instanceof ApiError && [401, 403].includes(error.status) ? '请登录 Harness 后继续上传' : undefined, hooks)
        await this.wait(Math.min(15000, this.retryMs * 2 ** Math.min(attempts++, 4)) * (0.8 + Math.random() * 0.4))
      }
    }
  }
}
export const uploadCacheFor = (base: string) => new IndexedUploadCache(`dsh-canvas-uploads:${base}`)
