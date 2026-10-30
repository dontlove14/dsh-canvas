import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-working-directory'
import { Readable } from 'node:stream'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'
import { CreativeDraftSchema, SpecialistRoleSchema, StepNote, DocumentSchema } from '../../shared/agent'
import { AutoPlacementSchema, type PresentationIntent } from '../../shared/presentation'
import { CanvasNodeSchema, IdSchema, nodeMediaKind } from '../../shared/contracts'
import { nodeFor } from '../../shared/nodeFactory'
import { connectAssetReference } from '../../shared/referenceConnection'
import { hash } from '../persistence/database'
import { CanvasError } from '../store'
import { METHODS, MAIN_PROMPT } from './methods'
import type { AgentMember } from './coordinator'
import type {} from './coordinator'
import { attachmentCatalog, readUserAttachment, verifiedAttachmentStream } from './attachments'
import { AgentWorkspace, type WorkspaceFile } from './workspace'
import { createAgentCanvas } from './catalog'
import { safeName, extension } from '../media/files'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap { 'canvas-agent': { kind: 'canvas-agent' } }
}
export const name = 'dsh-canvas-agent-preset'
export const inject = ['canvasAgent', 'tools', 'systemPrompt', 'agents', 'llm', 'subagents', 'attachments', 'userQuestions', 'workingDirectory']
export const Config = z.object({ role: z.union([z.literal('main'), SpecialistRoleSchema]).default('main') })
const Empty = z.object({}).strict()
const Operation = { operationId: IdSchema, revision: z.number().int().nonnegative(), ...StepNote }
const uuid = (input: unknown) => {
  const h = hash(input).slice(0, 32)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20)}`
}
const DraftOutput = { type: 'object' as const, properties: {
  kind: { type: 'string' as const, enum: ['brief', 'asset-spec', 'storyboard', 'shot-plan', 'audio-plan', 'review'] },
  // Native structured_output accepts a schema subset; bounds are checked by CreativeDraftSchema.
  title: { type: 'string' as const },
  content: { type: 'string' as const },
  dependencies: { type: 'array' as const, items: { type: 'string' as const } },
  assetIds: { type: 'array' as const, items: { type: 'string' as const } },
}, required: ['kind', 'title', 'content', 'dependencies', 'assetIds'], additionalProperties: false }
const source = { kind: 'canvas-agent' as const }
type BoundExec = ToolRunContext & { readonly agent: Agent }

export function apply(ctx: Context, input: { role?: AgentMember['role'] } = {}) {
  const { role } = Config.parse(input), coordinator = ctx.canvasAgent, service = coordinator.canvas
  const workspace = new AgentWorkspace(ctx)
  const admission = (exec: BoundExec) => {
    exec.signal.throwIfAborted(); coordinator.member(exec.agent)
    const c = coordinator.session(exec.agent.id).canvas
    if (c) coordinator.assert(exec.agent, c)
  }
  const projectFor = async (exec: BoundExec, control: ReturnType<typeof read> | null) => {
    const canvas = control && (await service.store.catalog()).canvases.find((item) => item.id === control.canvasId)
    const identity = { root: await workspace.root(exec.agent, exec.signal), id: canvas?.id ?? uuid(exec.agent.id) }
    const key = `workspace-project:${hash(identity)}`
    const pinned = coordinator.ledger.receipt(key, identity)?.value as { id: string; name: string } | undefined
    if (pinned) return pinned
    const project = { id: identity.id, name: canvas?.name ?? '会话方案' }
    coordinator.ledger.remember(key, identity, project); await coordinator.ledger.persist()
    return project
  }
  const document = async (exec: BoundExec, id: string, title: string, content: string, category: string, control?: ReturnType<typeof read>) => {
    const c = control ?? coordinator.session(exec.agent.id).canvas
    const project = await projectFor(exec, c)
    return workspace.publish(exec.agent, project, ['文档', category], `${safeName(title)}-${id}.md`,
      Readable.from([Buffer.from(content)]), 1024 * 1024, exec.signal, () => {
        admission(exec)
        if (c) coordinator.assert(exec.agent, c)
        else if (coordinator.session(exec.agent.id).canvas) throw new CanvasError('保存期间画布状态已变化，请核对方案', 409, 'AGENT_REVIEW_STALE')
      })
  }
  const checkFileReceipt = async (exec: BoundExec, value: unknown) => {
    const file = (value as { file?: WorkspaceFile })?.file
    if (file) await workspace.verify(exec.agent, file, exec.signal)
  }
  const tools: string[] = []
  const configured = new WeakMap<Agent, () => void>()
  const configure = (agent: Agent) => {
    if (configured.has(agent)) return
    const restriction = agent.ctx.tools.restrict({ allow: [...tools, ...(role === 'main' ? ['ask_user_question'] : [])] })
    const dispose = () => { restriction(); configured.delete(agent) }
    configured.set(agent, dispose)
    coordinator.trackRestriction(agent, role === 'main' ? 'canvas-creator' : `canvas-${role}`, dispose)
    ctx.effect(() => dispose)
  }
  const tool = <T extends z.ZodType>(name: string, description: string, schema: T, run: (args: z.infer<T>, exec: BoundExec) => Promise<unknown>) => {
    tools.push(name)
    ctx.tools.register({
      // Zod attaches non-enumerable ~standard metadata; Harness requires plain lossless JSON.
      name, description, parameters: JSON.parse(JSON.stringify(z.toJSONSchema(schema))),
      output: { schema: { type: 'object', properties: {}, additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: async (raw, exec) => {
        if (!exec.agent) throw new CanvasError('画布工具需要真实 Agent 身份', 403, 'AGENT_FORBIDDEN')
        coordinator.session(exec.agent.id)
        coordinator.member(exec.agent); exec.signal.throwIfAborted()
        const parsed = schema.parse(raw)
        // A different narration must not change the identity of the same business operation.
        if (parsed && typeof parsed === 'object') Reflect.deleteProperty(parsed, 'note')
        return run(parsed, exec as BoundExec)
      },
    })
  }
  const read = (agent: Agent) => { const c = coordinator.attached(agent); coordinator.assert(agent, c, false); return c }
  const write = async (exec: BoundExec, args: { operationId: string; nodeId?: string; target?: string }, run: (control: ReturnType<typeof read>) => Promise<unknown>, action?: PresentationIntent['action']) => {
    const c = read(exec.agent)
    const value = await coordinator.serial(async () => {
      exec.signal.throwIfAborted(); coordinator.assert(exec.agent, c)
      const key = `${c.canvasId}:${args.operationId}`, receipt = coordinator.ledger.receipt(key, args)
      if (receipt) { await checkFileReceipt(exec, receipt.value); return receipt.value }
      coordinator.ledger.reserveReceipts([key, `${key}:input`])
      coordinator.ledger.receipt(`${key}:input`, args)
      coordinator.ledger.remember(`${key}:input`, args, { reserved: true })
      await coordinator.ledger.persist()
      exec.signal.throwIfAborted(); coordinator.assert(exec.agent, c)
      const result = await run(c) as Record<string, unknown>
      if (action) {
        const intent = await coordinator.presentation.publish(c, args.operationId, action, service.store.state(c.canvasId).graphRevision,
          [args.nodeId ?? args.target ?? (result.nodeId as string | undefined) ?? (action === 'create' ? args.operationId : '')].filter(Boolean), result.taskId as string | undefined)
        result.presentationId = intent.id
      }
      coordinator.ledger.remember(key, args, result)
      await coordinator.ledger.persist()
      exec.signal.throwIfAborted(); coordinator.assert(exec.agent, c)
      return result
    }) as Record<string, unknown>
    if (!action) return value
    const intent = coordinator.presentation.current(c.canvasId)
    const presentation = intent && intent.id === value.presentationId
      ? await coordinator.presentation.wait(intent, exec.signal)
      : { id: value.presentationId, status: 'deferred', reason: '已由更新的操作替代，不重放旧操作' }
    return { ...value, presentation }
  }
  const register = (agent: Agent) => {
    const parent = role !== 'main' ? ctx.agents.list().find((candidate) => ctx.agents.isOwnedBy(agent.id, candidate)) : undefined
    if (role !== 'main' && !parent) throw new CanvasError('专业预设只能由主 Agent 调用', 403, 'AGENT_DRAFT_ONLY')
    if (parent && coordinator.member(parent).role !== 'main') throw new CanvasError('专业 Agent 不可再次委派', 403, 'AGENT_DRAFT_ONLY')
    coordinator.register(agent, role, parent?.id ?? agent.id)
    configure(agent)
  }
  ctx.on('agent/created', ({ agent }) => {
    register(agent)
    return undefined
  })
  ctx.on('agent/disposed', ({ agent }) => { coordinator.unregister(agent) })
  ctx.on('agent/request', async ({ agent, signal }, next) => {
    const config = await next()
    await coordinator.qualified(config.provider, config.model, signal)
    coordinator.setRoute(agent, config)
    if (role === 'main' && coordinator.session(agent.id).canvas) read(agent)
    return config
  })
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    register(agent)
    if (role === 'main' && coordinator.session(agent.id).canvas) read(agent)
    return next()
  })
  ctx.systemPrompt.suppressRuntimeContext()
  ctx.systemPrompt.section({
    name: 'deployment:persona-prefix', order: 0, interpolate: false,
    text: role === 'main' ? MAIN_PROMPT : `你是无限画布的 ${role} 专业子 Agent，只处理主 Agent 给定任务。独立上下文，不写画布、不生成付费任务、不再委派、不向用户提问。读必要的真实素材；完成后调用 structured_output，返回创作草稿，并明确未核验事实。\n${METHODS[role]}`,
  })
  ctx.systemPrompt.context({
    name: 'canvas:control', order: 50, required: true, interpolate: false,
    text: ({ agent }) => {
      if (!agent) return ''
      try {
        const c = coordinator.attached(agent), snapshot = service.store.state(c.canvasId)
        return JSON.stringify({ control: c, revision: snapshot.graphRevision, handoff: coordinator.ledger.handoff(c.canvasId)?.summary,
          ...(role === 'main' ? { userMedia: attachmentCatalog(agent), workspace: ctx.workingDirectory.get(agent.session) } : {}),
          drafts: coordinator.ledger.drafts(c.canvasId).slice(-12).map(({ id, kind, title, version }) => ({ id, kind, title, version })) })
      } catch { return role === 'main' ? JSON.stringify({ hint: '尚未打开画布，请使用 canvas_open。', userMedia: attachmentCatalog(agent), workspace: ctx.workingDirectory.get(agent.session) }) : '尚未打开画布，请使用 canvas_open。' }
    },
  })
  tool('canvas_inspect', '读取当前画布节点、引用、真实素材、任务摘要、模型能力及创作记录。首次打开前返回项目列表。', Empty, async (_args, exec) => {
    const root = coordinator.member(exec.agent).rootId
    const userMedia = role === 'main' ? attachmentCatalog(exec.agent) : []
    const cwd = role === 'main' ? await workspace.root(exec.agent, exec.signal) : undefined
    if (!coordinator.session(root).canvas) return { catalog: await service.store.catalog(), models: service.store.listModels(), userMedia, ...(cwd ? { workspace: cwd } : {}) }
    const c = read(exec.agent), state = await service.store.snapshot(c.canvasId)
    return { ...state, presentation: coordinator.presentation.current(c.canvasId) ?? null, view: coordinator.presentation.view(c) ?? null,
      models: service.store.listModels(), tts: service.store.ttsSettings(), drafts: coordinator.ledger.drafts(c.canvasId).slice(-30), userMedia, ...(cwd ? { workspace: cwd } : {}) }
  })
  tool('canvas_method', '按需读取专业制作方法；不向全局安装任何技能。', z.object({ role: SpecialistRoleSchema }).strict(), async ({ role }) => ({ method: METHODS[role] }))
  tool('canvas_view_image', '把当前画布的真实图片作为原生多模态附件提供给下一次模型请求；视频与音频不可用此工具理解。', z.object({ assetId: IdSchema }).strict(), async ({ assetId }, exec) => {
    const c = read(exec.agent), asset = service.store.state(c.canvasId).assets.find((a) => a.id === assetId)
    if (!asset || asset.kind !== 'image' || !['image/png', 'image/jpeg', 'image/webp'].includes(asset.mime)) throw new CanvasError('请选择 PNG、JPEG 或 WebP 图片')
    const locator = await service.store.locator(c.canvasId, assetId)
    if (locator.bytes > service.config.maxReferenceBytes) throw new CanvasError('图片超过理解输入大小限制', 413)
    const stream = await (await service.store.objects.adapter(locator.providerId, locator.credentialRef)).openRead(locator)
    const abort = () => stream.destroy(new Error('图片读取已取消'))
    exec.signal.addEventListener('abort', abort, { once: true })
    const chunks: Buffer[] = []; let bytes = 0
    try { for await (const chunk of stream) { exec.signal.throwIfAborted(); bytes += chunk.length; if (bytes > service.config.maxReferenceBytes) throw new CanvasError('图片过大', 413); chunks.push(Buffer.from(chunk)) } }
    finally { exec.signal.removeEventListener('abort', abort); stream.destroy() }
    const attachment = await ctx.attachments.saveImage({ data: Buffer.concat(chunks), mediaType: asset.mime as 'image/png', name: asset.filename })
    coordinator.assert(exec.agent, c, false); exec.signal.throwIfAborted()
    exec.deferContext({ id: MessageId(crypto.randomUUID()), role: 'user', source, content: [{ type: 'text', text: `画布图片 assetId=${assetId}` }, { type: 'image', attachment }] })
    return { assetId, admitted: true }
  })
  tool('canvas_task', '查询原有持久任务的当前状态和结果；不会重新提交生成请求。', z.object({ taskId: IdSchema }).strict(), async ({ taskId }, exec) => {
    const c = read(exec.agent), detail = await service.store.taskDetail(c.canvasId, taskId)
    const { snapshot: _snapshot, providerTaskId: _providerTaskId, ...task } = detail.task ?? {} as any
    return { kind: detail.kind, phase: detail.phase, failureCode: detail.failureCode, task }
  })
  if (role === 'main') {
    tool('canvas_review_plan', '用 Harness 原生方案审阅卡片展示完整 Markdown 方案，等待用户确认或修改意见；只审阅，不创建节点或提交生成任务。已有明确授权不重复审阅。', z.object({
      ...StepNote,
      plan: z.string().trim().min(1).max(32000),
      title: z.string().trim().min(1).max(160).default('创作方案'),
      question: z.string().trim().min(1).max(500).default('请审阅方案，确认后我会按方案继续。'),
    }).strict(), async ({ plan, title, question }, exec) => {
      const control = coordinator.session(exec.agent.id).canvas
      if (control) coordinator.assert(exec.agent, control)
      const file = await document(exec, uuid({ callId: exec.callId, plan, title }), title, plan, '方案', control ?? undefined)
      const id = 'canvas-plan', approve = '确认方案'
      const result = await ctx.userQuestions.ask({
        agent: exec.agent, signal: exec.signal, wait: { callId: exec.callId },
        questions: [{ id, header: title, question, detail: plan, multiSelect: false,
          options: [{ label: approve, description: '按这份方案继续' }, { label: '需要修改', description: '提出意见后再调整方案' }],
          // Native logged-plan lookup recognizes exit_plan_mode only. Keep
          // wait.callId for execution identity; detail owns our preview text.
          intent: { kind: 'plan-review', approve } }],
      })
      // A late answer cannot renew control or authorize work after a takeover.
      exec.signal.throwIfAborted()
      coordinator.member(exec.agent)
      if (control) coordinator.assert(exec.agent, control)
      else if (coordinator.session(exec.agent.id).canvas) throw new CanvasError('审阅期间画布状态已变化，请核对方案', 409, 'AGENT_REVIEW_STALE')
      const answer = result.answers.find((item) => item.id === id)
      const approved = result.answers.length === 1 && !!answer && answer.selected.length === 1 && answer.selected[0] === approve && !answer.custom?.trim()
      return { approved, answers: result.answers, file }
    })
    tool('canvas_open', '打开已有项目或创建一个新项目，并获得画布控制权；人工接管后的项目必须由用户重新委托。', z.object({
      canvasId: z.string().optional(), name: z.string().min(1).max(160).optional(), operationId: IdSchema, ...StepNote,
    }).strict().refine((a) => !!a.canvasId !== !!a.name, '提供 canvasId 或 name 之一'), async (args, exec) => {
      if (coordinator.session(exec.agent.id).canvas?.mode === 'manual') throw new CanvasError('请让用户重新委托画布', 409, 'AGENT_CONTROL_REVOKED')
      admission(exec)
      const created = args.canvasId ? undefined : await coordinator.serial(() => createAgentCanvas(service.store, coordinator.ledger, args.operationId, args.name!, () => admission(exec)))
      const id = args.canvasId ?? created!.id
      admission(exec)
      const control = await coordinator.delegate(id, exec.agent.id)
      const intent = await coordinator.presentation.publish(control, `open:${args.operationId}`, 'open', service.store.state(id).graphRevision, [])
      return { control, ...(created ?? {}), presentation: await coordinator.presentation.wait(intent, exec.signal) }
    })
    tool('canvas_import_attachment', '将当前用户会话提供的原始媒体导入画布。产品、人物或服装一致性要求优先使用真实参考；问题截图或单纯灵感不自动导入。导入任务成功后 inspect 获取 assetId 再 connect，不能以描述冒充真实参考。', z.object({
      ...Operation, attachmentId: z.string().min(1).max(200), kind: z.enum(['image', 'video', 'audio']),
      purpose: z.string().trim().min(1).max(500),
    }).strict(), (args, exec) => write(exec, args, async (c) => {
      const requestId = uuid({ namespace: 'canvas-user-attachment', canvas: c.canvasId, id: args.operationId })
      const guard = () => { exec.signal.throwIfAborted(); coordinator.assert(exec.agent, c) }
      const input = await readUserAttachment(ctx, exec.agent, args.attachmentId, service.config.maxMediaBytes, exec.signal)
      try {
        const body = await verifiedAttachmentStream(input.body, args.kind, exec.signal)
        const placement = await coordinator.presentation.position(c, service.store.state(c.canvasId).graph, `${args.kind}-asset`, { group: 'assets' }, exec.signal)
        const key = `${c.canvasId}:attachment-input:${args.operationId}`, pinned = coordinator.ledger.receipt(key, args)?.value as { requestId: string; filename: string; kind: 'image' | 'video' | 'audio'; position: { x: number; y: number } } | undefined
        const startInput = pinned ?? { requestId, filename: input.filename, kind: args.kind, position: placement.position }
        coordinator.ledger.remember(key, args, startInput); await coordinator.ledger.persist()
        const started = await service.runtime.uploads.start(c.canvasId, startInput, guard)
        const accepted = await service.runtime.uploads.accept(c.canvasId, started.id, body, args.kind, input.filename, exec.signal, guard)
        return { ...accepted, status: 'queued', purpose: args.purpose, referenceReady: false }
      } finally { input.body.destroy() }
    }, 'import'))
    tool('canvas_document', '把额外创作 Markdown 文档保存到当前工作区的项目文档分类目录；不接受任意路径、不覆盖用户文件。', z.object({
      operationId: IdSchema, document: DocumentSchema, ...StepNote,
    }).strict(), (args, exec) => write(exec, args, async (c) => ({
      file: await document(exec, args.operationId, args.document.title, args.document.content, args.document.category, c),
    })))
    tool('canvas_export_media', '仅当用户明确要求下载时，把当前画布真实素材下载到当前工作区项目的媒体分类目录。不会生成新任务或默认下载所有媒体。', z.object({
      operationId: IdSchema, assetId: IdSchema, userRequest: z.string().trim().min(1).max(500), ...StepNote,
    }).strict(), (args, exec) => write(exec, args, async (c) => {
      const asset = service.store.state(c.canvasId).assets.find((a) => a.id === args.assetId)
      if (!asset) throw new CanvasError('素材不存在', 404)
      const project = await projectFor(exec, c)
      const locator = await service.store.locator(c.canvasId, args.assetId)
      if (locator.bytes > service.config.maxMediaBytes) throw new CanvasError('媒体超过下载大小限制', 413, 'MEDIA_TOO_LARGE')
      const body = await (await service.store.objects.adapter(locator.providerId, locator.credentialRef)).openRead(locator)
      const file = await workspace.publish(exec.agent, project, ['媒体', { image: '图片', video: '视频', audio: '音频' }[asset.kind]],
        `${safeName(asset.filename.replace(/\.[^.]+$/, ''))}-${asset.id}${extension(asset.mime)}`, body, service.config.maxMediaBytes, exec.signal,
        () => { exec.signal.throwIfAborted(); coordinator.assert(exec.agent, c) }, locator)
      return { assetId: asset.id, file }
    }))
    tool('canvas_create_node', '创建图片、视频或 FishTTS 节点。默认按实际视野和固定起点避让排布；placement 可指定组或相关节点，明确坐标时可提供 position。revision 从 inspect 获取，同一操作重试复用 operationId。', z.object({
      ...Operation, kind: z.enum(['image-generation', 'video-generation', 'tts-generation']),
      title: z.string().min(1).max(160), prompt: z.string().max(32000), modelId: IdSchema.optional(),
      position: z.object({ x: z.number().finite(), y: z.number().finite() }).strict().optional(),
      placement: AutoPlacementSchema.optional(),
      params: CanvasNodeSchema.shape.params.optional(),
    }).strict(), async (args, exec) => {
      const control = read(exec.agent)
      const placement = args.position ? { position: args.position, source: 'explicit' }
        : await coordinator.presentation.position(control, service.store.state(control.canvasId).graph, args.kind, args.placement ?? { group: args.kind === 'video-generation' ? 'shots' : args.kind === 'tts-generation' ? 'audio' : 'assets' }, exec.signal)
      return write(exec, args, async (c) => {
      const replay = await service.store.db.get('SELECT committed_revision FROM canvas_mutations WHERE canvas_id=? AND mutation_id=?', [c.canvasId, args.operationId])
      if (replay) return { nodeId: args.operationId, revision: replay.committed_revision }
      const state = service.store.state(c.canvasId), model = args.modelId ? service.store.listModels().find((m) => m.id === args.modelId) : undefined
      if (args.modelId && !model) throw new CanvasError('模型不存在')
      if (model && model.kind !== nodeMediaKind(args.kind)) throw new CanvasError('模型类型与节点不一致')
      const node = { ...nodeFor(state.graph, args.kind, placement.position, model), id: args.operationId, title: args.title, prompt: args.prompt, ...(args.params !== undefined ? { params: args.params } : {}) }
      await service.mutateGraph(c.canvasId, { mutationId: args.operationId, baseRevision: args.revision, nodes: [{ value: node, hash: hash(node) }], edges: [], deleteNodes: [], deleteEdges: [] }, () => { exec.signal.throwIfAborted(); coordinator.assert(exec.agent, c) })
      return { nodeId: node.id, revision: service.store.state(c.canvasId).graphRevision, placement }
    }, 'create')
    })
    tool('canvas_update_node', '修改节点名称、提示词、参数、模型或认可的实际结果；不能任意改素材归属。', z.object({
      ...Operation, nodeId: IdSchema, patch: z.object({
        title: CanvasNodeSchema.shape.title.optional(), prompt: CanvasNodeSchema.shape.prompt.optional(),
        params: CanvasNodeSchema.shape.params.optional(), modelId: CanvasNodeSchema.shape.modelId.optional(),
        position: CanvasNodeSchema.shape.position.optional(),
        selectedResultId: CanvasNodeSchema.shape.selectedResultId.optional(),
      }).strict(),
    }).strict(), (args, exec) => write(exec, args, async (c) => {
      const replay = await service.store.db.get('SELECT committed_revision FROM canvas_mutations WHERE canvas_id=? AND mutation_id=?', [c.canvasId, args.operationId])
      if (replay) return { nodeId: args.nodeId, revision: replay.committed_revision }
      const state = service.store.state(c.canvasId), current = state.graph.nodes.find((n) => n.id === args.nodeId)
      if (!current) throw new CanvasError('节点不存在')
      const node = CanvasNodeSchema.parse({ ...current, ...args.patch })
      await service.mutateGraph(c.canvasId, { mutationId: args.operationId, baseRevision: args.revision, nodes: [{ value: node, hash: hash(node) }], edges: [], deleteNodes: [], deleteEdges: [] }, () => { exec.signal.throwIfAborted(); coordinator.assert(exec.agent, c) })
      return { nodeId: node.id, revision: service.store.state(c.canvasId).graphRevision }
    }, 'update'))
    tool('canvas_connect', '把真实素材引用连接到生成节点，保持资产图片与视频镜头的一致性。输入能力由现有验证规则检查。', z.object({
      ...Operation, source: IdSchema, target: IdSchema, assetId: IdSchema,
    }).strict(), (args, exec) => write(exec, args, async (c) => {
      const edge = { id: args.operationId, source: args.source, target: args.target, assetId: args.assetId }
      const state = service.store.state(c.canvasId)
      if (!state.graph.edges.some((e) => e.id === edge.id))
        connectAssetReference(state.graph, args.source, args.target, args.assetId, state.assets, state.tasks, service.store.listModels(), edge.id)
      await service.mutateGraph(c.canvasId, { mutationId: args.operationId, baseRevision: args.revision, nodes: [], edges: [{ value: edge, hash: hash(edge) }], deleteNodes: [], deleteEdges: [] }, () => { exec.signal.throwIfAborted(); coordinator.assert(exec.agent, c) })
      return { edgeId: edge.id, revision: service.store.state(c.canvasId).graphRevision }
    }, 'connect'))
    tool('canvas_generate', '按用户授权提交一次图片、视频或 FishTTS 生成。复用 operationId 防重复，返回 taskId 后通过 canvas_task 查询。不得自动重提失败或结果未知的任务。', z.object({
      ...Operation, nodeId: IdSchema,
    }).strict(), (args, exec) => write(exec, args, async (c) => {
      // Isolate generated request identities from manual requests and other canvases.
      const hex = hash({ namespace: 'canvas-agent-generation', canvasId: c.canvasId, operationId: args.operationId }).slice(0, 32)
      const requestId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`
      coordinator.ledger.pinSubmission(requestId, c); await coordinator.ledger.persist()
      coordinator.assert(exec.agent, c); exec.signal.throwIfAborted()
      const node = service.store.state(c.canvasId).graph.nodes.find((n) => n.id === args.nodeId)
      const task = await service.generate(c.canvasId, args.nodeId, args.revision, requestId, false, node?.kind === 'tts-generation', () => { exec.signal.throwIfAborted(); coordinator.assert(exec.agent, c) })
      return { taskId: task.id, status: task.status }
    }, 'generate'))
    tool('canvas_draft', '持久保存简报、资产规格及版本、分镜板、镜头依赖、音频计划或审查记录。依赖指向实际草稿 ID，保持旧画布数据结构。', z.object({
      operationId: IdSchema, draft: CreativeDraftSchema, ...StepNote,
    }).strict(), (args, exec) => write(exec, args, async (c) => {
      const state = service.store.state(c.canvasId)
      if (args.draft.assetIds.some((id) => !state.assets.some((a) => a.id === id))) throw new CanvasError('创作记录引用了不存在的素材')
      const draft = coordinator.ledger.draft(args.draft, c, state.graphRevision, exec.agent.id, args.operationId)
      await coordinator.ledger.persist()
      const category = { brief: '简报', 'asset-spec': '资产', storyboard: '分镜', 'shot-plan': '镜头', 'audio-plan': '音频', review: '审查' }[draft.kind]
      const file = await document(exec, draft.id, draft.title, `# ${draft.title}\n\n${draft.content}\n\n版本：${draft.version}\n记录 ID：${draft.id}\n素材：${draft.assetIds.join(', ')}\n依赖：${draft.dependencies.join(', ')}\n`, category, c)
      return { draft, file }
    }))
    tool('canvas_specialist', '按需启动一层独立专业子 Agent。只返回结构化草稿，由主 Agent 核对并提交；一次委派不得再次委派。', z.object({
      operationId: IdSchema, role: SpecialistRoleSchema, task: z.string().min(1).max(24000), ...StepNote,
    }).strict(), async (args, exec) => {
      const c = read(exec.agent)
      const key = `${c.canvasId}:specialist:${args.operationId}`
      const value = await coordinator.specialist(exec.agent, key, args, async () => {
      const state = service.store.state(c.canvasId)
      const child = await ctx.subagents.startActivation({ provider: 'spawn', delivery: 'caller', signal: exec.signal, label: args.role,
        request: { parent: exec.agent, agentPreset: `canvas-${args.role}`, agentOptions: coordinator.route(exec.agent), maxDepth: 1, outputSchema: DraftOutput,
          prompt: [{ type: 'text', text: JSON.stringify({ task: args.task, canvasId: c.canvasId, revision: state.graphRevision,
            facts: { nodes: state.graph.nodes, assets: state.assets, drafts: coordinator.ledger.drafts(c.canvasId).slice(-20) } }) }] } })
      const childAgent = ctx.agents.get(child.childId)
      if (!childAgent) { await child.dispose(); throw new CanvasError('专业 Agent 未正确挂载') }
      coordinator.register(childAgent, args.role, exec.agent.id)
      const detach = coordinator.trackChild(exec.agent.id, () => child.dispose())
      const abort = () => { void child.dispose().catch(() => {}) }
      exec.signal.addEventListener('abort', abort, { once: true })
      try {
        const result = await child.result
        exec.signal.throwIfAborted(); coordinator.assert(exec.agent, c)
        if (result.stopReason !== 'completed' || !result.structured) throw new CanvasError('专业 Agent 未完成有效草稿，请核对后决定是否重新委派', 409, 'SPECIALIST_INCOMPLETE')
        const draft = CreativeDraftSchema.parse(result.structured)
        const file = await document(exec, args.operationId, draft.title, `# ${draft.title}\n\n${draft.content}\n\n专业草稿：${args.role}；尚待主 Agent 核对。\n`, '其他', c)
        const value = { draft, file, baseRevision: state.graphRevision, stale: service.store.state(c.canvasId).graphRevision !== state.graphRevision }
        return value
      } finally { exec.signal.removeEventListener('abort', abort); detach(); await child.dispose() }
      })
      await checkFileReceipt(exec, value)
      return value
    })
  }
  // A preset's own tools are exempt from inherited restrictions, so execution guards also enforce the same list.
  const allowed = new Set([...tools, ...(role === 'main' ? ['ask_user_question'] : ['structured_output'])])
  ctx.tools.guard((exec) => allowed.has(exec.name) ? undefined : '当前创作预设不开放此能力')
}
