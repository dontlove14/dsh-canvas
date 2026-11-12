import { CursorActivitySchema, type CursorActivity, type CursorState } from '../shared/presentation'

export interface ExecutorCursor {
  activity: CursorActivity; number: number
  motion?: { sequence: number; point: CursorActivity['point']; from?: CursorActivity['point'] }
}
/** Snapshot authority plus finite transitions. Observation cannot call a tool. */
export class ExecutorCursors {
  private stream = ''
  private sequence = -1
  private snapshot: ExecutorCursor[] = []
  private listeners = new Set<() => void>()
  private numbers = new Map<string, number>()
  private consumed = new Set<string>()
  private ended = new Set<string>()
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  readonly getSnapshot = () => this.snapshot
  consume(childId: string, sequence: number) {
    const key = `${childId}:${sequence}`
    if (this.consumed.has(key)) return false
    this.consumed.add(key)
    if (this.consumed.size > 512) this.consumed.delete(this.consumed.values().next().value!)
    return true
  }
  receive(state?: CursorState, baseline = false) {
    if (!state) { this.reset(); return }
    if (state.streamId === this.stream && state.sequence < this.sequence) return
    const fresh = baseline || state.streamId !== this.stream || this.sequence < (state.floor ?? 0) - 1
    if (state.streamId !== this.stream) { this.numbers.clear(); this.consumed.clear(); this.ended.clear() }
    const previous = new Map(this.snapshot.map((cursor) => [cursor.activity.childId, cursor]))
    const starts = new Map<string, CursorActivity>()
    for (const raw of state.events) {
      const parsed = CursorActivitySchema.safeParse(raw)
      if (!parsed.success) continue
      if (parsed.data.phase === 'ended') this.ended.add(parsed.data.childId)
      if (!fresh && parsed.data.sequence > this.sequence && parsed.data.phase === 'started') starts.set(parsed.data.childId, parsed.data)
    }
    const snapshot: ExecutorCursor[] = []
    for (const raw of state.active) {
      const parsed = CursorActivitySchema.safeParse(raw)
      if (!parsed.success || parsed.data.phase === 'ended' || this.ended.has(parsed.data.childId)) continue
      const activity = parsed.data, old = previous.get(activity.childId), start = starts.get(activity.childId)
      if (!this.numbers.has(activity.childId)) this.numbers.set(activity.childId, this.numbers.size + 1)
      snapshot.push({ activity, number: this.numbers.get(activity.childId)!,
        ...(activity.phase !== 'failed' && (!fresh || old?.activity.sequence === activity.sequence) ? {
          motion: start ? { sequence: start.sequence, point: start.point, from: start.from ?? old?.activity.point }
            : old?.activity.operationId === activity.operationId ? old.motion : undefined,
        } : {}) })
    }
    this.stream = state.streamId; this.sequence = state.sequence
    if (this.ended.size > 256) this.ended.delete(this.ended.values().next().value!)
    if (this.numbers.size > 256) for (const childId of this.numbers.keys()) {
      if (!snapshot.some((cursor) => cursor.activity.childId === childId)) this.numbers.delete(childId)
    }
    if (JSON.stringify(snapshot) === JSON.stringify(this.snapshot)) return
    this.snapshot = snapshot
    for (const listener of this.listeners) listener()
  }
  reset() {
    this.stream = ''; this.sequence = -1; this.numbers.clear(); this.consumed.clear(); this.ended.clear()
    if (!this.snapshot.length) return
    this.snapshot = []; for (const listener of this.listeners) listener()
  }
}
