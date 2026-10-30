import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { z } from 'zod'
import { API_ROOT, IdSchema, WorkspaceIdSchema, ModelInputSchema, CanvasGraphSchema, TRACKED_STATUSES, validateGeneration, validateGraph, isGeneration, nodeMediaKind, type CanvasGraph, type Task, type WorkspaceState, type TaskAction } from '../shared/contracts'
import { V2_ROOT, MutationSchema, NameSchema, parseTaskSearchParams, type GraphMutation } from '../shared/v2'
import { CanvasError, Store } from './store'
import { CanvasRuntime } from './runtime'
import { hash, sql } from './persistence/database'
import { PreviewCache } from './media/previews'
import type { CredentialVault } from './credentials'
import { mockRecord, validateMockGeneration } from '../shared/mockModels'
import { resolvePrompt } from '../shared/promptMentions'
import { WaveformCache } from './media/waveforms'
import { TtsSettingsInputSchema, TtsParamsSchema, TtsTaskSnapshotSchema, isTtsParams, validateTtsText, type AnyTaskSnapshot } from '../shared/contracts'
import { StorageInputSchema, MediaUrlsSchema, MediaVariantSchema } from '../shared/objectStorage'
import type { StorageFactory } from './object-storage/types'
import { DerivedAssets } from './object-storage/derived'
import { videoGenerationParams, videoReferenceLimit, validateVideoConnections } from '../shared/video'
import { isMultimodalVideo } from '../shared/modelCatalog'
import { SettingSecretRequestSchema } from '../shared/settingSecrets'
import { ReviewSettingsInputSchema, ReviewProviderSchema, ReviewSubmitSchema, ReviewActionSchema } from '../shared/seedanceReview'
import { ReviewStore, publicReview } from './review/store'
import { ReviewRuntime } from './review/runtime'
import { OfficialReviewTransport, type ReviewTransport } from './review/provider'
import { UploadStartSchema } from '../shared/uploads'
import { HashSchema } from '../shared/v2'
import type { CanvasAgentCoordinator } from './agent/coordinator'
import { AgentControlCommandSchema } from '../shared/agent'
import { PresenceSchema, ViewReportSchema, PresentationAckSchema } from '../shared/presentation'

