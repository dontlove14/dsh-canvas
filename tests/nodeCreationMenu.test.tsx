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
import { emptyGraph, capabilitiesFor, defaultParams, type Asset, type CanvasNode, type PublicModel } from '../src/shared/contracts'
import { BUILTIN_MODELS } from '../src/shared/modelCatalog'
import type { CanvasSnapshot } from '../src/shared/v2'
import { harnessPrimitives } from './support/harnessPrimitives'
import { copyCanvasNodes } from '../src/client/nodeClipboard'

vi.mock('../src/client/useGpu', () => ({ useGpuCapability: () => ({ enabled: false, reason: 'test' }) }))
let root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined
  document.body.replaceChildren(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals()
  delete (navigator as any).clipboard
})
const menu = () => document.querySelector<HTMLElement>('.dc-node-creation-menu')
const item = (text: string) => [...menu()!.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === text)!

async function fixture(native = true, mime = 'image/png', sourceCount = 1, customize?: (snapshot: CanvasSnapshot) => PublicModel[]) {
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
  const sources = [source], assets = [asset]
  for (let i = 1; i < sourceCount; i++) {
    const node = { ...source, id: crypto.randomUUID(), assetId: crypto.randomUUID(), position: { x: i * 340, y: 0 } }
    sources.push(node); assets.push({ ...asset, id: node.assetId, nodeId: node.id, filename: `来源${i}.png` })
  }
  let snapshot: CanvasSnapshot = { version: 1, workspaceId: 'w', graphRevision: 1, graph: { ...emptyGraph(), nodes: sources }, assets,
    tasks: [], updatedAt: 1, commitHash: 'a'.repeat(64), hashes: { nodes: {}, edges: {}, viewport: '' } }
  const models = customize?.(snapshot) ?? []
  const api = new CanvasApi()
  vi.spyOn(api, 'state').mockImplementation(async () => structuredClone(snapshot))
  vi.spyOn(api, 'models').mockResolvedValue(models); vi.spyOn(api, 'ttsSettings').mockResolvedValue({ has_api_key: false } as any)
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
  return { api, host, canvas, pane, source, asset, sources, assets, flow: () => flow, store: () => store, save, generate, ttsGenerate, mouse, right, drag, key, clickItem,
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
  expect(menu()?.textContent).toContain('添加节点'); expect(menu()?.querySelectorAll('[role="menuitem"]')).toHaveLength(4)
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
  expect([...menu()!.querySelectorAll('button')].map((button) => button.textContent)).toEqual(['图片生成', '视频生成', '语音生成', expect.stringContaining('粘贴')])
})

