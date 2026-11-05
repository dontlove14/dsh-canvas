import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { StepNote } from '../../shared/agent'
import { CreativeTaskSchema, SpecialistResultSchema } from '../../shared/creative'
import { ExecutionCommandSchema, executionIntent } from '../../shared/execution'
import type { CreativeToolsContext } from './creativeTools'
import { CanvasError } from '../store'
import { hash } from '../persistence/database'
import { agentDisplayName } from '../../shared/collaboration'
import { validateVoiceDraft } from './voiceTools'

const DraftOutput = { type: 'object' as const, properties: {
  kind: { type: 'string' as const, enum: ['brief', 'asset-spec', 'storyboard', 'shot-plan', 'audio-plan', 'review'] },
  title: { type: 'string' as const }, content: { type: 'string' as const },
  dependencies: { type: 'array' as const, items: { type: 'string' as const } },
  assetIds: { type: 'array' as const, items: { type: 'string' as const } },
}, required: ['kind', 'title', 'content', 'dependencies', 'assetIds'], additionalProperties: false }
export const SpecialistOutput = { type: 'object' as const, properties: { result: { oneOf: [
  { type: 'object' as const, properties: {
    artifactId: { type: 'string' as const }, summary: { type: 'string' as const },
  }, required: ['artifactId'], additionalProperties: false },
  DraftOutput,
] } }, required: ['result'], additionalProperties: false }
const ExecutionOutput = { type: 'object' as const, properties: {
  status: { type: 'string' as const, enum: ['completed', 'blocked'] }, summary: { type: 'string' as const },
}, required: ['status', 'summary'], additionalProperties: false }
export function installDelegationTools(deps: CreativeToolsContext) {
  const { ctx, coordinator, tool, admission, projectFor, workspace, document } = deps
  tool('canvas_specialist', '按批次委派叙事、资产、镜头、音频、音色查找或审查子 Agent。仅音色查找角色读取 Fish 官网；专业角色保存草稿，主 Agent 负责协调及用户决定。', CreativeTaskSchema.extend(StepNote), async (args, exec) => {
    admission(exec)
    const c = coordinator.session(exec.agent.id).canvas, project = await projectFor(exec, c)
    const root = coordinator.rootAgent(exec.agent), cwd = await workspace.root(root, exec.signal)
    const checkWorkspace = async () => {
      admission(exec)
      if (await workspace.root(root, exec.signal) !== cwd) throw new CanvasError('成果交接期间工作区已切换', 409, 'WORKSPACE_CHANGED')
    }
    const key = `${project.id}:specialist:${args.operationId}`, baseRevision = c ? coordinator.canvas.store.state(c.canvasId).graphRevision : null
    const binding = { projectId: project.id, taskId: args.operationId, sourceIds: args.sourceIds, artifactIds: args.artifactIds, nodeIds: args.nodeIds, assetIds: args.assetIds }
    const value = await coordinator.specialist(exec.agent, key, args, async () => {
      const state = c ? coordinator.canvas.store.state(c.canvasId) : null
      if (args.nodeIds.some((id) => !state?.graph.nodes.some((n) => n.id === id)) || args.assetIds.some((id) => !state?.assets.some((a) => a.id === id))) throw new CanvasError('专业任务引用的节点或素材不存在')
      const run = coordinator.creative.begin(project.id, args.operationId, args.role, args, args.task, args.sourceIds, args.artifactIds)
      if (run.state !== 'running') throw new CanvasError('该批次已结束；请读取进度后以新任务 ID 继续', 409, 'SPECIALIST_INCOMPLETE')
      await coordinator.creative.persist()
      const id = randomUUID() as typeof exec.agent.id
      coordinator.collaboration.dispatch({ id: args.operationId, rootId: exec.agent.id, projectId: project.id, canvasId: c?.canvasId,
        parentCallId: exec.callId, childId: id, role: args.role, title: args.note || args.task.slice(0, 80), task: args.task,
        sourceRefs: args.sourceIds.map((id) => { const s = coordinator.creative.source(project.id, id); return { id, title: s.name, version: s.version } }),
        inputRefs: args.artifactIds.map((id) => { const a = coordinator.creative.artifact(project.id, id); return { id, title: a.draft.title, version: a.version } }),
        nodeIds: args.nodeIds, commandCount: 0 })
      await coordinator.collaboration.persist()
      const release = coordinator.prepareChild(id, exec.agent.id, args.role, binding)
      let child: Awaited<ReturnType<typeof ctx.subagents.startActivation>> | undefined
      let detach = () => {}
      const abort = () => { void child?.dispose().catch(() => {}) }
      try {
        child = await ctx.subagents.startActivation({ provider: 'spawn', childId: id, delivery: 'caller', signal: exec.signal, label: agentDisplayName(args.role),
          request: { parent: exec.agent, agentPreset: `canvas-${args.role}`, agentOptions: coordinator.route(exec.agent), maxDepth: 1, outputSchema: SpecialistOutput,
            prompt: [{ type: 'text', text: JSON.stringify({
              task: args.task, binding, canvasId: c?.canvasId, revision: baseRevision,
              completion: { suggestedArtifactId: randomUUID(), instruction: 'taskId仅标识批次。每份成果用独立artifactId；保存后以{"result":{"artifactId":"实际保存回执ID","summary":"简短交接说明"}}结束，不再重复输出全文。尚未保存才返回result内完整草稿。' },
              sources: args.sourceIds.map((id) => { const { sections, ...s } = coordinator.creative.source(project.id, id); return { ...s, sectionCount: sections.length } }),
              artifacts: args.artifactIds.map((id) => { const a = coordinator.creative.artifact(project.id, id); return { id, title: a.draft.title, kind: a.draft.kind, version: a.version, status: a.status, needsReview: a.needsReview } }),
              facts: { nodes: state?.graph.nodes.filter((n) => args.nodeIds.includes(n.id)) ?? [], assets: state?.assets.filter((a) => args.assetIds.includes(a.id)) ?? [] },
            }) }] } })
        const agent = ctx.agents.get(child.childId)
        if (!agent) throw new CanvasError('专业 Agent 未正确挂载')
        coordinator.register(agent, args.role, exec.agent.id); coordinator.bind(agent, binding)
        detach = coordinator.trackChild(exec.agent.id, () => child!.dispose())
        exec.signal.addEventListener('abort', abort, { once: true })
        const result = await child.result
        admission(exec)
        if (result.stopReason !== 'completed' || !result.structured) throw new CanvasError('专业 Agent 未完成有效草稿，请读取已有成果后决定下一批次', 409, 'SPECIALIST_INCOMPLETE')
        const parsed = SpecialistResultSchema.parse(result.structured), completion = 'result' in parsed ? parsed.result : parsed
        const value = await coordinator.serial(async () => {
          await checkWorkspace()
          const progress = coordinator.creative.run(project.id, args.operationId)!
          let artifact: ReturnType<typeof coordinator.creative.artifact> | undefined
          if ('artifactId' in completion) {
            if (!progress.artifactOutputIds.includes(completion.artifactId)) throw new CanvasError('交接成果必须是本批次实际保存的产出', 403, 'CREATIVE_SCOPE')
            artifact = coordinator.creative.artifact(project.id, completion.artifactId)
          } else {
            // Compare canonical drafts, not Markdown footers. Legacy mixed IDs remain readable.
            artifact = progress.artifactOutputIds.map((id) => coordinator.creative.artifact(project.id, id))
              .find((saved) => hash(saved.draft) === hash(completion))
          }
          if (artifact && artifact.taskId !== args.operationId) throw new CanvasError('交接成果不属于当前批次', 403, 'CREATIVE_SCOPE')
          const draft = artifact?.draft ?? completion
          if ('artifactId' in draft) throw new CanvasError('交接成果不存在', 403, 'CREATIVE_SCOPE')
          if (draft.dependencies.some((id) => !args.artifactIds.includes(id) && !progress.artifactOutputIds.includes(id)) ||
            draft.assetIds.some((id) => !args.assetIds.includes(id))) throw new CanvasError('专业结果超出委派范围', 403, 'CREATIVE_SCOPE')
          if (artifact) await workspace.verify(root, artifact.file, exec.signal)
          else {
            if (args.role === 'voice') validateVoiceDraft(coordinator, args.operationId, draft)
            const artifactId = randomUUID()
            const file = await document(exec, artifactId, draft.title, `# ${draft.title}\n\n${draft.content}\n\n专业草稿：${args.role}；状态：待用户认可。\n来源：${JSON.stringify(progress.readRanges)}\n依赖：${draft.dependencies.join(', ')}\n`, '其他', c ?? undefined, cwd)
            await checkWorkspace()
            artifact = coordinator.creative.saveArtifact({ id: artifactId, projectId: project.id, taskId: args.operationId,
              draft, sources: progress.readRanges.slice(0, 100), version: 1, author: agent.id, createdAt: Date.now(), status: 'draft', file })
          }
          await checkWorkspace()
          const value = { taskId: args.operationId, draft: artifact.draft, artifactId: artifact.id, version: artifact.version,
            status: artifact.status, sources: artifact.sources, needsReview: artifact.needsReview, file: artifact.file, baseRevision,
            ...('summary' in completion ? { summary: completion.summary } : {}),
            stale: !!c && coordinator.canvas.store.state(c.canvasId).graphRevision !== baseRevision,
            artifactOutputIds: coordinator.creative.run(project.id, args.operationId)!.artifactOutputIds }
          coordinator.creative.update(project.id, args.operationId, 'completed', '本批次完成；认可状态以成果记录为准', value)
          await coordinator.creative.persist()
          return value
        })
        coordinator.collaboration.returned(args.operationId, 'completed', '专业草稿已保存并回传，等待主 Agent 处理及用户认可')
        await coordinator.collaboration.persist(); return value
      } catch (error) {
        coordinator.creative.update(project.id, args.operationId, exec.signal.aborted ? 'interrupted' : 'blocked', '本批次未完整完成；已保存分段成果和原文进度，请核对后继续')
        await coordinator.creative.persist()
        coordinator.collaboration.returned(args.operationId, exec.signal.aborted ? 'interrupted' : 'blocked', '本批次未完整完成；已有成果与公开过程保留')
        await coordinator.collaboration.persist(); throw error
      } finally { release(); exec.signal.removeEventListener('abort', abort); detach(); await child?.dispose() }
    })
    const file = (value as { file?: Parameters<typeof workspace.verify>[1] }).file
    if (file) await workspace.verify(root, file, exec.signal)
    await checkWorkspace()
    return value
  })
  tool('canvas_execute', '启动同级画布执行子 Agent，按明确操作清单创建/修改/连线/导入或授权FishTTS。它不能改创作方向、猜模型、提问或再委派。按任务批次执行，主 Agent 根据宿主实际回执核对结果，再负责图片/视频交接。', z.object({
    operationId: z.string().uuid(), task: z.string().trim().min(1).max(24000),
    commands: z.array(ExecutionCommandSchema).min(1).max(100), allowTts: z.boolean().default(false),
    artifactIds: z.array(z.string().uuid()).max(100).default([]), ...StepNote,
  }).strict().refine((args) => JSON.stringify(args).length <= 256000, '执行批次过大，请拆分为多个明确批次'), async (args, exec) => {
    const c = coordinator.attached(exec.agent); coordinator.assert(exec.agent, c)
    const project = await projectFor(exec, c)
    if (new Set(args.commands.map((command) => command.input.operationId)).size !== args.commands.length) throw new CanvasError('执行清单中的操作 ID 必须唯一')
    if (args.commands.some((command) => command.input.canvasId && command.input.canvasId !== c.canvasId)) throw new CanvasError('执行清单不属于受控画布', 409, 'AGENT_SESSION_BUSY')
    if (args.commands.some((command) => command.tool === 'canvas_generate') && !args.allowTts) throw new CanvasError('本批次未获得 FishTTS 授权', 403, 'AGENT_EXECUTION_SCOPE')
    const key = `${project.id}:execution-batch:${args.operationId}`
    return coordinator.specialist(exec.agent, key, args, async () => {
      coordinator.creative.begin(project.id, args.operationId, 'executor', args, args.task, [], args.artifactIds)
      await coordinator.creative.persist()
      const id = randomUUID() as typeof exec.agent.id
      coordinator.collaboration.dispatch({ id: args.operationId, rootId: exec.agent.id, projectId: project.id, canvasId: c.canvasId,
        parentCallId: exec.callId, childId: id, role: 'executor', title: args.note || args.task.slice(0, 80), task: args.task,
        sourceRefs: [], inputRefs: args.artifactIds.map((id) => { const a = coordinator.creative.artifact(project.id, id); return { id, title: a.draft.title, version: a.version } }),
        nodeIds: args.commands.flatMap((command) => {
          const input = command.input as { nodeId?: string; source?: string; target?: string }
          return [input.nodeId, input.source, input.target].filter((id): id is string => !!id)
        }), commandCount: args.commands.length })
      await coordinator.collaboration.persist()
      const binding = { projectId: project.id, taskId: args.operationId, sourceIds: [], artifactIds: args.artifactIds, nodeIds: [], assetIds: [] }
      const release = coordinator.prepareChild(id, exec.agent.id, 'executor', binding, c, args.commands, args.allowTts)
      let child: Awaited<ReturnType<typeof ctx.subagents.startActivation>> | undefined
      let detach = () => {}
      const abort = () => { void child?.dispose().catch(() => {}) }
      try {
        child = await ctx.subagents.startActivation({ provider: 'spawn', childId: id, delivery: 'caller', signal: exec.signal, label: '画布执行',
          request: { parent: exec.agent, agentPreset: 'canvas-executor', agentOptions: coordinator.route(exec.agent), maxDepth: 1, outputSchema: ExecutionOutput,
            prompt: [{ type: 'text', text: JSON.stringify({ task: args.task, binding, control: c, commands: args.commands, allowTts: args.allowTts,
              modelSelections: coordinator.generationModels.selections(exec.agent) }) }] } })
        const agent = ctx.agents.get(child.childId)
        if (!agent) throw new CanvasError('画布执行 Agent 未正确挂载')
        coordinator.register(agent, 'executor', exec.agent.id); coordinator.bind(agent, binding); coordinator.grantExecution(agent, c, args.commands, args.allowTts)
        detach = coordinator.trackChild(exec.agent.id, () => child!.dispose()); exec.signal.addEventListener('abort', abort, { once: true })
        const result = await child.result
        admission(exec)
        // Structured claims are advisory. Only the host's exact operation receipts prove completion.
        const receipts = args.commands.map((command) => ({
          tool: command.tool, operationId: command.input.operationId,
          receipt: (coordinator.ledger.receipt(`${c.canvasId}:execution:${command.input.operationId}`, { tool: command.tool, input: executionIntent(command.input) })?.value as { result: unknown } | undefined)?.result ?? null,
        }))
        const completed = receipts.every((entry) => entry.receipt !== null)
        const value = { completed, receipts, stopReason: result.stopReason, summary: result.structured,
          revision: coordinator.canvas.store.state(c.canvasId).graphRevision, taskId: args.operationId }
        coordinator.creative.update(project.id, args.operationId, completed ? 'completed' : 'blocked', completed ? '执行清单全部取得实际回执' : '执行清单部分完成；核对回执后继续，勿重提未知生成', value)
        await coordinator.creative.persist()
        coordinator.collaboration.returned(args.operationId, completed ? 'completed' : 'blocked',
          completed ? '执行清单全部取得宿主实际回执，等待主 Agent 核对' : '执行清单仍有缺失回执，等待主 Agent 处理')
        await coordinator.collaboration.persist(); return value
      } catch (error) {
        coordinator.creative.update(project.id, args.operationId, exec.signal.aborted ? 'interrupted' : 'blocked', '执行中断；实际操作回执保留，不自动重放')
        await coordinator.creative.persist()
        coordinator.collaboration.returned(args.operationId, exec.signal.aborted ? 'interrupted' : 'blocked', '执行中断；实际回执保留，不自动重放')
        await coordinator.collaboration.persist(); throw error
      } finally { release(); exec.signal.removeEventListener('abort', abort); detach(); await child?.dispose() }
    })
  })
}
