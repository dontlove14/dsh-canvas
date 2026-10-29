import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { join } from 'node:path'
import type { StorageFactory, ObjectHead, StorageRecord } from '../../src/host/object-storage/types'
import type { ObjectLocator, StorageInput } from '../../src/shared/objectStorage'
import type { Store } from '../../src/host/store'
import type { CanvasService } from '../../src/host/service'

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const path = (root: string, bucket: string, key: string) => join(root, '_fake_cloud', digest(Buffer.from(`${bucket}/${key}`)))
/** A test double for remote storage, never part of the shipped runtime. */
export function fakeFactory(root: string): StorageFactory {
  return (record) => {
    const file = (key: string) => path(root, record.bucket, key)
    const head = async (key: string): Promise<ObjectHead | null> => {
      try {
        const bytes = await readFile(file(key)), meta = JSON.parse(await readFile(`${file(key)}.json`, 'utf8'))
        return { bytes: bytes.length, sha256: meta.sha256, etag: digest(bytes) }
      } catch (error) { if ((error as any).code === 'ENOENT') return null; throw error }
    }
    const put = async (key: string, source: string | Buffer, mime: string, sha256: string) => {
      await mkdir(join(root, '_fake_cloud'), { recursive: true, mode: 0o700 })
      const bytes = typeof source === 'string' ? await readFile(source) : source
      await writeFile(file(key), bytes, { mode: 0o600, flag: 'wx' })
      await writeFile(`${file(key)}.json`, JSON.stringify({ mime, sha256 }), { mode: 0o600 })
      return (await head(key))!
    }
    return {
      head, put,
      openRead: async (locator) => createReadStream(file(locator.objectKey)),
      signRead: async (key, options) => `https://fake.invalid/${encodeURIComponent(key)}?bucket=${record.bucket}&method=${options.method}&expires=${options.ttl}&signature=${randomUUID()}${options.download ? '&download=1' : ''}`,
      readProbe: async (url) => readFile(file(decodeURIComponent(new URL(url).pathname.slice(1)))),
      deleteProbe: async (key) => { await rm(file(key), { force: true }); await rm(`${file(key)}.json`, { force: true }) },
      copy: async (source, target) => {
        const meta = await head(source.objectKey)
        if (!meta || source.etag && meta.etag !== source.etag) throw new Error('Copy source changed')
        return put(target, file(source.objectKey), source.mime, source.sha256)
      },
    }
  }
}
export function storageInput(revision = 0, bucket = 'test-bucket'): StorageInput {
  return { requestId: randomUUID(), revision, type: 'aliyun-oss', name: bucket, bucket, region: 'oss-cn-hangzhou',
    endpoint: 'https://oss-cn-hangzhou.aliyuncs.com', prefix: 'dsh-canvas', accessKeyId: 'test-ak', accessKeySecret: 'test-sk' }
}
export async function initialize(instance: CanvasService, runtime = false) {
  await instance.store.init()
  await instance.reviews.init()
  if (!(await instance.store.storage()).configured) await instance.store.setStorage(storageInput())
  if (runtime) { await instance.reviewRuntime.start(); await instance.runtime.start() }
}
export async function cloudPath(store: Store, id: string): Promise<string> {
  const canvas = await store.db.get('SELECT canvas_id FROM canvas_assets WHERE id=?', [id])
  const locator = await store.locator(canvas.canvas_id, id)
  const record = await store.storageRecord(locator.providerId)
  return path(store.root, record.bucket, locator.objectKey)
}
export async function remoteBody(store: Store, response: Response): Promise<Buffer> {
  if (response.status !== 307) throw new Error(`Expected OSS redirect, received ${response.status}: ${await response.text()}`)
  const url = new URL(response.headers.get('location')!)
  return readFile(path(store.root, url.searchParams.get('bucket')!, decodeURIComponent(url.pathname.slice(1))))
}
