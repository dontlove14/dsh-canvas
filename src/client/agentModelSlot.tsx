import { useSyncExternalStore, type ComponentType } from 'react'
import type { SlotCore, StoredEntry, PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelSelectInjected } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { AgentModelPicker } from './AgentControl'
import type { CanvasApi } from './api'

const SLOT = 'conversation.input.model', LABEL = 'conversation.input.model.label'

/** Decorate the native slot occupant so its child-slot authority remains native. */
export function installAgentModelPicker(slots: Pick<SlotCore, 'entries' | 'onMutate'>, api: CanvasApi) {
  let active = true
  const listeners = new Set<() => void>()
  const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
  const getSnapshot = () => active
  const decorated = new Map<StoredEntry, { Original: unknown; Wrapped: unknown }>()
  const install = () => {
    const original = slots.entries(SLOT).find((entry) => entry.children?.[LABEL])
    if (!original || decorated.has(original)) return
    type Props = ModelSelectInjected & { sessionId: SessionId } & PropsRenderSlots<'conversation.input.model.label'>
    const Original = original.component as ComponentType<Props>
    const Wrapped = (props: Props) => useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
      ? <AgentModelPicker {...props} api={api} Original={Original} />
      : <Original {...props} />
    decorated.set(original, { Original, Wrapped })
    original.component = Wrapped
  }
  // Native registration may follow the slot declaration. A synchronous mutation
  // callback decorates it before the renderer receives the batched notification.
  const unsubscribe = slots.onMutate((key) => { if (key === SLOT) install() })
  install()
  return () => {
    unsubscribe()
    active = false
    for (const [entry, { Original, Wrapped }] of decorated) if (entry.component === Wrapped) entry.component = Original
    // Existing mounted wrappers must stop their API observers immediately,
    // even before the slot ledger next notifies its renderer.
    for (const listener of listeners) listener()
    listeners.clear()
    decorated.clear()
  }
}
