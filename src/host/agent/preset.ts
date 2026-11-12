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
import { AgentRoleSchema, CreativeDraftSchema, SpecialistRoleSchema, StepNote, DocumentSchema, GENERATION_HANDOFF_REMINDER, isGenerationHandoff, type CanvasControl } from '../../shared/agent'
import { type PresentationIntent } from '../../shared/presentation'
import { CanvasNodeSchema, IdSchema, defaultParams, type Asset } from '../../shared/contracts'
import { nodeFor } from '../../shared/nodeFactory'
import { connectAssetReference } from '../../shared/referenceConnection'
import { hash } from '../persistence/database'
import { CanvasError, detectMedia } from '../store'
import { submittedReferences } from './chatReferences'
import { METHODS, MAIN_PROMPT, EXECUTOR_PROMPT } from './methods'
import { EXECUTION_SCHEMAS, ReferenceExclusionsSchema, executionIntent, type ExecutionCommand } from '../../shared/execution'
import { installCreativeTools } from './creativeTools'
import { installDelegationTools } from './delegation'
import { installVoiceTools } from './voiceTools'
import { ChatAudioHandleSchema } from '../../shared/chatAudio'
import type { AgentMember } from './coordinator'
import type {} from './coordinator'
import { attachmentCatalog, readUserAttachment, verifiedAttachmentStream } from './attachments'
import { AgentWorkspace, type WorkspaceFile } from './workspace'
import { createAgentCanvas } from './catalog'
import { safeName, documentName, extension } from '../media/files'
import { choiceFor } from './modelSelection'
import { ReferenceCatalog } from '../../shared/referenceCatalog'
import { WorkspaceIdSchema } from '../../shared/contracts'
import { promptReference, promptReferenceCatalog, referenceDependencyCatalog, referencedNode, validateAgentGeneration } from './references'
import { isMultimodalVideo } from '../../shared/modelCatalog'
import { isTtsParams, validateGraph } from '../../shared/contracts'
import { videoGenerationParams } from '../../shared/video'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap { 'canvas-agent': { kind: 'canvas-agent' } }
}
export const name = 'dsh-canvas-agent-preset'
export const inject = ['canvasAgent', 'tools', 'systemPrompt', 'agents', 'llm', 'subagents', 'attachments', 'userQuestions', 'workingDirectory']
export const Config = z.object({ role: AgentRoleSchema.default('main') })
const Empty = z.object({}).strict()
const Operation = { operationId: IdSchema, revision: z.number().int().nonnegative(),
  canvasId: WorkspaceIdSchema.optional(), referenceId: z.string().regex(/^[a-f0-9]{64}$/).optional(), ...StepNote }
