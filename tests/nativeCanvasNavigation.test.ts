// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nativeHarnessSidebar } from './support/nativeHarnessSidebar'
import { CanvasPresentationClient } from '../src/client/presentation'
import { openCanvasTab } from '../src/client/nativeCanvasNavigation'
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconCloseFillRegular: () => null, IconCloseOutlineRegular: () => null,
  IconPanelLeftOutlineRegular: () => null, IconPlusOutlineRegular: () => null,
  MenuSurface: () => null, Tooltip: () => null,
  focusWithoutRing: () => {}, modalSelector: '', observeComposition: () => () => {},
}))
afterEach(() => { localStorage.clear(); sessionStorage.clear() })
describe('Published Harness navigation contract', () => {
  it('recovers from an unadopted window, expands, deduplicates and increments navigation revision for identical params', async () => {
    const sdk = nativeHarnessSidebar(), tabs = new sdk.SidebarRightTabRegistry({ effect: (install: () => unknown) => install() })
    tabs.register({ id: 'dsh-canvas', kind: 'dsh-canvas', title: () => '无限画布' })
    tabs.register({ id: 'guide', kind: 'guide', title: () => '工作区' })
    const native = sdk.createSidebarRightController(tabs, () => () => {}, { autoFullscreen: () => false,
      openWithFocus: (_session: string, open: () => unknown) => open(), closeWithFocus: (_session: string, _pane: string, close: () => void) => close() })
    const controller = native.controller, client = new CanvasPresentationClient()
    native.show('session')
    const intent = { id: 'one', sessionId: 'session', canvasId: 'canvas', epoch: 1, action: 'open' as const, graphRevision: 0, nodeIds: [], createdAt: 1 }
    client.receive({ intent })
    const open = () => openCanvasTab(controller, 'canvas')
    // Unlike openTabIn's silent no-op, the foreground method fails until adoption.
    expect(() => open()).toThrow()
    await client.navigate('session', open, 1000)
    const store = sdk.createSidebarRightStore(() => ({ kind: 'guide', contentId: sdk.pageAddress('guide'), title: '工作区' })).create('navigation-test')
    const release = native.adopt('session', store)
    await client.navigate('session', open, 2000)
    expect(controller.isExpanded()).toBe(true)
    expect(controller.tabsIn('session').filter((tab: any) => tab.kind === 'dsh-canvas')).toHaveLength(1)
    const tab = controller.active()
    const first = controller.tabDomain.occurrence('session', { id: tab.id }).navigation.getSnapshot()
    open()
    const second = controller.tabDomain.occurrence('session', { id: tab.id }).navigation.getSnapshot()
    expect(controller.tabsIn('session').filter((tab: any) => tab.kind === 'dsh-canvas')).toHaveLength(1)
    expect(second.params).toEqual({ canvasId: 'canvas' })
    expect(second.revision).toBeGreaterThan(first.revision)
    controller.float(tab.id, { x: 100, y: 120, width: 800, height: 700 })
    const floated = store.getSnapshot().bySession.session.layout
    openCanvasTab(controller, 'other-canvas')
    expect(controller.tabsIn('session').filter((tab: any) => tab.kind === 'dsh-canvas')).toHaveLength(1)
    const occurrence = controller.tabDomain.occurrence('session', { id: tab.id })
    expect(occurrence.navigation.getSnapshot().params).toEqual({ canvasId: 'other-canvas' })
    const revealed = store.getSnapshot().bySession.session.layout
    expect(revealed.nodes).toEqual(floated.nodes)
    expect(revealed.tabs).toEqual(floated.tabs)
    expect(revealed.floats).toEqual(floated.floats)
    expect(revealed.activePaneId).toBe(revealed.floats[0])
    native.show('other')
    expect(controller.active()).toBeUndefined()
    release(); client.clear()
  })
})
