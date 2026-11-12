import type { CanvasApi } from './api'
import { PresentationIntentSchema, type PresentationIntent, type PresentationState } from '../shared/presentation'
import type { SessionFace, SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import { isGenerationHandoff, type CanvasControl } from '../shared/agent'
import { ExecutorCursors } from './executorCursors'

type ConversationSnapshot = Pick<SessionSnapshot, 'sessionId' | 'running' | 'pendingSubmissions' | 'removed' | 'openState' | 'promptError'>
export interface CanvasConversation {
  getSnapshot: () => ConversationSnapshot
  subscribe: (listener: () => void) => () => void
  prompt?: SessionFace['prompt']
  beginSubmission?: SessionFace['beginSubmission']
}
interface ManualSeat {
  control: CanvasControl; active: boolean
  resume: (valid: () => boolean, source?: 'user-message') => Promise<void>
  report: (error: unknown) => void
}

export interface CanvasViewSeat {
  sessionId?: string; canvasId?: string; visible: boolean; loaded: boolean
  prepare: () => Promise<unknown>
  navigate?: (canvasId: string) => void
}
/** Plugin-root observer; neither the model picker nor a canvas tab owns navigation. */
export class CanvasPresentationClient {
  readonly cursors = new ExecutorCursors()
  private intent: PresentationIntent | null = null
  private running = false
  private listeners = new Set<() => void>()
  private seats = new Map<string, CanvasViewSeat>()
  private viewListeners = new Set<() => void>()
  private paused = new Set<string>()
  private automatic = new Set<string>()
  private seen = new Set<string>()
  private lastAttempt = 0
  private disposed = false
  private conversation: ConversationSnapshot | null = null
  private pendingReply = false
  private resumeSession?: string
  private admissionTimer?: ReturnType<typeof setTimeout>
  private idleTimer?: ReturnType<typeof setTimeout>
  private interactions = new Set<string>()
  private manualSeats = new Map<string, ManualSeat>()
  private activityVersion = 0
  private restoring?: Promise<void>
  activate() { this.disposed = false }
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  readonly getSnapshot = () => this.intent
  readonly getRunningSnapshot = () => this.running
  private manualSeat() {
    return [...this.manualSeats.values()].find((seat) => seat.active && seat.control.mode === 'manual' &&
      seat.control.sessionId === this.conversation?.sessionId)
  }
  manualSeatFor(id: string, seat: ManualSeat) {
    this.manualSeats.set(id, seat)
    // An explicit takeover is also a manual interaction; it may precede the
    // next presentation intent, so its timer cannot be owned by that intent.
    if (seat.active && seat.control.mode === 'manual' && seat.control.sessionId === this.conversation?.sessionId) this.activity()
    return () => {
      if (this.manualSeats.get(id) === seat) { this.manualSeats.delete(id); this.activityVersion++; this.stopIdle() }
    }
  }
  async prepareMessage(sessionId: string, signal?: AbortSignal) {
    const seat = [...this.seats.values()].find((item) => item.visible && item.sessionId === sessionId)
    signal?.throwIfAborted()
    await seat?.prepare()
    signal?.throwIfAborted()
    if (this.disposed || this.conversation?.sessionId !== sessionId) throw new Error('会话已切换，请重新发送')
    await this.restoreManual(true, signal)
    signal?.throwIfAborted()
    this.resume()
  }
  /** A reference can name a hidden canvas; flush its existing draft without navigating or delegating. */
  async prepareReference(canvasId: string, signal: AbortSignal) {
    signal.throwIfAborted()
    for (const [id, seat] of this.seats) if (seat.canvasId === canvasId) {
      if (!seat.loaded) throw new Error('引用画布尚未载入，请稍后重试')
      await seat.prepare()
      signal.throwIfAborted()
      if (this.disposed || this.seats.get(id)?.canvasId !== canvasId) throw new Error('画布已切换，请重新选择引用')
    }
  }
  failedMessage() { this.pendingReply = false; this.stopAdmission(); this.changed() }
  private restoreManual(force = false, signal?: AbortSignal): Promise<void> {
    if (this.restoring) return force ? this.restoring.then(() => this.restoreManual(force, signal)) : this.restoring
    const seat = this.manualSeat()
    if (!seat) return Promise.resolve()
    if (!force && isGenerationHandoff(seat.control)) return Promise.resolve()
    const version = this.activityVersion
    const valid = () => !this.disposed && !signal?.aborted && seat === this.manualSeat() &&
      (force || (version === this.activityVersion && !this.interactions.size && !document.hidden))
    const work = (async () => { await seat.resume(valid, force ? 'user-message' : undefined); if (valid()) this.resume() })()
    this.restoring = work
    void work.finally(() => { if (this.restoring === work) this.restoring = undefined }).catch(() => {})
    return work
  }
  private activeReply(intent = this.intent) {
    return !!intent && (this.conversation?.sessionId === intent.sessionId
      ? !this.conversation.removed && this.conversation.openState !== 'error' && (this.conversation.running || this.pendingReply)
      : this.running)
  }
  private key(intent: PresentationIntent) { return `${intent.sessionId}:${intent.canvasId}:${intent.epoch}` }
  following(intent = this.intent) {
    if (!intent) return false
    try {
      const mode = sessionStorage.getItem(`dc-follow:${this.key(intent)}`)
      if (mode === 'paused' || mode === 'manual') this.paused.add(this.key(intent))
      if (mode === 'manual') this.automatic.add(this.key(intent))
    } catch {}
    return this.activeReply(intent) && !this.paused.has(this.key(intent))
  }
  /** Observe public native snapshots; the initial snapshot never replays a send. */
  observeConversation(snapshot: ConversationSnapshot | null, baseline = false) {
    if (this.disposed) return false
    const previous = this.conversation
    // Native snapshots also notify during text streaming. Those updates do not
    // change view mode and must not restart centering or refresh the whole graph.
    if (!baseline && previous?.sessionId === snapshot?.sessionId && previous?.running === snapshot?.running &&
      previous?.pendingSubmissions === snapshot?.pendingSubmissions && previous?.removed === snapshot?.removed &&
      previous?.openState === snapshot?.openState && previous?.promptError === snapshot?.promptError) return false
    const starting = baseline || previous?.sessionId !== snapshot?.sessionId
    if (starting) { this.stopIdle(); this.stopAdmission(); this.interactions.clear(); this.pendingReply = false; this.resumeSession = undefined }
    const submitted = !starting && !!snapshot && snapshot.pendingSubmissions.some((entry) =>
      !previous?.pendingSubmissions.some((old) => old.requestId === entry.requestId))
    this.conversation = snapshot
    if (submitted) {
      this.resumeSession = snapshot.sessionId
      this.pendingReply = !snapshot.running
      this.stopAdmission()
      // An abandoned/failed admission must not leave an idle canvas in follow mode.
      if (this.pendingReply) this.admissionTimer = setTimeout(() => {
        this.admissionTimer = undefined; this.pendingReply = false; this.resumeSession = undefined; this.stopIdle(); this.changed()
      }, 15_000)
      if (this.intent?.sessionId === snapshot.sessionId) { this.resume(); this.resumeSession = undefined }
    }
    if (snapshot?.running || snapshot?.removed || snapshot?.openState === 'error' ||
      (!submitted && snapshot?.promptError?.op === 'send' && snapshot.promptError !== previous?.promptError) ||
      (!starting && previous?.running && !snapshot?.running)) {
      this.stopAdmission(); this.pendingReply = false
      if (!snapshot?.running) this.resumeSession = undefined
    }
    if (!this.activeReply() && !this.manualSeat()) this.stopIdle()
    if (snapshot && this.intent?.sessionId === snapshot.sessionId) this.running = snapshot.running && !snapshot.removed && snapshot.openState !== 'error'
    this.changed()
    if ((starting || (snapshot?.running && !previous?.running)) && this.intent && this.activeReply() && !this.following() && this.automatic.has(this.key(this.intent))) this.scheduleIdle()
    return true
  }
  receive(state: PresentationState, baseline = false) {
    if (this.disposed) return
    this.cursors.receive(state.cursors, baseline)
    const intent = state.intent ? PresentationIntentSchema.parse(state.intent) : null
    if (intent && this.intent && intent.sessionId === this.intent.sessionId && intent.createdAt < this.intent.createdAt) return
    const running = !!intent && (this.conversation?.sessionId === intent.sessionId
      ? this.conversation.running && !this.conversation.removed && this.conversation.openState !== 'error'
      : (state.running ?? true))
    if (this.intent?.id === intent?.id && this.intent?.sessionId === intent?.sessionId && this.running === running) return
    if (!intent || (this.intent && this.key(intent) !== this.key(this.intent))) {
      if (!this.manualSeat()) { this.stopIdle(); this.interactions.clear() }
      if (!intent && this.intent) { this.stopAdmission(); this.pendingReply = false; this.resumeSession = undefined }
    }
    this.intent = intent; this.running = running
    if (intent?.sessionId === this.resumeSession && this.activeReply()) { this.resumeSession = undefined; this.resume() }
    if (!this.activeReply() && !this.manualSeat()) this.stopIdle()
    this.notify()
    if (intent && this.activeReply() && !this.following() && this.automatic.has(this.key(intent)) && !this.idleTimer && !this.interactions.size) this.scheduleIdle()
  }
  private notify() { for (const listener of this.listeners) listener() }
  private changed() { if (this.intent) this.intent = { ...this.intent }; this.notify() }
  private stopIdle() { clearTimeout(this.idleTimer); this.idleTimer = undefined }
  private stopAdmission() { clearTimeout(this.admissionTimer); this.admissionTimer = undefined }
  private scheduleIdle() {
    this.stopIdle()
    const seat = this.manualSeat()
    if (isGenerationHandoff(seat?.control)) return
    if ((!seat && (!this.intent || !this.activeReply())) || this.interactions.size || this.disposed) return
    const key = this.intent && this.key(this.intent), version = this.activityVersion
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined
      if (this.disposed || this.interactions.size || version !== this.activityVersion || document.hidden) return
      if (seat && seat === this.manualSeat()) { void this.restoreManual().catch(seat.report); return }
      if (this.intent && this.key(this.intent) === key && this.activeReply()) this.resume()
    }, 10_001)
  }
  pause(automatic = false) { this.stopIdle(); if (this.intent) {
    const changed = !this.paused.has(this.key(this.intent))
    this.paused.add(this.key(this.intent))
    if (automatic) this.automatic.add(this.key(this.intent)); else this.automatic.delete(this.key(this.intent))
    try { sessionStorage.setItem(`dc-follow:${this.key(this.intent)}`, automatic ? 'manual' : 'paused') } catch {}
    if (changed) this.changed()
  } }
  activity(token?: string, finished = false) {
    this.activityVersion++
    if (token) { if (finished) this.interactions.delete(token); else this.interactions.add(token) }
    if ((!this.manualSeat() && (!this.intent || !this.activeReply())) || this.disposed) return
    this.pause(true); this.scheduleIdle()
  }
  cancelActivity() {
    this.activityVersion++
    this.interactions.clear(); this.stopIdle()
    if (this.intent && this.automatic.delete(this.key(this.intent))) {
      try { sessionStorage.setItem(`dc-follow:${this.key(this.intent)}`, 'paused') } catch {}
    }
  }
  resume() { if (this.intent) {
    this.stopIdle()
    this.paused.delete(this.key(this.intent)); this.automatic.delete(this.key(this.intent)); this.seen.delete(this.key(this.intent))
    try { sessionStorage.removeItem(`dc-follow:${this.key(this.intent)}`) } catch {}
    this.intent = { ...this.intent }; this.lastAttempt = 0; this.notify()
  } }
  readonly subscribeViews = (listener: () => void) => { this.viewListeners.add(listener); return () => { this.viewListeners.delete(listener) } }
  currentCanvas(sessionId: string): string | null {
    const visible = [...this.seats.values()].filter((seat) => seat.visible)
    const seat = visible.find((seat) => seat.sessionId === sessionId) ?? visible.find((seat) => !seat.sessionId)
    return seat?.canvasId ?? null
  }
  private viewsChanged() { for (const listener of this.viewListeners) listener() }
  seat(id: string, seat: CanvasViewSeat) {
    const previous = this.seats.get(id)
    this.seats.set(id, seat)
    if (previous?.canvasId !== seat.canvasId || previous?.sessionId !== seat.sessionId || previous?.visible !== seat.visible) this.viewsChanged()
    return () => { if (this.seats.get(id) === seat) { this.seats.delete(id); this.viewsChanged() } }
  }
  async prepare(id: string) { await this.seats.get(id)?.prepare() }
  async navigate(sessionId: string, open: (canvasId: string) => void, now = Date.now(), current = () => true) {
    const intent = this.intent
    if (!intent || intent.sessionId !== sessionId || !this.following(intent) || this.disposed) return
    const key = this.key(intent), seats = [...this.seats.values()].filter((seat) => seat.sessionId === sessionId)
    const target = seats.find((seat) => seat.visible && seat.loaded && seat.canvasId === intent.canvasId)
    if (target) { this.seen.add(key); return }
    if (this.seen.has(key)) { this.pause(); return }
    if (now - this.lastAttempt < 800) return
    this.lastAttempt = now
    // Protect unsaved local inputs before the tab's navigation changes.
    const seat = seats.find((seat) => seat.visible) ?? seats[0]
    try {
      await seat?.prepare()
      if (this.disposed || this.intent !== intent || !this.following(intent) || !current()) return
      if (seat?.navigate) seat.navigate(intent.canvasId)
      else open(intent.canvasId)
    } catch { /* Slow mount or an unsaved draft remains pending; never mark it opened. */ }
  }
  clear() { this.cursors.reset(); this.disposed = true; this.activityVersion++; this.stopIdle(); this.stopAdmission(); this.interactions.clear(); this.manualSeats.clear(); this.conversation = null; this.pendingReply = false; this.intent = null; this.running = false; this.notify(); this.listeners.clear(); this.seats.clear(); this.viewsChanged() }
}

