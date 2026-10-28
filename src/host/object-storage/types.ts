import type { Readable } from 'node:stream'
import type { ObjectLocator } from '../../shared/objectStorage'

export interface StorageRecord {
  id: string; type: 'aliyun-oss'; name: string; region: string; bucket: string; endpoint: string; prefix: string
  credentialRef: string; readCredentialRef?: string; revision: number; verifiedAt: number
}
export interface StorageCredentials { accessKeyId: string; accessKeySecret: string }
export interface ObjectHead { bytes: number; sha256: string; etag: string; versionId?: string }
export interface SignOptions { method: 'GET' | 'HEAD'; ttl: number; download?: string; versionId?: string }
/** Provider implementations never receive database or canvas mutation access. */
export interface ObjectStorageAdapter {
  head(key: string, versionId?: string): Promise<ObjectHead | null>
  put(key: string, source: string | Buffer, mime: string, sha256: string): Promise<ObjectHead>
  openRead(locator: ObjectLocator): Promise<Readable>
  signRead(key: string, options: SignOptions): Promise<string>
  copy(source: ObjectLocator, targetKey: string): Promise<ObjectHead>
  deleteProbe(key: string): Promise<void>
  readProbe(url: string): Promise<Buffer>
}
export type StorageFactory = (record: StorageRecord, credentials: StorageCredentials) => ObjectStorageAdapter