const uuid = (input: unknown) => {
  const h = hash(input).slice(0, 32)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20)}`
}
const source = { kind: 'canvas-agent' as const }
type BoundExec = ToolRunContext & { readonly agent: Agent }

export function apply(ctx: Context, input: { role?: AgentMember['role'] } = {}) {
  const { role } = Config.parse(input), coordinator = ctx.canvasAgent, service = coordinator.canvas
  const workspace = new AgentWorkspace(ctx)
  const rootAgent = (exec: BoundExec) => coordinator.rootAgent(exec.agent)
  const admission = (exec: BoundExec) => {
    exec.signal.throwIfAborted(); coordinator.member(exec.agent)
    const c = coordinator.session(rootAgent(exec).id).canvas
    if (c) coordinator.assert(exec.agent, c, role === 'main')
  }
  const projectFor = async (exec: BoundExec, control: ReturnType<typeof read> | null) => {
    const canvas = control && (await service.store.catalog()).canvases.find((item) => item.id === control.canvasId)
    const project = coordinator.creative.project(rootAgent(exec).id, await workspace.root(rootAgent(exec), exec.signal), canvas?.id, canvas?.name)
    await coordinator.creative.persist()
    return project
  }
  const document = async (exec: BoundExec, id: string, title: string, content: string, category: string, control?: ReturnType<typeof read>, workspaceRoot?: string) => {
    const c = control ?? coordinator.session(rootAgent(exec).id).canvas
    const project = await projectFor(exec, c)
    return workspace.publish(rootAgent(exec), project, ['文档', category], documentName(title, id),
      Readable.from([Buffer.from(content)]), 1024 * 1024, exec.signal, () => {
        admission(exec)
        if (c) coordinator.assert(exec.agent, c, role === 'main' || role === 'executor')
        else if (coordinator.session(rootAgent(exec).id).canvas) throw new CanvasError('保存期间画布状态已变化，请核对方案', 409, 'AGENT_REVIEW_STALE')
      }, undefined, workspaceRoot)
  }
  const checkFileReceipt = async (exec: BoundExec, value: unknown) => {
    const file = (value as { file?: WorkspaceFile })?.file
    if (file) await workspace.verify(rootAgent(exec), file, exec.signal)
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
  const referenceTarget = (exec: BoundExec, c: CanvasControl, args: { canvasId?: string; referenceId?: string }, targets: string[]) => {
    if (args.canvasId && args.canvasId !== c.canvasId) throw new CanvasError('引用目标不在当前受控画布，请先完成画布委托', 409, 'AGENT_SESSION_BUSY')
    const refs = submittedReferences(rootAgent(exec))
    if (args.referenceId) {
      const entry = refs.find((entry) => entry.referenceId === args.referenceId)
      if (!entry || entry.ref.kind !== 'node' || !targets.includes(entry.ref.nodeId))
        throw new CanvasError('操作目标与已提交节点引用不一致', 403, 'REFERENCE_FORBIDDEN')
      if (entry.ref.canvasId !== c.canvasId) throw new CanvasError('请先委托引用所在画布，再修改该节点', 409, 'AGENT_SESSION_BUSY')
    }
    for (const id of targets) {
      const matching = refs.filter((entry) => entry.ref.kind === 'node' && entry.ref.nodeId === id)
      if (matching.length && !matching.some((entry) => entry.ref.kind === 'node' && entry.ref.canvasId === c.canvasId))
        throw new CanvasError('节点引用属于其他画布，请先完成委托', 409, 'AGENT_SESSION_BUSY')
      if (!args.referenceId && matching.some((entry) => entry.ref.kind === 'node' && entry.ref.canvasId !== c.canvasId) &&
        matching.some((entry) => entry.ref.kind === 'node' && entry.ref.canvasId === c.canvasId))
        throw new CanvasError('同名身份在多个画布出现，请提供目标 referenceId', 403, 'REFERENCE_FORBIDDEN')
    }
  }
  const write = async (exec: BoundExec, args: { operationId: string; revision?: number; nodeId?: string; target?: string; source?: string; canvasId?: string; referenceId?: string; references?: { source: string; assetId: string }[] }, run: (control: ReturnType<typeof read>) => Promise<unknown>, action?: PresentationIntent['action']) => {
    const c = read(exec.agent)
    const executionTool = {
      create: 'canvas_create_node', update: 'canvas_update_node', connect: 'canvas_connect',
      import: 'canvas_import_attachment', generate: 'canvas_generate',
    }[action as 'create' | 'update' | 'connect' | 'import' | 'generate'] ?? ''
    const executionKey = `${c.canvasId}:execution:${args.operationId}`, commandIntent = { tool: executionTool, input: executionIntent(args) }
    if (role === 'executor') coordinator.assertExecution(exec.agent, executionTool, args)
    const targets = [args.nodeId, args.target, args.source, ...args.references?.map((ref) => ref.source) ?? []].filter((id): id is string => !!id)
    referenceTarget(exec, c, args, targets)
    const operation = async () => {
      exec.signal.throwIfAborted(); coordinator.assert(exec.agent, c)
      if (role === 'executor') {
        coordinator.assertExecution(exec.agent, executionTool, args)
        const replay = coordinator.ledger.receipt(executionKey, commandIntent)
        if (replay) {
          const saved = replay.value as { result: Record<string, unknown>; inputRevision: number }
          if (executionTool === 'canvas_generate' && saved.inputRevision !== args.revision) throw new CanvasError('生成操作 ID 绑定原始任务快照，不能改变修订', 409, 'REQUEST_REUSED')
          return saved.result
        }
      }
      if (role === 'executor' && action !== 'import') {
        const revision = coordinator.executionRevision(exec.agent, executionTool, args)
        if (action !== 'generate') args.revision = revision
      }
      referenceTarget(exec, c, args, targets)
      const key = `${c.canvasId}:${args.operationId}`, receipt = coordinator.ledger.receipt(key, args)
      if (receipt) { await checkFileReceipt(exec, receipt.value); return receipt.value }
      coordinator.ledger.reserveReceipts([key, `${key}:input`, ...(role === 'executor' ? [executionKey] : [])])
      coordinator.ledger.receipt(`${key}:input`, args)
      coordinator.ledger.remember(`${key}:input`, args, { reserved: true })
      await coordinator.ledger.persist()
      exec.signal.throwIfAborted(); coordinator.assert(exec.agent, c)
      const target = args.nodeId ?? args.target
      const cursor = (phase: 'started' | 'committed' | 'failed', result?: Record<string, unknown>) => {
        if (role !== 'executor' || !action || action === 'open') return
        const state = service.store.state(c.canvasId), nodeId = target ?? result?.nodeId as string | undefined
        const node = state.graph.nodes.find((node) => node.id === nodeId)
        const raw = args as unknown as { patch?: { position?: { x: number; y: number }; prompt?: string; title?: string }; position?: { x: number; y: number } }
        const placement = result?.placement as { position?: { x: number; y: number } } | undefined
        const point = raw.patch?.position ?? node?.position ?? placement?.position ?? raw.position
        if (!point) return
        const source = state.graph.nodes.find((node) => node.id === args.source)
        coordinator.presentation.operation(exec.agent.id, { operationId: args.operationId, action, phase,
          point: { x: point.x + (action === 'connect' ? 0 : 36), y: point.y + (action === 'connect' ? 90 : 28) },
          ...(source ? { from: { x: source.position.x + 320, y: source.position.y + 90 } } :
            raw.patch?.position && node ? { from: { x: node.position.x + 36, y: node.position.y + 28 } } : {}),
          text: action === 'update' && (raw.patch?.prompt !== undefined || raw.patch?.title !== undefined),
          nodeIds: [nodeId].filter((id): id is string => !!id), graphRevision: state.graphRevision })
      }
      if (action !== 'create' && action !== 'import') cursor('started')
      if (action && target && service.store.state(c.canvasId).graph.nodes.some((node) => node.id === target)) {
        if (role !== 'executor' || coordinator.presentation.followsExecutor(c.canvasId, exec.agent.id)) await coordinator.presentation.publish(c, `${args.operationId}:working`, action,
          service.store.state(c.canvasId).graphRevision, [target])
      }
      let result: Record<string, unknown>
      try { result = await run(c) as Record<string, unknown> }
      catch (error) { cursor('failed'); throw error }
      cursor('committed', result)
      if (action && (role !== 'executor' || coordinator.presentation.followsExecutor(c.canvasId, exec.agent.id))) {
        const intent = await coordinator.presentation.publish(c, args.operationId, action, service.store.state(c.canvasId).graphRevision,
          [args.nodeId ?? args.target ?? (result.nodeId as string | undefined) ?? (action === 'create' ? args.operationId : '')].filter(Boolean), result.taskId as string | undefined)
        result.presentationId = intent.id
      }
      coordinator.ledger.remember(key, args, result)
      if (role === 'executor') {
        coordinator.executionCommitted(exec.agent, { tool: executionTool, input: args } as ExecutionCommand)
        coordinator.ledger.remember(executionKey, commandIntent, { result, inputRevision: args.revision })
        const binding = coordinator.binding(exec.agent)
        coordinator.creative.update(binding.projectId, binding.taskId, 'running', `已完成 ${executionTool} ${args.operationId}`)
        await coordinator.creative.persist()
      }
      await coordinator.ledger.persist()
      if (role === 'executor') {
        coordinator.collaboration.receipt(exec.agent.id, args.operationId, executionTool, result)
        await coordinator.collaboration.persist()
      }
      exec.signal.throwIfAborted(); coordinator.assert(exec.agent, c)
      return result
    }
    // Uploads own guarded Store transactions; network reads never occupy the
    // graph queue. Their executor lease conservatively owns the whole graph.
    const value = await (action === 'import' ? operation() : coordinator.serial(operation)) as Record<string, unknown>
    if (!action) return value
    const intent = coordinator.presentation.current(c.canvasId)
    const presentation = intent && intent.id === value.presentationId
      ? await coordinator.presentation.wait(intent, exec.signal)
      : { id: String(value.presentationId ?? `${c.epoch}:${args.operationId}`), status: 'deferred', reason: '已由更新的操作替代，不重放旧操作' }
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
    text: role === 'main' ? MAIN_PROMPT : role === 'executor' ? EXECUTOR_PROMPT : `你是无限画布的 ${role} 专业子 Agent，只处理主 Agent 给定任务。独立上下文，不写画布、不生成付费任务、不再委派、不向用户提问。用 creative_source_index / creative_source_read 分页读取授权原文，用 creative_artifact_read 读取必要成果，分批用 creative_artifact_save 保存原文定位、依赖和进度；不把未读章节当成已分析。需要用户决定时在成果中标明缺口。taskId仅标识批次，不能作为新成果artifactId；每份新成果使用独立UUID，重试同一内容沿用原artifactId。完成后调用 structured_output({"result":{"artifactId":"最终成果保存回执中的ID","summary":"简短交接说明"}})，只交接本批次已保存的最终成果，不重复输出全文。尚未保存时才返回result内完整草稿kind/title/content/dependencies/assetIds。\n${METHODS[role]}`,
  })
  ctx.systemPrompt.context({
    name: 'canvas:control', order: 50, required: true, interpolate: false,
    text: ({ agent }) => {
      if (!agent) return ''
      const modelContext = { models: coordinator.generationModels.catalog(),
        ...(['main', 'executor'].includes(role) ? { modelSelections: coordinator.generationModels.selections(coordinator.rootAgent(agent)) } : {}) }
      try {
        const c = coordinator.attached(agent), snapshot = service.store.state(c.canvasId)
        return JSON.stringify({ ...modelContext, control: c, revision: snapshot.graphRevision, handoff: coordinator.ledger.handoff(c.canvasId)?.summary,
          ...(role === 'main' ? { userMedia: attachmentCatalog(agent), userReferences: submittedReferences(agent), workspace: ctx.workingDirectory.get(agent.session) } : {}),
          ...(role === 'main' ? { drafts: coordinator.ledger.drafts(c.canvasId).slice(-12).map(({ id, kind, title, version }) => ({ id, kind, title, version })) } : { binding: coordinator.binding(agent) }) })
      } catch { return JSON.stringify({ ...modelContext, hint: '尚未打开画布，请使用 canvas_open。',
        ...(role === 'main' ? { userMedia: attachmentCatalog(agent), userReferences: submittedReferences(agent), workspace: ctx.workingDirectory.get(agent.session) } : {}) }) }
    },
  })
  tool('canvas_inspect', '只读当前画布；可用 nodeIds/assetIds 限定读取。referenceDependencies 是成果当时实际参考，不以当前连线或最新输出代替；首次打开前返回项目列表。', z.object({
    nodeIds: z.array(IdSchema).min(1).max(100).optional(), assetIds: z.array(IdSchema).min(1).max(100).optional(),
  }).strict(), async (args, exec) => {
    const root = coordinator.member(exec.agent).rootId
    const userMedia = role === 'main' ? attachmentCatalog(exec.agent) : []
    const userReferences = role === 'main' ? submittedReferences(exec.agent) : []
    const cwd = role === 'main' ? await workspace.root(exec.agent, exec.signal) : undefined
    const modelContext = { models: coordinator.generationModels.catalog(),
      ...(['main', 'executor'].includes(role) ? { modelSelections: coordinator.generationModels.selections(rootAgent(exec)) } : {}) }
    if (!coordinator.session(root).canvas) return { catalog: await service.store.catalog(), ...modelContext, userMedia, userReferences, ...(cwd ? { workspace: cwd } : {}) }
    const c = read(exec.agent), state = await service.store.snapshot(c.canvasId)
    const raw = service.store.state(c.canvasId)
    if (raw.graphRevision !== state.graphRevision) throw new CanvasError('读取期间画布已变化，请重新读取', 409, 'GRAPH_CONFLICT')
    const references = promptReferenceCatalog(raw), dependencies = referenceDependencyCatalog(raw)
    if (role !== 'main' && role !== 'executor') {
      const binding = coordinator.binding(exec.agent)
      if (args.nodeIds?.some((id) => !binding.nodeIds.includes(id)) || args.assetIds?.some((id) => !binding.assetIds.includes(id)))
        throw new CanvasError('读取目标不在专业任务范围', 403, 'CREATIVE_SCOPE')
      const nodeIds = args.nodeIds ?? binding.nodeIds, assetIds = args.assetIds ?? binding.assetIds
      return { canvasId: c.canvasId, revision: state.graphRevision, control: c, ...modelContext,
        nodes: state.graph.nodes.filter((node) => nodeIds.includes(node.id)),
        assets: state.assets.filter((asset) => assetIds.includes(asset.id)),
        promptReferences: references.filter((ref) => assetIds.includes(ref.assetId)),
        referenceDependencies: dependencies.filter((row) => assetIds.includes(row.assetId)).map((row) => ({ ...row,
          dependencies: row.dependencies.filter((ref) => binding.assetIds.includes(ref.assetId)),
          outOfScopeCount: row.dependencies.filter((ref) => !binding.assetIds.includes(ref.assetId)).length })), binding }
    }
    if (args.nodeIds?.some((id) => !state.graph.nodes.some((node) => node.id === id)) || args.assetIds?.some((id) => !state.assets.some((asset) => asset.id === id)))
      throw new CanvasError('读取节点或素材不存在', 404)
    const scoped = args.nodeIds !== undefined || args.assetIds !== undefined, nodeIds = new Set(args.nodeIds ?? [])
    const assetIds = new Set([...(args.assetIds ?? []), ...state.graph.nodes.filter((node) => nodeIds.has(node.id)).flatMap((node) => node.assetId ? [node.assetId] : []),
      ...state.tasks.filter((task) => nodeIds.has(task.nodeId)).flatMap((task) => task.resultIds),
      ...state.graph.edges.filter((edge) => nodeIds.has(edge.target)).map((edge) => edge.assetId)])
    const selected = scoped ? { graphRevision: state.graphRevision, canvasId: c.canvasId,
      graph: { ...state.graph, nodes: state.graph.nodes.filter((node) => nodeIds.has(node.id)), edges: state.graph.edges.filter((edge) => nodeIds.has(edge.target)) },
      assets: state.assets.filter((asset) => assetIds.has(asset.id)), tasks: state.tasks.filter((task) => nodeIds.has(task.nodeId)) } : state
    return { ...selected, promptReferences: references.filter((ref) => !scoped || assetIds.has(ref.assetId)),
      referenceDependencies: dependencies.filter((row) => !scoped || assetIds.has(row.assetId)),
      control: c, presentation: coordinator.presentation.current(c.canvasId) ?? null, view: coordinator.presentation.view(c) ?? null,
      ...modelContext, tts: service.store.ttsSettings(), drafts: coordinator.ledger.drafts(c.canvasId).slice(-30), userMedia, userReferences, ...(cwd ? { workspace: cwd } : {}) }
  })
  tool('canvas_method', '按需读取专业制作方法；不向全局安装任何技能。', z.object({ role: SpecialistRoleSchema }).strict(), async ({ role }) => ({ method: METHODS[role] }))
  const admitImage = async (canvasId: string, asset: Asset | undefined, exec: BoundExec, valid: () => Promise<void>, present?: () => Promise<unknown>) => {
    if (!asset || asset.kind !== 'image' || !['image/png', 'image/jpeg', 'image/webp'].includes(asset.mime)) throw new CanvasError('请选择 PNG、JPEG 或 WebP 图片')
    exec.signal.throwIfAborted()
    await valid()
    const locator = await service.store.locator(canvasId, asset.id)
    if (locator.bytes > service.config.maxReferenceBytes) throw new CanvasError('图片超过理解输入大小限制', 413)
    await present?.()
    const stream = await (await service.store.objects.adapter(locator.providerId, locator.credentialRef)).openRead(locator)
    const abort = () => stream.destroy(new Error('图片读取已取消'))
    exec.signal.addEventListener('abort', abort, { once: true })
    const chunks: Buffer[] = []; let bytes = 0
    try { for await (const chunk of stream) { exec.signal.throwIfAborted(); bytes += chunk.length; if (bytes > service.config.maxReferenceBytes) throw new CanvasError('图片过大', 413); chunks.push(Buffer.from(chunk)) } }
    finally { exec.signal.removeEventListener('abort', abort); stream.destroy() }
    await valid(); exec.signal.throwIfAborted()
    const attachment = await ctx.attachments.saveImage({ data: Buffer.concat(chunks), mediaType: asset.mime as 'image/png', name: asset.filename })
    await valid(); exec.signal.throwIfAborted()
    exec.deferContext({ id: MessageId(crypto.randomUUID()), role: 'user', source, content: [{ type: 'text', text: `画布图片 canvasId=${canvasId} assetId=${asset.id}` }, { type: 'image', attachment }] })
    return { assetId: asset.id, admitted: true }
  }
  const viewImage = async (assetId: string, exec: BoundExec) => {
    if (role !== 'main' && role !== 'executor' && !coordinator.binding(exec.agent).assetIds.includes(assetId)) throw new CanvasError('图片不在专业任务范围', 403, 'CREATIVE_SCOPE')
    const c = read(exec.agent), asset = service.store.state(c.canvasId).assets.find((a) => a.id === assetId)
    return admitImage(c.canvasId, asset, exec, async () => { coordinator.assert(exec.agent, c, false) }, async () => {
      if (role === 'main' && asset?.nodeId) await coordinator.presentation.publish(c, `view:${crypto.randomUUID()}`, 'open',
        service.store.state(c.canvasId).graphRevision, [asset.nodeId])
    })
  }
  tool('canvas_view_image', '把当前画布的真实图片作为原生多模态附件提供给下一次模型请求；视频与音频不可用此工具理解。', z.object({ assetId: IdSchema }).strict(), async ({ assetId }, exec) => viewImage(assetId, exec))
  tool('canvas_task', '查询原有持久任务的当前状态和结果；不会重新提交生成请求。', z.object({ taskId: IdSchema }).strict(), async ({ taskId }, exec) => {
    const c = read(exec.agent), detail = await service.store.taskDetail(c.canvasId, taskId)
    if (role !== 'main' && role !== 'executor' && detail.task && !coordinator.binding(exec.agent).nodeIds.includes(detail.task.nodeId)) throw new CanvasError('任务不在专业委派范围', 403, 'CREATIVE_SCOPE')
    if (role === 'main' && detail.task) await coordinator.presentation.publish(c, `task:${taskId}:${detail.task.updatedAt}`, 'generate',
      service.store.state(c.canvasId).graphRevision, [detail.task.nodeId], taskId)
    const { snapshot: _snapshot, providerTaskId: _providerTaskId, ...task } = detail.task ?? {} as any
    return { kind: detail.kind, phase: detail.phase, failureCode: detail.failureCode, task }
  })
  const creativeTools = { ctx, coordinator, workspace, role, tool, admission, projectFor, document }
  installCreativeTools(creativeTools)
  installVoiceTools(creativeTools)
  if (role === 'main') installDelegationTools(creativeTools)
  if (role === 'main') {
    tool('canvas_show_audio', '将当前画布的实际音频成果或已提交 FishTTS 任务展示为对话内播放器；只读，不生成、不下载官网样例、不自动播放。未完成任务的卡片只跟踪原任务。', z.object({
      taskId: IdSchema.optional(), assetId: IdSchema.optional(), title: z.string().min(1).max(160), ...StepNote,
    }).strict().refine((value) => !!value.taskId || !!value.assetId, '需要实际任务或音频素材ID'), async (args, exec) => {
      const c = read(exec.agent)
      service.chatAudioResult(c.canvasId, args)
      return { audio: ChatAudioHandleSchema.parse({ ...args, canvasId: c.canvasId }), submitted: false, autoplay: false }
    })
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
    tool('canvas_read_reference', '读取本会话已提交的 # 节点、精确素材或旧文件引用。节点返回当前配置、修订、直接上下游与输出摘要；节点下可用 assetId 按需读取自身或直接输入素材。图片进入真实多模态上下文，视频/音频仅元数据，不获得写权限。', z.object({
      referenceId: z.string().regex(/^[a-f0-9]{64}$/), assetId: IdSchema.optional(),
    }).strict(), async ({ referenceId, assetId }, exec) => {
      const entry = submittedReferences(exec.agent).find((entry) => entry.referenceId === referenceId)
      if (!entry) throw new CanvasError('请从本会话 canvas_inspect 的 userReferences 选择', 403, 'REFERENCE_FORBIDDEN')
      const c = coordinator.session(exec.agent.id).canvas
      const valid = () => {
        exec.signal.throwIfAborted(); coordinator.member(exec.agent)
        if (c) coordinator.assert(exec.agent, c, false)
        else if (coordinator.session(exec.agent.id).canvas) throw new CanvasError('读取期间会话画布已变化，请重试', 409, 'REFERENCE_STALE')
      }
      valid()
      const ref = await coordinator.chatReferences.resolve(exec.agent.id, entry.ref, exec.signal)
      valid()
      if (assetId && ref.kind !== 'node') throw new CanvasError('素材或文件引用不能用 assetId 切换对象', 403, 'REFERENCE_FORBIDDEN')
      if (ref.kind === 'node') {
        const snapshot = await service.store.snapshot(ref.canvasId), index = new ReferenceCatalog(snapshot), node = index.nodes.get(ref.nodeId)
        if (!node) throw new CanvasError('节点已移除，请重新选择', 409, 'REFERENCE_STALE')
        valid()
        if (!assetId) return { referenceId, ref, ...index.context(node),
          model: service.store.listModels().find((model) => model.id === node.modelId) ?? null,
          hint: '节点引用明确对象，动作以用户文字为准。直接上下游是理解范围；修改前核对 canvasId、nodeId 和 graphRevision。' }
        const asset = index.related(node, assetId)
        if (!asset) throw new CanvasError('素材不属于该节点或当前直接上游', 403, 'REFERENCE_FORBIDDEN')
        const relatedValid = async () => {
          valid()
          await coordinator.chatReferences.resolve(exec.agent.id, ref, exec.signal)
          const current = new ReferenceCatalog(await service.store.snapshot(ref.canvasId)), target = current.nodes.get(ref.nodeId)
          if (!target || current.snapshot.graphRevision !== snapshot.graphRevision || hash(current.related(target, assetId)) !== hash(asset))
            throw new CanvasError('节点或输入关系已变化，请重新读取引用', 409, 'REFERENCE_STALE')
          valid()
        }
        await relatedValid()
        if (asset.kind === 'image') return { referenceId, ref, graphRevision: snapshot.graphRevision,
          ...await admitImage(ref.canvasId, asset, exec, relatedValid) }
        await service.store.locator(ref.canvasId, asset.id); await relatedValid()
        return { referenceId, ref, asset, graphRevision: snapshot.graphRevision, understood: false,
          hint: '仅这份原素材的元数据；视频与音频内容请结合用户反馈，不声称已观看或聆听。' }
      }
      if (ref.kind === 'media') {
        const asset = service.store.state(ref.canvasId).assets.find((item) => item.id === ref.assetId)!
        if (asset.kind === 'image') return { referenceId, ref, ...await admitImage(ref.canvasId, asset, exec, async () => {
          await coordinator.chatReferences.resolve(exec.agent.id, ref, exec.signal); valid()
        }) }
        return { referenceId, ref, asset, understood: false, hint: '已定位这份原素材；视频与音频内容请结合用户反馈，不声称已观看或聆听。' }
      }
      const file = await coordinator.chatReferences.file(exec.agent, ref, exec.signal, true)
      valid()
      const media = file.data && detectMedia(file.data.subarray(0, 512))
      if (file.data && media?.kind === 'image' && ['image/png', 'image/jpeg', 'image/webp'].includes(media.mime)) {
        const attachment = await ctx.attachments.saveImage({ data: file.data, mediaType: media.mime as 'image/png', name: ref.label })
        await coordinator.chatReferences.file(exec.agent, ref, exec.signal, false)
        valid()
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
  }
  if (role === 'executor') {
    tool('canvas_import_attachment', '将主 Agent 清单中的用户原始媒体导入画布，成功后才能引用真实 assetId。', EXECUTION_SCHEMAS.canvas_import_attachment, (args, exec) => write(exec, args, async (c) => {
      const requestId = uuid({ namespace: 'canvas-user-attachment', canvas: c.canvasId, id: args.operationId })
      const guard = () => { exec.signal.throwIfAborted(); coordinator.assert(exec.agent, c) }
      const input = await readUserAttachment(ctx, rootAgent(exec), args.attachmentId, service.config.maxMediaBytes, exec.signal)
      try {
        const body = await verifiedAttachmentStream(input.body, args.kind, exec.signal)
        const placement = await coordinator.presentation.position(c, service.store.state(c.canvasId).graph, `${args.kind}-asset`, { group: 'assets' }, exec.signal)
        const key = `${c.canvasId}:attachment-input:${args.operationId}`, pinned = coordinator.ledger.receipt(key, args)?.value as { requestId: string; filename: string; kind: 'image' | 'video' | 'audio'; position: { x: number; y: number } } | undefined
        const startInput = pinned ?? { requestId, filename: input.filename, kind: args.kind, position: placement.position }
        coordinator.ledger.remember(key, args, startInput); await coordinator.ledger.persist()
        const started = await service.runtime.uploads.start(c.canvasId, startInput, guard)
        guard()
        coordinator.presentation.operation(exec.agent.id, { operationId: args.operationId, action: 'import', phase: 'started',
          point: { x: startInput.position.x + 36, y: startInput.position.y + 28 }, text: false,
          nodeIds: [started.nodeId], graphRevision: service.store.state(c.canvasId).graphRevision })
        if (coordinator.presentation.followsExecutor(c.canvasId, exec.agent.id)) await coordinator.presentation.publish(c, `${args.operationId}:working`, 'import',
          service.store.state(c.canvasId).graphRevision, [started.nodeId])
        const accepted = await service.runtime.uploads.accept(c.canvasId, started.id, body, args.kind, input.filename, exec.signal, guard)
        return { ...accepted, status: 'queued', purpose: args.purpose, referenceReady: false }
      } finally { input.body.destroy() }
    }, 'import'))
  }
  if (role === 'main') {
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
  }
  if (role === 'executor') {
    tool('canvas_create_node', '执行授权清单中的节点创建；references 为真实 source/assetId，prompt 使用 inspect 返回的 token 表示 @ 标签，节点与引用同次保存。不能改变创作参数。', EXECUTION_SCHEMAS.canvas_create_node, async (args, exec) => {
      coordinator.assertExecution(exec.agent, 'canvas_create_node', args)
      const control = read(exec.agent)
      let placement = args.position ? { position: args.position, source: 'explicit' }
        : await coordinator.presentation.position(control, service.store.state(control.canvasId).graph, args.kind, args.placement ?? { group: args.kind === 'video-generation' ? 'shots' : args.kind === 'tts-generation' ? 'audio' : 'assets' }, exec.signal)
      return write(exec, args, async (c) => {
      const replay = await service.store.db.get('SELECT committed_revision FROM canvas_mutations WHERE canvas_id=? AND mutation_id=?', [c.canvasId, args.operationId])
      if (replay) return { nodeId: args.operationId, revision: replay.committed_revision }
      const state = service.store.state(c.canvasId)
      if (!args.position && state.graph.nodes.length) placement = await coordinator.presentation.position(c, state.graph, args.kind,
        args.placement ?? { group: args.kind === 'video-generation' ? 'shots' : args.kind === 'tts-generation' ? 'audio' : 'assets' }, exec.signal, false)
      if (args.kind === 'tts-generation' && args.modelId) throw new CanvasError('FishTTS 节点不使用图片或视频模型')
      const model = args.modelId ? coordinator.generationModels.require(rootAgent(exec), args.kind === 'video-generation' ? 'video' : 'image', args.modelId) : undefined
      const input = { ...nodeFor(state.graph, args.kind, placement.position, model), id: args.operationId, title: args.title, prompt: args.prompt, ...(args.params !== undefined ? { params: args.params } : {}) }
      const { node, edges, references, referenceCoverage } = referencedNode(state, input, args.references, service.store.listModels(), (index) => uuid({ operationId: args.operationId, reference: index }), true, args.referenceExclusions)
      coordinator.presentation.operation(exec.agent.id, { operationId: args.operationId, action: 'create', phase: 'started',
        point: { x: node.position.x + 36, y: node.position.y + 28 }, text: false, nodeIds: [node.id], graphRevision: state.graphRevision })
      await service.mutateGraph(c.canvasId, { mutationId: args.operationId, baseRevision: args.revision, nodes: [{ value: node, hash: hash(node) }], edges: edges.map((value) => ({ value, hash: hash(value) })), deleteNodes: [], deleteEdges: [] }, () => {
        exec.signal.throwIfAborted(); coordinator.assert(exec.agent, c)
        coordinator.executionRevision(exec.agent, 'canvas_create_node', args)
        if (model) coordinator.generationModels.require(rootAgent(exec), model.kind as 'image' | 'video', model.id)
      })
      return { nodeId: node.id, revision: service.store.state(c.canvasId).graphRevision, placement, references, referenceCoverage }
    }, 'create')
    })
    tool('canvas_update_node', '执行明确节点修改；可用 references 同次补充真实连线，patch.prompt 用 @ token 说明用途，不改变旧素材身份。', EXECUTION_SCHEMAS.canvas_update_node, (args, exec) => write(exec, args, async (c) => {
      const replay = await service.store.db.get('SELECT committed_revision FROM canvas_mutations WHERE canvas_id=? AND mutation_id=?', [c.canvasId, args.operationId])
      if (replay) return { nodeId: args.nodeId, revision: replay.committed_revision }
      const state = service.store.state(c.canvasId), current = state.graph.nodes.find((n) => n.id === args.nodeId)
      if (!current) throw new CanvasError('节点不存在')
      let node = CanvasNodeSchema.parse({ ...current, ...args.patch })
      const checkModel = () => {
        if (args.patch.modelId) {
          if (!['image-generation', 'video-generation'].includes(node.kind)) throw new CanvasError('只能为图片或视频生成节点选择模型')
          coordinator.generationModels.require(rootAgent(exec), node.kind === 'video-generation' ? 'video' : 'image', node.modelId)
        }
      }
      checkModel()
      if (args.patch.modelId && args.patch.params === undefined && (node.modelId !== current.modelId || !node.params))
        node.params = defaultParams(coordinator.generationModels.require(rootAgent(exec), node.kind === 'video-generation' ? 'video' : 'image', node.modelId))
      const edit = referencedNode(state, node, args.references, service.store.listModels(), (index) => uuid({ operationId: args.operationId, reference: index }),
        args.patch.prompt !== undefined || args.patch.params !== undefined || args.patch.modelId !== undefined || args.references !== undefined || args.referenceExclusions !== undefined,
        args.referenceExclusions)
      node = edit.node
      await service.mutateGraph(c.canvasId, { mutationId: args.operationId, baseRevision: args.revision, nodes: [{ value: node, hash: hash(node) }], edges: edit.edges.map((value) => ({ value, hash: hash(value) })), deleteNodes: [], deleteEdges: [] }, () => {
        exec.signal.throwIfAborted(); coordinator.assert(exec.agent, c); coordinator.executionRevision(exec.agent, 'canvas_update_node', args); checkModel()
      })
      return { nodeId: node.id, revision: service.store.state(c.canvasId).graphRevision, references: edit.references, referenceCoverage: edit.referenceCoverage }
    }, 'update'))
    tool('canvas_connect', '按授权清单连接真实 assetId，保留现有图约束。', EXECUTION_SCHEMAS.canvas_connect, (args, exec) => write(exec, args, async (c) => {
      const edge = { id: args.operationId, source: args.source, target: args.target, assetId: args.assetId }
      const state = service.store.state(c.canvasId)
      const graph = !state.graph.edges.some((e) => e.id === edge.id)
        ? connectAssetReference(state.graph, args.source, args.target, args.assetId, state.assets, state.tasks, service.store.listModels(), edge.id) : state.graph
      const target = graph.nodes.find((node) => node.id === args.target)!, model = service.store.listModels().find((model) => model.id === target.modelId)
      const node = model && isMultimodalVideo(model) && target.params && !isTtsParams(target.params)
        ? { ...target, params: videoGenerationParams(target.params, graph.edges.filter((edge) => edge.target === target.id).map((edge) => edge.assetId), model) } : target
      await service.mutateGraph(c.canvasId, { mutationId: args.operationId, baseRevision: args.revision,
        nodes: node === target ? [] : [{ value: node, hash: hash(node) }], edges: [{ value: edge, hash: hash(edge) }], deleteNodes: [], deleteEdges: [] }, () => {
          exec.signal.throwIfAborted(); coordinator.assert(exec.agent, c); coordinator.executionRevision(exec.agent, 'canvas_connect', args)
        })
      return { edgeId: edge.id, revision: service.store.state(c.canvasId).graphRevision, reference: promptReference(state, edge) }
    }, 'connect'))
  }
  if (role === 'main') {
    tool('canvas_handoff_generation', '图片或视频参数和引用填写完成后必须调用：定位对应节点，提醒用户检查或修改参数并亲自点击生成，立即交还画布。不会提交任务；回执后简短转告 reminder 并结束本轮操作。', z.object({
      ...Operation, nodeIds: z.array(IdSchema).min(1).max(100),
      referenceExclusions: z.array(z.object({ nodeId: IdSchema, exclusions: ReferenceExclusionsSchema.min(1) }).strict()).max(100).optional(),
    }).strict(), async (args, exec) => {
      const c = coordinator.attached(exec.agent), key = `${c.canvasId}:generation-handoff:${args.operationId}`
      referenceTarget(exec, c, args, args.nodeIds)
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
        const exclusions = new Map<string, { assetId: string; reason: string }[]>()
        for (const item of args.referenceExclusions ?? []) {
          if (!args.nodeIds.includes(item.nodeId) || exclusions.has(item.nodeId)) throw new CanvasError('排除清单须对应本次交接节点且不得重复', 409, 'AGENT_REFERENCE_INVALID')
          exclusions.set(item.nodeId, item.exclusions)
        }
        validateGraph(state.graph, state.assets, state.tasks)
        const nodes = args.nodeIds.map((id) => {
          const node = state.graph.nodes.find((node) => node.id === id)
          if (!node || !['image-generation', 'video-generation'].includes(node.kind)) throw new CanvasError('请选择已填写参数的图片或视频生成节点')
          const model = coordinator.generationModels.require(exec.agent, node.kind === 'video-generation' ? 'video' : 'image', node.modelId)
          return { nodeId: node.id, title: node.title, kind: node.kind, modelId: model.id, ...validateAgentGeneration(state, node, model, exclusions.get(node.id)) }
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
  }
  if (role === 'executor') {
    tool('canvas_generate', '仅执行清单中明确授权的 FishTTS，图片和视频必须交给用户点击；不得重提未知任务。', EXECUTION_SCHEMAS.canvas_generate, (args, exec) => write(exec, args, async (c) => {
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
        if (node.kind !== 'tts-generation') coordinator.generationModels.require(rootAgent(exec), node.kind === 'video-generation' ? 'video' : 'image', node.modelId)
      }
      checkModel()
      coordinator.ledger.pinSubmission(requestId, c); await coordinator.ledger.persist()
      coordinator.assert(exec.agent, c); exec.signal.throwIfAborted()
      const task = await service.generate(c.canvasId, args.nodeId, args.revision, requestId, false, node.kind === 'tts-generation', () => {
        exec.signal.throwIfAborted(); coordinator.assert(exec.agent, c); checkModel()
      })
      return { taskId: task.id, status: task.status }
    }, 'generate'))
  }
  if (role === 'main') {
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
  }
  // A preset's own tools are exempt from inherited restrictions, so execution guards also enforce the same list.
  const allowed = new Set([...tools, ...(role === 'main' ? ['ask_user_question'] : ['structured_output'])])
  ctx.tools.guard((exec) => allowed.has(exec.name) ? undefined : '当前创作预设不开放此能力')
}
