import { useEffect, useRef, useState, useSyncExternalStore, type ComponentType } from 'react'
import { createPortal } from 'react-dom'
import type { SlotCore, StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import { ThinkingOrb } from 'thinking-orbs'
import { AGENT_SPACE_PRESET } from '../shared/agentSpace'
import { AgentSpaceResources } from './agentSpaceResources'
import { useNodeLoadingEnvironment } from './NodeLoading'
import { UiButton, UiModal } from './ui'

interface GateRequest {
  token: number; phase: 'confirm' | 'loading' | 'error' | 'restoring' | 'restore-error'; valid: () => boolean
  cancel: () => Promise<string | undefined>; resolve: (result: boolean) => void
}
/** Confirmation belongs to an exact chooser generation; it never writes another session. */
export class AgentSpaceGate {
  selecting = false
  private request?: GateRequest
  private listeners = new Set<() => void>()
  private token = 0
  constructor(readonly resources: AgentSpaceResources) {}
  prepareExisting() {
    if (this.selecting || this.request) return Promise.resolve()
    this.request = { token: ++this.token, phase: 'confirm', valid: () => true, cancel: async () => undefined, resolve: () => {} }
    return this.confirm()
  }
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  readonly getSnapshot = () => this.request
  private notify() { for (const listener of this.listeners) listener() }
  ask(cancel: GateRequest['cancel'], valid = () => true): Promise<boolean> {
    this.request?.resolve(false)
    return new Promise((resolve) => {
      this.request = { token: ++this.token, phase: 'confirm', cancel, valid, resolve }
      this.notify()
    })
  }
  async confirm() {
    const request = this.request
    if (!request || !request.valid()) { this.dismiss(); return }
    if (request.phase !== 'confirm' && request.phase !== 'error') return
    this.request = { ...request, phase: 'loading' }; this.notify()
    try {
      await this.resources.load()
      if (this.request?.token !== request.token) return
      request.resolve(request.valid()); this.request = undefined; this.notify()
    } catch {
      if (this.request?.token === request.token) { this.request = { ...request, phase: 'error' }; this.notify() }
    }
  }
  async cancel() {
    const request = this.request
    if (!request || request.phase === 'loading' || request.phase === 'restoring') return
    if (!request.valid()) { this.dismiss(); return }
    this.request = { ...request, phase: 'restoring' }; this.notify()
    const error = await request.cancel().catch(() => '无法恢复预设')
    if (this.request?.token !== request.token) return
    if (error) { this.request = { ...request, phase: 'restore-error' }; this.notify(); return }
    request.resolve(false); this.request = undefined; this.notify()
  }
  validate() { if (this.request && !this.request.valid()) this.dismiss() }
  dismiss() { this.request?.resolve(false); this.request = undefined; this.token++; this.notify() }
  dispose() { this.dismiss(); this.listeners.clear() }
}

export function AgentSpaceGateOverlay({ gate }: { gate: AgentSpaceGate }) {
  const request = useSyncExternalStore(gate.subscribe, gate.getSnapshot)
  const progress = useSyncExternalStore(gate.resources.subscribe, gate.resources.getSnapshot)
  const [visible, setVisible] = useState(!document.hidden)
  const frame = useRef<HTMLDivElement>(null), environment = useNodeLoadingEnvironment(frame, visible)
  useEffect(() => {
    const change = () => setVisible(!document.hidden)
    document.addEventListener('visibilitychange', change)
    return () => document.removeEventListener('visibilitychange', change)
  }, [])
  useEffect(() => {
    if (!request || !['loading', 'error'].includes(request.phase)) return
    const loading = document.querySelector<HTMLElement>('.dc-agent-space-loading')
    if (!loading) return
    const previous = document.activeElement as HTMLElement | null
    const siblings = [...document.body.children].filter((element): element is HTMLElement =>
      element instanceof HTMLElement && element !== loading && !element.contains(loading))
    const old = siblings.map((element) => element.inert)
    siblings.forEach((element) => { element.inert = true })
    loading.focus()
    const keyboard = (event: KeyboardEvent) => {
      if (!loading.contains(event.target as Node)) { event.preventDefault(); event.stopImmediatePropagation(); return }
      if (event.key !== 'Tab') return
      const buttons = [...loading.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
      event.preventDefault()
      if (buttons.length) buttons[(index + (event.shiftKey ? buttons.length - 1 : 1)) % buttons.length].focus()
      else loading.focus()
    }
    document.addEventListener('keydown', keyboard, true)
    return () => {
      document.removeEventListener('keydown', keyboard, true)
      siblings.forEach((element, index) => { element.inert = old[index] })
      if (previous?.isConnected) previous.focus()
    }
  }, [request?.phase])
  useEffect(() => {
    const recover = () => { if (gate.getSnapshot()?.phase === 'error') void gate.confirm() }
    window.addEventListener('online', recover)
    return () => window.removeEventListener('online', recover)
  }, [gate])
  return <div ref={frame} className="dc-agent-space-gate-root">
    {request && ['confirm', 'restoring', 'restore-error'].includes(request.phase) && <UiModal label="加载资源" onClose={() => { void gate.cancel() }} className="dc-agent-space-confirm">
      <p>当前 Agent 需提前加载资源，请耐心等待</p>
      {request.phase === 'restore-error' && <p role="alert">无法恢复预设，请重试</p>}
      <div className="dc-agent-space-confirm-actions"><UiButton disabled={request.phase === 'restoring'} onClick={() => { void gate.cancel() }}>
        {request.phase === 'restore-error' ? '重试恢复' : '取消'}</UiButton>
        {request.phase === 'confirm' && <UiButton variant="primary" onClick={() => { void gate.confirm() }}>确认</UiButton>}</div>
    </UiModal>}
    {request && ['loading', 'error'].includes(request.phase) && createPortal(<div className="dc-agent-space-loading dc-overlay-scope" role="dialog"
      aria-modal="true" aria-label="资源加载中" tabIndex={-1} onKeyDown={(event) => event.stopPropagation()}>
      <ThinkingOrb state="solving" size={64} theme={environment.theme} color={environment.ink} paused={environment.paused} />
      <p role="status">资源加载中</p><strong>{progress.percent}%</strong>
      <progress max={100} value={progress.percent} aria-label="资源加载进度" />
      {request.phase === 'error' && <div className="dc-agent-space-confirm-actions">
        <UiButton onClick={() => { void gate.cancel() }}>取消</UiButton>
        <UiButton variant="primary" onClick={() => { void gate.confirm() }}>重试</UiButton></div>}
    </div>, document.body)}
  </div>
}

interface PresetSeat {
  sessionId?: string
  select: (id: string) => Promise<string | undefined>
  useAgentPresetSeat: (selector: (state: { current: string; options: readonly { id: string; isDefault?: boolean }[] }) => unknown) => any
}
/** Decorate the native chooser's select verb and retain its roster/staging semantics. */
export function installAgentSpacePresetGate(slots: Pick<SlotCore, 'entries' | 'onMutate'>, gate: AgentSpaceGate) {
  let active = true
  const listeners = new Set<() => void>()
  const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
  const snapshot = () => active
  const decorated = new Map<StoredEntry, { original: ComponentType<any>; wrapped: ComponentType<any> }>()
  const install = () => {
    for (const entry of slots.entries('conversation.hero.agentPreset')) {
      if (decorated.has(entry)) continue
      const Original = entry.component as ComponentType<any>
      const Wrapped = (props: PresetSeat) => {
        const installed = useSyncExternalStore(subscribe, snapshot, snapshot)
        const state = props.useAgentPresetSeat((state) => state)
        const live = useRef(true), session = useRef(props.sessionId)
        session.current = props.sessionId
        useEffect(() => { live.current = true; return () => { live.current = false; gate.validate() } }, [])
        useEffect(() => { gate.validate() }, [props.sessionId])
        const select = async (id: string) => {
          if (!active) return props.select(id)
          const previous = state.current || state.options.find((entry: { isDefault?: boolean }) => entry.isDefault)?.id
          const captured = props.sessionId
          if (id === AGENT_SPACE_PRESET) gate.selecting = true
          let error: string | undefined
          try { error = await props.select(id) }
          catch (error) { gate.selecting = false; throw error }
          if (error || id !== AGENT_SPACE_PRESET || !active || !live.current || session.current !== captured) {
            gate.selecting = false
            if (id !== AGENT_SPACE_PRESET) gate.dismiss()
            return error
          }
          const confirmation = gate.ask(() => props.select(previous || state.options.find((entry: { isDefault?: boolean }) => entry.isDefault)?.id || ''),
            () => live.current && session.current === captured)
          gate.selecting = false
          await confirmation
          return undefined
        }
        return <Original {...props} select={installed ? select : props.select} />
      }
      entry.component = Wrapped; decorated.set(entry, { original: Original, wrapped: Wrapped })
    }
  }
  const off = slots.onMutate((key) => { if (key === 'conversation.hero.agentPreset') install() })
  install()
  return () => {
    off(); active = false; gate.selecting = false; gate.dismiss()
    for (const [entry, { original, wrapped }] of decorated) if (entry.component === wrapped) entry.component = original
    for (const listener of listeners) listener()
    listeners.clear(); decorated.clear()
  }
}
