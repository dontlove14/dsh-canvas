import { isTtsParams, type ModelInput, type ModelsResponse, type PublicModel, type MediaKind, type TaskAction, type PublicTtsSettings, type TtsSettingsInput } from '../shared/contracts'
import { V2_ROOT, browserHash, type CanvasSnapshot, type GraphMutation, type Catalog, type TaskDetail, type TaskSummary, type TaskSearchQuery, type TaskPage } from '../shared/v2'
import { WaveformSchema, WAVEFORM_VERSION, type AudioWaveform } from '../shared/audioWaveform'
import type { ObjectStorageSettings, StorageInput, MediaUrl, MediaVariant } from '../shared/objectStorage'
import type { SettingSecretRequest, SettingSecretResponse } from '../shared/settingSecrets'
import type { ReviewSettings, ReviewSettingsInput, ReviewProvider, ReviewPage, ReviewSubmit, PublicReview, ReviewGroups } from '../shared/seedanceReview'
import { ApiError, ResumableUploads, uploadCacheFor } from './resumableUploads'
import { UploadSessionSchema, UploadStatusSchema, UploadResultSchema, type UploadStatus } from '../shared/uploads'
import type { CachedUpload } from './uploadCache'
import { seedanceGenerationParams, seedanceInputCapabilities, validateSeedanceConnections } from '../shared/seedance'
export { ApiError } from './resumableUploads'

