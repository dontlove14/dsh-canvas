import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import { CanvasError, detectMedia, type Output } from './store'
import { FISH_TTS_MODEL, isTtsSnapshot, type AnyTaskSnapshot, type TtsTaskSnapshot, type TaskSnapshot } from '../shared/contracts'
import { isGptImage25, builtinDefinition, bananaSizePresets, providerFor } from '../shared/modelCatalog'
import { receive } from './media/files'

export class ProviderFailure extends Error {
  constructor(message: string, readonly definitive: boolean) { super(message) }
}
export interface ProviderResult { id?: string; status: 'queued' | 'generating' | 'completed' | 'failed'; progress?: number; outputs?: Output[]; error?: string; errorCode?: string }
export interface ProviderOptions { requestTimeoutMs: number; maxMediaBytes: number; maxReferenceBytes: number }
export interface MediaReader { readMedia(id: string, limit: number, taskId?: string): Promise<Buffer>; stagePath(name: string): string }

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
  private async request(url: string, key: string, init: RequestInit = {}, auth: 'bearer' | 'google' = 'bearer'): Promise<Record<string, any>> {
    const response = await fetch(url, {
      ...init, headers: { ...init.headers, ...(key ? auth === 'google' ? { 'x-goog-api-key': key } : { Authorization: `Bearer ${key}` } : {}) },
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
  async prepare(snapshot: AnyTaskSnapshot, taskId?: string): Promise<Map<string, Buffer>> {
    const references = new Map<string, Buffer>(); let total = 0
    for (const id of snapshot.referenceIds) {
      const bytes = await this.store.readMedia(id, this.options.maxReferenceBytes - total, taskId)
      total += bytes.length
      const { detectMedia } = await import('./store')
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(detectMedia(bytes)?.mime ?? ''))
        throw new ProviderFailure('参考素材仅支持 PNG、JPEG 和 WebP', true)
      references.set(id, bytes)
    }
    return references
  }
  async submit(snapshot: AnyTaskSnapshot, key: string, prepared?: Map<string, Buffer>): Promise<ProviderResult> {
    if (isTtsSnapshot(snapshot)) return this.submitTts(snapshot, key)
    const references = prepared ?? await this.prepare(snapshot)
    const { model, params, prompt, referenceIds } = snapshot
    if (model.protocol === 'gemini-image') return this.submitBanana(snapshot, key, references)
    if (model.protocol === 'openai-video') {
      const payload: Record<string, unknown> = { model: model.model_id, prompt, size: params.size, seconds: String(params.seconds) }
      if (referenceIds.length) {
        const bytes = references.get(referenceIds[0])!
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
    const imageOptions = isGptImage25(model) ? { output_format: 'png', background: params.background ?? 'auto', quality: params.quality ?? 'auto' } : {}
    if (referenceIds.length) {
      path = 'images/edits'
      const form = new FormData()
      form.set('model', model.model_id); form.set('prompt', prompt); form.set('size', params.size); form.set('n', String(params.n))
      for (const [key, value] of Object.entries(imageOptions)) form.set(key, value)
      let total = 0
      for (const id of referenceIds) {
        const bytes = references.get(id)!
        total += bytes.length
        if (total > this.options.maxReferenceBytes) throw new ProviderFailure('参考图片总大小超过限制', true)
        const { detectMedia } = await import('./store')
        const mime = detectMedia(bytes)?.mime ?? ''
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime)) throw new ProviderFailure('图生图参考素材仅支持 PNG、JPEG 和 WebP', true)
        form.append('image[]', new Blob([new Uint8Array(bytes)], { type: mime }), `${id}.${mime.split('/')[1]}`)
      }
      init = { method: 'POST', body: form }
    } else {
      const payload = { model: model.model_id, prompt, size: params.size, n: params.n, ...imageOptions, ...(model.protocol !== 'openai-image' ? { response_format: 'b64_json' } : {}) }
      init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
    }
    const body = await this.request(endpoint(model.api_base, path), key, init)
    if (!Array.isArray(body.data) || !body.data.length || body.data.length > 10) throw new ProviderFailure('模型没有返回有效的图片结果，提交结果需要确认', false)
    const outputs: Output[] = []
    for (const item of body.data) {
      if (typeof item?.b64_json === 'string' && /^[A-Za-z0-9+/=\r\n]+$/.test(item.b64_json)) {
        const bytes = Buffer.from(item.b64_json, 'base64')
        const { detectMedia } = await import('./store')
        if (bytes.length <= this.options.maxMediaBytes && detectMedia(bytes)?.kind === 'image')
          outputs.push({ id: randomUUID(), mime: 'image/png', filename: 'generated-image.png', base64: item.b64_json })
      } else if (typeof item?.url === 'string') {
        try {
          const url = new URL(item.url)
          if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password)
            outputs.push({ id: randomUUID(), mime: 'image/png', filename: 'generated-image.png', url: url.href, authenticated: false })
        } catch {}
      }
    }
    if (!outputs.length) throw new ProviderFailure('模型返回了无法识别的图片结果，提交结果需要确认', false)
    return { status: 'completed', outputs, ...(outputs.length !== params.n ? { error: `部分失败：请求 ${params.n} 张，收到 ${outputs.length} 张有效图片` } : {}) }
  }
  private async submitBanana(snapshot: TaskSnapshot, key: string, references: Map<string, Buffer>): Promise<ProviderResult> {
    const { model, prompt, params, referenceIds } = snapshot
    const preset = bananaSizePresets(model.model_id).find((item) => item.size === params.size)
    if (!builtinDefinition(model) || !preset || params.n !== 1)
      throw new ProviderFailure('Nano Banana 模型、供应商或生成参数无效', true)
    const input: Array<Record<string, string>> = [{ type: 'text', text: prompt }]
    let total = 0
    for (const id of referenceIds) {
      const bytes = references.get(id)
      if (!bytes || (total += bytes.length) > this.options.maxReferenceBytes)
        throw new ProviderFailure('参考图片总大小超过限制或素材未准备完成', true)
      const mime = detectMedia(bytes)?.mime
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime ?? ''))
        throw new ProviderFailure('参考素材仅支持 PNG、JPEG 和 WebP', true)
      input.push({ type: 'image', mime_type: mime!, data: bytes.toString('base64') })
    }
    const imageSize = preset.resolution === '0.5K' ? '512' : preset.resolution
    let images: Array<{ data?: unknown; mime_type?: unknown }>
    if (providerFor(model)?.id === 'model-link') {
      const body = await this.request(endpoint(model.api_base, `v1/models/${encodeURIComponent(model.model_id)}:generateContent`), key, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: input.map((part) => part.type === 'text' ? { text: part.text }
            : { inline_data: { mime_type: part.mime_type, data: part.data } }) }],
          generationConfig: { responseModalities: ['TEXT', 'IMAGE'],
            imageConfig: { aspectRatio: preset.ratio, imageSize } },
        }),
      })
      const feedback = body.promptFeedback ?? body.prompt_feedback
      const blocked = feedback?.blockReason ?? feedback?.block_reason
      if (typeof blocked === 'string' && blocked && blocked !== 'BLOCK_REASON_UNSPECIFIED')
        return { status: 'failed', error: `Nano Banana 请求被拒绝（${blocked.slice(0, 80)}）`, errorCode: 'EXTERNAL_FAILED' }
      if (!Array.isArray(body.candidates) || !body.candidates.length || body.candidates.length > 10)
        throw new ProviderFailure('Nano Banana 没有返回有效的生成候选，提交结果需要确认', false)
      // One requested candidate; alternatives are not additional requested images.
      const candidate = body.candidates[0]
      const finish = candidate?.finishReason ?? candidate?.finish_reason
      if (['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY',
        'IMAGE_PROHIBITED_CONTENT', 'IMAGE_RECITATION', 'NO_IMAGE'].includes(finish))
        return { status: 'failed', error: `Nano Banana 图片生成被拒绝（${finish}）`, errorCode: 'EXTERNAL_FAILED' }
      if (finish !== undefined && finish !== 'STOP')
        throw new ProviderFailure('Nano Banana 生成未完整结束，提交结果需要确认，不会自动重提', false)
      const parts = candidate?.content?.parts
      if (!Array.isArray(parts)) throw new ProviderFailure('Nano Banana 没有返回有效的最终图片，提交结果需要确认', false)
      images = parts.filter((part: any) => part && !part.thought).map((part: any) => {
        const image = part.inlineData ?? part.inline_data
        return { data: image?.data, mime_type: image?.mimeType ?? image?.mime_type }
      }).filter((image) => image.data !== undefined)
    } else {
      const body = await this.request(endpoint(model.api_base, 'v1beta/interactions'), key, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: model.model_id, input, store: false,
          response_format: { type: 'image', delivery: 'inline', mime_type: 'image/jpeg',
            aspect_ratio: preset.ratio, image_size: imageSize },
        }),
      }, 'google')
      if (body.status === 'failed' || body.status === 'cancelled') return {
        status: 'failed', error: typeof body.errors?.[0]?.message === 'string' ? body.errors[0].message : 'Nano Banana 图片生成失败',
        errorCode: 'EXTERNAL_FAILED',
      }
      if (body.status !== 'completed' || !Array.isArray(body.steps))
        throw new ProviderFailure('Nano Banana 返回了无法确认的生成状态，不会自动重提', false)
      images = body.steps.filter((step: any) => step?.type === 'model_output')
        .flatMap((step: any) => Array.isArray(step.content) ? step.content : [])
        .filter((content: any) => content?.type === 'image')
    }
    if (!images.length || images.length > 10)
      throw new ProviderFailure('Nano Banana 没有返回有效的最终图片，提交结果需要确认', false)
    const outputs: Output[] = []
    for (const image of images) {
      if (typeof image.data !== 'string') continue
      const base64 = image.data.replace(/[\r\n]/g, '')
      // Check encoded length before allocating the decoded buffer.
      if (!base64.length || base64.length % 4 !== 0 || base64.length > 4 * Math.ceil(this.options.maxMediaBytes / 3)
        || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) continue
      const bytes = Buffer.from(base64, 'base64'), media = detectMedia(bytes)
      if (bytes.length > this.options.maxMediaBytes || !media || media.kind !== 'image'
        || !['image/png', 'image/jpeg', 'image/webp'].includes(media.mime) || media.mime !== image.mime_type) continue
      try {
        const { default: sharp } = await import('sharp')
        const metadata = await sharp(bytes, { limitInputPixels: 100_000_000, animated: false }).metadata()
        if (!metadata.width || !metadata.height) continue
        outputs.push({ id: randomUUID(), mime: media.mime, filename: `generated-image.${media.mime === 'image/jpeg' ? 'jpg' : media.mime.split('/')[1]}`,
          width: metadata.width, height: metadata.height, base64 })
      } catch { /* Invalid image metadata is an invalid result, not a reason to regenerate. */ }
    }
    if (!outputs.length) throw new ProviderFailure('Nano Banana 返回的 Base64 图片无效、超限或格式不一致，提交结果需要确认', false)
    return { status: 'completed', outputs }
  }
  private async submitTts(snapshot: TtsTaskSnapshot, key: string): Promise<ProviderResult> {
    const signal = AbortSignal.any([this.signal, AbortSignal.timeout(this.options.requestTimeoutMs)])
    const { reference_id, speed, volume } = snapshot.params
    const response = await fetch(snapshot.model.api_base, {
      method: 'POST', redirect: 'error', signal,
      headers: { 'Content-Type': 'application/json', model: FISH_TTS_MODEL, ...(key ? { Authorization: `Bearer ${key}` } : {}) },
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
