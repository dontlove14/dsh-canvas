import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Store } from '../store'
import { CanvasError } from '../store'
import { sql } from '../persistence/database'
import { PreviewCache } from '../media/previews'
import { decodeWaveform } from '../media/waveforms'
import { receive } from '../media/files'
import type { ObjectLocator, MediaVariant } from '../../shared/objectStorage'
import { WaveformSchema } from '../../shared/audioWaveform'

const MAX_WAVEFORM_BYTES = 8192
const WAVEFORM_CACHE_TTL = 3600000

/** Bounded temporary decoding; only uploaded derivatives persist. */
export class DerivedAssets {
  private queue: Promise<unknown> = Promise.resolve()
  private pending = new Map<string, Promise<ObjectLocator>>()
  private failed = new Map<string, number>()
  private waveformCache = new Map<string, { bytes: Buffer; expiresAt: number }>()
  private waveformPending = new Map<string, Promise<Buffer>>()
  private waveformFailed = new Map<string, number>()
  private controller = new AbortController()
  constructor(private store: Store, private limit: number) {}
  async get(canvas: string, id: string, variant: MediaVariant): Promise<ObjectLocator> {
    const original = await this.store.locator(canvas, id)
    if (variant === 'original') return original
    try { return await this.store.locator(canvas, id, variant) }
    catch (error) { if (!(error instanceof CanvasError) || error.code !== 'VARIANT_UNAVAILABLE') throw error }
    if (variant === 'waveform' && !original.mime.startsWith('audio/') || variant === 'preview' && original.mime.startsWith('audio/'))
      throw new CanvasError('媒体类型不支持该派生资源', 415)
    const key = JSON.stringify([canvas, id, variant, original])
    if (this.pending.has(key)) return this.pending.get(key)!
    if ((this.failed.get(key) ?? 0) > Date.now()) throw new CanvasError('派生资源暂不可用，请稍后重试', 422, 'VARIANT_UNAVAILABLE')
    if (this.pending.size >= 32) throw new CanvasError('媒体处理队列忙，请稍后重试', 503)
    const job = this.queue.then(async () => {
      const signal = this.controller.signal; signal.throwIfAborted()
      const directory = await realpath(await mkdtemp(join(tmpdir(), 'dsh-canvas-decode-')))
      const previews = new PreviewCache(directory)
      try {
        const path = join(directory, `${randomUUID()}.media`)
        await this.store.objects.verify(original)
        const stream = await (await this.store.objects.adapter(original.providerId)).openRead(original)
        const info = await receive(stream, path, this.limit, original.mime.startsWith('audio/') ? 'audio' : original.mime.startsWith('video/') ? 'video' : 'image', signal)
        if (info.fileHash !== original.sha256) throw new CanvasError('媒体内容发生变化', 409, 'OBJECT_CHANGED')
        const bytes = variant === 'waveform'
          ? Buffer.from(JSON.stringify(await decodeWaveform(path, signal)))
          : await readFile(await previews.get(canvas, id, path, original.sha256, original.mime.startsWith('video/') ? 'video' : 'image'))
        const sha256 = createHash('sha256').update(bytes).digest('hex')
        const locator: ObjectLocator = {
          providerId: original.providerId, objectKey: `${original.objectKey.slice(0, original.objectKey.lastIndexOf('/'))}/_derived/${id}/${variant}-v1-${sha256.slice(0, 12)}.${variant === 'waveform' ? 'json' : 'webp'}`,
          bytes: bytes.length, sha256, mime: variant === 'waveform' ? 'application/json' : 'image/webp',
        }
        const receipt = await this.store.objects.publish(locator, bytes)
        locator.etag = receipt.etag; locator.versionId = receipt.versionId
        await this.store.serial(async () => {
          // A rename during decoding must not register a derivative under an obsolete directory.
          if (JSON.stringify(await this.store.locator(canvas, id)) !== JSON.stringify(original))
            throw new CanvasError('媒体位置已更新，请重新读取', 409, 'OBJECT_CHANGED')
          await this.store.db.batch([sql('INSERT OR REPLACE INTO asset_variants VALUES(?,?,?,?)', [canvas, id, variant, JSON.stringify(locator)])])
        })
        return locator
      } finally { await previews.close(); await rm(directory, { recursive: true, force: true }) }
    }).catch((error) => {
      if (this.failed.size >= 128) this.failed.delete(this.failed.keys().next().value!)
      this.failed.set(key, Date.now() + 30000); throw error
    }).finally(() => this.pending.delete(key))
    this.pending.set(key, job); this.queue = job.catch(() => {})
    return job
  }
  /** Same-origin JSON for browsers; OSS remains the durable source of the envelope. */
  async waveform(canvas: string, id: string): Promise<Buffer> {
    const signal = this.controller.signal; signal.throwIfAborted()
    const locator = await this.get(canvas, id, 'waveform')
    signal.throwIfAborted()
    const key = JSON.stringify([locator.providerId, locator.objectKey, locator.versionId, locator.etag, locator.sha256, locator.bytes])
    const cached = this.waveformCache.get(key)
    if (cached && cached.expiresAt > Date.now()) {
      this.waveformCache.delete(key); this.waveformCache.set(key, cached); return cached.bytes
    }
    this.waveformCache.delete(key)
    if (this.waveformPending.has(key)) return this.waveformPending.get(key)!
    if ((this.waveformFailed.get(key) ?? 0) > Date.now())
      throw new CanvasError('波形暂不可用，请稍后重试', 422, 'WAVEFORM_UNAVAILABLE')
    if (this.waveformPending.size >= 32) throw new CanvasError('波形读取队列忙，请稍后重试', 503)
    const job = this.readWaveform(locator).then((bytes) => {
      signal.throwIfAborted()
      if (this.waveformCache.size >= 2048) this.waveformCache.delete(this.waveformCache.keys().next().value!)
      this.waveformCache.set(key, { bytes, expiresAt: Date.now() + WAVEFORM_CACHE_TTL })
      this.waveformFailed.delete(key)
      return bytes
    }).catch((error) => {
      if (this.waveformFailed.size >= 128) this.waveformFailed.delete(this.waveformFailed.keys().next().value!)
      this.waveformFailed.set(key, Date.now() + 30000); throw error
    }).finally(() => this.waveformPending.delete(key))
    this.waveformPending.set(key, job)
    return job
  }
  private async readWaveform(locator: ObjectLocator): Promise<Buffer> {
    if (locator.bytes > MAX_WAVEFORM_BYTES) throw new CanvasError('波形数据超过大小限制', 422, 'WAVEFORM_UNAVAILABLE')
    const signal = this.controller.signal; signal.throwIfAborted()
    const stream = await (await this.store.objects.adapter(locator.providerId, locator.credentialRef)).openRead(locator)
    const abort = () => stream.destroy(new Error('Waveform read aborted'))
    signal.addEventListener('abort', abort, { once: true })
    const chunks: Buffer[] = []; let length = 0
    try {
      signal.throwIfAborted()
      for await (const chunk of stream) {
        length += chunk.length
        if (length > MAX_WAVEFORM_BYTES) throw new CanvasError('波形数据超过大小限制', 422, 'WAVEFORM_UNAVAILABLE')
        chunks.push(Buffer.from(chunk))
      }
      signal.throwIfAborted()
      const bytes = Buffer.concat(chunks)
      if (length !== locator.bytes || createHash('sha256').update(bytes).digest('hex') !== locator.sha256)
        throw new CanvasError('波形对象内容发生变化', 409, 'OBJECT_CHANGED')
      try { WaveformSchema.parse(JSON.parse(bytes.toString('utf8'))) }
      catch { throw new CanvasError('波形数据不可用，仍可播放原音频', 422, 'WAVEFORM_UNAVAILABLE') }
      return bytes
    } finally { signal.removeEventListener('abort', abort); stream.destroy() }
  }
  async close(): Promise<void> {
    this.controller.abort()
    await Promise.allSettled([this.queue, ...this.waveformPending.values()])
    this.waveformCache.clear(); this.waveformFailed.clear()
  }
}
