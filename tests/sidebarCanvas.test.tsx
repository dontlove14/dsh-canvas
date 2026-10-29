// @vitest-environment jsdom
import { webcrypto } from 'node:crypto'
import { act, type ComponentType } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index'
import { CanvasApi } from '../src/client/api'
import { useCanvas } from '../src/client/useCanvas'
import { emptyGraph, type CanvasNode } from '../src/shared/contracts'
import type { CanvasSnapshot, GraphMutation } from '../src/shared/v2'
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'

// Harness loads primitives through its browser module loader. Test the plugin's
// public registration and real app/hooks; semantic controls stand in for that loader.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: () => null, Input: () => null, Checkbox: () => null,
  SegmentedControl: () => null, Menu: () => null, Modal: () => null, Tooltip: () => null,
}))
vi.mock('../src/client/ui', async (original) => ({
  ...await original<typeof import('../src/client/ui')>(),
  HarnessUiProvider: ({ children }: { children: React.ReactNode }) => children,
}))
vi.mock('../src/client/useGpu', () => ({ useGpuCapability: () => ({ enabled: false, reason: 'test' }) }))
vi.mock('@xyflow/react', async (original) => ({
  ...await original<typeof import('@xyflow/react')>(),
  Background: () => null, Controls: () => null, MiniMap: () => null,
  ReactFlow: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))
const roots: Root[] = []
const disposers: Array<() => void> = []
afterEach(() => {
  act(() => { for (const root of roots.splice(0)) root.unmount() })
  for (const dispose of disposers.splice(0)) dispose()
  document.body.replaceChildren(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
function render(element: React.ReactNode) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container); roots.push(root)
  act(() => root.render(element))
  return { root, container }
}
function registration() {
  const definitions = new Map<string, SidebarRightTabDefinition>()
  const slots = new Map<string, { definition: any; Body: ComponentType<any> }>()
  const waiting = new Map<string, () => () => void>()
  const cleanups: Array<() => void> = []
  const ctx = {
    effect: (setup: () => () => void) => { cleanups.push(setup()) },
    sidebarRightTabs: { register: (definition: SidebarRightTabDefinition) => {
      definitions.set(definition.id, definition); return () => { definitions.delete(definition.id) }
    } },
    slots: {
      inject: (name: string, setup: () => () => void) => {
        waiting.set(name, setup)
        cleanups.push(() => { waiting.delete(name) })
      },
      register: (definition: any, Body: ComponentType<any>) => {
        slots.set(definition.name, { definition, Body }); return () => { slots.delete(definition.name) }
      },
    },
  }
  apply(ctx as any)
  const dispose = () => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() }
  disposers.push(dispose)
  const available = (name: string) => { cleanups.push(waiting.get(name)!()) }
  return { definitions, slots, waiting, available, dispose }
}
const snapshot = (): CanvasSnapshot => ({
  version: 1, workspaceId: 'w', graphRevision: 1, graph: emptyGraph(), assets: [], tasks: [],
  updatedAt: 1, commitHash: 'a'.repeat(64), hashes: { nodes: {}, edges: {}, viewport: '' },
})
describe('Harness conversation sidebar canvas', () => {
  it('contributes a guide page and keyed body with one API, supports late slot declarations, and cleans up on unload', () => {
    const { definitions, slots, available, dispose } = registration()
    expect(inject).toContain('sidebarRightTabs')
    const tab = definitions.get('dsh-canvas')!
    expect(tab.kind).toBe('dsh-canvas')
    expect(tab.keepMounted).toBe(true)
    expect(tab.multiple).toBeUndefined()
    expect(tab.patterns).toBeUndefined()
    expect(tab.title('')).toBe('无限画布')
    expect(tab.guide![0].title()).toBe('无限画布')
    expect(slots.size).toBe(0)
    for (const name of ['main', 'sidebar.panellist', 'settings.section', 'sidebar.right.pane.tab']) available(name)
    const side = slots.get('sidebar.right.pane.tab')!
    expect(side.definition.key).toBe(tab.id)
    const api = side.definition.inject().api
    expect(api).toBeInstanceOf(CanvasApi)
    expect(slots.get('main')!.definition.inject().api).toBe(api)
    expect(slots.get('settings.section')!.definition.inject().api).toBe(api)
    expect(slots.get('sidebar.panellist')!.definition.label).toBe('无限画布')
    expect(document.head.querySelector('style[data-plugin="dsh-canvas"]')).toBeTruthy()
    dispose()
    expect(definitions.size).toBe(0); expect(slots.size).toBe(0)
    expect(document.head.querySelector('style[data-plugin="dsh-canvas"]')).toBeNull()
  })
  it('passes live tab visibility to the real app, retains folder/project state, pauses hidden polling and resumes without reloading the canvas', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('ResizeObserver', class { observe() {}; disconnect() {} })
    const { slots, available } = registration()
    available('sidebar.right.pane.tab')
    const { definition, Body } = slots.get('sidebar.right.pane.tab')!
    const { api } = definition.inject()
    const catalog = vi.spyOn(api, 'catalog').mockResolvedValue({
      folders: [{ id: 'folder', name: '作品', revision: 1, hash: '' }],
      canvases: [{ id: 'w', name: '已有画布', folderId: 'folder', revision: 1, hash: '', moving: false }],
    })
    const state = vi.spyOn(api, 'state').mockResolvedValue(snapshot())
    let visible = true
    const props = { api, useTabInfo: () => ({ tab: { visible } }) }
    const { root, container } = render(<Body {...props} />)
    await act(async () => { await Promise.resolve() })
    act(() => { [...container.querySelectorAll<HTMLButtonElement>('.dc-folder-item')].find((button) => button.textContent?.includes('作品'))!.click() })
    visible = false
    act(() => root.render(<Body {...props} />))
    await act(async () => { await vi.advanceTimersByTimeAsync(12000) })
    expect(catalog).toHaveBeenCalledTimes(1)
    visible = true
    act(() => root.render(<Body {...props} />))
    expect(container.querySelector('.dc-folder-item.active')?.textContent).toContain('作品')
    await act(async () => { await vi.advanceTimersByTimeAsync(4000) })
    expect(catalog).toHaveBeenCalledTimes(2)
    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="打开画布“已有画布”"]')!.click(); await Promise.resolve() })
    expect(state).toHaveBeenCalledTimes(1)
    expect(container.querySelector('.dc-workspace-title')?.textContent).toContain('已有画布')
    visible = false
    act(() => root.render(<Body {...props} />))
    await act(async () => { await vi.advanceTimersByTimeAsync(10000) })
    expect(state).toHaveBeenCalledTimes(1)
    visible = true
    act(() => root.render(<Body {...props} />))
    expect(container.querySelector('.dc-workspace-title')?.textContent).toContain('已有画布')
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(state).toHaveBeenCalledTimes(2)
    expect(catalog).toHaveBeenCalledTimes(2)
  })
  it('saves an existing draft while hidden without a hide-triggered reload, then reads updates on return', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('crypto', webcrypto)
    const api = new CanvasApi()
    let current = snapshot()
    vi.spyOn(api, 'state').mockImplementation(async () => current)
    const save = vi.spyOn(api, 'save').mockImplementation(async (_workspace, mutation: GraphMutation) => {
      current = { ...current, graphRevision: current.graphRevision + 1,
        graph: { ...current.graph, nodes: mutation.nodes.map((item) => item.value) },
        hashes: { ...current.hashes, nodes: Object.fromEntries(mutation.nodes.map((item) => [item.value.id, item.hash])) } }
      return current
    })
    let canvas!: ReturnType<typeof useCanvas>
    function Probe({ active }: { active: boolean }) { canvas = useCanvas(api, 'w', active); return <p>{canvas.graph.nodes[0]?.prompt}</p> }
    const { root, container } = render(<Probe active />)
    await act(async () => { await Promise.resolve() })
    const node: CanvasNode = { id: crypto.randomUUID(), kind: 'image-generation', title: '草稿', position: { x: 1, y: 2 }, modelId: null, params: null,
      prompt: '未完成的提示词', assetId: null, selectedResultId: null }
    act(() => { canvas.edit({ ...canvas.graph, nodes: [node] }); root.render(<Probe active={false} />) })
    await act(async () => { await vi.advanceTimersByTimeAsync(650); await canvas.flush() })
    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0][0]).toBe('w')
    expect(save.mock.calls[0][1].nodes[0].value.prompt).toBe('未完成的提示词')
    await act(async () => { await vi.advanceTimersByTimeAsync(8000) })
    expect(api.state).toHaveBeenCalledTimes(1)
    expect(container.textContent).toBe('未完成的提示词')
    act(() => root.render(<Probe active />))
    expect(container.textContent).toBe('未完成的提示词')
    expect(api.state).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(api.state).toHaveBeenCalledTimes(2)
    expect(save).toHaveBeenCalledTimes(1)
  })
})
