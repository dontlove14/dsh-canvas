import type { CanvasApi } from './api'
import type { AgentSpaceFile, AgentSpaceManifest } from '../shared/agentSpace'

export interface AgentSpaceProgress { status: 'idle' | 'loading' | 'ready' | 'error'; percent: number }
interface Resource { url: string; video?: HTMLVideoElement; image?: HTMLImageElement; ready: boolean }
const INITIAL: AgentSpaceProgress = { status: 'idle', percent: 0 }
const timeoutMs = 60_000

export async function parallelLimit<T>(items: readonly T[], limit: number, operation: (item: T) => Promise<void>) {
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) await operation(items[cursor++])
  }))
}
async function decodeResource(resource: Resource, entry: AgentSpaceFile, signal: AbortSignal) {
  signal.throwIfAborted()
  if (entry.mime !== 'video/webm') {
    const image = resource.image = new Image()
    await new Promise<void>((resolve, reject) => {
      const done = (error?: unknown) => {
        clearTimeout(timer); signal.removeEventListener('abort', failed)
        error ? reject(error) : resolve()
      }
      const failed = () => done(new Error('无法准备图片首帧'))
      const timer = setTimeout(failed, timeoutMs)
      signal.addEventListener('abort', failed, { once: true })
      image.src = resource.url
      image.decode().then(() => done(), done)
    })
    signal.throwIfAborted()
    return
  }
  const video = resource.video = document.createElement('video')
  video.muted = true; video.playsInline = true; video.preload = 'auto'
  await new Promise<void>((resolve, reject) => {
    const done = (error?: unknown) => {
      clearTimeout(timer); video.removeEventListener('loadeddata', loaded); video.removeEventListener('error', failed)
      signal.removeEventListener('abort', failed)
      error ? reject(error) : resolve()
    }
    const loaded = () => { if (video.readyState >= 2) done() }
    const failed = () => done(new Error('无法准备视频首帧'))
    const timer = setTimeout(failed, timeoutMs)
    video.addEventListener('loadeddata', loaded); video.addEventListener('error', failed)
    signal.addEventListener('abort', failed, { once: true })
    video.src = resource.url; video.load(); loaded()
  })
  video.pause()
}
/** Plugin-root bank: one complete, hash-checked Blob and prepared surface per asset. */
export class AgentSpaceResources {
  manifest?: AgentSpaceManifest
  private snapshot: AgentSpaceProgress = INITIAL
  private resources = new Map<string, Resource>()
  private bytes = new Map<string, number>()
  private listeners = new Set<() => void>()
  private pending?: Promise<void>
  private abort?: AbortController
  private generation = 0
  constructor(private api: Pick<CanvasApi, 'url'>, private decode = decodeResource) {}
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  readonly getSnapshot = () => this.snapshot
  private publish(status: AgentSpaceProgress['status']) {
    const files = this.manifest?.files ?? []
    const total = files.reduce((sum, entry) => sum + entry.bytes, 0)
    const received = files.reduce((sum, entry) => sum + Math.min(entry.bytes, this.bytes.get(entry.file) ?? 0), 0)
    const ready = files.filter((entry) => this.resources.get(entry.file)?.ready).length
    const percent = status === 'ready' ? 100 : Math.min(99, Math.floor((total ? received / total * 90 : 0) + (files.length ? ready / files.length * 10 : 0)))
    this.snapshot = { status, percent }
    for (const listener of this.listeners) listener()
  }
  url(file: string) { return this.resources.get(file)?.url }
  video(file: string) { return this.resources.get(file)?.video }
  load(): Promise<void> {
    if (this.snapshot.status === 'ready') return Promise.resolve()
    if (this.pending) return this.pending
    const abort = this.abort = new AbortController(), generation = ++this.generation
    this.publish('loading')
    const current = () => { abort.signal.throwIfAborted(); if (generation !== this.generation) throw new Error('资源准备已结束') }
    const work = (async () => {
      try {
        if (!this.manifest) {
          const response = await fetch(this.api.url('agent-space-assets'), {
            credentials: 'same-origin', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(timeoutMs)]),
          })
          if (!response.ok) throw new Error('资源清单不可用')
          const catalog = await response.json() as AgentSpaceManifest
          current()
          if (!Array.isArray(catalog.files) || !catalog.files.length || catalog.files.length > 256 ||
            catalog.files.some((entry) => !/^[A-Za-z0-9.-]+\.(?:webm|png|svg)$/.test(entry.file) ||
              !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0) ||
            catalog.files.reduce((sum, entry) => sum + entry.bytes, 0) > 200 * 1024 * 1024)
            throw new Error('资源清单不完整')
          this.manifest = catalog
        }
        const errors: unknown[] = []
        await parallelLimit(this.manifest.files, 4, async (entry) => {
          if (this.resources.has(entry.file)) return
          try {
            current()
            this.bytes.set(entry.file, 0)
            const response = await fetch(this.api.url('agent-space-assets', { file: entry.file, hash: entry.sha256 }),
              { credentials: 'same-origin', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(timeoutMs)]) })
            if (!response.ok) throw new Error('资源下载失败')
            const chunks: ArrayBuffer[] = [], reader = response.body?.getReader()
            if (reader) {
              for (;;) {
                const { done, value } = await reader.read()
                if (done) break
                current()
                const count = (this.bytes.get(entry.file) ?? 0) + value.byteLength
                if (count > entry.bytes) { await reader.cancel(); throw new Error('资源长度异常') }
                chunks.push(value.slice().buffer as ArrayBuffer)
                this.bytes.set(entry.file, count); this.publish('loading')
              }
            } else {
              const bytes = await response.arrayBuffer()
              chunks.push(bytes); this.bytes.set(entry.file, bytes.byteLength)
            }
            const blob = new Blob(chunks, { type: entry.mime })
            if (blob.size !== entry.bytes) throw new Error('资源文件未下载完整')
            const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))]
              .map((byte) => byte.toString(16).padStart(2, '0')).join('')
            if (hash !== entry.sha256) throw new Error('资源文件校验失败')
            current()
            this.resources.set(entry.file, { url: URL.createObjectURL(blob), ready: false })
          } catch (error) { current(); errors.push(error) }
        })
        await parallelLimit(this.manifest.files, 2, async (entry) => {
          const resource = this.resources.get(entry.file)
          if (!resource || resource.ready) return
          try { await this.decode(resource, entry, abort.signal); current(); resource.ready = true; this.publish('loading') }
          catch (error) {
            current(); errors.push(error)
            resource.video?.pause(); resource.video?.removeAttribute('src'); resource.video?.load()
            resource.image?.removeAttribute('src')
            resource.video = undefined; resource.image = undefined
          }
        })
        current()
        if (errors.length || this.manifest.files.some((entry) => !this.resources.get(entry.file)?.ready))
          throw new Error('资源尚未准备完整')
        this.publish('ready')
      } catch (error) {
        if (generation === this.generation) this.publish('error')
        throw error
      } finally { if (generation === this.generation) this.pending = undefined }
    })()
    this.pending = work
    return work
  }
  dispose() {
    this.generation++; this.abort?.abort(); this.pending = undefined
    for (const resource of this.resources.values()) {
      resource.video?.pause(); resource.video?.removeAttribute('src'); resource.video?.load()
      resource.image?.removeAttribute('src'); URL.revokeObjectURL(resource.url)
    }
    this.resources.clear(); this.bytes.clear(); this.manifest = undefined; this.snapshot = INITIAL; this.listeners.clear()
  }
}
