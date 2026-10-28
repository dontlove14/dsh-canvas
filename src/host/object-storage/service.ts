import { createHash, randomUUID } from 'node:crypto'
import type { ObjectLocator, StorageInput } from '../../shared/objectStorage'
import type { CredentialVault } from '../credentials'
import { CanvasError } from '../store'
import { AliyunStorage } from './aliyun'
import type { StorageRecord, StorageCredentials, StorageFactory, ObjectStorageAdapter, SignOptions, ObjectHead } from './types'
import { realpath } from 'node:fs/promises'
import { fileHash } from '../media/files'

export class ObjectStorage {
  private adapters = new Map<string, ObjectStorageAdapter>()
  private urls = new Map<string, { url: string; expiresAt: number }>()
  private inflight = new Map<string, Promise<{ url: string; expiresAt: number }>>()
  constructor(private vault: CredentialVault, private record: (id: string) => Promise<StorageRecord>,
    private factory: StorageFactory = (r, c) => new AliyunStorage(r, c), private now = Date.now) {}
  async adapter(id: string, pinnedCredentialRef?: string): Promise<ObjectStorageAdapter> {
    const record = await this.record(id)
    const ref = pinnedCredentialRef ?? record.readCredentialRef ?? record.credentialRef
    const key = JSON.stringify([id, ref])
    const existing = this.adapters.get(key)
    if (existing) return existing
    const credentials = JSON.parse(await this.vault.read(ref)) as StorageCredentials
    if (!credentials.accessKeyId || !credentials.accessKeySecret) throw new CanvasError('对象存储凭据不可用', 409, 'STORAGE_CREDENTIALS_MISSING')
    const adapter = this.factory(record, credentials)
    this.adapters.set(key, adapter)
    return adapter
  }
  async probe(input: StorageInput, credentials: StorageCredentials): Promise<void> {
    const adapter = this.factory({ ...input, id: randomUUID(), credentialRef: '', verifiedAt: 0 }, credentials)
    const key = `${input.prefix}/_probe/${randomUUID()}.txt`
    const bytes = Buffer.from(`dsh-canvas:${randomUUID()}`); const sha256 = createHash('sha256').update(bytes).digest('hex')
    let wrote = false
    try {
      await adapter.put(key, bytes, 'text/plain', sha256); wrote = true
      this.check(await adapter.head(key), { bytes: bytes.length, sha256 })
      const url = await adapter.signRead(key, { method: 'GET', ttl: 60 })
      if (!(await adapter.readProbe(url)).equals(bytes)) throw new CanvasError('OSS 签名读取内容不一致', 502, 'STORAGE_PROBE_FAILED')
    } finally {
      // A timed-out write may still have reached OSS. Cleanup only this unique probe key.
      await adapter.deleteProbe(key).catch((error) => { if (wrote) throw error })
    }
  }
  check(head: ObjectHead | null, expected: { bytes: number; sha256: string; etag?: string }): ObjectHead {
    if (!head || head.bytes !== expected.bytes || head.sha256 !== expected.sha256 || expected.etag && head.etag !== expected.etag)
      throw new CanvasError('对象身份校验失败，文件可能被外部修改', 409, 'OBJECT_CHANGED')
    return head
  }
  async verify(locator: ObjectLocator): Promise<void> {
    this.check(await (await this.adapter(locator.providerId, locator.credentialRef)).head(locator.objectKey, locator.versionId), locator)
  }
  async publish(locator: ObjectLocator, source: string | Buffer): Promise<ObjectHead> {
    const adapter = await this.adapter(locator.providerId, locator.credentialRef)
    const existing = await adapter.head(locator.objectKey, locator.versionId)
    if (existing) return this.check(existing, locator)
    if (typeof source === 'string') {
      if (await realpath(source) !== source || await fileHash(source) !== locator.sha256)
        throw new CanvasError('上传暂存文件身份发生变化', 409, 'STAGING_CHANGED')
    } else if (createHash('sha256').update(source).digest('hex') !== locator.sha256)
      throw new CanvasError('上传内容身份发生变化', 409, 'STAGING_CHANGED')
    try { return this.check(await adapter.put(locator.objectKey, source, locator.mime, locator.sha256), locator) }
    catch (error) {
      // Interrupted ACK / concurrent publication: accept only the exact immutable object.
      const head = await adapter.head(locator.objectKey).catch(() => null)
      if (head) return this.check(head, locator)
      throw error
    }
  }
  async read(locator: ObjectLocator, limit: number): Promise<Buffer> {
    if (locator.bytes > limit) throw new CanvasError('参考素材超过大小限制', 413)
    await this.verify(locator)
    const stream = await (await this.adapter(locator.providerId, locator.credentialRef)).openRead(locator)
    const chunks: Buffer[] = []; let bytes = 0
    try {
      for await (const chunk of stream) {
        bytes += chunk.length
        if (bytes > limit) throw new CanvasError('对象读取超过大小限制', 413)
        chunks.push(Buffer.from(chunk))
      }
      const result = Buffer.concat(chunks)
      if (bytes !== locator.bytes || createHash('sha256').update(result).digest('hex') !== locator.sha256)
        throw new CanvasError('对象内容校验失败', 409, 'OBJECT_CHANGED')
      return result
    } finally { stream.destroy() }
  }
  async sign(locator: ObjectLocator, options: SignOptions, fresh = false): Promise<{ url: string; expiresAt: number }> {
    const record = await this.record(locator.providerId)
    const key = JSON.stringify([record.id, record.revision, locator.credentialRef ?? record.readCredentialRef ?? record.credentialRef, locator, options])
    const cached = this.urls.get(key)
    if (!fresh && cached && cached.expiresAt - this.now() > 300000) {
      this.urls.delete(key); this.urls.set(key, cached); return cached
    }
    if (!fresh && this.inflight.has(key)) return this.inflight.get(key)!
    const work = (async () => {
      const url = await (await this.adapter(locator.providerId, locator.credentialRef)).signRead(locator.objectKey, { ...options, versionId: locator.versionId })
      const result = { url, expiresAt: this.now() + options.ttl * 1000 }
      if (!fresh) {
        if (this.urls.size >= 2048) this.urls.delete(this.urls.keys().next().value!)
        this.urls.set(key, result)
      }
      return result
    })().finally(() => { if (!fresh) this.inflight.delete(key) })
    if (!fresh) this.inflight.set(key, work)
    return work
  }
}
