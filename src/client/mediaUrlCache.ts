import type { MediaUrl, MediaVariant } from '../shared/objectStorage'

export interface UrlResolver {
  mediaUrls(canvas: string, items: Array<{ assetId: string; variant: MediaVariant }>, force?: boolean): Promise<{ items: Array<MediaUrl | { assetId: string; variant: MediaVariant; error: string }> }>
}
export class MediaUrlCache {
  private values = new Map<string, MediaUrl>()
  private pending = new Map<string, Promise<MediaUrl>>()
  private batch = new Map<string, { canvas: string; assetId: string; variant: MediaVariant; force: boolean; resolve: (v: MediaUrl) => void; reject: (e: Error) => void }>()
  private scheduled = false
  private epoch = 0
  private watchers = new Set<() => void>()
  private timer?: ReturnType<typeof setInterval>
  private refresh = () => { if (typeof document === 'undefined' || !document.hidden) for (const callback of this.watchers) callback() }
  constructor(private api: UrlResolver, private now = Date.now) {}
  peek(canvas: string, id: string, variant: MediaVariant) { return this.values.get(JSON.stringify([canvas, id, variant])) }
  invalidate(): void { this.epoch++; this.values.clear(); this.refresh() }
  resolve(canvas: string, assetId: string, variant: MediaVariant, force = false): Promise<MediaUrl> {
    const key = JSON.stringify([canvas, assetId, variant])
    const cached = this.values.get(key)
    if (!force && cached && cached.expiresAt - this.now() > 300000) return Promise.resolve(cached)
    if (this.pending.has(key)) return this.pending.get(key)!
    const work = new Promise<MediaUrl>((resolve, reject) => {
      this.batch.set(key, { canvas, assetId, variant, force, resolve, reject })
      if (!this.scheduled) { this.scheduled = true; queueMicrotask(() => void this.flush()) }
    }).finally(() => this.pending.delete(key))
    this.pending.set(key, work); return work
  }
  watch(callback: () => void): () => void {
    this.watchers.add(callback)
    if (!this.timer) {
      this.timer = setInterval(this.refresh, 60000)
      document.addEventListener('visibilitychange', this.refresh); window.addEventListener('focus', this.refresh)
    }
    return () => {
      this.watchers.delete(callback)
      if (!this.watchers.size) {
        clearInterval(this.timer); this.timer = undefined
        document.removeEventListener('visibilitychange', this.refresh); window.removeEventListener('focus', this.refresh)
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
          if (this.values.size >= 2048) this.values.delete(this.values.keys().next().value!)
          this.values.set(key, item); request.resolve(item)
        }
      } catch (error) { for (const [, request] of chunk) request.reject(error instanceof Error ? error : new Error('媒体链接读取失败')) }
    }
  }
}
