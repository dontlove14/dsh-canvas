import { useMemo, useSyncExternalStore, type ComponentType } from 'react'
import type { SlotCore, StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'

const SLOT = 'conversation.plan-review.actions', NATIVE = '@deepseek-ai/dsh-client-ui-plan'
interface Review {
  id: string; callId?: string; plan: string
  approve: { label: string }; decline?: { label: string }
}
/** Repair legacy canvas reviews without changing native plans or decision actions. */
export function installCanvasPlanPreview(slots: Pick<SlotCore, 'entries' | 'onMutate'>) {
  let active = true
  const listeners = new Set<() => void>()
  const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
  const getSnapshot = () => active
  const decorated = new Map<StoredEntry, { Original: unknown; Wrapped: unknown }>()
  const install = () => {
    const entry = slots.entries(SLOT).find((entry) => entry.options.id === NATIVE)
    if (!entry || decorated.has(entry)) return
    const Original = entry.component as ComponentType<any>
    const Wrapped = (props: { review: Review } & Record<string, unknown>) => {
      const enabled = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
      const review = useMemo(() => {
        if (!enabled || props.review.id !== 'canvas-plan' || props.review.approve.label !== '确认方案'
          || props.review.decline?.label !== '需要修改' || !props.review.callId) return props.review
        const { callId: _legacyLookup, ...detail } = props.review
        return detail
      }, [enabled, props.review])
      return <Original {...props} review={review} />
    }
    decorated.set(entry, { Original, Wrapped }); entry.component = Wrapped
  }
  const unsubscribe = slots.onMutate((key) => { if (key === SLOT) install() })
  install()
  return () => {
    unsubscribe(); active = false
    for (const [entry, { Original, Wrapped }] of decorated) if (entry.component === Wrapped) entry.component = Original
    for (const listener of listeners) listener()
    listeners.clear(); decorated.clear()
  }
}
