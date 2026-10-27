import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import ffmpeg from '@ffmpeg-installer/ffmpeg'
import { WaveformSchema, WAVEFORM_BARS, WAVEFORM_VERSION, type AudioWaveform } from '../../shared/audioWaveform'
import { CanvasError } from '../store'

const SAMPLE_RATE = 22050
const MAX_FRAMES = SAMPLE_RATE * 7200
interface Energy { squares: number; frames: number }
/** Stream stereo PCM into a bounded envelope; opposite-phase channels do not cancel. */
export class WaveformAccumulator {
  private points: Energy[] = []
  private block: Energy = { squares: 0, frames: 0 }
  private blockSize = 256
  private tail = Buffer.alloc(0)
  private frames = 0
  push(chunk: Buffer): void {
    const bytes = this.tail.length ? Buffer.concat([this.tail, chunk]) : chunk
    const end = bytes.length - bytes.length % 8
    for (let i = 0; i < end; i += 8) {
      const left = bytes.readFloatLE(i), right = bytes.readFloatLE(i + 4)
      if (!Number.isFinite(left) || !Number.isFinite(right)) throw new Error('Invalid audio samples')
      if (++this.frames > MAX_FRAMES) throw new Error('Audio exceeds waveform processing limit')
      this.block.squares += (left * left + right * right) / 2
      this.block.frames++
      if (this.block.frames === this.blockSize) {
        this.points.push(this.block); this.block = { squares: 0, frames: 0 }
        if (this.points.length === 8192) {
          const merged: Energy[] = []
          for (let j = 0; j < this.points.length; j += 2) merged.push({
            squares: this.points[j].squares + this.points[j + 1].squares,
            frames: this.points[j].frames + this.points[j + 1].frames,
          })
          this.points = merged; this.blockSize *= 2
        }
      }
    }
    this.tail = Buffer.from(bytes.subarray(end))
  }
  finish(): AudioWaveform {
    if (!this.frames || this.tail.length) throw new Error('Audio contains no complete samples')
    const points = this.block.frames ? [...this.points, this.block] : this.points
    const bins: Energy[] = Array.from({ length: WAVEFORM_BARS }, () => ({ squares: 0, frames: 0 }))
    let start = 0
    for (const point of points) {
      // Split the envelope's energy by time, including partial final blocks.
      const end = start + point.frames
      for (let i = Math.floor(start / this.frames * WAVEFORM_BARS); i < WAVEFORM_BARS && i * this.frames / WAVEFORM_BARS < end; i++) {
        const count = Math.min(end, (i + 1) * this.frames / WAVEFORM_BARS) - Math.max(start, i * this.frames / WAVEFORM_BARS)
        bins[i].squares += point.squares * count / point.frames; bins[i].frames += count
      }
      start = end
    }
    const rms = bins.map((bin) => Math.sqrt(bin.frames ? bin.squares / bin.frames : 0))
    const maximum = Math.max(...rms)
    return WaveformSchema.parse({ version: 1, duration: this.frames / SAMPLE_RATE,
      peaks: rms.map((value) => maximum < 1e-6 ? 0 : Math.round(value / maximum * 1000) / 1000) })
  }
}
export async function decodeWaveform(source: string, signal: AbortSignal): Promise<AudioWaveform> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const accumulator = new WaveformAccumulator()
    const child = spawn(ffmpeg.path, [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file,pipe',
      '-threads', '1', '-i', source, '-map', '0:a:0', '-vn', '-sn', '-dn',
      '-ac', '2', '-ar', String(SAMPLE_RATE), '-threads', '1', '-f', 'f32le', '-c:a', 'pcm_f32le', 'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    let failure: Error | undefined
    const stop = (error: Error) => { failure ??= error; child.kill('SIGKILL') }
    const abort = () => stop(new CanvasError('波形处理已停止', 503, 'WAVEFORM_UNAVAILABLE'))
    const timer = setTimeout(() => stop(new CanvasError('音频波形处理超时', 422, 'WAVEFORM_UNAVAILABLE')), 20000)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    child.stdout.on('data', (chunk: Buffer) => {
      if (failure) return
      try { accumulator.push(chunk) } catch { stop(new CanvasError('音频超过波形处理限制或无法解码', 422, 'WAVEFORM_UNAVAILABLE')) }
    })
    child.on('error', () => { failure = new CanvasError('音频解码器不可用', 422, 'WAVEFORM_UNAVAILABLE') })
    child.on('close', (code) => {
      clearTimeout(timer); signal.removeEventListener('abort', abort)
      if (failure || code !== 0) { reject(failure ?? new CanvasError('音频波形无法解码', 422, 'WAVEFORM_UNAVAILABLE')); return }
      try { resolve(accumulator.finish()) }
      catch { reject(new CanvasError('音频波形无法解码', 422, 'WAVEFORM_UNAVAILABLE')) }
    })
  })
}

