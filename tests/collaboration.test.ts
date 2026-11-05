import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AgentCollaboration, publicCollaborationData } from '../src/host/agent/collaboration'
import { CreativeProjects } from '../src/host/agent/creative'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'dc-collaboration-'))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  const creative = new CreativeProjects(dir); await creative.init()
  const journal = new AgentCollaboration(dir, creative); await journal.init()
  cleanup.push(() => journal.close())
  const rootId = 'main', childId = 'reserved-child', id = randomUUID()
  const project = creative.project(rootId, dir)
  const task = { id, rootId, childId, projectId: project.id, parentCallId: 'dispatch-call', role: 'story', title: '分集拆解',
    task: '先阅读授权章节，再保存分集方案', sourceRefs: [], inputRefs: [], nodeIds: [], commandCount: 2 }
  return { dir, creative, journal, task }
}
function event(seq: number, type: string, data: unknown) { return { seq, time: seq, type, data } as any }
it('captures the first reserved child step and public message, deduplicates sequence and excludes reasoning/source/system content', async () => {
  const { journal, task, dir } = await fixture()
  journal.dispatch(task); await journal.persist()
  journal.observe(task.childId, event(0, 'system/message', { message: { content: [{ type: 'text', text: 'private system' }] } }))
  journal.observe(task.childId, event(1, 'step/start', { turn: 1, step: 1 }))
  const message = event(2, 'assistant/message', { message: { content: [{ type: 'reasoning', text: 'private chain' }, { type: 'text', text: '正在整理角色' }] } })
  journal.observe(task.childId, message); journal.observe(task.childId, message)
  journal.observe('unrelated-child', message)
  journal.observe(task.childId, event(3, 'tool/call', { name: 'creative_source_read', callId: 'read', arguments: '{"sourceId":"source","start":0,"apiKey":"private-key"}' }))
  journal.observe(task.childId, event(4, 'tool/result', { message: { toolCallId: 'read', content: [{ type: 'text', text: '{"text":"private source body","start":0,"end":10}' }] } }))
  const detail = journal.detail(task.rootId, task.id)
  expect(detail.task.state).toBe('running')
  expect(detail.events.filter((e) => e.kind === 'message')).toHaveLength(1)
  expect(detail.events.find((e) => e.kind === 'tool-result')?.callId).toBe('read')
  await journal.persist()
  const saved = await readFile(join(dir, 'agent-collaboration.json'), 'utf8')
  for (const privateText of ['private system', 'private chain', 'private source body', 'private-key']) expect(saved).not.toContain(privateText)
})
it('counts host receipts once, keeps claimed progress separate and isolates roots and artifact lookups', async () => {
  const { journal, task } = await fixture()
  journal.dispatch(task)
  journal.observe(task.childId, event(1, 'assistant/message', { message: { content: [{ type: 'text', text: '所有节点已完成' }] } }))
  expect(journal.task(task.rootId, task.id).receiptIds).toEqual([])
  journal.receipt(task.childId, 'operation', 'canvas_create_node', { nodeId: 'node', apiKey: 'secret', url: 'https://secret' })
  journal.receipt(task.childId, 'operation', 'canvas_create_node', { nodeId: 'node' })
  expect(journal.task(task.rootId, task.id)).toMatchObject({ receiptIds: ['operation'], nodeIds: ['node'], main: 'pending' })
  expect(journal.page('other-root').tasks).toEqual([])
  expect(() => journal.detail('other-root', task.id)).toThrow('当前会话没有')
  expect(() => journal.artifact(task.rootId, task.id, 'arbitrary-artifact')).toThrow('成果不属于')
  journal.returned(task.id, 'blocked', '缺少回执')
  journal.observe(task.rootId, event(10, 'assistant/message', { message: { content: [{ type: 'text', text: '先核对缺失的第二步' }] } }))
  expect(journal.task(task.rootId, task.id).main).toBe('responded')
  expect(journal.task(task.rootId, task.id).state).toBe('blocked')
})
it('restores interrupted history without dispatching again, preserves receipts, bounds retained events and pages newest backwards', async () => {
  const { journal, creative, task, dir } = await fixture()
  journal.dispatch(task); journal.receipt(task.childId, 'op', 'canvas_create_node', { nodeId: 'node' })
  for (let seq = 0; seq < 520; seq++) journal.observe(task.childId, event(seq, 'tool/call', { callId: `call-${seq}`, name: 'canvas_state', arguments: '{}' }))
  await journal.persist()
  const restored = new AgentCollaboration(dir, creative); await restored.init(); cleanup.push(() => restored.close())
  expect(restored.task(task.rootId, task.id)).toMatchObject({ state: 'interrupted', receiptIds: ['op'], droppedEvents: 23 })
  const latest = restored.detail(task.rootId, task.id, undefined, 50)
  const older = restored.detail(task.rootId, task.id, latest.next!, 50)
  expect(older.events.at(-1)!.seq).toBeLessThan(latest.events[0].seq)
  expect(new Set([...older.events, ...latest.events].map((e) => e.seq)).size).toBe(100)
  expect(restored.page(task.rootId).total).toBe(1)
})
it('tracks saved artifact versions and human decisions without treating return as approval', async () => {
  const { journal, creative, task } = await fixture()
  creative.begin(task.projectId, task.id, 'story', {}, task.task, [], [])
  journal.dispatch(task)
  creative.saveArtifact({ id: randomUUID(), taskId: task.id, projectId: task.projectId, version: 1, author: task.childId, createdAt: 1, status: 'draft',
    draft: { kind: 'brief', title: '分集方案', content: '持久正文', dependencies: [], assetIds: [] }, sources: [], file: { path: '/private/root/draft.md', relativePath: 'draft.md', sha256: 'hash', bytes: 10 } })
  journal.refresh(); journal.returned(task.id, 'completed', '专业结果回传')
  const artifact = journal.task(task.rootId, task.id).artifactRefs[0]
  expect(artifact).toMatchObject({ version: 1, status: 'draft' })
  expect(journal.artifact(task.rootId, task.id, artifact.id)).toMatchObject({ content: '持久正文', relativePath: 'draft.md' })
  expect(JSON.stringify(journal.detail(task.rootId, task.id))).not.toContain('/private/root')
  creative.decide(task.projectId, artifact.id, 'approved', '用户已确认')
  journal.refresh()
  expect(journal.task(task.rootId, task.id).artifactRefs[0].status).toBe('approved')
})
it('preserves corrupt journal and exposes recording failure without altering authoritative creative state', async () => {
  const { journal, creative, task, dir } = await fixture()
  await journal.close()
  await writeFile(join(dir, 'agent-collaboration.json'), 'corrupt-private-data')
  const bad = new AgentCollaboration(dir, creative); await bad.init(); cleanup.push(() => bad.close())
  bad.dispatch(task); await bad.persist()
  expect(bad.page(task.rootId).error).toContain('无法读取')
  expect(await readFile(join(dir, 'agent-collaboration.json'), 'utf8')).toBe('corrupt-private-data')
})
it('projects only allowed structured fields and bounds nested tool input', () => {
  expect(publicCollaborationData({ apiKey: 'secret', text: 'full source', prompt: 'system', sourceId: 'source', summary: 'Bearer credential-value https://example?token=secret' }))
    .toEqual({ sourceId: 'source', summary: '[凭据省略] [链接省略]' })
})
it('projects a bounded latest public activity without tool data, reasoning, credentials or a persisted task field', async () => {
  const { journal, task, dir } = await fixture()
  journal.dispatch(task)
  journal.observe(task.childId, event(1, 'tool/call', { name: 'creative_source_read', callId: 'read', arguments: '{"sourceId":"source","secret":"private-key"}' }))
  journal.observe(task.childId, event(2, 'tool/result', { message: { toolCallId: 'read', content: [{ type: 'text', text: '{"text":"private source body","start":0}' }] } }))
  expect(journal.task(task.rootId, task.id).activity).toEqual({ seq: 3, time: expect.any(Number), actor: 'host', kind: 'tool-result', text: '工具已返回', tool: 'creative_source_read' })
  journal.observe(task.childId, event(3, 'assistant/message', { message: { content: [{ type: 'reasoning', text: 'private reasoning' },
    { type: 'text', text: '公开 Bearer private-key https://private.example ' + '进度'.repeat(500) }] } }))
  const activity = journal.page(task.rootId).tasks[0].activity!
  expect(activity.text.length).toBeLessThanOrEqual(360)
  expect(activity.text).toContain('[凭据省略]')
  expect(Object.keys(activity).sort()).toEqual(['actor', 'kind', 'seq', 'text', 'time'])
  expect(JSON.stringify(activity)).not.toMatch(/private-key|private source|private reasoning|https:/)
  await journal.persist()
  const state = JSON.parse(await readFile(join(dir, 'agent-collaboration.json'), 'utf8'))
  expect(state.version).toBe(1)
  expect(state.records[0].task).not.toHaveProperty('activity')
})
it('includes bounded active batches beyond the newest page without changing history cursor or root scope', async () => {
  const { journal, task } = await fixture()
  journal.dispatch(task)
  for (let index = 0; index < 35; index++) {
    const id = randomUUID()
    journal.dispatch({ ...task, id, childId: `child-${index}` }); journal.returned(id, 'completed', '完成')
  }
  const page = journal.page(task.rootId)
  expect(page.tasks).toHaveLength(30); expect(page.next).toBe(30); expect(page.active).toBe(1)
  expect(page.activeTasks?.map((t) => t.id)).toEqual([task.id])
  expect(journal.page(task.rootId, 30)).not.toHaveProperty('activeTasks')
  expect(journal.page('other').activeTasks).toEqual([])
})
