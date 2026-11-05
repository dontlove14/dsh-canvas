import { randomUUID } from 'node:crypto'
import { readFile, writeFile, rename, mkdir, lstat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { CollaborationTask, CollaborationEvent, CollaborationPage } from '../../shared/collaboration'
import type { CreativeProjects } from './creative'
import { CanvasError } from '../store'
import { z } from 'zod'

interface RecordEntry { task: CollaborationTask; events: CollaborationEvent[]; seen: Record<string, number> }
interface State { version: 1; revision: number; records: RecordEntry[] }
const MAX_EVENTS = 500
const MAX_BYTES = 64 * 1024 * 1024
const Reference = z.object({ id: z.string(), title: z.string(), version: z.number().optional() })
const TaskSchema = z.object({
  id: z.string(), rootId: z.string(), projectId: z.string(), canvasId: z.string().optional(), parentCallId: z.string(), childId: z.string(),
  nativeRunId: z.string().optional(), role: z.string(), title: z.string(), task: z.string().max(24000),
  createdAt: z.number(), updatedAt: z.number(), revision: z.number().int().nonnegative(),
  state: z.enum(['dispatched', 'running', 'completed', 'blocked', 'interrupted']), main: z.enum(['pending', 'responded']),
  sourceRefs: z.array(Reference), inputRefs: z.array(Reference), nodeIds: z.array(z.string()),
  artifactRefs: z.array(Reference.extend({ kind: z.string(), status: z.enum(['draft', 'approved', 'rejected']), needsReview: z.boolean(), relativePath: z.string() })),
  commandCount: z.number(), receiptIds: z.array(z.string()), progress: z.string().optional(), eventCount: z.number(), droppedEvents: z.number(),
})
const StateSchema = z.object({ version: z.literal(1), revision: z.number().int().nonnegative(), records: z.array(z.object({
  task: TaskSchema, events: z.array(z.object({
    seq: z.number().int().positive(), time: z.number(), actor: z.enum(['host', 'child', 'main']),
    kind: z.enum(['dispatch', 'started', 'message', 'tool-call', 'tool-result', 'receipt', 'returned', 'next', 'interrupted']),
    text: z.string().max(4000), callId: z.string().optional(), tool: z.string().optional(), data: z.unknown().optional(),
  })).max(MAX_EVENTS), seen: z.record(z.string(), z.number().int()),
})).max(10000) })
const allowedKeys = new Set(['operationId', 'canvasId', 'revision', 'nodeId', 'source', 'target', 'assetId', 'sourceId',
  'artifactId', 'artifactOutputIds', 'taskId', 'title', 'kind', 'role', 'note', 'start', 'end', 'next', 'version',
  'state', 'status', 'completed', 'stopReason', 'summary', 'progress', 'citation', 'sources', 'dependencies',
  'nodeIds', 'assetIds', 'sourceIds', 'artifactIds', 'resultIds', 'referenceReady', 'offsetUnit', 'totalLength',
  'relativePath', 'tool', 'receipt', 'receipts', 'file', 'stale', 'needsReview'])
/** Public, bounded projection. Never copy raw source pages, headers, prompts, images or provider replay. */
export function collaborationText(text: string, limit = 4000) {
  return text.replace(/https?:\/\/[^\s"'<>]+/gi, '[链接省略]')
    .replace(/\b(?:Bearer\s+|sk-)[\w.+/-]+/gi, '[凭据省略]')
    .replace(/((?:api[_-]?key|authorization|password|secret|token)\s*[:=]\s*)[^\s,;"'}]+/gi, '$1[凭据省略]')
    .slice(0, limit)
}
export function publicCollaborationData(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[展开深度已限]'
  if (typeof value === 'string') return collaborationText(value, 1000)
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => publicCollaborationData(item, depth + 1))
  if (!value || typeof value !== 'object') return undefined
  return Object.fromEntries(Object.entries(value).filter(([key]) => allowedKeys.has(key))
    .map(([key, item]) => [key, publicCollaborationData(item, depth + 1)]))
}
function toolData(text: string) {
  try {
    const data = publicCollaborationData(JSON.parse(text)), serialized = JSON.stringify(data)
    return serialized && serialized.length > 8000 ? { summary: serialized.slice(0, 8000), truncated: true } : data
  } catch { return { summary: collaborationText(text, 1000) } }
}
/** Read-only activity journal beside creative-projects; independent of graph and execution admissions. */
export class AgentCollaboration {
  private state: State = { version: 1, revision: 0, records: [] }
  private saving: Promise<void> = Promise.resolve()
  private timer?: ReturnType<typeof setTimeout>
  private listeners = new Set<() => void>()
  private error?: string
  private dirty = true
  closed = false
  private path: string
  constructor(dataDir: string, private creative: CreativeProjects) { this.path = join(dataDir, 'agent-collaboration.json') }
  async init() {
    try {
      const stat = await lstat(this.path)
      if (stat.isSymbolicLink() || stat.size > MAX_BYTES) throw new Error('Invalid journal')
      const state = StateSchema.parse(JSON.parse(await readFile(this.path, 'utf8')))
      this.state = state
      for (const entry of state.records) if (['dispatched', 'running'].includes(entry.task.state)) {
        entry.task.state = 'interrupted'
        this.append(entry, 'host', 'interrupted', '宿主已重启，已保存过程与回执保留；任务未自动重提')
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.error = '协作记录无法读取，原文件保留；请恢复备份'; return
      }
    }
    await this.persist()
  }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private notify() { for (const listener of this.listeners) { try { listener() } catch { /* Observers cannot affect execution. */ } } }
  private changed(entry: RecordEntry) {
    this.dirty = true
    entry.task.updatedAt = Date.now(); entry.task.revision = ++this.state.revision
    this.notify()
    if (!this.timer && !this.closed) this.timer = setTimeout(() => {
      this.timer = undefined; void this.persist()
    }, 100)
  }
  private append(entry: RecordEntry, actor: CollaborationEvent['actor'], kind: CollaborationEvent['kind'], text: string, extras: Partial<CollaborationEvent> = {}) {
    entry.events.push({ seq: ++entry.task.eventCount, time: Date.now(), actor, kind, text: collaborationText(text), ...extras,
      ...(extras.data === undefined ? {} : { data: toolData(JSON.stringify(extras.data)) }) })
    if (entry.events.length > MAX_EVENTS) { entry.events.shift(); entry.task.droppedEvents++ }
    this.changed(entry)
  }
  dispatch(input: Omit<CollaborationTask, 'createdAt' | 'updatedAt' | 'revision' | 'state' | 'main' | 'artifactRefs' | 'receiptIds' | 'eventCount' | 'droppedEvents' | 'activity'>) {
    if (this.error || this.closed) return
    const old = this.state.records.find((r) => r.task.id === input.id)
    if (old) return
    if (this.state.records.length >= 10000) { this.error = '协作记录容量已满，已有记录保留'; this.notify(); return }
    for (const entry of this.state.records.filter((r) => r.task.rootId === input.rootId && r.task.main === 'pending' &&
      !['running', 'dispatched'].includes(r.task.state))) {
      entry.task.main = 'responded'; this.append(entry, 'main', 'next', `主 Agent 派发下一批次：${input.title}`, { data: { taskId: input.id } })
    }
    const entry: RecordEntry = { task: { ...structuredClone(input), title: collaborationText(input.title, 180), task: collaborationText(input.task, 24000),
      createdAt: Date.now(), updatedAt: Date.now(), revision: 0, state: 'dispatched', main: 'pending',
      artifactRefs: [], receiptIds: [], eventCount: 0, droppedEvents: 0 }, events: [], seen: {} }
    this.state.records.push(entry); this.append(entry, 'main', 'dispatch', input.task)
  }
  observe(sessionId: string, event: SessionEvent) {
    if (this.error || this.closed) return
    const child = this.state.records.find((r) => r.task.childId === sessionId)
    const entries = child ? [child] : this.state.records.filter((r) => r.task.rootId === sessionId &&
      !['running', 'dispatched'].includes(r.task.state) && r.task.main === 'pending')
    for (const entry of entries) {
      if ((entry.seen[sessionId] ?? -1) >= event.seq) continue
      entry.seen[sessionId] = event.seq
      if (child && event.type === 'step/start') {
        if (entry.task.state === 'dispatched') { entry.task.state = 'running'; this.append(entry, 'host', 'started', '子 Agent 已开始执行') }
      } else if (event.type === 'assistant/message') {
        const text = event.data.message.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n')
        if (text.trim()) {
          if (!child) entry.task.main = 'responded'
          this.append(entry, child ? 'child' : 'main', 'message', text)
        }
      } else if (event.type === 'tool/call' && (child || /^(creative_|canvas_)/.test(event.data.name))) {
        this.append(entry, child ? 'child' : 'main', 'tool-call', `调用 ${event.data.name}`, { tool: event.data.name, callId: event.data.callId, data: toolData(event.data.arguments) })
      } else if (event.type === 'tool/result' && (child || entry.events.some((e) => e.actor === 'main' && e.callId === event.data.message.toolCallId))) {
        const message = event.data.message
        const text = message.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n')
        this.append(entry, child ? 'host' : 'main', 'tool-result', message.isError ? '工具返回错误' : '工具已返回', {
          callId: message.toolCallId, data: toolData(text),
        })
      }
    }
  }
  started(childId: string, nativeRunId: string) {
    const entry = this.state.records.find((r) => r.task.childId === childId)
    if (!entry || this.error || this.closed) return
    entry.task.nativeRunId = nativeRunId
    if (entry.task.state === 'dispatched') { entry.task.state = 'running'; this.append(entry, 'host', 'started', '子 Agent 已启动') }
    else this.changed(entry)
  }
  receipt(childId: string, operationId: string, tool: string, result: unknown) {
    const entry = this.state.records.find((r) => r.task.childId === childId)
    if (!entry || this.error || this.closed || entry.task.receiptIds.includes(operationId)) return
    entry.task.receiptIds.push(operationId)
    const nodeId = (result as { nodeId?: string })?.nodeId
    if (nodeId && !entry.task.nodeIds.includes(nodeId)) entry.task.nodeIds.push(nodeId)
    this.append(entry, 'host', 'receipt', `宿主确认 ${tool} 的实际回执`, { tool, data: publicCollaborationData({ operationId, receipt: result }) })
  }
  returned(id: string, state: CollaborationTask['state'], text: string) {
    const entry = this.state.records.find((r) => r.task.id === id)
    if (!entry || this.error || this.closed) return
    entry.task.state = state; this.append(entry, 'host', 'returned', text); this.refresh()
  }
  refresh() {
    if (this.error || this.closed) return
    try { for (const entry of this.state.records) {
      const run = this.creative.run(entry.task.projectId, entry.task.id)
      if (!run) continue
      const refs = run.artifactOutputIds.map((id) => {
        const a = this.creative.artifact(entry.task.projectId, id)
        return { id, title: collaborationText(a.draft.title, 180), kind: a.draft.kind, version: a.version, status: a.status, needsReview: a.needsReview, relativePath: a.file.relativePath }
      })
      if (JSON.stringify(refs) !== JSON.stringify(entry.task.artifactRefs) || entry.task.progress !== run.progress) {
        entry.task.artifactRefs = refs; entry.task.progress = collaborationText(run.progress, 1000); this.changed(entry)
      }
    } } catch { this.error = '协作成果索引无法读取；创作成果仍由项目资料保存'; this.notify() }
  }
  page(rootId: string, cursor = 0, limit = 30, canvasId?: string): CollaborationPage {
    const entries = this.state.records.filter((r) => r.task.rootId === rootId && (!canvasId || r.task.canvasId === canvasId)).slice().reverse()
    const active = entries.filter((r) => ['running', 'dispatched'].includes(r.task.state))
    return { revision: this.state.revision, tasks: entries.slice(cursor, cursor + limit).map((r) => this.project(r)),
      next: cursor + limit < entries.length ? cursor + limit : null, total: entries.length,
      active: active.length, ...(cursor === 0 ? { activeTasks: active.slice(0, 100).map((r) => this.project(r)) } : {}),
      ...(this.error ? { error: this.error } : {}) }
  }
  private project(entry: RecordEntry): CollaborationTask {
    const task = structuredClone(entry.task), event = entry.events.at(-1)
    if (event) {
      // Explicit allowlist: tool input/results, call IDs and hidden content never enter the bubble.
      const tool = event.tool ?? (event.callId ? [...entry.events].reverse().find((e) => e.callId === event.callId && e.kind === 'tool-call')?.tool : undefined)
      task.activity = { seq: event.seq, time: event.time, actor: event.actor, kind: event.kind,
        text: collaborationText(event.text, 360), ...(tool ? { tool: collaborationText(tool, 100) } : {}) }
    }
    return task
  }
  private entry(rootId: string, id: string) {
    const entry = this.state.records.find((r) => r.task.rootId === rootId && r.task.id === id)
    if (!entry) throw new CanvasError('当前会话没有这条协作记录', 404, 'COLLABORATION_NOT_FOUND')
    return entry
  }
  task(rootId: string, id: string) { return this.project(this.entry(rootId, id)) }
  detail(rootId: string, id: string, before?: number, limit = 50) {
    const entry = this.entry(rootId, id), events = entry.events.filter((e) => before === undefined || e.seq < before)
    const page = events.slice(-limit)
    return { task: this.project(entry), events: structuredClone(page), next: events.length > limit ? page[0].seq : null }
  }
  artifact(rootId: string, id: string, artifactId: string) {
    const entry = this.entry(rootId, id)
    if (!entry.task.artifactRefs.some((a) => a.id === artifactId)) throw new CanvasError('成果不属于本协作任务', 404)
    const artifact = this.creative.artifact(entry.task.projectId, artifactId)
    return { title: artifact.draft.title, content: collaborationText(artifact.draft.content, 200000), version: artifact.version,
      status: artifact.status, needsReview: artifact.needsReview, relativePath: artifact.file.relativePath }
  }
  persist(): Promise<void> {
    clearTimeout(this.timer); this.timer = undefined
    if (this.error || !this.dirty) return this.saving
    const contents = JSON.stringify(this.state)
    if (Buffer.byteLength(contents) > MAX_BYTES) { this.error = '协作记录达到 64 MiB 上限；已保存历史保留，请归档后继续记录'; this.notify(); return this.saving }
    this.dirty = false
    const work = this.saving.then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
      const temp = `${this.path}.${randomUUID()}.tmp`
      await writeFile(temp, contents, { mode: 0o600 }); await rename(temp, this.path)
    }).catch(() => { this.error = '协作记录保存失败，当前执行回执仍由宿主保留'; this.notify() })
    this.saving = work; return work
  }
  async close() { this.closed = true; await this.persist(); this.notify(); this.listeners.clear() }
}
