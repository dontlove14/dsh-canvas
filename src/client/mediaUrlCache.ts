import type { MediaUrl, MediaVariant } from '../shared/objectStorage'

export interface UrlResolver {
  mediaUrls(canvas: string, items: Array<{ assetId: string; variant: MediaVariant }>, force?: boolean): Promise<{ items: Array<MediaUrl | { assetId: string; variant: MediaVariant; error: string }> }>
}
export interface CachedMediaUrl extends MediaUrl { revision: number }
export type MediaRefreshReason = 'timer' | 'resume' | 'online' | 'invalidate' | 'updated'
const mediaKey = (canvas: string, id: string, variant: MediaVariant) => JSON.stringify([canvas, id, variant])
export class MediaUrlCache {
  private values = new Map<string, CachedMediaUrl>()
  private pending = new Map<string, Promise<CachedMediaUrl>>()
  private batch = new Map<string, { canvas: string; assetId: string; variant: MediaVariant; force: boolean; resolve: (v: CachedMediaUrl) => void; reject: (e: Error) => void }>()
  private scheduled = false
  private epoch = 0
  private revision = 0
  private recovering = new Set<string>()
  private watchers = new Map<string, Set<(reason: MediaRefreshReason) => void>>()
  private timer?: ReturnType<typeof setInterval>
  private refresh = (reason: MediaRefreshReason) => {
    if (typeof document !== 'undefined' && document.hidden) return
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return
    for (const [key, callbacks] of this.watchers) {
      if (reason !== 'timer') this.recovering.delete(key)
      for (const callback of callbacks) callback(reason)
    }
  }
  private tick = () => this.refresh('timer')
  private resume = () => this.refresh('resume')
  private online = () => this.refresh('online')
  constructor(private api: UrlResolver, private now = Date.now) {}
  peek(canvas: string, id: string, variant: MediaVariant) { return this.values.get(mediaKey(canvas, id, variant)) }
  isFresh(canvas: string, id: string, variant: MediaVariant): boolean {
    const value = this.peek(canvas, id, variant)
    return !!value && value.expiresAt - this.now() > 300000 && !this.pending.has(mediaKey(canvas, id, variant))
  }
  invalidate(): void { this.epoch++; this.values.clear(); this.recovering.clear(); this.refresh('invalidate') }
  /** One forced signature per recovery round, shared by every occurrence of the resource. */
  recover(canvas: string, id: string, variant: MediaVariant, revision: number): Promise<CachedMediaUrl> | undefined {
    const key = mediaKey(canvas, id, variant)
    const pending = this.pending.get(key)
    if (pending) return pending
    const cached = this.values.get(key)
    if (cached && cached.revision !== revision && this.isFresh(canvas, id, variant)) return Promise.resolve(cached)
    if (this.recovering.has(key)) return
    this.recovering.add(key)
    return this.resolve(canvas, id, variant, true)
  }
  loaded(canvas: string, id: string, variant: MediaVariant, revision: number): void {
    if (this.peek(canvas, id, variant)?.revision === revision) this.recovering.delete(mediaKey(canvas, id, variant))
  }
  resolve(canvas: string, assetId: string, variant: MediaVariant, force = false): Promise<CachedMediaUrl> {
    const key = mediaKey(canvas, assetId, variant)
    // A normal reader must join a forced refresh instead of receiving the known bad old URL.
    if (this.pending.has(key)) return this.pending.get(key)!
    const cached = this.values.get(key)
    if (!force && cached && cached.expiresAt - this.now() > 300000) return Promise.resolve(cached)
    const work = new Promise<CachedMediaUrl>((resolve, reject) => {
      this.batch.set(key, { canvas, assetId, variant, force, resolve, reject })
      if (!this.scheduled) { this.scheduled = true; queueMicrotask(() => void this.flush()) }
    }).finally(() => this.pending.delete(key))
    this.pending.set(key, work); return work
  }
  watch(canvas: string, id: string, variant: MediaVariant, callback: (reason: MediaRefreshReason) => void): () => void {
    const key = mediaKey(canvas, id, variant)
    const callbacks = this.watchers.get(key) ?? new Set()
    callbacks.add(callback); this.watchers.set(key, callbacks)
    if (!this.timer) {
      this.timer = setInterval(this.tick, 60000)
      document.addEventListener('visibilitychange', this.resume)
      window.addEventListener('focus', this.resume); window.addEventListener('pageshow', this.resume)
      window.addEventListener('online', this.online)
    }
    return () => {
      callbacks.delete(callback)
      if (!callbacks.size) { this.watchers.delete(key); this.recovering.delete(key) }
      if (!this.watchers.size) {
        clearInterval(this.timer); this.timer = undefined
        document.removeEventListener('visibilitychange', this.resume)
        window.removeEventListener('focus', this.resume); window.removeEventListener('pageshow', this.resume)
        window.removeEventListener('online', this.online)
      }
    }
  }
  private async flush(): Promise<void> {
    this.scheduled = false
    const entries = [...this.batch.entries()]; this.batch.clear()
    const groups = new Map<string, typeof entries>()
    for (const entry of entries) {
      const key = JSON.stringify([entry[1].canvas, entry[1].force])
      const group = groups.get(key) ?? []; group.push(entry); groups.set(key, group)
    }
    for (const [, group] of groups) for (let offset = 0; offset < group.length; offset += 100) {
      const chunk = group.slice(offset, offset + 100)
      try {
        const epoch = this.epoch
        const items = chunk.map(([, v]) => ({ assetId: v.assetId, variant: v.variant }))
        let result = await this.api.mediaUrls(chunk[0][1].canvas, items, chunk[0][1].force)
        if (epoch !== this.epoch) result = await this.api.mediaUrls(chunk[0][1].canvas, items, true)
        for (const [key, request] of chunk) {
          const item = result.items.find((v) => v.assetId === request.assetId && v.variant === request.variant)
          if (!item || 'error' in item) { request.reject(new Error(item && 'error' in item ? item.error : '媒体链接不可用')); continue }
          if (!this.values.has(key) && this.values.size >= 2048) {
            const oldest = this.values.keys().next().value!
            this.values.delete(oldest); this.recovering.delete(oldest)
          }
          const next = { ...item, revision: ++this.revision }
          this.values.set(key, next)
          if (!request.force) this.recovering.delete(key)
          request.resolve(next)
          for (const callback of this.watchers.get(key) ?? []) callback('updated')
        }
      } catch (error) { for (const [, request] of chunk) request.reject(error instanceof Error ? error : new Error('媒体链接读取失败')) }
    }
  }
}
