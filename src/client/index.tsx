import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SidebarRightTabDefinition, UseSidebarRightTabInfo } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import flowCss from '@xyflow/react/dist/style.css?inline'
import css from './styles.css?inline'
import agentCss from './agent.css?inline'
import { CanvasApi } from './api'
import { CanvasApp } from './Canvas'
import { CanvasSettings } from './Settings'
import { Button, Input, Checkbox, SegmentedControl, Menu, Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { HarnessUiProvider } from './ui'
import { installAgentModelPicker } from './agentModelSlot'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import { CanvasPresentationClient, installCanvasPresentation } from './presentation'
import { openCanvasTab } from './nativeCanvasNavigation'
import { installCanvasPlanPreview } from './canvasPlanPreview'
import { installAgentProgress } from './agentProgress'
import { useRef, useState, useEffect } from 'react'

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap { 'dsh-canvas': { canvasId?: string } }
}

export const name = 'dsh-canvas'
export const inject = ['slots', 'layout', 'sidebarRightTabs']
const PANEL_ID = 'dsh-canvas' as MainPanelId
const components = { Button, Input, Checkbox, SegmentedControl, Menu, Modal, Tooltip }
interface Face { api: CanvasApi; presentation: CanvasPresentationClient }
function MainPanel({ api, sessionId, presentation }: Face & { sessionId?: string }) {
  return <HarnessUiProvider components={components}><CanvasApp api={api} sessionId={sessionId} presentation={presentation} /></HarnessUiProvider>
}
function SidebarPanel({ api, useTabInfo, sessionId, presentation }: Face & { useTabInfo: UseSidebarRightTabInfo; sessionId?: string }) {
  const { tab } = useTabInfo()
  const viewId = useRef(crypto.randomUUID()).current
  const params = tab.navigation.params as { canvasId?: string } | undefined
  return <HarnessUiProvider components={components}><CanvasApp api={api} active={tab.visible} sessionId={sessionId} requestedCanvas={params?.canvasId}
    navigationRevision={tab.navigation.revision} presentation={presentation} viewId={viewId}
    /></HarnessUiProvider>
}
function SettingsPanel({ api }: { api: CanvasApi }) {
  return <HarnessUiProvider components={components}><CanvasSettings api={api} /></HarnessUiProvider>
}
function SidebarTitle({ api, useTabInfo }: { api: CanvasApi; useTabInfo: UseSidebarRightTabInfo }) {
  const { tab } = useTabInfo()
  const canvasId = (tab.navigation.params as { canvasId?: string } | undefined)?.canvasId
  const [title, setTitle] = useState<{ id?: string; value: string }>({ value: '无限画布' })
  useEffect(() => {
    let live = true
    if (canvasId) void api.catalog().then((catalog) => {
      const choice = catalog.canvases.find((choice) => choice.id === canvasId)
      if (live && choice) setTitle({ id: canvasId, value: choice.name })
    }).catch(() => {})
    return () => { live = false }
  }, [api, canvasId, tab.navigation.revision])
  return <span>{canvasId && title.id === canvasId ? title.value : '无限画布'}</span>
}
function PanelIcon({ size = 18 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="2" stroke="currentColor" strokeWidth="1.5" /><rect x="14" y="14" width="7" height="7" rx="2" stroke="currentColor" strokeWidth="1.5" /><path d="M10 6.5h4.5a3 3 0 0 1 3 3V14M6.5 10v7.5H14" stroke="currentColor" strokeWidth="1.5" /></svg>
}
const sidebarTab: SidebarRightTabDefinition = {
  id: name, kind: name, title: () => '无限画布', keepMounted: true,
  guide: [{ id: name, order: 70, title: () => '无限画布', description: () => '打开画布项目，连接素材与创作节点', icon: PanelIcon }],
}

export function apply(ctx: Context): void {
  installAgentProgress(ctx)
  const face: Face = { api: new CanvasApi(), presentation: new CanvasPresentationClient() }
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = name
    style.textContent = `${flowCss}\n${css}\n${agentCss}`
    document.head.appendChild(style)
    return () => style.remove()
  })
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, inject: () => face }, MainPanel))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, label: '无限画布', order: 70 }, PanelIcon))
  ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'canvas-models', label: '无限画布', order: 70, inject: () => ({ api: face.api }) }, SettingsPanel))
  ctx.effect(() => ctx.sidebarRightTabs.register(sidebarTab))
  ctx.effect(() => installCanvasPlanPreview({
    entries: (key) => ctx.slots.entries(key as Parameters<typeof ctx.slots.entries>[0]),
    onMutate: (listener) => ctx.on('slots/changed', listener),
  }))
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: sidebarTab.id, inject: () => face }, SidebarPanel))
  ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: sidebarTab.id, inject: () => ({ api: face.api }) }, SidebarTitle))
  ctx.inject(['modelDirectories'], (scope) => {
    scope.effect(() => installAgentModelPicker({
      entries: (key) => scope.slots.entries(key as 'conversation.input.model'),
      onMutate: (listener) => scope.on('slots/changed', listener),
    }, face.api))
  })
  ctx.inject(['sidebarRight', 'connection'], (scope) => {
    scope.effect(() => installCanvasPresentation(face.api, face.presentation, {
      session: () => scope.sidebarRight.mounted.getSnapshot(),
      subscribe: (listener) => scope.sidebarRight.mounted.subscribe(listener),
      open: (canvasId) => openCanvasTab(scope.sidebarRight, canvasId),
    }, (listener) => scope.on('connection/reset', listener)))
  })
}
