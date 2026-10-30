import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createScope, scopeTarget, scopeOf } from '@deepseek-ai/dsh-scope'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { UserQuestionService, type AskUserQuestionRequest, type AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { mkdtemp, readFile, stat, rm, writeFile, symlink, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { CanvasService } from '../src/host/service'
import { CanvasAgentCoordinator } from '../src/host/agent/coordinator'
import { apply as preset } from '../src/host/agent/preset'
import { fakeFactory, initialize } from './support/objectStorage'
import type { Agent } from '@deepseek-ai/dsh-agent'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
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
  ctx.reflect.provide('systemPrompt', { tools: () => () => {}, section: () => () => {}, context: () => () => {}, suppressRuntimeContext: () => () => {} })
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
  const call = (name: string, args: unknown, signal = new AbortController().signal) => registry.execute({ name, arguments: args, callId: ToolCallId(randomUUID()), agent, signal })
  const child = async () => {
    const childPreset = createScope(ctx, {}, { parent: scopeOf(ctx) })
    preset(childPreset.ctx, { role: 'assets' })
    const child = { id: `child-${randomUUID()}`, cancel: vi.fn(), options: agent.options } as unknown as Agent
    const childScope = createScope(childPreset.ctx, child, { parent: scopeOf(childPreset.ctx) })
    Object.assign(child, { ctx: childScope.ctx })
    parents.set(child.id, agent); agents.set(child.id, child); presets.set(child.ctx, 'canvas-assets')
    child.ctx.tools.register({ name: 'structured_output', description: 'SDK-owned capture fixture', parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'object' }, render: () => [] }, execute: async () => ({ captured: true }) })
    await ctx.serial(scopeTarget(child, child), 'agent/created', { agent: child, source: 'startup' })
    return child
  }
  return { ctx, dir, service, coordinator, agent, registry, call, child, canvasId: created.id, selectModel, resolveModelInfo, events, setCwd: (next: string) => { cwd = next } }
}
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
    expect(roster.presets).toHaveLength(8)
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
    expect(f.registry.schemas(f.agent).map((s) => s.name)).toContain('canvas_create_node')
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
  it('admits only two professional runs and retains receipts before accepting new work', async () => {
    const f = await fixture()
    let release!: () => void, started!: () => void
    const waiting = new Promise<void>((resolve) => { release = resolve })
    const active = new Promise<void>((resolve) => { started = resolve })
    let count = 0
    const run = async () => { if (++count === 2) started(); await waiting; return {} }
    const first = f.coordinator.specialist(f.agent, `${f.canvasId}:specialist:${randomUUID()}`, {}, run)
    const second = f.coordinator.specialist(f.agent, `${f.canvasId}:specialist:${randomUUID()}`, {}, run)
    await active
    await expect(f.coordinator.specialist(f.agent, `${f.canvasId}:specialist:${randomUUID()}`, {}, run)).rejects.toMatchObject({ code: 'SPECIALIST_CAPACITY' })
    release(); await Promise.all([first, second])
    expect(count).toBe(2)
  })
  it('isolates and replays a generated request identity without calling the service twice', async () => {
    const f = await fixture()
    const generated = vi.spyOn(f.service, 'generate').mockResolvedValue({ id: randomUUID(), status: 'queued' } as any)
    const args = { operationId: randomUUID(), revision: 0, nodeId: randomUUID() }
    const first = await f.call('canvas_generate', args)
    expect(first.isError).toBe(false)
    expect((await f.call('canvas_generate', args)).isError).toBe(false)
    expect(generated).toHaveBeenCalledTimes(1)
    const requestId = generated.mock.calls[0][3]!
    expect(requestId).not.toBe(args.operationId)
    expect(f.coordinator.ledger.submission(requestId)).toMatchObject({ canvasId: f.canvasId, sessionId: f.agent.id })
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
