import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import { CanvasError, type Output } from './store'
import { isTtsSnapshot, type AnyTaskSnapshot, type TtsTaskSnapshot } from '../shared/contracts'
import { receive } from './media/files'

export class ProviderFailure extends Error {
  constructor(message: string, readonly definitive: boolean) { super(message) }
}
export interface ProviderResult { id?: string; status: 'queued' | 'generating' | 'completed' | 'failed'; progress?: number; outputs?: Output[]; error?: string; errorCode?: string }
export interface ProviderOptions { requestTimeoutMs: number; maxMediaBytes: number; maxReferenceBytes: number }
export interface MediaReader { mediaPath(id: string): string; stagePath(name: string): string }

export function endpoint(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path}`
}
async function jsonResponse(response: Response, limit: number): Promise<Record<string, any>> {
  if (!response.body) throw new ProviderFailure('模型服务返回空响应', false)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.length
      if (bytes > limit) throw new ProviderFailure('模型服务响应超过大小限制', false)
      chunks.push(next.value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch (error) { await reader.cancel().catch(() => {}); throw error }
}

export class Providers {
  constructor(private store: MediaReader, private options: ProviderOptions, private signal: AbortSignal) {}
  private async request(url: string, key: string, init: RequestInit = {}): Promise<Record<string, any>> {
    const response = await fetch(url, {
      ...init, headers: { ...init.headers, ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      redirect: 'error',
      signal: AbortSignal.any([this.signal, AbortSignal.timeout(this.options.requestTimeoutMs)]),
    })
    if (!response.ok) {
      const body: Record<string, any> = await jsonResponse(response, 64 * 1024).catch(() => ({}))
      const message = typeof body.error?.message === 'string' ? body.error.message : `模型服务返回 HTTP ${response.status}`
      // A gateway/server failure may happen after the provider accepted the request.
      throw new ProviderFailure(message, response.status >= 400 && response.status < 500 && ![408, 409, 429].includes(response.status))
    }
    return jsonResponse(response, Math.ceil(this.options.maxMediaBytes * 1.4) + 1024 * 1024)
  }
  async submit(snapshot: AnyTaskSnapshot, key: string): Promise<ProviderResult> {
    if (isTtsSnapshot(snapshot)) return this.submitTts(snapshot, key)
    const { model, params, prompt, referenceIds } = snapshot
    if (model.protocol === 'openai-video') {
      const payload: Record<string, unknown> = { model: model.model_id, prompt, size: params.size, seconds: String(params.seconds) }
      if (referenceIds.length) {
        const bytes = await readFile(this.store.mediaPath(referenceIds[0]))
        if (bytes.length > this.options.maxReferenceBytes) throw new ProviderFailure('参考图超过大小限制', true)
        const { detectMedia } = await import('./store')
        const mime = detectMedia(bytes)?.mime
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime ?? '')) throw new ProviderFailure('视频参考图仅支持 PNG、JPEG 和 WebP', true)
        payload.input_reference = { image_url: `data:${mime};base64,${bytes.toString('base64')}` }
      }
      const body = await this.request(endpoint(model.api_base, 'videos'), key, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      })
      return this.videoResult(body, model.api_base)
    }
    let init: RequestInit
    let path = 'images/generations'
    if (referenceIds.length) {
      path = 'images/edits'
      const form = new FormData()
      form.set('model', model.model_id); form.set('prompt', prompt); form.set('size', params.size); form.set('n', String(params.n))
      let total = 0
      for (const id of referenceIds) {
        const bytes = await readFile(this.store.mediaPath(id))
        total += bytes.length
        if (total > this.options.maxReferenceBytes) throw new ProviderFailure('参考图片总大小超过限制', true)
        const { detectMedia } = await import('./store')
        const mime = detectMedia(bytes)?.mime ?? ''
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime)) throw new ProviderFailure('图生图参考素材仅支持 PNG、JPEG 和 WebP', true)
        form.append('image[]', new Blob([new Uint8Array(bytes)], { type: mime }), `${id}.${mime.split('/')[1]}`)
      }
      init = { method: 'POST', body: form }
    } else {
      const payload = { model: model.model_id, prompt, size: params.size, n: params.n, ...(model.protocol !== 'openai-image' ? { response_format: 'b64_json' } : {}) }
      init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
    }
    const body = await this.request(endpoint(model.api_base, path), key, init)
    if (!Array.isArray(body.data) || body.data.length !== params.n) throw new ProviderFailure('模型返回的图片数量不符合请求，提交结果需要确认', false)
    const outputs: Output[] = body.data.map((item: any) => {
      if (typeof item.b64_json === 'string' && /^[A-Za-z0-9+/=\r\n]+$/.test(item.b64_json))
        return { id: randomUUID(), mime: 'image/png', filename: 'generated-image.png', base64: item.b64_json }
      if (typeof item.url === 'string') {
        const url = new URL(item.url)
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new ProviderFailure('模型返回无效的图片地址', false)
        return { id: randomUUID(), mime: 'image/png', filename: 'generated-image.png', url: url.href, authenticated: false }
      }
      throw new ProviderFailure('模型返回了无法识别的图片结果', false)
    })
    return { status: 'completed', outputs }
  }
  private async submitTts(snapshot: TtsTaskSnapshot, key: string): Promise<ProviderResult> {
    const signal = AbortSignal.any([this.signal, AbortSignal.timeout(this.options.requestTimeoutMs)])
    const { reference_id, speed, volume } = snapshot.params
    const response = await fetch(snapshot.model.api_base, {
      method: 'POST', redirect: 'error', signal,
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ text: snapshot.prompt, ...(reference_id ? { reference_id } : {}), prosody: { speed, volume }, format: 'mp3' }),
    })
    if (!response.ok) {
      const body: Record<string, any> = await jsonResponse(response, 64 * 1024).catch(() => ({}))
      throw new ProviderFailure(typeof body.message === 'string' ? body.message : typeof body.error?.message === 'string' ? body.error.message : `FishTTS 返回 HTTP ${response.status}`, response.status >= 400 && response.status < 500 && ![408, 409, 429].includes(response.status))
    }
    if (!response.body) throw new ProviderFailure('FishTTS 返回空音频', false)
    const id = randomUUID(); const stageFile = `${id}.raw`
    const media = await receive(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), this.store.stagePath(stageFile), this.options.maxMediaBytes, 'audio', signal)
    return { status: 'completed', outputs: [{ id, stageFile, mime: media.mime, filename: 'fish-tts.mp3' }] }
  }
  async poll(snapshot: AnyTaskSnapshot, key: string, id: string): Promise<ProviderResult> {
    if (isTtsSnapshot(snapshot)) throw new ProviderFailure('FishTTS 没有可恢复查询的外部任务 ID', true)
    const body = await this.request(endpoint(snapshot.model.api_base, `videos/${encodeURIComponent(id)}`), key)
    return this.videoResult(body, snapshot.model.api_base, id)
  }
  private videoResult(body: Record<string, any>, base: string, expectedId?: string): ProviderResult {
    if (typeof body.id !== 'string' || !body.id || body.id.length > 512 || (expectedId && body.id !== expectedId))
      throw new ProviderFailure('视频服务没有返回有效的任务 ID', false)
    if (!['queued', 'in_progress', 'completed', 'failed'].includes(body.status)) throw new ProviderFailure('视频服务返回了未知任务状态', false)
    const status = body.status === 'in_progress' ? 'generating' : body.status
    return {
      id: body.id, status, progress: typeof body.progress === 'number' && Number.isFinite(body.progress) ? Math.min(100, Math.max(0, body.progress)) : undefined,
      ...(status === 'failed' ? { error: typeof body.error?.message === 'string' ? body.error.message : '视频生成失败', errorCode: typeof body.error?.code === 'string' ? body.error.code.slice(0, 160) : 'EXTERNAL_FAILED' } : {}),
      ...(status === 'completed' ? { outputs: [{ id: randomUUID(), mime: 'video/mp4', filename: 'generated-video.mp4', url: endpoint(base, `videos/${encodeURIComponent(body.id)}/content`), authenticated: true }] } : {}),
    }
  }
  async outputStream(output: Output, snapshot: AnyTaskSnapshot, key: string): Promise<Readable> {
    if (output.stageFile) return createReadStream(this.store.stagePath(output.stageFile))
    if (output.base64) return Readable.from([Buffer.from(output.base64, 'base64')])
    if (!output.url) throw new CanvasError('生成结果不可用')
    const url = new URL(output.url)
    const provider = new URL(snapshot.model.api_base)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new CanvasError('结果地址无效')
    if (output.authenticated && url.origin !== provider.origin) throw new CanvasError('结果地址与模型服务不一致')
    const response = await fetch(url, {
      headers: output.authenticated && key ? { Authorization: `Bearer ${key}` } : {},
      redirect: output.authenticated ? 'error' : 'follow',
      signal: AbortSignal.any([this.signal, AbortSignal.timeout(this.options.requestTimeoutMs)]),
    })
    if (!response.ok || !response.body) throw new CanvasError(`结果下载失败（HTTP ${response.status}）`, 502)
    return Readable.fromWeb(response.body as import('node:stream/web').ReadableStream)
  }
}
