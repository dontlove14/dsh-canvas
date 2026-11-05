import { useMemo, useSyncExternalStore, type ComponentType } from 'react'
import type { SessionListState, UseProjection } from '@deepseek-ai/dsh-api-session-controller/client'
import type { UseSessions } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SlotCore, StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import { CANVAS_PRESET, INTERNAL_CANVAS_PRESETS } from '../shared/agent'
import { agentDisplayName } from '../shared/collaboration'

const SLOT = 'conversation.session.header.actions'
const ACTIONS = new Set(['agent-team', 'subagent-catalog'])
type Projections = SessionListState['projectionsBySession']
type Projection = Projections[keyof Projections]
interface Props { useSessions: UseSessions; useProjection: UseProjection }
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function localizeNames<T>(value: T, nameKey: string): T {
  if (!Array.isArray(value)) return value
  let changed = false
  const rows = value.map((row: unknown) => {
    if (!record(row) || typeof row[nameKey] !== 'string') return row
    const name = agentDisplayName(row[nameKey])
    if (name === row[nameKey]) return row
    changed = true
    return { ...row, [nameKey]: name }
  })
  return changed ? rows as T : value
}
function localizeTeam<T>(value: T): T {
  if (!record(value)) return value
  const members = localizeNames(value.members, 'name')
  return members === value.members ? value : { ...value, members }
}

/** A cached display view keeps native snapshots, watermarks and identities intact. */
export function createAgentNameView() {
  const states = new WeakMap<SessionListState, SessionListState>()
  const projections = new WeakMap<Projections, Projections>()
  const snapshots = new WeakMap<Projection, Projection>()
  return (state: SessionListState): SessionListState => {
    const cached = states.get(state)
    if (cached) return cached
    let views = projections.get(state.projectionsBySession)
    if (!views) {
      let changed = false
      const entries = Object.entries(state.projectionsBySession).map(([id, snapshot]) => {
        let view = snapshots.get(snapshot)
        if (!view) {
          // Experimental Team projection is optional and has no SDK type seat.
          const values = snapshot.values as Projection['values'] & Record<string, unknown>
          const agentTeam = localizeTeam(values.agentTeam)
          const subagentCatalog = localizeNames(values.subagentCatalog, 'label')
          const localizedValues = { ...values, agentTeam, subagentCatalog }
          view = agentTeam === values.agentTeam && subagentCatalog === values.subagentCatalog ? snapshot :
            { ...snapshot, values: localizedValues }
          snapshots.set(snapshot, view)
        }
        if (view !== snapshot) changed = true
        return [id, view] as const
      })
      views = changed ? Object.fromEntries(entries) : state.projectionsBySession
      projections.set(state.projectionsBySession, views)
    }
    const view = views === state.projectionsBySession ? state : { ...state, projectionsBySession: views }
    states.set(state, view)
    return view
  }
}

/** Decorate the two native lists; retain their navigation, status and injection. */
export function installAgentNames(slots: Pick<SlotCore, 'entries' | 'onMutate'>) {
  let active = true
  const listeners = new Set<() => void>()
  const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
  const snapshot = () => active
  const view = createAgentNameView()
  const decorated = new Map<StoredEntry, { Original: ComponentType<Props>; Wrapped: ComponentType<Props> }>()
  const install = () => {
    for (const entry of slots.entries(SLOT)) {
      if (!ACTIONS.has(String(entry.options.id)) || decorated.has(entry)) continue
      const Original = entry.component as ComponentType<Props>
      function Wrapped(props: Props) {
        const installed = useSyncExternalStore(subscribe, snapshot, snapshot)
        const canvas = props.useProjection('agentPreset', (preset) =>
          preset === CANVAS_PRESET || !!preset && INTERNAL_CANVAS_PRESETS.includes(preset))
        const useSessions = useMemo<UseSessions>(() => installed && canvas
          ? (selector, eq) => props.useSessions((state) => selector(view(state)), eq)
          : props.useSessions, [installed, canvas, props.useSessions])
        return <Original {...props} useSessions={useSessions} />
      }
      decorated.set(entry, { Original, Wrapped })
      entry.component = Wrapped
    }
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
