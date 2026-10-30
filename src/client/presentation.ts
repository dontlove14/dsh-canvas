import type { CanvasApi } from './api'
import { PresentationIntentSchema, type PresentationIntent, type PresentationState } from '../shared/presentation'

export interface CanvasViewSeat {
  sessionId?: string; canvasId?: string; visible: boolean; loaded: boolean
  prepare: () => Promise<unknown>
  navigate?: (canvasId: string) => void
}
/** Plugin-root observer; neither the model picker nor a canvas tab owns navigation. */
export class CanvasPresentationClient {
  private intent: PresentationIntent | null = null
  private listeners = new Set<() => void>()
  private seats = new Map<string, CanvasViewSeat>()
  private paused = new Set<string>()
  private seen = new Set<string>()
  private lastAttempt = 0
  private disposed = false
  activate() { this.disposed = false }
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  readonly getSnapshot = () => this.intent
  private key(intent: PresentationIntent) { return `${intent.sessionId}:${intent.canvasId}:${intent.epoch}` }
  following(intent = this.intent) {
    if (!intent) return false
    try { if (sessionStorage.getItem(`dc-follow:${this.key(intent)}`) === 'paused') this.paused.add(this.key(intent)) } catch {}
    return !this.paused.has(this.key(intent))
  }
  receive(state: PresentationState) {
    if (this.disposed) return
    const intent = state.intent ? PresentationIntentSchema.parse(state.intent) : null
    if (intent && this.intent && intent.sessionId === this.intent.sessionId && intent.createdAt < this.intent.createdAt) return
    if (this.intent?.id === intent?.id && this.intent?.sessionId === intent?.sessionId) return
    this.intent = intent; this.notify()
  }
  private notify() { for (const listener of this.listeners) listener() }
  pause() { if (this.intent) {
    this.paused.add(this.key(this.intent))
    try { sessionStorage.setItem(`dc-follow:${this.key(this.intent)}`, 'paused') } catch {}
    this.intent = { ...this.intent }; this.notify()
  } }
  resume() { if (this.intent) {
    this.paused.delete(this.key(this.intent)); this.seen.delete(this.key(this.intent))
    try { sessionStorage.removeItem(`dc-follow:${this.key(this.intent)}`) } catch {}
    this.intent = { ...this.intent }; this.lastAttempt = 0; this.notify()
  } }
  seat(id: string, seat: CanvasViewSeat) { this.seats.set(id, seat); return () => { if (this.seats.get(id) === seat) this.seats.delete(id) } }
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
  clear() { this.disposed = true; this.intent = null; this.notify(); this.listeners.clear(); this.seats.clear() }
}

export function installCanvasPresentation(api: CanvasApi, client: CanvasPresentationClient, window: {
  session: () => string | undefined; subscribe: (listener: () => void) => () => void
  open: (canvasId: string) => void
}, connectionReset?: (listener: () => void) => () => void) {
  client.activate()
  let alive = true, fetching = false, session: string | undefined, stream: EventSource | undefined, generation = 0
  const viewId = crypto.randomUUID()
  const sync = async () => {
    if (!alive) return
    const next = window.session()
    if (session !== next) {
      if (session) void api.presence(session, viewId, false).catch(() => {})
      session = next; generation++; stream?.close(); stream = undefined; client.receive({ intent: null })
      if (next && typeof EventSource !== 'undefined') {
        const captured = generation
        stream = new EventSource(api.url('agent-presentation-events', { sessionId: next }))
        stream.onmessage = (event) => {
          if (!alive || captured !== generation || window.session() !== next) return
          try { client.receive(JSON.parse(event.data)); void sync() } catch {}
        }
      }
    }
    if (!next) return
    const visible = !document.hidden, captured = generation
    void api.presence(next, viewId, visible).catch(() => {})
    if (!visible) return
    if (!fetching) {
      fetching = true
      const baseline = client.getSnapshot()
      void api.presentation(next).then((state) => {
        if (alive && captured === generation && window.session() === next && (state.intent || baseline === client.getSnapshot())) client.receive(state)
      }).catch(() => {}).finally(() => { fetching = false })
    }
    await client.navigate(next, (canvasId) => window.open(canvasId), Date.now(), () => alive && captured === generation && !document.hidden && window.session() === next)
  }
  const unsubscribe = window.subscribe(() => { void sync() })
  const reset = connectionReset?.(() => { generation++; stream?.close(); stream = undefined; const old = session; session = undefined; if (old) void api.presence(old, viewId, false).catch(() => {}); void sync() })
  const timer = setInterval(() => { void sync() }, 1000)
  const visibility = () => { void sync() }
  document.addEventListener('visibilitychange', visibility)
  void sync()
  return () => {
    alive = false; generation++; clearInterval(timer); stream?.close(); unsubscribe(); reset?.()
    document.removeEventListener('visibilitychange', visibility)
    if (session) void api.presence(session, viewId, false).catch(() => {})
    client.clear()
  }
}
