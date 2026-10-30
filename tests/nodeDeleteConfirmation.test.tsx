// @vitest-environment jsdom
import { webcrypto } from 'node:crypto'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ReactFlowProvider, useReactFlow, useStoreApi } from '@xyflow/react'
import { afterEach, expect, it, vi } from 'vitest'
import { CanvasWorkspace } from '../src/client/Canvas'
import { CanvasApi } from '../src/client/api'
import { HarnessUiProvider } from '../src/client/ui'
import { emptyGraph, type Asset, type CanvasNode } from '../src/shared/contracts'
import type { CanvasSnapshot, TaskSummary } from '../src/shared/v2'
import { harnessPrimitives } from './support/harnessPrimitives'

// Real workspace, XYFlow keyboard/deleteElements, graph saving and submission
// guards. Only browser geometry, API transport and the Harness loader are fixtures.
vi.mock('../src/client/useGpu', () => ({ useGpuCapability: () => ({ enabled: false, reason: 'test' }) }))
let root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined
  document.body.replaceChildren(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')
const button = (text: string) => [...dialog()!.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === text)!
async function fixture(mentioned = false) {
  vi.useFakeTimers()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal('ResizeObserver', class {
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: Element) { this.callback([{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry], this as unknown as ResizeObserver) }
    unobserve() {}; disconnect() {}
  })
  vi.stubGlobal('IntersectionObserver', class { observe() {}; disconnect() {} })
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(1000)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(700)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1000, 700))
  vi.stubGlobal('DOMMatrixReadOnly', class { m22 = 1 })
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  const nodes: CanvasNode[] = [0, 1, 2].map((index) => ({
    id: crypto.randomUUID(), kind: index < 2 ? 'image-asset' : 'image-generation', title: `节点${index}`,
    position: { x: index * 330, y: 0 }, prompt: '', params: null, modelId: null, assetId: null, selectedResultId: null,
  }))
  const assets: Asset[] = nodes.map((node, index) => ({
    id: crypto.randomUUID(), nodeId: node.id, taskId: index === 2 ? 'result-task' : undefined,
    kind: 'image', mime: 'image/png', filename: `素材${index}.png`, bytes: 100, width: 320, height: 180, createdAt: 1,
  }))
  nodes[0].assetId = assets[0].id; nodes[1].assetId = assets[1].id
  const task: TaskSummary = { id: 'result-task', nodeId: nodes[2].id, workspaceId: 'w', status: 'completed',
    resultIds: [assets[2].id], createdAt: 1, updatedAt: 1 }
  const edges = [0, 1].map((index) => ({ id: crypto.randomUUID(), source: nodes[index].id, target: nodes[2].id, assetId: assets[index].id }))
  if (mentioned) nodes[2].prompt = `参考 {{asset:${assets[0].id}}}，保留文字。`
  let snapshot: CanvasSnapshot = { version: 1, workspaceId: 'w', graphRevision: 1, graph: { ...emptyGraph(), nodes, edges },
    assets, tasks: [task], updatedAt: 1, commitHash: 'a'.repeat(64), hashes: { nodes: {}, edges: {}, viewport: '' } }
  const api = new CanvasApi()
  vi.spyOn(api, 'state').mockImplementation(async () => structuredClone(snapshot))
  vi.spyOn(api, 'models').mockResolvedValue([])
  vi.spyOn(api, 'ttsSettings').mockResolvedValue({ has_api_key: false } as any)
  vi.spyOn(api, 'reviewSettings').mockResolvedValue({ profiles: [] })
  vi.spyOn(api, 'mediaUrls').mockImplementation(async (_canvas, items) => ({ items: items.map((item) => ({
    ...item, url: `https://fixture.invalid/${item.assetId}`, expiresAt: Date.now() + 3600000,
  })) }))
  const save = vi.spyOn(api, 'save').mockImplementation(async (_workspace, mutation) => {
    snapshot = { ...snapshot, graphRevision: snapshot.graphRevision + 1, graph: { ...snapshot.graph,
      nodes: snapshot.graph.nodes.filter((node) => !mutation.deleteNodes.includes(node.id))
        .map((node) => mutation.nodes.find((item) => item.value.id === node.id)?.value ?? node),
      edges: snapshot.graph.edges.filter((edge) => !mutation.deleteEdges.includes(edge.id)),
      viewport: mutation.viewport?.value ?? snapshot.graph.viewport,
    } }
    return structuredClone(snapshot)
  })
  const confirm = vi.spyOn(window, 'confirm')
  const generate = vi.spyOn(api, 'generate'), ttsGenerate = vi.spyOn(api, 'ttsGenerate')
  let flow!: ReturnType<typeof useReactFlow>, active = true, workspace = 'w'
  let store!: ReturnType<typeof useStoreApi>
  function Probe() { flow = useReactFlow(); store = useStoreApi(); return null }
  const host = document.createElement('div'); document.body.append(host)
  root = createRoot(host)
  const render = () => root!.render(<HarnessUiProvider components={harnessPrimitives}><ReactFlowProvider>
    <Probe /><CanvasWorkspace api={api} workspace={workspace} title="测试" active={active} onBack={() => {}} />
  </ReactFlowProvider></HarnessUiProvider>)
  await act(async () => render())
  act(() => store.setState({ width: 1000, height: 700 }))
  await act(async () => vi.advanceTimersByTimeAsync(40))
  const canvas = host.querySelector<HTMLElement>('.dc-canvas-area')!
  act(() => canvas.focus())
  const request = async (ids = [nodes[0].id]) => {
    let promise!: ReturnType<typeof flow.deleteElements>
    await act(async () => { promise = flow.deleteElements({ nodes: ids.map((id) => ({ id })) }) })
    return { promise }
  }
  const key = async (key: string, target: Element = canvas) => {
    await act(async () => target.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true })))
    await act(async () => target.dispatchEvent(new KeyboardEvent('keyup', { key, code: key, bubbles: true, cancelable: true })))
  }
  return { host, canvas, nodes, assets, edges, task, save, confirm, generate, ttsGenerate, request, key,
    flow: () => flow, store: () => store, state: () => snapshot,
    poll: () => act(async () => vi.advanceTimersByTimeAsync(2000)),
    saveNow: () => act(async () => host.querySelector<HTMLButtonElement>('[title="保存画布"]')!.click()),
    update: (tasks: TaskSummary[]) => { snapshot = { ...snapshot, tasks } },
    changeEdges: () => { snapshot = { ...snapshot, graphRevision: snapshot.graphRevision + 1,
      graph: { ...snapshot.graph, edges: snapshot.graph.edges.map((edge) => ({ ...edge, assetId: assets[1].id })) } } },
    hide: () => act(async () => { active = false; render() }),
    switchWorkspace: () => act(async () => { workspace = 'other'; render() }),
  }
}

