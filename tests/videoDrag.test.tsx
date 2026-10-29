// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ReactFlowProvider } from '@xyflow/react'
import { XYDrag, type InternalNodeBase, type NodeBase } from '@xyflow/system'
import { afterEach, expect, it, vi } from 'vitest'
import { ResourceNode } from '../src/client/ResourceNode'
import { GenerationNode } from '../src/client/GenerationNode'
import { HistoryNode } from '../src/client/HistoryNode'
import { CanvasApi } from '../src/client/api'
import type { Asset, CanvasNode } from '../src/shared/contracts'
import type { TaskSummary } from '../src/shared/v2'

let root: Root | undefined
let driver: ReturnType<typeof XYDrag> | undefined
afterEach(() => {
  driver?.destroy(); driver = undefined
  act(() => root?.unmount()); root = undefined
  document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

it.each([
  ['resource', 1], ['generation', 2], ['history-collapsed', 1], ['history-expanded', 2],
] as const)('drags a playing %s video at zoom%s while preserving playback and isolating controls', async (branch, zoom) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private notify: (entries: Array<{ isIntersecting: boolean }>) => void) {}
    observe() { this.notify([{ isIntersecting: true }]) }; disconnect() {}
  })
  const paused = new WeakMap<HTMLMediaElement, boolean>()
  vi.spyOn(HTMLMediaElement.prototype, 'paused', 'get').mockImplementation(function () { return paused.get(this) ?? true })
  const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async function () {
    paused.set(this, false); this.dispatchEvent(new Event('play'))
  })
  const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function () {
    if (paused.get(this) === false) { paused.set(this, true); this.dispatchEvent(new Event('pause')) }
  })
  const api = new CanvasApi()
  vi.spyOn(api, 'mediaUrls').mockImplementation(async (_canvas, items) => ({
    items: items.map((item) => ({ ...item, url: `https://assets.example/${item.assetId}/${item.variant}`, expiresAt: Date.now() + 3600000 })),
  }))
  const asset: Asset = { id: crypto.randomUUID(), nodeId: 'node', taskId: 'task', kind: 'video', mime: 'video/mp4',
    filename: 'clip.mp4', bytes: 100, duration: 10, width: 320, height: 180, createdAt: 1 }
  let node: CanvasNode = { id: 'node', kind: branch === 'resource' ? 'video-asset' : 'video-generation',
    title: '视频', position: { x: 0, y: 0 }, assetId: branch === 'resource' ? asset.id : null, selectedResultId: null,
    modelId: null, params: null, prompt: '' }
  const task: TaskSummary = { id: 'task', nodeId: node.id, workspaceId: 'w', status: 'completed', resultIds: [asset.id], createdAt: 1, updatedAt: 1 }
  const oldAsset = { ...asset, id: crypto.randomUUID(), taskId: 'old-task' }
  const cards = [
    { task, results: [asset] },
    { task: { ...task, id: 'old-task', resultIds: [oldAsset.id], createdAt: 0 }, results: [oldAsset] },
  ]
  const results = [asset]
  let selected = false, playing = false
  const onStop = vi.fn(), onOpen = vi.fn(), onFocus = vi.fn(), onInspect = vi.fn()
  const noop = () => {}
  const onPlay = vi.fn(() => { selected = true; playing = true; root!.render(view()) })
  const nodeClick = vi.fn()
  const common = { api, workspace: 'w', onPlay, onStop, onRename: noop, onOpen, onSize: noop }
  const view = () => <ReactFlowProvider><div className="react-flow__node" onClick={nodeClick}>
    {branch === 'resource' ? <ResourceNode {...common} node={node} asset={asset} selected={selected} playing={playing}
      rotation={0} onRotate={noop} onFocus={onFocus} />
      : branch === 'generation' ? <GenerationNode {...common} node={node} asset={asset} results={results} task={task}
        selected={selected} playing={playing} expanded={false} onResult={noop} onExpand={noop} />
        : <HistoryNode {...common} node={node} cards={cards} connectedAssets={[]} selected={selected} playing={playing}
          expanded={branch === 'history-expanded'} onExpand={noop} onInspect={onInspect} />}
  </div></ReactFlowProvider>
  const pane = document.createElement('div'); document.body.append(pane)
  root = createRoot(pane)
  act(() => root!.render(view()))
  await act(async () => { await Promise.resolve() })
  // Click the original frame exactly as a user does to reveal the custom player.
  act(() => pane.querySelector<HTMLElement>('.dc-resource-frame,.dc-generation-media')!.click())
  await act(async () => { await Promise.resolve() })
  const video = pane.querySelector('video')!
  expect(video).toBeTruthy(); expect(onPlay).toHaveBeenCalledOnce()
  Object.defineProperties(video, { duration: { value: 10, configurable: true }, currentTime: { value: 0, writable: true, configurable: true } })
  act(() => { video.dispatchEvent(new Event('loadedmetadata')); video.dispatchEvent(new Event('loadeddata')) })
  await act(async () => { await Promise.resolve() })
  const image = pane.querySelector('img')!
  await act(async () => { image.dispatchEvent(new Event('load')); await Promise.resolve() })
  act(() => { video.currentTime = 3; video.dispatchEvent(new Event('timeupdate')) })
  expect(video.paused).toBe(false)
  const plays = play.mock.calls.length, pauses = pause.mock.calls.length, stops = onStop.mock.calls.length
  const userNode: NodeBase = { id: node.id, position: { x: 0, y: 0 }, data: {}, selected: true }
  const internal: InternalNodeBase = { ...userNode, measured: { width: 320, height: 180 },
    internals: { positionAbsolute: { x: 0, y: 0 }, z: 0, userNode } }
  const nodeLookup = new Map([[node.id, internal]])
  const update = vi.fn((items: Map<string, { position: { x: number; y: number }; internals: { positionAbsolute: { x: number; y: number } } }>) => {
    for (const item of items.values()) {
      internal.position = { ...item.position }; internal.internals.positionAbsolute = { ...item.internals.positionAbsolute }
      node = { ...node, position: { ...item.position } }
    }
    root!.render(view())
  })
  driver = XYDrag({ getStoreItems: () => ({
    nodes: [userNode], edges: [], nodeLookup, nodeExtent: [[-Infinity, -Infinity], [Infinity, Infinity]],
    snapGrid: [15, 15], snapToGrid: false, nodeOrigin: [0, 0], multiSelectionActive: false,
    domNode: pane, transform: [0, 0, zoom], autoPanOnNodeDrag: false, nodesDraggable: true,
    selectNodesOnDrag: true, nodeDragThreshold: 1, panBy: async () => false,
    unselectNodesAndEdges: noop, updateNodePositions: update,
  }) })
  driver.update({ domNode: pane.querySelector('.react-flow__node')!, nodeId: node.id, noDragClassName: 'nodrag', isSelectable: true })
  const ownerView = pane.ownerDocument.defaultView!
  const mouse = (type: string, x: number, y: number, buttons: number) => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons, clientX: x, clientY: y })
    Object.defineProperty(event, 'view', { value: ownerView })
    return event
  }
  const drag = (target: Element) => act(() => {
    target.dispatchEvent(mouse('mousedown', 20, 30, 1))
    ownerView.dispatchEvent(mouse('mousemove', 22, 32, 1))
    ownerView.dispatchEvent(mouse('mousemove', 62, 52, 1))
    ownerView.dispatchEvent(mouse('mouseup', 62, 52, 0))
  })
  const inspectCalls = onInspect.mock.calls.length
  for (const target of [video, pane.querySelector('.dc-video-player')!, pane.querySelector('.dc-video-time')!]) drag(target)
  expect(internal.position).toEqual({ x: 120 / zoom, y: 60 / zoom })
  expect(node.position).toEqual(internal.position)
  expect(pane.querySelector('video')).toBe(video)
  expect(video.currentTime).toBe(3); expect(video.paused).toBe(false)
  expect(play).toHaveBeenCalledTimes(plays); expect(pause).toHaveBeenCalledTimes(pauses)
  expect(onStop).toHaveBeenCalledTimes(stops); expect(onInspect).toHaveBeenCalledTimes(inspectCalls)
  expect(onFocus).not.toHaveBeenCalled(); expect(onOpen).not.toHaveBeenCalled()
  // The real D3 suppression prevents a drag's trailing click from toggling play.
  act(() => video.click()); expect(video.paused).toBe(false)
  const calls = update.mock.calls.length, position = { ...internal.position }
  for (const target of [pane.querySelector('.dc-video-progress')!, pane.querySelector('.dc-video-toggle svg')!]) drag(target)
  expect(update).toHaveBeenCalledTimes(calls); expect(internal.position).toEqual(position)
  // Allow D3's one-tick click suppression to expire, then exercise the controls.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  await act(async () => { pane.querySelector<HTMLButtonElement>('.dc-video-toggle')!.click(); await Promise.resolve() })
  expect(video.paused).toBe(true)
  await act(async () => { pane.querySelector<HTMLButtonElement>('.dc-video-toggle')!.click(); await Promise.resolve() })
  expect(video.paused).toBe(false)
  const slider = pane.querySelector<HTMLInputElement>('.dc-video-progress')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(slider, '6')
    slider.dispatchEvent(new Event('input', { bubbles: true }))
    await Promise.resolve()
  })
  expect(video.currentTime).toBe(6); expect(video.paused).toBe(false)
  expect(internal.position).toEqual(position)
  const nodeClicks = nodeClick.mock.calls.length
  await act(async () => { video.click(); await Promise.resolve() })
  expect(video.paused).toBe(true); expect(nodeClick).toHaveBeenCalledTimes(nodeClicks)
})
