import { readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { PresentationIntentSchema, type PresentationIntent, type PresentationAck, type ViewReport, type PresentationResult, type AutoPlacement } from '../../shared/presentation'
import { initialNodeSize, placeAgentNode } from '../../shared/agentLayout'
import type { CanvasControl } from '../../shared/agent'
import type { CanvasNode, CanvasGraph } from '../../shared/contracts'
import { CanvasError } from '../store'

const FileSchema = z.object({ version: z.literal(1), canvases: z.record(z.string(), z.object({
  intent: PresentationIntentSchema, origin: z.object({ x: z.number().finite(), y: z.number().finite() }).optional(),
})) })
/** Independent sidecar: rendering metadata never becomes CanvasGraph or a task identity. */
export class AgentPresentation {
  closed = false
  private data: z.infer<typeof FileSchema> = { version: 1, canvases: {} }
  private saving: Promise<void> = Promise.resolve()
  private views = new Map<string, ViewReport & { receivedAt: number }>()
  private presence = new Map<string, { sessionId: string; visible: boolean; receivedAt: number }>()
  private acks = new Map<string, PresentationAck>()
  private listeners = new Set<() => void>()
  private readonly path: string
  constructor(dataDir: string, private control: (canvasId: string) => CanvasControl) { this.path = join(dataDir, 'agent-presentation.json') }
  async init() {
    try { this.data = FileSchema.parse(JSON.parse(await readFile(this.path, 'utf8'))) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new CanvasError('画布呈现记录无法读取', 503, 'PRESENTATION_INVALID') }
  }
  private valid(value: { canvasId: string; sessionId: string; epoch: number }) {
    const control = this.control(value.canvasId)
    return control.mode === 'agent' && control.sessionId === value.sessionId && control.epoch === value.epoch
  }
  state(sessionId: string) {
    const intent = Object.values(this.data.canvases).map((entry) => entry.intent)
      .filter((entry) => entry.sessionId === sessionId && this.valid(entry)).sort((a, b) => b.createdAt - a.createdAt)[0]
    return { intent: intent ?? null }
  }
  current(canvasId: string) {
    const intent = this.data.canvases[canvasId]?.intent
    return intent && this.valid(intent) ? intent : undefined
  }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  changed() { for (const listener of this.listeners) listener() }
  close() { this.closed = true; this.changed(); this.listeners.clear() }
  reportPresence(viewId: string, sessionId: string, visible: boolean) {
    this.presence.set(viewId, { sessionId, visible, receivedAt: Date.now() }); this.prune(); this.changed()
  }
  report(view: ViewReport) {
    if (!this.valid(view)) throw new CanvasError('呈现身份已失效', 409, 'PRESENTATION_STALE')
    const previous = this.views.get(view.viewId)
    if (previous && previous.sequence >= view.sequence) return
    this.views.set(view.viewId, { ...view, receivedAt: Date.now() }); this.prune(); this.changed()
  }
  ack(value: PresentationAck) {
    const current = this.current(value.canvasId), view = this.views.get(value.viewId)
    if (!this.valid(value) || current?.id !== value.presentationId || !view || view.sessionId !== value.sessionId || view.canvasId !== value.canvasId || view.epoch !== value.epoch)
      throw new CanvasError('呈现回执已失效', 409, 'PRESENTATION_STALE')
    if (value.status === 'presented' && (!view.visible || !view.following || Date.now() - view.receivedAt > 5000 || value.graphRevision < current.graphRevision))
      throw new CanvasError('画布尚未呈现对应版本', 409, 'PRESENTATION_NOT_READY')
    this.acks.set(`${current.id}:${value.viewId}`, value); this.changed()
  }
  private prune() {
    for (const [id, view] of this.views) if (Date.now() - view.receivedAt > 30000) this.views.delete(id)
    for (const [id, view] of this.presence) if (Date.now() - view.receivedAt > 30000) this.presence.delete(id)
    if (this.acks.size > 500) this.acks.clear()
  }
  view(control: CanvasControl) {
    return [...this.views.values()].filter((view) => view.canvasId === control.canvasId && view.sessionId === control.sessionId && view.epoch === control.epoch && view.visible && Date.now() - view.receivedAt < 5000)
      .sort((a, b) => b.receivedAt - a.receivedAt)[0]
  }
  private foreground(sessionId: string) { return [...this.presence.values()].some((view) => view.sessionId === sessionId && view.visible && Date.now() - view.receivedAt < 5000) }
  async publish(control: CanvasControl, id: string, action: PresentationIntent['action'], graphRevision: number, nodeIds: string[], taskId?: string) {
    if (!control.sessionId || !this.valid({ ...control, sessionId: control.sessionId })) throw new CanvasError('画布控制已失效', 409, 'PRESENTATION_STALE')
    const previous = this.data.canvases[control.canvasId]
    if (previous?.intent.id === `${control.epoch}:${id}`) return previous.intent
    const latest = Math.max(0, ...Object.values(this.data.canvases).map((entry) => entry.intent.createdAt))
    const intent: PresentationIntent = { id: `${control.epoch}:${id}`, sessionId: control.sessionId, canvasId: control.canvasId, epoch: control.epoch, action, graphRevision, nodeIds,
      ...(taskId ? { taskId } : {}), createdAt: Math.max(Date.now(), latest + 1) }
    this.data.canvases[control.canvasId] = { intent, origin: previous?.intent.epoch === control.epoch ? previous.origin : undefined }
    await this.persist(); this.changed(); return intent
  }
  /** Always called outside the graph commit queue so takeover can revoke immediately. */
  async wait(intent: PresentationIntent, signal: AbortSignal): Promise<PresentationResult> {
    const deadline = Date.now() + 8000
    for (;;) {
      signal.throwIfAborted()
      if (this.closed) return { id: intent.id, status: 'deferred', reason: '宿主正在关闭，稍后重新委托' }
      if (!this.valid(intent)) throw new CanvasError('画布已由人工接管', 409, 'AGENT_CONTROL_REVOKED')
      if (this.current(intent.canvasId)?.id !== intent.id) return { id: intent.id, status: 'deferred', reason: '已由更新的操作替代' }
      const view = this.view(this.control(intent.canvasId))
      const ack = view && this.acks.get(`${intent.id}:${view.viewId}`)
      if (ack) return { id: intent.id, status: ack.status, reason: ack.reason }
      if (view && !view.following) return { id: intent.id, status: 'paused', reason: '用户正在自主浏览' }
      if (!this.foreground(intent.sessionId)) return { id: intent.id, status: 'deferred', reason: '当前会话无可见窗口' }
      if (Date.now() >= deadline) return { id: intent.id, status: 'deferred', reason: '等待窗口载入，返回时补呈现' }
      await this.wake(signal, Math.min(500, deadline - Date.now()))
    }
  }
  private wake(signal: AbortSignal, timeout: number) {
    return new Promise<void>((resolve) => {
      const finish = () => { clearTimeout(timer); this.listeners.delete(finish); signal.removeEventListener('abort', finish); resolve() }
      const timer = setTimeout(finish, timeout)
      this.listeners.add(finish); signal.addEventListener('abort', finish, { once: true })
    })
  }
  async position(control: CanvasControl, graph: CanvasGraph, kind: CanvasNode['kind'], placement: AutoPlacement, signal: AbortSignal) {
    let view = this.view(control)
    const deadline = Date.now() + 8000
    while (!this.closed && !graph.nodes.length && !view?.center && this.foreground(control.sessionId!) && Date.now() < deadline) {
      signal.throwIfAborted()
      if (this.control(control.canvasId).epoch !== control.epoch) throw new CanvasError('画布已由人工接管', 409, 'AGENT_CONTROL_REVOKED')
      await this.wake(signal, 300); view = this.view(control)
    }
    const size = initialNodeSize(kind), entry = this.data.canvases[control.canvasId]
    const source = entry?.origin ? 'fixed-origin' : graph.nodes.length ? 'existing-node' : view?.center ? 'visible-viewport' : 'saved-viewport'
    const origin = entry?.origin ?? graph.nodes[0]?.position ?? (view?.center
      ? { x: view.center.x - size.width / 2, y: view.center.y - size.height / 2 }
      : { x: -graph.viewport.x / graph.viewport.zoom + 160, y: -graph.viewport.y / graph.viewport.zoom + 90 })
    if (entry && !entry.origin) { entry.origin = origin; await this.persist() }
    return { position: placeAgentNode(graph.nodes, size, origin, placement, view?.sizes), source }
  }
  persist() {
    const contents = JSON.stringify(this.data)
    const work = this.saving.then(async () => {
      const temp = `${this.path}.${randomUUID()}.tmp`
      await writeFile(temp, contents, { mode: 0o600 }); await rename(temp, this.path)
    })
    this.saving = work.catch(() => {}); return work
  }
}
