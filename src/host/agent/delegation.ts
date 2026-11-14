import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { StepNote } from '../../shared/agent'
import { CreativeTaskSchema, SpecialistResultSchema } from '../../shared/creative'
import { ExecutionBatchSchema, ParallelExecutionSchema, executionIntent, type ExecutionBatch } from '../../shared/execution'
import type { CreativeToolsContext } from './creativeTools'
import { CanvasError } from '../store'
import { hash } from '../persistence/database'
import { agentDisplayName } from '../../shared/collaboration'
import { validateVoiceDraft } from './voiceTools'
import { executionResources, executionGroup, independentCreateBatches } from './executionScheduler'
import { taskSkills, capabilities } from './capabilities'
import { planningKinds, matchingPromptSkills, MODEL_PROMPT_SKILLS } from './modelPromptSkills'

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
  tool('canvas_specialist', `按批次委派专业任务。正式shots任务先选视频模型，assets生成规格先选图片模型；modelKinds声明其他模型相关任务，宿主自动补必需类型并注入实时能力/对应提示词Skill。换模型用新批次复核。导演/序列/画面归shots，专业角色只保存成果。各角色Skill目录：${JSON.stringify(Object.fromEntries(['story', 'assets', 'shots', 'audio', 'voice', 'review'].map((role) => [role, capabilities(role as 'story').skills])))}`, CreativeTaskSchema.extend(StepNote), async (args, exec) => {
    admission(exec)
    const planningModels = planningKinds(args.role, args.skillNames, args.modelKinds).map((kind) => coordinator.generationModels.pin(exec.agent, kind))
    const matching = matchingPromptSkills(args.role, planningModels)
    if (args.skillNames?.some((name) => Object.values(MODEL_PROMPT_SKILLS).includes(name) && !matching.includes(name)))
      throw new CanvasError('委派的提示词方法与用户已选模型不匹配', 409, 'AGENT_MODEL_SKILL_MISMATCH')
    const skillNames = taskSkills(args.role, [...args.skillNames ?? [], ...matching])
    const c = coordinator.session(exec.agent.id).canvas, project = await projectFor(exec, c)
    const root = coordinator.rootAgent(exec.agent), cwd = await workspace.root(root, exec.signal)
    const checkWorkspace = async () => {
      admission(exec)
      coordinator.generationModels.assertPlan(exec.agent, planningModels)
      if (await workspace.root(root, exec.signal) !== cwd) throw new CanvasError('成果交接期间工作区已切换', 409, 'WORKSPACE_CHANGED')
    }
    const key = `${project.id}:specialist:${args.operationId}`, baseRevision = c ? coordinator.canvas.store.state(c.canvasId).graphRevision : null
    const binding = { projectId: project.id, taskId: args.operationId, sourceIds: args.sourceIds, artifactIds: args.artifactIds, nodeIds: args.nodeIds, assetIds: args.assetIds, skillNames, planningModels }
    const value = await coordinator.specialist(exec.agent, key, { ...args, planningModels }, async () => {
      const state = c ? coordinator.canvas.store.state(c.canvasId) : null
      if (args.nodeIds.some((id) => !state?.graph.nodes.some((n) => n.id === id)) || args.assetIds.some((id) => !state?.assets.some((a) => a.id === id))) throw new CanvasError('专业任务引用的节点或素材不存在')
      const run = coordinator.creative.begin(project.id, args.operationId, args.role, { ...args, planningModels }, args.task, args.sourceIds, args.artifactIds)
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
            artifactOutputIds: coordinator.creative.run(project.id, args.operationId)!.artifactOutputIds, planningModels }
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
    }, { signal: exec.signal })
    const file = (value as { file?: Parameters<typeof workspace.verify>[1] }).file
    if (file) await workspace.verify(root, file, exec.signal)
    await checkWorkspace()
    return value
  })
  const receiptsFor = (args: ExecutionBatch, canvasId: string) => args.commands.map((command) => ({
    tool: command.tool, operationId: command.input.operationId,
    receipt: (coordinator.ledger.receipt(`${canvasId}:execution:${command.input.operationId}`, { tool: command.tool, input: executionIntent(command.input) })?.value as { result: unknown } | undefined)?.result ?? null,
  }))
  const validateBatch = (args: ExecutionBatch, canvasId: string) => {
    if (new Set(args.commands.map((command) => command.input.operationId)).size !== args.commands.length) throw new CanvasError('执行清单中的操作 ID 必须唯一')
    if (args.commands.some((command) => command.input.canvasId && command.input.canvasId !== canvasId)) throw new CanvasError('执行清单不属于受控画布', 409, 'AGENT_SESSION_BUSY')
    if (args.commands.some((command) => command.tool === 'canvas_generate') && !args.allowTts) throw new CanvasError('本批次未获得 FishTTS 授权', 403, 'AGENT_EXECUTION_SCOPE')
  }
  const execute = async (args: ExecutionBatch, exec: Parameters<typeof admission>[0], inputRevision?: number) => {
    const c = coordinator.attached(exec.agent); coordinator.assert(exec.agent, c)
    const admittedRevision = inputRevision ?? coordinator.canvas.store.state(c.canvasId).graphRevision
    const project = await projectFor(exec, c)
    validateBatch(args, c.canvasId)
    const key = `${project.id}:execution-batch:${args.operationId}`
    return coordinator.specialist(exec.agent, key, args, async () => {
      coordinator.videoSound.batch(exec.agent, c, args.commands)
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
      const release = coordinator.prepareChild(id, exec.agent.id, 'executor', binding, c, args.commands, args.allowTts, admittedRevision)
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
        const receipts = receiptsFor(args, c.canvasId)
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
      } finally { coordinator.presentation.endExecutor(id); release(); exec.signal.removeEventListener('abort', abort); detach(); await child?.dispose() }
    }, { signal: exec.signal, resources: executionResources(args.commands, coordinator.canvas.store.state(c.canvasId).graph) })
  }
  tool('canvas_execute', '按精确清单执行。多个独立新建节点默认分给最多4个实际画布执行实例；有本批引用、布局依赖或混合操作保持顺序。用户明确要求顺序时executionMode=serial。完成以宿主实际回执为准；其他独立任务用canvas_execute_parallel。', ExecutionBatchSchema, async (args, exec) => {
    admission(exec)
    const c = coordinator.attached(exec.agent); coordinator.assert(exec.agent, c)
    validateBatch(args, c.canvasId)
    const state = coordinator.canvas.store.state(c.canvasId), inputRevision = state.graphRevision
    const batches = independentCreateBatches(args, state.graph, coordinator.executionScheduler.capacity)
    if (!batches.length) return execute(args, exec)
    const project = await projectFor(exec, c), key = `${project.id}:execution-batch:${args.operationId}`
    const validate = () => { admission(exec); coordinator.assert(exec.agent, c) }
    // The original key/arguments gate replay before fan-out, including pre-upgrade receipts.
    return coordinator.specialist(exec.agent, key, args, async () => {
      coordinator.videoSound.batch(exec.agent, c, args.commands)
      coordinator.creative.begin(project.id, args.operationId, 'executor', args, args.task, [], args.artifactIds)
      await coordinator.creative.persist()
      try {
        const group = await executionGroup(batches.map((batch) => ({ ...batch, dependsOn: [] })), exec.signal, validate, (task) => {
          const { dependsOn: _dependsOn, ...batch } = task
          return execute(batch, exec, inputRevision)
        })
        const receipts = receiptsFor(args, c.canvasId), completed = group.completed && receipts.every((entry) => entry.receipt !== null)
        const value = { completed, receipts, revision: coordinator.canvas.store.state(c.canvasId).graphRevision, taskId: args.operationId,
          stopReason: exec.signal.aborted ? 'interrupted' : completed ? 'completed' : 'blocked',
          summary: { status: completed ? 'completed' : 'blocked', summary: completed ? '独立新建清单全部取得实际回执' : '并行清单未完整完成，请核对已有回执' },
          dispatch: { mode: 'parallel', tasks: group.tasks } }
        coordinator.creative.update(project.id, args.operationId, exec.signal.aborted ? 'interrupted' : completed ? 'completed' : 'blocked', value.summary.summary, value)
        await coordinator.creative.persist()
        return value
      } catch (error) {
        coordinator.creative.update(project.id, args.operationId, exec.signal.aborted ? 'interrupted' : 'blocked', '执行中断；实际操作回执保留，不自动重放')
        await coordinator.creative.persist(); throw error
      }
    }, { signal: exec.signal, group: true })
  })
  tool('canvas_execute_parallel', '按用户问题派发多个画布执行实例。独立节点并行，共享节点/引用排队，dependsOn 指定前置任务；每个实例只在画布内显示自身真实操作光标。不要拆分简单任务来强制并行。', ParallelExecutionSchema, async (args, exec) => {
    admission(exec)
    const c = coordinator.attached(exec.agent); coordinator.assert(exec.agent, c)
    const inputRevision = coordinator.canvas.store.state(c.canvasId).graphRevision
    const ids = args.tasks.flatMap((task) => task.commands.map((command) => command.input.operationId))
    if (new Set(ids).size !== ids.length) throw new CanvasError('不同执行任务不能共用操作 ID')
    for (const task of args.tasks) {
      if (task.commands.some((command) => command.input.canvasId && command.input.canvasId !== c.canvasId)) throw new CanvasError('执行清单不属于受控画布')
      if (!task.allowTts && task.commands.some((command) => command.tool === 'canvas_generate')) throw new CanvasError('本任务未获得 FishTTS 授权', 403, 'AGENT_EXECUTION_SCOPE')
    }
    const validate = () => { admission(exec); coordinator.assert(exec.agent, c) }
    return coordinator.specialist(exec.agent, `${c.canvasId}:execution-group:${args.operationId}`, args, () =>
      executionGroup(args.tasks, exec.signal, validate, (task) => {
        const { dependsOn: _dependsOn, ...batch } = task
        return execute(batch, exec, inputRevision)
      }), { signal: exec.signal, group: true })
  })
}
