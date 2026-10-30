import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'

/** Update an existing native occurrence without moving its dock or floating pane. */
export function openCanvasTab(sidebar: Context['sidebarRight'], canvasId: string) {
  const sessionId = sidebar.mounted.getSnapshot()
  if (!sessionId) return
  const existing = sidebar.tabsIn(sessionId).find((tab) => tab.kind === 'dsh-canvas')
  if (existing) {
    sidebar.tabDomain.navigate(sessionId, existing.id, { address: existing.contentId, params: { canvasId } })
    if (!sidebar.isExpanded()) sidebar.toggleExpanded()
    sidebar.focus(existing.id)
  } else sidebar.openTab('dsh-canvas', { params: { canvasId } })
}
