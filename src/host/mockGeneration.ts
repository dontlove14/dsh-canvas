import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { lstat, open, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import sharp from 'sharp'
import ffmpeg from '@ffmpeg-installer/ffmpeg'
import { isTtsSnapshot, type Task } from '../shared/contracts'
import type { Output, Store } from './store'

export function mockOutputId(taskId: string, index: number): string {
  const hex = createHash('sha256').update(`mock:${taskId}:${index}`).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}
/** Synthetic domain results, rendered locally without a model request or user credentials. */
export async function renderMock(task: Task, store: Store, signal: AbortSignal, progress: (value: number) => Promise<void>): Promise<Output[]> {
  if (isTtsSnapshot(task.snapshot)) throw new Error('语音生成不使用 Mock')
  const outputs: Output[] = []
  const directory = join(await realpath(store.root), 'staging')
  if (await realpath(directory) !== directory) throw new Error('Mock 暂存目录不可用')
  const stagePath = (name: string) => join(directory, basename(store.stagePath(name)))
  const [width, height] = task.snapshot.params.size.split('x').map(Number)
  const palettes = [
    ['#76b7d9', '#e8d3cb', '#47796d', '#20454c'],
    ['#a6a2cf', '#f4d4a3', '#7d809d', '#41475e'],
    ['#75b6b3', '#fde3ae', '#819c6b', '#27564e'],
    ['#d4aeb1', '#fcdfc4', '#9b8a9c', '#51485f'],
  ]
  const seed = parseInt(createHash('sha256').update(task.snapshot.prompt).digest('hex').slice(0, 6), 16)
  for (let index = 0; index < task.snapshot.params.n; index++) {
    signal.throwIfAborted()
    const id = mockOutputId(task.id, index)
    const video = task.snapshot.model.kind === 'video'
    const stageFile = `${id}.raw`
    const path = stagePath(stageFile)
    const existing = await lstat(path).catch((error) => { if (error.code !== 'ENOENT') throw error; return null })
    if (existing && (!existing.isFile() || await realpath(path) !== path)) throw new Error('Mock 暂存路径不可用')
    if (!existing) {
      const [sky, sun, hills, ground] = palettes[(seed + index) % palettes.length]
      const x = 200 + (seed + index * 173) % 600
      // Fixed numeric/template inputs only; never interpolate a prompt into SVG.
      const scene = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 800" width="${width}" height="${height}" preserveAspectRatio="xMidYMid slice">
        <defs><linearGradient id="sky" x2="0" y2="1"><stop stop-color="${sky}"/><stop offset="1" stop-color="${sun}"/></linearGradient><linearGradient id="land" x2="0" y2="1"><stop stop-color="${hills}"/><stop offset="1" stop-color="${ground}"/></linearGradient></defs>
        <path fill="url(#sky)" d="M0 0h1200v800H0z"/><circle cx="${x}" cy="270" r="96" fill="${sun}" opacity=".95"/>
        <path d="M-80 560 210 250 420 495 720 230 1250 600v200H-80z" fill="${hills}" opacity=".55"/>
        <path d="M0 540Q300 390 560 590T1200 520V800H0z" fill="url(#land)"/>
        <path d="M0 670Q330 480 640 700T1200 610V800H0z" fill="${ground}"/>
        <path d="M510 800Q810 650 720 600Q620 550 680 520" stroke="${sun}" stroke-width="10" fill="none" opacity=".65"/>
        <text x="36" y="754" fill="#fff" opacity=".65" font-family="sans-serif" font-size="20">MOCK · ${index + 1}</text></svg>`)
      const png = await sharp(scene, { limitInputPixels: 20_000_000 }).png().toBuffer()
      signal.throwIfAborted()
      const temporary = stagePath(`${id}-${randomUUID()}.media`)
      const input = stagePath(`${id}-${randomUUID()}.raw`)
      try {
        if (video) {
          await writeFile(input, png, { flag: 'wx', mode: 0o600 })
          await renderVideo(input, temporary, width, height, task.snapshot.params.seconds!, signal)
        } else await writeFile(temporary, png, { flag: 'wx', mode: 0o600 })
        signal.throwIfAborted()
        const file = await open(temporary, 'r')
        try { await file.chmod(0o600); await file.sync() } finally { await file.close() }
        await rename(temporary, path)
        const directory = await open(dirname(path), 'r')
        try { await directory.sync() } finally { await directory.close() }
      } finally { await rm(temporary, { force: true }); await rm(input, { force: true }) }
    }
    outputs.push({ id, mime: video ? 'video/mp4' : 'image/png', filename: `mock-${index + 1}.${video ? 'mp4' : 'png'}`, stageFile })
    await progress(10 + Math.round((index + 1) / task.snapshot.params.n * 75))
  }
  return outputs
}
function renderVideo(input: string, output: string, width: number, height: number, seconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg.path, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file,pipe',
      '-loop', '1', '-i', input, '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', String(seconds),
      '-filter_threads', '1', '-vf', `zoompan=z='1+0.025*sin(on/24)':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s=${width}x${height}:fps=24`,
      '-threads', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '26', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
      '-shortest', '-movflags', '+faststart', '-f', 'mp4', '-y', output], { stdio: 'ignore' })
    let failure: Error | undefined
    const abort = () => { failure = new Error('Mock 生成已停止'); child.kill('SIGKILL') }
    signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => { failure = new Error('Mock 视频处理超时'); child.kill('SIGKILL') }, 60000)
    child.on('error', (error) => { failure = error })
    child.on('close', (code) => {
      clearTimeout(timer); signal.removeEventListener('abort', abort)
      if (failure || code !== 0) reject(failure ?? new Error('Mock 视频生成失败'))
      else resolve()
    })
  })
}
