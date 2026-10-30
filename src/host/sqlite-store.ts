import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rm, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import lockfile from 'proper-lockfile'
import { z } from 'zod'
import { CanvasError, type TaskPrivate } from './store'
import { Database, sql, hash, type Statement, type SqlValue } from './persistence/database'
import { LocalVault, atomicJson, type CredentialVault } from './credentials'
import { pathKey, receive, safeName, extension } from './media/files'
import { NameSchema, TaskSearchQuerySchema, type TaskSearchQuery, type TaskPage, type Catalog, type CanvasSnapshot, type TaskDetail, type TaskSummary } from '../shared/v2'
import { ModelRecordSchema, WorkspaceStateSchema, emptyGraph, capabilitiesFor, BUSY_STATUSES,
  type ModelRecord, type ModelInput, type PublicModel, type WorkspaceState, type Asset, type MediaKind, type Task } from '../shared/contracts'
import { maskSecret, SettingSecretRequestSchema, type SettingSecretRequest } from '../shared/settingSecrets'
import { isMockModel } from '../shared/mockModels'
import { BUILTIN_MODELS, builtinDefinition, correctSeedreamModelId, modelConfigured, modelRequiresEndpoint, isUnsupportedModelLinkH3, providerFor } from '../shared/modelCatalog'
import { inspectSeedanceReference } from './media/seedanceReferences'
import { FISH_TTS_ENDPOINT, TtsParamsSchema, TtsSettingsInputSchema, type TtsSettingsInput, type PublicTtsSettings, type TtsTaskSnapshot } from '../shared/contracts'
import { STORAGE_REQUIRED, type ObjectLocator, type ObjectStorageSettings, type StorageInput, type MediaVariant } from '../shared/objectStorage'
import { ObjectStorage } from './object-storage/service'
import type { StorageFactory, StorageRecord, StorageCredentials } from './object-storage/types'

const TtsConfigSchema = z.object({
  endpoint: TtsSettingsInputSchema.shape.endpoint, revision: z.number().int().positive(),
  id: z.string().uuid(), credentialRef: z.string().min(1),
}).strict()

const statusToDb: Record<Task['status'], string> = { submitted: 'queued', queued: 'external_wait', generating: 'running', saving: 'saving', completed: 'succeeded', failed: 'failed', unknown: 'needs_attention', save_failed: 'save_failed', abandoned: 'abandoned' }
const statusFromDb: Record<string, Task['status']> = { queued: 'submitted', external_wait: 'queued', running: 'generating', saving: 'saving', succeeded: 'completed', failed: 'failed', needs_attention: 'unknown', save_failed: 'save_failed', abandoned: 'abandoned' }

// Use the submitted identity, never today's model configuration or a private URL as a label.
function taskModelIdentity(model: { name?: unknown; api_base?: unknown; protocol?: unknown } | undefined) {
  return {
    modelName: typeof model?.name === 'string' && model.name.trim() ? model.name : '-',
    providerName: typeof model?.api_base === 'string'
      ? providerFor({ api_base: model.api_base })?.label
        ?? (model.protocol === 'fish-tts' && model.api_base === FISH_TTS_ENDPOINT ? 'Model Link' : '-')
      : '-',
  }
}