export interface CanvasConfig {
  dataDir: string; maxConcurrentTasks: number; pollIntervalMs: number; requestTimeoutMs: number
  maxMediaBytes: number; maxReferenceBytes: number
}
export const routeDefinitions = [
  { suffix: 'agent-presentation', methods: ['GET'] as const, requestBody: 'buffered' as const },
  { suffix: 'agent-presentation-events', methods: ['GET'] as const, requestBody: 'buffered' as const },
  { suffix: 'agent-view', methods: ['POST'] as const, requestBody: 'buffered' as const },
  { suffix: 'agent-presence', methods: ['POST'] as const, requestBody: 'buffered' as const },
  { suffix: 'agent-presentation-ack', methods: ['POST'] as const, requestBody: 'buffered' as const },
  { suffix: 'agent-control', methods: ['GET', 'POST'] as const, requestBody: 'buffered' as const },
  { suffix: 'agent-session', methods: ['GET'] as const, requestBody: 'buffered' as const },
  { suffix: 'agent-models', methods: ['GET'] as const, requestBody: 'buffered' as const },
  { suffix: 'agent-drafts', methods: ['GET'] as const, requestBody: 'buffered' as const },
  { suffix: 'models', methods: ['GET', 'POST'] as const, requestBody: 'buffered' as const },
  { suffix: 'settings-secret', methods: ['POST'] as const, requestBody: 'buffered' as const },
  { suffix: 'seedance-review-settings', methods: ['GET', 'POST'] as const, requestBody: 'buffered' as const },
  { suffix: 'seedance-review-settings-test', methods: ['POST'] as const, requestBody: 'buffered' as const },
  { suffix: 'asset-reviews', methods: ['GET', 'POST'] as const, requestBody: 'buffered' as const },
  { suffix: 'asset-review', methods: ['GET'] as const, requestBody: 'buffered' as const },
  { suffix: 'asset-review-action', methods: ['POST'] as const, requestBody: 'buffered' as const },
  { suffix: 'review-groups', methods: ['GET'] as const, requestBody: 'buffered' as const },
  { suffix: 'model-delete', methods: ['POST'] as const, requestBody: 'buffered' as const },
  { suffix: 'catalog', methods: ['GET', 'POST'] as const, requestBody: 'buffered' as const },
  { suffix: 'graph', methods: ['GET', 'POST'] as const, requestBody: 'buffered' as const },
  { suffix: 'generate', methods: ['POST'] as const, requestBody: 'buffered' as const },
  { suffix: 'mock-generate', methods: ['POST'] as const, requestBody: 'buffered' as const },
  { suffix: 'tts-generate', methods: ['POST'] as const, requestBody: 'buffered' as const },
  { suffix: 'tts-settings', methods: ['GET', 'POST'] as const, requestBody: 'buffered' as const },
  { suffix: 'tasks', methods: ['GET'] as const, requestBody: 'buffered' as const },
  { suffix: 'task-search', methods: ['GET'] as const, requestBody: 'buffered' as const },
  { suffix: 'task', methods: ['GET', 'POST'] as const, requestBody: 'buffered' as const },
  { suffix: 'upload-start', methods: ['POST'] as const, requestBody: 'buffered' as const },
  { suffix: 'upload-status', methods: ['GET'] as const, requestBody: 'buffered' as const },
  { suffix: 'upload', methods: ['POST'] as const, requestBody: 'streaming' as const },
  { suffix: 'upload-complete', methods: ['POST'] as const, requestBody: 'buffered' as const },
  { suffix: 'upload-cancel', methods: ['POST'] as const, requestBody: 'buffered' as const },
  { suffix: 'media', methods: ['GET', 'HEAD'] as const, requestBody: 'buffered' as const },
  { suffix: 'storage', methods: ['GET', 'POST'] as const, requestBody: 'buffered' as const },
  { suffix: 'storage-test', methods: ['POST'] as const, requestBody: 'buffered' as const },
  { suffix: 'media-urls', methods: ['POST'] as const, requestBody: 'buffered' as const },
  { suffix: 'storage-retry', methods: ['POST'] as const, requestBody: 'buffered' as const },
]
const CatalogCommand = z.object({
  requestId: IdSchema, operation: z.enum(['folder-create', 'folder-rename', 'folder-delete', 'canvas-create', 'canvas-rename', 'canvas-move', 'canvas-delete']),
  id: WorkspaceIdSchema.optional(), name: NameSchema.optional(), folderId: IdSchema.nullable().optional(), revision: z.number().int().nonnegative().optional(),
}).strict()