async function addTarget(f: Awaited<ReturnType<typeof fixture>>) {
  await f.right()
  await f.clickItem(item('图片生成'))
  return f.flow().getNodes().find((node) => !f.sources.some((source) => source.id === node.id) && node.type === 'media')!
}
it('connects a real output released on a target body, saves only the reference and preserves handle wiring', async () => {
  const f = await fixture(), target = await addTarget(f)
  await f.saveNow(); f.save.mockClear()
  const body = f.host.querySelector<HTMLElement>(`.react-flow__node[data-id="${target.id}"] .dc-generation-empty`)!
  await f.drag(700, 300, async () => f.hit(body))
  expect(f.flow().getEdges()).toHaveLength(1); expect(menu()).toBeNull()
  await f.saveNow()
  expect(f.save.mock.calls[0][1].nodes).toHaveLength(0)
  expect(f.save.mock.calls[0][1].edges.map((entry) => entry.value)).toEqual([
    expect.objectContaining({ source: f.source.id, target: target.id, assetId: f.asset.id }),
  ])
  expect(f.generate).not.toHaveBeenCalled()
})
it.each(['body', 'handle'])('connects a real group output to a target %s once, persists all references together and downloads ready media only', async (ending) => {
  const f = await fixture(true, 'image/png', 2), target = await addTarget(f)
  await f.saveNow(); f.save.mockClear()
  await act(async () => f.store().getState().addSelectedNodes(f.sources.map((node) => node.id)))
  await act(async () => vi.advanceTimersByTimeAsync(40))
  const group = f.flow().getNodes().find((node) => node.type === 'selection')!
  expect(group).toMatchObject({ selected: false, selectable: false, draggable: false, deletable: false })
  const toolbar = document.querySelector<HTMLElement>('[aria-label="框选操作"]')!
  expect(toolbar.classList.contains('dc-canvas-text-scope')).toBe(true)
  expect([...toolbar.querySelectorAll('button')].map((button) => button.textContent)).toEqual(['下载'])
  const downloaded: string[] = []
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () { downloaded.push(this.download) })
  await act(async () => toolbar.querySelector<HTMLButtonElement>('button')!.click())
  expect(downloaded).toEqual(f.assets.map((asset) => asset.filename))
  const handle = f.host.querySelector<HTMLElement>('.dc-selection-handle')!
  const hit = f.host.querySelector<HTMLElement>(`.react-flow__node[data-id="${target.id}"] ${ending === 'body' ? '.dc-generation-empty' : '.target'}`)!
  f.hit(handle); await f.mouse(handle, 'pointerdown', 315, 90); await f.mouse(handle, 'mousedown', 315, 90)
  f.hit(hit); await f.mouse(document, 'mousemove', 700, 300); await f.mouse(hit, 'pointerup', 700, 300); await f.mouse(hit, 'mouseup', 700, 300)
  expect(f.flow().getEdges().map((edge) => edge.source)).toEqual(f.sources.map((node) => node.id)); expect(menu()).toBeNull()
  await f.saveNow()
  const mutation = f.save.mock.calls[0][1]
  expect(mutation.nodes).toHaveLength(0); expect(mutation.edges).toHaveLength(2)
  expect(mutation.edges.every((entry) => entry.value.target === target.id)).toBe(true)
  expect(f.flow().getNodes().filter((node) => node.type === 'media')).toHaveLength(3)
  expect(f.generate).not.toHaveBeenCalled()
})
it.each(['Escape', 'outside', 'controls'])('does not connect or create after group %s release', async (boundary) => {
  const f = await fixture(true, 'image/png', 2), target = await addTarget(f)
  await act(async () => f.store().getState().addSelectedNodes(f.sources.map((node) => node.id)))
  await act(async () => vi.advanceTimersByTimeAsync(40))
  const handle = f.host.querySelector<HTMLElement>('.dc-selection-handle')!
  f.hit(handle); await f.mouse(handle, 'mousedown', 315, 90)
  const body = f.host.querySelector<HTMLElement>(`.react-flow__node[data-id="${target.id}"] .dc-generation-empty`)!
  f.hit(boundary === 'controls' ? f.host.querySelector('.dc-tools button') : body)
  await f.mouse(document, 'mousemove', 700, 300)
  if (boundary === 'Escape') await f.key('Escape')
  await f.mouse(f.pane, 'mouseup', boundary === 'outside' ? 1500 : 700, 300)
  expect(f.flow().getEdges()).toHaveLength(0); expect(menu()).toBeNull()
  expect(f.flow().getNodes().filter((node) => node.type === 'media')).toHaveLength(3)
})
it('preserves native reverse handle wiring and does not create a blank menu', async () => {
  const f = await fixture(), target = await addTarget(f)
  await act(async () => vi.advanceTimersByTimeAsync(40))
  const input = f.host.querySelector<HTMLElement>(`.react-flow__node[data-id="${target.id}"] .target`)!
  const output = f.host.querySelector<HTMLElement>(`.react-flow__node[data-id="${f.source.id}"] .source`)!
  f.hit(input); await f.mouse(input, 'mousedown', 315, 90)
  f.hit(output); await f.mouse(document, 'mousemove', 660, 285); await f.mouse(output, 'mouseup', 660, 285)
  expect(f.flow().getEdges()).toHaveLength(1)
  expect(f.flow().getEdges()[0]).toMatchObject({ source: f.source.id, target: target.id, assetId: f.asset.id })
  expect(menu()).toBeNull(); expect(f.generate).not.toHaveBeenCalled()
})

