// @vitest-environment jsdom
import { webcrypto } from 'node:crypto'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ReactFlowProvider, useReactFlow, useStoreApi } from '@xyflow/react'
import { afterEach, expect, it, vi } from 'vitest'
import { CanvasWorkspace } from '../src/client/Canvas'
import { CanvasApi } from '../src/client/api'
import { HarnessUiProvider, pointMenuPosition } from '../src/client/ui'
import { blankCanvasPoint } from '../src/client/useNodeCreationMenu'
import { emptyGraph, type Asset, type CanvasNode } from '../src/shared/contracts'
import type { CanvasSnapshot } from '../src/shared/v2'
import { harnessPrimitives } from './support/harnessPrimitives'

vi.mock('../src/client/useGpu', () => ({ useGpuCapability: () => ({ enabled: false, reason: 'test' }) }))
let root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined
  document.body.replaceChildren(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
const menu = () => document.querySelector<HTMLElement>('.dc-node-creation-menu')
const item = (text: string) => [...menu()!.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === text)!

async function fixture(native = true, mime = 'image/png') {
  vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal('ResizeObserver', class { observe() {}; unobserve() {}; disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {}; disconnect() {} })
  vi.stubGlobal('DOMMatrixReadOnly', class { m22 = 1 })
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function () { return this.classList.contains('react-flow__handle') ? 10 : 1000 })
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function () { return this.classList.contains('react-flow__handle') ? 10 : 700 })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    return this.classList.contains('react-flow__handle') ? new DOMRect(310, 85, 10, 10) : new DOMRect(0, 0, 1000, 700)
  })
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  const source: CanvasNode = { id: crypto.randomUUID(), kind: 'image-asset', title: '来源', position: { x: 0, y: 0 },
    assetId: crypto.randomUUID(), modelId: null, params: null, prompt: '', selectedResultId: null }
  const asset: Asset = { id: source.assetId!, nodeId: source.id, kind: 'image', mime, filename: '来源.png', bytes: 1, createdAt: 1 }
  let snapshot: CanvasSnapshot = { version: 1, workspaceId: 'w', graphRevision: 1, graph: { ...emptyGraph(), nodes: [source] }, assets: [asset],
    tasks: [], updatedAt: 1, commitHash: 'a'.repeat(64), hashes: { nodes: {}, edges: {}, viewport: '' } }
  const api = new CanvasApi()
  vi.spyOn(api, 'state').mockImplementation(async () => structuredClone(snapshot))
  vi.spyOn(api, 'models').mockResolvedValue([]); vi.spyOn(api, 'ttsSettings').mockResolvedValue({ has_api_key: false } as any)
  vi.spyOn(api, 'reviewSettings').mockResolvedValue({ profiles: [] })
  vi.spyOn(api, 'mediaUrls').mockResolvedValue({ items: [] })
  const generate = vi.spyOn(api, 'generate'), ttsGenerate = vi.spyOn(api, 'ttsGenerate')
  const save = vi.spyOn(api, 'save').mockImplementation(async (_workspace, mutation) => {
    snapshot = { ...snapshot, graphRevision: snapshot.graphRevision + 1, graph: {
      ...snapshot.graph,
      nodes: [...snapshot.graph.nodes.filter((node) => !mutation.deleteNodes.includes(node.id) && !mutation.nodes.some((entry) => entry.value.id === node.id)), ...mutation.nodes.map((entry) => entry.value)],
      edges: [...snapshot.graph.edges.filter((edge) => !mutation.deleteEdges.includes(edge.id) && !mutation.edges.some((entry) => entry.value.id === edge.id)), ...mutation.edges.map((entry) => entry.value)],
      viewport: mutation.viewport?.value ?? snapshot.graph.viewport,
    } }
    return structuredClone(snapshot)
  })
  let flow!: ReturnType<typeof useReactFlow>, store!: ReturnType<typeof useStoreApi>, active = true
  function Probe() { flow = useReactFlow(); store = useStoreApi(); return null }
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  const render = () => {
    const content = <ReactFlowProvider><Probe /><CanvasWorkspace api={api} workspace="w" title="测试" active={active} onBack={() => {}} /></ReactFlowProvider>
    root!.render(native ? <HarnessUiProvider components={harnessPrimitives}>{content}</HarnessUiProvider> : content)
  }
  await act(async () => render())
  await act(async () => vi.advanceTimersByTimeAsync(40))
  const canvas = host.querySelector<HTMLElement>('.dc-canvas-area')!, pane = host.querySelector<HTMLElement>('.react-flow__pane')!
  let hit: Element | null = pane
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: vi.fn(() => hit) })
  const mouse = async (target: EventTarget, type: string, x: number, y: number, button = 0) => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button, buttons: type === 'mouseup' ? 0 : button === 2 ? 2 : 1 })
    Object.defineProperty(event, 'view', { value: document.defaultView })
    await act(async () => target.dispatchEvent(event))
  }
  const right = async (x = 700, y = 300) => { await mouse(pane, 'mousedown', x, y, 2); await mouse(window, 'mouseup', x, y, 2) }
  const drag = async (x = 700, y = 300, beforeUp?: () => Promise<void>) => {
    const handle = host.querySelector<HTMLElement>('.react-flow__handle.source')!
    hit = handle
    await mouse(handle, 'mousedown', 315, 90)
    hit = pane; await mouse(document, 'mousemove', x, y)
    if (beforeUp) await beforeUp()
    await mouse(pane, 'mouseup', x, y)
  }
  const key = async (value: string) => act(async () => (document.activeElement ?? canvas).dispatchEvent(new KeyboardEvent('keydown', { key: value, code: value, bubbles: true, cancelable: true })))
  const clickItem = async (button: HTMLButtonElement) => {
    await mouse(button, 'pointerdown', 700, 300)
    await mouse(button, 'mousedown', 700, 300)
    await mouse(button, 'pointerup', 700, 300)
    await mouse(button, 'mouseup', 700, 300)
    await act(async () => button.click())
  }
  return { api, host, canvas, pane, source, asset, flow: () => flow, store: () => store, save, generate, ttsGenerate, mouse, right, drag, key, clickItem,
    hit: (element: Element | null) => { hit = element },
    hide: () => act(async () => { active = false; render() }),
    saveNow: () => act(async () => {
      host.querySelector<HTMLButtonElement>('[title="保存画布"]')!.click()
      await vi.waitFor(() => expect(save).toHaveBeenCalled())
    }),
  }
}

