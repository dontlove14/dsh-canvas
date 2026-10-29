import { createContext, useContext, useSyncExternalStore } from 'react'
import type { Asset } from '../shared/contracts'
import { REVIEW_BUSY, type PublicReview, type ReviewSettings } from '../shared/seedanceReview'
import { CanvasApi } from './api'

const EMPTY: readonly PublicReview[] = []
/** One local read per active canvas; only the changed asset's subscribers are notified. */
export class CanvasReviewState {
  private values = new Map<string, readonly PublicReview[]>()
  private listeners = new Map<string, Set<() => void>>()
  private timer?: ReturnType<typeof setTimeout>
  private controller?: AbortController
  private epoch = 0
  private active = false
  private configured = false
  private configurationListeners = new Set<() => void>()
  constructor(readonly api: CanvasApi, readonly canvas: string) {}
  availability = (): boolean => this.configured
  subscribeAvailability = (notify: () => void): (() => void) => {
    this.configurationListeners.add(notify)
    return () => { this.configurationListeners.delete(notify) }
  }
  updateSettings(settings: ReviewSettings): void {
    const configured = settings.profiles.some((profile) => profile.configured)
    if (configured === this.configured) return
    this.configured = configured
    for (const notify of this.configurationListeners) notify()
  }
  snapshot = (id: string): readonly PublicReview[] => this.values.get(id) ?? EMPTY
  subscribe = (id: string, notify: () => void): (() => void) => {
    const subscribers = this.listeners.get(id) ?? new Set()
    subscribers.add(notify); this.listeners.set(id, subscribers)
    return () => { subscribers.delete(notify); if (!subscribers.size) this.listeners.delete(id) }
  }
  setActive(active: boolean): void {
    this.active = active; this.epoch++; this.controller?.abort(); clearTimeout(this.timer)
    if (active) void this.refresh()
  }
  merge(job: PublicReview): void {
    this.epoch++; this.controller?.abort()
    const items = this.snapshot(job.assetId).filter((item) => item.provider !== job.provider)
    this.update(job.assetId, [...items, job])
    if (this.active) void this.refresh(false)
  }
  private update(id: string, next: readonly PublicReview[]): void {
    if (JSON.stringify(this.snapshot(id)) === JSON.stringify(next)) return
    this.values.set(id, next)
    for (const notify of this.listeners.get(id) ?? []) notify()
  }
  refresh = async (configuration = true): Promise<void> => {
    if (!this.active) return
    clearTimeout(this.timer); this.controller?.abort()
    const controller = new AbortController(), epoch = ++this.epoch
    this.controller = controller
    let repeat = false
    let settingsRead = !configuration
    try {
      if (configuration) {
        const settings = await this.api.reviewSettings(controller.signal)
        if (epoch !== this.epoch || controller.signal.aborted) return
        this.updateSettings(settings)
        settingsRead = true
      }
      if (!this.configured) {
        for (const id of this.values.keys()) this.update(id, EMPTY)
        return
      }
      const page = await this.api.reviews(this.canvas, controller.signal)
      if (epoch !== this.epoch || controller.signal.aborted) return
      const next = new Map<string, PublicReview[]>()
      for (const item of page.items) next.set(item.assetId, [...(next.get(item.assetId) ?? []), item])
      for (const id of new Set([...this.values.keys(), ...next.keys()])) this.update(id, next.get(id) ?? EMPTY)
      repeat = page.busy || page.items.some((item) => REVIEW_BUSY.has(item.status))
    } catch {
      repeat = true
      if (epoch === this.epoch && !controller.signal.aborted && !settingsRead) this.updateSettings({ profiles: [] })
    }
    finally {
      if (epoch === this.epoch && this.active && !controller.signal.aborted && repeat)
        this.timer = setTimeout(() => void this.refresh(configuration && !this.configured), 3000)
    }
  }
}
export interface ReviewEnvironment { state: CanvasReviewState; open: (asset: Asset) => void }
export const ReviewContext = createContext<ReviewEnvironment | null>(null)
export function useReviewAvailability(): boolean {
  const context = useContext(ReviewContext)
  return useSyncExternalStore(
    context?.state.subscribeAvailability ?? (() => () => {}),
    context?.state.availability ?? (() => false),
    () => false,
  )
}
export function useAssetReviews(assetId?: string): readonly PublicReview[] {
  const context = useContext(ReviewContext)
  return useSyncExternalStore(
    (notify) => context && assetId ? context.state.subscribe(assetId, notify) : () => {},
    () => context && assetId ? context.state.snapshot(assetId) : EMPTY,
    () => EMPTY,
  )
}