export function installCanvasPresentation(api: CanvasApi, client: CanvasPresentationClient, window: {
  session: () => string | undefined; subscribe: (listener: () => void) => () => void
  open: (canvasId: string) => void
  conversation?: (sessionId: string) => CanvasConversation | undefined
}, connectionReset?: (listener: () => void) => () => void) {
  client.activate()
  let alive = true, fetching = false, session: string | undefined, stream: EventSource | undefined, generation = 0
  const viewId = crypto.randomUUID()
  let conversation: CanvasConversation | undefined, stopConversation: (() => void) | undefined, restorePrompt: (() => void) | undefined
  const observe = (next?: string) => {
    const face = next ? window.conversation?.(next) : undefined
    if (face === conversation) return
    stopConversation?.(); restorePrompt?.(); conversation = face; stopConversation = undefined; restorePrompt = undefined
    client.observeConversation(face?.getSnapshot() ?? null, true)
    if (face) stopConversation = face.subscribe(() => {
      if (alive && conversation === face && window.session() === next) {
        if (client.observeConversation(face.getSnapshot())) void sync()
      }
    })
    if (face?.prompt && next) {
      const original = face.prompt
      const originalBegin = face.beginSubmission
      const submissions = new Map<string, ReturnType<SessionFace['beginSubmission']>>()
      const begin: SessionFace['beginSubmission'] = function (this: CanvasConversation, input) {
        const handle = originalBegin!.call(this, { ...input, onRetire: (settlement) => {
          submissions.delete(handle.requestId); input.onRetire?.(settlement)
        } })
        submissions.set(handle.requestId, handle)
        return handle
      }
      if (originalBegin) face.beginSubmission = begin
      const guarded: SessionFace['prompt'] = async function (this: CanvasConversation, ...args) {
        try { await client.prepareMessage(next, args[2]) }
        catch (error) {
          if (args[3]) submissions.get(args[3])?.abandon()
          client.failedMessage()
          throw error
        }
        return original.apply(this, args)
      }
      face.prompt = guarded
      restorePrompt = () => {
        if (face.prompt === guarded) face.prompt = original
        if (face.beginSubmission === begin) face.beginSubmission = originalBegin
        submissions.clear()
      }
    }
  }
  const sync = async () => {
    if (!alive) return
    const next = window.session()
    if (session !== next) {
      if (session) void api.presence(session, viewId, false).catch(() => {})
      session = next; generation++; stream?.close(); stream = undefined; client.receive({ intent: null })
      if (next && typeof EventSource !== 'undefined') {
        const captured = generation
        stream = new EventSource(api.url('agent-presentation-events', { sessionId: next }))
        let baseline = true
        stream.onopen = () => { baseline = true }
        stream.onmessage = (event) => {
          if (!alive || captured !== generation || window.session() !== next) return
          try { client.receive(JSON.parse(event.data), baseline); baseline = false; void sync() } catch {}
        }
      }
    }
    observe(next)
    if (!next) return
    const visible = !document.hidden, captured = generation
    void api.presence(next, viewId, visible).catch(() => {})
    if (!visible) return
    if (!fetching) {
      fetching = true
      const baseline = client.getSnapshot()
      void api.presentation(next).then((state) => {
        if (alive && captured === generation && window.session() === next && (state.intent || baseline === client.getSnapshot())) client.receive(state, true)
      }).catch(() => {}).finally(() => { fetching = false })
    }
    await client.navigate(next, (canvasId) => window.open(canvasId), Date.now(), () => alive && captured === generation && !document.hidden && window.session() === next)
  }
  const unsubscribe = window.subscribe(() => { void sync() })
  const reset = connectionReset?.(() => { generation++; stream?.close(); stream = undefined; stopConversation?.(); restorePrompt?.(); restorePrompt = undefined; stopConversation = undefined; conversation = undefined; client.observeConversation(null, true); const old = session; session = undefined; if (old) void api.presence(old, viewId, false).catch(() => {}); void sync() })
  const timer = setInterval(() => { void sync() }, 1000)
  const visibility = () => { void sync() }
  document.addEventListener('visibilitychange', visibility)
  void sync()
  return () => {
    alive = false; generation++; clearInterval(timer); stream?.close(); unsubscribe(); reset?.(); stopConversation?.(); restorePrompt?.()
    document.removeEventListener('visibilitychange', visibility)
    if (session) void api.presence(session, viewId, false).catch(() => {})
    client.clear()
  }
}