function clipboardEvent(type: 'copy' | 'paste', text = '') {
  let value = text
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: {
    setData: vi.fn((_format: string, content: string) => { value = content }),
    getData: vi.fn(() => value),
  } })
  return { event, text: () => value }
}
const actionItem = (label: string) => [...menu()!.querySelectorAll<HTMLButtonElement>('button')]
  .find((button) => button.textContent?.startsWith(label))!
async function selectSources(f: Awaited<ReturnType<typeof fixture>>) {
  await act(async () => f.store().getState().addSelectedNodes(f.sources.map((node) => node.id)))
  await act(async () => vi.advanceTimersByTimeAsync(40))
  f.canvas.focus()
}
it('uses native copy/paste events for a selected batch, centers without a pointer, offsets repeats and saves once', async () => {
  const f = await fixture(true, 'image/png', 2)
  await selectSources(f)
  const copied = clipboardEvent('copy')
  await act(async () => f.canvas.dispatchEvent(copied.event))
  expect(copied.event.defaultPrevented).toBe(true)
  expect(JSON.parse(copied.text()).nodes).toHaveLength(2)
  expect(f.host.querySelector('.dc-notification-capsule[data-tone="success"][role="status"]')?.textContent).toContain('已复制 2 个节点')
  expect(f.host.querySelector('.dc-notification-capsule[role="alert"]')).toBeNull()
  const pasted = clipboardEvent('paste', copied.text())
  await act(async () => f.canvas.dispatchEvent(pasted.event))
  const first = f.flow().getNodes().filter((node) => node.type === 'media' && !f.sources.some((source) => source.id === node.id))
  expect(first).toHaveLength(2); expect(first.every((node) => node.selected)).toBe(true)
  const bounds = JSON.parse(copied.text()).bounds
  expect(first[0].position).toEqual({ x: 500 - bounds.width / 2, y: 350 - bounds.height / 2 })
  await act(async () => f.canvas.dispatchEvent(clipboardEvent('paste', copied.text()).event))
  const second = f.flow().getNodes().filter((node) => node.type === 'media' && !f.sources.some((source) => source.id === node.id) && !first.some((old) => old.id === node.id))
  expect(second[0].position).toEqual({ x: first[0].position.x + 32, y: first[0].position.y + 32 })
  expect(second.every((node) => node.selected)).toBe(true)
  await f.saveNow()
  expect(f.save.mock.calls[0][1].nodes).toHaveLength(4)
  expect(f.save.mock.calls[0][1].edges).toHaveLength(0)
  expect(f.generate).not.toHaveBeenCalled(); expect(f.ttsGenerate).not.toHaveBeenCalled()
})
it('places keyboard paste at the latest canvas pointer under pan and zoom', async () => {
  const f = await fixture()
  await selectSources(f)
  await act(async () => f.flow().setViewport({ x: 100, y: -50, zoom: 2 }, { duration: 0 }))
  await f.mouse(f.pane, 'pointermove', 700, 300)
  const copy = clipboardEvent('copy')
  await act(async () => f.canvas.dispatchEvent(copy.event))
  await act(async () => f.canvas.dispatchEvent(clipboardEvent('paste', copy.text()).event))
  expect(f.flow().getNodes().find((node) => node.id !== f.source.id)!.position).toEqual({ x: 300, y: 175 })
})
it.each(['input', 'textarea', 'contenteditable', 'selectable', 'outside'])('keeps native text clipboard behavior inside %s', async (boundary) => {
  const f = await fixture(); await selectSources(f)
  const target = document.createElement(boundary === 'input' || boundary === 'textarea' ? boundary : 'div')
  if (boundary === 'contenteditable') target.setAttribute('contenteditable', 'true')
  if (boundary === 'selectable') target.dataset.dcTextSelectable = 'true'
  ;(boundary === 'outside' ? document.body : f.canvas).append(target)
  const copy = clipboardEvent('copy'), paste = clipboardEvent('paste', copyCanvasNodes({ ...emptyGraph(), nodes: [f.source] }, [f.source.id], 'w', location.origin))
  await act(async () => { target.dispatchEvent(copy.event); target.dispatchEvent(paste.event) })
  expect(copy.event.defaultPrevented).toBe(false); expect(paste.event.defaultPrevented).toBe(false)
  expect(f.flow().getNodes()).toHaveLength(1); expect(f.save).not.toHaveBeenCalled()
})
it('copies from a node card and pastes at a blank-menu point using the current system clipboard', async () => {
  const f = await fixture()
  let text = ''
  const writeText = vi.fn(async (value: string) => { text = value }), readText = vi.fn(async () => text)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText, readText } })
  const node = f.host.querySelector<HTMLElement>('.react-flow__node')!
  await f.mouse(node, 'contextmenu', 100, 100, 2)
  expect(menu()?.textContent).toContain('节点操作')
  expect(menu()?.classList.contains('dc-canvas-text-scope')).toBe(true)
  await f.clickItem(actionItem('复制'))
  expect(writeText).toHaveBeenCalledTimes(1); expect(JSON.parse(text).nodes[0].id).toBe(f.source.id)
  expect(f.host.querySelector('.dc-notification-capsule[data-tone="success"][role="status"]')?.textContent).toContain('已复制 1 个节点')
  await f.right()
  const paste = actionItem('粘贴'); expect(paste.disabled).toBe(false)
  await f.clickItem(paste); await act(async () => paste.click())
  expect(f.flow().getNodes()).toHaveLength(2); expect(menu()).toBeNull()
  expect(f.flow().getNodes()[1].position).toEqual({ x: 700, y: 300 })
  await f.saveNow(); expect(f.save.mock.calls[0][1].nodes).toHaveLength(1)
  expect(f.generate).not.toHaveBeenCalled()
})
it.each(['node', 'padding'])('copies the existing selected batch from group %s right-click', async (surface) => {
  const f = await fixture(true, 'image/png', 2); await selectSources(f)
  const writeText = vi.fn(async (_value: string) => {})
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  if (surface === 'node') await f.mouse(f.host.querySelector<HTMLElement>('.react-flow__node')!, 'contextmenu', 100, 100, 2)
  else await f.right(10, 10)
  expect(menu()?.textContent).toContain('节点操作')
  await f.clickItem(actionItem('复制'))
  expect(JSON.parse(writeText.mock.calls[0][0] as unknown as string).nodes).toHaveLength(2)
  expect(f.save).not.toHaveBeenCalled()
})
it.each(['outside', 'hide', 'new action', 'Escape'])('discards a late clipboard menu read after %s', async (boundary) => {
  const f = await fixture()
  const text = copyCanvasNodes({ ...emptyGraph(), nodes: [f.source] }, [f.source.id], 'w', location.origin)
  let reads = 0, resolve!: (value: string) => void
  const readText = vi.fn(() => ++reads === 1 ? Promise.resolve(text) : new Promise<string>((done) => { resolve = done }))
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText } })
  await f.right(); await f.clickItem(actionItem('粘贴'))
  expect(menu()).toBeNull()
  if (boundary === 'outside') await f.mouse(f.pane, 'pointerdown', 800, 500)
  if (boundary === 'hide') await f.hide()
  if (boundary === 'new action') {
    const copy = clipboardEvent('copy'); await selectSources(f); await act(async () => f.canvas.dispatchEvent(copy.event))
  }
  if (boundary === 'Escape') await f.key('Escape')
  await act(async () => resolve(text))
  expect(f.flow().getNodes()).toHaveLength(1); expect(f.save).not.toHaveBeenCalled()
})
it('never uses an earlier node copy when the system clipboard changes or cannot be read', async () => {
  const f = await fixture()
  const valid = copyCanvasNodes({ ...emptyGraph(), nodes: [f.source] }, [f.source.id], 'w', location.origin)
  let text = valid
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: vi.fn(async () => text) } })
  await f.right(); expect(actionItem('粘贴').disabled).toBe(false)
  text = 'ordinary text'
  await f.clickItem(actionItem('粘贴'))
  expect(f.flow().getNodes()).toHaveLength(1)
  await f.right(); expect(actionItem('粘贴').disabled).toBe(true)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: vi.fn().mockRejectedValue(new DOMException('Denied', 'NotAllowedError')) } })
  await f.right(); expect(actionItem('粘贴').disabled).toBe(true)
  expect(actionItem('粘贴').querySelector('[title]')?.getAttribute('title')).toContain('Command/Ctrl')
})
it('preserves actual video frame roles and prompt while saving fresh draft plus original-source references in one mutation', async () => {
  let target!: CanvasNode
  const f = await fixture(true, 'image/png', 2, (snapshot) => {
    const record = BUILTIN_MODELS.find((model) => model.protocol === 'seedance-video')!
    const model: PublicModel = { ...record, has_api_key: true, api_key_mask: '', capabilities: capabilitiesFor(record) }
    const [a, b] = snapshot.graph.nodes
    target = { ...a, id: crypto.randomUUID(), kind: 'video-generation', title: '视频', modelId: model.id, assetId: null,
      position: { x: 700, y: 400 }, params: { ...defaultParams(model), videoMode: 'frames', firstFrameId: b.assetId!, lastFrameId: a.assetId! },
      prompt: `保留 @[${a.assetId}] 与 @[${b.assetId}]` }
    snapshot.graph = { ...snapshot.graph, nodes: [...snapshot.graph.nodes, target], edges: [
      { id: crypto.randomUUID(), source: a.id, target: target.id, assetId: a.assetId! },
      { id: crypto.randomUUID(), source: b.id, target: target.id, assetId: b.assetId! },
    ] }
    return [model]
  })
  await act(async () => f.store().getState().addSelectedNodes([target.id]))
  f.canvas.focus()
  const copy = clipboardEvent('copy')
  await act(async () => f.canvas.dispatchEvent(copy.event))
  await act(async () => f.canvas.dispatchEvent(clipboardEvent('paste', copy.text()).event))
  const pasted = f.flow().getNodes().find((node) => node.type === 'media' && ![...f.sources.map((node) => node.id), target.id].includes(node.id))!
  expect(pasted.data.node).toMatchObject({ prompt: target.prompt, params: target.params, selectedResultId: null, assetId: null })
  await f.saveNow()
  const mutation = f.save.mock.calls[0][1]
  expect(mutation.nodes).toHaveLength(1); expect(mutation.nodes[0].value.params).toEqual(target.params)
  expect(mutation.edges.map((entry) => [entry.value.source, entry.value.target, entry.value.assetId])).toEqual(
    f.sources.map((node) => [node.id, pasted.id, node.assetId]))
  expect(mutation.deleteNodes).toEqual([]); expect(mutation.deleteEdges).toEqual([])
  expect(f.generate).not.toHaveBeenCalled()
})
it('suppresses a node context menu after right-button dragging', async () => {
  const f = await fixture(), node = f.host.querySelector<HTMLElement>('.react-flow__node')!
  await f.mouse(node, 'mousedown', 100, 100, 2)
  await f.mouse(document, 'mousemove', 160, 100, 2)
  await f.mouse(window, 'mouseup', 160, 100, 2)
  await f.mouse(node, 'contextmenu', 160, 100, 2)
  expect(menu()).toBeNull(); expect(f.save).not.toHaveBeenCalled()
})