it.each(['取消', 'Escape', '关闭'])('cancels through Harness %s, restores canvas focus and never calls browser confirm', async (action) => {
  const f = await fixture(), { promise } = await f.request()
  expect(dialog()?.getAttribute('aria-label')).toBe('删除节点')
  expect(dialog()?.classList.contains('dc-native-modal')).toBe(true)
  expect(document.activeElement).toBe(button('取消'))
  expect(dialog()?.textContent).toContain('本地媒体和下游结果会保留。')
  if (action === 'Escape') await f.key('Escape', button('取消'))
  else await act(async () => (action === '关闭' ? dialog()!.querySelector<HTMLButtonElement>('[aria-label="关闭"]')! : button(action)).click())
  expect(await promise).toEqual({ deletedNodes: [], deletedEdges: [] })
  expect(dialog()).toBeNull(); expect(document.activeElement).toBe(f.canvas)
  expect(f.flow().getNodes()).toHaveLength(3); expect(f.save).not.toHaveBeenCalled(); expect(f.confirm).not.toHaveBeenCalled()
})

it('confirms a multi-node native deletion, removes connected edges and saves without deleting media or downstream results', async () => {
  const f = await fixture(), { promise } = await f.request(f.nodes.slice(0, 2).map((node) => node.id))
  expect(dialog()?.textContent).toContain('删除 2 个节点')
  await act(async () => button('删除').click())
  const result = await promise
  expect(result.deletedNodes.map((node) => node.id)).toEqual(f.nodes.slice(0, 2).map((node) => node.id))
  expect(result.deletedEdges.map((edge) => edge.id)).toEqual(f.edges.map((edge) => edge.id))
  expect(f.flow().getNodes().map((node) => node.id)).toEqual([f.nodes[2].id])
  expect(f.flow().getEdges()).toHaveLength(0)
  await f.saveNow()
  expect(f.save.mock.calls[0][1].deleteNodes).toEqual(f.nodes.slice(0, 2).map((node) => node.id))
  expect(f.state().graph.edges).toHaveLength(0)
  expect(f.state().assets).toEqual(f.assets); expect(f.state().tasks).toEqual([f.task])
  expect(f.confirm).not.toHaveBeenCalled(); expect(f.generate).not.toHaveBeenCalled(); expect(f.ttsGenerate).not.toHaveBeenCalled()
})