/** SQLite is authoritative; the host projection is published only after a successful COMMIT. */
export class SqliteStore {
  readonly db = new Database()
  readonly owner = 'local-owner'
  readonly vault: CredentialVault
  private queue: Promise<unknown> = Promise.resolve()
  private models: ModelRecord[] = []
  private bindings: Record<string, string> = {}
  private keys: Record<string, string> = {}
  private ttsConfig: z.infer<typeof TtsConfigSchema> | null = null
  private ttsKey = ''
  private states = new Map<string, WorkspaceState>()
  private release?: () => Promise<void>
  private closed = false
  private compromised = false
  readonly objects: ObjectStorage
  private rootDir: string
  get root(): string { return this.rootDir }
  constructor(root: string, vault?: CredentialVault, factory?: StorageFactory) {
    this.rootDir = root
    this.vault = vault ?? new LocalVault(root)
    this.objects = new ObjectStorage(this.vault, (id) => this.storageRecord(id), factory)
  }
  async init(): Promise<void> {
    const [major, minor] = process.versions.node.split('.').map(Number)
    if (major < 22 || (major === 22 && minor < 13)) throw new CanvasError('SQLite 画布要求 Node.js 22.13 或以上')
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    this.rootDir = await realpath(this.root)
    // Coordinate old releases as well as heartbeat locks. Never steal a live PID.
    const legacy = join(this.root, '.writer')
    const pid = Number(await readFile(join(legacy, 'pid'), 'utf8').catch(() => '0'))
    if (pid) {
      try { process.kill(pid, 0); throw new CanvasError('另一个画布插件正在使用这个存储目录', 409, 'STORE_LOCKED') }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
    } else if (await stat(legacy).then(() => true).catch(() => false)) throw new CanvasError('存储目录锁尚未初始化，请检查宿主进程', 409, 'STORE_LOCKED')
    try {
      this.release = await lockfile.lock(this.root, { stale: 30000, update: 5000, realpath: true, retries: 0, onCompromised: () => { this.compromised = true } })
    } catch { throw new CanvasError('另一个画布插件正在使用这个存储目录', 409, 'STORE_LOCKED') }
    try {
      await rm(legacy, { force: true, recursive: true }); await mkdir(legacy, { mode: 0o700 })
      await writeFile(join(legacy, 'pid'), String(process.pid), { mode: 0o600 })
      await mkdir(join(this.root, 'staging'), { mode: 0o700, recursive: true })
      await this.db.open(join(this.root, 'canvas.sqlite'))
      const settings = await this.db.get('SELECT * FROM owner_settings WHERE owner_id=?', [this.owner])
      if (!settings) {
        await this.db.batch([
          sql('INSERT INTO owner_settings(owner_id,active_storage_provider_id,content_hash,runtime_token,updated_at) VALUES(?,NULL,?,?,?)', [this.owner, hash({ storage: null }), this.db.token, Date.now()]),
        ])
      } else await this.db.batch([sql('UPDATE owner_settings SET runtime_token=? WHERE owner_id=?', [this.db.token, this.owner])], true, true)
      this.models = z.array(ModelRecordSchema).parse(await this.readJson('models.json', []))
      const correctedModels = this.models.map(correctSeedreamModelId)
      if (correctedModels.some((model, index) => model !== this.models[index])) {
        await atomicJson(join(this.root, 'models.json'), correctedModels)
        this.models = correctedModels
      }
      this.bindings = await this.readJson('model-bindings.json', {})
      const old = await this.readJson('credentials.json', { models: {} })
      for (const model of this.models) {
        if (!this.bindings[model.id]) this.bindings[model.id] = await this.vault.put(old.models[model.id] ?? '')
        this.keys[model.id] = await this.vault.read(this.bindings[model.id])
      }
      const tts = await this.readJson('tts-settings.json', null)
      if (tts) { this.ttsConfig = TtsConfigSchema.parse(tts); this.ttsKey = await this.vault.read(this.ttsConfig.credentialRef) }
      await atomicJson(join(this.root, 'model-bindings.json'), this.bindings)
      await this.load()
      await this.db.batch([sql('UPDATE task_details SET lease_owner=NULL,lease_until=NULL')])
    } catch (error) { await this.close(); throw error }
  }
  private async readJson(filename: string, fallback: any): Promise<any> {
    try { return JSON.parse(await readFile(join(this.root, filename), 'utf8')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback; throw error }
  }
  assertWriter(): void {
    if (this.closed || this.compromised) throw new CanvasError('存储执行锁已失效，请重启宿主', 503, 'WRITER_FENCED')
  }
  serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(() => {
      this.assertWriter()
      return operation()
    })
    this.queue = result.catch(() => {})
    return result
  }
  private async load(): Promise<void> {
    const [canvases, nodes, edges, relations, viewports, assets, tasks, details, outputs] = await this.db.batch([
      sql('SELECT * FROM canvases WHERE deleted_at IS NULL', [], 'all'), sql('SELECT * FROM canvas_nodes ORDER BY sort_order', [], 'all'),
      sql('SELECT * FROM canvas_edges ORDER BY sort_order', [], 'all'), sql('SELECT * FROM edge_node_relations', [], 'all'),
      sql('SELECT * FROM canvas_state', [], 'all'), sql('SELECT * FROM canvas_assets', [], 'all'),
      sql("SELECT * FROM task_catalog WHERE kind='generation' ORDER BY queue_seq", [], 'all'),
      sql("SELECT d.* FROM task_details d JOIN task_catalog c ON c.id=d.task_id WHERE c.kind='generation'", [], 'all'),
      sql('SELECT * FROM task_outputs ORDER BY ordinal', [], 'all'),
    ], false)
    for (const row of canvases) {
      const view = viewports.find((v: any) => v.canvas_id === row.id)
      const state: WorkspaceState = {
        version: 1, workspaceId: row.id, graphRevision: row.graph_revision, updatedAt: row.updated_at,
        graph: { version: 1, nodes: nodes.filter((v: any) => v.canvas_id === row.id).map((n: any) => ({
          id: n.id, kind: n.kind === 'audio-asset' && TtsParamsSchema.safeParse(n.params_json ? JSON.parse(n.params_json) : null).success ? 'tts-generation' : n.kind, title: n.title, position: { x: n.position_x, y: n.position_y }, modelId: n.model_id, prompt: n.prompt,
          params: n.params_json ? JSON.parse(n.params_json) : null, assetId: n.asset_id, selectedResultId: n.selected_result_id,
        })), edges: edges.filter((v: any) => v.canvas_id === row.id).map((e: any) => ({
          id: e.id, assetId: e.asset_id, source: relations.find((r: any) => r.canvas_id === row.id && r.edge_id === e.id && r.role === 'source').node_id,
          target: relations.find((r: any) => r.canvas_id === row.id && r.edge_id === e.id && r.role === 'target').node_id,
        })), viewport: { x: view?.viewport_x ?? 0, y: view?.viewport_y ?? 0, zoom: view?.viewport_zoom ?? 1 } },
        assets: assets.filter((v: any) => v.canvas_id === row.id && v.file_state === 'ready').map((a: any) => this.assetDTO(a)),
        tasks: tasks.filter((v: any) => v.canvas_id === row.id).map((c: any) => {
          const d = details.find((v: any) => v.task_id === c.id)
          return { id: c.id, workspaceId: row.id, nodeId: c.node_id, snapshot: JSON.parse(d.snapshot_json), status: statusFromDb[c.status], resultIds: outputs.filter((o: any) => o.task_id === c.id).map((o: any) => o.asset_id), createdAt: c.created_at, updatedAt: c.updated_at, ...(c.progress !== null ? { progress: c.progress } : {}), ...(d.external_task_id ? { providerTaskId: d.external_task_id } : {}), ...(d.failure_message ? { error: d.failure_message } : {}) }
        }),
      }
      this.states.set(row.id, WorkspaceStateSchema.parse(state))
    }
  }
  private assetDTO(a: any): Asset {
    return { id: a.id, kind: a.kind, filename: a.file_name ?? a.original_filename ?? a.name_snapshot, mime: a.mime, bytes: a.bytes, nodeId: a.name_source_node_id, taskId: a.task_id, createdAt: a.created_at, ...(a.width ? { width: a.width } : {}), ...(a.height ? { height: a.height } : {}), ...(a.duration !== null ? { duration: a.duration } : {}) }
  }
  state(id: string): WorkspaceState {
    return structuredClone(this.states.get(id) ?? { version: 1, workspaceId: id, graphRevision: 0, graph: emptyGraph(), assets: [], tasks: [], updatedAt: Date.now() })
  }
  allStates(): WorkspaceState[] { return [...this.states.values()].map((s) => structuredClone(s)) }
  pendingTasks(): Task[] { return this.allStates().flatMap((s) => s.tasks.filter((t) => BUSY_STATUSES.has(t.status))) }
  listModels(): PublicModel[] {
    const builtins = BUILTIN_MODELS.map((definition) => this.models.find((model) => !!builtinDefinition(model)
      && model.model_id === definition.model_id && model.api_base === definition.api_base) ?? definition)
    return [...builtins, ...this.models.filter((model) => !builtinDefinition(model))].map((model) => ({
      ...model, has_api_key: !!this.keys[model.id], api_key_mask: maskSecret(this.keys[model.id] ?? ''),
      capabilities: capabilitiesFor(model), configurable: !!builtinDefinition(model),
    }))
  }
  model(id: string) {
    const model = this.models.find((m) => m.id === id)
    if (model && isUnsupportedModelLinkH3(model))
      throw new CanvasError('Model Link 的 MiniMax H3 仅支持 MiniMax-H3，请重新选择模型', 400, 'MODEL_NOT_SUPPORTED')
    if ((!model && BUILTIN_MODELS.some((m) => m.id === id)) || (model && builtinDefinition(model) && !modelConfigured({ ...model, has_api_key: !!this.keys[id] })))
      throw new CanvasError('请前往设置页面配置模型', 400, 'MODEL_NOT_CONFIGURED')
    if (!model) throw new CanvasError('模型已删除，请重新选择', 404, 'MODEL_NOT_FOUND')
    return { model: structuredClone(model), key: this.keys[id] ?? '', credentialRef: this.bindings[id] }
  }
  ttsSettings(): PublicTtsSettings {
    return { endpoint: this.ttsConfig?.endpoint ?? FISH_TTS_ENDPOINT, revision: this.ttsConfig?.revision ?? 0, configured: !!this.ttsConfig, has_api_key: !!this.ttsKey, api_key_mask: maskSecret(this.ttsKey) }
  }
  /** Explicit owner action reads only the current setting, never arbitrary Vault refs or task snapshots. */
  async settingSecret(input: SettingSecretRequest): Promise<string> {
    input = SettingSecretRequestSchema.parse(input)
    return this.serial(async () => {
      let value: string | undefined
      if (input.scope === 'model') {
        const model = this.models.find((model) => model.id === input.id)
        if (!model || !builtinDefinition(model)) throw new CanvasError('模型配置不存在', 404, 'MODEL_NOT_FOUND')
        value = this.keys[model.id]
      } else if (input.scope === 'tts') value = this.ttsKey
      else if (input.scope === 'storage') {
        const record = await this.storageRecord(input.id)
        try {
          const credentials = JSON.parse(await this.vault.read(record.readCredentialRef ?? record.credentialRef)) as Partial<StorageCredentials>
          value = credentials[input.field]
        } catch { throw new CanvasError('对象存储凭据不可用', 409, 'STORAGE_CREDENTIALS_MISSING') }
      } else throw new CanvasError('预审凭据由独立配置服务读取')
      if (!value) throw new CanvasError('该配置尚未保存凭据', 404, 'SETTING_SECRET_NOT_FOUND')
      return value
    })
  }
  /** Called inside the same serial section that accepts the immutable task. */
  ttsService(): { model: TtsTaskSnapshot['model']; credentialRef: string } {
    if (!this.ttsConfig || !this.ttsKey) throw new CanvasError('请先在设置中配置 FishTTS 服务的 API Key', 400, 'TTS_NOT_CONFIGURED')
    const { id, endpoint, credentialRef } = this.ttsConfig
    return { model: { id, kind: 'audio', name: 'FishTTS', model_id: 'fish-tts', protocol: 'fish-tts', api_base: endpoint }, credentialRef }
  }
  async saveTtsSettings(input: TtsSettingsInput): Promise<PublicTtsSettings> {
    input = TtsSettingsInputSchema.parse(input)
    if (input.endpoint !== FISH_TTS_ENDPOINT) throw new CanvasError('FishTTS 仅支持固定 Model Link 渠道', 400, 'MODEL_NOT_SUPPORTED')
    return this.serial(async () => {
      if (input.revision !== (this.ttsConfig?.revision ?? 0)) throw new CanvasError('语音服务配置已更新，请重新打开设置', 409, 'SETTINGS_CONFLICT')
      const credentialRef = input.api_key !== undefined || !this.ttsConfig ? await this.vault.put(input.api_key?.trim() ?? '') : this.ttsConfig.credentialRef
      const key = await this.vault.read(credentialRef)
      const next = { endpoint: input.endpoint, revision: input.revision + 1, id: this.ttsConfig?.id ?? randomUUID(), credentialRef }
      await atomicJson(join(this.root, 'tts-settings.json'), next)
      this.ttsConfig = next; this.ttsKey = key
      return this.ttsSettings()
    })
  }
  async saveModel(input: ModelInput): Promise<PublicModel[]> {
    return this.serial(async () => {
      if (isUnsupportedModelLinkH3(input))
        throw new CanvasError('Model Link 的 MiniMax H3 仅支持 MiniMax-H3', 400, 'MODEL_NOT_SUPPORTED')
      const definition = builtinDefinition(input)
      const existing = input.id ? this.models.find((m) => m.id === input.id) : undefined
      const legacyKeyEdit = existing && !builtinDefinition(existing) && ['kind', 'name', 'model_id', 'api_base', 'protocol'].every((key) => input[key as keyof ModelInput] === existing[key as keyof ModelRecord])
      if (!definition && !legacyKeyEdit) throw new CanvasError('只能配置内置模型和供应商，不能自定义 API Base', 400, 'MODEL_NOT_SUPPORTED')
      if (definition && input.name !== definition.name) throw new CanvasError('内置模型名称不能修改', 400, 'MODEL_NOT_SUPPORTED')
      if (existing && definition && !builtinDefinition(existing)) throw new CanvasError('不能改变已有配置的模型或供应商', 409, 'MODEL_IDENTITY_CONFLICT')
      if (existing && definition && (existing.model_id !== definition.model_id || existing.api_base !== definition.api_base)) throw new CanvasError('不能改变已有配置的模型或供应商', 409, 'MODEL_IDENTITY_CONFLICT')
      const duplicate = definition && this.models.find((m) => m.model_id === definition.model_id && m.api_base === definition.api_base)
      const id = existing?.id ?? (duplicate ? duplicate.id : definition!.id)
      if (definition && input.id && input.id !== id) throw new CanvasError('模型配置身份不一致', 409, 'MODEL_IDENTITY_CONFLICT')
      const { api_key, ...fields } = input
      const previous = this.models.find((m) => m.id === id)
      const record = ModelRecordSchema.parse({ ...fields, id, ...(fields.endpoint_id === undefined && previous?.endpoint_id ? { endpoint_id: previous.endpoint_id } : {}) })
      const needsEndpoint = modelRequiresEndpoint(record)
      if (record.endpoint_id && !needsEndpoint) throw new CanvasError('此供应商使用 Model ID，无需配置 EP', 400, 'MODEL_NOT_SUPPORTED')
      if (needsEndpoint && (api_key !== undefined ? !!api_key.trim() : !!this.keys[id]) && !record.endpoint_id)
        throw new CanvasError('请配置所选模型供应商的 EP', 400, 'MODEL_NOT_CONFIGURED')
      if (this.models.find((m) => m.id === id)?.kind && this.models.find((m) => m.id === id)!.kind !== record.kind) throw new CanvasError('编辑时不能改变模型类型')
      const bindings = { ...this.bindings }
      if (api_key !== undefined || !bindings[id]) bindings[id] = await this.vault.put(api_key?.trim() ?? '')
      await atomicJson(join(this.root, 'model-bindings.json'), bindings)
      const models = this.models.filter((m) => m.id !== id).concat(record)
      await atomicJson(join(this.root, 'models.json'), models)
      this.models = models; this.bindings = bindings; this.keys[id] = await this.vault.read(bindings[id])
      return this.listModels()
    })
  }
  async deleteModel(id: string): Promise<PublicModel[]> {
    return this.serial(async () => {
      const busy = await this.db.get("SELECT c.id FROM task_catalog c JOIN task_details d ON d.task_id=c.id WHERE c.status IN ('queued','running','external_wait','saving','needs_attention','save_failed') AND json_extract(d.snapshot_json,'$.model.id')=? LIMIT 1", [id])
      if (busy) throw new CanvasError('这个模型还有未结束任务', 409, 'MODEL_IN_USE')
      const models = this.models.filter((m) => m.id !== id)
      await atomicJson(join(this.root, 'models.json'), models); this.models = models
      delete this.keys[id]
      return this.listModels()
    })
  }
  async ensureCanvas(id: string, name = id): Promise<void> {
    if (await this.db.get('SELECT id FROM canvases WHERE id=?', [id])) return
    const now = Date.now(); const location = randomUUID()
    const root = await this.requireStorage()
    const directory = await this.directoryName(root, name, id)
    await this.db.batch([
      sql('INSERT INTO canvases(id,owner_id,name,target_storage_id,content_hash,commit_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', [id, this.owner, NameSchema.parse(name), location, hash({ name, folderId: null }), hash({ revision: 0 }), now, now]),
      sql('INSERT INTO canvas_storage_locations VALUES(?,?,?,?,?,?)', [id, location, root, directory, pathKey(directory), now]),
      sql('INSERT INTO canvas_state(canvas_id,viewport_x,viewport_y,viewport_zoom,content_hash,updated_at) VALUES(?,0,0,1,?,?)', [id, hash(emptyGraph().viewport), now]),
    ])
    this.states.set(id, this.state(id))
  }
  private async directoryName(root: string, name: string, id: string, folderId?: string | null, folderName?: string): Promise<string> {
    const provider = await this.storageRecord(root)
    const folder = folderId ? folderName ?? (await this.db.get('SELECT name FROM folders WHERE id=?', [folderId]))?.name : null
    return `${provider.prefix}/${folder ? `${safeName(folder)}__${folderId}` : '未归档'}/${safeName(name)}__${id}`
  }
  async requireStorage(): Promise<string> {
    const row = await this.db.get('SELECT active_storage_provider_id FROM owner_settings WHERE owner_id=?', [this.owner])
    if (!row?.active_storage_provider_id) throw new CanvasError(STORAGE_REQUIRED, 409, 'STORAGE_NOT_CONFIGURED')
    return row.active_storage_provider_id
  }
  async storageRecord(id: string): Promise<StorageRecord> {
    const row = await this.db.get('SELECT config_json,credential_ref,read_credential_ref FROM storage_providers WHERE id=? AND owner_id=?', [id, this.owner])
    if (!row) throw new CanvasError('对象存储配置不存在', 404, 'STORAGE_NOT_FOUND')
    return { ...JSON.parse(row.config_json), credentialRef: row.credential_ref, readCredentialRef: row.read_credential_ref }
  }
  /** Allocate under the active provider at acceptance, then pin this location for the task. */
  async currentStorageTarget(canvas: string, providerId?: string): Promise<string> {
    const root = providerId ?? await this.requireStorage()
    const row = await this.db.get('SELECT * FROM canvases WHERE id=? AND owner_id=?', [canvas, this.owner])
    const directory = await this.directoryName(root, row.name, canvas, row.folder_id)
    const existing = await this.db.get('SELECT id FROM canvas_storage_locations WHERE canvas_id=? AND root_id=? AND relative_dir=?', [canvas, root, directory])
    if (existing) return existing.id
    const id = randomUUID()
    await this.db.batch([sql('INSERT INTO canvas_storage_locations VALUES(?,?,?,?,?,?)', [canvas, id, root, directory, pathKey(directory), Date.now()])])
    return id
  }
  update<T>(id: string, mutate: (state: WorkspaceState) => T | Promise<T>, extra?: (before: WorkspaceState, after: WorkspaceState) => Statement[], beforeCommit?: () => void): Promise<T> {
    return this.serial(async () => {
      await this.ensureCanvas(id)
      const before = this.state(id); const draft = structuredClone(before)
      const result = await mutate(draft); draft.updatedAt = Date.now()
      draft.graphRevision = hash(before.graph) === hash(draft.graph) ? before.graphRevision : before.graphRevision + 1
      WorkspaceStateSchema.parse(draft)
      await this.persist(before, draft, extra?.(before, draft) ?? [], beforeCommit)
      this.states.set(id, draft)
      return result
    })
  }
  private async persist(before: WorkspaceState, after: WorkspaceState, extra: Statement[] = [], beforeCommit?: () => void): Promise<void> {
    const id = after.workspaceId; const now = after.updatedAt; const steps: Statement[] = []
    const previousNodes = new Map(before.graph.nodes.map((n, i) => [n.id, { n, i }]))
    const previousEdges = new Map(before.graph.edges.map((e, i) => [e.id, { e, i }]))
    for (const edge of before.graph.edges) if (!after.graph.edges.some((e) => e.id === edge.id)) steps.push(sql('DELETE FROM canvas_edges WHERE canvas_id=? AND id=?', [id, edge.id]))
    for (const n of before.graph.nodes) if (!after.graph.nodes.some((v) => v.id === n.id)) steps.push(sql('DELETE FROM canvas_nodes WHERE canvas_id=? AND id=?', [id, n.id]))
    for (const [i, n] of after.graph.nodes.entries()) {
      const previous = previousNodes.get(n.id)
      if (previous && hash(previous.n) === hash(n) && previous.i === i) continue
      steps.push(sql(`INSERT INTO canvas_nodes(canvas_id,id,kind,title,position_x,position_y,model_id,prompt,params_json,asset_id,selected_result_id,sort_order,content_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(canvas_id,id) DO UPDATE SET name_revision=name_revision+(title!=excluded.title),kind=excluded.kind,title=excluded.title,position_x=excluded.position_x,position_y=excluded.position_y,model_id=excluded.model_id,prompt=excluded.prompt,params_json=excluded.params_json,asset_id=excluded.asset_id,selected_result_id=excluded.selected_result_id,sort_order=excluded.sort_order,row_version=row_version+1,content_hash=excluded.content_hash,updated_at=excluded.updated_at`,
      [id, n.id, n.kind === 'tts-generation' ? 'audio-asset' : n.kind, n.title, n.position.x, n.position.y, n.modelId, n.prompt, n.params ? JSON.stringify(n.params) : null, n.assetId, n.selectedResultId, i, hash(n), now, now]))
    }
    for (const [i, e] of after.graph.edges.entries()) {
      const previous = previousEdges.get(e.id)
      if (previous && hash(previous.e) === hash(e) && previous.i === i) continue
      steps.push(sql('INSERT INTO canvas_edges(canvas_id,id,asset_id,sort_order,content_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(canvas_id,id) DO UPDATE SET asset_id=excluded.asset_id,sort_order=excluded.sort_order,content_hash=excluded.content_hash,row_version=row_version+1,updated_at=excluded.updated_at', [id, e.id, e.assetId, i, hash(e), now, now]))
      for (const role of ['source', 'target'] as const) steps.push(sql('INSERT INTO edge_node_relations(canvas_id,edge_id,role,node_id,content_hash) VALUES(?,?,?,?,?) ON CONFLICT(canvas_id,edge_id,role) DO UPDATE SET node_id=excluded.node_id,content_hash=excluded.content_hash', [id, e.id, role, e[role], hash({ role, nodeId: e[role] })]))
    }
    if (hash(before.graph.viewport) !== hash(after.graph.viewport)) steps.push(sql('UPDATE canvas_state SET viewport_x=?,viewport_y=?,viewport_zoom=?,content_hash=?,row_version=row_version+1,updated_at=? WHERE canvas_id=?', [after.graph.viewport.x, after.graph.viewport.y, after.graph.viewport.zoom, hash(after.graph.viewport), now, id]))
    const oldTasks = new Map(before.tasks.map((t) => [t.id, t]))
    for (const task of after.tasks) {
      const old = oldTasks.get(task.id)
      if (old && hash(old) === hash(task)) continue
      const terminal = ['completed', 'failed', 'abandoned'].includes(task.status)
      if (!old) {
        const ref = isMockModel(task.snapshot.model) ? null : this.bindings[task.snapshot.model.id] ?? null
        steps.push(sql('INSERT INTO task_catalog(id,canvas_id,node_id,kind,title,queue_seq,status,progress,created_at,updated_at,finished_at) VALUES(?,?,?,\'generation\',?,(SELECT COALESCE(MAX(queue_seq),0)+1 FROM task_catalog),?,?,?,?,?)', [task.id, id, task.nodeId, after.graph.nodes.find((n) => n.id === task.nodeId)?.title ?? '历史任务', statusToDb[task.status], task.progress ?? null, task.createdAt, now, terminal ? now : null]))
        steps.push(sql('INSERT INTO task_details(task_id,request_id,request_hash,snapshot_json,credential_ref,phase,external_task_id,updated_at) VALUES(?,?,?,?,?,?,?,?)', [task.id, task.id, hash(task.snapshot), JSON.stringify(task.snapshot), ref, 'submit', task.providerTaskId ?? null, now]))
        const storage = await this.currentStorageTarget(id)
        steps.push(sql('INSERT INTO storage_targets VALUES(?,?,?)', [task.id, id, storage]))
        for (const [i, assetId] of task.snapshot.referenceIds.entries()) {
          const locator = await this.locator(id, assetId)
          const record = await this.storageRecord(locator.providerId)
          locator.credentialRef = record.readCredentialRef ?? record.credentialRef
          steps.push(sql('INSERT INTO task_references VALUES(?,?,?,?,?,?)', [task.id, i, id, assetId, locator.sha256, JSON.stringify(locator)]))
        }
      } else steps.push(sql('UPDATE task_catalog SET status=?,progress=?,updated_at=?,finished_at=? WHERE id=?', [statusToDb[task.status], task.progress ?? null, now, terminal ? now : null, task.id]))
      steps.push(sql(`UPDATE task_details SET external_task_id=?,phase=CASE WHEN ?='completed' THEN 'completed' WHEN ?='saving' THEN 'publish' ELSE phase END,success_at=CASE WHEN ?='completed' THEN ? ELSE success_at END,
        external_completed_at=CASE WHEN ?='saving' THEN COALESCE(external_completed_at,?) ELSE external_completed_at END,
        failure_message=COALESCE(?,failure_message),updated_at=? WHERE task_id=?`,
      [task.providerTaskId ?? null, task.status, task.status, task.status, now, isMockModel(task.snapshot.model) ? '' : task.status, now, task.error ?? null, now, task.id]))
      for (const [i, assetId] of task.resultIds.entries()) steps.push(sql('INSERT OR IGNORE INTO task_outputs VALUES(?,?,?,?)', [task.id, i, id, assetId]))
    }
    const changed = hash(before.graph) !== hash(after.graph)
    const previousCommit = (await this.db.get('SELECT commit_hash FROM canvases WHERE id=?', [id])).commit_hash
    const changes = {
      nodes: after.graph.nodes.filter((n) => hash(previousNodes.get(n.id)?.n ?? null) !== hash(n)).map((value) => ({ value, hash: hash(value) })),
      edges: after.graph.edges.filter((e) => hash(previousEdges.get(e.id)?.e ?? null) !== hash(e)).map((value) => ({ value, hash: hash(value) })),
      deleteNodes: before.graph.nodes.filter((n) => !after.graph.nodes.some((v) => v.id === n.id)).map((n) => n.id),
      deleteEdges: before.graph.edges.filter((e) => !after.graph.edges.some((v) => v.id === e.id)).map((e) => e.id),
      ...(hash(before.graph.viewport) !== hash(after.graph.viewport) ? { viewport: { value: after.graph.viewport, hash: hash(after.graph.viewport) } } : {}),
    }
    const commit = changed ? hash({ prevCommitHash: previousCommit, revision: after.graphRevision, changes }) : previousCommit
    const userReceipt = extra.find((s) => s.sql.startsWith('INSERT INTO canvas_mutations'))
    if (changed || userReceipt) steps.push(sql('INSERT INTO canvas_mutations VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      [id, userReceipt?.params?.[1] ?? randomUUID(), userReceipt ? 'user' : 'host', userReceipt?.params?.[3] ?? hash(changes),
        before.graphRevision, after.graphRevision, Number(changed), previousCommit, commit, JSON.stringify(changes), now]))
    steps.push(sql('UPDATE canvases SET graph_revision=?,updated_at=?,commit_hash=? WHERE id=? AND graph_revision=?', [after.graphRevision, now, commit, id, before.graphRevision], 'run', 1))
    // Names change immediately; locators continue pointing at verified immutable objects.
    const renamed = after.graph.nodes.filter((n) => previousNodes.has(n.id) && previousNodes.get(n.id)!.n.title !== n.title)
    if (renamed.length) {
      steps.push(sql('UPDATE canvases SET layout_revision=layout_revision+1 WHERE id=?', [id]))
      steps.push(...await this.moveStatements(id, renamed.map((n) => n.id), undefined, after, 1))
    }
    steps.push(...extra.filter((s) => s !== userReceipt))
    beforeCommit?.()
    await this.db.batch(steps)
  }
  async snapshot(id: string): Promise<CanvasSnapshot> {
    return this.serial(async () => {
      const state = this.state(id)
      const row = await this.db.get('SELECT commit_hash FROM canvases WHERE id=? AND deleted_at IS NULL', [id])
      if (!row) throw new CanvasError('画布不存在', 404)
      const imports = await this.db.all("SELECT * FROM task_catalog WHERE canvas_id=? AND kind='import' ORDER BY queue_seq", [id])
      const requests = await this.db.all('SELECT d.task_id,d.request_id FROM task_details d JOIN task_catalog c ON c.id=d.task_id WHERE c.canvas_id=?', [id])
      const requestIds = new Map<string, string>(requests.map((item) => [item.task_id, item.request_id]))
      const tasks: TaskSummary[] = state.tasks.map(({ snapshot: _s, error: _e, providerTaskId: _p, ...summary }) =>
        ({ ...summary, requestId: requestIds.get(summary.id) }))
      for (const item of imports) tasks.push({ id: item.id, nodeId: item.node_id, workspaceId: id, status: statusFromDb[item.status], progress: item.progress ?? undefined, resultIds: [], createdAt: item.created_at, updatedAt: item.updated_at })
      tasks.sort((a, b) => a.createdAt - b.createdAt)
      return { ...state, tasks, commitHash: row.commit_hash,
        hashes: { nodes: Object.fromEntries(state.graph.nodes.map((n) => [n.id, hash(n)])), edges: Object.fromEntries(state.graph.edges.map((e) => [e.id, hash(e)])), viewport: hash(state.graph.viewport) } }
    })
  }
  async graphChanges(id: string, afterRevision: number) {
    return this.serial(async () => {
      const [canvas, changes] = await this.db.batch([
        sql('SELECT graph_revision,commit_hash,min_replay_revision FROM canvases WHERE id=? AND deleted_at IS NULL', [id], 'get'),
        sql('SELECT mutation_id AS id,actor,base_revision AS baseRevision,committed_revision AS revision,prev_commit_hash AS prevCommitHash,commit_hash AS commitHash,changes_json FROM canvas_mutations WHERE canvas_id=? AND committed_revision>? AND has_changes=1 ORDER BY committed_revision LIMIT 100', [id, afterRevision], 'all'),
      ], false)
      if (!canvas) throw new CanvasError('画布不存在', 404)
      if (afterRevision < canvas.min_replay_revision || afterRevision > canvas.graph_revision) throw new CanvasError('增量基线不可用，请读取完整画布', 409, 'SNAPSHOT_REQUIRED')
      return { graphRevision: canvas.graph_revision, commitHash: canvas.commit_hash,
        changes: changes.map(({ changes_json, ...receipt }: any) => ({ ...receipt, changes: JSON.parse(changes_json) })),
        nextRevision: changes.at(-1)?.revision ?? afterRevision, hasMore: changes.length > 0 && changes.at(-1).revision < canvas.graph_revision }
    })
  }
  async taskPrivate(id: string): Promise<TaskPrivate> {
    const row = await this.db.get('SELECT * FROM task_details WHERE task_id=?', [id])
    const mock = row && isMockModel(JSON.parse(row.snapshot_json).model)
    if (!row || (!row.credential_ref && !mock)) throw new CanvasError('任务凭据不可用', 409, 'TASK_CREDENTIALS_MISSING')
    return { key: mock ? '' : await this.vault.read(row.credential_ref), issued: !!row.submit_issued, ...(row.outputs_json ? { outputs: JSON.parse(row.outputs_json) } : {}) }
  }
  async writeTaskPrivate(id: string, data: TaskPrivate): Promise<void> {
    const row = await this.db.get('SELECT credential_ref,snapshot_json FROM task_details WHERE task_id=?', [id])
    if (!row) throw new CanvasError('任务不存在', 404)
    const ref = isMockModel(JSON.parse(row.snapshot_json).model) ? null : row.credential_ref ?? await this.vault.put(data.key)
    const outputs = data.outputs ? await Promise.all(data.outputs.map(async (output) => {
      if (!output.base64) return output
      const stage = join(this.root, 'staging', `${output.id}.raw`)
      if (!(await stat(stage).then(() => true).catch(() => false))) await receive(Readable.from([Buffer.from(output.base64, 'base64')]), stage, Number.MAX_SAFE_INTEGER, 'image')
      const { base64: _b, ...descriptor } = output
      return { ...descriptor, stageFile: `${output.id}.raw` }
    })) : undefined
    await this.db.batch([sql('UPDATE task_details SET credential_ref=?,submit_issued=?,outputs_json=?,updated_at=? WHERE task_id=?', [ref, Number(data.issued), outputs ? JSON.stringify(outputs) : null, Date.now(), id])])
  }
  async removeTaskPrivate(id: string): Promise<void> {
    const row = await this.db.get('SELECT outputs_json FROM task_details WHERE task_id=?', [id])
    for (const output of row?.outputs_json ? JSON.parse(row.outputs_json) : []) {
      if (output.stageFile) await rm(this.stagePath(output.stageFile), { force: true })
      await rm(this.stagePath(`${output.id}.media`), { force: true })
    }
    await this.db.batch([sql('UPDATE task_details SET outputs_json=NULL WHERE task_id=?', [id])])
  }
  async verifyReferences(taskId: string): Promise<void> {
    for (const reference of await this.db.all('SELECT locator_json FROM task_references WHERE task_id=? ORDER BY ordinal', [taskId]))
      await this.objects.verify(JSON.parse(reference.locator_json))
  }
  async publishedAsset(canvas: string, id: string): Promise<Asset | null> {
    const row = await this.db.get("SELECT * FROM canvas_assets WHERE canvas_id=? AND id=? AND file_state='ready'", [canvas, id])
    if (!row) return null
    await this.objects.verify(await this.locator(canvas, id))
    return this.assetDTO(row)
  }
  async locator(canvas: string, id: string, variant: MediaVariant = 'original'): Promise<ObjectLocator> {
    if (variant !== 'original') {
      const row = await this.db.get('SELECT locator_json FROM asset_variants WHERE canvas_id=? AND asset_id=? AND variant=?', [canvas, id, variant])
      if (!row) throw new CanvasError('派生资源暂不可用', 404, 'VARIANT_UNAVAILABLE')
      return JSON.parse(row.locator_json)
    }
    const row = await this.db.get("SELECT a.*,l.root_id FROM canvas_assets a JOIN canvas_storage_locations l ON l.canvas_id=a.canvas_id AND l.id=a.storage_id WHERE a.canvas_id=? AND a.id=? AND a.file_state='ready'", [canvas, id])
    if (!row) throw new CanvasError('媒体文件不可用', 404, 'MEDIA_MISSING')
    return { providerId: row.root_id, objectKey: row.object_key, bytes: row.bytes, mime: row.mime, sha256: row.file_hash,
      ...(row.etag ? { etag: row.etag } : {}), ...(row.version_id ? { versionId: row.version_id } : {}) }
  }
  async readMedia(id: string, limit: number, taskId?: string): Promise<Buffer> {
    const reference = taskId ? await this.db.get('SELECT locator_json FROM task_references WHERE task_id=? AND asset_id=?', [taskId, id]) : null
    if (taskId && !reference) throw new CanvasError('任务参考素材不存在', 404)
    const canvas = !reference ? await this.db.get('SELECT canvas_id FROM canvas_assets WHERE id=?', [id]) : null
    const locator = reference ? JSON.parse(reference.locator_json) : await this.locator(canvas?.canvas_id, id)
    return this.objects.read(locator, limit)
  }
  async modelReferenceUrl(taskId: string, assetId: string): Promise<string> {
    const row = await this.db.get('SELECT locator_json FROM task_references WHERE task_id=? AND asset_id=?', [taskId, assetId])
    if (!row) throw new CanvasError('任务参考素材不存在', 404)
    const locator = JSON.parse(row.locator_json)
    await this.objects.verify(locator)
    return (await this.objects.sign(locator, { method: 'GET', ttl: 86400 }, true)).url
  }
  async inspectReference(taskId: string, assetId: string, signal: AbortSignal, protocol = 'seedance-video'): Promise<Asset> {
    const row = await this.db.get('SELECT canvas_id,locator_json FROM task_references WHERE task_id=? AND asset_id=?', [taskId, assetId])
    if (!row) throw new CanvasError('任务参考素材不存在', 404)
    const locator: ObjectLocator = JSON.parse(row.locator_json)
    const asset = this.state(row.canvas_id).assets.find((asset) => asset.id === assetId)
    if (!asset) throw new CanvasError('任务参考素材不存在', 404)
    const source = await (await this.objects.adapter(locator.providerId, locator.credentialRef)).openRead(locator)
    return inspectSeedanceReference(source, { ...asset, bytes: locator.bytes, mime: locator.mime }, locator.sha256, signal, protocol)
  }
  async mediaHash(canvas: string, id: string): Promise<string> {
    const row = await this.db.get("SELECT file_hash FROM canvas_assets WHERE canvas_id=? AND id=? AND file_state='ready'", [canvas, id])
    if (!row) throw new CanvasError('媒体文件不可用', 404, 'MEDIA_MISSING')
    return row.file_hash
  }
  stagePath(name: string): string {
    if (!/^[a-f0-9-]+\.(raw|media|upload|resume\.json)$/.test(name)) throw new CanvasError('无效暂存文件引用')
    return join(this.root, 'staging', name)
  }
  async actualPath(canvas: string, storage: string, filename: string): Promise<string> {
    const row = await this.db.get('SELECT relative_dir FROM canvas_storage_locations WHERE canvas_id=? AND id=?', [canvas, storage])
    if (!row) throw new CanvasError('媒体存储位置不存在', 404)
    return `${row.relative_dir}/${filename}`
  }
  async saveMedia(source: Readable, metadata: Omit<Asset, 'bytes' | 'mime'>, limit: number, expected: MediaKind, signal?: AbortSignal): Promise<Asset> {
    const state = this.allStates().find((s) => (metadata.nodeId && s.graph.nodes.some((n) => n.id === metadata.nodeId)) || (metadata.taskId && s.tasks.some((t) => t.id === metadata.taskId)))
    const canvas = state?.workspaceId
    if (!canvas) throw new CanvasError('素材必须属于画布')
    const stage = join(this.root, 'staging', `${metadata.id}.media`)
    const manifest = await this.db.get('SELECT * FROM canvas_assets WHERE canvas_id=? AND id=?', [canvas, metadata.id])
    if (manifest) {
      source.destroy()
      return this.publish(canvas, metadata, stage, { bytes: manifest.bytes, mime: manifest.mime, fileHash: manifest.file_hash }, signal)
    }
    await rm(stage, { force: true })
    const info = await receive(source, stage, limit, expected, signal)
    return this.publish(canvas, metadata, stage, info, signal)
  }
  async publish(canvas: string, metadata: Omit<Asset, 'bytes' | 'mime'>, stage: string, info: { bytes: number; mime: string; fileHash: string; width?: number; height?: number }, signal?: AbortSignal): Promise<Asset> {
    // SQL reserves identity; cloud I/O must never hold the Store serialization queue.
    const manifest = await this.serial(async () => {
      const previous = await this.db.get('SELECT * FROM canvas_assets WHERE canvas_id=? AND id=?', [canvas, metadata.id])
      if (previous) return previous
      const pinned = metadata.taskId ? await this.db.get('SELECT storage_id FROM storage_targets WHERE task_id=? AND canvas_id=?', [metadata.taskId, canvas]) : null
      const storage = pinned?.storage_id ?? await this.currentStorageTarget(canvas)
      const node = this.state(canvas).graph.nodes.find((n) => n.id === metadata.nodeId)
      const title = node?.title ?? safeName(metadata.filename.replace(/\.[^.]+$/, ''))
      const name = `${safeName(title)}__${metadata.id}${extension(info.mime)}`
      const key = await this.actualPath(canvas, storage, name)
      await this.db.batch([sql(`INSERT INTO canvas_assets(canvas_id,id,kind,origin_kind,original_filename,name_source_node_id,name_snapshot,storage_id,file_name,file_name_key,object_key,mime,bytes,file_hash,file_state,width,height,duration,row_version,content_hash,created_at,updated_at,task_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'staging',?,?,?,0,?,?,?,?)`,
      [canvas, metadata.id, metadata.kind, metadata.taskId ? 'generated' : 'uploaded', metadata.filename, metadata.nodeId, title, storage, name, pathKey(name), key, info.mime, info.bytes, info.fileHash, info.width ?? metadata.width ?? null, info.height ?? metadata.height ?? null, metadata.duration ?? null, hash({ ...metadata, ...info }), metadata.createdAt, Date.now(), metadata.taskId])])
      return this.db.get('SELECT * FROM canvas_assets WHERE canvas_id=? AND id=?', [canvas, metadata.id])
    })
    const location = await this.db.get('SELECT root_id FROM canvas_storage_locations WHERE canvas_id=? AND id=?', [canvas, manifest.storage_id])
    const locator: ObjectLocator = { providerId: location.root_id, objectKey: manifest.object_key, bytes: manifest.bytes, mime: manifest.mime, sha256: manifest.file_hash,
      credentialRef: (await this.storageRecord(location.root_id)).credentialRef }
    signal?.throwIfAborted()
    const receipt = await this.objects.publish(locator, stage)
    signal?.throwIfAborted()
    await this.serial(async () => {
      await this.db.batch([sql("UPDATE canvas_assets SET file_state='ready',etag=?,version_id=?,updated_at=? WHERE canvas_id=? AND id=? AND file_hash=?", [receipt.etag, receipt.versionId ?? null, Date.now(), canvas, metadata.id, info.fileHash], 'run', 1)])
    })
    // Keep stage until caller commits its output/node relation. Derived files are independent.
    return this.assetDTO({ ...manifest, file_state: 'ready' })
  }
  redact(message: string, extraKeys: string[] = []): string {
    let result = message
    for (const key of [...Object.values(this.keys), this.ttsKey, ...extraKeys]) if (key) result = result.split(key).join('[已脱敏]')
    return result.replace(/Bearer\s+\S+/gi, 'Bearer [已脱敏]').replace(/https?:\/\/\S+/gi, '[服务地址]').slice(0, 1000)
  }
  async catalog(): Promise<Catalog> {
    const [folders, canvases] = await this.db.batch([
      sql('SELECT id,name,meta_revision AS revision,content_hash AS hash FROM folders WHERE owner_id=? ORDER BY name', [this.owner], 'all'),
      sql(`SELECT c.id,c.name,c.folder_id AS folderId,c.meta_revision AS revision,c.content_hash AS hash,
        EXISTS(SELECT 1 FROM file_operations f WHERE f.canvas_id=c.id AND f.state IN ('pending','running')) AS moving,
        (SELECT error FROM file_operations f WHERE f.canvas_id=c.id AND f.state='failed' ORDER BY updated_at DESC LIMIT 1) AS moveError
        FROM canvases c WHERE owner_id=? AND deleted_at IS NULL ORDER BY c.created_at`, [this.owner], 'all'),
    ], false)
    return { folders, canvases }
  }
  async catalogCommand(input: { requestId: string; operation: string; id?: string; name?: string; folderId?: string | null; revision?: number }, beforeCommit?: () => void): Promise<{ id: string }> {
    return this.serial(async () => {
      const requestHash = hash(input)
      const receipt = await this.db.get('SELECT * FROM catalog_mutations WHERE owner_id=? AND request_id=?', [this.owner, input.requestId])
      if (receipt) {
        if (receipt.request_hash !== requestHash) throw new CanvasError('请求 ID 已用于其他内容', 409, 'REQUEST_REUSED')
        return JSON.parse(receipt.result_json)
      }
      const id = input.id ?? randomUUID(); const now = Date.now()
      const steps: Statement[] = []
      const folderOperation = input.operation.startsWith('folder-')
      const entity = folderOperation ? 'folders' : 'canvases'
      const row = input.id ? await this.db.get(`SELECT * FROM ${entity} WHERE id=? AND owner_id=?`, [id, this.owner]) : null
      if (input.id && !row) throw new CanvasError('目录对象不存在', 404)
      if (row && input.revision !== row.meta_revision) throw new CanvasError('目录已更新，请重新载入', 409, 'CATALOG_CONFLICT')
      const name = input.name === undefined ? row?.name : NameSchema.parse(input.name)
      if (input.folderId && !(await this.db.get('SELECT id FROM folders WHERE owner_id=? AND id=?', [this.owner, input.folderId]))) throw new CanvasError('文件夹不存在', 404)
      if (input.operation === 'folder-create') {
        steps.push(sql('INSERT INTO folders VALUES(?,?,?,0,?,?,?)', [id, this.owner, NameSchema.parse(name), hash({ name }), now, now]))
      } else if (input.operation === 'folder-rename') {
        steps.push(sql('UPDATE folders SET name=?,meta_revision=meta_revision+1,content_hash=?,updated_at=? WHERE id=? AND meta_revision=?', [name, hash({ name }), now, id, input.revision!], 'run', 1))
        for (const canvas of await this.db.all('SELECT * FROM canvases WHERE folder_id=? AND deleted_at IS NULL', [id])) {
          steps.push(...await this.relayout(canvas, canvas.name, id, name))
        }
      } else if (input.operation === 'folder-delete') {
        if (await this.db.get('SELECT id FROM canvases WHERE folder_id=? AND deleted_at IS NULL LIMIT 1', [id])) throw new CanvasError('请先移出文件夹内的画布', 409, 'FOLDER_NOT_EMPTY')
        steps.push(sql('UPDATE canvases SET folder_id=NULL WHERE folder_id=? AND deleted_at IS NOT NULL', [id]))
        steps.push(sql('DELETE FROM folders WHERE id=? AND meta_revision=?', [id, input.revision!], 'run', 1))
      } else if (input.operation === 'canvas-create') {
        const root = await this.requireStorage()
        const location = randomUUID(); const dir = await this.directoryName(root, NameSchema.parse(name), id, input.folderId)
        steps.push(sql('INSERT INTO canvases(id,owner_id,folder_id,name,target_storage_id,content_hash,commit_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', [id, this.owner, input.folderId ?? null, name, location, hash({ name, folderId: input.folderId ?? null }), hash({ revision: 0 }), now, now]),
          sql('INSERT INTO canvas_storage_locations VALUES(?,?,?,?,?,?)', [id, location, root, dir, pathKey(dir), now]),
          sql('INSERT INTO canvas_state(canvas_id,viewport_x,viewport_y,viewport_zoom,content_hash,updated_at) VALUES(?,0,0,1,?,?)', [id, hash(emptyGraph().viewport), now]))
      } else if (input.operation === 'canvas-rename' || input.operation === 'canvas-move') {
        const folder = input.operation === 'canvas-move' ? input.folderId ?? null : row.folder_id
        steps.push(sql('UPDATE canvases SET name=?,folder_id=?,meta_revision=meta_revision+1,content_hash=?,updated_at=? WHERE id=? AND meta_revision=?', [name, folder, hash({ name, folderId: folder }), now, id, input.revision!], 'run', 1))
        steps.push(...await this.relayout(row, name, folder))
      } else if (input.operation === 'canvas-delete') {
        if (await this.hasUnfinished(id)) throw new CanvasError('画布仍有未完成任务或上传', 409, 'CANVAS_BUSY')
        steps.push(sql('UPDATE canvases SET deleted_at=?,meta_revision=meta_revision+1 WHERE id=? AND meta_revision=?', [now, id, input.revision!], 'run', 1))
      } else throw new CanvasError('未知目录操作')
      steps.push(sql('INSERT INTO catalog_mutations VALUES(?,?,?,?,?,?,?,?)', [this.owner, input.requestId, input.operation, entity, id, requestHash, JSON.stringify({ id }), now]))
      beforeCommit?.()
      try { await this.db.batch(steps) }
      catch (error) {
        if (String(error).includes('UNIQUE constraint')) throw new CanvasError('名称已存在，请换一个名称', 409, 'NAME_EXISTS')
        throw error
      }
      if (input.operation === 'canvas-create') this.states.set(id, this.state(id))
      if (input.operation === 'canvas-delete') this.states.delete(id)
      return { id }
    })
  }
  async hasUnfinished(canvas: string, node?: string): Promise<boolean> {
    const task = await this.db.get(`SELECT id FROM task_catalog WHERE canvas_id=? ${node ? 'AND node_id=?' : ''} AND status IN ('queued','running','external_wait','saving','needs_attention','save_failed') LIMIT 1`, [canvas, ...(node ? [node] : [])])
    const upload = await this.db.get(`SELECT id FROM upload_sessions WHERE canvas_id=? ${node ? 'AND node_id=?' : ''} AND state IN ('receiving','received') AND task_id IS NULL LIMIT 1`, [canvas, ...(node ? [node] : [])])
    return !!(task || upload)
  }
  private async storageCredentials(input: StorageInput): Promise<StorageCredentials> {
    const previous = input.id ? await this.storageRecord(input.id) : null
      const old = previous ? JSON.parse(await this.vault.read(previous.readCredentialRef ?? previous.credentialRef)) as StorageCredentials : null
    const credentials = { accessKeyId: input.accessKeyId || old?.accessKeyId || '', accessKeySecret: input.accessKeySecret || old?.accessKeySecret || '' }
    if (!credentials.accessKeyId || !credentials.accessKeySecret) throw new CanvasError('请输入 AccessKey ID 和 AccessKey Secret')
    return credentials
  }
  async testStorage(input: StorageInput): Promise<void> {
    await this.objects.probe(input, await this.storageCredentials(input))
  }
  async setStorage(input: StorageInput): Promise<ObjectStorageSettings> {
    const existing = await this.db.get('SELECT request_hash FROM catalog_mutations WHERE owner_id=? AND request_id=?', [this.owner, input.requestId])
    if (existing) {
      if (existing.request_hash !== hash(input)) throw new CanvasError('请求 ID 已使用', 409, 'REQUEST_REUSED')
      return this.storage()
    }
    const credentials = await this.storageCredentials(input)
    await this.objects.probe(input, credentials)
    const credentialRef = await this.vault.put(JSON.stringify(credentials))
    await this.serial(async () => {
      const replay = await this.db.get('SELECT request_hash FROM catalog_mutations WHERE owner_id=? AND request_id=?', [this.owner, input.requestId])
      if (replay) {
        if (replay.request_hash !== hash(input)) throw new CanvasError('请求 ID 已使用', 409, 'REQUEST_REUSED')
        return
      }
      const setting = await this.db.get('SELECT * FROM owner_settings WHERE owner_id=?', [this.owner])
      if (setting.storage_revision !== input.revision) throw new CanvasError('存储设置已更新', 409, 'STORAGE_CONFLICT')
      const id = randomUUID(); const now = Date.now()
      const { requestId: _request, accessKeyId: _ak, accessKeySecret: _sk, id: _old, ...config } = input
      const record: StorageRecord = { ...config, id, credentialRef, revision: setting.storage_revision + 1, verifiedAt: now }
      const { credentialRef: _ref, ...publicConfig } = record
      const steps = [
        sql('INSERT INTO storage_providers VALUES(?,?,?,?,?,?)', [id, this.owner, JSON.stringify(publicConfig), credentialRef, credentialRef, now]),
        sql('UPDATE owner_settings SET active_storage_provider_id=?,storage_revision=storage_revision+1,content_hash=?,updated_at=? WHERE owner_id=? AND storage_revision=?', [id, hash(publicConfig), now, this.owner, input.revision], 'run', 1),
        sql('INSERT INTO catalog_mutations VALUES(?,?,?,?,?,?,?,?)', [this.owner, input.requestId, 'storage-set', 'settings', this.owner, hash(input), JSON.stringify({ id }), now]),
      ]
      // Rotate read credentials for the same immutable storage identity; accepted tasks retain their original refs.
      if (input.id) {
        const previous = await this.storageRecord(input.id)
        const identity = (r: Pick<StorageRecord, 'type' | 'bucket' | 'region' | 'endpoint' | 'prefix'>) => hash([r.type, r.bucket, r.region, r.endpoint, r.prefix])
        if (identity(previous) === identity(record)) {
          for (const provider of await this.db.all('SELECT id,config_json FROM storage_providers WHERE owner_id=?', [this.owner])) {
            if (identity(JSON.parse(provider.config_json)) === identity(record))
              steps.push(sql('UPDATE storage_providers SET read_credential_ref=? WHERE id=?', [credentialRef, provider.id]))
          }
        }
      }
      await this.db.batch(steps)
    })
    return this.storage()
  }
  async retryMoves(): Promise<void> {
    await this.serial(async () => {
      await this.db.batch([sql("UPDATE file_operation_items SET state='pending',error=NULL WHERE state='failed'"), sql("UPDATE file_operations SET state='pending',error=NULL WHERE state='failed'")])
    })
  }
  async storage(): Promise<ObjectStorageSettings> {
    const row = await this.db.get('SELECT active_storage_provider_id AS activeProviderId,storage_revision AS revision FROM owner_settings WHERE owner_id=?', [this.owner])
    const providers = []
    for (const item of await this.db.all('SELECT * FROM storage_providers WHERE owner_id=? ORDER BY created_at DESC', [this.owner])) {
      const record = JSON.parse(item.config_json)
      const credentials = JSON.parse(await this.vault.read(item.read_credential_ref).catch(() => '{}')) as Partial<StorageCredentials>
      providers.push({ ...record, active: item.id === row.activeProviderId, hasCredentials: !!credentials.accessKeyId && !!credentials.accessKeySecret,
        accessKeyIdMask: maskSecret(credentials.accessKeyId ?? ''), accessKeySecretMask: maskSecret(credentials.accessKeySecret ?? '') })
    }
    const counts = await this.db.get("SELECT SUM(state IN ('pending','running')) AS moving,SUM(state='failed') AS failed FROM file_operations")
    return { ...row, configured: !!row.activeProviderId, providers, moving: counts.moving ?? 0, failed: counts.failed ?? 0 }
  }
  async searchTasks(input: Partial<TaskSearchQuery>): Promise<TaskPage> {
    const query = TaskSearchQuerySchema.parse(input)
    const type = "CASE WHEN t.kind='import' THEN 'import' WHEN json_extract(d.snapshot_json,'$.model.protocol')='fish-tts' THEN 'tts' WHEN json_extract(d.snapshot_json,'$.model.kind')='video' THEN 'video' ELSE 'image' END"
    const maximum = '(SELECT COALESCE(MAX(q.queue_seq),0) FROM task_catalog q JOIN canvases a ON a.id=q.canvas_id WHERE a.owner_id=? AND a.deleted_at IS NULL)'
    const where = ['c.owner_id=?', 'c.deleted_at IS NULL', `t.queue_seq<=COALESCE(?,${maximum})`]
    const params: SqlValue[] = [this.owner, query.upperBound ?? null, this.owner]
    const add = (condition: string, value: SqlValue) => { where.push(condition); params.push(value) }
    const fuzzy = (value: string) => `%${value.replace(/[\\%_]/g, '\\$&')}%`
    if (query.taskId) add('t.id=?', query.taskId)
    if (query.folderName) add("COALESCE(f.name,'未归档') LIKE ? ESCAPE '\\'", fuzzy(query.folderName))
    if (query.canvasName) add("c.name LIKE ? ESCAPE '\\'", fuzzy(query.canvasName))
    if (query.type) add(`${type}=?`, query.type)
    if (query.startTime !== undefined) add('t.created_at>=?', query.startTime)
    if (query.endTime !== undefined) add('t.created_at<=?', query.endTime)
    const filtered = `WITH filtered AS (
      SELECT t.id,t.canvas_id AS canvasId,t.node_id AS nodeId,COALESCE(f.name,'未归档') AS folderName,
        c.name AS canvasName,t.title AS nodeName,${type} AS type,t.status,t.queue_seq,
        json_extract(d.snapshot_json,'$.model.name') AS submittedModelName,
        json_extract(d.snapshot_json,'$.model.api_base') AS submittedModelBase,
        json_extract(d.snapshot_json,'$.model.protocol') AS submittedModelProtocol,
        t.created_at AS createdAt,t.updated_at AS updatedAt
      FROM task_catalog t JOIN canvases c ON c.id=t.canvas_id
      LEFT JOIN folders f ON f.id=c.folder_id AND f.owner_id=c.owner_id
      LEFT JOIN task_details d ON d.task_id=t.id WHERE ${where.join(' AND ')}
    )`
    // A single worker message keeps count, bounds and rows consistent with the single writer.
    const [bound, count, rows] = await this.db.batch([
      sql(`SELECT COALESCE(?,${maximum}) AS value`, [query.upperBound ?? null, this.owner], 'get'),
      sql(`${filtered} SELECT COUNT(*) AS total FROM filtered`, params, 'get'),
      sql(`${filtered} SELECT * FROM filtered ORDER BY queue_seq DESC LIMIT ?
        OFFSET MIN(?, MAX(0,CAST(((SELECT COUNT(*) FROM filtered)-1)/? AS INTEGER))*?)`,
      [...params, query.pageSize, (query.page - 1) * query.pageSize, query.pageSize, query.pageSize], 'all'),
    ], false)
    return {
      items: rows.map(({ queue_seq: _sequence, status, submittedModelName, submittedModelBase, submittedModelProtocol, ...row }: any) => ({
        ...row, ...taskModelIdentity({ name: submittedModelName, api_base: submittedModelBase, protocol: submittedModelProtocol }),
        status: statusFromDb[status],
      })),
      total: count.total, page: Math.min(query.page, Math.max(1, Math.ceil(count.total / query.pageSize))),
      pageSize: query.pageSize, upperBound: bound.value,
    }
  }
  async taskDetail(canvas: string, id: string): Promise<TaskDetail> {
    const row = await this.db.get('SELECT d.*,c.kind FROM task_details d JOIN task_catalog c ON c.id=d.task_id WHERE c.canvas_id=? AND c.id=?', [canvas, id])
    if (!row) throw new CanvasError('任务不存在', 404)
    const task = this.state(canvas).tasks.find((t) => t.id === id)
    return { ...taskModelIdentity(row.snapshot_json ? JSON.parse(row.snapshot_json).model : undefined),
      task: task ?? null, kind: row.kind, phase: row.phase, externalTaskId: row.external_task_id, externalCompletedAt: row.external_completed_at, successAt: row.success_at, failureStage: row.failure_stage, failureCode: row.failure_code, failureMessage: row.failure_message, attempts: await this.db.all('SELECT step,issued_at,finished_at,outcome,error FROM task_attempts WHERE task_id=? ORDER BY issued_at', [id]) }
  }
  private async moveStatements(canvas: string, nodeIds?: string[], targetStorage?: string, state = this.state(canvas), revisionIncrement = 0): Promise<Statement[]> {
    const target = await this.db.get('SELECT target_storage_id,layout_revision FROM canvases WHERE id=?', [canvas])
    if (targetStorage) target.target_storage_id = targetStorage
    target.layout_revision += revisionIncrement
    const assets = await this.db.all("SELECT * FROM canvas_assets WHERE canvas_id=? AND file_state='ready'", [canvas])
    const operation = randomUUID(); const now = Date.now(); const steps: Statement[] = []
    for (const asset of assets) {
      if (nodeIds && !nodeIds.includes(asset.name_source_node_id)) continue
      const node = state.graph.nodes.find((n) => n.id === asset.name_source_node_id)
      const title = node?.title ?? asset.name_snapshot
      const name = `${safeName(title)}__${asset.id}${extension(asset.mime)}`
      const source = await this.locator(canvas, asset.id)
      const storage = targetStorage ?? await this.currentStorageTarget(canvas, source.providerId)
      if (asset.storage_id === storage && asset.file_name === name) continue
      steps.push(sql("INSERT INTO file_operation_items VALUES(?,?,?,?,?,?,?,?,?,'pending',NULL,?)", [randomUUID(), operation, canvas, asset.id, JSON.stringify(source), storage, name, asset.file_hash, asset.row_version, now]))
    }
    if (!steps.length) return []
    return [sql("INSERT INTO file_operations VALUES(?,?,?,'pending',NULL,?,?)", [operation, canvas, target.layout_revision, now, now]), ...steps]
  }
  async planMoves(canvas: string, nodeIds?: string[]): Promise<void> {
    const steps = await this.moveStatements(canvas, nodeIds)
    if (steps.length) await this.db.batch(steps)
  }
  private async relayout(row: any, name: string, folder: string | null, folderName?: string): Promise<Statement[]> {
    // Rename copies within each asset's original provider. A switch never migrates old objects.
    const steps: Statement[] = []
    const providers = await this.db.all('SELECT DISTINCT l.root_id FROM canvas_assets a JOIN canvas_storage_locations l ON l.canvas_id=a.canvas_id AND l.id=a.storage_id WHERE a.canvas_id=?', [row.id])
    const initial = await this.db.get('SELECT root_id FROM canvas_storage_locations WHERE canvas_id=? AND id=?', [row.id, row.target_storage_id])
    if (!providers.some((p) => p.root_id === initial.root_id)) providers.push(initial)
    for (const provider of providers) {
      const location = randomUUID()
      const dir = await this.directoryName(provider.root_id, name, row.id, folder, folderName)
      steps.push(sql('INSERT INTO canvas_storage_locations VALUES(?,?,?,?,?,?)', [row.id, location, provider.root_id, dir, pathKey(dir), Date.now()]))
      const moves = await this.moveStatements(row.id, undefined, location, this.state(row.id), 1)
      // Filter each operation to this provider; immutable old locators remain for task references.
      const items = moves.slice(1).filter((s) => JSON.parse(String(s.params?.[4])).providerId === provider.root_id)
      if (items.length) steps.push(moves[0], ...items)
      if (provider.root_id === initial.root_id) steps.push(sql('UPDATE canvases SET target_storage_id=? WHERE id=?', [location, row.id]))
    }
    steps.push(sql('UPDATE canvases SET layout_revision=layout_revision+1 WHERE id=?', [row.id]))
    return steps
  }
  async runMoves(signal?: AbortSignal): Promise<void> {
    const operations = await this.db.all("SELECT * FROM file_operations WHERE state IN ('pending','running') ORDER BY created_at LIMIT 4")
    for (const operation of operations) {
      signal?.throwIfAborted()
      await this.db.batch([sql("UPDATE file_operations SET state='running',updated_at=? WHERE id=?", [Date.now(), operation.id])])
      const items = await this.db.all("SELECT * FROM file_operation_items WHERE operation_id=? AND state IN ('pending','copied')", [operation.id])
      let failed = false
      for (const item of items) {
        try {
          const target = await this.actualPath(item.canvas_id, item.target_storage_id, item.target_name)
          const source: ObjectLocator = JSON.parse(item.source_path)
          const adapter = await this.objects.adapter(source.providerId)
          await this.objects.verify(source)
          const receipt = await adapter.head(target)
          const copied = receipt ?? await adapter.copy(source, target)
          this.objects.check(copied, { bytes: source.bytes, sha256: source.sha256 })
          await this.serial(async () => {
            const asset = await this.db.get('SELECT * FROM canvas_assets WHERE canvas_id=? AND id=?', [item.canvas_id, item.asset_id])
            const layout = await this.db.get('SELECT layout_revision FROM canvases WHERE id=?', [item.canvas_id])
            if (asset.row_version !== item.source_version || layout.layout_revision !== operation.layout_revision) {
              await this.db.batch([sql("UPDATE file_operation_items SET state='superseded',updated_at=? WHERE id=?", [Date.now(), item.id])]); return
            }
            const title = this.state(item.canvas_id).graph.nodes.find((n) => n.id === asset.name_source_node_id)?.title ?? asset.name_snapshot
            await this.db.batch([
              sql('UPDATE canvas_assets SET storage_id=?,file_name=?,file_name_key=?,object_key=?,etag=?,version_id=?,name_snapshot=?,row_version=row_version+1,content_hash=?,updated_at=? WHERE canvas_id=? AND id=? AND row_version=?', [item.target_storage_id, item.target_name, pathKey(item.target_name), target, copied.etag, copied.versionId ?? null, title, hash({ ...asset, storage_id: item.target_storage_id, object_key: target, name_snapshot: title }), Date.now(), item.canvas_id, item.asset_id, item.source_version], 'run', 1),
              sql('DELETE FROM asset_variants WHERE canvas_id=? AND asset_id=?', [item.canvas_id, item.asset_id]),
              sql("UPDATE file_operation_items SET state='completed',updated_at=? WHERE id=?", [Date.now(), item.id]),
            ])
            const current = this.states.get(item.canvas_id)?.assets.find((a) => a.id === item.asset_id)
            if (current) current.filename = item.target_name
          })
          // Source bytes are retained. A later explicit GC policy can reclaim them safely.
        } catch (error) {
          if (signal?.aborted) throw error
          failed = true
          await this.db.batch([sql("UPDATE file_operation_items SET state='failed',error=?,updated_at=? WHERE id=?", [this.redact(String(error)), Date.now(), item.id])])
        }
      }
      await this.db.batch([sql('UPDATE file_operations SET state=?,error=?,updated_at=? WHERE id=?', [failed ? 'failed' : 'completed', failed ? '部分媒体搬移失败，原文件仍保留' : null, Date.now(), operation.id])])
    }
  }
  async close(): Promise<void> {
    if (this.closed) return
    await this.queue; this.closed = true
    await this.db.close()
    if (this.release) {
      const pid = await readFile(join(this.root, '.writer', 'pid'), 'utf8').catch(() => '')
      if (pid === String(process.pid)) await rm(join(this.root, '.writer'), { force: true, recursive: true })
      await this.release(); this.release = undefined
    }
  }
}
