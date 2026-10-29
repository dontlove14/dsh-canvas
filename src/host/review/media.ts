import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Readable } from 'node:stream'
import sharp from 'sharp'
import type { Asset } from '../../shared/contracts'
import { CanvasError } from '../store'
import { receive } from '../media/files'
import { probe } from '../media/seedanceReferences'

export function validateReviewFile(asset: Asset): number {
  const limit = { image: 30, video: 200, audio: 15 }[asset.kind] * 1024 * 1024
  const types = { image: ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/tiff', 'image/heif', 'image/heic'],
    video: ['video/mp4', 'video/quicktime'], audio: ['audio/wav', 'audio/mpeg'] }
  if (!types[asset.kind].includes(asset.mime)) throw new CanvasError('此素材格式不符合预审要求', 415, 'REVIEW_FORMAT')
  if (asset.bytes > limit || asset.kind === 'image' && asset.bytes >= limit)
    throw new CanvasError('素材超过预审文件大小限制', 413, 'REVIEW_SIZE')
  return limit
}
/** Pre-review has a separate file contract from Seedance model reference validation. */
export async function inspectReviewMedia(source: Readable, asset: Asset, sha256: string, signal: AbortSignal): Promise<void> {
  const limit = validateReviewFile(asset)
  const directory = await mkdtemp(join(tmpdir(), 'dsh-canvas-review-media-'))
  try {
    const path = join(directory, 'original.raw')
    const actual = await receive(source, path, limit, asset.kind, signal)
    if (actual.fileHash !== sha256 || actual.bytes !== asset.bytes || actual.mime !== asset.mime)
      throw new CanvasError('送审原文件身份已改变', 409, 'MEDIA_CHANGED')
    if (asset.kind === 'image') {
      const { width = 0, height = 0 } = await sharp(path, { limitInputPixels: 36_000_000 }).metadata()
      if (width <= 300 || width >= 6000 || height <= 300 || height >= 6000 || width / height <= .4 || width / height >= 2.5)
        throw new CanvasError('预审图片宽高须大于300且小于6000像素，宽高比须在0.4至2.5之间', 422, 'REVIEW_DIMENSIONS')
      return
    }
    const text = await probe(path, signal)
    const duration = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text)
    const seconds = duration ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) : 0
    if (seconds < 2 || seconds > 30) throw new CanvasError('预审音视频时长须在2至30秒之间', 422, 'REVIEW_DURATION')
    if (asset.kind === 'audio') {
      if (!/Audio:/.test(text)) throw new CanvasError('预审音频无法读取', 422, 'REVIEW_FORMAT')
      return
    }
    const line = text.split('\n').find((line) => /Stream .*Video:/.test(line)) ?? ''
    const dimensions = /(?:,\s*|\s)(\d{3,5})x(\d{3,5})(?=[\s,\[])/.exec(line)
    const fps = Number(/([\d.]+)\s*fps/.exec(line)?.[1])
    if (!dimensions || !Number.isFinite(fps) || fps < 24 || fps > 60
      || Math.min(Number(dimensions[1]), Number(dimensions[2])) < 480
      || Math.max(Number(dimensions[1]), Number(dimensions[2])) > 4096)
      throw new CanvasError('预审视频需为480p至4K、24至60 FPS', 422, 'REVIEW_DIMENSIONS')
  } finally { source.destroy(); await rm(directory, { recursive: true, force: true }) }
}
