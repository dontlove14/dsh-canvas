import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SidebarRightTabDefinition, UseSidebarRightTabInfo } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import flowCss from '@xyflow/react/dist/style.css?inline'
import css from './styles.css?inline'
import { CanvasApi } from './api'
import { CanvasApp } from './Canvas'
import { CanvasSettings } from './Settings'
import { Button, Input, Checkbox, SegmentedControl, Menu, Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { HarnessUiProvider } from './ui'

export const name = 'dsh-canvas'
export const inject = ['slots', 'layout', 'sidebarRightTabs']
const PANEL_ID = 'dsh-canvas' as MainPanelId
const components = { Button, Input, Checkbox, SegmentedControl, Menu, Modal, Tooltip }
interface Face { api: CanvasApi }
function MainPanel({ api }: Face) {
  return <HarnessUiProvider components={components}><CanvasApp api={api} /></HarnessUiProvider>
}
function SidebarPanel({ api, useTabInfo }: Face & { useTabInfo: UseSidebarRightTabInfo }) {
  const { tab } = useTabInfo()
  return <HarnessUiProvider components={components}><CanvasApp api={api} active={tab.visible} /></HarnessUiProvider>
}
function SettingsPanel({ api }: { api: CanvasApi }) {
  return <HarnessUiProvider components={components}><CanvasSettings api={api} /></HarnessUiProvider>
}
function PanelIcon({ size = 18 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="2" stroke="currentColor" strokeWidth="1.5" /><rect x="14" y="14" width="7" height="7" rx="2" stroke="currentColor" strokeWidth="1.5" /><path d="M10 6.5h4.5a3 3 0 0 1 3 3V14M6.5 10v7.5H14" stroke="currentColor" strokeWidth="1.5" /></svg>
}
const sidebarTab: SidebarRightTabDefinition = {
  id: name, kind: name, title: () => '无限画布', keepMounted: true,
  guide: [{ id: name, order: 70, title: () => '无限画布', description: () => '打开画布项目，连接素材与创作节点', icon: PanelIcon }],
}

export function apply(ctx: Context): void {
  const face: Face = { api: new CanvasApi() }
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = name
    style.textContent = `${flowCss}\n${css}`
    document.head.appendChild(style)
    return () => style.remove()
  })
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, inject: () => face }, MainPanel))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, label: '无限画布', order: 70 }, PanelIcon))
  ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'canvas-models', label: '无限画布', order: 70, inject: () => ({ api: face.api }) }, SettingsPanel))
  ctx.effect(() => ctx.sidebarRightTabs.register(sidebarTab))
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: sidebarTab.id, inject: () => face }, SidebarPanel))
}