export class CanvasApi {
  private uploadManager?: ResumableUploads
  constructor(readonly base = `/${V2_ROOT}`) {}
  get uploads() {
    return this.uploadManager ??= new ResumableUploads({
      start: async (canvas, input) => UploadSessionSchema.parse(await this.request('upload-start', { canvas }, { ...this.json(input), signal: AbortSignal.timeout(30000) })),
      status: async (canvas, id) => UploadStatusSchema.parse(await this.request('upload-status', { canvas, id }, { signal: AbortSignal.timeout(30000), cache: 'no-store' })),
      chunk: (job, offset, blob, checksum, progress) => this.uploadChunk(job, offset, blob, checksum, progress),
      complete: async (canvas, id) => UploadResultSchema.parse(await this.request('upload-complete', { canvas }, { ...this.json({ id }), signal: AbortSignal.timeout(120000) })),
      cancel: (canvas, id) => this.request('upload-cancel', { canvas }, { ...this.json({ id }), signal: AbortSignal.timeout(30000) }),
      link: (job, result) => this.linkUpload(job, result.nodeId),
    }, uploadCacheFor(this.base))
  }
  resumeUploads() { return this.uploads.restore() }
  url(path: string, params: Record<string, string> = {}): string {
    const query = new URLSearchParams(params).toString()
    return `${this.base}/${path}${query ? `?${query}` : ''}`
  }
  private async request<T>(path: string, params: Record<string, string>, init?: RequestInit): Promise<T> {
    const response = await fetch(this.url(path, params), { credentials: 'same-origin', ...init })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new ApiError(body.error ?? `请求失败（${response.status}）`, body.code ?? 'NETWORK_ERROR', response.status)
    return body as T
  }
  private json(data: unknown): RequestInit { return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) } }
  async models(): Promise<PublicModel[]> { return (await this.request<ModelsResponse>('models', {})).models }
  async saveModel(input: ModelInput): Promise<PublicModel[]> { return (await this.request<ModelsResponse>('models', {}, this.json(input))).models }
  async settingSecret(input: SettingSecretRequest, signal?: AbortSignal): Promise<string> {
    return (await this.request<SettingSecretResponse>('settings-secret', {}, { ...this.json(input), signal, cache: 'no-store' })).value
  }
  reviewSettings(signal?: AbortSignal): Promise<ReviewSettings> { return this.request('seedance-review-settings', {}, { signal, cache: 'no-store' }) }
  saveReviewSettings(input: ReviewSettingsInput): Promise<ReviewSettings> { return this.request('seedance-review-settings', {}, this.json(input)) }
  testReviewSettings(provider: ReviewProvider): Promise<{ ok: boolean }> { return this.request('seedance-review-settings-test', {}, this.json({ provider })) }
  reviews(canvas: string, signal?: AbortSignal): Promise<ReviewPage> { return this.request('asset-reviews', { canvas }, { signal, cache: 'no-store' }) }
  submitReview(canvas: string, input: ReviewSubmit): Promise<PublicReview> { return this.request('asset-reviews', { canvas }, this.json(input)) }
  reviewAction(canvas: string, id: string, action: 'retry' | 'resume' | 'reconcile' | 'abandon', requestId?: string): Promise<PublicReview> {
    return this.request('asset-review-action', { canvas, id }, this.json({ action, ...(requestId ? { requestId } : {}) }))
  }
  reviewGroups(canvas: string, provider: ReviewProvider, nextToken?: string, signal?: AbortSignal): Promise<ReviewGroups> {
    return this.request('review-groups', { canvas, provider, ...(nextToken ? { nextToken } : {}) }, { signal, cache: 'no-store' })
  }
  async deleteModel(id: string): Promise<PublicModel[]> { return (await this.request<ModelsResponse>('model-delete', { id }, { method: 'POST' })).models }
  catalog(): Promise<Catalog> { return this.request('catalog', {}) }
  catalogCommand(input: { operation: string; id?: string; name?: string; revision?: number; folderId?: string | null }): Promise<{ id: string }> {
    return this.request('catalog', {}, this.json({ ...input, requestId: crypto.randomUUID() }))
  }
  state(canvas: string): Promise<CanvasSnapshot> { return this.request('graph', { canvas }) }
  save(canvas: string, mutation: GraphMutation): Promise<CanvasSnapshot> { return this.request('graph', { canvas }, this.json(mutation)) }
  generate(canvas: string, nodeId: string, revision: number, requestId = crypto.randomUUID()): Promise<TaskSummary> { return this.request('generate', { canvas }, this.json({ nodeId, revision, requestId })) }
  mockGenerate(canvas: string, nodeId: string, revision: number, requestId = crypto.randomUUID()): Promise<TaskSummary> { return this.request('mock-generate', { canvas }, this.json({ nodeId, revision, requestId })) }
  ttsGenerate(canvas: string, nodeId: string, revision: number, requestId = crypto.randomUUID()): Promise<TaskSummary> { return this.request('tts-generate', { canvas }, this.json({ nodeId, revision, requestId })) }
  ttsSettings(): Promise<PublicTtsSettings> { return this.request('tts-settings', {}) }
  saveTtsSettings(input: TtsSettingsInput): Promise<PublicTtsSettings> { return this.request('tts-settings', {}, this.json(input)) }
  taskDetail(canvas: string, id: string, signal?: AbortSignal): Promise<TaskDetail> { return this.request('task', { canvas, id }, { signal }) }
  searchTasks(query: Partial<TaskSearchQuery>, signal?: AbortSignal): Promise<TaskPage> {
    const params = Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]))
    return this.request('task-search', params, { signal })
  }
  tasks(canvas: string, cursor = 0): Promise<{ items: Array<{ id: string; nodeId: string; kind: string; title: string; sequence: number; status: string; progress: number | null; createdAt: number; updatedAt: number }>; nextCursor: number | null }> { return this.request('tasks', { canvas, cursor: String(cursor) }) }
  taskAction(canvas: string, id: string, action: TaskAction): Promise<{ ok: boolean }> { return this.request('task', { canvas }, this.json({ id, action })) }
  storage(): Promise<ObjectStorageSettings> { return this.request('storage', {}) }
  setStorage(input: StorageInput): Promise<ObjectStorageSettings> { return this.request('storage', {}, this.json(input)) }
  testStorage(input: StorageInput): Promise<{ ok: boolean }> { return this.request('storage-test', {}, this.json(input)) }
  mediaUrls(canvas: string, items: Array<{ assetId: string; variant: MediaVariant }>, force = false): Promise<{ items: Array<MediaUrl | { assetId: string; variant: MediaVariant; error: string }> }> {
    return this.request('media-urls', { canvas }, this.json({ items, force }))
  }
  retryMoves(): Promise<{ ok: boolean }> { return this.request('storage-retry', {}, { method: 'POST' }) }
  upload(canvas: string, file: File, kind: MediaKind, position: { x: number; y: number }, onStarted?: () => Promise<void>, onProgress?: (value: number) => void, target?: string) {
    return this.uploads.upload(canvas, file, kind, position, { started: onStarted, progress: onProgress }, target)
  }
  private uploadChunk(job: CachedUpload, offset: number, blob: Blob, checksum: string, progress: (bytes: number) => void): Promise<UploadStatus> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', this.url('upload', { canvas: job.canvas, id: job.requestId, kind: job.kind, offset: String(offset) }))
      xhr.timeout = 120000
      xhr.setRequestHeader('Content-Type', 'application/octet-stream')
      xhr.setRequestHeader('x-canvas-filename', encodeURIComponent(job.filename))
      xhr.setRequestHeader('x-canvas-chunk-sha256', checksum)
      xhr.upload.onprogress = (event) => { if (event.lengthComputable) progress(event.loaded) }
      xhr.onload = () => {
        try {
          const body = JSON.parse(xhr.responseText || '{}')
          if (xhr.status >= 200 && xhr.status < 300) resolve(UploadStatusSchema.parse(body))
          else reject(new ApiError(body.error ?? '上传失败', body.code ?? 'UPLOAD_FAILED', xhr.status))
        } catch { reject(new Error('上传响应中断，等待同步进度')) }
      }
      xhr.onerror = xhr.ontimeout = xhr.onabort = () => reject(new Error('上传连接中断，等待自动恢复'))
      xhr.send(blob)
    })
  }
  private async linkUpload(job: CachedUpload, nodeId: string): Promise<void> {
    for (;;) {
      const snapshot = await this.request<CanvasSnapshot>('graph', { canvas: job.canvas }, { signal: AbortSignal.timeout(30000) })
      const target = snapshot.graph.nodes.find((node) => node.id === job.target)
      const resource = snapshot.graph.nodes.find((node) => node.id === nodeId)
      if (!target || !resource) return
      if (!resource.assetId) {
        const detail = await this.taskDetail(job.canvas, job.result!.taskId)
        if (detail.failureCode) throw new ApiError('素材已接收，但保存失败；请在任务中重试保存后连接素材', 'IMPORT_FAILED', 409)
        await new Promise((resolve) => setTimeout(resolve, 500)); continue
      }
      if (snapshot.graph.edges.some((edge) => edge.source === nodeId && edge.target === job.target && edge.assetId === resource.assetId)) return
      const asset = snapshot.assets.find((item) => item.id === resource.assetId)!
      const models = await this.request<ModelsResponse>('models', {}, { signal: AbortSignal.timeout(30000) })
      const model = models.models.find((item) => item.id === target.modelId)
      try {
        if (asset.kind === 'image' && !['image/png', 'image/jpeg', 'image/webp'].includes(asset.mime))
          throw new Error('当前协议的参考图仅支持 PNG、JPEG 和 WebP')
        if (!model && asset.kind !== 'image') throw new Error('请先选择支持这类素材的模型')
        const references = snapshot.graph.edges.filter((edge) => edge.target === target.id)
        const params = model?.protocol === 'seedance-video' && target.params && !isTtsParams(target.params)
          ? seedanceGenerationParams(target.params, references.map((edge) => edge.assetId)) : target.params
        const caps = model && seedanceInputCapabilities(model, !isTtsParams(params) ? params : null)
        if (caps && (!caps.referenceKinds.includes(asset.kind) || references.length >= caps.maxReferences))
          throw new Error('当前模型不支持这份素材，或引用数量已达上限')
        if (model?.protocol === 'seedance-video' && params && !isTtsParams(params))
          validateSeedanceConnections(seedanceGenerationParams(params, [...references.map((edge) => edge.assetId), asset.id]),
            [...references.map((edge) => snapshot.assets.find((item) => item.id === edge.assetId)!), asset], model.model_id)
      } catch (error) { throw new ApiError(error instanceof Error ? error.message : '素材连接失败', 'REFERENCE_INVALID', 400) }
      const edge = { id: job.requestId, source: nodeId, target: target.id, assetId: resource.assetId }
      try {
        await this.save(job.canvas, { mutationId: crypto.randomUUID(), baseRevision: snapshot.graphRevision,
          nodes: [], edges: [{ value: edge, hash: await browserHash(edge) }], deleteNodes: [], deleteEdges: [] })
        return
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== 'GRAPH_CONFLICT') throw error
      }
    }
  }
  media(canvas: string, id: string, download = false): string { return this.url('media', { canvas, id, ...(download ? { download: '1' } : {}) }) }
  preview(canvas: string, id: string): string { return this.url('media', { canvas, id, variant: 'preview', v: '1' }) }
  async waveform(canvas: string, id: string, signal?: AbortSignal): Promise<AudioWaveform> {
    return WaveformSchema.parse(await this.request('media', { canvas, id, variant: 'waveform', v: WAVEFORM_VERSION }, { signal }))
  }
}
