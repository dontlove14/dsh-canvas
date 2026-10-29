import type { UploadStart, UploadResult } from '../shared/uploads'

export interface CachedUpload extends UploadStart {
  canvas: string; file: Blob; target?: string; result?: UploadResult
}
export interface UploadCache {
  list(): Promise<CachedUpload[]>
  put(job: CachedUpload): Promise<void>
  remove(id: string): Promise<void>
}
/** Persist the original bytes before creating a server session, so reload can resume it. */
export class IndexedUploadCache implements UploadCache {
  private database?: Promise<IDBDatabase>
  constructor(private name: string) {}
  private open() {
    return this.database ??= new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === 'undefined') { reject(new Error('浏览器不支持上传恢复缓存')); return }
      const request = indexedDB.open(this.name, 1)
      request.onupgradeneeded = () => request.result.createObjectStore('uploads', { keyPath: 'requestId' })
      request.onsuccess = () => {
        const db = request.result
        db.onversionchange = () => { db.close(); this.database = undefined }
        resolve(db)
      }
      request.onerror = () => { this.database = undefined; reject(request.error) }
      request.onblocked = () => { this.database = undefined; reject(new Error('上传恢复缓存被其他页面占用')) }
    })
  }
  private async transaction<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.open()
    return new Promise((resolve, reject) => {
      const tx = db.transaction('uploads', mode), request = operation(tx.objectStore('uploads'))
      tx.oncomplete = () => resolve(request.result)
      tx.onabort = tx.onerror = () => reject(tx.error ?? request.error ?? new Error('上传恢复缓存写入失败'))
    })
  }
  list() { return this.transaction('readonly', (store) => store.getAll()) as Promise<CachedUpload[]> }
  async put(job: CachedUpload) { await this.transaction('readwrite', (store) => store.put(job)) }
  async remove(id: string) { await this.transaction('readwrite', (store) => store.delete(id)) }
}
