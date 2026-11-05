import { useCallback, useEffect, useSyncExternalStore } from 'react'
import type { CanvasApi } from './api'
import type { CollaborationPage, CollaborationTask, CollaborationDetail } from '../shared/collaboration'

const EMPTY: CollaborationPage = { revision: -1, tasks: [], next: null, total: 0, active: 0 }
interface Seat { snapshot: CollaborationPage; listeners: Set<() => void>; stream?: EventSource; generation: number; abort?: AbortController; historical?: boolean }
const CLOSED_VIEW = { expanded: false, taskId: undefined as string | undefined, revision: 0 }
export type CollaborationView = typeof CLOSED_VIEW
/** One live subscription per root session for every card and panel; reads never invoke an Agent. */
export class CollaborationClient {
  private seats = new Map<string, Seat>()
  private views = new Map<string, CollaborationView>()
  private viewListeners = new Set<() => void>()
  constructor(readonly api: Pick<CanvasApi, 'url'>) {}
  private seat(id: string) {
    let seat = this.seats.get(id)
    if (!seat) { seat = { snapshot: EMPTY, listeners: new Set(), generation: 0 }; this.seats.set(id, seat) }
    return seat
  }
  snapshot(id: string) { return this.seat(id).snapshot }
  view(id: string) { return this.views.get(id) ?? CLOSED_VIEW }
  subscribeView(listener: () => void) { this.viewListeners.add(listener); return () => { this.viewListeners.delete(listener) } }
  open(id: string, taskId?: string) {
    this.views.set(id, { expanded: true, taskId, revision: this.view(id).revision + 1 })
    for (const listener of this.viewListeners) listener()
  }
  collapse(id: string) {
    this.views.set(id, { ...this.view(id), expanded: false })
    for (const listener of this.viewListeners) listener()
  }
  private publish(seat: Seat) { for (const listener of seat.listeners) listener() }
  async read<T>(path: string, params: Record<string, string>, signal?: AbortSignal): Promise<T> {
    const response = await fetch(this.api.url(path, params), { credentials: 'same-origin', cache: 'no-store', signal })
    if (!response.ok) throw new Error(response.status === 404 ? '该批次没有协作记录；可查看原生工具记录' : '协作记录暂不可用')
    return response.json()
  }
  private receive(seat: Seat, page: CollaborationPage, historical = false) {
    if (page.revision < seat.snapshot.revision) return
    const byId = new Map(seat.snapshot.tasks.map((t) => [t.id, t]))
    for (const task of [...page.tasks, ...(page.activeTasks ?? [])]) if ((byId.get(task.id)?.revision ?? -1) <= task.revision) byId.set(task.id, task)
    if (historical) seat.historical = true
    seat.snapshot = { ...page, tasks: [...byId.values()].sort((a, b) => b.createdAt - a.createdAt),
      next: historical ? page.next : seat.historical ? seat.snapshot.next : page.next }
    this.publish(seat)
  }
  private connect(id: string, seat: Seat) {
    const generation = ++seat.generation
    seat.abort = new AbortController()
    const current = () => seat.generation === generation && seat.listeners.size > 0
    void this.read<CollaborationPage>('agent-collaboration', { sessionId: id }, seat.abort.signal)
      .then((page) => { if (current()) this.receive(seat, page) })
      .catch((error) => { if (current()) { seat.snapshot = { ...seat.snapshot, error: error.message }; this.publish(seat) } })
    if (typeof EventSource === 'undefined') return
    const stream = seat.stream = new EventSource(this.api.url('agent-collaboration-events', { sessionId: id }))
    stream.onmessage = (event) => {
      if (!current()) return
      try { this.receive(seat, JSON.parse(event.data)) } catch {
        seat.snapshot = { ...seat.snapshot, error: '协作记录格式异常，请重连' }; this.publish(seat)
      }
    }
    stream.onerror = () => { if (current()) { seat.snapshot = { ...seat.snapshot, error: '连接中断，正在重连；当前显示已保存记录' }; this.publish(seat) } }
  }
  subscribe(id: string, listener: () => void) {
    const seat = this.seat(id)
    seat.listeners.add(listener)
    if (seat.listeners.size === 1) this.connect(id, seat)
    return () => {
      seat.listeners.delete(listener)
      if (!seat.listeners.size) { seat.generation++; seat.stream?.close(); seat.stream = undefined; seat.abort?.abort() }
    }
  }
  reset() {
    for (const [id, seat] of this.seats) {
      seat.generation++; seat.stream?.close(); seat.abort?.abort()
      seat.snapshot = EMPTY; seat.historical = false; this.publish(seat)
      if (seat.listeners.size) this.connect(id, seat)
    }
  }
  close() {
    for (const seat of this.seats.values()) { seat.generation++; seat.stream?.close(); seat.abort?.abort(); seat.listeners.clear() }
    this.seats.clear(); this.views.clear(); this.viewListeners.clear()
  }
  async older(id: string) {
    const seat = this.seat(id), cursor = seat.snapshot.next, generation = seat.generation
    if (cursor === null) return
    const page = await this.read<CollaborationPage>('agent-collaboration', { sessionId: id, cursor: String(cursor) }, seat.abort?.signal)
    if (seat.generation === generation && seat.listeners.size) this.receive(seat, page, true)
  }
  async ensureTask(id: string, taskId: string, signal: AbortSignal) {
    const seat = this.seat(id), generation = seat.generation
    const task = await this.read<CollaborationTask>('agent-collaboration', { sessionId: id, id: taskId }, signal)
    if (seat.generation !== generation || signal.aborted) return
    const tasks = new Map(seat.snapshot.tasks.map((t) => [t.id, t]))
    if ((tasks.get(task.id)?.revision ?? -1) > task.revision) return
    tasks.set(task.id, task); seat.snapshot = { ...seat.snapshot, tasks: [...tasks.values()].sort((a, b) => b.createdAt - a.createdAt) }; this.publish(seat)
  }
  detail(sessionId: string, id: string, signal: AbortSignal, before?: number): Promise<CollaborationDetail> {
    return this.read('agent-collaboration-detail', { sessionId, id, limit: '50', ...(before ? { before: String(before) } : {}) }, signal)
  }
}
export function useCollaborationView(client: CollaborationClient, sessionId?: string) {
  const subscribe = useCallback((listener: () => void) => client.subscribeView(listener), [client])
  const snapshot = useCallback(() => sessionId ? client.view(sessionId) : CLOSED_VIEW, [client, sessionId])
  return useSyncExternalStore(subscribe, snapshot, () => CLOSED_VIEW)
}
export function useCollaboration(client: CollaborationClient, sessionId?: string, active = true) {
  const subscribe = useCallback((listener: () => void) => sessionId && active ? client.subscribe(sessionId, listener) : () => {}, [client, sessionId, active])
  const snapshot = useCallback(() => sessionId && active ? client.snapshot(sessionId) : EMPTY, [client, sessionId, active])
  return useSyncExternalStore(subscribe, snapshot, () => EMPTY)
}
export function useCollaborationTask(client: CollaborationClient, sessionId: string, id: string) {
  const page = useCollaboration(client, sessionId)
  const task = page.tasks.find((t) => t.id === id)
  useEffect(() => {
    if (!id || page.revision < 0 || task) return
    const abort = new AbortController()
    void client.ensureTask(sessionId, id, abort.signal).catch(() => {})
    return () => abort.abort()
  }, [client, sessionId, id, page.revision])
  return { task, error: page.error }
}