it.each(['Delete', 'Backspace'])('opens the Harness modal from real %s selection but leaves editable input keys alone', async (key) => {
  const f = await fixture()
  await act(async () => f.host.querySelector<HTMLElement>(`.react-flow__node[data-id="${f.nodes[0].id}"]`)!.click())
  expect(f.flow().getNodes()[0].selected).toBe(true)
  const field = document.createElement('input'); f.canvas.append(field); field.focus()
  await f.key(key, field); expect(dialog()).toBeNull()
  f.canvas.focus(); await f.key(key)
  expect(dialog()).toBeTruthy()
  await act(async () => button('删除').click())
  expect(f.flow().getNodes().some((node) => node.id === f.nodes[0].id)).toBe(false)
  expect(f.confirm).not.toHaveBeenCalled()
})

it.each(['before', 'while open'])('blocks native deletion when a tracked task arrives %s confirmation', async (when) => {
  const f = await fixture()
  const busy: TaskSummary = { ...f.task, id: 'busy', nodeId: f.nodes[0].id, status: 'generating', resultIds: [] }
  let promise: ReturnType<ReturnType<typeof useReactFlow>['deleteElements']>
  if (when === 'before') {
    f.update([f.task, busy]); await f.poll()
    promise = (await f.request()).promise
    expect(dialog()).toBeNull()
  } else {
    promise = (await f.request()).promise
    f.update([f.task, busy]); await f.poll()
    await act(async () => button('删除').click())
  }
  expect(await promise).toEqual({ deletedNodes: [], deletedEdges: [] })
  expect(f.flow().getNodes()).toHaveLength(3)
  expect(f.host.querySelector('[role="alert"]')?.textContent).toContain('选中的节点有未结束任务')
  expect(f.save).not.toHaveBeenCalled()
})

it('rejects a repeated deletion while the first modal is pending and keeps its original candidate', async () => {
  const f = await fixture(), first = await f.request(), second = await f.request([f.nodes[1].id])
  expect(await second.promise).toEqual({ deletedNodes: [], deletedEdges: [] })
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
  await act(async () => button('删除').click())
  expect((await first.promise).deletedNodes.map((node) => node.id)).toEqual([f.nodes[0].id])
  expect(f.flow().getNodes().some((node) => node.id === f.nodes[1].id)).toBe(true)
})

it.each(['hidden tab', 'hidden page', 'unmount', 'workspace change'])('settles pending deletion without changes on %s', async (boundary) => {
  const f = await fixture(), { promise } = await f.request()
  if (boundary === 'hidden tab') await f.hide()
  else if (boundary === 'hidden page') {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  } else if (boundary === 'unmount') await act(async () => { root!.unmount(); root = undefined })
  else await f.switchWorkspace()
  expect(await promise).toEqual({ deletedNodes: [], deletedEdges: [] })
  expect(dialog()).toBeNull(); expect(f.save).not.toHaveBeenCalled()
})