it('opens from real right mouse down/up, creates at transformed click and saves one unconnected node', async () => {
  const f = await fixture()
  await act(async () => f.flow().setViewport({ x: 100, y: -50, zoom: 2 }, { duration: 0 }))
  await f.right()
  expect(menu()?.classList.contains('dc-canvas-text-scope')).toBe(true)
  expect(menu()?.textContent).toContain('添加节点'); expect(menu()?.querySelectorAll('[role="menuitem"]')).toHaveLength(3)
  await f.clickItem(item('语音生成'))
  const node = f.flow().getNodes().find((node) => node.id !== f.source.id)!
  expect(node.position).toEqual({ x: 300, y: 175 }); expect(node.selected).toBe(true)
  expect(f.flow().getEdges()).toHaveLength(0)
  await f.saveNow()
  expect(f.save.mock.calls[0][1].nodes).toHaveLength(1); expect(f.save.mock.calls[0][1].edges).toHaveLength(0)
  expect(f.generate).not.toHaveBeenCalled(); expect(f.ttsGenerate).not.toHaveBeenCalled()
})

it.each(['图片生成', '视频生成'])('creates %s from a real pointer click after output dragging, saving node plus edge atomically', async (label) => {
  const f = await fixture(); await f.drag()
  expect(menu()?.textContent).toContain('引用该节点生成')
  expect(f.host.querySelector('.dc-pending-connection')).toBeTruthy()
  expect([...menu()!.querySelectorAll('button')].map((button) => button.textContent)).toEqual(['图片生成', '视频生成'])
  const selected = item(label)
  await f.clickItem(selected)
  await act(async () => selected.click())
  expect(menu()).toBeNull(); expect(f.flow().getNodes()).toHaveLength(2); expect(f.flow().getEdges()).toHaveLength(1)
  const node = f.flow().getNodes().find((node) => node.id !== f.source.id)!
  expect(node.position).toEqual({ x: 700, y: 300 })
  await f.saveNow()
  const mutation = f.save.mock.calls[0][1]
  expect(mutation.nodes).toHaveLength(1); expect(mutation.edges).toHaveLength(1)
  expect(mutation.edges[0].value).toMatchObject({ source: f.source.id, target: node.id, assetId: f.asset.id })
  expect(f.generate).not.toHaveBeenCalled()
})

it.each(['Escape', 'outside', 'pan', 'hide', 'source removed', 'settings'])('cancels without creating on %s', async (boundary) => {
  const f = await fixture(); await f.drag(); expect(menu()).toBeTruthy()
  if (boundary === 'Escape') await f.key('Escape')
  else if (boundary === 'outside') await act(async () => f.host.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })))
  else if (boundary === 'pan') await act(async () => f.flow().setViewport({ x: 10, y: 0, zoom: 1 }, { duration: 0 }))
  else if (boundary === 'hide') await f.hide()
  else if (boundary === 'settings') await act(async () => [...f.host.querySelectorAll<HTMLButtonElement>('.dc-header button')].find((button) => button.textContent?.includes('设置'))!.click())
  else await act(async () => f.store().getState().onNodesChange?.([{ id: f.source.id, type: 'remove' }]))
  expect(menu()).toBeNull(); expect(f.host.querySelector('.dc-pending-connection')).toBeNull()
  expect(f.flow().getEdges()).toHaveLength(0)
  expect(f.flow().getNodes().filter((node) => node.id !== f.source.id)).toHaveLength(0)
})

