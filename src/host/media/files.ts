import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, open, readFile, realpath, link, rm, stat } from 'node:fs/promises'
import { basename, extname, join, relative, resolve, isAbsolute } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { CanvasError, detectMedia } from '../store'
import type { MediaKind } from '../../shared/contracts'

export const pathKey = (v: string): string => v.normalize('NFC').toLocaleLowerCase('en-US')
export function safeName(value: string): string {
  let result = value.normalize('NFC').replace(/[/\\:\x00-\x1f<>\"|?*]/g, '_').replace(/[ .]+$/g, '').trim()
  if (!result || /^\.+$/.test(result) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(result)) result = `_${result || 'media'}`
  while (Buffer.byteLength(result) > 140) result = [...result].slice(0, -1).join('')
  return result
}
export const extension = (mime: string): string => ({ 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp', 'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm', 'audio/mp4': '.m4a', 'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/ogg': '.ogg', 'audio/flac': '.flac' }[mime] ?? '.bin')
export async function checkedDirectory(root: string, component?: string): Promise<string> {
  const actualRoot = await realpath(root)
  const directory = component ? join(actualRoot, component) : actualRoot
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const actual = await realpath(directory)
  const rel = relative(actualRoot, actual)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new CanvasError('媒体目录包含越界的符号链接', 409, 'UNSAFE_PATH')
  return actual
}
export async function validateRoot(input: string): Promise<string> {
  if (!isAbsolute(input)) throw new CanvasError('请输入宿主电脑上的绝对路径')
  const root = resolve(input)
  await mkdir(root, { recursive: true, mode: 0o700 })
  const actual = await realpath(root)
  const probe = join(actual, `.canvas-probe-${crypto.randomUUID()}`)
  const handle = await open(probe, 'wx', 0o600); await handle.close(); await rm(probe)
  return actual
}
export async function fileHash(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk)
  return hash.digest('hex')
}
export async function receive(source: Readable, path: string, limit: number, expected: MediaKind, signal?: AbortSignal) {
  let bytes = 0; let prefix = Buffer.alloc(0)
  const digest = createHash('sha256')
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length
      if (bytes > limit) { callback(new CanvasError('媒体文件超过大小限制', 413, 'MEDIA_TOO_LARGE')); return }
      if (prefix.length < 512) prefix = Buffer.concat([prefix, chunk.subarray(0, 512 - prefix.length)])
      digest.update(chunk); callback(null, chunk)
    },
  })
  try {
    await pipeline(source, meter, createWriteStream(path, { flags: 'wx', mode: 0o600 }), { signal })
    const detected = detectMedia(prefix)
    if (!detected || detected.kind !== expected) throw new CanvasError('不支持的文件格式，或文件类型与节点不一致', 415, 'UNSUPPORTED_MEDIA')
    const handle = await open(path, 'r+'); await handle.sync(); await handle.close()
    return { bytes, mime: detected.mime, fileHash: digest.digest('hex'), ...(detected.mime === 'image/png' && prefix.length >= 24 ? { width: prefix.readUInt32BE(16), height: prefix.readUInt32BE(20) } : {}) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') await rm(path, { force: true })
    throw error
  }
}
/** The durable manifest owns destination allocation. Hard-link publication never overwrites. */
export async function copyVerified(source: string, destination: string, expectedHash: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  if (basename(destination) !== destination.split('/').at(-1) || !extname(destination)) throw new CanvasError('无效媒体目标')
  if (await stat(destination).then(() => true).catch(() => false)) {
    if (await fileHash(destination, signal) !== expectedHash) throw new CanvasError('目标文件已存在且内容不同', 409, 'FILE_COLLISION')
    return
  }
  const temporary = `${destination}.copy-${crypto.randomUUID()}`
  try {
    await pipeline(createReadStream(source), createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), { signal })
    if (await fileHash(temporary, signal) !== expectedHash) throw new CanvasError('文件复制校验失败', 409, 'FILE_HASH_MISMATCH')
    const handle = await open(temporary, 'r+'); await handle.sync(); await handle.close()
    await link(temporary, destination)
    const directory = await open(resolve(destination, '..'), 'r')
    try { await directory.sync() } finally { await directory.close() }
  } finally { await rm(temporary, { force: true }) }
}
