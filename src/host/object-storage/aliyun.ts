import OSS from 'ali-oss'
import type { ObjectLocator } from '../../shared/objectStorage'
import type { ObjectStorageAdapter, ObjectHead, SignOptions, StorageRecord, StorageCredentials } from './types'
import { CanvasError } from '../store'

/** Only standard external HTTPS endpoints reach this adapter; AK never reaches Client. */
export class AliyunStorage implements ObjectStorageAdapter {
  private client: OSS
  constructor(record: StorageRecord, credentials: StorageCredentials) {
    this.client = new OSS({ region: record.region, bucket: record.bucket, endpoint: record.endpoint,
      ...credentials, secure: true, authorizationV4: true, timeout: 120000 })
  }
  private receipt(headers: Record<string, any>, meta: Record<string, any> = {}): ObjectHead {
    return { bytes: Number(headers['content-length']), sha256: String(meta?.sha256 ?? headers['x-oss-meta-sha256'] ?? ''),
      etag: String(headers.etag ?? '').replace(/^"|"$/g, ''),
      ...(headers['x-oss-version-id'] ? { versionId: String(headers['x-oss-version-id']) } : {}) }
  }
  async head(key: string, versionId?: string): Promise<ObjectHead | null> {
    try {
      const result = await this.client.head(key, { ...(versionId ? { versionId } : {}) } as OSS.HeadObjectOptions)
      return this.receipt(result.res.headers, result.meta)
    } catch (error) { if ((error as any).status === 404) return null; throw this.failure('HEAD', error) }
  }
  async put(key: string, source: string | Buffer, mime: string, sha256: string): Promise<ObjectHead> {
    try {
      await this.client.put(key, source, { mime, headers: { 'x-oss-forbid-overwrite': 'true', 'x-oss-meta-sha256': sha256 } })
      return (await this.head(key))!
    } catch (error) { throw this.failure('上传', error) }
  }
  async openRead(locator: ObjectLocator) {
    try {
      const result = await this.client.getStream(locator.objectKey, {
        headers: locator.etag ? { 'If-Match': `"${locator.etag}"` } : {},
        ...(locator.versionId ? { versionId: locator.versionId } : {}),
      })
      return result.stream
    } catch (error) { throw this.failure('读取', error) }
  }
  async signRead(key: string, options: SignOptions): Promise<string> {
    try {
      // SDK supports arbitrary HTTP methods; the community declaration omits HEAD.
      return await this.client.signatureUrlV4(options.method as OSS.HTTPMethods, options.ttl, { headers: {}, queries: {
        ...(options.versionId ? { versionId: options.versionId } : {}),
        ...(options.download ? { 'response-content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(options.download)}` } : {}),
      } }, key)
    } catch (error) { throw this.failure('签名', error) }
  }
  async copy(source: ObjectLocator, targetKey: string): Promise<ObjectHead> {
    try {
      await this.client.copy(targetKey, source.objectKey, {
        headers: { 'x-oss-forbid-overwrite': 'true', ...(source.etag ? { 'x-oss-copy-source-if-match': `"${source.etag}"` } : {}) },
        ...(source.versionId ? { versionId: source.versionId } : {}),
      })
      return (await this.head(targetKey))!
    } catch (error) { throw this.failure('复制', error) }
  }
  async deleteProbe(key: string): Promise<void> {
    try { await this.client.delete(key) } catch (error) { throw this.failure('删除探测对象', error) }
  }
  async readProbe(url: string): Promise<Buffer> {
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20000) })
    if (!response.ok) throw new CanvasError(`OSS 签名读取测试失败（HTTP ${response.status}）`, 502, 'STORAGE_UNAVAILABLE')
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > 4096) throw new CanvasError('OSS 探测响应异常', 502, 'STORAGE_UNAVAILABLE')
    return bytes
  }
  private failure(stage: string, error: unknown): CanvasError {
    const value = error as { code?: string; status?: number; requestId?: string }
    return new CanvasError(`OSS ${stage}失败（${String(value.code ?? value.status ?? '网络错误').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80)}）`, 502, 'STORAGE_UNAVAILABLE')
  }
}