it('does not open a menu for right-button panning or an output released over a node/outside', async () => {
  const f = await fixture()
  await f.mouse(f.pane, 'mousedown', 700, 300, 2); await f.mouse(window, 'mousemove', 750, 350, 2); await f.mouse(window, 'mouseup', 750, 350, 2)
  expect(menu()).toBeNull()
  await f.drag(700, 300, async () => f.hit(f.host.querySelector('.react-flow__node')))
  expect(menu()).toBeNull()
  await f.drag(1500, 300)
  expect(menu()).toBeNull(); expect(f.flow().getNodes()).toHaveLength(1)
})

it('supports standalone keyboard selection and canvas focus after Escape', async () => {
  const f = await fixture(false); await f.right()
  expect(document.activeElement).toBe(item('图片生成'))
  await f.key('ArrowDown'); expect(document.activeElement).toBe(item('视频生成'))
  await f.key('Enter'); expect(f.flow().getNodes()[1].data.node.kind).toBe('video-generation')
  await f.right(); await f.key('Escape'); expect(menu()).toBeNull(); expect(document.activeElement).toBe(f.canvas)
})

it('clamps menus within the visible canvas and requires real top-level blank hits', async () => {
  const f = await fixture(), bounds = new DOMRect(400, 100, 400, 400)
  expect(pointMenuPosition({ x: 795, y: 495 }, bounds, { width: 208, height: 158 })).toEqual({ x: 584, y: 334 })
  expect(blankCanvasPoint(f.canvas, { clientX: 700, clientY: 300, target: f.pane })).toEqual({ x: 700, y: 300 })
  const modal = document.createElement('div'); document.body.append(modal); f.hit(modal)
  expect(blankCanvasPoint(f.canvas, { clientX: 700, clientY: 300, target: f.pane })).toBeUndefined()
  f.hit(null)
  expect(blankCanvasPoint(f.canvas, { clientX: 700, clientY: 300, target: f.pane })).toBeUndefined()
})

it('keeps the bottom dock registry and normal native wiring to an existing node', async () => {
  const f = await fixture()
  await act(async () => f.host.querySelector<HTMLButtonElement>('[aria-label="添加节点"]')!.click())
  const dockMenu = document.querySelector<HTMLElement>('[role="menu"]')!
  expect([...dockMenu.querySelectorAll('button')].map((button) => button.textContent)).toEqual(['图片生成', '视频生成', '语音生成'])
  await act(async () => [...dockMenu.querySelectorAll<HTMLButtonElement>('button')][0].click())
  const target = f.flow().getNodes().find((node) => node.id !== f.source.id)!
  const sourceHandle = f.host.querySelector<HTMLElement>(`.react-flow__node[data-id="${f.source.id}"] .source`)!
  const targetHandle = f.host.querySelector<HTMLElement>(`.react-flow__node[data-id="${target.id}"] .target`)!
  f.hit(sourceHandle); await f.mouse(sourceHandle, 'mousedown', 315, 90)
  f.hit(targetHandle); await f.mouse(document, 'mousemove', 660, 285); await f.mouse(targetHandle, 'mouseup', 660, 285)
  expect(f.flow().getNodes()).toHaveLength(2); expect(f.flow().getEdges()).toHaveLength(1); expect(menu()).toBeNull()
  expect(f.flow().getEdges()[0]).toMatchObject({ source: f.source.id, target: target.id, assetId: f.asset.id })
})

it('does not turn a cancelled drag into creation on the eventual mouseup', async () => {
  const f = await fixture()
  await f.drag(700, 300, async () => { await f.key('Escape') })
  expect(menu()).toBeNull(); expect(f.flow().getNodes()).toHaveLength(1); expect(f.flow().getEdges()).toHaveLength(0)
})

it('leaves no empty menu or temporary wire when no creation type accepts the output', async () => {
  const f = await fixture(true, 'image/gif')
  await f.drag()
  expect(menu()).toBeNull(); expect(f.host.querySelector('.dc-pending-connection')).toBeNull()
  expect(f.flow().getNodes()).toHaveLength(1); expect(f.flow().getEdges()).toHaveLength(0)
  expect(f.save).not.toHaveBeenCalled(); expect(f.generate).not.toHaveBeenCalled()
  await f.right()
  expect([...menu()!.querySelectorAll('button')].map((button) => button.textContent)).toEqual(['图片生成', '视频生成', '语音生成'])
})