/** Disposable derived files. Never update audio bytes, asset metadata or tasks. */
export class WaveformCache {
  private queue: Promise<unknown> = Promise.resolve()
  private inflight = new Map<string, Promise<AudioWaveform>>()
  private failed = new Map<string, number>()
  private controller = new AbortController()
  constructor(private root: string) {}
  async get(canvas: string, id: string, source: string, fileHash: string): Promise<AudioWaveform> {
    this.controller.signal.throwIfAborted()
    const original = await lstat(source)
    if (!original.isFile() || await realpath(source) !== source) throw new CanvasError('音频路径不可用', 409, 'UNSAFE_PATH')
    const key = createHash('sha256').update(JSON.stringify([canvas, id, fileHash, WAVEFORM_VERSION, original.size, original.mtimeMs])).digest('hex')
    const root = await realpath(this.root)
    const previews = join(root, 'previews')
    await mkdir(previews, { recursive: true, mode: 0o700 })
    if (await realpath(previews) !== previews) throw new CanvasError('波形目录路径发生变更', 409, 'UNSAFE_PATH')
    const directory = join(previews, 'waveforms')
    await mkdir(directory, { mode: 0o700 }).catch((error) => { if (error.code !== 'EEXIST') throw error })
    if (await realpath(directory) !== directory) throw new CanvasError('波形目录路径发生变更', 409, 'UNSAFE_PATH')
    const path = join(directory, `${key}.json`)
    const cached = await lstat(path).catch((error) => { if (error.code !== 'ENOENT') throw error; return null })
    if (cached) {
      if (!cached.isFile() || await realpath(path) !== path) throw new CanvasError('波形路径发生变更', 409, 'UNSAFE_PATH')
      if (cached.size > 8192) throw new CanvasError('波形缓存不可用', 422, 'WAVEFORM_UNAVAILABLE')
      try { return WaveformSchema.parse(JSON.parse(await readFile(path, 'utf8'))) }
      catch { await rm(path, { force: true }) }
    }
    const pending = this.inflight.get(key)
    if (pending) return pending
    if ((this.failed.get(key) ?? 0) > Date.now()) throw new CanvasError('波形暂不可用，请稍后重试', 422, 'WAVEFORM_UNAVAILABLE')
    if (this.inflight.size >= 16) throw new CanvasError('波形队列忙，请稍后重试', 503, 'WAVEFORM_UNAVAILABLE')
    const job = this.queue.then(async () => {
      const signal = this.controller.signal
      signal.throwIfAborted()
      if (await realpath(source) !== source) throw new CanvasError('音频路径发生变更', 409, 'UNSAFE_PATH')
      const waveform = await decodeWaveform(source, signal)
      const now = await lstat(source)
      signal.throwIfAborted()
      if (await realpath(source) !== source || now.size !== original.size || now.mtimeMs !== original.mtimeMs) throw new CanvasError('音频处理期间发生变更', 409, 'MEDIA_CHANGED')
      if (await realpath(directory) !== directory) throw new CanvasError('波形目录发生变更', 409, 'UNSAFE_PATH')
      const temporary = join(directory, `.${key}-${randomUUID()}.tmp`)
      try {
        await writeFile(temporary, JSON.stringify(waveform), { flag: 'wx', mode: 0o600 })
        signal.throwIfAborted()
        await rename(temporary, path)
        return waveform
      } finally { await rm(temporary, { force: true }) }
    }).catch((error) => {
      if (this.failed.size >= 128) this.failed.delete(this.failed.keys().next().value!)
      this.failed.set(key, Date.now() + 30000)
      if (error instanceof CanvasError) throw error
      throw new CanvasError('波形暂不可用，原音频仍可播放或下载', 422, 'WAVEFORM_UNAVAILABLE')
    }).finally(() => this.inflight.delete(key))
    this.inflight.set(key, job); this.queue = job.catch(() => {})
    return job
  }
  async close(): Promise<void> { this.controller.abort(); await this.queue }
}
