import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { lstat, mkdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import ffmpeg from '@ffmpeg-installer/ffmpeg'
import { CanvasError } from '../store'

export const PREVIEW_VERSION = '1'
const MAX_SIDE = 960

/** Decode only the first displayed frame; never seek or choose a later thumbnail. */
export function videoFirstFrame(source: string, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg.path, [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file,pipe',
      '-threads', '1', '-i', source, '-map', '0:v:0', '-frames:v', '1', '-an',
      '-filter_threads', '1', '-vf', `scale=w='min(${MAX_SIDE},iw)':h='min(${MAX_SIDE},ih)':force_original_aspect_ratio=decrease,setsar=1`,
      '-threads', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    const chunks: Buffer[] = []
    let size = 0; let failure: Error | undefined
    const stop = (error: Error) => { failure = error; child.kill('SIGKILL') }
    const abort = () => stop(new CanvasError('封面处理已停止', 503, 'PREVIEW_UNAVAILABLE'))
    const timer = setTimeout(() => stop(new CanvasError('视频封面处理超时', 422, 'PREVIEW_UNAVAILABLE')), 15000)
    signal.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 8 * 1024 * 1024) stop(new CanvasError('视频封面超过处理限制', 422, 'PREVIEW_UNAVAILABLE'))
      else chunks.push(chunk)
    })
    child.on('error', (error) => { failure = error })
    child.on('close', (code) => {
      clearTimeout(timer); signal.removeEventListener('abort', abort)
      if (failure || code !== 0 || !size) reject(failure ?? new CanvasError('视频首帧无法解码', 422, 'PREVIEW_UNAVAILABLE'))
      else resolve(Buffer.concat(chunks))
    })
  })
}

/** Derived cache only. Asset records, original bytes and paid task state are untouched. */
export class PreviewCache {
  private queue: Promise<unknown> = Promise.resolve()
  private inflight = new Map<string, Promise<string>>()
  private failed = new Map<string, number>()
  private controller = new AbortController()
  constructor(private root: string) {}

  async get(canvas: string, id: string, source: string, fileHash: string, kind: 'image' | 'video'): Promise<string> {
    this.controller.signal.throwIfAborted()
    const sourceStat = await lstat(source)
    if (!sourceStat.isFile() || await realpath(source) !== source) throw new CanvasError('媒体路径不可用', 409, 'UNSAFE_PATH')
    const key = createHash('sha256').update(JSON.stringify([canvas, id, fileHash, PREVIEW_VERSION, sourceStat.size, sourceStat.mtimeMs])).digest('hex')
    const directory = join(await realpath(this.root), 'previews')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    if (await realpath(directory) !== directory) throw new CanvasError('封面目录路径发生变更', 409, 'UNSAFE_PATH')
    const destination = join(directory, `${key}.webp`)
    const cached = await lstat(destination).catch((e) => { if (e.code !== 'ENOENT') throw e; return null })
    if (cached) {
      if (!cached.isFile() || await realpath(destination) !== destination) throw new CanvasError('封面路径发生变更', 409, 'UNSAFE_PATH')
      return destination
    }
    const pending = this.inflight.get(key)
    if (pending) return pending
    if ((this.failed.get(key) ?? 0) > Date.now()) throw new CanvasError('封面暂不可用，请稍后再试', 422, 'PREVIEW_UNAVAILABLE')
    if (this.inflight.size >= 64) throw new CanvasError('封面队列忙，请稍后再试', 503, 'PREVIEW_UNAVAILABLE')
    const job = this.queue.then(async () => {
      const signal = this.controller.signal
      signal.throwIfAborted()
      if (await realpath(source) !== source) throw new CanvasError('媒体路径发生变更', 409, 'UNSAFE_PATH')
      const input = kind === 'video' ? await videoFirstFrame(source, signal) : source
      const image = sharp(input, { limitInputPixels: 100_000_000, sequentialRead: true, animated: false })
        .rotate().resize(MAX_SIDE, MAX_SIDE, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 76, effort: 3 }).timeout({ seconds: 12 })
      // Sharp's buffer API does not install a stream error listener. Destroying
      // with an Error would crash the host; stop the stream and await the bounded
      // native operation, then check the signal before publishing any bytes.
      const abort = () => image.destroy()
      signal.addEventListener('abort', abort, { once: true })
      const temporary = join(directory, `.${key}-${randomUUID()}.tmp`)
      try {
        const output = await image.toBuffer()
        signal.throwIfAborted()
        const now = await lstat(source)
        if (await realpath(source) !== source || now.size !== sourceStat.size || now.mtimeMs !== sourceStat.mtimeMs) throw new CanvasError('媒体处理期间发生变更', 409, 'MEDIA_CHANGED')
        if (await realpath(directory) !== directory) throw new CanvasError('封面目录发生变更', 409, 'UNSAFE_PATH')
        await writeFile(temporary, output, { flag: 'wx', mode: 0o600 })
        signal.throwIfAborted()
        await rename(temporary, destination)
        return destination
      } finally {
        signal.removeEventListener('abort', abort)
        await rm(temporary, { force: true })
      }
    }).catch((error) => {
      if (this.failed.size >= 128) this.failed.delete(this.failed.keys().next().value!)
      this.failed.set(key, Date.now() + 30000)
      if (error instanceof CanvasError) throw error
      throw new CanvasError('封面无法解码，原文件仍可下载或放大查看', 422, 'PREVIEW_UNAVAILABLE')
    }).finally(() => this.inflight.delete(key))
    this.inflight.set(key, job)
    this.queue = job.catch(() => {})
    return job
  }
  async close(): Promise<void> { this.controller.abort(); await this.queue }
}
