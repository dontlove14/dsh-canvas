import { useMemo, useSyncExternalStore, type ComponentType } from 'react'
import type { SlotCore, StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type { ComposerBarProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-agent-preset-registry/types'
import { CANVAS_PRESET } from '../shared/agent'

const SLOT = 'conversation.composer.bar'
const HINT = ', # 画布资源引用'
const MESSAGE_PLACEHOLDERS = ['placeholder.default', 'placeholder.hero', 'placeholder.plan'] as const

/** Keep the native editor and status placeholders; decorate only message guidance. */
export function installChatReferencePlaceholder(slots: Pick<SlotCore, 'entries' | 'onMutate'>) {
  let active = true
  const listeners = new Set<() => void>()
  const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
  const snapshot = () => active
  const decorated = new Map<StoredEntry, { Original: ComponentType<ComposerBarProps>; Wrapped: ComponentType<ComposerBarProps> }>()
  const install = () => {
    const entry = slots.entries(SLOT).find((entry) => entry.children?.['conversation.input.model'] && entry.children?.['conversation.input.attachments'])
    if (!entry || decorated.has(entry)) return
    const Original = entry.component as ComponentType<ComposerBarProps>
    function Wrapped(props: ComposerBarProps) {
      const installed = useSyncExternalStore(subscribe, snapshot, snapshot)
      const canvas = props.useProjection('agentPreset', (preset) => preset === CANVAS_PRESET)
      const enabled = installed && canvas && !props.disabled && !props.blocked
      const t = useMemo(() => enabled ? new Proxy(props.t, {
        apply(target, receiver, args) {
          const text = Reflect.apply(target, receiver, args)
          return MESSAGE_PLACEHOLDERS.some((key) => key === args[0]) ? text + HINT : text
        },
      }) : props.t, [enabled, props.t])
      const placeholder = enabled && props.placeholder !== undefined &&
        MESSAGE_PLACEHOLDERS.some((key) => props.placeholder === props.t(key))
        ? props.placeholder + HINT : props.placeholder
      return <Original {...props} t={t} placeholder={placeholder} />
    }
    decorated.set(entry, { Original, Wrapped })
    entry.component = Wrapped
  }
  const unsubscribe = slots.onMutate((key) => { if (key === SLOT) install() })
  install()
  return () => {
    unsubscribe()
    active = false
    for (const [entry, { Original, Wrapped }] of decorated) if (entry.component === Wrapped) entry.component = Original
    for (const listener of listeners) listener()
    listeners.clear()
    decorated.clear()
  }
}
