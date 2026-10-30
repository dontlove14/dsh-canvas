import { randomUUID } from 'node:crypto'
import { readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { CreativeDraftSchema, type CanvasControl, type CreativeDraft } from '../../shared/agent'
import { CanvasError } from '../store'
import { hash } from '../persistence/database'
import { CanvasGraphSchema, type CanvasGraph } from '../../shared/contracts'

const ControlSchema = z.object({
  canvasId: z.string(), sessionId: z.string().nullable(), mode: z.enum(['manual', 'agent']),
  epoch: z.number().int().nonnegative(), updatedAt: z.number(), reason: z.string().optional(),
})
const FileSchema = z.object({
  version: z.literal(1), controls: z.record(z.string(), ControlSchema),
  drafts: z.array(CreativeDraftSchema.extend({
    id: z.string().uuid(), canvasId: z.string(), version: z.number().int().positive(),
    author: z.string(), createdAt: z.number(), baseRevision: z.number(), epoch: z.number(),
  })),
  receipts: z.record(z.string(), z.object({ hash: z.string(), value: z.unknown() })),
  submissions: z.record(z.string(), z.object({ canvasId: z.string(), sessionId: z.string(), epoch: z.number() })),
  handoffs: z.record(z.string(), z.object({ graphHash: z.string(), summary: z.string(), graph: CanvasGraphSchema.optional() })),
})
type LedgerFile = z.infer<typeof FileSchema>
/** Single host owner: the existing Store process lock also owns this atomic sidecar. */
export class AgentLedger {
  private data: LedgerFile = { version: 1, controls: {}, drafts: [], receipts: {}, submissions: {}, handoffs: {} }
  private saving: Promise<void> = Promise.resolve()
  private readonly path: string
  constructor(dataDir: string) { this.path = join(dataDir, 'agent-ledger.json') }
  async init() {
    try { this.data = FileSchema.parse(JSON.parse(await readFile(this.path, 'utf8'))) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new CanvasError('Agent 记录无法读取，请恢复备份', 503, 'AGENT_LEDGER_INVALID') }
    for (const entry of Object.values(this.data.controls)) if (entry.mode === 'agent') {
      entry.mode = 'manual'; entry.epoch++; entry.reason = '宿主重启，等待重新委托'; entry.updatedAt = Date.now()
    }
    await this.persist()
  }
  control(canvasId: string): CanvasControl {
    return structuredClone(this.data.controls[canvasId] ?? { canvasId, sessionId: null, mode: 'manual', epoch: 0, updatedAt: 0 })
  }
  controls() { return Object.values(this.data.controls).map((c) => structuredClone(c)) }
  setControl(control: CanvasControl) { this.data.controls[control.canvasId] = structuredClone(control) }
  drafts(canvasId: string) {
    const drafts = this.data.drafts.filter((d) => d.canvasId === canvasId)
    const superseded = new Set(drafts.filter((d) => drafts.some((n) => n.kind === d.kind && n.title === d.title && n.version > d.version)).map((d) => d.id))
    return drafts.map((d) => ({ ...structuredClone(d), needsReview: d.dependencies.some((id) => superseded.has(id)) }))
  }
  draft(input: z.infer<typeof CreativeDraftSchema>, control: CanvasControl, baseRevision: number, author: string, id: string = randomUUID()) {
    const existing = this.data.drafts.find((d) => d.id === id)
    if (existing) {
      const { kind, title, content, dependencies, assetIds } = existing
      if (existing.canvasId !== control.canvasId || hash({ kind, title, content, dependencies, assetIds }) !== hash(input)) throw new CanvasError('草稿 ID 已用于其他内容', 409, 'REQUEST_REUSED')
      return structuredClone(existing)
    }
    if (this.data.drafts.length >= 10000) throw new CanvasError('创作记录容量已满，请备份后整理', 409, 'AGENT_LEDGER_FULL')
    for (const id of input.dependencies) if (!this.data.drafts.some((d) => d.id === id && d.canvasId === control.canvasId)) throw new CanvasError('草稿依赖不存在')
    const version = 1 + this.data.drafts.filter((d) => d.canvasId === control.canvasId && d.kind === input.kind && d.title === input.title).length
    const draft: CreativeDraft = { ...input, id, canvasId: control.canvasId, version, author, createdAt: Date.now(), baseRevision, epoch: control.epoch }
    this.data.drafts.push(draft); return draft
  }
  receipt(key: string, input: unknown): { value: unknown } | undefined {
    const receipt = this.data.receipts[key]
    if (!receipt) return
    if (receipt.hash !== hash(input)) throw new CanvasError('操作 ID 已用于其他内容', 409, 'REQUEST_REUSED')
    return { value: structuredClone(receipt.value) }
  }
  remember(key: string, input: unknown, value: unknown) {
    this.reserveReceipts([key])
    this.data.receipts[key] = { hash: hash(input), value: structuredClone(value) }
  }
  reserveReceipts(keys: string[]) {
    if (Object.keys(this.data.receipts).length + new Set(keys.filter((key) => !Object.hasOwn(this.data.receipts, key))).size > 20000)
      throw new CanvasError('Agent 操作记录容量已满', 409, 'AGENT_LEDGER_FULL')
  }
  submission(requestId: string) { return this.data.submissions[requestId] }
  pinSubmission(requestId: string, control: CanvasControl) {
    this.data.submissions[requestId] = { canvasId: control.canvasId, sessionId: control.sessionId!, epoch: control.epoch }
  }
  handoff(canvasId: string) { return this.data.handoffs[canvasId] }
  setHandoff(canvasId: string, graphHash: string, summary: string, graph?: CanvasGraph) { this.data.handoffs[canvasId] = { graphHash, summary, graph: graph ? structuredClone(graph) : undefined } }
  persist(): Promise<void> {
    const contents = JSON.stringify(this.data)
    const work = this.saving.then(async () => {
      const temp = `${this.path}.${randomUUID()}.tmp`
      await writeFile(temp, contents, { mode: 0o600 })
      await rename(temp, this.path)
    })
    this.saving = work.catch(() => {})
    return work
  }
}
