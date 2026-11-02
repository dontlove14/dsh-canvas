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
import { CreativeDraftSchema, SpecialistRoleSchema, StepNote, DocumentSchema, GENERATION_HANDOFF_REMINDER, isGenerationHandoff, type CanvasControl } from '../../shared/agent'
import { AutoPlacementSchema, type PresentationIntent } from '../../shared/presentation'
import { CanvasNodeSchema, IdSchema, defaultParams } from '../../shared/contracts'
import { nodeFor } from '../../shared/nodeFactory'
import { connectAssetReference } from '../../shared/referenceConnection'
import { hash } from '../persistence/database'
import { CanvasError, detectMedia } from '../store'
import { submittedReferences } from './chatReferences'
import { METHODS, MAIN_PROMPT } from './methods'
import type { AgentMember } from './coordinator'
import type {} from './coordinator'
import { attachmentCatalog, readUserAttachment, verifiedAttachmentStream } from './attachments'
import { AgentWorkspace, type WorkspaceFile } from './workspace'
import { createAgentCanvas } from './catalog'
import { safeName, extension } from '../media/files'
import { choiceFor } from './modelSelection'

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
      const target = args.nodeId ?? args.target
      if (action && target && service.store.state(c.canvasId).graph.nodes.some((node) => node.id === target)) {
        await coordinator.presentation.publish(c, `${args.operationId}:working`, action,
          service.store.state(c.canvasId).graphRevision, [target])
      }
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
  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
    register(agent)
    // A fresh root-user message is a new delegation, not a replay of the
    // cancelled step. Restore before assembly/request guards inspect control.
    if (role === 'main') await coordinator.resumeForUserInput(agent, messages, signal)
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
      const modelContext = { models: coordinator.generationModels.catalog(),
        ...(role === 'main' ? { modelSelections: coordinator.generationModels.selections(agent) } : {}) }
      try {
        const c = coordinator.attached(agent), snapshot = service.store.state(c.canvasId)
        return JSON.stringify({ ...modelContext, control: c, revision: snapshot.graphRevision, handoff: coordinator.ledger.handoff(c.canvasId)?.summary,
          ...(role === 'main' ? { userMedia: attachmentCatalog(agent), userReferences: submittedReferences(agent), workspace: ctx.workingDirectory.get(agent.session) } : {}),
          drafts: coordinator.ledger.drafts(c.canvasId).slice(-12).map(({ id, kind, title, version }) => ({ id, kind, title, version })) })
      } catch { return JSON.stringify({ ...modelContext, hint: '尚未打开画布，请使用 canvas_open。',
        ...(role === 'main' ? { userMedia: attachmentCatalog(agent), userReferences: submittedReferences(agent), workspace: ctx.workingDirectory.get(agent.session) } : {}) }) }
    },
  })
  tool('canvas_inspect', '读取当前画布节点、引用、真实素材、任务摘要、模型能力及创作记录。首次打开前返回项目列表。', Empty, async (_args, exec) => {
    const root = coordinator.member(exec.agent).rootId
    const userMedia = role === 'main' ? attachmentCatalog(exec.agent) : []
    const userReferences = role === 'main' ? submittedReferences(exec.agent) : []
    const cwd = role === 'main' ? await workspace.root(exec.agent, exec.signal) : undefined
    const modelContext = { models: coordinator.generationModels.catalog(),
      ...(role === 'main' ? { modelSelections: coordinator.generationModels.selections(exec.agent) } : {}) }
    if (!coordinator.session(root).canvas) return { catalog: await service.store.catalog(), ...modelContext, userMedia, userReferences, ...(cwd ? { workspace: cwd } : {}) }
    const c = read(exec.agent), state = await service.store.snapshot(c.canvasId)
    return { ...state, control: c, presentation: coordinator.presentation.current(c.canvasId) ?? null, view: coordinator.presentation.view(c) ?? null,
      ...modelContext, tts: service.store.ttsSettings(), drafts: coordinator.ledger.drafts(c.canvasId).slice(-30), userMedia, userReferences, ...(cwd ? { workspace: cwd } : {}) }
  })
  tool('canvas_method', '按需读取专业制作方法；不向全局安装任何技能。', z.object({ role: SpecialistRoleSchema }).strict(), async ({ role }) => ({ method: METHODS[role] }))
  const viewImage = async (assetId: string, exec: BoundExec) => {
    const c = read(exec.agent), asset = service.store.state(c.canvasId).assets.find((a) => a.id === assetId)
    if (!asset || asset.kind !== 'image' || !['image/png', 'image/jpeg', 'image/webp'].includes(asset.mime)) throw new CanvasError('请选择 PNG、JPEG 或 WebP 图片')
    const locator = await service.store.locator(c.canvasId, assetId)
    if (locator.bytes > service.config.maxReferenceBytes) throw new CanvasError('图片超过理解输入大小限制', 413)
    if (role === 'main' && asset.nodeId) await coordinator.presentation.publish(c, `view:${crypto.randomUUID()}`, 'open',
      service.store.state(c.canvasId).graphRevision, [asset.nodeId])
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
  }
  tool('canvas_view_image', '把当前画布的真实图片作为原生多模态附件提供给下一次模型请求；视频与音频不可用此工具理解。', z.object({ assetId: IdSchema }).strict(), async ({ assetId }, exec) => viewImage(assetId, exec))
  tool('canvas_task', '查询原有持久任务的当前状态和结果；不会重新提交生成请求。', z.object({ taskId: IdSchema }).strict(), async ({ taskId }, exec) => {
    const c = read(exec.agent), detail = await service.store.taskDetail(c.canvasId, taskId)
    if (role === 'main' && detail.task) await coordinator.presentation.publish(c, `task:${taskId}:${detail.task.updatedAt}`, 'generate',
      service.store.state(c.canvasId).graphRevision, [detail.task.nodeId], taskId)
    const { snapshot: _snapshot, providerTaskId: _providerTaskId, ...task } = detail.task ?? {} as any
    return { kind: detail.kind, phase: detail.phase, failureCode: detail.failureCode, task }
  })
  if (role === 'main') {
    tool('canvas_select_model', '通过 Harness 原生单选卡片询问用户要使用的图片或视频模型及供应商，只提供当前已配置项。即使只有一项也要确认；当前有效选择可复用，用户要求更换时 change=true。不会提交生成任务。', z.object({
      kind: z.enum(['image', 'video']), change: z.boolean().default(false), ...StepNote,
    }).strict(), async ({ kind, change }, exec) => {
      const control = coordinator.session(exec.agent.id).canvas
      admission(exec)
      const current = coordinator.generationModels.current(exec.agent, kind)
      if (current && !change) return { approved: true, selection: current, reused: true }
      const token = coordinator.generationModels.begin(exec.agent, kind)
      const models = coordinator.generationModels.models(kind)
      if (!models.length) return { approved: false, needsConfiguration: true, models: [],
        hint: `当前没有已配置可用的${kind === 'image' ? '图片' : '视频'}模型，请让用户配置后再选择；不要指定未配置项。` }
      const id = `canvas-model-${kind}`
      const options = models.map((model) => {
        const choice = choiceFor(model)
        return { label: `${choice.name} · ${choice.providerName}`, description: `使用 ${choice.providerName} 的 ${choice.model}` }
      })
      const result = await ctx.userQuestions.ask({
        agent: exec.agent, signal: exec.signal, wait: { callId: exec.callId },
        questions: [{ id, header: kind === 'image' ? '图片模型' : '视频模型',
          question: `你打算使用哪个${kind === 'image' ? '图片' : '视频'}模型和供应商？`, multiSelect: false, options }],
      })
      admission(exec)
      if (control) coordinator.assert(exec.agent, control)
      else if (coordinator.session(exec.agent.id).canvas) throw new CanvasError('选择期间画布已变化，请重新询问用户', 409, 'AGENT_MODEL_SELECTION_STALE')
      const answer = result.answers.find((answer) => answer.id === id)
      const index = answer?.selected.length === 1 ? options.findIndex((option) => option.label === answer.selected[0]) : -1
      if (result.answers.length !== 1 || index < 0 || answer?.custom?.trim())
        return { approved: false, answers: result.answers }
      return { approved: true, selection: coordinator.generationModels.confirm(exec.agent, kind, token, models[index]), reused: false }
    })
    tool('canvas_read_reference', '读取用户通过 # 实际提交的素材或工作区文件；图片进入真实多模态上下文，文本有大小限制，视频/音频仅返回元数据与反馈。', z.object({ referenceId: z.string().regex(/^[a-f0-9]{64}$/) }).strict(), async ({ referenceId }, exec) => {
      const entry = submittedReferences(exec.agent).find((entry) => entry.referenceId === referenceId)
      if (!entry) throw new CanvasError('请从本会话 canvas_inspect 的 userReferences 选择', 403, 'REFERENCE_FORBIDDEN')
      const c = coordinator.session(exec.agent.id).canvas
      if (c) coordinator.assert(exec.agent, c, false)
      const ref = await coordinator.chatReferences.resolve(exec.agent.id, entry.ref, exec.signal)
      if (ref.kind === 'media') {
        const asset = service.store.state(ref.canvasId).assets.find((item) => item.id === ref.assetId)!
        if (asset.kind === 'image') return { referenceId, ref, ...await viewImage(asset.id, exec) }
        return { referenceId, ref, asset, understood: false, hint: '已定位这份原素材；视频与音频内容请结合用户反馈，不声称已观看或聆听。' }
      }
      const file = await coordinator.chatReferences.file(exec.agent, ref, exec.signal, true)
      if (c) coordinator.assert(exec.agent, c, false)
      const media = file.data && detectMedia(file.data.subarray(0, 512))
      if (file.data && media?.kind === 'image' && ['image/png', 'image/jpeg', 'image/webp'].includes(media.mime)) {
        const attachment = await ctx.attachments.saveImage({ data: file.data, mediaType: media.mime as 'image/png', name: ref.label })
        await coordinator.chatReferences.file(exec.agent, ref, exec.signal, false)
        if (c) coordinator.assert(exec.agent, c, false)
        exec.signal.throwIfAborted()
        exec.deferContext({ id: MessageId(crypto.randomUUID()), role: 'user', source, content: [
          { type: 'text', text: `用户 # 工作区图片：${ref.label}` }, { type: 'image', attachment },
        ] })
        return { referenceId, ref, admitted: true }
      }
      let text: string | undefined
      if (file.data && !media && !file.data.includes(0)) try { text = new TextDecoder('utf-8', { fatal: true }).decode(file.data) } catch { /* Binary files retain honest metadata. */ }
      return { referenceId, ref, bytes: file.pin.bytes, ...(text !== undefined ? { text, understood: true } : {
        understood: false, hint: '仅文件元数据；文件超过读取限制或不是受支持的文本/图片，不声称已理解其内容。',
      }) }
    })
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
    tool('canvas_open', '打开已有项目或创建一个新项目，并获得画布控制权；用户的新消息会自动恢复其当前画布，旧的被取消操作不自动重放。', z.object({
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
        guard()
        await coordinator.presentation.publish(c, `${args.operationId}:working`, 'import',
          service.store.state(c.canvasId).graphRevision, [started.nodeId])
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
      params: CanvasNodeSchema.shape.params.removeDefault().optional(),
    }).strict(), async (args, exec) => {
      const control = read(exec.agent)
      const placement = args.position ? { position: args.position, source: 'explicit' }
        : await coordinator.presentation.position(control, service.store.state(control.canvasId).graph, args.kind, args.placement ?? { group: args.kind === 'video-generation' ? 'shots' : args.kind === 'tts-generation' ? 'audio' : 'assets' }, exec.signal)
      return write(exec, args, async (c) => {
      const replay = await service.store.db.get('SELECT committed_revision FROM canvas_mutations WHERE canvas_id=? AND mutation_id=?', [c.canvasId, args.operationId])
      if (replay) return { nodeId: args.operationId, revision: replay.committed_revision }
      const state = service.store.state(c.canvasId)
      if (args.kind === 'tts-generation' && args.modelId) throw new CanvasError('FishTTS 节点不使用图片或视频模型')
      const model = args.modelId ? coordinator.generationModels.require(exec.agent, args.kind === 'video-generation' ? 'video' : 'image', args.modelId) : undefined
      const node = { ...nodeFor(state.graph, args.kind, placement.position, model), id: args.operationId, title: args.title, prompt: args.prompt, ...(args.params !== undefined ? { params: args.params } : {}) }
      await service.mutateGraph(c.canvasId, { mutationId: args.operationId, baseRevision: args.revision, nodes: [{ value: node, hash: hash(node) }], edges: [], deleteNodes: [], deleteEdges: [] }, () => {
        exec.signal.throwIfAborted(); coordinator.assert(exec.agent, c)
        if (model) coordinator.generationModels.require(exec.agent, model.kind as 'image' | 'video', model.id)
      })
      return { nodeId: node.id, revision: service.store.state(c.canvasId).graphRevision, placement }
    }, 'create')
    })
    tool('canvas_update_node', '修改节点名称、提示词、参数、模型或认可的实际结果；不能任意改素材归属。', z.object({
      ...Operation, nodeId: IdSchema, patch: z.object({
        title: CanvasNodeSchema.shape.title.optional(), prompt: CanvasNodeSchema.shape.prompt.removeDefault().optional(),
        params: CanvasNodeSchema.shape.params.removeDefault().optional(), modelId: CanvasNodeSchema.shape.modelId.removeDefault().optional(),
        position: CanvasNodeSchema.shape.position.optional(),
        selectedResultId: CanvasNodeSchema.shape.selectedResultId.removeDefault().optional(),
      }).strict(),
    }).strict(), (args, exec) => write(exec, args, async (c) => {
      const replay = await service.store.db.get('SELECT committed_revision FROM canvas_mutations WHERE canvas_id=? AND mutation_id=?', [c.canvasId, args.operationId])
      if (replay) return { nodeId: args.nodeId, revision: replay.committed_revision }
      const state = service.store.state(c.canvasId), current = state.graph.nodes.find((n) => n.id === args.nodeId)
      if (!current) throw new CanvasError('节点不存在')
      const node = CanvasNodeSchema.parse({ ...current, ...args.patch })
      const checkModel = () => {
        if (args.patch.modelId) {
          if (!['image-generation', 'video-generation'].includes(node.kind)) throw new CanvasError('只能为图片或视频生成节点选择模型')
          coordinator.generationModels.require(exec.agent, node.kind === 'video-generation' ? 'video' : 'image', node.modelId)
        }
      }
      checkModel()
      if (args.patch.modelId && args.patch.params === undefined && (node.modelId !== current.modelId || !node.params))
        node.params = defaultParams(coordinator.generationModels.require(exec.agent, node.kind === 'video-generation' ? 'video' : 'image', node.modelId))
      await service.mutateGraph(c.canvasId, { mutationId: args.operationId, baseRevision: args.revision, nodes: [{ value: node, hash: hash(node) }], edges: [], deleteNodes: [], deleteEdges: [] }, () => {
        exec.signal.throwIfAborted(); coordinator.assert(exec.agent, c); checkModel()
      })
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
    tool('canvas_handoff_generation', '图片或视频参数和引用填写完成后必须调用：定位对应节点，提醒用户检查或修改参数并亲自点击生成，立即交还画布。不会提交任务；回执后简短转告 reminder 并结束本轮操作。', z.object({
      ...Operation, nodeIds: z.array(IdSchema).min(1).max(100),
    }).strict(), async (args, exec) => {
      const c = coordinator.attached(exec.agent), key = `${c.canvasId}:generation-handoff:${args.operationId}`
      const prepared = await coordinator.serial(async () => {
        exec.signal.throwIfAborted()
        const receipt = coordinator.ledger.receipt(key, args)
        if (receipt) {
          const value = receipt.value as { control: CanvasControl }
          const current = coordinator.control(c.canvasId)
          if (!isGenerationHandoff(current) || current.sessionId !== exec.agent.id || current.epoch !== value.control.epoch)
            throw new CanvasError('该交接已结束，请读取当前画布，不重放旧交接', 409, 'AGENT_CONTROL_REVOKED')
          return { replay: receipt.value }
        }
        coordinator.assert(exec.agent, c)
        const state = service.store.state(c.canvasId)
        if (state.graphRevision !== args.revision) throw new CanvasError('画布已变化，请重新核对参数', 409, 'GRAPH_CONFLICT')
        if (new Set(args.nodeIds).size !== args.nodeIds.length) throw new CanvasError('交接节点不得重复')
        const nodes = args.nodeIds.map((id) => {
          const node = state.graph.nodes.find((node) => node.id === id)
          if (!node || !['image-generation', 'video-generation'].includes(node.kind)) throw new CanvasError('请选择已填写参数的图片或视频生成节点')
          const model = coordinator.generationModels.require(exec.agent, node.kind === 'video-generation' ? 'video' : 'image', node.modelId)
          return { nodeId: node.id, title: node.title, kind: node.kind, modelId: model.id }
        })
        coordinator.ledger.reserveReceipts([key, `${key}:input`])
        coordinator.ledger.receipt(`${key}:input`, args)
        coordinator.ledger.remember(`${key}:input`, args, { reserved: true })
        await coordinator.ledger.persist()
        coordinator.assert(exec.agent, c); exec.signal.throwIfAborted()
        const intent = await coordinator.presentation.publish(c, args.operationId, 'update', args.revision, args.nodeIds)
        return { nodes, intent }
      })
      if ('replay' in prepared) return prepared.replay
      const presentation = await coordinator.presentation.wait(prepared.intent!, exec.signal)
      return coordinator.serial(async () => {
        exec.signal.throwIfAborted(); coordinator.assert(exec.agent, c)
        const state = service.store.state(c.canvasId)
        if (state.graphRevision !== args.revision) throw new CanvasError('画布已变化，请重新核对参数', 409, 'GRAPH_CONFLICT')
        for (const node of prepared.nodes!) coordinator.generationModels.require(exec.agent, node.kind === 'video-generation' ? 'video' : 'image', node.modelId)
        const reminder = `请检查${prepared.nodes!.map((node) => `「${node.title}」`).join('、')}。${GENERATION_HANDOFF_REMINDER}`
        const control = coordinator.handoffGeneration(exec.agent, c, reminder, state.graph)
        const result = { handedOff: true, submitted: false, nodes: prepared.nodes, revision: args.revision, reminder, control, presentation }
        coordinator.ledger.remember(key, args, result)
        await coordinator.ledger.persist()
        return result
      })
    })
    tool('canvas_generate', '仅提交用户授权的 FishTTS 生成，或查询同一 operationId 已接受的历史任务。图片、视频必须用 canvas_handoff_generation 交给用户检查并点击生成，Agent 不得提交。不得重提失败或结果未知的任务。', z.object({
      ...Operation, nodeId: IdSchema,
    }).strict(), (args, exec) => write(exec, args, async (c) => {
      // Isolate generated request identities from manual requests and other canvases.
      const hex = hash({ namespace: 'canvas-agent-generation', canvasId: c.canvasId, operationId: args.operationId }).slice(0, 32)
      const requestId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`
      // Recover an accepted task even if the final tool receipt was interrupted.
      // This is a lookup, not a new model decision or paid submission.
      const replay = await service.store.db.get('SELECT task_id,request_hash FROM task_details WHERE request_id=?', [requestId])
      if (replay) {
        const task = service.store.state(c.canvasId).tasks.find((task) => task.id === replay.task_id)
        const tts = task?.snapshot.model.protocol === 'fish-tts'
        if (!task || replay.request_hash !== hash({ canvas: c.canvasId, nodeId: args.nodeId, revision: args.revision, ...(tts ? { tts: true } : {}) }))
          throw new CanvasError('请求 ID 已用于其他内容', 409, 'REQUEST_REUSED')
        return { taskId: task.id, status: task.status }
      }
      const node = service.store.state(c.canvasId).graph.nodes.find((n) => n.id === args.nodeId)
      if (!node || !['image-generation', 'video-generation', 'tts-generation'].includes(node.kind)) throw new CanvasError('请选择生成节点')
      if (node.kind !== 'tts-generation')
        throw new CanvasError('图片和视频请调用 canvas_handoff_generation，提醒用户检查参数并亲自点击生成；Agent 不提交任务', 409, 'AGENT_MANUAL_GENERATION_REQUIRED')
      const checkModel = () => {
        if (node.kind !== 'tts-generation') coordinator.generationModels.require(exec.agent, node.kind === 'video-generation' ? 'video' : 'image', node.modelId)
      }
      checkModel()
      coordinator.ledger.pinSubmission(requestId, c); await coordinator.ledger.persist()
      coordinator.assert(exec.agent, c); exec.signal.throwIfAborted()
      const task = await service.generate(c.canvasId, args.nodeId, args.revision, requestId, false, node.kind === 'tts-generation', () => {
        exec.signal.throwIfAborted(); coordinator.assert(exec.agent, c); checkModel()
      })
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
