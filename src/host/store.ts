import type { MediaKind } from '../shared/contracts'
export { SqliteStore as Store } from './sqlite-store'

export class CanvasError extends Error {
  constructor(message: string, public status = 400, public code = 'INVALID_REQUEST') { super(message) }
}
export interface Output {
  id: string
  mime: string
  filename: string
  url?: string
  base64?: string
  stageFile?: string
  authenticated?: boolean
}
export interface TaskPrivate { key: string; issued: boolean; outputs?: Output[] }
export function detectMedia(bytes: Buffer): { kind: MediaKind; mime: string } | undefined {
  const text = bytes.toString('latin1')
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { kind: 'image', mime: 'image/png' }
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return { kind: 'image', mime: 'image/jpeg' }
  if (text.startsWith('GIF87a') || text.startsWith('GIF89a')) return { kind: 'image', mime: 'image/gif' }
  if (text.startsWith('RIFF') && text.slice(8, 12) === 'WEBP') return { kind: 'image', mime: 'image/webp' }
  if (text.slice(4, 8) === 'ftyp') {
    if (text.slice(8, 12) === 'M4A ') return { kind: 'audio', mime: 'audio/mp4' }
    if (['heic', 'heix', 'avif', 'avis', 'mif1'].includes(text.slice(8, 12))) return undefined
    return { kind: 'video', mime: text.slice(8, 12) === 'qt  ' ? 'video/quicktime' : 'video/mp4' }
  }
  if (bytes.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]))) return { kind: 'video', mime: 'video/webm' }
  if (text.startsWith('RIFF') && text.slice(8, 12) === 'WAVE') return { kind: 'audio', mime: 'audio/wav' }
  if (text.startsWith('OggS')) return { kind: 'audio', mime: 'audio/ogg' }
  if (text.startsWith('fLaC')) return { kind: 'audio', mime: 'audio/flac' }
  if (text.startsWith('ID3') || (bytes[0] === 255 && ((bytes[1] ?? 0) & 224) === 224)) return { kind: 'audio', mime: 'audio/mpeg' }
  return undefined
}
