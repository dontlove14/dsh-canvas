import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import ffmpeg from '@ffmpeg-installer/ffmpeg'
import sharp from 'sharp'
import type { Asset } from '../../shared/contracts'
import { seedanceReferenceLimit } from '../../shared/seedance'
import { CanvasError } from '../store'
import { receive } from './files'

/** Private metadata derived from the exact pinned bytes, never written back to the graph. */
export interface SeedanceReference extends Asset { frameRate?: number; videoCodec?: string; audioCodec?: string }
export async function probe(path: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg.path, ['-nostdin', '-hide_banner', '-protocol_whitelist', 'file,pipe', '-threads', '1', '-i', path],
      { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    let text = '', failure: Error | undefined
    const stop = (error: Error) => { failure ??= error; child.kill('SIGKILL') }
    const abort = () => stop(new CanvasError('参考素材校验已停止', 503))
    signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => stop(new CanvasError('参考素材信息读取超时', 422)), 10000)
    if (signal.aborted) abort()
    child.stderr.on('data', (chunk: Buffer) => {
      if (text.length + chunk.length > 65536) stop(new CanvasError('参考素材信息过大', 422))
      else text += chunk.toString('utf8')
    })
    child.on('error', () => { failure = new CanvasError('参考素材解码器不可用', 422) })
    child.on('close', () => {
      clearTimeout(timer); signal.removeEventListener('abort', abort)
      if (failure) reject(failure)
      else resolve(text)
    })
  })
}
export async function inspectSeedanceReference(source: Readable, asset: Asset, sha256: string, signal: AbortSignal): Promise<SeedanceReference> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-canvas-reference-'))
  const path = join(directory, 'reference.raw')
  try {
    const actual = await receive(source, path, seedanceReferenceLimit(asset.kind), asset.kind, signal)
    if (actual.fileHash !== sha256 || actual.bytes !== asset.bytes || actual.mime !== asset.mime)
      throw new CanvasError('任务参考素材身份已改变', 409, 'MEDIA_CHANGED')
    if (asset.kind === 'image') {
      const { width, height } = await sharp(path, { limitInputPixels: 36_000_000, animated: false }).metadata()
      if (!width || !height) throw new CanvasError('参考图片无法读取', 422)
      return { ...asset, width, height }
    }
    const text = await probe(path, signal)
    const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text)
    if (!match) throw new CanvasError('参考音视频无法读取时长', 422)
    const duration = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
    const audio = /Audio:\s*(\w+)/.exec(text)
    if (asset.kind === 'audio') {
      if (!audio) throw new CanvasError('参考音频缺少音轨', 422)
      return { ...asset, duration }
    }
    const video = text.split('\n').find((line) => /Stream .*Video:/.test(line)) ?? ''
    const codec = /Video:\s*(\w+)/.exec(video)?.[1], dimensions = /(?:,\s*|\s)(\d{3,5})x(\d{3,5})(?=[\s,\[])/.exec(video)
    const frameRate = Number(/([\d.]+)\s*fps/.exec(video)?.[1])
    if (!codec || !dimensions || !Number.isFinite(frameRate) || frameRate < 24 || frameRate > 60
      || !['h264', 'hevc'].includes(codec) || audio && !['aac', 'mp3'].includes(audio[1]))
      throw new CanvasError('参考视频需使用 H.264/H.265 编码、24至60 FPS，音轨需为 AAC/MP3', 422)
    return { ...asset, duration, width: Number(dimensions[1]), height: Number(dimensions[2]), frameRate, videoCodec: codec,
      ...(audio ? { audioCodec: audio[1] } : {}) }
  } finally { source.destroy(); await rm(directory, { recursive: true, force: true }) }
}
