import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { GENERATION_HANDOFF_REASON, isGenerationHandoff, INTERNAL_CANVAS_PRESETS, type CanvasControl, type SpecialistRole } from '../../shared/agent'
import type { CanvasGraph } from '../../shared/contracts'
import type { CanvasService } from '../service'
import { CanvasError } from '../store'
import { hash } from '../persistence/database'
import { AgentLedger } from './ledger'
import { handoffSummary } from './handoff'
import { AgentPresentation } from './presentation'
import { CanvasChatReferences } from './chatReferences'
import { AgentModelSelection, type PlanningModel } from './modelSelection'
import { CreativeProjects } from './creative'
import { AgentCollaboration } from './collaboration'
import { executionIntent, type ExecutionCommand } from '../../shared/execution'
import { ExecutionScheduler, executionResources, resourceFingerprint, type Resources } from './executionScheduler'
import { capabilities, taskSkills } from './capabilities'
import { AgentVideoSound } from './videoSound'

declare module '@deepseek-ai/cordis' { interface Context { canvasAgent: CanvasAgentCoordinator } }
const internalPresets = new Set(INTERNAL_CANVAS_PRESETS)
export interface AgentMember { agent: Agent; role: 'main' | 'executor' | SpecialistRole; rootId: string }
export interface CreativeBinding { projectId: string; taskId: string; sourceIds: string[]; artifactIds: string[]; nodeIds: string[]; assetIds: string[]; skillNames?: string[]; planningModels?: PlanningModel[] }
/** All foreground writes and paid dispatch admissions share one commit queue. */
export class CanvasAgentCoordinator extends Service {
  readonly ledger: AgentLedger
  readonly presentation: AgentPresentation
  readonly chatReferences: CanvasChatReferences
  readonly generationModels: AgentModelSelection
  readonly videoSound = new AgentVideoSound()
  readonly creative: CreativeProjects
  readonly collaboration: AgentCollaboration
  private bindings = new Map<string, CreativeBinding>()
  private executions = new Map<string, { control: CanvasControl; commands: ExecutionCommand[]; allowTts: boolean; inputRevision: number; fingerprints: Map<string, string> }>()
  readonly executionScheduler: ExecutionScheduler
  private prepared = new Map<string, { rootId: string; role: AgentMember['role']; binding: CreativeBinding; control?: CanvasControl; commands?: ExecutionCommand[]; allowTts: boolean; inputRevision?: number }>()
  private members = new Map<string, AgentMember>()
  private queue: Promise<unknown> = Promise.resolve()
  private children = new Map<string, Set<() => Promise<void>>>()
  private revoked = new Set<string>()
  private routes = new Map<string, { provider: string; model: string }>()
  private specialistRuns = new Map<string, Promise<unknown>>()
  private restrictions = new Map<Agent, { preset: string; dispose: () => void }>()
  private manualInputs = new Map<string, Set<string>>()
  constructor(ctx: Context, readonly canvas: CanvasService) {
    super(ctx, 'canvasAgent')
    this.executionScheduler = new ExecutionScheduler(canvas.config.maxConcurrentAgents ?? 4)
    this.ledger = new AgentLedger(canvas.config.dataDir)
    this.creative = new CreativeProjects(canvas.config.dataDir)
    this.collaboration = new AgentCollaboration(canvas.config.dataDir, this.creative)
    ctx.effect(() => this.creative.subscribe(() => this.collaboration.refresh()))
    ctx.effect(() => ctx.root.on('session/event', (session, event) => this.collaboration.observe(session.id, event)))
    ctx.effect(() => ctx.root.on('session/flush', () => this.collaboration.persist()))
    ctx.effect(() => ctx.root.on('subagent/start', (info) => this.collaboration.started(info.id, info.runId)))
    this.generationModels = new AgentModelSelection(() => canvas.store.listModels())
    this.chatReferences = new CanvasChatReferences(ctx, this)
    this.presentation = new AgentPresentation(canvas.config.dataDir, (id) => this.control(id),
      (id) => ctx.agents.get(id as SessionId)?.status === 'running')
    ctx.effect(() => ctx.root.on('agent/status', ({ agent }) => {
      if (this.members.get(agent.id)?.role === 'main') {
        if (agent.status !== 'running') this.presentation.endRoot(agent.id)
        this.presentation.changed()
      }
    }))
    // Preset listeners stop matching immediately after rebind; the host owns cleanup.
    ctx.effect(() => ctx.root.on('agent-preset/selected', (id, preset) => {
      for (const [agent, entry] of this.restrictions) if (agent.id === id && entry.preset !== preset) {
        entry.dispose(); this.restrictions.delete(agent)
        if (this.members.get(id)?.role === 'main') this.unregister(agent)
      }
    }))
  }
  async init() { await this.ledger.init(); await this.creative.init(); await this.collaboration.init(); await this.presentation.init() }
  serial<T>(operation: () => Promise<T>): Promise<T> {
    const work = this.queue.then(operation)
    this.queue = work.catch(() => {})
    return work
  }
  register(agent: Agent, role: AgentMember['role'], rootId = agent.id) {
    capabilities(role)
    if (role === 'main' && this.members.get(agent.id)?.agent !== agent &&
      this.ledger.controls().some((control) => control.sessionId === agent.id && control.mode === 'manual')) this.rememberManualInputs(agent)
    this.members.set(agent.id, { agent, role, rootId })
    const prepared = this.prepared.get(agent.id)
    if (prepared && prepared.rootId === rootId && prepared.role === role) {
      this.bind(agent, prepared.binding)
      if (prepared.control && prepared.commands) this.grantExecution(agent, prepared.control, prepared.commands, prepared.allowTts, prepared.inputRevision)
      this.prepared.delete(agent.id)
    }
  }
  private rememberManualInputs(agent: Agent) {
    const ids = new Set<string>()
    for (const event of agent.session.snapshotEvents()) {
      if (event.type === 'user/message') ids.add(event.data.id)
    }
    for (const message of [...(agent.inbox?.nextTurn ?? []), ...(agent.inbox?.nextStep ?? [])]) ids.add(message.id)
    this.manualInputs.set(agent.id, ids)
  }
  async resumeForUserInput(agent: Agent, messages: UserMessage[], signal: AbortSignal) {
    const member = this.member(agent), control = this.session(agent.id).canvas
    if (member.role !== 'main' || control?.mode !== 'manual' ||
      !messages.some((message) => message.source.kind === 'user' && !!message.id && !this.manualInputs.get(agent.id)?.has(message.id))) return
    signal.throwIfAborted()
    await this.delegate(control.canvasId, agent.id, undefined, control.epoch, 'user-message')
    signal.throwIfAborted()
  }
  trackRestriction(agent: Agent, preset: string, dispose: () => void) {
    this.restrictions.set(agent, { preset, dispose })
  }
  unregister(agent: Agent) {
    if (this.members.get(agent.id)?.agent !== agent) return
    this.members.delete(agent.id)
    this.presentation.endExecutor(agent.id)
    this.bindings.delete(agent.id); this.executions.delete(agent.id)
    this.generationModels.clear(agent)
    this.videoSound.clear(agent)
    this.routes.delete(agent.id)
    this.manualInputs.delete(agent.id)
    this.restrictions.get(agent)?.dispose(); this.restrictions.delete(agent)
    for (const c of this.ledger.controls()) if (c.sessionId === agent.id && c.mode === 'agent') {
      this.ledger.setControl({ ...c, mode: 'manual', epoch: c.epoch + 1, updatedAt: Date.now(), reason: '会话已关闭' })
    }
    void this.ledger.persist().catch(() => {})
    this.presentation.changed()
    this.executionScheduler.changed()
  }
  setRoute(agent: Agent, route: { provider: string; model: string }) {
    const previous = this.routes.get(agent.id)
    if (previous && (previous.provider !== route.provider || previous.model !== route.model)) this.generationModels.clear(agent)
    this.routes.set(agent.id, { ...route })
  }
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
  rootAgent(agent: Agent) {
    const member = this.member(agent), root = this.members.get(member.rootId)?.agent
    if (!root || this.member(root).role !== 'main') throw new CanvasError('主 Agent 已关闭', 403, 'AGENT_FORBIDDEN')
    return root
  }
  bind(agent: Agent, binding: CreativeBinding) { taskSkills(this.member(agent).role, binding.skillNames); this.bindings.set(agent.id, structuredClone(binding)) }
  prepareChild(id: string, rootId: string, role: AgentMember['role'], binding: CreativeBinding, control?: CanvasControl, commands?: ExecutionCommand[], allowTts = false, inputRevision?: number) {
    taskSkills(role, binding.skillNames)
    this.prepared.set(id, { rootId, role, binding: structuredClone(binding), control, commands, allowTts, inputRevision })
    return () => { this.prepared.delete(id) }
  }
  binding(agent: Agent) {
    this.member(agent)
    const binding = this.bindings.get(agent.id)
    if (!binding) throw new CanvasError('子 Agent 未获得本批次任务授权', 403, 'AGENT_FORBIDDEN')
    this.generationModels.assertPlan(this.rootAgent(agent), binding.planningModels)
    return structuredClone(binding)
  }
  grantExecution(agent: Agent, control: CanvasControl, commands: ExecutionCommand[], allowTts: boolean, inputRevision?: number) {
    if (this.member(agent).role !== 'executor') throw new CanvasError('只有画布执行子 Agent 可获得写授权', 403, 'AGENT_FORBIDDEN')
    const previous = this.executions.get(agent.id)
    if (previous?.control.epoch === control.epoch && hash(previous.commands) === hash(commands)) return
    const state = this.canvas.store.state(control.canvasId), resources = executionResources(commands, state.graph)
    const fingerprints = new Map([...new Set([...resources.read, ...resources.write])].filter((key) => key !== '*')
      .map((key) => [key, resourceFingerprint(key, state.graph, state.assets)]))
    this.executions.set(agent.id, { control: structuredClone(control), commands: structuredClone(commands), allowTts, fingerprints, inputRevision: inputRevision ?? state.graphRevision })
    const binding = this.bindings.get(agent.id)
    if (binding) this.presentation.startExecutor(agent.id, control, binding.taskId)
  }
  /** Rebase only a finite ordinary edit whose granted resources still match. */
  executionRevision(agent: Agent, tool: string, input: unknown) {
    this.assertExecution(agent, tool, input)
    const grant = this.executions.get(agent.id)!, state = this.canvas.store.state(grant.control.canvasId)
    if (Math.min(...grant.commands.map((command) => command.input.revision)) !== grant.inputRevision)
      throw new CanvasError('执行清单引用了旧修订，请主 Agent 重新读取后派发', 409, 'GRAPH_CONFLICT')
    for (const [key, fingerprint] of grant.fingerprints) if (resourceFingerprint(key, state.graph, state.assets) !== fingerprint)
      throw new CanvasError('获授节点或引用已变化，请主 Agent 核对后重新派发', 409, 'AGENT_RESOURCE_CONFLICT')
    return state.graphRevision
  }
  executionCommitted(agent: Agent, command: ExecutionCommand) {
    const grant = this.executions.get(agent.id)!
    const state = this.canvas.store.state(grant.control.canvasId)
    for (const key of executionResources([command], state.graph).write) if (key !== '*')
      grant.fingerprints.set(key, resourceFingerprint(key, state.graph, state.assets))
  }
  assertExecution(agent: Agent, tool: string, input: unknown) {
    const grant = this.executions.get(agent.id)
    if (!grant || this.member(agent).role !== 'executor' ||
      !grant.commands.some((command) => command.tool === tool && hash(executionIntent(command.input)) === hash(executionIntent(input))) ||
      (tool === 'canvas_generate' && !grant.allowTts)) throw new CanvasError('操作超出主 Agent 的明确执行清单', 403, 'AGENT_EXECUTION_SCOPE')
    this.assert(agent, grant.control)
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
    if (writing && member.role !== 'main' && member.role !== 'executor') throw new CanvasError('专业 Agent 只能返回草稿', 403, 'AGENT_DRAFT_ONLY')
    if (writing && member.role === 'executor') {
      const grant = this.executions.get(agent.id)
      if (!grant || grant.control.canvasId !== control.canvasId || grant.control.epoch !== control.epoch)
        throw new CanvasError('画布执行授权已失效', 403, 'AGENT_EXECUTION_SCOPE')
    }
    // The root may finish its reminder and inspect saved inputs after yielding;
    // all writes remain revoked, and cancelled children get no such exception.
    if (!writing && member.role === 'main' && isGenerationHandoff(current) &&
      current.sessionId === agent.id && current.epoch === control.epoch) return
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
  async delegate(canvasId: string, sessionId: string, revision?: number, expectedEpoch?: number, source?: 'user-message') {
    this.session(sessionId)
    const member = this.members.get(sessionId)
    if (!member || member.role !== 'main') throw new CanvasError('请先在对话中选择「无限画布」Agent 预设', 409, 'AGENT_SESSION_REQUIRED')
    const admittedEpoch = this.control(canvasId).epoch
    if (expectedEpoch !== undefined && expectedEpoch !== admittedEpoch) throw new CanvasError('控制状态已变化，请核对当前画布', 409, 'AGENT_CONTROL_REVOKED')
    return this.serial(async () => {
      const snapshot = await this.canvas.store.snapshot(canvasId)
      if (this.control(canvasId).epoch !== admittedEpoch) throw new CanvasError('控制状态已更新，请重新委托', 409, 'AGENT_CONTROL_REVOKED')
      if (revision !== undefined && revision !== snapshot.graphRevision) throw new CanvasError('请先保存当前画布后再委托', 409, 'GRAPH_CONFLICT')
      const c = this.control(canvasId)
      if (isGenerationHandoff(c) && source !== 'user-message')
        throw new CanvasError('正在等待用户检查参数并点击生成；只有新消息可恢复 Agent 操作', 409, 'AGENT_MANUAL_GENERATION_REQUIRED')
      if (c.mode === 'agent' && c.sessionId !== sessionId) throw new CanvasError('画布正由另一会话操作，请先人工接管', 409, 'AGENT_CANVAS_BUSY')
      if (c.mode === 'agent' && c.sessionId === sessionId) return c
      for (const other of this.ledger.controls()) if (other.sessionId === sessionId && other.canvasId !== canvasId && other.mode === 'agent') throw new CanvasError('请先接管上一张画布', 409, 'AGENT_SESSION_BUSY')
      for (const other of this.ledger.controls()) if (other.sessionId === sessionId && other.canvasId !== canvasId)
        { this.ledger.setControl({ ...other, sessionId: null }); this.generationModels.clear(member.agent) }
      const previous = this.ledger.handoff(canvasId)
      const summary = handoffSummary(previous?.graph, snapshot.graph, snapshot.graphRevision)
      const next: CanvasControl = { canvasId, sessionId, mode: 'agent', epoch: c.epoch + 1, updatedAt: Date.now() }
      this.revoked.delete(sessionId)
      this.manualInputs.delete(sessionId)
      this.ledger.setControl(next)
      this.ledger.setHandoff(canvasId, hash(snapshot.graph), summary, snapshot.graph)
      await this.ledger.persist()
      await this.presentation.publish(next, `delegate:${next.epoch}`, 'open', snapshot.graphRevision, [])
      return next
    })
  }
  /** Called in the shared commit queue after the presentation receipt. */
  handoffGeneration(agent: Agent, control: CanvasControl, summary: string, graph: CanvasGraph) {
    this.assert(agent, control)
    const next: CanvasControl = { ...control, mode: 'manual', epoch: control.epoch + 1,
      updatedAt: Date.now(), reason: GENERATION_HANDOFF_REASON }
    this.ledger.setControl(next)
    this.videoSound.clear(agent)
    this.rememberManualInputs(agent); this.generationModels.clear(agent); this.revoked.add(agent.id)
    this.ledger.setHandoff(control.canvasId, hash(graph), summary, graph)
    for (const member of this.members.values()) if (member.rootId === agent.id && member.agent !== agent) member.agent.cancel({ kind: 'user' })
    for (const dispose of this.children.get(agent.id) ?? []) void dispose().catch(() => {})
    this.presentation.changed()
    return next
  }
  async takeover(canvasId: string, reason = '人工接管') {
    const c = this.control(canvasId)
    // Revoke synchronously before cancellation hooks or other awaited work.
    this.ledger.setControl({ ...c, mode: 'manual', epoch: c.epoch + 1, updatedAt: Date.now(), reason })
    this.presentation.changed()
    this.executionScheduler.changed()
    if (c.sessionId) {
      const main = this.members.get(c.sessionId)?.agent
      if (main) { this.rememberManualInputs(main); this.generationModels.clear(main); this.videoSound.clear(main) }
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
  async specialist(agent: Agent, key: string, args: unknown, operation: () => Promise<unknown>,
    options: { signal?: AbortSignal; resources?: Resources; group?: boolean } = {}) {
    const c = this.session(agent.id).canvas
    const valid = () => {
      if (this.member(agent).role !== 'main') throw new CanvasError('只有主 Agent 可以委派', 403, 'AGENT_FORBIDDEN')
      if (c) this.assert(agent, c)
      else if (this.session(agent.id).canvas) throw new CanvasError('委派期间画布已变化', 409, 'AGENT_REVIEW_STALE')
    }
    valid()
    const replay = this.ledger.receipt(key, args)
    if (replay) return replay.value
    this.ledger.receipt(`${key}:started`, args)
    const existing = this.specialistRuns.get(key)
    if (existing) return existing
    const scopeId = c?.canvasId ?? agent.id
    const work = (async () => {
      const release = options.group ? () => {} : await this.executionScheduler.acquire(scopeId,
        options.resources ?? { read: [], write: [] }, options.signal ?? new AbortController().signal, valid)
      try {
      await this.serial(async () => {
        valid()
        if (this.ledger.receipt(`${key}:started`, args)) throw new CanvasError('上次专业委派未取得完整结果，请核对后使用新操作 ID；不会自动重提', 409, 'SPECIALIST_INCOMPLETE')
        options.signal?.throwIfAborted()
        this.ledger.reserveReceipts([key, `${key}:started`])
        this.ledger.remember(`${key}:started`, args, { started: true })
        await this.ledger.persist()
      })
      const value = await operation()
      valid()
      this.ledger.remember(key, args, value); await this.ledger.persist()
      valid()
      return value
      } finally { release() }
    })()
    this.specialistRuns.set(key, work)
    try { return await work } finally { if (this.specialistRuns.get(key) === work) this.specialistRuns.delete(key) }
  }
  async manual(request: Request, operation: () => Promise<Response>) {
    if (request.method !== 'POST') return operation()
    const url = new URL(request.url), suffix = url.pathname.split('/').at(-1)!
    if (['media-urls', 'settings-secret', 'agent-control', 'agent-view', 'agent-presence', 'agent-presentation-ack', 'agent-reference-resolve'].includes(suffix)) return operation()
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
  async drain() { await this.queue; await this.ledger.persist(); await this.creative.persist(); await this.collaboration.persist(); await this.presentation.persist() }
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
      if (session.preset || ['canvas-creator', ...INTERNAL_CANVAS_PRESETS].includes(inspected.meta.agentPreset ?? ''))
        await coordinator.qualified(request.provider, request.model)
      return original.call(this, request)
    }
    controller.selectModel = guarded
    this.ctx.effect(() => () => { if (controller.selectModel === guarded) controller.selectModel = original })
  }
}