it('retains edge-only deletion without a modal, and rejects requests with focus outside the canvas', async () => {
  const f = await fixture()
  let result!: Awaited<ReturnType<ReturnType<typeof useReactFlow>['deleteElements']>>
  await act(async () => { result = await f.flow().deleteElements({ edges: [{ id: f.edges[0].id }] }) })
  expect(result.deletedEdges.map((edge) => edge.id)).toEqual([f.edges[0].id])
  expect(f.flow().getNodes()).toHaveLength(3); expect(dialog()).toBeNull()
  f.host.querySelector<HTMLButtonElement>('.dc-header button')!.focus()
  expect(await (await f.request()).promise).toEqual({ deletedNodes: [], deletedEdges: [] })
  expect(dialog()).toBeNull(); expect(f.confirm).not.toHaveBeenCalled()
})

it.each(['Delete', 'Backspace'])('focuses a clicked edge and removes only its reference using real %s', async (key) => {
  const f = await fixture()
  await act(async () => f.host.querySelector<HTMLElement>(`.react-flow__node[data-id="${f.nodes[0].id}"]`)!.click())
  f.host.querySelector<HTMLButtonElement>('.dc-header button')!.focus()
  await act(async () => f.host.querySelector<HTMLElement>(`.react-flow__edge[data-id="${f.edges[0].id}"]`)!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  expect(document.activeElement).toBe(f.canvas)
  expect(f.flow().getNodes().some((node) => node.selected)).toBe(false)
  expect(f.host.querySelector(`.react-flow__edge[data-id="${f.edges[0].id}"] .dc-edge-flow`)).toBeTruthy()
  expect(f.host.querySelector(`.react-flow__edge[data-id="${f.edges[1].id}"] .dc-edge-flow`)).toBeNull()
  await f.key(key)
  expect(dialog()).toBeNull()
  expect(f.flow().getEdges().map((edge) => edge.id)).toEqual([f.edges[1].id])
  expect(f.flow().getNodes()).toHaveLength(3)
  expect(f.host.querySelector('.dc-edge-flow')).toBeNull()
  await f.saveNow()
  expect(f.save.mock.calls[0][1].deleteEdges).toEqual([f.edges[0].id]); expect(f.save.mock.calls[0][1].deleteNodes).toEqual([])
})
it.each(['取消', '删除', 'Escape', 'changed identity'])('requires exact prompt mention confirmation and handles %s without rewriting prompt or media', async (action) => {
  const f = await fixture(true)
  let promise!: ReturnType<ReturnType<typeof useReactFlow>['deleteElements']>
  await act(async () => { promise = f.flow().deleteElements({ edges: f.edges.map((edge) => ({ id: edge.id })) }) })
  expect(dialog()?.getAttribute('aria-label')).toBe('删除连线')
  expect(dialog()?.textContent).toContain('有 1 条被提示词 @ 引用')
  if (action === 'Escape') await f.key('Escape', button('取消'))
  else {
    if (action === 'changed identity') { f.changeEdges(); await f.poll() }
    await act(async () => button(action === '取消' ? '取消' : '删除').click())
  }
  expect((await promise).deletedEdges).toHaveLength(action === '删除' ? 2 : 0)
  expect(f.flow().getNodes()).toHaveLength(3)
  if (action === '删除') {
    await f.saveNow()
    expect(f.save.mock.calls[0][1].nodes).toHaveLength(0)
    expect(f.state().graph.nodes[2].prompt).toBe(f.nodes[2].prompt)
    expect(f.state().assets).toEqual(f.assets); expect(f.state().tasks).toEqual([f.task])
  }
  expect(f.confirm).not.toHaveBeenCalled(); expect(f.generate).not.toHaveBeenCalled()
})
it('deletes an unmentioned edge immediately even if a different connected asset is mentioned', async () => {
  const f = await fixture(true)
  await act(async () => { await f.flow().deleteElements({ edges: [{ id: f.edges[1].id }] }) })
  expect(dialog()).toBeNull()
  expect(f.flow().getEdges().map((edge) => edge.id)).toEqual([f.edges[0].id])
})
