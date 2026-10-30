import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { INTERNAL_CANVAS_PRESETS, type CanvasControl, type SpecialistRole } from '../../shared/agent'
import type { CanvasService } from '../service'
import { CanvasError } from '../store'
import { hash } from '../persistence/database'
import { AgentLedger } from './ledger'
import { handoffSummary } from './handoff'
import { AgentPresentation } from './presentation'

declare module '@deepseek-ai/cordis' { interface Context { canvasAgent: CanvasAgentCoordinator } }
const internalPresets = new Set(INTERNAL_CANVAS_PRESETS)
export interface AgentMember { agent: Agent; role: 'main' | SpecialistRole; rootId: string }
/** All foreground writes and paid dispatch admissions share one commit queue. */
export class CanvasAgentCoordinator extends Service {
  readonly ledger: AgentLedger
  readonly presentation: AgentPresentation
  private members = new Map<string, AgentMember>()
  private queue: Promise<unknown> = Promise.resolve()
  private children = new Map<string, Set<() => Promise<void>>>()
  private revoked = new Set<string>()
  private routes = new Map<string, { provider: string; model: string }>()
  private specialistRuns = new Map<string, Promise<unknown>>()
  private restrictions = new Map<Agent, { preset: string; dispose: () => void }>()
  constructor(ctx: Context, readonly canvas: CanvasService) {
    super(ctx, 'canvasAgent')
    this.ledger = new AgentLedger(canvas.config.dataDir)
    this.presentation = new AgentPresentation(canvas.config.dataDir, (id) => this.control(id))
    // Preset listeners stop matching immediately after rebind; the host owns cleanup.
    ctx.effect(() => ctx.root.on('agent-preset/selected', (id, preset) => {
      for (const [agent, entry] of this.restrictions) if (agent.id === id && entry.preset !== preset) {
        entry.dispose(); this.restrictions.delete(agent)
        if (this.members.get(id)?.role === 'main') this.unregister(agent)
      }
    }))
  }
  async init() { await this.ledger.init(); await this.presentation.init() }
  serial<T>(operation: () => Promise<T>): Promise<T> {
    const work = this.queue.then(operation)
    this.queue = work.catch(() => {})
    return work
  }
  register(agent: Agent, role: AgentMember['role'], rootId = agent.id) {
    this.members.set(agent.id, { agent, role, rootId })
  }
  trackRestriction(agent: Agent, preset: string, dispose: () => void) {
    this.restrictions.set(agent, { preset, dispose })
  }
  unregister(agent: Agent) {
    if (this.members.get(agent.id)?.agent !== agent) return
    this.members.delete(agent.id)
    this.routes.delete(agent.id)
    this.restrictions.get(agent)?.dispose(); this.restrictions.delete(agent)
    for (const c of this.ledger.controls()) if (c.sessionId === agent.id && c.mode === 'agent') {
      this.ledger.setControl({ ...c, mode: 'manual', epoch: c.epoch + 1, updatedAt: Date.now(), reason: '会话已关闭' })
    }
    void this.ledger.persist().catch(() => {})
    this.presentation.changed()
  }
  setRoute(agent: Agent, route: { provider: string; model: string }) { this.routes.set(agent.id, { ...route }) }
  route(agent: Agent) {
    const route = this.routes.get(agent.id)
    if (!route) throw new CanvasError('尚未核验主 Agent 模型', 409, 'AGENT_MULTIMODAL_REQUIRED')
    return route
  }
  member(agent: Agent) {
    const member = this.members.get(agent.id)
    if (!member || member.agent !== agent) throw new CanvasError('当前 Agent 没有画布权限', 403, 'AGENT_FORBIDDEN')
    return member
  }
  session(id: string) {
    const live = this.ctx.agents.get(id as SessionId)
    const preset = live ? this.ctx.agentPresets.composedPreset(live.ctx) : undefined
    if (live && preset !== 'canvas-creator' && this.members.get(id)?.role === 'main') this.unregister(live)
    if (live && preset === 'canvas-creator' && !this.members.has(id)) this.register(live, 'main')
    return { preset: preset === 'canvas-creator' || this.members.get(id)?.role === 'main', canvas: this.ledger.controls().filter((c) => c.sessionId === id).sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null }
  }
  control(canvasId: string) { return this.ledger.control(canvasId) }
  attached(agent: Agent): CanvasControl {
    const member = this.member(agent)
    const c = this.session(member.rootId).canvas
    if (!c) throw new CanvasError('请先打开或创建画布项目', 409, 'AGENT_CANVAS_REQUIRED')
    return c
  }
  assert(agent: Agent, control: CanvasControl, writing = true) {
    const member = this.member(agent), current = this.control(control.canvasId)
    if (writing && member.role !== 'main') throw new CanvasError('专业 Agent 只能返回草稿', 403, 'AGENT_DRAFT_ONLY')
    if (current.mode !== 'agent' || current.sessionId !== member.rootId || current.epoch !== control.epoch || this.revoked.has(member.rootId))
      throw new CanvasError('画布已由人工接管，请重新委托', 409, 'AGENT_CONTROL_REVOKED')
  }
  async qualified(provider: string, model: string, signal?: AbortSignal) {
    const info = await this.ctx.llm.resolveModelInfo(provider, model, signal)
    if (!info.inputModalities?.includes('image')) throw new CanvasError('画布 Agent 需要支持图片输入的多模态模型，请在模型设置中配置', 422, 'AGENT_MULTIMODAL_REQUIRED')
  }
  async modelCatalog() {
    const catalog = await this.ctx.sessionController.modelCatalog()
    const entries = catalog.groups.flatMap((group) => group.models.map((model) => ({ group, model })))
    const models: Array<{ provider: string; providerName: string; model: string; name: string; eligible: boolean }> = []
    let cursor = 0
    await Promise.all(Array.from({ length: Math.min(4, entries.length) }, async () => {
      while (cursor < entries.length) {
      const index = cursor++, { group, model } = entries[index]
      let eligible = false
      try { await this.qualified(group.id, model.id, AbortSignal.timeout(10000)); eligible = true } catch {}
      models[index] = { provider: group.id, providerName: group.name, model: model.id, name: model.name, eligible }
      }
    }))
    return { models }
  }
  async delegate(canvasId: string, sessionId: string, revision?: number) {
    this.session(sessionId)
    const member = this.members.get(sessionId)
    if (!member || member.role !== 'main') throw new CanvasError('请先在对话中选择「无限画布」Agent 预设', 409, 'AGENT_SESSION_REQUIRED')
    const admittedEpoch = this.control(canvasId).epoch
    return this.serial(async () => {
      const snapshot = await this.canvas.store.snapshot(canvasId)
      if (this.control(canvasId).epoch !== admittedEpoch) throw new CanvasError('控制状态已更新，请重新委托', 409, 'AGENT_CONTROL_REVOKED')
      if (revision !== undefined && revision !== snapshot.graphRevision) throw new CanvasError('请先保存当前画布后再委托', 409, 'GRAPH_CONFLICT')
      const c = this.control(canvasId)
      if (c.mode === 'agent' && c.sessionId !== sessionId) throw new CanvasError('画布正由另一会话操作，请先人工接管', 409, 'AGENT_CANVAS_BUSY')
      if (c.mode === 'agent' && c.sessionId === sessionId) return c
      for (const other of this.ledger.controls()) if (other.sessionId === sessionId && other.canvasId !== canvasId && other.mode === 'agent') throw new CanvasError('请先接管上一张画布', 409, 'AGENT_SESSION_BUSY')
      for (const other of this.ledger.controls()) if (other.sessionId === sessionId && other.canvasId !== canvasId)
        this.ledger.setControl({ ...other, sessionId: null })
      const previous = this.ledger.handoff(canvasId)
      const summary = handoffSummary(previous?.graph, snapshot.graph, snapshot.graphRevision)
      const next: CanvasControl = { canvasId, sessionId, mode: 'agent', epoch: c.epoch + 1, updatedAt: Date.now() }
      this.revoked.delete(sessionId)
      this.ledger.setControl(next)
      this.ledger.setHandoff(canvasId, hash(snapshot.graph), summary, snapshot.graph)
      await this.ledger.persist()
      await this.presentation.publish(next, `delegate:${next.epoch}`, 'open', snapshot.graphRevision, [])
      return next
    })
  }
  async takeover(canvasId: string, reason = '人工接管') {
    const c = this.control(canvasId)
    // Revoke synchronously before cancellation hooks or other awaited work.
    this.ledger.setControl({ ...c, mode: 'manual', epoch: c.epoch + 1, updatedAt: Date.now(), reason })
    this.presentation.changed()
    if (c.sessionId) {
      this.revoked.add(c.sessionId)
      for (const member of this.members.values()) if (member.rootId === c.sessionId) member.agent.cancel({ kind: 'user' })
      for (const dispose of this.children.get(c.sessionId) ?? []) void dispose().catch(() => {})
    }
    return this.serial(async () => {
      const snapshot = await this.canvas.store.snapshot(canvasId)
      this.ledger.setHandoff(canvasId, hash(snapshot.graph), reason, snapshot.graph)
      await this.ledger.persist()
      return this.control(canvasId)
    })
  }
  trackChild(rootId: string, dispose: () => Promise<void>) {
    const set = this.children.get(rootId) ?? new Set()
    this.children.set(rootId, set); set.add(dispose)
    return () => { set.delete(dispose); if (!set.size) this.children.delete(rootId) }
  }
  async specialist(agent: Agent, key: string, args: unknown, operation: () => Promise<unknown>) {
    const c = this.attached(agent)
    this.assert(agent, c)
    const replay = this.ledger.receipt(key, args)
    if (replay) return replay.value
    this.ledger.receipt(`${key}:started`, args)
    const existing = this.specialistRuns.get(key)
    if (existing) return existing
    const work = (async () => {
      await this.serial(async () => {
        this.assert(agent, c)
        if (this.ledger.receipt(`${key}:started`, args)) throw new CanvasError('上次专业委派未取得完整结果，请核对后使用新操作 ID；不会自动重提', 409, 'SPECIALIST_INCOMPLETE')
        if ([...this.specialistRuns.keys()].filter((k) => k.startsWith(`${c.canvasId}:specialist:`)).length > 2) throw new CanvasError('专业 Agent 并发上限为 2，请等待当前草稿', 429, 'SPECIALIST_CAPACITY')
        this.ledger.reserveReceipts([key, `${key}:started`])
        this.ledger.remember(`${key}:started`, args, { started: true })
        await this.ledger.persist()
      })
      const value = await operation()
      this.assert(agent, c)
      this.ledger.remember(key, args, value); await this.ledger.persist()
      this.assert(agent, c)
      return value
    })()
    this.specialistRuns.set(key, work)
    try { return await work } finally { if (this.specialistRuns.get(key) === work) this.specialistRuns.delete(key) }
  }
  async manual(request: Request, operation: () => Promise<Response>) {
    if (request.method !== 'POST') return operation()
    const url = new URL(request.url), suffix = url.pathname.split('/').at(-1)!
    if (['media-urls', 'settings-secret', 'agent-control', 'agent-view', 'agent-presence', 'agent-presentation-ack'].includes(suffix)) return operation()
    return this.serial(async () => {
      const canvasId = url.searchParams.get('canvas') ?? url.searchParams.get('workspace')
      const locked = canvasId ? this.control(canvasId).mode === 'agent' : this.ledger.controls().some((c) => c.mode === 'agent')
      if (locked) return Response.json({ error: 'Agent 正在操作，请先点击人工接管', code: 'CANVAS_READ_ONLY' }, { status: 409 })
      return operation()
    })
  }
  async dispatch<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    const detail = await this.canvas.store.db.get('SELECT request_id FROM task_details WHERE task_id=?', [taskId])
    const submission = detail?.request_id ? this.ledger.submission(detail.request_id) : undefined
    if (!submission) return operation()
    return this.serial(async () => {
      const c = this.control(submission.canvasId)
      if (c.mode !== 'agent' || c.sessionId !== submission.sessionId || c.epoch !== submission.epoch)
        throw new CanvasError('人工接管或重启后，未发送的 Agent 任务已停止；不会自动重提', 409, 'AGENT_CONTROL_REVOKED')
      return operation()
    })
  }
  async drain() { await this.queue; await this.ledger.persist(); await this.presentation.persist() }
  installPresetRosterGuard() {
    const registry = this.ctx.agentPresets
    const original = registry.remoteExportList
    // Keep native resolve/mount/list untouched: the chooser roster is a separate API.
    async function visibleRoster(this: typeof registry) {
      const roster = await original.call(this)
      return { ...roster, presets: roster.presets.filter((preset) => !internalPresets.has(preset.id)) }
    }
    registry.remoteExportList = visibleRoster
    return this.ctx.effect(() => () => { if (registry.remoteExportList === visibleRoster) registry.remoteExportList = original })
  }
  installModelSelectionGuard() {
    const controller = this.ctx.sessionController
    const original = controller.selectModel
    const coordinator = this
    async function guarded(this: typeof controller, request: Parameters<typeof original>[0]) {
      const inspected = await this.inspect(request.sessionId)
      const session = coordinator.session(request.sessionId)
      if (session.preset || ['canvas-creator', 'canvas-story', 'canvas-assets', 'canvas-shots', 'canvas-audio', 'canvas-review'].includes(inspected.meta.agentPreset ?? ''))
        await coordinator.qualified(request.provider, request.model)
      return original.call(this, request)
    }
    controller.selectModel = guarded
    this.ctx.effect(() => () => { if (controller.selectModel === guarded) controller.selectModel = original })
  }
}
