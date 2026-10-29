import { constants } from 'node:fs'
import { open, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { CanvasError, detectMedia } from '../store'
import { HashSchema } from '../../shared/v2'
import { UPLOAD_CHUNK_BYTES } from '../../shared/uploads'

const JournalSchema = z.object({
  version: z.literal(1), canvas: z.string(), id: z.string().uuid(),
  filename: z.string().min(1).max(255), kind: z.enum(['image', 'video', 'audio']),
  size: z.number().int().positive().max(1024 * 1024 * 1024),
  chunkBytes: z.number().int().positive().max(UPLOAD_CHUNK_BYTES),
  offset: z.number().int().nonnegative(), hashes: z.array(HashSchema),
}).strict().refine((j) => j.offset <= j.size && (j.offset === j.size || j.offset % j.chunkBytes === 0)
  && j.hashes.length === Math.ceil(j.offset / j.chunkBytes))
export type UploadJournal = z.infer<typeof JournalSchema>
const corrupt = () => new CanvasError('上传暂存数据损坏，请重新上传', 409, 'UPLOAD_CORRUPT')

export async function readJournal(path: string): Promise<UploadJournal | null> {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    if (!(await handle.stat()).isFile()) throw corrupt()
    return JournalSchema.parse(JSON.parse(await handle.readFile('utf8')))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw corrupt()
    if (error instanceof z.ZodError || error instanceof SyntaxError) throw corrupt()
    throw error
  } finally { await handle?.close() }
}
/** File bytes are synced before this atomic, durable commit of the acknowledged offset. */
export async function writeJournal(path: string, journal: UploadJournal): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try { await handle.writeFile(JSON.stringify(journal)); await handle.sync() } finally { await handle.close() }
    await rename(temporary, path)
    const directory = await open(dirname(path), 'r')
    try { await directory.sync() } finally { await directory.close() }
  } finally { await rm(temporary, { force: true }) }
}
export async function openStage(path: string, journal: UploadJournal) {
  let handle
  try { handle = await open(path, constants.O_RDWR | constants.O_NOFOLLOW) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw corrupt()
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    if (journal.offset) throw corrupt()
    handle = await open(path, 'wx+', 0o600)
  }
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size < journal.offset) throw corrupt()
    if (info.size > journal.offset) { await handle.truncate(journal.offset); await handle.sync() }
    return handle
  } catch (error) { await handle.close(); throw error }
}
/** Re-check recorded checksums after a restart and before accepting the whole file. */
export async function verifyStage(path: string, journal: UploadJournal, signal?: AbortSignal) {
  const handle = await openStage(path, journal)
  const whole = createHash('sha256'), buffer = Buffer.alloc(Math.min(journal.chunkBytes, journal.offset))
  let prefix = Buffer.alloc(0)
  try {
    for (let offset = 0, index = 0; offset < journal.offset; index++) {
      signal?.throwIfAborted()
      const length = Math.min(journal.chunkBytes, journal.offset - offset)
      let read = 0
      while (read < length) {
        const result = await handle.read(buffer, read, length - read, offset + read)
        if (!result.bytesRead) throw corrupt()
        read += result.bytesRead
      }
      const bytes = buffer.subarray(0, length)
      if (createHash('sha256').update(bytes).digest('hex') !== journal.hashes[index]) throw corrupt()
      if (prefix.length < 512) prefix = Buffer.concat([prefix, bytes.subarray(0, 512 - prefix.length)])
      whole.update(bytes); offset += length
    }
    const detected = detectMedia(prefix)
    return { bytes: journal.offset, fileHash: whole.digest('hex'), detected,
      ...(detected?.mime === 'image/png' && prefix.length >= 24 ? { width: prefix.readUInt32BE(16), height: prefix.readUInt32BE(20) } : {}) }
  } finally { await handle.close() }
}
