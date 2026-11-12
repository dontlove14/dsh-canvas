import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createScope, scopeTarget, scopeOf } from '@deepseek-ai/dsh-scope'
import { ToolRuntime, assertObjectJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { UserQuestionService, type AskUserQuestionRequest, type AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { mkdtemp, readFile, stat, rm, writeFile, symlink, readdir, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { CanvasService } from '../src/host/service'
import { CanvasAgentCoordinator } from '../src/host/agent/coordinator'
import { apply as preset } from '../src/host/agent/preset'
import { fakeFactory, initialize } from './support/objectStorage'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { referenceText, referenceSpans, type ChatReference } from '../src/shared/chatReferences'
import { submittedReferences } from '../src/host/agent/chatReferences'
import { BUILTIN_MODELS, providerFor } from '../src/shared/modelCatalog'
import { MOCK_MODELS } from '../src/shared/mockModels'
import { hash, sql } from '../src/host/persistence/database'
import { GENERATION_HANDOFF_REASON, isGenerationHandoff } from '../src/shared/agent'
import { MAIN_PROMPT, METHODS } from '../src/host/agent/methods'
import { AgentLedger } from '../src/host/agent/ledger'
import { CanvasNodeSchema, NodeKindSchema, defaultTtsParams } from '../src/shared/contracts'
import { EXECUTION_SCHEMAS, type ExecutionCommand } from '../src/shared/execution'
import { CreativeProjects, readCreativeSource } from '../src/host/agent/creative'
import { SpecialistOutput } from '../src/host/agent/delegation'
import { assetToken, resolvePrompt } from '../src/shared/promptMentions'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const simpleDraft = (title = '单元分析', dependencies: string[] = []) => ({ kind: 'brief' as const, title, content: '实际读取的单元分析', dependencies, assetIds: [] })
const hashBytes = (body: Buffer) => createHash('sha256').update(body).digest('hex')
async function fixture(delegate = true) {
  const dir = await mkdtemp(join(tmpdir(), 'canvas-agent-test-'))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  const service = new CanvasService({ dataDir: dir, maxConcurrentTasks: 1, pollIntervalMs: 3000, requestTimeoutMs: 1000, maxMediaBytes: 1e6, maxReferenceBytes: 1e6 }, undefined, fakeFactory(dir))
  await initialize(service); cleanup.push(() => service.close())
  const scope = createScope(new Context(), {})
  cleanup.push(() => scope.dispose())
  const ctx = scope.ctx
  const agents = new Map<string, Agent>()
  const presets = new Map<Context, string>()
  const contexts: any[] = []
  ctx.reflect.provide('systemPrompt', { tools: () => () => {}, section: () => () => {}, context: (value: unknown) => { contexts.push(value); return () => {} }, suppressRuntimeContext: () => () => {} })
  const parents = new Map<string, Agent>()
  ctx.reflect.provide('agents', { get: (id: string) => agents.get(id), list: () => [...agents.values()], roots: () => [...agents.values()].filter((a) => !parents.has(a.id)), isOwnedBy: (id: string, parent: Agent) => parents.get(id) === parent })
  ctx.reflect.provide('agentPresets', { composedPreset: (ctx: Context) => presets.get(ctx), remoteExportList: vi.fn(async () => ({ presets: [] })) })
  const resolveModelInfo = vi.fn(async (_provider: string, model: string) => ({ inputModalities: model === 'vision' ? ['text', 'image'] : ['text'] }))
  ctx.reflect.provide('llm', { resolveModelInfo })
  const selectModel = vi.fn(async (request) => ({ selected: request }))
  ctx.reflect.provide('sessionController', { selectModel, inspect: async () => ({ meta: { agentPreset: 'canvas-creator' } }) })
  ctx.reflect.provide('attachments', {})
  ctx.reflect.provide('subagents', {})
  const registry = new ToolRuntime(ctx)
  new UserQuestionService(ctx)
  const coordinator = new CanvasAgentCoordinator(ctx, service)
  service.agentControl = coordinator
  await coordinator.init()
  const presetScope = createScope(ctx, {}, { parent: scopeOf(ctx) })
  preset(presetScope.ctx)
  presetScope.ctx.tools.register({ name: 'ask_user_question', description: 'Native question fixture', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object' }, render: () => [] }, execute: async () => ({ answer: 'yes' }) })
  registry.register({ name: 'bash', description: 'Forbidden fixture', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object' }, render: () => [] }, execute: async () => ({ executed: true }) })
  const events: any[] = []
  let cwd = dir
  ctx.reflect.provide('workingDirectory', { ensure: async () => cwd, get: () => cwd })
  const agent = { id: `session-${randomUUID()}`, session: { snapshotEvents: () => events }, cancel: vi.fn(), options: { provider: 'fixture', model: 'vision' } } as unknown as Agent
  const agentScope = createScope(presetScope.ctx, agent, { parent: scopeOf(presetScope.ctx) })
  Object.assign(agent, { ctx: agentScope.ctx })
  presets.set(agent.ctx, 'canvas-creator'); agents.set(agent.id, agent)
  await ctx.serial(scopeTarget(agent, agent), 'agent/created', { agent, source: 'startup' })
  const created = await service.store.catalogCommand({ requestId: randomUUID(), operation: 'canvas-create', name: 'Agent test' })
  if (delegate) await coordinator.delegate(created.id, agent.id, 0)
  const rawCall = (name: string, args: unknown, signal = new AbortController().signal) => registry.execute({ name, arguments: args, callId: ToolCallId(randomUUID()), agent, signal })
  const child = async (role: 'assets' | 'executor' = 'assets', id = `child-${randomUUID()}`) => {
    const childPreset = createScope(ctx, {}, { parent: scopeOf(ctx) })
    preset(childPreset.ctx, { role })
    const child = { id, session: { snapshotEvents: () => [] }, cancel: vi.fn(), options: agent.options } as unknown as Agent
    const childScope = createScope(childPreset.ctx, child, { parent: scopeOf(childPreset.ctx) })
    Object.assign(child, { ctx: childScope.ctx })
    parents.set(child.id, agent); agents.set(child.id, child); presets.set(child.ctx, `canvas-${role}`)
    child.ctx.tools.register({ name: 'structured_output', description: 'SDK-owned capture fixture', parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'object' }, render: () => [] }, execute: async () => ({ captured: true }) })
    await ctx.serial(scopeTarget(child, child), 'agent/created', { agent: child, source: 'startup' })
    let bound = false
    try { coordinator.binding(child); bound = true } catch {}
    if (role === 'assets' && !bound) {
      const project = coordinator.creative.project(agent.id, await realpath(dir), coordinator.session(agent.id).canvas?.canvasId, 'Agent test')
      const taskId = randomUUID()
      coordinator.creative.begin(project.id, taskId, role, {}, 'fixture professional task', [], [])
      coordinator.bind(child, { projectId: project.id, taskId, sourceIds: [], artifactIds: [], nodeIds: [], assetIds: [] })
    }
    return child
  }
  let writer: Promise<Agent> | undefined
  // Existing mutation tests now exercise the actual scoped executor tools.
  // rawCall remains available to prove the root cannot bypass delegation.
  const call = async (name: string, args: unknown, signal = new AbortController().signal) => {
    if (!Object.hasOwn(EXECUTION_SCHEMAS, name)) return rawCall(name, args, signal)
    const executor = await (writer ??= child('executor'))
    const control = coordinator.attached(agent)
    const project = coordinator.creative.project(agent.id, await realpath(dir), control.canvasId, 'Agent test'), taskId = randomUUID()
    coordinator.creative.begin(project.id, taskId, 'executor', {}, 'test operation', [], [])
    coordinator.bind(executor, { projectId: project.id, taskId, sourceIds: [], artifactIds: [], nodeIds: [], assetIds: [] })
    const input = EXECUTION_SCHEMAS[name as keyof typeof EXECUTION_SCHEMAS].parse(args)
    coordinator.grantExecution(executor, control, [{ tool: name, input } as ExecutionCommand], true)
    return registry.execute({ name, arguments: args, callId: ToolCallId(randomUUID()), agent: executor, signal })
  }
  return { ctx, dir, service, coordinator, agent, registry, call, rawCall, child, canvasId: created.id, selectModel, resolveModelInfo, events, contexts, setCwd: (next: string) => { cwd = next } }
}
async function configureGeneration(f: Awaited<ReturnType<typeof fixture>>, kind: 'image' | 'video' = 'image', apiBase = 'https://api.modellink.online/v1') {
  const model = BUILTIN_MODELS.find((model) => model.kind === kind && model.api_base === apiBase)!
  await f.service.store.saveModel({ ...model, api_key: 'fixture-model-key' })
  return model
}
async function chooseGeneration(f: Awaited<ReturnType<typeof fixture>>, model: { id: string; kind: 'image' | 'video'; name: string; api_base: string }, change = false) {
  const dispose = f.agent.ctx.on('user-questions/request', async (request) => ({ answers: [{
    id: request.questions[0].id, selected: [`${model.name} · ${providerFor(model)!.label}`],
  }] }))
  try { expect(await f.call('canvas_select_model', { kind: model.kind, ...(change ? { change: true } : {}) })).toMatchObject({ isError: false, value: { approved: true, selection: { modelId: model.id } } }) }
  finally { dispose() }
}
describe('Configured generation model choices', () => {
  it.each(BUILTIN_MODELS.filter((model) => model.protocol === 'kling-video'))('requires the exact Kling provider selected through native questions: $api_base', async (model) => {
    const f = await fixture()
    const other = BUILTIN_MODELS.find((item) => item.protocol === 'kling-video' && item.id !== model.id)!
    await f.service.store.saveModel({ ...model, api_key: 'selected-provider-key' })
    await f.service.store.saveModel({ ...other, api_key: 'other-provider-key' })
    const inspect = (await f.call('canvas_inspect', {})).value
    expect(inspect.models.map((item: any) => [item.id, item.provider])).toEqual(
      BUILTIN_MODELS.filter((item) => item.protocol === 'kling-video').map((item) => [item.id, providerFor(item)!.id]))
    await chooseGeneration(f, model)
    expect(f.coordinator.generationModels.current(f.agent, 'video')).toMatchObject({ modelId: model.id, provider: providerFor(model)!.id })
    expect(await f.call('canvas_create_node', { operationId: randomUUID(), revision: 0, kind: 'video-generation',
      title: '错误渠道', prompt: '镜头平移', modelId: other.id })).toMatchObject({ isError: true })
    const nodeId = randomUUID()
    expect(await f.call('canvas_create_node', { operationId: nodeId, revision: 0, kind: 'video-generation',
      title: 'Kling', prompt: '镜头平移', modelId: model.id })).toMatchObject({ isError: false })
    expect(f.service.store.state(f.canvasId).graph.nodes[0]).toMatchObject({ modelId: model.id,
      params: { size: '1080p/16:9', n: 1, seconds: 10, videoMode: 'text' } })
    const generate = vi.spyOn(f.service, 'generate')
    expect(await f.call('canvas_generate', { operationId: randomUUID(), revision: 1, nodeId })).toMatchObject({ isError: true })
    expect(generate).not.toHaveBeenCalled()
    expect(f.service.store.state(f.canvasId).tasks).toHaveLength(0)
  })
  it.each([false, true])('filters inspect to configured model/provider pairs, bound=%s', async (bound) => {
    const f = await fixture(bound)
    expect(await f.call('canvas_inspect', {})).toMatchObject({ value: { models: [], modelSelections: { image: null, video: null } } })
    const model = await configureGeneration(f)
    const result = (await f.call('canvas_inspect', {})).value as any
    expect(result.models).toHaveLength(1)
    expect(result.models[0]).toMatchObject({ id: model.id, modelId: model.id, providerName: 'Model Link', has_api_key: true })
    expect(JSON.stringify(result)).not.toContain('fixture-model-key')
    expect(result.models[0]).not.toHaveProperty('api_key_mask')
    expect(JSON.parse(f.contexts[0].text({ agent: f.agent })).models).toHaveLength(1)
  })
  it('excludes missing EP, credentialless, legacy and mock entries even if they appear in the underlying catalogue', async () => {
    const f = await fixture()
    const model = await configureGeneration(f), real = f.service.store.listModels().find((item) => item.id === model.id)!
    const missingEp = { ...real, ...BUILTIN_MODELS.find((item) => item.protocol === 'seedance-video' && providerFor(item)?.id === 'bytedance')!, has_api_key: true }
    const suspendedWan = BUILTIN_MODELS.filter((item) => item.protocol === 'wan-video').map((model) => ({
      ...real, ...model, api_base: 'https://api.modellink.online/wan/api/v1', has_api_key: true, configurable: false,
    }))
    vi.spyOn(f.service.store, 'listModels').mockReturnValue([real, missingEp, { ...real, has_api_key: false },
      { ...real, model_id: 'legacy-model', configurable: false }, ...suspendedWan, ...MOCK_MODELS.map((model) => ({ ...model, has_api_key: true }))])
    expect((await f.call('canvas_inspect', {})).value).toMatchObject({ models: [{ modelId: real.id }] })
    expect(f.coordinator.generationModels.models()).toHaveLength(1)
  })
  it('asks through the real native question service even for one choice before opening a canvas; reuse causes no graph/task changes', async () => {
    const f = await fixture(false), model = await configureGeneration(f), signal = new AbortController().signal
    const before = await f.service.store.snapshot(f.canvasId), catalog = await f.service.store.catalog()
    const answerer = vi.fn(async (request: AskUserQuestionRequest) => ({ answers: [{ id: request.questions[0].id, selected: [request.questions[0].options[0].label] }] }))
    f.agent.ctx.on('user-questions/request', answerer)
    expect(await f.call('canvas_select_model', { kind: 'image' }, signal)).toMatchObject({ isError: false, value: { approved: true, selection: { modelId: model.id, provider: 'model-link' }, reused: false } })
    expect(answerer.mock.calls[0][0]).toMatchObject({ agent: f.agent, signal, wait: { callId: expect.any(String) },
      questions: [{ multiSelect: false, options: [{ label: `${model.name} · Model Link` }] }] })
    expect(await f.call('canvas_select_model', { kind: 'image' })).toMatchObject({ value: { approved: true, reused: true } })
    expect(answerer).toHaveBeenCalledTimes(1)
    expect(await f.service.store.snapshot(f.canvasId)).toEqual(before)
    expect(await f.service.store.catalog()).toEqual(catalog)
    expect(f.coordinator.session(f.agent.id).canvas).toBeNull()
    await f.coordinator.delegate(f.canvasId, f.agent.id, 0)
    expect(await f.call('canvas_create_node', { operationId: randomUUID(), revision: 0, kind: 'image-generation', title: '选择后创建', prompt: '一只猫', modelId: model.id })).toMatchObject({ isError: false })
  })
  it('requests configuration only when no usable models of that type exist; choices are main-only', async () => {
    const f = await fixture(), answerer = vi.fn(async () => ({ answers: [] }))
    f.agent.ctx.on('user-questions/request', answerer)
    expect(await f.call('canvas_select_model', { kind: 'image' })).toMatchObject({ isError: false, value: { approved: false, needsConfiguration: true, models: [] } })
    await configureGeneration(f)
    expect(await f.call('canvas_select_model', { kind: 'video' })).toMatchObject({ value: { needsConfiguration: true } })
    expect(answerer).not.toHaveBeenCalled()
    expect(f.registry.get('canvas_select_model', await f.child())).toBeUndefined()
  })
  it.each([
    { selected: [] }, { selected: [], custom: '随便选一个' },
    { selected: ['invalid-model'] }, { selected: ['first', 'second'] },
    { selected: ['first'], custom: '先别用这个' },
  ])('does not count incomplete, invented or mixed answers as a model decision: %j', async (answer) => {
    const f = await fixture(), model = await configureGeneration(f)
    f.agent.ctx.on('user-questions/request', async (request) => ({ answers: [{ id: request.questions[0].id,
      ...answer, selected: answer.selected.map((label) => label === 'first' ? request.questions[0].options[0].label : label) }] }))
    expect(await f.call('canvas_select_model', { kind: 'image' })).toMatchObject({ isError: false, value: { approved: false } })
    expect(f.coordinator.generationModels.current(f.agent, 'image')).toBeNull()
    expect(await f.call('canvas_create_node', { operationId: randomUUID(), revision: 0, kind: 'image-generation', title: '不能创建', prompt: '猫', modelId: model.id })).toMatchObject({ isError: true })
  })
  it('requires the exact user-selected provider and media type on create, update and generate, including manually configured nodes', async () => {
    const f = await fixture(), selected = await configureGeneration(f), other = await configureGeneration(f, 'image', 'https://api.openai.com/v1')
    const video = await configureGeneration(f, 'video', 'https://maas.qianwenaiapi.com/api/v1')
    const generate = vi.spyOn(f.service, 'generate'), nodeId = randomUUID()
    await f.call('canvas_create_node', { operationId: nodeId, revision: 0, kind: 'image-generation', title: '规划', prompt: '猫' })
    const update = (modelId: string) => f.call('canvas_update_node', { operationId: randomUUID(), revision: 1, nodeId, patch: { modelId } })
    expect(await update(selected.id)).toMatchObject({ isError: true })
    await chooseGeneration(f, selected)
    expect(await update(other.id)).toMatchObject({ isError: true })
    expect(await update(video.id)).toMatchObject({ isError: true })
    expect(await f.call('canvas_create_node', { operationId: randomUUID(), revision: 1, kind: 'video-generation', title: '镜头', prompt: '猫', modelId: video.id })).toMatchObject({ isError: true })
    await f.service.store.update(f.canvasId, (state) => { state.graph.nodes[0].modelId = other.id; state.graphRevision++ })
    expect(await f.call('canvas_generate', { operationId: randomUUID(), revision: 2, nodeId })).toMatchObject({ isError: true })
    expect(generate).not.toHaveBeenCalled()
    expect(await f.call('canvas_update_node', { operationId: randomUUID(), revision: 2, nodeId, patch: { modelId: selected.id } })).toMatchObject({ isError: false })
    expect(f.coordinator.generationModels.current(f.agent, 'video')).toBeNull()
    expect(f.service.store.state(f.canvasId).tasks).toHaveLength(0)
  })
  it('can confirm video independently; requesting a replacement asks again and revokes the old choice on decline', async () => {
    const f = await fixture(), image = await configureGeneration(f), video = await configureGeneration(f, 'video', 'https://maas.qianwenaiapi.com/api/v1')
    await chooseGeneration(f, image); await chooseGeneration(f, video)
    expect(f.coordinator.generationModels.selections(f.agent)).toMatchObject({ image: { modelId: image.id }, video: { modelId: video.id } })
    const ask = vi.fn(async (request: AskUserQuestionRequest) => ({ answers: [{ id: request.questions[0].id, selected: [], custom: '暂时不用' }] }))
    f.agent.ctx.on('user-questions/request', ask)
    expect(await f.call('canvas_select_model', { kind: 'image', change: true })).toMatchObject({ value: { approved: false } })
    expect(ask).toHaveBeenCalledTimes(1)
    expect(f.coordinator.generationModels.selections(f.agent)).toMatchObject({ image: null, video: { modelId: video.id } })
  })
  it.each(['cancel', 'takeover', 'delete-config', 'change-ep', 'unregister', 'bind'] as const)('rejects a late native model answer after %s', async (action) => {
    const f = await fixture(action !== 'bind'), controller = new AbortController()
    const model = action === 'change-ep'
      ? BUILTIN_MODELS.find((model) => model.protocol === 'seedream-image' && providerFor(model)?.id === 'bytedance')!
      : BUILTIN_MODELS[0]
    await f.service.store.saveModel({ ...model, api_key: 'fixture-key', ...(action === 'change-ep' ? { endpoint_id: 'ep-original' } : {}) })
    f.agent.ctx.on('user-questions/request', async (request) => {
      if (action === 'cancel') controller.abort()
      if (action === 'takeover') await f.coordinator.takeover(f.canvasId)
      if (action === 'delete-config') await f.service.store.deleteModel(model.id)
      if (action === 'change-ep') await f.service.store.saveModel({ ...model, endpoint_id: 'ep-changed' })
      if (action === 'unregister') f.coordinator.unregister(f.agent)
      if (action === 'bind') await f.coordinator.delegate(f.canvasId, f.agent.id, 0)
      return { answers: [{ id: request.questions[0].id, selected: [request.questions[0].options[0].label] }] }
    })
    expect(await f.call('canvas_select_model', { kind: 'image' }, controller.signal)).toMatchObject({ isError: true })
    expect(f.coordinator.generationModels.current(f.agent, 'image')).toBeNull()
    expect(f.service.store.state(f.canvasId).graph.nodes).toHaveLength(0)
  })
  it('invalidates approved choices on configuration removal, route change, takeover and canvas switch', async () => {
    const f = await fixture(), model = await configureGeneration(f)
    await chooseGeneration(f, model)
    await f.service.store.deleteModel(model.id)
    expect(f.coordinator.generationModels.current(f.agent, 'image')).toBeNull()
    await configureGeneration(f); await chooseGeneration(f, model)
    f.coordinator.setRoute(f.agent, { provider: 'fixture', model: 'vision' })
    f.coordinator.setRoute(f.agent, { provider: 'another', model: 'vision' })
    expect(f.coordinator.generationModels.current(f.agent, 'image')).toBeNull()
    await chooseGeneration(f, model); await f.coordinator.takeover(f.canvasId)
    expect(f.coordinator.generationModels.current(f.agent, 'image')).toBeNull()
    await f.coordinator.delegate(f.canvasId, f.agent.id); await chooseGeneration(f, model)
    await f.coordinator.takeover(f.canvasId); await f.coordinator.delegate(f.canvasId, f.agent.id); await chooseGeneration(f, model)
    // Leave the old canvas in manual mode without granting a late answer there.
    f.coordinator.ledger.setControl({ ...f.coordinator.control(f.canvasId), mode: 'manual' })
    const another = await f.service.store.catalogCommand({ requestId: randomUUID(), operation: 'canvas-create', name: '另一个' })
    await f.coordinator.delegate(another.id, f.agent.id, 0)
    expect(f.coordinator.generationModels.current(f.agent, 'image')).toBeNull()
  })
  it('rechecks the approved choice at commit and refuses configuration drift while graph work is waiting', async () => {
    const f = await fixture(), model = await configureGeneration(f)
    await chooseGeneration(f, model)
    const mutate = f.service.mutateGraph.bind(f.service)
    vi.spyOn(f.service, 'mutateGraph').mockImplementation(async (canvas, input, guard) => {
      f.coordinator.generationModels.clear(f.agent)
      return mutate(canvas, input, guard)
    })
    expect(await f.call('canvas_create_node', { operationId: randomUUID(), revision: 0, kind: 'image-generation', title: '猫', prompt: '猫', modelId: model.id })).toMatchObject({ isError: true })
    expect(f.service.store.state(f.canvasId).graph.nodes).toHaveLength(0)
  })
  it('keeps selected model and default params across partial edits; unconfigured identities cannot create a node', async () => {
    const f = await fixture(), model = await configureGeneration(f), nodeId = randomUUID()
    await chooseGeneration(f, model)
    expect(await f.call('canvas_create_node', { operationId: nodeId, revision: 0, kind: 'image-generation', title: '猫', prompt: '蓝色猫', modelId: model.id })).toMatchObject({ isError: false })
    const original = f.service.store.state(f.canvasId).graph.nodes[0]
    expect(original.params).not.toBeNull()
    expect(await f.call('canvas_update_node', { operationId: randomUUID(), revision: 1, nodeId, patch: { title: '新名称' } })).toMatchObject({ isError: false })
    expect(f.service.store.state(f.canvasId).graph.nodes[0]).toMatchObject({ modelId: model.id, params: original.params, prompt: original.prompt })
    expect(await f.call('canvas_create_node', { operationId: randomUUID(), revision: 2, kind: 'image-generation', title: '未配置', prompt: '猫', modelId: BUILTIN_MODELS[1].id })).toMatchObject({ isError: true })
    expect(f.service.store.state(f.canvasId).graph.nodes).toHaveLength(1)
  })
  it('rejects superseded answers from overlapping model questions', async () => {
    const f = await fixture(); await configureGeneration(f)
    let answer!: (value: AskUserQuestionAnswer) => void, opened!: () => void
    const opening = new Promise<void>((resolve) => { opened = resolve })
    let count = 0, label = ''
    f.agent.ctx.on('user-questions/request', async (request) => {
      label = request.questions[0].options[0].label
      if (++count === 1) { opened(); return new Promise<AskUserQuestionAnswer>((resolve) => { answer = resolve }) }
      return { answers: [{ id: request.questions[0].id, selected: [label] }] }
    })
    const first = f.call('canvas_select_model', { kind: 'image' })
    await opening
    expect(await f.call('canvas_select_model', { kind: 'image', change: true })).toMatchObject({ isError: false, value: { approved: true } })
    answer({ answers: [{ id: 'canvas-model-image', selected: [label] }] })
    expect(await first).toMatchObject({ isError: true })
  })
  it('blocks image dispatch even with a selected model and leaves no task or submission identity', async () => {
    const f = await fixture(), model = await configureGeneration(f), nodeId = randomUUID()
    await chooseGeneration(f, model)
    await f.call('canvas_create_node', { operationId: nodeId, revision: 0, kind: 'image-generation', title: '猫', prompt: '猫', modelId: model.id })
    const generate = f.service.generate.bind(f.service)
    vi.spyOn(f.service, 'generate').mockImplementation(async (...args) => {
      f.coordinator.generationModels.clear(f.agent)
      return generate(...args)
    })
    vi.spyOn(f.service.runtime, 'wake').mockImplementation(() => {})
    expect(await f.call('canvas_generate', { operationId: randomUUID(), revision: 1, nodeId })).toMatchObject({ isError: true })
    expect(f.service.store.state(f.canvasId).tasks).toHaveLength(0)
    expect(await f.service.store.db.all('SELECT * FROM task_catalog')).toHaveLength(0)
    expect(f.service.generate).not.toHaveBeenCalled()
  })
  it('recovers an accepted task without a new service dispatch or model confirmation after receipt loss', async () => {
    const f = await fixture(), model = await configureGeneration(f), nodeId = randomUUID()
    await chooseGeneration(f, model)
    expect(await f.call('canvas_create_node', { operationId: nodeId, revision: 0, kind: 'image-generation', title: '猫', prompt: '猫', modelId: model.id })).toMatchObject({ isError: false })
    const args = { operationId: randomUUID(), revision: 1, nodeId }
    const hex = hash({ namespace: 'canvas-agent-generation', canvasId: f.canvasId, operationId: args.operationId }).slice(0, 32)
    const requestId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`
    vi.spyOn(f.service.runtime, 'wake').mockImplementation(() => {})
    const task = await f.service.generate(f.canvasId, nodeId, 1, requestId)
    f.coordinator.generationModels.clear(f.agent)
    const generate = vi.spyOn(f.service, 'generate')
    expect(await f.call('canvas_generate', args)).toMatchObject({ isError: false, value: { taskId: task.id } })
    expect(generate).not.toHaveBeenCalled()
    expect(f.service.store.state(f.canvasId).tasks).toHaveLength(1)
    expect(await f.call('canvas_generate', { ...args, revision: 2 })).toMatchObject({ isError: true })
  })
})

describe('Creative project sources and scoped delegation', () => {
  it('imports workspace and root attachments without creating a canvas, snapshots changed sources and reads Unicode pages honestly', async () => {
    const f = await fixture(false), text = '第1章 起点\n' + '汉字🙂'.repeat(7000) + '\n第2章 后续\n结尾'
    const path = join(f.dir, '原文.txt'); await writeFile(path, text)
    const before = await f.service.store.catalog()
    const imported = (await f.call('creative_source_import', { path: '原文.txt' })).value as any
    expect(imported.source).toMatchObject({ version: 1, length: text.length, encoding: 'utf-8' })
    expect(imported).not.toHaveProperty('text')
    expect(await f.service.store.catalog()).toEqual(before)
    const project = (await f.call('creative_project', {})).value as any
    const page = await f.coordinator.creative.page(project.project.id, imported.source.id, 0, 12000, new AbortController().signal)
    const rest = await f.coordinator.creative.page(project.project.id, imported.source.id, page.next!, 12000, new AbortController().signal)
    expect(page.text + rest.text).toBe(text.slice(0, rest.end))
    expect(/[\uD800-\uDBFF]$/.test(page.text)).toBe(false)
    await writeFile(path, '第1章 改版\n新的正文')
    expect((await f.call('creative_source_import', { path: '原文.txt' })).value).toMatchObject({ source: { version: 2 } })
    expect((await f.coordinator.creative.page(project.project.id, imported.source.id, 0, 100, new AbortController().signal)).text).toBe(text.slice(0, 100))
    f.events.push({ type: 'user/message', data: { id: 'source-message', source: { kind: 'user' }, content: [
      { type: 'file', attachment: { attachmentId: 'novel-upload', name: '上传.md', bytes: 20 } },
    ] } })
    Object.assign(f.ctx.attachments, { readFileStream: async function* () { yield Buffer.from('# 上传资料\n正文') } })
    expect((await f.call('creative_source_import', { attachmentId: 'novel-upload' })).value).toMatchObject({ source: { origin: 'attachment:novel-upload' }, sectionCount: 1 })
    expect(await f.call('creative_source_import', { attachmentId: 'invented' })).toMatchObject({ isError: true })
    await symlink(path, join(f.dir, '链接.txt'))
    expect(await f.call('creative_source_import', { path: '链接.txt' })).toMatchObject({ isError: true })
    expect(await f.call('creative_source_import', { path: '../outside.txt' })).toMatchObject({ isError: true })
    expect(f.registry.get('creative_source_read', f.agent)).toBeUndefined()
  })
  it('spawns a professional before canvas creation, restricts source reads and persists checkpoint artifacts through an interrupted batch', async () => {
    const f = await fixture(false); f.coordinator.setRoute(f.agent, { provider: 'fixture', model: 'vision' })
    await writeFile(join(f.dir, '小说.txt'), '第1章\n第一单元正文\n第2章\n第二单元正文')
    await writeFile(join(f.dir, '未授权.txt'), '不应读取')
    const first = ((await f.call('creative_source_import', { path: '小说.txt' })).value as any).source
    const other = ((await f.call('creative_source_import', { path: '未授权.txt' })).value as any).source
    const artifactId = randomUUID(), taskId = randomUUID(), requests: any[] = []
    Object.assign(f.ctx.subagents, { startActivation: async (spec: any) => {
      requests.push(spec)
      const record = f.coordinator.collaboration.task(f.agent.id, taskId)
      expect(record).toMatchObject({ childId: spec.childId, role: 'assets', state: 'dispatched', commandCount: 0 })
      f.coordinator.collaboration.observe(spec.childId, { seq: 0, type: 'step/start', time: 1, data: { turn: 1, step: 1 } } as any)
      const child = await f.child('assets', spec.childId)
      // Real startup registration consumes the host-reserved binding before any tool executes.
      const call = (name: string, args: unknown) => f.registry.execute({ agent: child, name, arguments: args, callId: ToolCallId(randomUUID()), signal: spec.signal })
      const result = (async () => {
        expect(await call('creative_source_read', { sourceId: other.id, start: 0 })).toMatchObject({ isError: true })
        expect(await call('creative_source_read', { sourceId: first.id, start: 0, length: 12 })).toMatchObject({ isError: false })
        expect(await call('creative_artifact_save', { artifactId: randomUUID(), draft: simpleDraft(), sources: [{ sourceId: first.id, start: 12, end: 20 }] })).toMatchObject({ isError: true })
        expect(await call('creative_artifact_save', { artifactId, draft: simpleDraft(), sources: [{ sourceId: first.id, start: 0, end: 12 }] })).toMatchObject({ isError: false })
        return { stopReason: 'max-tokens', output: [] }
      })()
      return { childId: child.id, result, dispose: async () => { f.coordinator.unregister(child) } }
    } })
    expect(await f.call('canvas_specialist', { operationId: taskId, role: 'assets', task: '按单元分析；未读取部分保持待分析', sourceIds: [first.id] })).toMatchObject({ isError: true })
    const project = (await f.call('creative_project', {})).value as any
    expect(project.runs.find((r: any) => r.id === taskId)).toMatchObject({ state: 'blocked', artifactOutputIds: [artifactId], readRanges: [{ sourceId: first.id, start: 0, end: 12 }] })
    expect(project.artifacts[0]).toMatchObject({ id: artifactId, status: 'draft' })
    expect(f.coordinator.collaboration.task(f.agent.id, taskId)).toMatchObject({ state: 'blocked', artifactRefs: [{ id: artifactId, status: 'draft' }] })
    expect(JSON.stringify(requests[0].request.prompt)).not.toContain('第一单元正文')
    expect(await f.call('canvas_specialist', { operationId: taskId, role: 'assets', task: '按单元分析；未读取部分保持待分析', sourceIds: [first.id] })).toMatchObject({ isError: true })
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ label: '视觉资产', request: { agentPreset: 'canvas-assets' } })
    const reloaded = new CreativeProjects(f.dir); await reloaded.init()
    expect(reloaded.run(project.project.id, taskId)).toMatchObject({ state: 'blocked', artifactOutputIds: [artifactId] })
    expect(reloaded.artifact(project.project.id, artifactId).file.path).toContain('Agent 创作')
    expect(f.coordinator.session(f.agent.id).canvas).toBeNull()
    Object.assign(f.ctx.subagents, { startActivation: async (spec: any) => {
      requests.push(spec)
      const child = await f.child('assets', spec.childId)
      const result = (async () => {
        expect(await f.registry.execute({ agent: child, name: 'creative_source_read', arguments: { sourceId: first.id, start: 12, length: 12 },
          callId: ToolCallId(randomUUID()), signal: spec.signal })).toMatchObject({ isError: false })
        return { stopReason: 'completed', structured: simpleDraft('第二单元', [artifactId]), output: [] }
      })()
      return { childId: child.id, result, dispose: async () => { f.coordinator.unregister(child) } }
    } })
    const nextArgs = { operationId: randomUUID(), role: 'assets', task: '从已读12处继续，复用上一单元成果', sourceIds: [first.id], artifactIds: [artifactId] }
    const completed = await f.call('canvas_specialist', nextArgs)
    expect(completed).toMatchObject({ isError: false, value: { taskId: nextArgs.operationId, status: 'draft', baseRevision: null } })
    const finalArtifactId = (completed.value as any).artifactId
    expect(finalArtifactId).not.toBe(nextArgs.operationId)
    expect(await f.call('canvas_specialist', nextArgs)).toMatchObject({ isError: false })
    expect(requests).toHaveLength(2)
    const finalReload = new CreativeProjects(f.dir); await finalReload.init()
    expect(finalReload.run(project.project.id, nextArgs.operationId)).toMatchObject({ state: 'completed' })
    expect(finalReload.artifact(project.project.id, finalArtifactId).draft.dependencies).toEqual([artifactId])
    expect(f.coordinator.collaboration.task(f.agent.id, taskId).main).toBe('responded')
    const monitored = await f.service.handle(new Request(`http://localhost/api/canvas/v2/agent-collaboration?sessionId=${f.agent.id}`))
    expect(await monitored.json()).toMatchObject({ total: 2 })
    expect((await f.service.handle(new Request(`http://localhost/api/canvas/v2/agent-collaboration-detail?sessionId=unrelated&id=${taskId}`))).status).toBe(404)
    expect((await f.service.handle(new Request(`http://localhost/api/canvas/v2/agent-collaboration?sessionId=${f.agent.id}&limit=101`))).status).toBe(400)
  })
  it('uses an object-rooted native schema for saved references and unsaved drafts', () => {
    assertObjectJsonSchema(SpecialistOutput)
    expect(validateJsonSchemaValue(SpecialistOutput, { result: { artifactId: randomUUID(), summary: '已保存' } })).toEqual([])
    expect(validateJsonSchemaValue(SpecialistOutput, { result: simpleDraft() })).toEqual([])
    expect(validateJsonSchemaValue(SpecialistOutput, simpleDraft())).not.toEqual([])
    expect(validateJsonSchemaValue(SpecialistOutput, { result: { artifactId: randomUUID(), ...simpleDraft() } })).not.toEqual([])
  })
  it('hands off saved final artifacts once, retaining exact files, citations, versions and user approval', async () => {
    const f = await fixture(false); f.coordinator.setRoute(f.agent, { provider: 'fixture', model: 'vision' })
    await writeFile(join(f.dir, '原文.txt'), '一份已实际读取的原文')
    const source = ((await f.call('creative_source_import', { path: '原文.txt' })).value as any).source
    const taskId = randomUUID(), artifactId = randomUUID(), sources = [{ sourceId: source.id, start: 0, end: 6 }]
    let saved: any, initialStat: any
    const spawn = vi.fn(async (spec: any) => {
      assertObjectJsonSchema(spec.request.outputSchema)
      const child = await f.child('assets', spec.childId)
      const call = (name: string, args: unknown) => f.registry.execute({ agent: child, name, arguments: args, callId: ToolCallId(randomUUID()), signal: spec.signal })
      const result = (async () => {
        expect(await call('creative_source_read', { sourceId: source.id, start: 0, length: 6 })).toMatchObject({ isError: false })
        expect(await call('creative_artifact_save', { artifactId: randomUUID(), draft: simpleDraft('最终分镜'), sources })).toMatchObject({ isError: false })
        const receipt = await call('creative_artifact_save', { artifactId, draft: { ...simpleDraft('最终分镜'), content: '第二版最终内容' }, sources })
        expect(receipt).toMatchObject({ isError: false })
        saved = (receipt.value as any).artifact
        expect(await f.call('creative_artifact_decide', { artifactId, status: 'approved', userDecision: '用户确认此版' })).toMatchObject({ isError: false })
        saved = f.coordinator.creative.artifact(saved.projectId, artifactId)
        initialStat = await stat(saved.file.path)
        return { stopReason: 'completed', structured: { result: { artifactId, summary: '交接已保存的第二版' } } }
      })()
      return { childId: child.id, result, dispose: async () => f.coordinator.unregister(child) }
    })
    Object.assign(f.ctx.subagents, { startActivation: spawn })
    const args = { operationId: taskId, role: 'assets', task: '保存并交接最终成果', sourceIds: [source.id] }
    const receipt = await f.call('canvas_specialist', args)
    expect(receipt).toMatchObject({ isError: false, value: {
      taskId, artifactId, version: 2, status: 'approved', sources, file: saved.file, draft: saved.draft, needsReview: false,
    } })
    expect((receipt.value as any).artifactOutputIds).toHaveLength(2)
    expect(await f.call('canvas_specialist', args)).toMatchObject({ isError: false, value: receipt.value })
    expect(spawn).toHaveBeenCalledTimes(1)
    const finalStat = await stat(saved.file.path)
    expect([finalStat.ino, finalStat.mtimeMs, finalStat.size]).toEqual([initialStat.ino, initialStat.mtimeMs, initialStat.size])
    const reloaded = new CreativeProjects(f.dir); await reloaded.init()
    expect(reloaded.artifact(saved.projectId, artifactId)).toEqual(saved)
    expect(reloaded.run(saved.projectId, taskId)).toMatchObject({ state: 'completed', artifactOutputIds: (receipt.value as any).artifactOutputIds })
  })
  it.each(['flat', 'wrapped', 'changed'] as const)('compatibly handles a legacy artifact with a batch ID: %s', async (shape) => {
    const f = await fixture(false); f.coordinator.setRoute(f.agent, { provider: 'fixture', model: 'vision' })
    const taskId = randomUUID(), original = simpleDraft('既有成果'), final = shape === 'changed' ? simpleDraft('新的最终成果') : original
    let saved: any
    const spawn = vi.fn(async (spec: any) => {
      const child = await f.child('assets', spec.childId), binding = f.coordinator.binding(child)
      // Seed an older mixed-ID record; new save tools must never create this shape.
      const path = join(await realpath(f.dir), 'legacy.md'), body = Buffer.from('保留旧正文及格式')
      await writeFile(path, body, { mode: 0o600 })
      saved = f.coordinator.creative.saveArtifact({ id: taskId, taskId, projectId: binding.projectId,
        draft: original, sources: [], author: child.id, version: 1, status: 'draft', createdAt: 1,
        file: { path, relativePath: 'legacy.md', bytes: body.length, sha256: hashBytes(body) } })
      await f.coordinator.creative.persist()
      // Reorder wire keys to ensure the compatibility match is canonical.
      const draft = { assetIds: final.assetIds, content: final.content, dependencies: final.dependencies, title: final.title, kind: final.kind }
      return { childId: child.id, result: Promise.resolve({ stopReason: 'completed', structured: shape === 'flat' ? draft : { result: draft } }),
        dispose: async () => f.coordinator.unregister(child) }
    })
    Object.assign(f.ctx.subagents, { startActivation: spawn })
    const args = { operationId: taskId, role: 'assets', task: '兼容旧批次成果' }
    const completed = await f.call('canvas_specialist', args)
    expect(completed).toMatchObject({ isError: false, value: { taskId, draft: final } })
    const value = completed.value as any
    if (shape === 'changed') {
      expect(value.artifactId).not.toBe(taskId)
      expect(value.artifactOutputIds).toEqual([taskId, value.artifactId])
    } else {
      expect(value).toMatchObject({ artifactId: taskId, file: saved.file, artifactOutputIds: [taskId] })
      expect(await readdir(f.dir)).not.toContain('Agent 创作')
    }
    expect(await readFile(saved.file.path, 'utf8')).toBe('保留旧正文及格式')
    expect(await f.call('canvas_specialist', args)).toMatchObject({ isError: false, value })
    expect(spawn).toHaveBeenCalledTimes(1)
  })
  it('rejects a batch ID before writing and retains full UUID suffixes for long equal titles', async () => {
    const f = await fixture(false), child = await f.child(), taskId = f.coordinator.binding(child).taskId
    const call = (artifactId: string) => f.registry.execute({ agent: child, name: 'creative_artifact_save',
      arguments: { artifactId, draft: simpleDraft('超长中文标题😀'.repeat(16)), sources: [] }, callId: ToolCallId(randomUUID()), signal: new AbortController().signal })
    expect(await call(taskId)).toMatchObject({ isError: true })
    expect(await readdir(f.dir)).not.toContain('Agent 创作')
    const ids = [randomUUID(), randomUUID()], files: any[] = []
    for (const id of ids) {
      const receipt = await call(id)
      expect(receipt).toMatchObject({ isError: false })
      const file = (receipt.value as any).artifact.file, filename = file.path.split('/').at(-1)!
      expect(filename.endsWith(`-${id}.md`)).toBe(true)
      expect(Buffer.byteLength(filename)).toBeLessThanOrEqual(140)
      expect(filename).not.toContain('\uFFFD')
      files.push(file)
    }
    expect(files[0].path).not.toBe(files[1].path)
    expect(await call(ids[1])).toMatchObject({ isError: false, value: { artifact: { file: files[1] } } })
  })
  it.each(['upstream', 'foreign', 'missing', 'modified', 'cwd'] as const)('blocks invalid saved completion without extra writes or respawn: %s', async (failure) => {
    const f = await fixture(false); f.coordinator.setRoute(f.agent, { provider: 'fixture', model: 'vision' })
    const taskId = randomUUID(), artifactId = randomUUID(), project = f.coordinator.creative.project(f.agent.id, await realpath(f.dir))
    const upstream = failure === 'upstream' || failure === 'foreign'
    if (upstream) {
      const foreign = f.coordinator.creative.project('foreign-root', await realpath(f.dir))
      const path = join(f.dir, 'input.md'), body = Buffer.from('原输入')
      await writeFile(path, body)
      f.coordinator.creative.saveArtifact({ id: artifactId, taskId: randomUUID(), projectId: failure === 'foreign' ? foreign.id : project.id,
        draft: simpleDraft(), sources: [], author: 'old-child', version: 1, createdAt: 1, status: 'draft',
        file: { path, relativePath: 'input.md', bytes: body.length, sha256: hashBytes(body) } })
    }
    const nextCwd = await mkdtemp(join(tmpdir(), 'canvas-handoff-cwd-'))
    cleanup.push(() => rm(nextCwd, { recursive: true, force: true }))
    const spawn = vi.fn(async (spec: any) => {
      const child = await f.child('assets', spec.childId)
      const result = (async () => {
        if (!upstream) {
          const receipt = await f.registry.execute({ agent: child, name: 'creative_artifact_save',
            arguments: { artifactId, draft: simpleDraft(), sources: [] }, callId: ToolCallId(randomUUID()), signal: spec.signal })
          expect(receipt).toMatchObject({ isError: false })
          const file = (receipt.value as any).artifact.file
          if (failure === 'missing') await rm(file.path)
          if (failure === 'modified') await writeFile(file.path, '用户修改')
          if (failure === 'cwd') f.setCwd(nextCwd)
        }
        return { stopReason: 'completed', structured: { result: { artifactId } } }
      })()
      return { childId: child.id, result, dispose: async () => f.coordinator.unregister(child) }
    })
    Object.assign(f.ctx.subagents, { startActivation: spawn })
    const args = { operationId: taskId, role: 'assets', task: '核对交接范围和实际文件', artifactIds: failure === 'upstream' ? [artifactId] : [] }
    expect(await f.call('canvas_specialist', args)).toMatchObject({ isError: true })
    expect(f.coordinator.creative.run(project.id, taskId)).toMatchObject({ state: 'blocked', artifactOutputIds: upstream ? [] : [artifactId] })
    f.setCwd(f.dir)
    expect(await f.call('canvas_specialist', args)).toMatchObject({ isError: true })
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(f.coordinator.creative.summary(project.id).totals.artifacts).toBe(failure === 'foreign' ? 0 : 1)
    expect(await readdir(nextCwd)).toEqual([])
  })
  it('runs an executor batch with root model selection and presentation, denies extra creative intent and proves completion from actual receipts', async () => {
    const f = await fixture(); f.coordinator.setRoute(f.agent, { provider: 'fixture', model: 'vision' })
    const model = await configureGeneration(f); await chooseGeneration(f, model)
    const nodeId = randomUUID(), commands: ExecutionCommand[] = [
      { tool: 'canvas_create_node', input: { operationId: nodeId, revision: 0, kind: 'image-generation', title: '单图', prompt: '中文画面', modelId: model.id } },
      { tool: 'canvas_update_node', input: { operationId: randomUUID(), revision: 0, nodeId, patch: { title: '已调整' } } },
    ]
    let spawns = 0
    Object.assign(f.ctx.subagents, { startActivation: async (spec: any) => {
      spawns++; expect(spec.request.agentPreset).toBe('canvas-executor')
      const child = await f.child('executor', spec.childId)
      const result = (async () => {
        const call = (tool: string, input: unknown) => f.registry.execute({ agent: child, name: tool, arguments: input, callId: ToolCallId(randomUUID()), signal: spec.signal })
        expect(await call('canvas_create_node', { ...commands[0].input, prompt: '自行改方向' })).toMatchObject({ isError: true })
        for (const command of commands) expect(await call(command.tool, { ...command.input, revision: f.service.store.state(f.canvasId).graphRevision })).toMatchObject({ isError: false })
        expect(f.coordinator.presentation.current(f.canvasId)).toMatchObject({ sessionId: f.agent.id, nodeIds: [nodeId] })
        expect(f.registry.get('ask_user_question', child)).toBeUndefined()
        return { stopReason: 'completed', structured: { status: 'completed', summary: '清单完成' }, output: [] }
      })()
      return { childId: child.id, result, dispose: async () => { f.coordinator.unregister(child) } }
    } })
    const args = { operationId: randomUUID(), task: '单图准备并改名', commands }
    expect(await f.call('canvas_execute', args)).toMatchObject({ isError: false, value: { completed: true, revision: 2, receipts: [{ tool: 'canvas_create_node' }, { tool: 'canvas_update_node' }] } })
    expect(await f.call('canvas_execute', args)).toMatchObject({ isError: false, value: { completed: true } })
    expect(spawns).toBe(1)
    expect(f.coordinator.collaboration.task(f.agent.id, args.operationId)).toMatchObject({
      state: 'completed', commandCount: 2, receiptIds: commands.map((command) => command.input.operationId), nodeIds: [nodeId],
    })
    expect(f.service.store.state(f.canvasId).graph.nodes).toMatchObject([{ id: nodeId, title: '已调整', prompt: '中文画面', modelId: model.id }])
    expect(f.service.store.state(f.canvasId).tasks).toHaveLength(0)
    expect(await f.rawCall('canvas_update_node', commands[1].input)).toMatchObject({ isError: true })
  })
  it('does not trust an executor completion claim and rejects late writes after a root takeover', async () => {
    const f = await fixture(); f.coordinator.setRoute(f.agent, { provider: 'fixture', model: 'vision' })
    const command: ExecutionCommand = { tool: 'canvas_create_node', input: { operationId: randomUUID(), revision: 0, kind: 'image-generation', title: '迟到', prompt: '' } }
    let childAgent: Agent | undefined
    Object.assign(f.ctx.subagents, { startActivation: async (spec: any) => {
      childAgent = await f.child('executor', spec.childId)
      return { childId: childAgent.id, result: Promise.resolve({ stopReason: 'completed', structured: { status: 'completed', summary: '虚报' } }), dispose: async () => {} }
    } })
    expect(await f.call('canvas_execute', { operationId: randomUUID(), task: '验证回执', commands: [command] })).toMatchObject({ isError: false, value: { completed: false, receipts: [{ receipt: null }] } })
    await f.coordinator.takeover(f.canvasId)
    expect(await f.registry.execute({ agent: childAgent!, name: command.tool, arguments: command.input, callId: ToolCallId(randomUUID()), signal: new AbortController().signal })).toMatchObject({ isError: true })
    expect(f.service.store.state(f.canvasId).graph.nodes).toHaveLength(0)
  })
  it('fans out real scoped executor tools, rebases independent commits and removes only the finished cursor', async () => {
    const f = await fixture(); f.coordinator.setRoute(f.agent, { provider: 'fixture', model: 'vision' })
    const nodeIds = [randomUUID(), randomUUID()]
    for (const nodeId of nodeIds) expect(await f.call('canvas_create_node', {
      operationId: nodeId, revision: f.service.store.state(f.canvasId).graphRevision, kind: 'image-generation', title: '初稿', prompt: '',
    })).toMatchObject({ isError: false })
    for (const cursor of f.coordinator.presentation.state(f.agent.id).cursors.active) f.coordinator.presentation.endExecutor(cursor.childId)
    const tasks = nodeIds.map((nodeId, index) => ({ operationId: randomUUID(), task: `改名${index}`, dependsOn: [],
      commands: [{ tool: 'canvas_update_node', input: { operationId: randomUUID(), revision: 2, nodeId, patch: { title: `成果${index}` } } }] }))
    let overlap = 0, peak = 0, count = 0, releaseStart!: () => void, ready!: () => void
    const startGate = new Promise<void>((resolve) => { releaseStart = resolve })
    const bothWritten = new Promise<void>((resolve) => { ready = resolve })
    const finishes = tasks.map(() => { let finish!: () => void; const promise = new Promise<void>((resolve) => { finish = resolve }); return { finish, promise } })
    const childIds: string[] = []
    Object.assign(f.ctx.subagents, { startActivation: async (spec: any) => {
      const index = childIds.length; childIds.push(spec.childId)
      const child = await f.child('executor', spec.childId)
      const result = (async () => {
        peak = Math.max(peak, ++overlap)
        if (overlap === 2) releaseStart()
        await startGate
        const command = tasks[index].commands[0]
        const written = await f.registry.execute({ agent: child, name: command.tool, arguments: command.input, callId: ToolCallId(randomUUID()), signal: spec.signal })
        if (written.isError) throw new Error(JSON.stringify(written))
        expect(written).toMatchObject({ isError: false })
        if (++count === 2) ready()
        await finishes[index].promise
        overlap--
        return { stopReason: 'completed', structured: { status: 'completed', summary: '回执已保存' } }
      })()
      return { childId: child.id, result, dispose: async () => f.coordinator.unregister(child) }
    } })
    const pending = f.rawCall('canvas_execute_parallel', { operationId: randomUUID(), tasks })
    await Promise.race([bothWritten, pending.then((value) => { throw new Error(`并行任务过早返回：${JSON.stringify(value)}`) })])
    expect(peak).toBe(2)
    expect(f.service.store.state(f.canvasId).graphRevision).toBe(4)
    expect(f.coordinator.presentation.state(f.agent.id).cursors.active.filter((cursor) => childIds.includes(cursor.childId))).toHaveLength(2)
    expect(f.coordinator.presentation.current(f.canvasId)?.nodeIds).toEqual([nodeIds[0]])
    finishes[0].finish()
    // Observe the actual finally path, not a timer-based UI assumption.
    await vi.waitFor(() => expect(f.coordinator.presentation.state(f.agent.id).cursors.active.some((cursor) => cursor.childId === childIds[0])).toBe(false))
    expect(f.coordinator.presentation.state(f.agent.id).cursors.active.some((cursor) => cursor.childId === childIds[1])).toBe(true)
    finishes[1].finish()
    expect(await pending).toMatchObject({ isError: false, value: { completed: true, tasks: [{ status: 'completed' }, { status: 'completed' }] } })
    expect(f.coordinator.presentation.state(f.agent.id).cursors.active.filter((cursor) => childIds.includes(cursor.childId))).toHaveLength(0)
    expect(f.service.store.state(f.canvasId).graph.nodes.map((node) => node.title)).toEqual(['成果0', '成果1'])
  })
  it('automatically divides one ten-create call into four real executors, preserves ordered receipts and never respawns replay', async () => {
    const f = await fixture(); f.coordinator.setRoute(f.agent, { provider: 'fixture', model: 'vision' })
    const model = await configureGeneration(f); await chooseGeneration(f, model)
    const commands: ExecutionCommand[] = Array.from({ length: 10 }, (_, index) => ({
      tool: 'canvas_create_node', input: { operationId: randomUUID(), revision: 0, kind: 'image-generation', modelId: model.id, title: `节点${index}`, prompt: `已确定提示词${index}` },
    }))
    let active = 0, peak = 0, writes = 0, start!: () => void, ready!: () => void
    const gate = new Promise<void>((resolve) => { start = resolve }), written = new Promise<void>((resolve) => { ready = resolve })
    const finishes = Array.from({ length: 4 }, () => { let finish!: () => void; const promise = new Promise<void>((resolve) => { finish = resolve }); return { finish, promise } })
    const childIds: string[] = [], taskIds: string[] = [], actualCommands: ExecutionCommand[] = []
    Object.assign(f.ctx.subagents, { startActivation: async (spec: any) => {
      const index = childIds.length; childIds.push(spec.childId)
      const prompt = JSON.parse(spec.request.prompt[0].text)
      taskIds.push(prompt.binding.taskId); actualCommands.push(...prompt.commands)
      const child = await f.child('executor', spec.childId)
      const result = (async () => {
        peak = Math.max(peak, ++active); if (active === 4) start()
        await gate
        const foreign = commands.find((command) => !prompt.commands.some((own: ExecutionCommand) => own.input.operationId === command.input.operationId))!
        expect(await f.registry.execute({ agent: child, name: foreign.tool, arguments: foreign.input, callId: ToolCallId(randomUUID()), signal: spec.signal })).toMatchObject({ isError: true })
        for (const command of prompt.commands) {
          const response = await f.registry.execute({ agent: child, name: command.tool, arguments: command.input, callId: ToolCallId(randomUUID()), signal: spec.signal })
          if (response.isError) throw new Error(JSON.stringify(response))
          if (++writes === 10) ready()
        }
        await finishes[index].promise; active--
        return { stopReason: 'completed', structured: { status: 'completed', summary: '实际回执' } }
      })()
      return { childId: child.id, result, dispose: async () => f.coordinator.unregister(child) }
    } })
    const args = { operationId: randomUUID(), task: '创建10个已确定节点', commands }
    const pending = f.rawCall('canvas_execute', args)
    await Promise.race([written, pending.then((value) => { throw new Error(`提前返回：${JSON.stringify(value)}`) })])
    expect(peak).toBe(4); expect(new Set(taskIds).size).toBe(4); expect(taskIds).not.toContain(args.operationId)
    expect(actualCommands).toHaveLength(10)
    expect(new Set(actualCommands.map((command) => command.input.operationId)).size).toBe(10)
    for (const command of commands) expect(actualCommands).toContainEqual(command)
    expect(f.coordinator.presentation.state(f.agent.id).cursors.active.map((cursor) => cursor.childId).sort()).toEqual([...childIds].sort())
    const nodes = f.service.store.state(f.canvasId).graph.nodes
    expect(nodes).toHaveLength(10); expect(new Set(nodes.map((node) => JSON.stringify(node.position))).size).toBe(10)
    finishes[0].finish()
    await vi.waitFor(() => expect(f.coordinator.presentation.state(f.agent.id).cursors.active.some((cursor) => cursor.childId === childIds[0])).toBe(false))
    expect(f.coordinator.presentation.state(f.agent.id).cursors.active).toHaveLength(3)
    finishes.slice(1).forEach((finish) => finish.finish())
    const response = await pending
    expect(response).toMatchObject({ isError: false, value: { completed: true, revision: 10, taskId: args.operationId, dispatch: { mode: 'parallel', tasks: taskIds.map((taskId) => ({ taskId, status: 'completed' })) } } })
    expect((response.value as any).receipts.map((entry: any) => entry.operationId)).toEqual(commands.map((command) => command.input.operationId))
    expect((response.value as any).receipts.every((entry: any) => entry.receipt !== null)).toBe(true)
    expect(f.coordinator.presentation.state(f.agent.id).cursors.active).toEqual([])
    expect(await f.rawCall('canvas_execute', args)).toEqual(response)
    expect(childIds).toHaveLength(4); expect(f.service.store.state(f.canvasId).tasks).toHaveLength(0)
  })
  it('honors explicit serial creates and reuses pre-upgrade completed or interrupted batch identities', async () => {
    const f = await fixture(); f.coordinator.setRoute(f.agent, { provider: 'fixture', model: 'vision' })
    let spawns = 0
    Object.assign(f.ctx.subagents, { startActivation: async (spec: any) => {
      spawns++; const child = await f.child('executor', spec.childId)
      return { childId: child.id, result: Promise.resolve({ stopReason: 'completed', structured: { status: 'completed', summary: '未写入' } }), dispose: async () => f.coordinator.unregister(child) }
    } })
    const commands: ExecutionCommand[] = [0, 1].map((index) => ({ tool: 'canvas_create_node', input: {
      operationId: randomUUID(), revision: 0, kind: 'image-generation', title: `节点${index}`, prompt: '',
    } }))
    expect(await f.rawCall('canvas_execute', { operationId: randomUUID(), task: '按顺序', executionMode: 'serial', commands })).toMatchObject({ isError: false, value: { completed: false } })
    expect(spawns).toBe(1)
    const project = f.coordinator.creative.project(f.agent.id, await realpath(f.dir), f.canvasId, 'Agent test')
    const args = { operationId: randomUUID(), task: '历史批次', commands, allowTts: false, artifactIds: [] }
    const key = `${project.id}:execution-batch:${args.operationId}`, oldValue = { completed: false, receipts: [], taskId: args.operationId }
    f.coordinator.ledger.remember(key, args, oldValue)
    expect(await f.rawCall('canvas_execute', args)).toMatchObject({ isError: false, value: oldValue })
    const interrupted = { ...args, operationId: randomUUID() }
    f.coordinator.ledger.remember(`${project.id}:execution-batch:${interrupted.operationId}:started`, interrupted, { started: true })
    expect(await f.rawCall('canvas_execute', interrupted)).toMatchObject({ isError: true })
    expect(spawns).toBe(1)
  })
  it('retains successful creates when an automatic sibling fails and replays without new executors', async () => {
    const f = await fixture(); f.coordinator.setRoute(f.agent, { provider: 'fixture', model: 'vision' })
    const commands: ExecutionCommand[] = [0, 1].map((index) => ({ tool: 'canvas_create_node', input: {
      operationId: randomUUID(), revision: 0, kind: 'image-generation', title: `节点${index}`, prompt: '',
    } }))
    let spawns = 0
    Object.assign(f.ctx.subagents, { startActivation: async (spec: any) => {
      const index = spawns++, child = await f.child('executor', spec.childId)
      const result = (async () => {
        if (index === 0) throw new Error('模型调用失败')
        const command = JSON.parse(spec.request.prompt[0].text).commands[0]
        expect(await f.registry.execute({ agent: child, name: command.tool, arguments: command.input, callId: ToolCallId(randomUUID()), signal: spec.signal })).toMatchObject({ isError: false })
        return { stopReason: 'completed', structured: { status: 'completed', summary: '已保存' } }
      })()
      return { childId: child.id, result, dispose: async () => f.coordinator.unregister(child) }
    } })
    const args = { operationId: randomUUID(), task: '两个独立节点', commands }
    const response = await f.rawCall('canvas_execute', args)
    expect(response).toMatchObject({ isError: false, value: { completed: false, receipts: [{ receipt: null }, { operationId: commands[1].input.operationId }], dispatch: { tasks: [{ status: 'blocked' }, { status: 'completed' }] } } })
    expect(f.service.store.state(f.canvasId).graph.nodes.map((node) => node.id)).toEqual([commands[1].input.operationId])
    expect(f.coordinator.presentation.state(f.agent.id).cursors.active).toEqual([])
    expect(await f.rawCall('canvas_execute', args)).toEqual(response); expect(spawns).toBe(2)
  })
  it.each([false, true])('queues same-node executor tasks with dependency=%s and accepts the original group revision', async (dependent) => {
    const f = await fixture(); f.coordinator.setRoute(f.agent, { provider: 'fixture', model: 'vision' })
    const nodeId = randomUUID()
    expect(await f.call('canvas_create_node', { operationId: nodeId, revision: 0, kind: 'image-generation', title: '初稿', prompt: '' })).toMatchObject({ isError: false })
    for (const cursor of f.coordinator.presentation.state(f.agent.id).cursors.active) f.coordinator.presentation.endExecutor(cursor.childId)
    const firstId = randomUUID()
    const tasks = [0, 1].map((index) => ({ operationId: index === 0 ? firstId : randomUUID(), task: `改名${index}`,
      dependsOn: dependent && index === 1 ? [firstId] : [],
      commands: [{ tool: 'canvas_update_node', input: { operationId: randomUUID(), revision: 1, nodeId, patch: { title: `成果${index}` } } }] }))
    let ready!: () => void, finish!: () => void, active = 0, peak = 0
    const written = new Promise<void>((resolve) => { ready = resolve })
    const gate = new Promise<void>((resolve) => { finish = resolve })
    const childIds: string[] = []
    Object.assign(f.ctx.subagents, { startActivation: async (spec: any) => {
      const index = childIds.length; childIds.push(spec.childId)
      const child = await f.child('executor', spec.childId)
      const result = (async () => {
        peak = Math.max(peak, ++active)
        const command = tasks[index].commands[0]
        const response = await f.registry.execute({ agent: child, name: command.tool, arguments: command.input, callId: ToolCallId(randomUUID()), signal: spec.signal })
        if (response.isError) throw new Error(JSON.stringify(response))
        if (index === 0) { ready(); await gate }
        active--
        return { stopReason: 'completed', structured: { status: 'completed', summary: '回执已保存' } }
      })()
      return { childId: child.id, result, dispose: async () => f.coordinator.unregister(child) }
    } })
    const pending = f.rawCall('canvas_execute_parallel', { operationId: randomUUID(), tasks })
    await Promise.race([written, pending.then((value) => { throw new Error(JSON.stringify(value)) })])
    expect(childIds).toHaveLength(1)
    expect(f.coordinator.presentation.state(f.agent.id).cursors.active.map((cursor) => cursor.childId)).toEqual(childIds)
    finish()
    expect(await pending).toMatchObject({ isError: false, value: { completed: true, tasks: [{ status: 'completed' }, { status: 'completed' }] } })
    expect(peak).toBe(1)
    expect(f.service.store.state(f.canvasId).graphRevision).toBe(3)
    expect(f.service.store.state(f.canvasId).graph.nodes[0].title).toBe('成果1')
    expect(f.coordinator.presentation.state(f.agent.id).cursors.active).toEqual([])
  })
  it('retains explicit approval on old artifacts and marks dependents for review after source/spec revisions', async () => {
    const f = await fixture(), project = f.coordinator.creative.project(f.agent.id, await realpath(f.dir), f.canvasId, '通用制作')
    const source = await f.coordinator.creative.import(project.id, 'workspace:brief.md', 'brief.md', Buffer.from('第一版原文'), () => {})
    const file = { path: join(f.dir, 'artifact.md'), relativePath: 'artifact.md', bytes: 0, sha256: '' }
    const first = f.coordinator.creative.saveArtifact({ id: randomUUID(), taskId: randomUUID(), projectId: project.id, draft: simpleDraft('视觉词典'), sources: [{ sourceId: source.id, start: 0, end: 2 }], version: 1, author: 'assets', createdAt: 1, status: 'draft', file })
    f.coordinator.creative.decide(project.id, first.id, 'approved', '用户确认第一版')
    const { needsReview: _review, ...saved } = first
    const dependent = f.coordinator.creative.saveArtifact({ ...saved, id: randomUUID(), draft: simpleDraft('片段一', [first.id]), sources: [] })
    f.coordinator.creative.saveArtifact({ ...saved, id: randomUUID(), draft: { ...simpleDraft('视觉词典'), content: '修订词典' } })
    await f.coordinator.creative.import(project.id, 'workspace:brief.md', 'brief.md', Buffer.from('第二版原文'), () => {})
    expect(f.coordinator.creative.artifact(project.id, first.id)).toMatchObject({ status: 'approved', needsReview: true })
    expect(f.coordinator.creative.artifact(project.id, dependent.id)).toMatchObject({ needsReview: true })
    expect(f.coordinator.creative.project('another-session', await realpath(f.dir), f.canvasId).id).toBe(project.id)
  })
})
describe('Agent reference generation and prompt mentions', () => {
  async function media(f: Awaited<ReturnType<typeof fixture>>, kinds: ('image' | 'audio' | 'video')[] = ['image', 'audio', 'video']) {
    const refs = kinds.map((kind) => ({ source: randomUUID(), assetId: randomUUID(), kind }))
    await f.service.store.update(f.canvasId, (state) => {
      for (const ref of refs) {
        state.graph.nodes.push(CanvasNodeSchema.parse({ id: ref.source, kind: `${ref.kind}-asset`, title: ref.kind,
          position: { x: 0, y: 0 } }))
      }
    })
    const assets = []
    for (const ref of refs) {
      const path = join(f.dir, `${ref.assetId}.media`), body = Buffer.alloc(100)
      await writeFile(path, body)
      assets.push(await f.service.store.publish(f.canvasId, { id: ref.assetId, nodeId: ref.source, taskId: null, kind: ref.kind,
        filename: `${ref.kind}-参考`, createdAt: 1, ...(ref.kind !== 'image' ? { duration: 3 } : {}) }, await realpath(path),
      { bytes: body.length, mime: { image: 'image/png', audio: 'audio/wav', video: 'video/mp4' }[ref.kind], fileHash: hashBytes(body) }))
    }
    await f.service.store.update(f.canvasId, (state) => {
      state.assets.push(...assets)
      for (const ref of refs) state.graph.nodes.find((node) => node.id === ref.source)!.assetId = ref.assetId
    })
    return refs.map(({ source, assetId }) => ({ source, assetId }))
  }
  async function ready(kinds?: ('image' | 'audio' | 'video')[]) {
    const f = await fixture()
    const model = BUILTIN_MODELS.find((model) => model.protocol === 'seedance-video' && model.model_id.includes('2-0') && providerFor(model)?.id === 'bytedance')!
    await f.service.store.saveModel({ ...model, api_key: 'fixture-key', endpoint_id: 'ep-reference-fixture' })
    await chooseGeneration(f, model)
    const refs = await media(f, kinds)
    const prompt = refs.map((ref, index) => `${assetToken(ref.assetId)}用于${['人物形象', '对白节奏', '镜头运动'][index]}`).join('，')
    return { ...f, model, refs, prompt, revision: f.service.store.state(f.canvasId).graphRevision }
  }
  async function storyboard(f: Awaited<ReturnType<typeof ready>>, dependencyIndices: number[]) {
    const image = await configureGeneration(f), originTaskId = randomUUID()
    await f.service.store.update(f.canvasId, (state) => {
      const node = state.graph.nodes.find((node) => node.id === f.refs[0].source)!
      Object.assign(node, { kind: 'image-generation', assetId: null, selectedResultId: f.refs[0].assetId,
        modelId: image.id, prompt: '已生成的分镜', params: { size: '1024x1024', n: 1 } })
      state.tasks.push({ id: originTaskId, nodeId: node.id, workspaceId: f.canvasId, status: 'completed',
        snapshot: { model: image, prompt: '当时的参考', params: { size: '1024x1024', n: 1 },
          referenceIds: dependencyIndices.map((index) => f.refs[index].assetId) },
        resultIds: [f.refs[0].assetId], createdAt: 1, updatedAt: 1 })
    })
    f.revision = f.service.store.state(f.canvasId).graphRevision
    return originTaskId
  }
  it('reads saved storyboard inputs in a small scope even after live source edges change, without disclosing task snapshots', async () => {
    const f = await ready(['image', 'image', 'image', 'image', 'image']), originTaskId = await storyboard(f, [1, 2, 3])
    await f.service.store.update(f.canvasId, (state) => {
      state.graph.edges.push({ id: randomUUID(), ...f.refs[4], target: f.refs[0].source })
    })
    const before = await f.service.store.snapshot(f.canvasId), control = f.coordinator.control(f.canvasId)
    const result = await f.call('canvas_inspect', { assetIds: [f.refs[0].assetId] })
    expect(result.isError).toBe(false)
    expect(result.value.graph.nodes).toEqual([])
    expect(result.value.assets.map((asset: any) => asset.id)).toEqual([f.refs[0].assetId])
    expect(result.value.referenceDependencies).toEqual([{ assetId: f.refs[0].assetId, provenance: 'task-snapshot', originTaskId,
      dependencies: [1, 2, 3].map((index) => ({ ...f.refs[index], available: true, kind: 'image',
        filename: before.assets.find((asset) => asset.id === f.refs[index].assetId)!.filename, token: assetToken(f.refs[index].assetId) })) }])
    const selected = await f.call('canvas_inspect', { nodeIds: [f.refs[0].source] })
    expect(selected.value.graph.nodes).toHaveLength(1)
    expect(selected.value.tasks).toHaveLength(1)
    expect(JSON.stringify(selected.value)).not.toContain('"snapshot"')
    expect(JSON.stringify(selected.value)).not.toContain('fixture-key')
    expect(await f.service.store.snapshot(f.canvasId)).toEqual(before)
    expect(f.coordinator.control(f.canvasId)).toEqual(control)
    const specialist = await f.child()
    const binding = f.coordinator.binding(specialist)
    f.coordinator.bind(specialist, { ...binding, nodeIds: [f.refs[0].source], assetIds: [f.refs[0].assetId, f.refs[1].assetId] })
    const scoped = (args: unknown) => f.registry.execute({ name: 'canvas_inspect', arguments: args, agent: specialist,
      callId: ToolCallId(randomUUID()), signal: new AbortController().signal })
    const allowed = await scoped({ assetIds: [f.refs[0].assetId] })
    expect(allowed.value.referenceDependencies[0]).toMatchObject({ dependencies: [{ assetId: f.refs[1].assetId }], outOfScopeCount: 2 })
    expect(JSON.stringify(allowed.value)).not.toContain(f.refs[2].assetId)
    expect(await scoped({ assetIds: [f.refs[2].assetId] })).toMatchObject({ isError: true })
    expect(await scoped({ nodeIds: [f.refs[2].source] })).toMatchObject({ isError: true })
  })
  it('blocks storyboard-only edits and handoffs, then atomically accepts direct character, scene, prop and voice references', async () => {
    const f = await ready(['image', 'image', 'image', 'image', 'audio', 'video'])
    await storyboard(f, [1, 2, 3])
    const nodeId = randomUUID(), before = await f.service.store.snapshot(f.canvasId)
    const args = { operationId: randomUUID(), revision: f.revision, kind: 'video-generation', title: '一致性镜头',
      prompt: `${assetToken(f.refs[0].assetId)}用于构图`, modelId: f.model.id, references: [f.refs[0]] }
    expect(await f.call('canvas_create_node', args)).toMatchObject({ isError: true })
    expect(await f.service.store.snapshot(f.canvasId)).toEqual(before)
    expect(await f.call('canvas_create_node', { ...args, operationId: nodeId, prompt: '规划', references: [] })).toMatchObject({ isError: false })
    expect(await f.call('canvas_connect', { operationId: randomUUID(), revision: f.revision + 1, ...f.refs[0], target: nodeId })).toMatchObject({ isError: false })
    await f.service.store.update(f.canvasId, (state) => { state.graph.nodes.find((node) => node.id === nodeId)!.prompt = args.prompt })
    const incomplete = await f.service.store.snapshot(f.canvasId), control = f.coordinator.control(f.canvasId)
    expect(await f.call('canvas_handoff_generation', { operationId: randomUUID(), revision: incomplete.graphRevision, nodeIds: [nodeId] })).toMatchObject({ isError: true })
    expect(f.coordinator.control(f.canvasId)).toEqual(control)
    expect(await f.call('canvas_update_node', { operationId: randomUUID(), revision: incomplete.graphRevision, nodeId, patch: { title: '仍可改名' } })).toMatchObject({ isError: false })
    const uses = ['分镜构图和站位', '人物全身外观和服装', '场景空间和灯光', '道具外观', '只参考张小强音色，不复述样例内容', '动作节奏']
    const prompt = f.refs.map((ref, index) => `${assetToken(ref.assetId)}用于${uses[index]}`).join('；') + '；张小强说：“快关门！”'
    const update = { operationId: randomUUID(), revision: f.service.store.state(f.canvasId).graphRevision, nodeId, patch: { prompt }, references: f.refs }
    expect(await f.call('canvas_update_node', update)).toMatchObject({ isError: false, value: { referenceCoverage: [1, 2, 3].map((index) => ({ assetId: f.refs[index].assetId, status: 'connected' })) } })
    const state = f.service.store.state(f.canvasId)
    expect(state.graph.edges.filter((edge) => edge.target === nodeId)).toHaveLength(6)
    expect(await f.call('canvas_update_node', { ...update, revision: state.graphRevision })).toMatchObject({ isError: false })
    expect(await f.call('canvas_update_node', { ...update, referenceExclusions: [{ assetId: f.refs[1].assetId, reason: '擅自忽略角色' }] })).toMatchObject({ isError: true })
    expect(await f.call('canvas_handoff_generation', { operationId: randomUUID(), revision: state.graphRevision, nodeIds: [nodeId] })).toMatchObject({ isError: false, value: { submitted: false, nodes: [{ references: f.refs.map((ref) => expect.objectContaining(ref)) }] } })
    expect(state.tasks).toHaveLength(1)
  })
  it('requires exact per-shot exclusion decisions again at handoff without persisting them into graph or accepting arbitrary omissions', async () => {
    const f = await ready(['image', 'image', 'image']), nodeId = randomUUID()
    await storyboard(f, [1, 2])
    const referenceExclusions = [{ assetId: f.refs[2].assetId, reason: '该人物只在前镜出现，本镜画外无对白' }]
    const input = { operationId: nodeId, revision: f.revision, kind: 'video-generation', title: '单人镜头', modelId: f.model.id,
      references: f.refs.slice(0, 2), prompt: f.refs.slice(0, 2).map((ref) => `${assetToken(ref.assetId)}用于本镜`).join('，'), referenceExclusions }
    const before = await f.service.store.snapshot(f.canvasId)
    for (const exclusions of [[...referenceExclusions, ...referenceExclusions],
      [{ assetId: randomUUID(), reason: '未知来源' }], [{ assetId: f.refs[1].assetId, reason: '已经连入' }]]) {
      expect(await f.call('canvas_create_node', { ...input, operationId: randomUUID(), referenceExclusions: exclusions })).toMatchObject({ isError: true })
      expect(await f.service.store.snapshot(f.canvasId)).toEqual(before)
    }
    expect(await f.call('canvas_create_node', input)).toMatchObject({ isError: false, value: { referenceCoverage: [
      { assetId: f.refs[1].assetId, status: 'connected' }, { assetId: f.refs[2].assetId, status: 'excluded', reason: referenceExclusions[0].reason },
    ] } })
    const handoff = { operationId: randomUUID(), revision: f.revision + 1, nodeIds: [nodeId] }
    expect(await f.call('canvas_handoff_generation', handoff)).toMatchObject({ isError: true })
    for (const referenceExclusions of [
      [{ nodeId: randomUUID(), exclusions: input.referenceExclusions }],
      [{ nodeId, exclusions: input.referenceExclusions }, { nodeId, exclusions: input.referenceExclusions }],
    ]) expect(await f.call('canvas_handoff_generation', { ...handoff, operationId: randomUUID(), referenceExclusions })).toMatchObject({ isError: true })
    const graph = structuredClone(f.service.store.state(f.canvasId).graph)
    const complete = { ...handoff, operationId: randomUUID(), referenceExclusions: [{ nodeId, exclusions: input.referenceExclusions }] }
    const result = await f.call('canvas_handoff_generation', complete)
    expect(result).toMatchObject({ isError: false, value: { nodes: [{ referenceCoverage: [{ status: 'connected' }, { status: 'excluded' }] }] } })
    expect(await f.call('canvas_handoff_generation', complete)).toMatchObject({ isError: false, value: result.value })
    expect(f.service.store.state(f.canvasId).graph).toEqual(graph)
  })
  it('reports missing saved inputs and keeps explicit frames exempt from reference dependency coverage', async () => {
    const f = await ready(['image', 'image']), nodeId = randomUUID()
    await storyboard(f, [1])
    const missing = randomUUID()
    await f.service.store.update(f.canvasId, (state) => { state.tasks[0].snapshot.referenceIds.push(missing) })
    const inspected = await f.call('canvas_inspect', { assetIds: [f.refs[0].assetId] })
    expect(inspected.value.referenceDependencies[0].dependencies).toContainEqual({ assetId: missing, available: false })
    const before = await f.service.store.snapshot(f.canvasId)
    const input = { operationId: randomUUID(), revision: before.graphRevision, kind: 'video-generation', title: '缺失来源', modelId: f.model.id, references: f.refs, prompt: f.prompt }
    expect(await f.call('canvas_create_node', input)).toMatchObject({ isError: true })
    expect(await f.service.store.snapshot(f.canvasId)).toEqual(before)
    const params = { size: '720p/16:9', n: 1, seconds: 5, videoMode: 'frames', firstFrameId: f.refs[0].assetId }
    expect(await f.call('canvas_create_node', { ...input, operationId: nodeId, references: [f.refs[0]], prompt: `${assetToken(f.refs[0].assetId)}用于首帧`, params })).toMatchObject({ isError: false })
    expect(await f.call('canvas_handoff_generation', { operationId: randomUUID(), revision: before.graphRevision + 1, nodeIds: [nodeId] })).toMatchObject({ isError: false, value: { nodes: [{ videoMode: 'frames', referenceCoverage: [] }] } })
  })
  it('uses the selected Kling budget and roles, skips unsupported voice lineage, and never connects audio or dispatches TTS', async () => {
    const f = await ready(['image', 'audio']), nodeId = randomUUID()
    await storyboard(f, [1])
    const model = BUILTIN_MODELS.find((model) => model.protocol === 'kling-video')!
    await f.service.store.saveModel({ ...model, api_key: 'fixture-kling-key' })
    await chooseGeneration(f, model, true)
    const inspected = await f.call('canvas_inspect', { assetIds: [f.refs[0].assetId] })
    const selected = inspected.value.models.find((entry: any) => entry.modelId === model.id)
    expect(selected.referenceLimits).toEqual({ text: { image: 0, audio: 0, video: 0, total: 0 }, reference: { image: 10, video: 5, audio: 0, total: 15 } })
    expect(selected.referenceRoles.image).toContainEqual({ value: 'first_frame', label: '首帧' })
    const input = { operationId: nodeId, revision: f.revision, kind: 'video-generation', title: '无音频参考能力的镜头',
      modelId: model.id, prompt: `${assetToken(f.refs[0].assetId)}用于构图；对白：“快关门！”`, references: [f.refs[0]] }
    const generate = vi.spyOn(f.service, 'generate')
    expect(await f.call('canvas_create_node', input)).toMatchObject({ isError: false, value: { referenceCoverage: [{ assetId: f.refs[1].assetId, status: 'unsupported' }] } })
    expect(await f.call('canvas_handoff_generation', { operationId: randomUUID(), revision: f.revision + 1, nodeIds: [nodeId] }))
      .toMatchObject({ isError: false, value: { nodes: [{ videoMode: 'reference', referenceCoverage: [{ status: 'unsupported' }] }], submitted: false } })
    expect(f.service.store.state(f.canvasId).graph.edges.filter((edge) => edge.target === nodeId).map((edge) => edge.assetId)).toEqual([f.refs[0].assetId])
    expect(generate).not.toHaveBeenCalled()
    expect(f.service.store.state(f.canvasId).tasks).toHaveLength(1)
  })
  it('atomically saves mixed media edges and @ tokens, resolves exact inputs, and hands off without dispatch', async () => {
    const f = await ready(), nodeId = randomUUID(), mutation = vi.spyOn(f.service, 'mutateGraph'), generate = vi.spyOn(f.service, 'generate')
    const inspect = await f.call('canvas_inspect', {})
    expect(inspect.value.promptReferences).toEqual(f.refs.map((ref, index) => ({
      ...ref, kind: ['image', 'audio', 'video'][index], filename: f.service.store.state(f.canvasId).assets.find((asset) => asset.id === ref.assetId)!.filename, token: assetToken(ref.assetId),
    })))
    const args = { operationId: nodeId, revision: f.revision, kind: 'video-generation', title: '参考镜头', prompt: f.prompt, modelId: f.model.id, references: f.refs }
    expect(await f.call('canvas_create_node', args)).toMatchObject({ isError: false, value: { references: inspect.value.promptReferences } })
    expect(mutation).toHaveBeenCalledTimes(1)
    expect(mutation.mock.calls[0][1]).toMatchObject({ nodes: [{ value: { prompt: f.prompt, params: { videoMode: 'reference' } } }], edges: f.refs.map((ref) => ({ value: { ...ref, target: nodeId } })) })
    const state = f.service.store.state(f.canvasId)
    expect(state.graphRevision).toBe(f.revision + 1)
    expect(resolvePrompt(state.graph.nodes.find((node) => node.id === nodeId)!.prompt, state.graph.edges.map((edge) => edge.assetId), state.assets))
      .toBe('[参考图1]用于人物形象，[参考音频2]用于对白节奏，[参考视频3]用于镜头运动')
    expect(await f.call('canvas_create_node', { ...args, revision: f.revision + 1 })).toMatchObject({ isError: false })
    expect(mutation).toHaveBeenCalledTimes(1)
    expect(await f.call('canvas_create_node', { ...args, prompt: `${f.prompt}改动` })).toMatchObject({ isError: true })
    expect(await f.call('canvas_handoff_generation', { operationId: randomUUID(), revision: f.revision + 1, nodeIds: [nodeId] }))
      .toMatchObject({ isError: false, value: { submitted: false, nodes: [{ nodeId, videoMode: 'reference', references: inspect.value.promptReferences }] } })
    expect(generate).not.toHaveBeenCalled()
    expect(state.tasks).toHaveLength(0)
  })
  it.each(['create', 'update'] as const)('rejects invalid %s reference edits with no partial node, prompt or edge commit', async (action) => {
    const f = await ready(['image']), nodeId = randomUUID()
    if (action === 'update') await f.call('canvas_create_node', { operationId: nodeId, revision: f.revision, kind: 'video-generation', title: '原镜头', prompt: '原提示词', modelId: f.model.id })
    const before = await f.service.store.snapshot(f.canvasId)
    const bad = [
      { references: f.refs, prompt: '参考图1中的人物' },
      { references: [], prompt: f.prompt },
      { references: [f.refs[0], f.refs[0]], prompt: f.prompt },
      { references: [{ source: randomUUID(), assetId: f.refs[0].assetId }], prompt: f.prompt },
      { references: [{ source: f.refs[0].source, assetId: randomUUID() }], prompt: f.prompt },
    ]
    for (const input of bad) {
      const common = { operationId: randomUUID(), revision: before.graphRevision, references: input.references }
      const result = action === 'create'
        ? await f.call('canvas_create_node', { ...common, kind: 'video-generation', title: '不应保存', prompt: input.prompt, modelId: f.model.id })
        : await f.call('canvas_update_node', { ...common, nodeId, patch: { prompt: input.prompt, title: '不应保存' } })
      expect(result.isError).toBe(true)
      expect(await f.service.store.snapshot(f.canvasId)).toEqual(before)
    }
  })
  it('fills a planned node and reuses existing exact edges rather than duplicating them', async () => {
    const f = await ready(['image', 'audio']), nodeId = randomUUID()
    await f.call('canvas_create_node', { operationId: nodeId, revision: f.revision, kind: 'video-generation', title: '规划', prompt: '规划', modelId: f.model.id })
    const connect = await f.call('canvas_connect', { operationId: randomUUID(), revision: f.revision + 1, target: nodeId, ...f.refs[0] })
    expect(connect).toMatchObject({ isError: false, value: { reference: { token: assetToken(f.refs[0].assetId) } } })
    const original = structuredClone(f.service.store.state(f.canvasId).graph.edges[0])
    expect(await f.call('canvas_update_node', { operationId: randomUUID(), revision: f.revision + 2, nodeId, references: f.refs, patch: { prompt: f.prompt } })).toMatchObject({ isError: false })
    const state = f.service.store.state(f.canvasId)
    expect(state.graph.edges).toHaveLength(2)
    expect(state.graph.edges[0]).toEqual(original)
    expect(state.graph.nodes.find((node) => node.id === nodeId)).toMatchObject({ prompt: f.prompt, params: { videoMode: 'reference' } })
  })
  it.each(['no-edge', 'no-at', 'disconnected-at', 'empty-prompt', 'bad-duration', 'audio-only'] as const)('blocks %s generation handoff and retains Agent control', async (failure) => {
    const f = await ready(failure === 'audio-only' ? ['audio'] : ['image']), nodeId = randomUUID()
    await f.call('canvas_create_node', { operationId: nodeId, revision: f.revision, kind: 'video-generation', title: '待修正', prompt: '规划', modelId: f.model.id,
      ...(failure === 'no-edge' ? { params: { size: '720p/16:9', n: 1, seconds: 5, videoMode: 'frames', firstFrameId: f.refs[0].assetId } } : {}) })
    if (failure !== 'no-edge') {
      expect(await f.call('canvas_update_node', { operationId: randomUUID(), revision: f.revision + 1, nodeId, patch: { prompt: f.prompt }, references: f.refs })).toMatchObject({ isError: false })
      await f.service.store.update(f.canvasId, (state) => {
        const node = state.graph.nodes.find((node) => node.id === nodeId)!
        if (failure === 'no-at') node.prompt = '参考图1用于人物形象'
        if (failure === 'disconnected-at') node.prompt += assetToken(randomUUID())
        if (failure === 'empty-prompt') node.prompt = ''
        if (failure === 'bad-duration' && node.params && !('type' in node.params)) node.params.seconds = 999
      })
    }
    const before = await f.service.store.snapshot(f.canvasId), control = f.coordinator.control(f.canvasId)
    expect(await f.call('canvas_handoff_generation', { operationId: randomUUID(), revision: before.graphRevision, nodeIds: [nodeId] })).toMatchObject({ isError: true })
    expect(f.coordinator.control(f.canvasId)).toEqual(control)
    expect(await f.service.store.snapshot(f.canvasId)).toEqual(before)
    expect(before.tasks).toHaveLength(0)
  })
  it('keeps an explicit first/last frame choice with true edges and mentions', async () => {
    const f = await ready(['image', 'image']), nodeId = randomUUID()
    const params = { size: '720p/16:9', n: 1, seconds: 5, videoMode: 'frames', firstFrameId: f.refs[1].assetId, lastFrameId: f.refs[0].assetId }
    expect(await f.call('canvas_create_node', { operationId: nodeId, revision: f.revision, kind: 'video-generation', title: '指定起止画面', prompt: f.prompt, modelId: f.model.id, references: f.refs, params })).toMatchObject({ isError: false })
    expect(f.service.store.state(f.canvasId).graph.nodes.find((node) => node.id === nodeId)?.params).toEqual(params)
    expect(await f.call('canvas_handoff_generation', { operationId: randomUUID(), revision: f.revision + 1, nodeIds: [nodeId] })).toMatchObject({ isError: false, value: { nodes: [{ videoMode: 'frames' }] } })
  })
  it.each(['frames-audio', 'image-count', 'foreign-frame'] as const)('rejects %s before any reference mutation', async (failure) => {
    const f = await ready(failure === 'frames-audio' ? ['image', 'audio'] : failure === 'image-count' ? Array(10).fill('image') : ['image'])
    const before = await f.service.store.snapshot(f.canvasId)
    const params = { size: '720p/16:9', n: 1, seconds: 5, videoMode: failure === 'image-count' ? 'reference' : 'frames',
      ...(failure === 'foreign-frame' ? { firstFrameId: randomUUID() } : {}) }
    expect(await f.call('canvas_create_node', { operationId: randomUUID(), revision: f.revision, kind: 'video-generation', title: '无效参考', prompt: f.prompt, modelId: f.model.id, references: f.refs, params })).toMatchObject({ isError: true })
    expect(await f.service.store.snapshot(f.canvasId)).toEqual(before)
  })
  it('preserves historical outputs and rejects a cycle in an atomic update', async () => {
    const f = await ready(['image', 'image']), nodeId = randomUUID()
    const image = await configureGeneration(f)
    await chooseGeneration(f, image)
    const newerId = randomUUID(), path = join(f.dir, `${newerId}.media`), body = Buffer.alloc(100)
    await writeFile(path, body)
    const newer = await f.service.store.publish(f.canvasId, { id: newerId, nodeId: f.refs[0].source, taskId: null, kind: 'image',
      filename: '新版人物', createdAt: 2 }, await realpath(path), { bytes: body.length, mime: 'image/png', fileHash: hashBytes(body) })
    await f.service.store.update(f.canvasId, (state) => {
      state.assets.push(newer)
      for (const ref of f.refs) {
        const source = state.graph.nodes.find((node) => node.id === ref.source)!
        Object.assign(source, { kind: 'image-generation', assetId: null, modelId: image.id, params: { size: '1024x1024', n: 1 } })
        state.tasks.push({ id: randomUUID(), nodeId: source.id, workspaceId: f.canvasId, status: 'completed',
          snapshot: { model: image, prompt: '旧素材', params: { size: '1024x1024', n: 1 }, referenceIds: [] }, resultIds: [ref.assetId], createdAt: 1, updatedAt: 1 })
      }
      state.graph.edges.push({ id: randomUUID(), source: f.refs[0].source, target: f.refs[1].source, assetId: f.refs[0].assetId })
      state.tasks.push({ ...state.tasks[0], id: randomUUID(), resultIds: [newerId], createdAt: 2, updatedAt: 2 })
      state.graph.nodes.find((node) => node.id === f.refs[0].source)!.selectedResultId = newerId
    })
    const before = await f.service.store.snapshot(f.canvasId)
    expect(await f.call('canvas_update_node', { operationId: randomUUID(), revision: before.graphRevision, nodeId: f.refs[0].source, references: [f.refs[1]],
      patch: { prompt: `${assetToken(f.refs[1].assetId)}用于构图` } })).toMatchObject({ isError: true })
    expect(await f.service.store.snapshot(f.canvasId)).toEqual(before)
    expect(await f.call('canvas_create_node', { operationId: nodeId, revision: before.graphRevision, kind: 'video-generation', title: '旧人物版本', prompt: `${assetToken(f.refs[0].assetId)}用于人物形象`, modelId: f.model.id, references: [f.refs[0]] })).toMatchObject({ isError: false })
    expect(f.service.store.state(f.canvasId).graph.edges.find((edge) => edge.target === nodeId)?.assetId).toBe(f.refs[0].assetId)
  })
  it.each(['revision', 'takeover'] as const)('does not save reference edits after %s changes', async (change) => {
    const f = await ready(['image'])
    if (change === 'revision') await f.service.store.update(f.canvasId, (state) => { state.graph.viewport.x++ })
    else await f.coordinator.takeover(f.canvasId)
    const before = await f.service.store.snapshot(f.canvasId)
    expect(await f.call('canvas_create_node', { operationId: randomUUID(), revision: f.revision, kind: 'video-generation', title: '旧清单', prompt: f.prompt, modelId: f.model.id, references: f.refs })).toMatchObject({ isError: true })
    expect(await f.service.store.snapshot(f.canvasId)).toEqual(before)
  })
  it('instructs main and every specialist to prefer references and give literal tokens and their uses', () => {
    for (const prompt of [MAIN_PROMPT, ...Object.entries(METHODS).filter(([role]) => role !== 'voice').map(([, method]) => method)]) {
      expect(prompt).toContain('有真实素材时优先使用参考生成')
      expect(prompt).toContain('分镜构图、人物形象（含服装）、场景空间、道具外观、人物音色')
      expect(prompt).toContain('不能替代人物/场景/道具原始参考')
      expect(prompt).toContain('只参考张小强的音色，不复述样例内容')
      expect(prompt).toContain('referenceDependencies')
      expect(prompt).toContain('不支持音频参考时跳过人物音色一致性')
      expect(prompt).toContain('models.referenceLimits[实际模式]中的image/video/audio/total')
      expect(prompt).toContain('不得用“分镜已含细节”“数量不足”“找不到素材”排除必要一致性')
      expect(prompt).toContain('{{asset:实际UUID}}')
      expect(prompt).toContain('firstFrameId/lastFrameId不是连线')
      expect(prompt).toContain('是什么、怎么用')
    }
  })
})
describe('Manual image and video generation handoff', () => {
  it('returns a lossless native tool receipt for presented acknowledgements without a reason', async () => {
    const f = await fixture(), model = await configureGeneration(f)
    await chooseGeneration(f, model)
    const publish = f.coordinator.presentation.publish.bind(f.coordinator.presentation)
    vi.spyOn(f.coordinator.presentation, 'publish').mockImplementation(async (...args) => {
      const intent = await publish(...args)
      const identity = { sessionId: intent.sessionId, canvasId: intent.canvasId, epoch: intent.epoch, viewId: 'native-visible' }
      f.coordinator.presentation.report({ ...identity, sequence: 1, visible: true, following: true })
      f.coordinator.presentation.ack({ ...identity, presentationId: intent.id, graphRevision: intent.graphRevision, status: 'presented' })
      return intent
    })
    const nodeId = randomUUID()
    const result = await f.call('canvas_create_node', { operationId: nodeId, revision: 0, kind: 'image-generation',
      title: '可见节点', prompt: '一只猫', modelId: model.id })
    expect(result).toMatchObject({ isError: false, value: { nodeId, presentation: { status: 'presented' } } })
    expect(result.value.presentation).not.toHaveProperty('reason')
  })
  async function ready(kind: 'image' | 'video' = 'image') {
    const f = await fixture(), model = await configureGeneration(f, kind, kind === 'video' ? 'https://maas.qianwenaiapi.com/api/v1' : 'https://api.modellink.online/v1'), nodeId = randomUUID()
    await chooseGeneration(f, model)
    expect(await f.call('canvas_create_node', { operationId: nodeId, revision: 0, kind: `${kind}-generation`, title: '待检查节点', prompt: '一只猫', modelId: model.id })).toMatchObject({ isError: false })
    return { ...f, model, nodeId }
  }
  it.each(['image', 'video'] as const)('hands off %s with real node identity and reminder, without generating or cancelling the root reply', async (kind) => {
    const f = await ready(kind), child = await f.child()
    const graph = structuredClone(f.service.store.state(f.canvasId).graph), generated = vi.spyOn(f.service, 'generate')
    const args = { operationId: randomUUID(), revision: 1, nodeIds: [f.nodeId] }
    const result = await f.call('canvas_handoff_generation', args)
    expect(result).toMatchObject({ isError: false, value: { handedOff: true, submitted: false,
      nodes: [{ nodeId: f.nodeId, title: '待检查节点', kind: `${kind}-generation`, modelId: f.model.id }],
      control: { mode: 'manual', reason: GENERATION_HANDOFF_REASON }, presentation: { status: 'deferred' } } })
    expect((result.value as any).reminder).toContain('「待检查节点」')
    expect((result.value as any).reminder).toContain('点击“生成”')
    expect(f.agent.cancel).not.toHaveBeenCalled()
    expect(child.cancel).toHaveBeenCalledOnce()
    expect(f.service.store.state(f.canvasId).graph).toEqual(graph)
    expect(f.coordinator.presentation.state(f.agent.id)).toMatchObject({ intent: null, cursors: { active: [] } })
    expect(f.service.store.state(f.canvasId).tasks).toHaveLength(0)
    expect(generated).not.toHaveBeenCalled()
    expect(await f.call('canvas_inspect', {})).toMatchObject({ isError: false, value: { control: { mode: 'manual' } } })
    expect(await f.call('canvas_handoff_generation', { ...args, note: '重读交接结果' })).toMatchObject({ isError: false, value: result.value })
    expect(await f.call('canvas_update_node', { operationId: randomUUID(), revision: 1, nodeId: f.nodeId, patch: { prompt: 'Agent不能再写' } })).toMatchObject({ isError: true })
    expect(await f.call('canvas_generate', { operationId: randomUUID(), revision: 1, nodeId: f.nodeId })).toMatchObject({ isError: true })
    expect(f.registry.get('canvas_handoff_generation', child)).toBeUndefined()
  })
  it('presents saved inputs before release, then accepts a manual edit and manual submission using the latest parameters', async () => {
    const f = await ready()
    const wait = vi.spyOn(f.coordinator.presentation, 'wait').mockImplementation(async (intent) => {
      expect(intent.nodeIds).toEqual([f.nodeId]); expect(intent.action).toBe('update')
      expect(f.coordinator.control(f.canvasId).mode).toBe('agent')
      return { id: intent.id, status: 'presented' }
    })
    await f.call('canvas_handoff_generation', { operationId: randomUUID(), revision: 1, nodeIds: [f.nodeId] })
    expect(wait).toHaveBeenCalledOnce()
    const saved = structuredClone(f.service.store.state(f.canvasId).graph)
    saved.nodes[0].prompt = '用户修改后的猫'
    const manual = await f.coordinator.manual(new Request(`http://local/api/canvas/graph?canvas=${f.canvasId}`, { method: 'POST' }), async () => {
      await f.service.saveGraph(f.canvasId, saved, 1)
      return Response.json({ saved: true })
    })
    expect(manual.status).toBe(200)
    vi.spyOn(f.service.runtime, 'wake').mockImplementation(() => {})
    const task = await f.service.generate(f.canvasId, f.nodeId, 2, randomUUID())
    expect(task.snapshot.prompt).toBe('用户修改后的猫')
    expect(f.service.store.state(f.canvasId).tasks).toHaveLength(1)
  })
  it('persists the manual hold, rejects idle delegation and old messages, but a fresh user message allows a normal reminder reply and later edits', async () => {
    const f = await ready(), old = { id: 'original-message', source: { kind: 'user' }, content: [] } as any
    f.events.push({ type: 'user/message', data: old })
    const args = { operationId: randomUUID(), revision: 1, nodeIds: [f.nodeId] }
    await f.call('canvas_handoff_generation', args)
    const control = f.coordinator.control(f.canvasId)
    const next = vi.fn(async () => ({ done: true }))
    await f.ctx.serial(scopeTarget(f.agent, f.agent), 'agent/pre-step', { agent: f.agent, messages: [old], signal: new AbortController().signal }, next)
    expect(next).toHaveBeenCalled()
    expect(f.coordinator.control(f.canvasId)).toEqual(control)
    const recovered = new AgentLedger(f.dir)
    await recovered.init()
    expect(isGenerationHandoff(recovered.control(f.canvasId))).toBe(true)
    await expect(f.coordinator.delegate(f.canvasId, f.agent.id, 1, control.epoch)).rejects.toMatchObject({ code: 'AGENT_MANUAL_GENERATION_REQUIRED' })
    await f.coordinator.resumeForUserInput(f.agent, [{ ...old, id: 'fresh-message' }], new AbortController().signal)
    expect(f.coordinator.control(f.canvasId).mode).toBe('agent')
    expect(await f.call('canvas_handoff_generation', args)).toMatchObject({ isError: true })
    expect(f.service.store.state(f.canvasId).tasks).toHaveLength(0)
  })
  it.each(['revision', 'missing', 'duplicate'] as const)('rejects invalid %s handoffs without releasing control or creating a task', async (kind) => {
    const f = await ready(), control = f.coordinator.control(f.canvasId)
    const args = { operationId: randomUUID(), revision: kind === 'revision' ? 0 : 1,
      nodeIds: kind === 'missing' ? [randomUUID()] : kind === 'duplicate' ? [f.nodeId, f.nodeId] : [f.nodeId] }
    expect(await f.call('canvas_handoff_generation', args)).toMatchObject({ isError: true })
    expect(f.coordinator.control(f.canvasId)).toEqual(control)
    expect(f.service.store.state(f.canvasId).tasks).toHaveLength(0)
  })
  it.each(['cancel', 'takeover', 'choice'] as const)('rejects a handoff after %s during presentation without submitting anything', async (change) => {
    const f = await ready(), signal = new AbortController()
    vi.spyOn(f.coordinator.presentation, 'wait').mockImplementation(async (intent) => {
      if (change === 'cancel') signal.abort()
      if (change === 'takeover') await f.coordinator.takeover(f.canvasId)
      if (change === 'choice') f.coordinator.generationModels.clear(f.agent)
      return { id: intent.id, status: 'deferred' }
    })
    expect(await f.call('canvas_handoff_generation', { operationId: randomUUID(), revision: 1, nodeIds: [f.nodeId] }, signal.signal)).toMatchObject({ isError: true })
    expect(f.service.store.state(f.canvasId).tasks).toHaveLength(0)
    expect(isGenerationHandoff(f.coordinator.control(f.canvasId))).toBe(false)
  })
  it('instructs the main Agent to proactively remind, yield and end the turn instead of treating chat authorization as a click', () => {
    expect(MAIN_PROMPT).toContain('必须调用 canvas_handoff_generation')
    expect(MAIN_PROMPT).toContain('主动简短转告 reminder 和节点名称')
    expect(MAIN_PROMPT).toContain('然后结束本轮操作')
    expect(MAIN_PROMPT).toContain('不能代替画布上的点击')
  })
})
describe('Submitted # references', () => {
  const submit = (f: Awaited<ReturnType<typeof fixture>>, ref: ChatReference, kind = 'user') => {
    f.events.push({ type: 'user/message', data: { id: randomUUID(), source: { kind }, content: [{ type: 'text', text: `${referenceText(ref)} 不符合预期` }] } })
    return submittedReferences(f.agent).find((item) => item.ref.label === ref.label)
  }
  const fileRef = (f: Awaited<ReturnType<typeof fixture>>, path = '方案.md'): ChatReference =>
    ({ version: 1, kind: 'file', sessionId: f.agent.id, cwd: f.dir, path, label: path })
  it('exposes six empty nodes in the opt-in catalog, resolves latest identity and rejects deleted targets', async () => {
    const f = await fixture(), signal = new AbortController().signal
    await f.service.store.update(f.canvasId, (state) => {
      state.graph.nodes = NodeKindSchema.options.map((kind) => CanvasNodeSchema.parse({ id: randomUUID(), kind, title: '相同名称', position: { x: 0, y: 0 },
        ...(kind === 'tts-generation' ? { params: defaultTtsParams() } : {}) }))
      state.graphRevision++
    })
    const before = await f.service.store.snapshot(f.canvasId)
    const response = await f.service.handle(new Request(`http://local/api/canvas/v2/agent-reference-choices?${new URLSearchParams({ sessionId: f.agent.id, view: 'node-media' })}`))
    expect(response.status).toBe(200)
    const choices = await response.json()
    expect(choices.items).toHaveLength(6); expect(choices.media).toEqual([])
    expect(choices.items.map((item: any) => item.ref.nodeId)).toEqual(before.graph.nodes.map((node) => node.id))
    const ref = choices.items[0].ref, entry = submit(f, ref)!
    expect(await f.call('canvas_read_reference', { referenceId: entry.referenceId })).toMatchObject({ isError: false, value: {
      graphRevision: before.graphRevision, node: { id: ref.nodeId }, currentOutput: null, upstream: [], downstream: [],
    } })
    await f.service.store.update(f.canvasId, (state) => { state.graph.nodes[0].title = '现在的名称'; state.graph.nodes[0].prompt = '人工改过'; state.graphRevision++ })
    expect(await f.coordinator.chatReferences.resolve(f.agent.id, ref, signal)).toEqual(ref)
    expect(await f.call('canvas_read_reference', { referenceId: entry.referenceId })).toMatchObject({ value: { node: { title: '现在的名称', prompt: '人工改过' } } })
    await f.service.store.update(f.canvasId, (state) => { state.graph.nodes.shift(); state.graphRevision++ })
    await expect(f.coordinator.chatReferences.resolve(f.agent.id, ref, signal)).rejects.toThrow('已移除')
    expect(await f.call('canvas_read_reference', { referenceId: entry.referenceId })).toMatchObject({ isError: true })
  })
  it('pages every node without losing folders and rejects cursor tampering, query changes and graph revisions', async () => {
    const f = await fixture(), signal = new AbortController().signal
    await f.service.store.update(f.canvasId, (state) => {
      state.graph.nodes = Array.from({ length: 430 }, (_, index) => CanvasNodeSchema.parse({ id: randomUUID(), kind: 'video-generation', title: `镜头 ${index}`, position: { x: 0, y: 0 } }))
      state.graphRevision++
    })
    const refs = f.coordinator.chatReferences, browse = { view: 'node-media' as const, currentCanvasId: f.canvasId }
    const before = await f.service.store.snapshot(f.canvasId), first = await refs.choices(f.agent.id, '', signal, browse)
    const second = await refs.choices(f.agent.id, '', signal, { ...browse, cursor: first.nextCursor })
    const third = await refs.choices(f.agent.id, '', signal, { ...browse, cursor: second.nextCursor })
    expect([first.items!.length, second.items!.length, third.items!.length]).toEqual([200, 200, 30])
    expect([first.truncated, second.truncated, third.truncated]).toEqual([true, true, false])
    expect([...first.items!, ...second.items!, ...third.items!].map((item: any) => item.ref.nodeId)).toEqual(before.graph.nodes.map((node) => node.id))
    expect(second.folders).toEqual(first.folders)
    await expect(refs.choices(f.agent.id, '', signal, { ...browse, cursor: first.nextCursor! + 'x' })).rejects.toThrow('无效')
    await expect(refs.choices(f.agent.id, '镜头', signal, { ...browse, cursor: first.nextCursor })).rejects.toThrow('查询已变化')
    await expect(refs.choices(f.agent.id, '', signal, { ...browse, nodeId: before.graph.nodes[0].id })).rejects.toThrow()
    expect(await f.service.store.snapshot(f.canvasId)).toEqual(before)
    await f.service.store.update(f.canvasId, (state) => { state.graph.nodes[0].title = '人工改名'; state.graphRevision++ })
    await expect(refs.choices(f.agent.id, '', signal, { ...browse, cursor: first.nextCursor })).rejects.toThrow('查询已变化')
    const invalid = await f.service.handle(new Request(`http://local/api/canvas/v2/agent-reference-choices?${new URLSearchParams({ sessionId: f.agent.id, view: 'unknown' })}`))
    expect(invalid.status).toBe(400)
  })
  it('reads original incoming image bytes through a node and rejects unrelated assets or a changed edge before admission', async () => {
    const f = await fixture(), png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex')
    const attachment = { attachmentId: 'node-input', mediaType: 'image/png', bytes: png.length, name: '上游旧图.png' }
    f.events.push({ type: 'user/message', data: { id: 'user', source: { kind: 'user' }, content: [{ type: 'image', attachment }] } })
    Object.assign(f.ctx.attachments, { readImage: async () => ({ ref: attachment, data: png }), saveImage: vi.fn(async () => attachment) })
    await f.call('canvas_import_attachment', { operationId: randomUUID(), revision: 0, attachmentId: attachment.attachmentId, kind: 'image', purpose: '引用' })
    await f.service.runtime.uploads.run()
    const source = (await f.service.store.snapshot(f.canvasId)).graph.nodes[0], assetId = source.assetId!
    const saved = await f.service.store.snapshot(f.canvasId)
    await f.call('canvas_import_attachment', { operationId: randomUUID(), revision: saved.graphRevision, attachmentId: attachment.attachmentId, kind: 'image', purpose: '结果夹具' })
    await f.service.runtime.uploads.run()
    const output = (await f.service.store.snapshot(f.canvasId)).graph.nodes.find((node) => node.id !== source.id)!, outputId = output.assetId!
    const target = CanvasNodeSchema.parse({ ...output, kind: 'image-generation', title: '镜头02', assetId: null })
    const downstream = CanvasNodeSchema.parse({ id: randomUUID(), kind: 'image-generation', title: '下游', position: { x: 0, y: 0 } })
    await f.service.store.update(f.canvasId, (state) => {
      state.graph.nodes = state.graph.nodes.map((node) => node.id === target.id ? target : node)
      state.graph.nodes.push(downstream)
      state.graph.edges.push({ id: randomUUID(), source: source.id, target: target.id, assetId },
        { id: randomUUID(), source: target.id, target: downstream.id, assetId: outputId })
      state.graphRevision++
    })
    const ref: ChatReference = { version: 2, kind: 'node', sessionId: f.agent.id, canvasId: f.canvasId, nodeId: target.id, label: target.title }
    const entry = submit(f, ref)!, before = await f.service.store.snapshot(f.canvasId), publish = vi.spyOn(f.coordinator.presentation, 'publish')
    expect(await f.call('canvas_read_reference', { referenceId: entry.referenceId })).toMatchObject({ value: {
      upstream: [{ assetId, source: { nodeId: source.id } }], downstream: [{ target: { nodeId: downstream.id } }], graphRevision: before.graphRevision,
    } })
    expect(f.ctx.attachments.saveImage).not.toHaveBeenCalled()
    expect(await f.call('canvas_read_reference', { referenceId: entry.referenceId, assetId })).toMatchObject({ isError: false, value: { admitted: true, assetId },
      additionalContexts: [{ content: [{ type: 'text' }, { type: 'image' }] }] })
    expect(f.ctx.attachments.saveImage).toHaveBeenCalledWith(expect.objectContaining({ data: png }))
    expect(await f.call('canvas_read_reference', { referenceId: entry.referenceId, assetId: randomUUID() })).toMatchObject({ isError: true })
    expect(publish).not.toHaveBeenCalled(); expect(await f.service.store.snapshot(f.canvasId)).toEqual(before)
    f.ctx.attachments.saveImage.mockImplementationOnce(async () => {
      await f.service.store.update(f.canvasId, (state) => { state.graph.edges.shift(); state.graphRevision++ })
      return attachment
    })
    const stale = await f.call('canvas_read_reference', { referenceId: entry.referenceId, assetId })
    expect(stale).toMatchObject({ isError: true }); expect(stale.additionalContexts ?? []).toEqual([])
    const media = submit(f, { version: 1, kind: 'media', sessionId: f.agent.id, canvasId: f.canvasId, nodeId: source.id, assetId, label: '旧图' })!
    expect(await f.call('canvas_read_reference', { referenceId: media.referenceId, assetId })).toMatchObject({ isError: true })
  })
  it('allows a foreign node read without delegation but blocks writes to a duplicate ID in the controlled canvas', async () => {
    const f = await fixture(), other = await f.service.store.catalogCommand({ requestId: randomUUID(), operation: 'canvas-create', name: '引用画布' })
    const node = CanvasNodeSchema.parse({ id: randomUUID(), kind: 'image-generation', title: '目标', position: { x: 0, y: 0 } })
    for (const canvasId of [f.canvasId, other.id]) await f.service.store.update(canvasId, (state) => { state.graph.nodes.push(node); state.graphRevision++ })
    const ref: ChatReference = { version: 2, kind: 'node', sessionId: f.agent.id, canvasId: other.id, nodeId: node.id, label: node.title }
    const entry = submit(f, ref)!, before = await f.service.store.snapshot(f.canvasId), control = f.coordinator.session(f.agent.id).canvas
    const publish = vi.spyOn(f.coordinator.presentation, 'publish')
    expect(await f.call('canvas_read_reference', { referenceId: entry.referenceId })).toMatchObject({ isError: false, value: { canvasId: other.id, nodeId: node.id } })
    expect(f.coordinator.session(f.agent.id).canvas).toEqual(control); expect(publish).not.toHaveBeenCalled()
    for (const extra of [{}, { canvasId: other.id }, { referenceId: entry.referenceId }]) {
      expect(await f.call('canvas_update_node', { operationId: randomUUID(), revision: before.graphRevision, nodeId: node.id, patch: { title: '改过' }, ...extra })).toMatchObject({ isError: true })
    }
    expect(await f.service.store.snapshot(f.canvasId)).toEqual(before)
    await f.coordinator.takeover(f.canvasId); await f.coordinator.delegate(other.id, f.agent.id, 1)
    expect(await f.call('canvas_update_node', { operationId: randomUUID(), revision: 1, canvasId: other.id, referenceId: entry.referenceId, nodeId: node.id, patch: { title: '已修改' } })).toMatchObject({ isError: false })
  })
  it('lists only canvas choices even when the working directory is unavailable', async () => {
    const f = await fixture(), before = await f.service.store.snapshot(f.canvasId)
    const ensure = vi.spyOn(f.ctx.workingDirectory, 'ensure').mockRejectedValue(new Error('工作区不可用'))
    const get = vi.spyOn(f.ctx.workingDirectory, 'get').mockImplementation(() => { throw new Error('不读取工作区') })
    const response = await f.service.handle(new Request(`http://local/api/canvas/v2/agent-reference-choices?${new URLSearchParams({
      sessionId: f.agent.id, browse: JSON.stringify({ currentCanvasId: f.canvasId }),
    })}`))
    expect(response.status).toBe(200)
    const choices = await response.json()
    expect(choices.expandedCanvasId).toBe(f.canvasId)
    expect(choices).not.toHaveProperty('cwd')
    expect(choices.media).toEqual([])
    expect(ensure).not.toHaveBeenCalled()
    expect(get).not.toHaveBeenCalled()
    expect(await f.service.store.snapshot(f.canvasId)).toEqual(before)
  })
  it('serializes and reads a legacy # file while Agent controls the canvas, without mutating graph/tasks', async () => {
    const f = await fixture()
    await writeFile(join(f.dir, '方案.md'), '第一镜头需要修改')
    const before = await f.service.store.snapshot(f.canvasId)
    const response = await f.service.handle(new Request('http://local/api/canvas/v2/agent-reference-resolve', {
      method: 'POST', body: JSON.stringify({ sessionId: f.agent.id, ref: fileRef(f) }), headers: { 'Content-Type': 'application/json' },
    }))
    expect(response.status).toBe(200)
    const ref = referenceSpans((await response.json()).text)[0].ref
    expect(ref).toMatchObject({ pin: { bytes: Buffer.byteLength('第一镜头需要修改') } })
    const entry = submit(f, ref)!
    expect(await f.call('canvas_read_reference', { referenceId: entry.referenceId })).toMatchObject({ isError: false, value: { text: '第一镜头需要修改', understood: true } })
    expect(await f.call('canvas_inspect', {})).toMatchObject({ value: { userReferences: [{ referenceId: entry.referenceId }] } })
    expect(await f.service.store.snapshot(f.canvasId)).toEqual(before)
  })
  it('rejects cross-session, synthetic user content and unsubmitted references; main-only tool', async () => {
    const f = await fixture()
    await writeFile(join(f.dir, '方案.md'), '内容')
    submit(f, fileRef(f), 'canvas-agent')
    submit(f, { ...fileRef(f), sessionId: 'other' })
    expect(submittedReferences(f.agent)).toEqual([])
    expect(await f.call('canvas_read_reference', { referenceId: 'a'.repeat(64) })).toMatchObject({ isError: true })
    await expect(f.coordinator.chatReferences.resolve('other', fileRef(f), new AbortController().signal)).rejects.toThrow()
    const child = await f.child()
    expect(f.registry.get('canvas_read_reference', child)).toBeUndefined()
  })
  it('blocks changed, deleted, traversing and symlink files and changed workspaces', async () => {
    const f = await fixture(), refs = f.coordinator.chatReferences, signal = new AbortController().signal
    const path = join(f.dir, '方案.md')
    await writeFile(path, '原内容')
    const ref = await refs.resolve(f.agent.id, fileRef(f), signal), entry = submit(f, ref)!
    await writeFile(path, '用户改过内容')
    expect(await f.call('canvas_read_reference', { referenceId: entry.referenceId })).toMatchObject({ isError: true })
    await expect(refs.resolve(f.agent.id, fileRef(f, '../秘密'), signal)).rejects.toThrow('文件不在当前工作区内')
    await symlink(path, join(f.dir, '链接.md'))
    await expect(refs.resolve(f.agent.id, fileRef(f, '链接.md'), signal)).rejects.toThrow('符号链接')
    await rm(path)
    await expect(refs.resolve(f.agent.id, fileRef(f), signal)).rejects.toThrow('文件已移除')
    f.setCwd(tmpdir())
    await expect(refs.resolve(f.agent.id, fileRef(f), signal)).rejects.toThrow('工作区已切换')
  })
  it('reads a workspace image into actual native image context and keeps binary/large-file claims honest', async () => {
    const f = await fixture(false), signal = new AbortController().signal
    const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex')
    await writeFile(join(f.dir, '参考.png'), png)
    const ref = await f.coordinator.chatReferences.resolve(f.agent.id, fileRef(f, '参考.png'), signal), entry = submit(f, ref)!
    const saveImage = vi.fn(async () => ({ attachmentId: 'actual-image', mediaType: 'image/png', bytes: png.length }))
    Object.assign(f.ctx.attachments, { saveImage })
    expect(await f.call('canvas_read_reference', { referenceId: entry.referenceId })).toMatchObject({ isError: false, value: { admitted: true },
      additionalContexts: [{ role: 'user', source: { kind: 'canvas-agent' }, content: [{ type: 'text' }, { type: 'image', attachment: { attachmentId: 'actual-image' } }] }] })
    expect(saveImage.mock.calls[0][0].data).toEqual(png)
    await writeFile(join(f.dir, '二进制.bin'), Buffer.from([0, 1, 2]))
    const binary = submit(f, await f.coordinator.chatReferences.resolve(f.agent.id, fileRef(f, '二进制.bin'), signal))!
    expect(await f.call('canvas_read_reference', { referenceId: binary.referenceId })).toMatchObject({ value: { understood: false } })
    await writeFile(join(f.dir, '大文件.txt'), Buffer.alloc(1000001, 65))
    const large = submit(f, await f.coordinator.chatReferences.resolve(f.agent.id, fileRef(f, '大文件.txt'), signal))!
    expect(await f.call('canvas_read_reference', { referenceId: large.referenceId })).toMatchObject({ value: { understood: false } })
  })
  it('lists exact image asset identities, retains a chosen asset after renaming and rejects deleted node/canvas changes', async () => {
    const f = await fixture(), signal = new AbortController().signal
    const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex')
    const attachment = { attachmentId: 'original', mediaType: 'image/png', bytes: png.length, width: 1, height: 1, name: '原图.png' }
    f.events.push({ type: 'user/message', data: { id: 'user', source: { kind: 'user' }, content: [{ type: 'image', attachment }] } })
    Object.assign(f.ctx.attachments, { readImage: async () => ({ ref: attachment, data: png }), saveImage: vi.fn(async () => attachment) })
    await f.call('canvas_import_attachment', { operationId: randomUUID(), revision: 0, attachmentId: 'original', kind: 'image', purpose: '用户参考' })
    await f.service.runtime.uploads.run()
    const choices = await f.coordinator.chatReferences.choices(f.agent.id, '', signal)
    expect(choices.media).toHaveLength(1)
    const ref = choices.media[0].ref, entry = submit(f, ref)!
    const before = await f.service.store.snapshot(f.canvasId)
    await f.service.store.update(f.canvasId, (state) => { state.graph.nodes[0].title = '改过名称'; state.graphRevision++ })
    expect(await f.coordinator.chatReferences.resolve(f.agent.id, ref, signal)).toEqual(ref)
    expect(await f.call('canvas_read_reference', { referenceId: entry.referenceId })).toMatchObject({ isError: false, value: { admitted: true, assetId: before.assets[0].id } })
    expect(f.ctx.attachments.saveImage).toHaveBeenCalledWith(expect.objectContaining({ data: png }))
    await f.service.store.update(f.canvasId, (state) => { state.graph.nodes = []; state.graphRevision++ })
    await expect(f.coordinator.chatReferences.resolve(f.agent.id, ref, signal)).rejects.toThrow('已移除')
    await f.coordinator.takeover(f.canvasId)
    expect(await f.call('canvas_read_reference', { referenceId: entry.referenceId })).toMatchObject({ isError: true })
    const another = await f.service.store.catalogCommand({ requestId: randomUUID(), operation: 'canvas-create', name: '另一个' })
    await f.coordinator.delegate(another.id, f.agent.id, 0)
    await expect(f.coordinator.chatReferences.resolve(f.agent.id, ref, signal)).rejects.toThrow('已移除')
  })
  it.each(['video', 'audio'] as const)('pins exact %s originals and returns honest metadata without image admission or generation', async (kind) => {
    const f = await fixture(), signal = new AbortController().signal
    const bytes = Buffer.from(kind === 'video' ? '\0\0\0\x18ftypmp42test-media' : 'RIFF0000WAVEtest-media', 'latin1')
    const attachment = { attachmentId: 'media', name: kind === 'video' ? '镜头.mp4' : '旁白.wav', bytes: bytes.length }
    f.events.push({ type: 'user/message', data: { id: 'user', source: { kind: 'user' }, content: [{ type: 'file', attachment }] } })
    Object.assign(f.ctx.attachments, { readFileStream: async function* () { yield bytes }, saveImage: vi.fn() })
    expect(await f.call('canvas_import_attachment', { operationId: randomUUID(), revision: 0, attachmentId: 'media', kind, purpose: '反馈目标' })).toMatchObject({ isError: false })
    await f.service.runtime.uploads.run()
    const before = await f.service.store.snapshot(f.canvasId), choices = await f.coordinator.chatReferences.choices(f.agent.id, '', signal)
    expect(choices.media).toHaveLength(1)
    expect(choices.media[0].kind).toBe(kind)
    const entry = submit(f, choices.media[0].ref)!
    await f.coordinator.takeover(f.canvasId)
    const another = await f.service.store.catalogCommand({ requestId: randomUUID(), operation: 'canvas-create', name: '正在编辑的另一个画布' })
    await f.coordinator.delegate(another.id, f.agent.id, 0)
    expect(await f.call('canvas_read_reference', { referenceId: entry.referenceId })).toMatchObject({ isError: false, value: {
      understood: false, asset: { id: before.assets[0].id, kind }, ref: { assetId: before.assets[0].id },
    } })
    expect(f.ctx.attachments.saveImage).not.toHaveBeenCalled()
    expect(await f.service.store.snapshot(f.canvasId)).toEqual(before)
  })
  it('orders every folder and canvas by visible editor then edit time, including empty current canvases', async () => {
    const f = await fixture(), refs = f.coordinator.chatReferences, signal = new AbortController().signal
    const first = await f.service.store.catalogCommand({ requestId: randomUUID(), operation: 'folder-create', name: '当前分类' })
    const second = await f.service.store.catalogCommand({ requestId: randomUUID(), operation: 'folder-create', name: '最近分类' })
    const make = (name: string, folderId: string) => f.service.store.catalogCommand({ requestId: randomUUID(), operation: 'canvas-create', name, folderId })
    const older = await make('人工打开', first.id), newer = await make('同分类更新', first.id), latest = await make('最新编辑', second.id)
    for (const [id, time] of [[f.canvasId, 1], [older.id, 10], [newer.id, 20], [latest.id, 30]] as const)
      await f.service.store.db.batch([sql('UPDATE canvases SET updated_at=? WHERE id=?', [time, id])])
    const before = await f.service.store.catalog(), control = f.coordinator.session(f.agent.id).canvas
    const choices = await refs.choices(f.agent.id, '', signal, { currentCanvasId: older.id })
    expect(choices.expandedCanvasId).toBe(older.id)
    expect(choices.folders!.map((folder) => folder.name)).toEqual(['当前分类', '最近分类', '未分类'])
    expect(choices.folders![0].canvases.map((canvas) => canvas.id)).toEqual([older.id, newer.id])
    expect(choices.media).toEqual([])
    const none = await refs.choices(f.agent.id, '', signal, { currentCanvasId: null })
    expect(none.expandedCanvasId).toBe(latest.id)
    expect(none.folders![0].name).toBe('最近分类')
    const folder = await refs.choices(f.agent.id, '', signal, { currentCanvasId: older.id, folderId: second.id })
    expect(folder.expandedCanvasId).toBeUndefined()
    const canvas = await refs.choices(f.agent.id, '', signal, { currentCanvasId: older.id, folderId: second.id, browseCanvasId: latest.id })
    expect(canvas.expandedCanvasId).toBe(latest.id)
    await expect(refs.choices(f.agent.id, '', signal, { folderId: first.id, browseCanvasId: latest.id })).rejects.toThrow('移出文件夹')
    const response = await f.service.handle(new Request(`http://local/api/canvas/v2/agent-reference-choices?${new URLSearchParams({
      sessionId: f.agent.id, browse: JSON.stringify({ currentCanvasId: older.id }),
    })}`))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ expandedCanvasId: older.id, currentCanvasId: older.id })
    expect(await f.service.store.catalog()).toEqual(before)
    expect(f.coordinator.session(f.agent.id).canvas).toEqual(control)
  })
  it('admits a submitted image from another canvas without navigating, rebinding or replacing the original', async () => {
    const f = await fixture(), signal = new AbortController().signal
    const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex')
    const attachment = { attachmentId: 'foreign', mediaType: 'image/png', bytes: png.length, name: '旧画布原图.png' }
    f.events.push({ type: 'user/message', data: { id: 'user', source: { kind: 'user' }, content: [{ type: 'image', attachment }] } })
    Object.assign(f.ctx.attachments, { readImage: async () => ({ ref: attachment, data: png }), saveImage: vi.fn(async () => attachment) })
    await f.call('canvas_import_attachment', { operationId: randomUUID(), revision: 0, attachmentId: attachment.attachmentId, kind: 'image', purpose: '引用' })
    await f.service.runtime.uploads.run()
    const original = await f.service.store.snapshot(f.canvasId)
    const ref = (await f.coordinator.chatReferences.choices(f.agent.id, '', signal)).media[0].ref
    const entry = submit(f, ref)!
    await f.coordinator.takeover(f.canvasId)
    const another = await f.service.store.catalogCommand({ requestId: randomUUID(), operation: 'canvas-create', name: '人工打开' })
    await f.coordinator.delegate(another.id, f.agent.id, 0)
    const before = await f.service.store.snapshot(another.id), publish = vi.spyOn(f.coordinator.presentation, 'publish')
    expect(await f.coordinator.chatReferences.resolve(f.agent.id, ref, signal)).toEqual(ref)
    expect(await f.call('canvas_read_reference', { referenceId: entry.referenceId })).toMatchObject({ isError: false, value: {
      admitted: true, assetId: original.assets[0].id, ref: { canvasId: f.canvasId },
    }, additionalContexts: [{ content: [{ type: 'text' }, { type: 'image' }] }] })
    expect(f.ctx.attachments.saveImage).toHaveBeenCalledWith(expect.objectContaining({ data: png }))
    expect(publish).not.toHaveBeenCalled()
    expect(await f.service.store.snapshot(another.id)).toEqual(before)
    f.ctx.attachments.saveImage.mockImplementationOnce(async () => { await f.coordinator.takeover(another.id); return attachment })
    const cancelled = await f.call('canvas_read_reference', { referenceId: entry.referenceId })
    expect(cancelled).toMatchObject({ isError: true })
    expect(cancelled.additionalContexts ?? []).toEqual([])
    await f.coordinator.takeover(another.id)
    // Discovery/serialization is possible before granting Agent edit control.
    expect(await f.coordinator.chatReferences.resolve(f.agent.id, ref, signal)).toEqual(ref)
    const row = (await f.service.store.catalog()).canvases.find((canvas) => canvas.id === f.canvasId)!
    await f.service.store.catalogCommand({ requestId: randomUUID(), operation: 'canvas-delete', id: row.id, revision: row.revision })
    await expect(f.coordinator.chatReferences.resolve(f.agent.id, ref, signal)).rejects.toThrow('画布已移除')
  })
})
describe('Native canvas plan reviews', () => {
  it('can review before binding a canvas and does not prepare a project as a side effect', async () => {
    const f = await fixture(false), before = await f.service.store.catalog()
    f.agent.ctx.on('user-questions/request', async (request) => ({ answers: [{ id: request.questions[0].id, selected: ['确认方案'] }] }))
    expect(await f.call('canvas_review_plan', { plan: '先讨论方向' })).toMatchObject({ isError: false, value: { approved: true } })
    expect(f.coordinator.session(f.agent.id).canvas).toBeNull()
    expect(await f.service.store.catalog()).toEqual(before)
  })
  it('rejects an unbound review when the user binds a canvas during the wait', async () => {
    const f = await fixture(false)
    f.agent.ctx.on('user-questions/request', async (request) => {
      await f.coordinator.delegate(f.canvasId, f.agent.id, 0)
      return { answers: [{ id: request.questions[0].id, selected: ['确认方案'] }] }
    })
    expect(await f.call('canvas_review_plan', { plan: '旧讨论方案' })).toMatchObject({ isError: true })
  })
  it('passes full Markdown, exact root identity, cancellation and logged call identity to the native answerer without generating', async () => {
    const f = await fixture(), signal = new AbortController().signal
    let request!: AskUserQuestionRequest
    f.agent.ctx.on('user-questions/request', async (value) => {
      request = value
      return { answers: [{ id: value.questions[0].id, selected: ['确认方案'] }] }
    })
    const before = await f.service.store.snapshot(f.canvasId)
    const result = await f.call('canvas_review_plan', { plan: '# 分镜\n\n| 镜头 | 时长 |\n| --- | --- |\n| 开场 | 5秒 |', title: '广告方案' }, signal)
    expect(result).toMatchObject({ isError: false, value: { approved: true } })
    expect(request.agent).toBe(f.agent)
    expect(request.signal).toBe(signal)
    expect(request.wait?.callId).toBeTruthy()
    expect(request.questions).toEqual([expect.objectContaining({
      header: '广告方案', detail: '# 分镜\n\n| 镜头 | 时长 |\n| --- | --- |\n| 开场 | 5秒 |', multiSelect: false,
      intent: { kind: 'plan-review', approve: '确认方案' },
      options: [expect.objectContaining({ label: '确认方案' }), expect.objectContaining({ label: '需要修改' })],
    })])
    expect(await f.service.store.snapshot(f.canvasId)).toEqual(before)
    const child = await f.child()
    expect(f.registry.get('canvas_review_plan', child)).toBeUndefined()
  })
  it.each([
    { selected: ['需要修改'] },
    { selected: [], custom: '换个开场' },
    { selected: ['确认方案'], custom: '但先别生成' },
    { selected: ['确认方案', '需要修改'] },
  ])('does not interpret decline or mixed/free-text feedback as approval: %j', async (answer) => {
    const f = await fixture()
    f.agent.ctx.on('user-questions/request', async (value) => ({ answers: [{ id: value.questions[0].id, ...answer }] }))
    expect(await f.call('canvas_review_plan', { plan: '待审方案' })).toMatchObject({ isError: false, value: { approved: false, answers: [{ ...answer }] } })
  })
  it('rejects blank/oversized plans before opening the native card', async () => {
    const f = await fixture(), answerer = vi.fn(async () => ({ answers: [] }))
    f.agent.ctx.on('user-questions/request', answerer)
    expect((await f.call('canvas_review_plan', { plan: '  ' })).isError).toBe(true)
    expect((await f.call('canvas_review_plan', { plan: 'x'.repeat(32001) })).isError).toBe(true)
    expect(answerer).not.toHaveBeenCalled()
  })
  it.each(['cancel', 'takeover'] as const)('rejects a late approval after %s', async (action) => {
    const f = await fixture(), controller = new AbortController()
    let answer!: (value: AskUserQuestionAnswer) => void, opened!: () => void
    const opening = new Promise<void>((resolve) => { opened = resolve })
    f.agent.ctx.on('user-questions/request', async (request) => {
      opened()
      return new Promise<AskUserQuestionAnswer>((resolve) => { answer = resolve })
    })
    const reviewing = f.call('canvas_review_plan', { plan: '原方案' }, controller.signal)
    await opening
    if (action === 'cancel') controller.abort()
    else await f.coordinator.takeover(f.canvasId)
    answer({ answers: [{ id: 'canvas-plan', selected: ['确认方案'] }] })
    expect((await reviewing).isError).toBe(true)
    expect(f.service.store.state(f.canvasId).graph.nodes).toHaveLength(0)
  })
})
describe('Canvas Agent permissions and durable operations', () => {
  it('creates Agent 创作 before new canvases, reuses it and preserves creation retries after moves/renames', async () => {
    const f = await fixture(false), operationId = randomUUID()
    const first = await f.call('canvas_open', { operationId, name: '用户产品' })
    expect(first).toMatchObject({ isError: false, value: { folderName: 'Agent 创作', folderCreated: true } })
    const id = (first.value as any).control.canvasId
    const catalog = await f.service.store.catalog()
    expect(catalog.folders).toHaveLength(1)
    const canvas = catalog.canvases.find((c) => c.id === id)!
    expect(canvas.folderId).toBe(catalog.folders[0].id)
    await f.service.store.catalogCommand({ requestId: randomUUID(), operation: 'canvas-move', id, revision: canvas.revision, folderId: null })
    expect(await f.call('canvas_open', { operationId, name: '用户产品' })).toMatchObject({ isError: false, value: { control: { canvasId: id }, folderCreated: false } })
    expect(await f.call('canvas_open', { operationId, name: '另一项目' })).toMatchObject({ isError: true })
    expect((await f.service.store.catalog()).canvases).toHaveLength(2)
  })
  it('imports only an actual root user image, preserves bytes and publishes a real reference asset exactly once', async () => {
    const f = await fixture()
    const bytes = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex')
    const attachment = { attachmentId: 'user-original', mediaType: 'image/png', bytes: bytes.length, width: 1, height: 1, name: '产品原图.png' }
    f.events.push({ type: 'user/message', data: { id: 'user-message', source: { kind: 'user' }, content: [{ type: 'image', attachment }] } })
    f.events.push({ type: 'user/message', data: { id: 'plugin-message', source: { kind: 'canvas-agent' }, content: [{ type: 'image', attachment: { ...attachment, attachmentId: 'synthetic' } }] } })
    const reader = vi.fn(async () => ({ ref: attachment, data: bytes }))
    Object.assign(f.ctx.attachments, { readImage: reader })
    expect(await f.call('canvas_inspect', {})).toMatchObject({ value: { userMedia: [{ attachmentId: 'user-original' }] } })
    expect(await f.call('canvas_import_attachment', { operationId: randomUUID(), revision: 0, attachmentId: 'synthetic', kind: 'image', purpose: '产品一致性' })).toMatchObject({ isError: true })
    expect(reader).not.toHaveBeenCalled()
    const args = { operationId: randomUUID(), revision: 0, attachmentId: 'user-original', kind: 'image', purpose: '产品一致性' }
    const result = await f.call('canvas_import_attachment', args)
    expect(result).toMatchObject({ isError: false, value: { referenceReady: false, status: 'queued' } })
    await f.service.runtime.uploads.run()
    const state = await f.service.store.snapshot(f.canvasId)
    expect(state.assets).toHaveLength(1)
    expect(state.graph.nodes[0].assetId).toBe(state.assets[0].id)
    const locator = await f.service.store.locator(f.canvasId, state.assets[0].id)
    const stream = await (await f.service.store.objects.adapter(locator.providerId, locator.credentialRef)).openRead(locator)
    const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(chunk)
    expect(Buffer.concat(chunks)).toEqual(bytes)
    const model = f.service.store.listModels().find((m) => m.kind === 'image' && m.model_id.includes('seedream'))!
    await f.service.store.saveModel({ ...BUILTIN_MODELS.find((item) => item.id === model.id)!, api_key: 'fixture-reference-model-key' })
    await chooseGeneration(f, model)
    const nodeId = randomUUID()
    expect(await f.call('canvas_create_node', { operationId: nodeId, revision: state.graphRevision, kind: 'image-generation', title: '产品广告', prompt: '保持参考产品一致', modelId: model.id })).toMatchObject({ isError: false })
    expect(await f.call('canvas_connect', { operationId: randomUUID(), revision: f.service.store.state(f.canvasId).graphRevision, source: state.graph.nodes[0].id, target: nodeId, assetId: state.assets[0].id })).toMatchObject({ isError: false })
    expect(f.service.store.state(f.canvasId).graph.edges[0]).toMatchObject({ assetId: state.assets[0].id })
    const exported = await f.call('canvas_export_media', { operationId: randomUUID(), assetId: state.assets[0].id, userRequest: '把这张产品图下载到当前工作区' })
    expect(exported).toMatchObject({ isError: false, value: { file: { relativePath: expect.stringContaining('/媒体/图片/') } } })
    expect(await readFile((exported.value as any).file.path)).toEqual(bytes)
    expect(await f.call('canvas_import_attachment', args)).toMatchObject({ isError: false })
    expect((await f.service.store.snapshot(f.canvasId)).graph.nodes).toHaveLength(2)
    expect(await f.call('canvas_import_attachment', { ...args, purpose: '不同输入' })).toMatchObject({ isError: true })
  })
  it('blocks attachment import if human takeover happens while reading the admitted file', async () => {
    const f = await fixture()
    f.events.push({ type: 'user/message', data: { id: 'file', source: { kind: 'user' }, content: [{ type: 'file', attachment: { attachmentId: 'media-file', name: '声音.wav', bytes: 12 } }] } })
    Object.assign(f.ctx.attachments, { readFileStream: async function* () { void f.coordinator.takeover(f.canvasId); yield Buffer.from('RIFF0000WAVE') } })
    expect(await f.call('canvas_import_attachment', { operationId: randomUUID(), revision: 0, attachmentId: 'media-file', kind: 'audio', purpose: '音色参考' })).toMatchObject({ isError: true })
    expect(f.service.store.state(f.canvasId).graph.nodes).toHaveLength(0)
    expect(await f.service.store.db.all('SELECT * FROM upload_sessions')).toHaveLength(0)
  })
  it('rejects unsupported user file bytes before creating any upload node', async () => {
    const f = await fixture()
    f.events.push({ type: 'user/message', data: { id: 'file', source: { kind: 'user' }, content: [{ type: 'file', attachment: { attachmentId: 'text-file', name: '资料.txt', bytes: 5 } }] } })
    Object.assign(f.ctx.attachments, { readFileStream: async function* () { yield Buffer.from('hello') } })
    expect(await f.call('canvas_import_attachment', { operationId: randomUUID(), revision: 0, attachmentId: 'text-file', kind: 'video', purpose: '视频参考' })).toMatchObject({ isError: true })
    expect(f.service.store.state(f.canvasId).graph.nodes).toHaveLength(0)
  })
  it('saves drafts and documents under the committed workspace and refuses old-workspace receipt replay', async () => {
    const f = await fixture(), next = await mkdtemp(join(tmpdir(), 'agent-current-cwd-'))
    cleanup.push(() => rm(next, { recursive: true, force: true }))
    f.setCwd(next)
    const args = { operationId: randomUUID(), draft: { kind: 'storyboard', title: '分镜', content: '完整分镜文本' } }
    const result = await f.call('canvas_draft', args)
    expect(result).toMatchObject({ isError: false, value: { file: { relativePath: expect.stringContaining('/文档/分镜/') } } })
    const file = (result.value as any).file.path
    expect(await readFile(file, 'utf8')).toContain('完整分镜文本')
    expect(await f.call('canvas_draft', args)).toMatchObject({ isError: false })
    expect(f.coordinator.ledger.drafts(f.canvasId)).toHaveLength(1)
    f.setCwd(f.dir)
    expect(await f.call('canvas_draft', args)).toMatchObject({ isError: true })
    expect(await readdir(f.dir)).not.toContain('Agent 创作')
  })
  it('will not overwrite a user file or follow an Agent folder symlink', async () => {
    const f = await fixture(), args = { operationId: randomUUID(), document: { title: '方案', content: '文档文本', category: '方案' } }
    const first = await f.call('canvas_document', args), file = (first.value as any).file.path
    await writeFile(file, '用户改写')
    // Even another operation with a colliding target must use no-overwrite publication.
    const { AgentWorkspace } = await import('../src/host/agent/workspace')
    const workspace = new AgentWorkspace(f.ctx)
    const { Readable } = await import('node:stream')
    await expect(workspace.publish(f.agent, { id: f.canvasId, name: 'Agent test' }, ['文档', '方案'], `方案-${args.operationId}.md`, Readable.from(['不同内容']), 1000, new AbortController().signal, () => {})).rejects.toMatchObject({ code: 'FILE_COLLISION' })
    expect(await readFile(file, 'utf8')).toBe('用户改写')
    const outside = await mkdtemp(join(tmpdir(), 'agent-outside-'))
    cleanup.push(() => rm(outside, { recursive: true, force: true }))
    await rm(join(f.dir, 'Agent 创作'), { recursive: true, force: true })
    await symlink(outside, join(f.dir, 'Agent 创作'))
    expect(await f.call('canvas_document', { ...args, operationId: randomUUID() })).toMatchObject({ isError: true })
    expect(await readdir(outside)).toEqual([])
  })
  it('places the first node at an actual zoomed view center and exposes a truthful presentation outcome', async () => {
    const f = await fixture(), control = f.coordinator.control(f.canvasId)
    f.coordinator.presentation.report({ sessionId: f.agent.id, canvasId: f.canvasId, epoch: control.epoch, viewId: 'view', sequence: 1,
      visible: true, following: true, center: { x: 850, y: -100 }, width: 700, height: 600, zoom: .4 })
    const args = { operationId: randomUUID(), revision: 0, kind: 'video-generation', title: '镜头', prompt: '当前镜头' }
    const result = await f.call('canvas_create_node', args)
    expect(result).toMatchObject({ isError: false, value: { placement: { position: { x: 690, y: -190 }, source: 'visible-viewport' }, presentation: { status: 'deferred' } } })
    expect(f.service.store.state(f.canvasId).graph.nodes[0].position).toEqual({ x: 690, y: -190 })
    const replay = await f.call('canvas_create_node', { ...args, note: '我核对同一步的实际结果。' })
    expect(replay).toMatchObject({ isError: false })
    expect(f.service.store.state(f.canvasId).graph.nodes).toHaveLength(1)
  })
  it('admits view reports while locked, rejects wrong identities and streams actual intent changes without mutations', async () => {
    const f = await fixture(), control = f.coordinator.control(f.canvasId)
    const post = (suffix: string, body: unknown) => f.service.handle(new Request(`http://localhost/api/canvas/v2/${suffix}?canvas=${f.canvasId}`, { method: 'POST', body: JSON.stringify(body) }))
    const report = { sessionId: f.agent.id, canvasId: f.canvasId, epoch: control.epoch, viewId: 'view', sequence: 1, visible: true, following: true }
    expect((await post('agent-view', report)).status).toBe(200)
    expect((await post('agent-view', { ...report, sessionId: 'other' })).status).toBe(409)
    const response = await f.service.handle(new Request(`http://localhost/api/canvas/v2/agent-presentation-events?sessionId=${f.agent.id}`))
    const reader = response.body!.getReader()
    const first = new TextDecoder().decode((await reader.read()).value)
    expect(first).toContain(control.canvasId)
    await reader.cancel()
    expect(f.service.store.state(f.canvasId).graph.nodes).toHaveLength(0)
  })
  it('filters exactly the five internal presets from the native chooser without changing the returned source', async () => {
    const f = await fixture()
    const { INTERNAL_CANVAS_PRESETS } = await import('../src/shared/agent')
    const entries = [
      { id: 'standard', name: '标准模式', isDefault: true },
      { id: 'canvas-creator', name: '无限画布', isDefault: false },
      ...INTERNAL_CANVAS_PRESETS.map((id) => ({ id, name: id, isDefault: false })),
      { id: 'canvas-other-plugin', name: '其他插件', isDefault: false },
    ]
    const roster = { presets: entries }, original = f.ctx.agentPresets.remoteExportList
    vi.mocked(original).mockResolvedValue(roster)
    f.coordinator.installPresetRosterGuard()
    const result = await f.ctx.agentPresets.remoteExportList()
    expect(result.presets.map((p) => p.id)).toEqual(['standard', 'canvas-creator', 'canvas-other-plugin'])
    expect(result.presets[0]).toBe(entries[0])
    expect(roster.presets).toHaveLength(3 + INTERNAL_CANVAS_PRESETS.length)
    const child = await f.child()
    expect(f.registry.get('canvas_inspect', child)).toBeDefined()
    expect(f.registry.get('canvas_generate', child)).toBeUndefined()
  })
  it('restores the native roster method when the visibility adapter is unloaded', async () => {
    const f = await fixture(), original = f.ctx.agentPresets.remoteExportList
    const dispose = f.coordinator.installPresetRosterGuard()
    expect(f.ctx.agentPresets.remoteExportList).not.toBe(original)
    await dispose()
    expect(f.ctx.agentPresets.remoteExportList).toBe(original)
  })
  it('uses real scoped SDK registration and hides terminal tools without affecting another Agent', async () => {
    const f = await fixture()
    expect(f.registry.schemas(f.agent).map((s) => s.name)).not.toContain('canvas_create_node')
    expect(f.registry.schemas(f.agent).map((s) => s.name)).toContain('canvas_execute')
    expect(await f.rawCall('canvas_create_node', { operationId: randomUUID(), revision: 0, kind: 'image-generation', title: '绕过', prompt: '' })).toMatchObject({ isError: true })
    expect(f.registry.get('bash', f.agent)).toBeUndefined()
    expect(f.registry.get('bash', scopeOf(f.ctx))).toBeDefined()
    expect((await f.call('bash', {})).isError).toBe(true)
    expect((await f.call('canvas_inspect', {})).isError).toBe(false)
    expect(await f.call('canvas_create_node', { operationId: randomUUID(), revision: 0, kind: 'image-generation', title: '资产', prompt: '', position: { x: 0, y: 0 } })).toMatchObject({ isError: false })
  })
  it('replays one create exactly once, rejects reused IDs, and retains the old canvas schema', async () => {
    const f = await fixture()
    const args = { operationId: randomUUID(), revision: 0, kind: 'image-generation', title: '角色资产', prompt: '人物造型', position: { x: 0, y: 0 } }
    const first = await f.call('canvas_create_node', args)
    expect(first).toMatchObject({ isError: false })
    expect(await f.call('canvas_create_node', args)).toMatchObject({ value: (first as any).value })
    expect((await f.call('canvas_create_node', { ...args, prompt: '其他人物' })).isError).toBe(true)
    const graph = f.service.store.state(f.canvasId).graph
    expect(graph.nodes).toHaveLength(1)
    expect(Object.keys(graph).sort()).toEqual(['edges', 'nodes', 'version', 'viewport'])
  })
  it('revokes writes synchronously, cancels the actual Agent, and blocks manual mutations until takeover', async () => {
    const f = await fixture()
    const args = { operationId: randomUUID(), revision: 0, kind: 'image-generation', title: '角色', prompt: '', position: { x: 0, y: 0 } }
    const response = await f.service.handle(new Request(`http://localhost/api/canvas/v2/graph?canvas=${f.canvasId}`, { method: 'POST', body: '{}' }))
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'CANVAS_READ_ONLY' })
    const taking = f.coordinator.takeover(f.canvasId)
    expect(f.coordinator.control(f.canvasId).mode).toBe('manual')
    expect(f.agent.cancel).toHaveBeenCalledWith({ kind: 'user' })
    expect((await f.call('canvas_create_node', args)).isError).toBe(true)
    await taking
    const graph = await f.service.handle(new Request(`http://localhost/api/canvas/v2/graph?canvas=${f.canvasId}`))
    expect((await graph.json()).agentControl.mode).toBe('manual')
    await f.coordinator.delegate(f.canvasId, f.agent.id, 0)
    expect((await f.call('canvas_create_node', args)).isError).toBe(false)
  })
  it('checks permission again at the database commit after asynchronous validation', async () => {
    const f = await fixture()
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const validate = (f.service as any).validate.bind(f.service)
    vi.spyOn(f.service as any, 'validate').mockImplementation(async (...args) => { await blocked; return validate(...args) })
    const c = f.coordinator.control(f.canvasId)
    const node = { id: randomUUID(), kind: 'image-generation' as const, title: '晚到', prompt: '', modelId: null, params: null, assetId: null, selectedResultId: null, position: { x: 0, y: 0 } }
    const { hash } = await import('../src/host/persistence/database')
    const writing = f.coordinator.serial(() => f.service.mutateGraph(f.canvasId, { mutationId: randomUUID(), baseRevision: 0, nodes: [{ value: node, hash: hash(node) }], edges: [], deleteNodes: [], deleteEdges: [] }, () => f.coordinator.assert(f.agent, c)))
    const rejected = expect(writing).rejects.toMatchObject({ code: 'AGENT_CONTROL_REVOKED' })
    await Promise.resolve()
    const taking = f.coordinator.takeover(f.canvasId)
    release()
    await rejected; await taking
    expect(f.service.store.state(f.canvasId).graph.nodes).toHaveLength(0)
  })
  it('restores manual control for a new root-user message before native pre-step and request guards', async () => {
    const f = await fixture(), old = f.coordinator.control(f.canvasId)
    await f.coordinator.takeover(f.canvasId)
    const signal = new AbortController().signal
    const next = vi.fn(async () => ({ kind: 'accept' as const }))
    await f.ctx.waterfall(scopeTarget(f.agent, f.agent), 'agent/pre-step', {
      agent: f.agent, messages: [{ id: 'new-user', source: { kind: 'user' }, content: [{ type: 'text', text: '继续修改' }] } as any],
      turn: 2, step: 1, signal,
    }, next)
    const control = f.coordinator.control(f.canvasId)
    expect(control).toMatchObject({ mode: 'agent', sessionId: f.agent.id, epoch: old.epoch + 2 })
    expect(next).toHaveBeenCalledTimes(1)
    expect(() => f.coordinator.assert(f.agent, old)).toThrow('重新委托')
    const request = await f.ctx.waterfall(scopeTarget(f.agent, f.agent), 'agent/request',
      { agent: f.agent, turn: 2, step: 1, signal }, async () => ({ provider: 'fixture', model: 'vision' }))
    expect(request).toMatchObject({ provider: 'fixture', model: 'vision' })
    expect((await f.call('canvas_inspect', {})).isError).toBe(false)
  })
  it('does not renew control for old tool continuation, child input or an aborted new step', async () => {
    const f = await fixture()
    const oldMessage = { id: 'before-takeover', source: { kind: 'user' }, content: [] } as any
    Object.assign(f.agent, { inbox: { nextTurn: [oldMessage], nextStep: [] } })
    await f.coordinator.takeover(f.canvasId)
    const control = f.coordinator.control(f.canvasId), signal = new AbortController().signal
    for (const messages of [[], [{ source: { kind: 'canvas-agent' } }], [oldMessage]]) {
      await expect(f.ctx.waterfall(scopeTarget(f.agent, f.agent), 'agent/pre-step',
        { agent: f.agent, messages: messages as any, turn: 1, step: 2, signal }, async () => ({ kind: 'accept' as const }))).rejects.toMatchObject({ code: 'AGENT_CONTROL_REVOKED' })
      expect(f.coordinator.control(f.canvasId)).toEqual(control)
    }
    const aborted = new AbortController(); aborted.abort()
    await expect(f.ctx.waterfall(scopeTarget(f.agent, f.agent), 'agent/pre-step',
      { agent: f.agent, messages: [{ source: { kind: 'user' } }] as any, turn: 2, step: 1, signal: aborted.signal },
      async () => ({ kind: 'accept' as const }))).rejects.toThrow()
    expect(f.coordinator.control(f.canvasId)).toEqual(control)
  })
  it('rejects delayed automatic delegation against a newer takeover epoch', async () => {
    const f = await fixture()
    await f.coordinator.takeover(f.canvasId)
    const stale = f.coordinator.control(f.canvasId)
    await f.coordinator.takeover(f.canvasId)
    await expect(f.coordinator.delegate(f.canvasId, f.agent.id, 0, stale.epoch)).rejects.toMatchObject({ code: 'AGENT_CONTROL_REVOKED' })
    expect(f.coordinator.control(f.canvasId).mode).toBe('manual')
  })
  it('stores versioned logical drafts independently and returns to manual mode on restart', async () => {
    const f = await fixture()
    const draft = { kind: 'asset-spec', title: '人物 A', content: '服装：蓝色外套。待用户认可。', dependencies: [] }
    for (let i = 0; i < 2; i++) expect((await f.call('canvas_draft', { operationId: randomUUID(), draft })).isError).toBe(false)
    expect(f.coordinator.ledger.drafts(f.canvasId).map((d) => d.version)).toEqual([1, 2])
    expect((await stat(join(f.dir, 'agent-ledger.json'))).mode & 0o777).toBe(0o600)
    const { AgentLedger } = await import('../src/host/agent/ledger')
    const restored = new AgentLedger(f.dir); await restored.init()
    expect(restored.control(f.canvasId).mode).toBe('manual')
    expect(restored.drafts(f.canvasId)).toHaveLength(2)
    expect(JSON.parse(await readFile(join(f.dir, 'agent-ledger.json'), 'utf8')).version).toBe(1)
  })
  it('rejects text-only and unknown modality metadata at model selection and dispatch', async () => {
    const f = await fixture()
    f.coordinator.installModelSelectionGuard()
    await expect(f.ctx.sessionController.selectModel({ sessionId: f.agent.id, provider: 'fixture', model: 'text' })).rejects.toMatchObject({ code: 'AGENT_MULTIMODAL_REQUIRED' })
    expect(f.selectModel).not.toHaveBeenCalled()
    await f.ctx.sessionController.selectModel({ sessionId: f.agent.id, provider: 'fixture', model: 'vision' })
    expect(f.selectModel).toHaveBeenCalledTimes(1)
    f.resolveModelInfo.mockResolvedValueOnce({ inputModalities: undefined } as any)
    await expect(f.coordinator.qualified('fixture', 'unknown')).rejects.toMatchObject({ code: 'AGENT_MULTIMODAL_REQUIRED' })
  })
  it('gives a separately scoped specialist only read tools and SDK structured output', async () => {
    const f = await fixture(), child = await f.child()
    expect(f.registry.get('canvas_inspect', child)).toBeDefined()
    expect(f.registry.get('structured_output', child)).toBeDefined()
    for (const name of ['canvas_generate', 'canvas_create_node', 'canvas_draft', 'canvas_specialist', 'ask_user_question', 'bash']) expect(f.registry.get(name, child)).toBeUndefined()
    const result = await f.registry.execute({ name: 'canvas_inspect', arguments: {}, agent: child, callId: ToolCallId(randomUUID()), signal: new AbortController().signal })
    expect(result.isError).toBe(false)
    await f.coordinator.takeover(f.canvasId)
    expect(child.cancel).toHaveBeenCalledWith({ kind: 'user' })
  })
  it('returns human edits as factual text and invalidates dependency drafts when an asset specification is versioned', async () => {
    const f = await fixture()
    const { handoffSummary } = await import('../src/host/agent/handoff')
    const before = f.service.store.state(f.canvasId).graph
    const args = { operationId: randomUUID(), revision: 0, kind: 'image-generation', title: '角色', prompt: '蓝色外套', position: { x: 0, y: 0 } }
    await f.call('canvas_create_node', args)
    const after = f.service.store.state(f.canvasId).graph
    expect(handoffSummary(before, after, 1)).toContain(args.operationId)
    const spec = f.coordinator.ledger.draft({ kind: 'asset-spec', title: '角色', content: 'v1', dependencies: [], assetIds: [] }, f.coordinator.control(f.canvasId), 1, f.agent.id)
    f.coordinator.ledger.draft({ kind: 'storyboard', title: '镜头1', content: '引用角色 v1', dependencies: [spec.id], assetIds: [] }, f.coordinator.control(f.canvasId), 1, f.agent.id)
    f.coordinator.ledger.draft({ kind: 'asset-spec', title: '角色', content: 'v2', dependencies: [], assetIds: [] }, f.coordinator.control(f.canvasId), 1, f.agent.id)
    expect(f.coordinator.ledger.drafts(f.canvasId).find((d) => d.title === '镜头1')?.needsReview).toBe(true)
    await f.coordinator.takeover(f.canvasId)
    const node = { ...after.nodes[0], prompt: '红色外套' }
    await f.service.saveGraph(f.canvasId, { ...after, nodes: [node] }, 1)
    await f.coordinator.delegate(f.canvasId, f.agent.id, 2)
    expect(f.coordinator.ledger.handoff(f.canvasId)?.summary).toContain('红色外套')
  })
  it('deduplicates concurrent specialist requests and refuses replay of an interrupted activation', async () => {
    const f = await fixture(), id = randomUUID(), key = `${f.canvasId}:specialist:${id}`, args = { operationId: id, task: 'asset' }
    let release!: () => void
    const waiting = new Promise<void>((resolve) => { release = resolve })
    const run = vi.fn(async () => { await waiting; return { content: 'draft' } })
    const first = f.coordinator.specialist(f.agent, key, args, run)
    const second = f.coordinator.specialist(f.agent, key, args, run)
    release()
    expect(await first).toEqual(await second)
    expect(run).toHaveBeenCalledTimes(1)
    const interrupted = `${f.canvasId}:specialist:${randomUUID()}`
    f.coordinator.ledger.remember(`${interrupted}:started`, args, { started: true })
    await expect(f.coordinator.specialist(f.agent, interrupted, args, run)).rejects.toMatchObject({ code: 'SPECIALIST_INCOMPLETE' })
  })
  it('shares four model slots and queues excess runs without losing receipts', async () => {
    const f = await fixture()
    let release!: () => void, started!: () => void
    const waiting = new Promise<void>((resolve) => { release = resolve })
    const active = new Promise<void>((resolve) => { started = resolve })
    let count = 0
    const run = async () => { if (++count === 4) started(); await waiting; return {} }
    const first = f.coordinator.specialist(f.agent, `${f.canvasId}:specialist:${randomUUID()}`, {}, run)
    const second = f.coordinator.specialist(f.agent, `${f.canvasId}:specialist:${randomUUID()}`, {}, run)
    const third = f.coordinator.specialist(f.agent, `${f.canvasId}:specialist:${randomUUID()}`, {}, run)
    const fourth = f.coordinator.specialist(f.agent, `${f.canvasId}:specialist:${randomUUID()}`, {}, run)
    await active
    const fifth = f.coordinator.specialist(f.agent, `${f.canvasId}:specialist:${randomUUID()}`, {}, run)
    expect(count).toBe(4)
    release(); await Promise.all([first, second, third, fourth, fifth])
    expect(count).toBe(5)
  })
  it('isolates and replays a generated request identity without calling the service twice', async () => {
    const f = await fixture(), nodeId = randomUUID()
    await f.call('canvas_create_node', { operationId: nodeId, revision: 0, kind: 'tts-generation', title: '旁白', prompt: '产品介绍' })
    const generated = vi.spyOn(f.service, 'generate').mockResolvedValue({ id: randomUUID(), status: 'queued' } as any)
    const args = { operationId: randomUUID(), revision: 1, nodeId }
    const first = await f.call('canvas_generate', args)
    expect(first.isError).toBe(false)
    expect((await f.call('canvas_generate', args)).isError).toBe(false)
    expect(generated).toHaveBeenCalledTimes(1)
    const requestId = generated.mock.calls[0][3]!
    expect(requestId).not.toBe(args.operationId)
    expect(f.coordinator.ledger.submission(requestId)).toMatchObject({ canvasId: f.canvasId, sessionId: f.agent.id })
  })
  it('publishes the actual target before a delayed generate call and uses native run status without changing node coordinates or replaying generation', async () => {
    const f = await fixture()
    Object.assign(f.agent, { status: 'running' })
    const nodeId = randomUUID()
    await f.call('canvas_create_node', { operationId: nodeId, revision: 0, kind: 'tts-generation', title: '旁白', prompt: '产品介绍' })
    const position = { ...f.service.store.state(f.canvasId).graph.nodes[0].position }
    let finish!: () => void
    const pending = new Promise<void>((resolve) => { finish = resolve })
    const generated = vi.spyOn(f.service, 'generate').mockImplementation(async () => {
      expect(f.coordinator.presentation.state(f.agent.id)).toMatchObject({ running: true,
        intent: { id: expect.stringContaining(':working'), nodeIds: [nodeId], action: 'generate' } })
      await pending
      return { id: randomUUID(), status: 'queued' } as any
    })
    const args = { operationId: randomUUID(), revision: 1, nodeId }
    const work = f.call('canvas_generate', args)
    await vi.waitFor(() => expect(generated).toHaveBeenCalledTimes(1))
    finish()
    expect(await work).toMatchObject({ isError: false })
    expect(f.service.store.state(f.canvasId).graph.nodes[0].position).toEqual(position)
    Object.assign(f.agent, { status: 'idle' })
    f.ctx.emit(scopeTarget(f.agent, f.agent), 'agent/status', { agent: f.agent, status: 'idle' })
    expect(f.coordinator.presentation.state(f.agent.id)).toMatchObject({ running: false })
    await f.call('canvas_generate', args)
    expect(generated).toHaveBeenCalledTimes(1)
  })
  it('blocks an unsent attributed task after takeover but admits manual tasks', async () => {
    const f = await fixture(), requestId = randomUUID()
    f.coordinator.ledger.pinSubmission(requestId, f.coordinator.control(f.canvasId))
    const get = vi.spyOn(f.service.store.db, 'get').mockResolvedValue({ request_id: requestId })
    const outbound = vi.fn(async () => ({ pending: Promise.resolve('sent') }))
    await f.coordinator.dispatch(randomUUID(), outbound)
    await f.coordinator.takeover(f.canvasId)
    await expect(f.coordinator.dispatch(randomUUID(), outbound)).rejects.toMatchObject({ code: 'AGENT_CONTROL_REVOKED' })
    expect(outbound).toHaveBeenCalledTimes(1)
    get.mockResolvedValue({ request_id: randomUUID() })
    await f.coordinator.dispatch(randomUUID(), outbound)
    expect(outbound).toHaveBeenCalledTimes(2)
  })
  it.each([['image-generation', 'image/gif'], ['tts-generation', 'image/png']] as const)('rejects %s / %s references before attempting a graph commit', async (kind, mime) => {
    const f = await fixture(), state = structuredClone(f.service.store.state(f.canvasId))
    const sourceId = randomUUID(), assetId = randomUUID(), targetId = randomUUID()
    const fields = { title: '参考', prompt: '', position: { x: 0, y: 0 }, modelId: null, params: null, selectedResultId: null }
    state.graph.nodes.push({ ...fields, id: sourceId, kind: 'image-asset', assetId }, { ...fields, id: targetId, kind, assetId: null })
    state.assets.push({ id: assetId, nodeId: sourceId, kind: 'image', mime, filename: '参考', bytes: 1, createdAt: 1 })
    vi.spyOn(f.service.store, 'state').mockReturnValue(state)
    const commit = vi.spyOn(f.service, 'mutateGraph')
    const result = await f.call('canvas_connect', { operationId: randomUUID(), revision: 0, source: sourceId, target: targetId, assetId })
    expect(result.isError).toBe(true)
    expect(commit).not.toHaveBeenCalled()
  })
})
