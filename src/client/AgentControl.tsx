import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ComponentType } from 'react'
import type { ModelSelectInjected, ModelDirectoryState, ModelLabelOwner } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { CanvasApi } from './api'
import { UiButton } from './ui'
import type { CanvasControl } from '../shared/agent'
import { MODEL_CAPABILITY_FAILED_HINT, MODEL_CAPABILITY_PENDING_HINT, NON_MULTIMODAL_MODEL_HINT, NativeModelOptionRestriction, modelRouteKey } from './nativeModelRestrictions'

export function AgentControlBar({ api, canvasId, sessionId, control, flush, refresh, report, disabled }: {
  api: CanvasApi; canvasId: string; sessionId?: string; control?: CanvasControl
  flush: () => Promise<number>; refresh: () => Promise<void>; report: (error: unknown) => void; disabled: boolean
}) {
  const [busy, setBusy] = useState(false)
  const act = async () => {
    setBusy(true)
    try {
      if (control?.mode === 'agent') await api.takeover(canvasId)
      else {
        if (!sessionId) throw new Error('请在「无限画布」会话的画布侧栏中委托')
        const revision = await flush()
        await api.delegate(canvasId, sessionId, revision)
      }
      await refresh()
    } catch (error) { report(error) }
    finally { setBusy(false) }
  }
  return <div className="dc-agent-control">
    <span>{control?.mode === 'agent' ? 'Agent 协作 · 画布只读' : '人工手动'}</span>
    <UiButton variant={control?.mode === 'agent' ? 'primary' : 'outline'} disabled={busy || disabled || (!sessionId && control?.mode !== 'agent')} onClick={() => void act()}>
      {control?.mode === 'agent' ? '人工接管' : '交给 Agent'}
    </UiButton>
  </div>
}

type ModelProps = ModelSelectInjected & { sessionId: SessionId } & PropsRenderSlots<'conversation.input.model.label'>
export function AgentModelPicker(props: ModelProps & {
  api: CanvasApi; Original: ComponentType<any>
}) {
  const { api, Original, sessionId, directory } = props
  const state = useSyncExternalStore<ModelDirectoryState>(directory.subscribe, directory.getSnapshot, directory.getSnapshot)
  const [preset, setPreset] = useState(false)
  const [capabilities, setCapabilities] = useState<{ sessionId: string; models: Map<string, boolean> | null; failed: boolean }>({ sessionId, models: null, failed: false })
  const refreshModels = useRef<() => void>(() => {})
  const refreshQueued = useRef(false)
  const requestRefresh = useCallback(() => {
    if (refreshQueued.current) return
    refreshQueued.current = true
    queueMicrotask(() => { refreshQueued.current = false; refreshModels.current() })
  }, [])
  const routes = JSON.stringify(state.groups.map((group) => [group.id, group.models.map((model) => [model.id, model.name])]))
  useEffect(() => {
    let alive = true, fetching = false
    const refresh = async () => {
      if (fetching) return
      fetching = true
      try {
        const session = await api.agentSession(sessionId)
        if (!alive) return
        setPreset(session.preset)
      } catch {}
      finally { fetching = false }
    }
    void refresh()
    const timer = setInterval(() => { if (!document.hidden) void refresh() }, 1000)
    return () => { alive = false; clearInterval(timer) }
  }, [api, sessionId])
  useEffect(() => {
    let alive = true, fetching = false
    setCapabilities({ sessionId, models: null, failed: false })
    const refresh = () => {
      if (!alive || !preset || fetching) return
      fetching = true
      void api.agentModels().then(({ models }) => {
        if (alive) setCapabilities({ sessionId, models: new Map(models.map((model) => [modelRouteKey(model.provider, model.model), model.eligible])), failed: false })
      }).catch(() => { if (alive) setCapabilities({ sessionId, models: null, failed: true }) })
        .finally(() => { fetching = false })
    }
    refreshModels.current = refresh
    refresh()
    return () => { alive = false; refreshModels.current = () => {} }
  }, [api, preset, sessionId])
  useEffect(() => { refreshModels.current() }, [routes])
  const renderSlot: ModelProps['renderSlot'] = (key, owner, options) => {
    const label = props.renderSlot(key, owner, options)
    if (!preset || key !== 'conversation.input.model.label') return label
    const modelOwner = owner as unknown as ModelLabelOwner
    if (modelOwner.placement !== 'option') return label
    const known = capabilities.sessionId === sessionId ? capabilities.models?.get(modelRouteKey(modelOwner.provider.id, modelOwner.model.id)) : undefined
    const hint = known === true ? null : known === false ? NON_MULTIMODAL_MODEL_HINT
      : capabilities.failed ? MODEL_CAPABILITY_FAILED_HINT : MODEL_CAPABILITY_PENDING_HINT
    return <>{label}<NativeModelOptionRestriction hint={hint} modelName={modelOwner.model.name} directory={directory} refresh={requestRefresh} /></>
  }
  return <Original {...props} renderSlot={preset ? renderSlot : props.renderSlot} />
}
