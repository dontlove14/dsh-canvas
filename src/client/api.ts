import { type ModelInput, type ModelsResponse, type PublicModel, type MediaKind, type TaskAction, type PublicTtsSettings, type TtsSettingsInput } from '../shared/contracts'
import { V2_ROOT, type CanvasSnapshot, type GraphMutation, type Catalog, type TaskDetail, type TaskSummary, type TaskSearchQuery, type TaskPage } from '../shared/v2'
import { WaveformSchema, WAVEFORM_VERSION, type AudioWaveform } from '../shared/audioWaveform'
import type { ObjectStorageSettings, StorageInput, MediaUrl, MediaVariant } from '../shared/objectStorage'

export class ApiError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) { super(message) }
}
export class CanvasApi {
  constructor(readonly base = `/${V2_ROOT}`) {}
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
  async upload(canvas: string, file: File, kind: MediaKind, position: { x: number; y: number }, onStarted?: () => Promise<void>, onProgress?: (value: number) => void): Promise<{ taskId: string; nodeId: string }> {
    const session = await this.request<{ id: string; nodeId: string }>('upload-start', { canvas }, this.json({ requestId: crypto.randomUUID(), filename: file.name, kind, position }))
    await onStarted?.()
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', this.url('upload', { canvas, id: session.id, kind }))
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream')
      xhr.setRequestHeader('x-canvas-filename', encodeURIComponent(file.name))
      xhr.upload.onprogress = (event) => { if (event.lengthComputable) onProgress?.(Math.round(event.loaded / event.total * 100)) }
      xhr.onload = () => {
        const body = JSON.parse(xhr.responseText || '{}')
        if (xhr.status >= 200 && xhr.status < 300) resolve(body)
        else reject(new ApiError(body.error ?? '上传失败', body.code ?? 'UPLOAD_FAILED', xhr.status))
      }
      xhr.onerror = () => reject(new Error('上传连接中断，请重新上传'))
      xhr.send(file)
    })
  }
  media(canvas: string, id: string, download = false): string { return this.url('media', { canvas, id, ...(download ? { download: '1' } : {}) }) }
  preview(canvas: string, id: string): string { return this.url('media', { canvas, id, variant: 'preview', v: '1' }) }
  async waveform(canvas: string, id: string, signal?: AbortSignal): Promise<AudioWaveform> {
    return WaveformSchema.parse(await this.request('media', { canvas, id, variant: 'waveform', v: WAVEFORM_VERSION }, { signal }))
  }
}