export class CanvasService {
  agentControl?: CanvasAgentCoordinator
  readonly store: Store
  readonly runtime: CanvasRuntime
  readonly previews: PreviewCache
  readonly waveforms: WaveformCache
  readonly derived: DerivedAssets
  readonly reviews: ReviewStore
  readonly reviewRuntime: ReviewRuntime
  private closing = false
  constructor(readonly config: CanvasConfig, vault?: CredentialVault, factory?: StorageFactory, reviewTransport?: ReviewTransport) {
    this.store = new Store(config.dataDir, vault, factory)
    this.reviews = new ReviewStore(this.store, reviewTransport ?? new OfficialReviewTransport(config.requestTimeoutMs))
    this.reviewRuntime = new ReviewRuntime(this.reviews)
    this.runtime = new CanvasRuntime(this.store, config, (id, snapshot) => this.reviews.referenceUris(id, snapshot))
    this.previews = new PreviewCache(config.dataDir)
    this.waveforms = new WaveformCache(config.dataDir)
    this.derived = new DerivedAssets(this.store, config.maxMediaBytes)
  }
  async init(): Promise<void> {
    await this.store.init()
    try { await this.agentControl?.init(); await this.reviews.init(); await this.reviewRuntime.start(); await this.runtime.start() } catch (error) { await this.close(); throw error }
  }
  private async validate(state: WorkspaceState, graph: CanvasGraph): Promise<void> {
    validateGraph(graph, state.assets, state.tasks)
    const models = new Map(this.store.listModels().map((model) => [model.id, model]))
    for (const previous of state.graph.nodes) if (!graph.nodes.some((n) => n.id === previous.id) && await this.store.hasUnfinished(state.workspaceId, previous.id)) throw new CanvasError('节点仍有未结束任务或上传', 409, 'NODE_BUSY')
    for (const node of graph.nodes) {
      NameSchema.parse(node.title)
      if (node.assetId) {
        const asset = state.assets.find((a) => a.id === node.assetId)
        if (isGeneration(node.kind) || !asset || asset.kind !== nodeMediaKind(node.kind)) throw new CanvasError('资源节点素材类型不一致')
      }
      if (node.selectedResultId && !state.tasks.some((t) => t.nodeId === node.id && t.resultIds.includes(node.selectedResultId!))) throw new CanvasError('选中的生成结果不属于这个节点')
      const model = node.modelId ? models.get(node.modelId) : undefined
      if (model && isMultimodalVideo(model) && node.params && !isTtsParams(node.params)) {
        const references = graph.edges.filter((edge) => edge.target === node.id)
        validateVideoConnections(videoGenerationParams(node.params, references.map((edge) => edge.assetId), model),
          references.map((edge) => state.assets.find((asset) => asset.id === edge.assetId)!), model)
      }
    }
  }
  async saveGraph(canvas: string, graph: CanvasGraph, revision: number): Promise<WorkspaceState> {
    graph = CanvasGraphSchema.parse(graph)
    await this.store.update(canvas, async (state) => {
      if (state.graphRevision !== revision) throw new CanvasError('画布已更新，请保留草稿并重新载入', 409, 'GRAPH_CONFLICT')
      await this.validate(state, graph)
      state.graph = graph; state.graphRevision++
    })
    return this.store.state(canvas)
  }
  async mutateGraph(canvas: string, input: GraphMutation, beforeCommit?: () => void) {
    const requestHash = hash(input)
    let replay = false
    await this.store.update(canvas, async (state) => {
      const receipt = await this.store.db.get('SELECT * FROM canvas_mutations WHERE canvas_id=? AND mutation_id=?', [canvas, input.mutationId])
      if (receipt) {
        if (receipt.request_hash !== requestHash) throw new CanvasError('增量 ID 已用于其他内容', 409, 'REQUEST_REUSED')
        replay = true; return
      }
      if (state.graphRevision !== input.baseRevision) throw new CanvasError('画布已更新，请保留草稿并重新载入', 409, 'GRAPH_CONFLICT')
      for (const entry of [...input.nodes, ...input.edges, ...(input.viewport ? [input.viewport] : [])]) if (hash(entry.value) !== entry.hash) throw new CanvasError('增量内容 hash 不匹配', 409, 'HASH_MISMATCH')
      if (new Set(input.nodes.map((n) => n.value.id)).size !== input.nodes.length || new Set(input.edges.map((e) => e.value.id)).size !== input.edges.length) throw new CanvasError('增量包含重复对象')
      const nodeUpserts = new Map(input.nodes.map(({ value }) => [value.id, value]))
      const edgeUpserts = new Map(input.edges.map(({ value }) => [value.id, value]))
      const graph: CanvasGraph = {
        ...state.graph,
        nodes: state.graph.nodes.filter((n) => !input.deleteNodes.includes(n.id)).map((n) => { const next = nodeUpserts.get(n.id) ?? n; nodeUpserts.delete(n.id); return next }).concat([...nodeUpserts.values()]),
        edges: state.graph.edges.filter((e) => !input.deleteEdges.includes(e.id)).map((e) => { const next = edgeUpserts.get(e.id) ?? e; edgeUpserts.delete(e.id); return next }).concat([...edgeUpserts.values()]),
        viewport: input.viewport?.value ?? state.graph.viewport,
      }
      await this.validate(state, graph)
      if (hash(graph) !== hash(state.graph)) { state.graph = graph; state.graphRevision++ }
    }, (before, after) => replay ? [] : [
      sql('INSERT INTO canvas_mutations VALUES(?,?,?,?,?,?,?,?,?,?,?)', [canvas, input.mutationId, 'user', requestHash, before.graphRevision, after.graphRevision, Number(after.graphRevision !== before.graphRevision), hash({ revision: before.graphRevision, graph: before.graph }), hash({ revision: after.graphRevision, graph: after.graph }), JSON.stringify(input), Date.now()]),
    ], beforeCommit)
    const snapshot = await this.store.snapshot(canvas)
    const receipt = await this.store.db.get('SELECT committed_revision AS revision,commit_hash AS commitHash,has_changes AS hasChanges FROM canvas_mutations WHERE canvas_id=? AND mutation_id=?', [canvas, input.mutationId])
    return { ...snapshot, mutation: { id: input.mutationId, replay, ...receipt } }
  }
  async generate(canvas: string, nodeId: string, revision: number, requestId: string = randomUUID(), mock = false, tts = false, beforeCommit?: () => void): Promise<Task> {
    let acceptedTaskId = ''
    let ttsCredentialRef: string | undefined
    const requestHash = hash({ canvas, nodeId, revision, ...(mock ? { mock: true } : {}), ...(tts ? { tts: true } : {}) })
    const task = await this.store.update(canvas, async (state) => {
      const replay = await this.store.db.get('SELECT task_id,request_hash FROM task_details WHERE request_id=?', [requestId])
      if (replay) {
        if (replay.request_hash !== requestHash) throw new CanvasError('请求 ID 已用于其他内容', 409, 'REQUEST_REUSED')
        const old = state.tasks.find((t) => t.id === replay.task_id)
        if (!old) throw new CanvasError('请求归属不一致', 409)
        acceptedTaskId = old.id; return old
      }
      await this.store.requireStorage()
      if (state.graphRevision !== revision) throw new CanvasError('请先保存当前画布后再生成', 409, 'GRAPH_CONFLICT')
      const node = state.graph.nodes.find((n) => n.id === nodeId)
      if (!node || !isGeneration(node.kind)) throw new CanvasError('请选择生成节点')
      let snapshot: AnyTaskSnapshot
      if (tts) {
        if (node.kind !== 'tts-generation') throw new CanvasError('请选择语音生成节点')
        if (state.graph.edges.some((edge) => edge.target === nodeId)) throw new CanvasError('语音节点不支持输入连线')
        validateTtsText(node.prompt)
        const service = this.store.ttsService()
        const params = TtsParamsSchema.parse(node.params)
        snapshot = TtsTaskSnapshotSchema.parse({ model: service.model, prompt: node.prompt.trim(), params: { ...params, reference_id: params.reference_id.trim() }, referenceIds: [] })
        ttsCredentialRef = service.credentialRef
      } else {
        if (node.kind === 'tts-generation') throw new CanvasError('语音节点请使用语音生成接口')
        if (!node.modelId || !node.params || isTtsParams(node.params)) throw new CanvasError('请先选择模型')
        const model = mock ? mockRecord(node.modelId) : this.store.model(node.modelId).model
        if (model.kind !== nodeMediaKind(node.kind)) throw new CanvasError('模型类型与节点不一致')
        snapshot = { model, prompt: node.prompt.trim(), params: node.params, referenceIds: state.graph.edges.filter((e) => e.target === nodeId).map((e) => e.assetId) }
        if (isMultimodalVideo(model)) snapshot.params = videoGenerationParams(snapshot.params, snapshot.referenceIds, model)
        if (mock) validateMockGeneration(snapshot, state.assets)
        else validateGeneration(snapshot, state.assets)
        snapshot.prompt = resolvePrompt(snapshot.prompt, snapshot.referenceIds, state.assets)
      }
      let bytes = 0
      for (const id of snapshot.referenceIds) {
        const locator = await this.store.locator(canvas, id)
        bytes += locator.bytes
        if (isMultimodalVideo(snapshot.model)) {
          const asset = state.assets.find((asset) => asset.id === id)!
          if (locator.bytes > videoReferenceLimit(asset.kind, snapshot.model.protocol)) throw new CanvasError('视频参考素材超过单文件大小限制', 413)
        } else if (bytes > this.config.maxReferenceBytes) throw new CanvasError('参考素材总大小超过限制', 413)
      }
      if ((await this.store.db.get("SELECT COUNT(*) AS count FROM task_catalog WHERE status IN ('queued','running','external_wait','saving')")).count >= 1000) throw new CanvasError('任务队列已满，请稍后再提交', 429, 'QUEUE_FULL')
      if (!mock && snapshot.model.protocol === 'seedance-video') await this.reviews.pin(canvas, requestId, requestHash, snapshot as import('../shared/contracts').TaskSnapshot)
      const task: Task = { id: randomUUID(), nodeId, workspaceId: canvas, snapshot, status: 'submitted', resultIds: [], createdAt: Date.now(), updatedAt: Date.now() }
      state.tasks.push(task)
      acceptedTaskId = task.id
      return task
    }, (_before, after) => {
      return [sql('UPDATE task_details SET request_id=?,request_hash=? WHERE task_id=?', [requestId, requestHash, acceptedTaskId]), ...(ttsCredentialRef ? [sql('UPDATE task_details SET credential_ref=? WHERE task_id=?', [ttsCredentialRef, acceptedTaskId])] : [])]
    }, beforeCommit)
    this.runtime.wake()
    return task
  }
  async taskAction(canvas: string, id: string, action: TaskAction): Promise<void> {
    if (this.runtime.isActive(id)) throw new CanvasError('任务正在处理，请稍后重试', 409)
    const catalog = await this.store.db.get('SELECT kind,status FROM task_catalog WHERE id=? AND canvas_id=?', [id, canvas])
    if (catalog?.kind === 'import') {
      if (catalog.status !== 'save_failed') throw new CanvasError('当前导入任务不可重试', 409)
      await this.store.db.batch([sql('UPDATE task_catalog SET status=? WHERE id=?', [action === 'abandon' ? 'abandoned' : 'queued', id])])
      if (action === 'abandon') {
        const descriptor = await this.store.db.get('SELECT import_json FROM task_details WHERE task_id=?', [id])
        if (descriptor?.import_json) await rm(this.store.stagePath(JSON.parse(descriptor.import_json).stageFile), { force: true })
      }
      this.runtime.wake(); return
    }
    await this.store.update(canvas, async (state) => {
      const task = state.tasks.find((t) => t.id === id)
      if (!task) throw new CanvasError('任务不存在', 404)
      if (action === 'retry-save') {
        if (task.status !== 'save_failed') throw new CanvasError('只有结果保存失败可重新保存')
        const data = await this.store.taskPrivate(id)
        if (!data.outputs && !task.providerTaskId) throw new CanvasError('原结果描述未能持久保存，无法恢复；请核对后结束本地等待', 409, 'RESULT_UNAVAILABLE')
        task.status = task.providerTaskId ? 'generating' : 'saving'; task.error = undefined
      } else if (action === 'resume-query') {
        if (task.status !== 'unknown' || !task.providerTaskId) throw new CanvasError('这个任务没有可恢复查询的外部 ID')
        await this.store.taskPrivate(id); task.status = 'generating'; task.error = undefined
      } else {
        if (!['unknown', 'save_failed'].includes(task.status)) throw new CanvasError('当前任务不能结束本地等待')
        task.status = 'abandoned'
      }
      task.updatedAt = Date.now()
    }, () => [sql('UPDATE task_details SET next_run_at=0 WHERE task_id=?', [id])])
    if (action === 'abandon') await this.store.removeTaskPrivate(id)
    this.runtime.wake()
  }
  async handle(request: Request): Promise<Response> {
    return this.agentControl ? this.agentControl.manual(request, () => this.handleInner(request)) : this.handleInner(request)
  }
  private async handleInner(request: Request): Promise<Response> {
    try {
      if (this.closing) throw new CanvasError('宿主正在停止', 503)
      const url = new URL(request.url)
      const isV2 = url.pathname.startsWith(`/${V2_ROOT}/`)
      const suffix = url.pathname.slice(`/${isV2 ? V2_ROOT : API_ROOT}/`.length)
      const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
      const canvas = () => WorkspaceIdSchema.parse(url.searchParams.get('canvas') ?? url.searchParams.get('workspace'))
      const requireCanvas = async () => {
        const id = canvas()
        if (!(await this.store.db.get('SELECT id FROM canvases WHERE id=? AND deleted_at IS NULL', [id]))) throw new CanvasError('画布不存在', 404)
        return id
      }
      if (suffix.startsWith('agent-')) {
        const agent = this.agentControl
        if (!agent) throw new CanvasError('当前环境未启用画布 Agent', 503, 'AGENT_UNAVAILABLE')
        if (suffix === 'agent-session' && request.method === 'GET') return json(agent.session(z.string().min(1).max(200).parse(url.searchParams.get('sessionId'))))
        if (suffix === 'agent-models' && request.method === 'GET') return json(await agent.modelCatalog())
        if (suffix === 'agent-presence' && request.method === 'POST') {
          const input = PresenceSchema.parse(await request.json())
          agent.presentation.reportPresence(input.viewId, input.sessionId, input.visible)
          return json({ ok: true })
        }
        if (['agent-presentation', 'agent-presentation-events'].includes(suffix) && request.method === 'GET') {
          const sessionId = z.string().min(1).max(200).parse(url.searchParams.get('sessionId'))
          if (suffix === 'agent-presentation') return json(agent.presentation.state(sessionId))
          let dispose = (_close = true) => {}
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              const encoder = new TextEncoder()
              let stopped = false, last = ''
              const send = () => {
                if (stopped) return
                if (agent.presentation.closed) { dispose(); return }
                const state = agent.presentation.state(sessionId), body = JSON.stringify(state)
                if (body !== last) { last = body; controller.enqueue(encoder.encode(`data: ${body}\n\n`)) }
              }
              const unsubscribe = agent.presentation.subscribe(send)
              const timer = setInterval(() => { send(); if (!stopped) controller.enqueue(encoder.encode(': heartbeat\n\n')) }, 2000)
              const abort = () => dispose()
              dispose = (close = true) => { if (stopped) return; stopped = true; clearInterval(timer); unsubscribe(); request.signal.removeEventListener('abort', abort); if (close) controller.close() }
              request.signal.addEventListener('abort', abort, { once: true }); send()
            },
            cancel() { dispose(false) },
          })
          return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' } })
        }
        const id = await requireCanvas()
        if (suffix === 'agent-view' && request.method === 'POST') {
          const view = ViewReportSchema.parse(await request.json())
          if (view.canvasId !== id) throw new CanvasError('画布身份不一致')
          agent.presentation.report(view); return json({ ok: true })
        }
        if (suffix === 'agent-presentation-ack' && request.method === 'POST') {
          const ack = PresentationAckSchema.parse(await request.json())
          if (ack.canvasId !== id) throw new CanvasError('画布身份不一致')
          agent.presentation.ack(ack); return json({ ok: true })
        }
        if (suffix === 'agent-drafts' && request.method === 'GET') return json({ drafts: agent.ledger.drafts(id) })
        if (suffix === 'agent-control') {
          if (request.method === 'GET') return json(agent.control(id))
          const input = AgentControlCommandSchema.parse(await request.json())
          if (input.action === 'takeover') return json(await agent.takeover(id))
          if (!input.sessionId || input.revision === undefined) throw new CanvasError('请提供会话与已保存画布版本')
          return json(await agent.delegate(id, input.sessionId, input.revision))
        }
      }
      if (!isV2 && suffix === 'workspace' && request.method === 'GET') return json(this.store.state(canvas()))
      if (suffix === 'models') {
        if (request.method === 'GET') return json({ models: this.store.listModels() })
        if (request.method === 'POST') return json({ models: await this.store.saveModel(ModelInputSchema.parse(await request.json())) })
      }
      if (!isV2) throw new CanvasError('请使用 v2 接口', 410, 'API_RETIRED')
      if (suffix === 'settings-secret' && request.method === 'POST') {
        if (url.search) throw new CanvasError('凭据查看不接受查询参数')
        const input = SettingSecretRequestSchema.parse(await request.json())
        return json({ value: input.scope === 'seedance-review' ? await this.reviews.secret(input.provider, input.field) : await this.store.settingSecret(input) })
      }
      if (suffix === 'seedance-review-settings') {
        if (request.method === 'GET') return json(await this.reviews.settings())
        if (request.method === 'POST') {
          const result = await this.reviews.saveSettings(ReviewSettingsInputSchema.parse(await request.json()))
          this.reviewRuntime.wake(); return json(result)
        }
      }
      if (suffix === 'seedance-review-settings-test' && request.method === 'POST') {
        const input = z.object({ provider: ReviewProviderSchema }).strict().parse(await request.json())
        await this.reviewRuntime.test(input.provider); return json({ ok: true })
      }
      if (suffix === 'asset-reviews') {
        const id = await requireCanvas()
        if (request.method === 'GET') {
          const ids = url.searchParams.has('assetIds') ? z.array(IdSchema).max(100).parse(url.searchParams.get('assetIds')!.split(',')) : undefined
          return json(await this.reviews.page(id, ids))
        }
        if (request.method === 'POST') {
          const job = await this.reviews.submit(id, ReviewSubmitSchema.parse(await request.json()))
          this.reviewRuntime.wake(); return json(job, 202)
        }
      }
      if (suffix === 'asset-review' && request.method === 'GET')
        return json(publicReview(await this.reviews.job(await requireCanvas(), IdSchema.parse(url.searchParams.get('id')))))
      if (suffix === 'asset-review-action' && request.method === 'POST') {
        const id = await requireCanvas(), jobId = IdSchema.parse(url.searchParams.get('id'))
        return json(await this.reviewRuntime.action(id, jobId, ReviewActionSchema.parse(await request.json())))
      }
      if (suffix === 'review-groups' && request.method === 'GET') {
        const id = await requireCanvas(), provider = ReviewProviderSchema.parse(url.searchParams.get('provider'))
        const token = z.string().min(1).max(4096).optional().parse(url.searchParams.get('nextToken') ?? undefined)
        return json(await this.reviewRuntime.groups(id, provider, token))
      }
      if (suffix === 'tts-settings') {
        if (request.method === 'GET') return json(this.store.ttsSettings())
        if (request.method === 'POST') return json(await this.store.saveTtsSettings(TtsSettingsInputSchema.parse(await request.json())))
      }
      if (suffix === 'model-delete' && request.method === 'POST') return json({ models: await this.store.deleteModel(IdSchema.parse(url.searchParams.get('id'))) })
      if (suffix === 'catalog') {
        if (request.method === 'GET') return json(await this.store.catalog())
        if (request.method === 'POST') {
          const input = CatalogCommand.parse(await request.json())
          const result = await this.store.catalogCommand(input)
          if (input.operation === 'canvas-create') {
            await this.reviews.ensureCanvas(result.id).catch(() => {})
            this.reviewRuntime.wake()
          }
          return json(result)
        }
      }
      if (suffix === 'graph') {
        const id = await requireCanvas()
        if (request.method === 'GET') {
          if (url.searchParams.has('afterRevision')) {
            const after = z.coerce.number().int().nonnegative().parse(url.searchParams.get('afterRevision'))
            return json(await this.store.graphChanges(id, after))
          }
          return json({ ...await this.store.snapshot(id), ...(this.agentControl ? { agentControl: this.agentControl.control(id) } : {}) })
        }
        if (request.method === 'POST') return json(await this.mutateGraph(id, MutationSchema.parse(await request.json())))
      }
      if (['generate', 'mock-generate', 'tts-generate'].includes(suffix) && request.method === 'POST') {
        const body = z.object({ nodeId: IdSchema, revision: z.number().int().nonnegative(), requestId: IdSchema }).strict().parse(await request.json())
        const task = await this.generate(await requireCanvas(), body.nodeId, body.revision, body.requestId, suffix === 'mock-generate', suffix === 'tts-generate')
        const { snapshot: _s, providerTaskId: _p, error: _e, ...summary } = task
        return json({ ...summary, requestId: body.requestId }, 202)
      }
      if (suffix === 'task-search' && request.method === 'GET') return json(await this.store.searchTasks(parseTaskSearchParams(url.searchParams)))
      if (suffix === 'tasks' && request.method === 'GET') {
        const id = await requireCanvas()
        const cursor = z.coerce.number().int().nonnegative().parse(url.searchParams.get('cursor') ?? 0)
        const rows = await this.store.db.all('SELECT id,node_id AS nodeId,kind,title,queue_seq AS sequence,status,progress,created_at AS createdAt,updated_at AS updatedAt FROM task_catalog WHERE canvas_id=? AND queue_seq>? ORDER BY queue_seq LIMIT 50', [id, cursor])
        return json({ items: rows, nextCursor: rows.length === 50 ? rows.at(-1).sequence : null })
      }
      if (suffix === 'task') {
        const id = await requireCanvas()
        if (request.method === 'GET') return json(await this.store.taskDetail(id, IdSchema.parse(url.searchParams.get('id'))))
        if (request.method === 'POST') {
          const body = z.object({ id: IdSchema, action: z.enum(['retry-save', 'resume-query', 'abandon']) }).strict().parse(await request.json())
          await this.taskAction(id, body.id, body.action); return json({ ok: true })
        }
      }
      if (suffix === 'upload-start' && request.method === 'POST') {
        const body = UploadStartSchema.parse(await request.json())
        return json(await this.runtime.uploads.start(await requireCanvas(), body), 201)
      }
      if (suffix === 'upload-status' && request.method === 'GET')
        return json(await this.runtime.uploads.status(await requireCanvas(), IdSchema.parse(url.searchParams.get('id'))))
      if (['upload-complete', 'upload-cancel'].includes(suffix) && request.method === 'POST') {
        const body = z.object({ id: IdSchema }).strict().parse(await request.json()), canvasId = await requireCanvas()
        if (suffix === 'upload-cancel') return json(await this.runtime.uploads.cancel(canvasId, body.id))
        const result = await this.runtime.uploads.complete(canvasId, body.id)
        this.runtime.wake(); return json(result, 202)
      }
      if (suffix === 'upload' && request.method === 'POST') {
        const id = await requireCanvas()
        if (!request.body) throw new CanvasError('请上传文件')
        if (Number(request.headers.get('content-length')) > this.config.maxMediaBytes) throw new CanvasError('文件过大', 413)
        const kind = z.enum(['image', 'video', 'audio']).parse(url.searchParams.get('kind'))
        const filename = decodeURIComponent(request.headers.get('x-canvas-filename') ?? 'media')
        const stream = Readable.fromWeb(request.body as import('node:stream/web').ReadableStream)
        const uploadId = IdSchema.parse(url.searchParams.get('id'))
        if (url.searchParams.has('offset')) {
          const offset = z.coerce.number().int().nonnegative().parse(url.searchParams.get('offset'))
          const checksum = HashSchema.parse(request.headers.get('x-canvas-chunk-sha256'))
          return json(await this.runtime.uploads.chunk(id, uploadId, stream, kind, filename, offset, checksum, request.signal))
        }
        const result = await this.runtime.uploads.accept(id, uploadId, stream, kind, filename, request.signal)
        this.runtime.wake(); return json(result, 202)
      }
      if (suffix === 'storage') {
        if (request.method === 'GET') return json(await this.store.storage())
        if (request.method === 'POST') return json(await this.store.setStorage(StorageInputSchema.parse(await request.json())))
      }
      if (suffix === 'storage-test' && request.method === 'POST') {
        await this.store.testStorage(StorageInputSchema.parse(await request.json())); return json({ ok: true })
      }
      if (suffix === 'media-urls' && request.method === 'POST') {
        const id = await requireCanvas()
        const body = MediaUrlsSchema.parse(await request.json())
        const items = []
        for (const item of body.items) {
          try {
            const locator = await this.derived.get(id, item.assetId, item.variant)
            items.push({ ...item, ...await this.store.objects.sign(locator, { method: 'GET', ttl: 3600 }, body.force) })
          } catch (error) {
            items.push({ ...item, error: this.store.redact(error instanceof Error ? error.message : '媒体读取失败') })
          }
        }
        return json({ items })
      }
      if (suffix === 'storage-retry' && request.method === 'POST') { await this.store.retryMoves(); this.runtime.wake(); return json({ ok: true }) }
      if (suffix === 'media' && ['GET', 'HEAD'].includes(request.method)) return await this.media(request, await requireCanvas(), IdSchema.parse(url.searchParams.get('id')))
      return json({ error: '接口不存在', code: 'NOT_FOUND' }, 404)
    } catch (error) {
      const message = error instanceof z.ZodError ? error.issues[0]?.message ?? '输入无效' : error instanceof SyntaxError ? '请求内容格式错误' : error instanceof Error ? error.message : '操作失败'
      return Response.json({ error: await this.reviews.redactPublic(message).catch(() => this.store.redact(message)), code: error instanceof CanvasError ? error.code : 'INVALID_REQUEST' }, { status: error instanceof CanvasError ? error.status : 400, headers: { 'Cache-Control': 'no-store' } })
    }
  }
  private async media(request: Request, canvas: string, id: string): Promise<Response> {
    const asset = this.store.state(canvas).assets.find((a) => a.id === id)
    if (!asset) throw new CanvasError('媒体文件不存在', 404)
    const params = new URL(request.url).searchParams
    const variant = MediaVariantSchema.parse(params.get('variant') ?? 'original')
    if (params.has('v') && params.get('v') !== '1') throw new CanvasError('派生资源版本不可用', 400)
    if (variant === 'waveform') {
      const bytes = await this.derived.waveform(canvas, id)
      return new Response(request.method === 'HEAD' ? null : new Uint8Array(bytes), {
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(bytes.length),
          'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
      })
    }
    const locator = await this.derived.get(canvas, id, variant)
    const signed = await this.store.objects.sign(locator, { method: request.method === 'HEAD' ? 'HEAD' : 'GET', ttl: 3600,
      ...(params.has('download') ? { download: asset.filename } : {}) })
    return new Response(null, { status: 307, headers: { Location: signed.url, 'Cache-Control': 'no-store' } })
  }
  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
    await Promise.all([this.derived.close(), this.previews.close(), this.waveforms.close(), this.runtime.close(), this.reviewRuntime.close()])
    await this.reviews.close()
    await this.store.close()
  }
}
