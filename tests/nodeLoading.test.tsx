// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ReactFlowProvider, type useStoreApi } from '@xyflow/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CanvasWorkspace } from '../src/client/Canvas'
import { NodeLoading, NodeLoadingBoundary, NodeLoadingContext } from '../src/client/NodeLoading'
import { GenerationNode } from '../src/client/GenerationNode'
import { VideoPlayer } from '../src/client/VideoPlayer'
import { AudioPlayer } from '../src/client/AudioPlayer'
import { SignedImage } from '../src/client/SignedMedia'
import { CanvasApi } from '../src/client/api'
import { defaultTtsParams, emptyGraph, FISH_TTS_ENDPOINT, type Asset, type CanvasNode, type NodeKind, type TaskStatus } from '../src/shared/contracts'
import type { CanvasSnapshot, TaskSummary } from '../src/shared/v2'
import { createLoadingResolutionStore, LoadingResolutionContext, loadingPixelRatio } from '../src/client/loadingResolution'

let flowStore: ReturnType<typeof useStoreApi> | undefined

// Libraries, workspace task routing and media components stay real.
vi.mock('@xyflow/react', async (original) => {
  const actual = await original<typeof import('@xyflow/react')>()
  return {
  ...actual,
  Background: () => null, Controls: () => null, MiniMap: () => null,
  ReactFlow: ({ nodes, nodeTypes, children, proOptions }: any) => {
    flowStore = actual.useStoreApi()
    return <div data-hide-attribution={String(proOptions?.hideAttribution)}>
    {nodes.map((node: any) => {
      const Component = nodeTypes[node.type]
      return <div key={node.id} data-test-node={node.id}><Component id={node.id} data={node.data} selected={node.selected} /></div>
    })}{children}
  </div>
  },
  }
})
vi.mock('../src/client/useGpu', () => ({ useGpuCapability: () => ({ enabled: false, reason: 'test' }) }))
const roots: Root[] = []
const intersections = new Map<Element, (visible: boolean) => void>()
const frames = new Map<number, FrameRequestCallback>()
const media = new Map<string, MediaQueryList>()
const paints: string[] = []
const transforms: number[] = []
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('IntersectionObserver', class {
    targets: Element[] = []
    constructor(private notify: (entries: Array<{ isIntersecting: boolean }>) => void) {}
    observe(target: Element) {
      this.targets.push(target); intersections.set(target, (visible) => this.notify([{ isIntersecting: visible }]))
      this.notify([{ isIntersecting: true }])
    }
    disconnect() { for (const target of this.targets) intersections.delete(target) }
  })
  vi.stubGlobal('ResizeObserver', class { observe() {}; disconnect() {} })
  let frameId = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  vi.stubGlobal('matchMedia', (query: string) => {
    if (!media.has(query)) media.set(query, Object.assign(new EventTarget(), {
      matches: query.includes('color-scheme'), media: query,
    }) as unknown as MediaQueryList)
    return media.get(query)!
  })
  const ctx = {
    setTransform(ratio: number) { transforms.push(ratio) }, clearRect() {}, beginPath() {}, arc() {}, fill() {}, moveTo() {}, lineTo() {}, stroke() {},
    set fillStyle(value: string) { paints.push(value) }, set strokeStyle(_value: string) {}, lineWidth: 1,
  }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
})
afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()))
  document.body.replaceChildren(); document.body.removeAttribute('data-ds-dark-theme')
  intersections.clear(); frames.clear(); media.clear(); paints.length = 0; transforms.length = 0; flowStore = undefined
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})
function mount(element: React.ReactNode) {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container); roots.push(root)
  act(() => root.render(element))
  return { root, container }
}
const task = (status: TaskStatus): TaskSummary => ({
  id: 'task', nodeId: 'node', workspaceId: 'w', status, resultIds: [], progress: 42, createdAt: 1, updatedAt: 1,
})
function orbFrames() { return [...frames.values()].filter((frame) => frame.name === 'loop').length }
async function workspace() {
  const shapes: Array<[NodeKind, boolean]> = [
    ['image-generation', false], ['image-generation', true], ['video-generation', false], ['video-generation', true],
    ['tts-generation', false], ['tts-generation', true],
    ['image-asset', true], ['video-asset', true], ['audio-asset', true],
    ['image-asset', false], ['video-asset', false], ['audio-asset', false],
  ]
  const nodes: CanvasNode[] = shapes.map(([kind], index) => ({
    id: `node-${index}`, kind, title: kind, position: { x: 0, y: 0 }, modelId: null, prompt: '',
    params: kind === 'tts-generation' ? defaultTtsParams() : null,
    assetId: shapes[index][1] ? `asset-${index}` : null, selectedResultId: null,
  }))
  const assets: Asset[] = shapes.flatMap(([kind, hasAsset], index) => hasAsset ? [{
    id: `asset-${index}`, nodeId: nodes[index].id, taskId: null, kind: kind.includes('image') ? 'image' : kind.includes('video') ? 'video' : 'audio',
    filename: 'media', mime: 'application/octet-stream', bytes: 100, width: 320, height: 180, createdAt: 1,
  }] : [])
  const snapshot: CanvasSnapshot = {
    version: 1, workspaceId: 'w', graphRevision: 1, graph: { ...emptyGraph(), nodes }, assets,
    tasks: nodes.map((node) => ({ ...task('generating'), id: `task-${node.id}`, nodeId: node.id, resultIds: node.assetId ? [node.assetId] : [] })),
    updatedAt: 1, commitHash: 'a'.repeat(64), hashes: { nodes: {}, edges: {}, viewport: '' },
  }
  const api = new CanvasApi()
  vi.spyOn(api, 'state').mockResolvedValue(snapshot); vi.spyOn(api, 'models').mockResolvedValue([])
  vi.spyOn(api, 'ttsSettings').mockResolvedValue({ endpoint: FISH_TTS_ENDPOINT, revision: 0, configured: false, has_api_key: false, api_key_mask: '' })
  vi.spyOn(api, 'waveform').mockResolvedValue({ version: 1, duration: 10, peaks: Array(96).fill(.5) })
  const view = (active: boolean) => <ReactFlowProvider><CanvasWorkspace api={api} active={active} workspace="w" title="画布" onBack={() => {}} /></ReactFlowProvider>
  const { container, root } = mount(view(true))
  await act(async () => { await Promise.resolve() })
  const show = (active: boolean) => act(async () => { root.render(view(active)); await Promise.resolve() })
  return { container, show, api }
}
describe('dependency-backed whole-node loading', () => {
  it('redraws the real Orb at screen DPR × actual XYFlow zoom without changing CSS size or remounting media', async () => {
    vi.stubGlobal('devicePixelRatio', 2)
    const { container, api } = await workspace()
    act(() => flowStore!.setState({ transform: [0, 0, 1] }))
    const orb = container.querySelector<HTMLCanvasElement>('.dc-node-loading canvas')!
    const audio = container.querySelector('audio'), image = container.querySelector('img')
    expect(orb.width).toBe(128)
    act(() => flowStore!.setState({ transform: [5, -4, 2.5] }))
    expect(orb.width).toBe(320); expect(orb.height).toBe(320)
    expect(orb.style.width).toBe('64px'); expect(orb.style.height).toBe('64px')
    expect(transforms.slice(-12)).toEqual(Array(12).fill(5))
    expect(container.querySelector('.dc-node-loading canvas')).toBe(orb)
    expect(container.querySelector('audio')).toBe(audio); expect(container.querySelector('img')).toBe(image)
    expect(api.state).toHaveBeenCalledTimes(1); expect(orbFrames()).toBe(12)
    const count = transforms.length
    act(() => flowStore!.setState({ transform: [19, 33, 2.45] }))
    act(() => flowStore!.setState({ transform: [-18, 42, 2.45] }))
    expect(transforms).toHaveLength(count)
    act(() => flowStore!.setState({ transform: [0, 0, .75] }))
    expect(orb.width).toBe(128); expect(orbFrames()).toBe(12)
  })
  it('uses screen density for a preview and full zoom density for compact references inside nodes', () => {
    vi.stubGlobal('devicePixelRatio', 2)
    const store = createLoadingResolutionStore({ getZoom: () => 2.5, subscribe: () => () => {} })
    const { container } = mount(<LoadingResolutionContext.Provider value={store}>
      <article className="dc-node"><NodeLoading task={task('queued')} title="引用图" compact /></article>
      <div data-preview><NodeLoading task={task('queued')} title="预览" compact /></div>
    </LoadingResolutionContext.Provider>)
    const node = container.querySelector<HTMLCanvasElement>('article canvas')!
    const preview = container.querySelector<HTMLCanvasElement>('[data-preview] canvas')!
    expect(node.width).toBe(100); expect(node.style.width).toBe('20px')
    expect(preview.width).toBe(40); expect(preview.style.width).toBe('20px')
  })
  it('updates for fractional screen density and a monitor switch, including after the DPR media query is rearmed', () => {
    vi.stubGlobal('devicePixelRatio', 1.25)
    const { container } = mount(<NodeLoading task={task('queued')} title="预览" />)
    const orb = container.querySelector('canvas')!
    expect(orb.width).toBe(128)
    const initial = media.get('(resolution: 1.25dppx)')!
    act(() => { vi.stubGlobal('devicePixelRatio', 3); initial.dispatchEvent(new Event('change')) })
    expect(orb.width).toBe(192); expect(media.has('(resolution: 3dppx)')).toBe(true)
    act(() => { vi.stubGlobal('devicePixelRatio', 2); window.dispatchEvent(new Event('resize')) })
    expect(orb.width).toBe(128); expect(container.querySelector('canvas')).toBe(orb)
  })
  it('changes resolution while paused without restarting either library frame loop', () => {
    vi.stubGlobal('devicePixelRatio', 2)
    let zoom = 1, notify = () => {}
    const store = createLoadingResolutionStore({ getZoom: () => zoom, subscribe: (read) => { notify = read; return () => {} } })
    const view = (paused: boolean) => <LoadingResolutionContext.Provider value={store}>
      <NodeLoadingContext.Provider value={{ theme: 'dark', ink: '#efedf4', paused }}>
        <article className="dc-node"><NodeLoading task={task('queued')} title="任务" /></article>
      </NodeLoadingContext.Provider>
    </LoadingResolutionContext.Provider>
    const { container, root } = mount(view(false))
    expect(frames.size).toBeGreaterThan(1)
    act(() => root.render(view(true)))
    expect(frames.size).toBe(0)
    act(() => { zoom = 3; notify() })
    expect(container.querySelector<HTMLCanvasElement>('.dc-node-loading canvas')!.width).toBe(384)
    expect(frames.size).toBe(0)
    act(() => root.render(view(false)))
    expect(orbFrames()).toBe(1); expect(frames.size).toBeGreaterThan(1)
  })
  it('shares one lazy viewport/resize listener and detaches it when the final loader finishes', () => {
    const subscribe = vi.fn(() => stop), stop = vi.fn()
    const add = vi.spyOn(window, 'addEventListener'), remove = vi.spyOn(window, 'removeEventListener')
    const store = createLoadingResolutionStore({ getZoom: () => 1, subscribe })
    const node = vi.fn(), preview = vi.fn()
    expect(subscribe).not.toHaveBeenCalled()
    const stopNode = store.subscribeNode(node), stopPreview = store.subscribeScreen(preview)
    expect(subscribe).toHaveBeenCalledTimes(1)
    expect(add.mock.calls.filter(([event]) => event === 'resize')).toHaveLength(1)
    stopNode(); expect(stop).not.toHaveBeenCalled()
    stopPreview(); expect(stop).toHaveBeenCalledTimes(1)
    expect(remove.mock.calls.filter(([event]) => event === 'resize')).toHaveLength(1)
    window.dispatchEvent(new Event('resize'))
    expect(node).not.toHaveBeenCalled(); expect(preview).not.toHaveBeenCalled()
  })
  it('bounds backing memory and treats invalid density/zoom as the ordinary screen scale', () => {
    expect(loadingPixelRatio(2, 4)).toBe(8)
    expect(loadingPixelRatio(3, 20)).toBe(8)
    expect(loadingPixelRatio(2, .15)).toBe(1)
    expect(loadingPixelRatio(1.25, 1.25)).toBe(2)
    expect(loadingPixelRatio(NaN, Infinity)).toBe(1)
    expect(loadingPixelRatio(2, -1)).toBe(2)
  })
  it.each(['submitted', 'queued', 'generating', 'saving'] as const)('renders the actual Beam and Orb for %s with one readable status', (status) => {
    const { container } = mount(<NodeLoading task={task(status)} title="图片" />)
    expect(container.querySelector('[data-beam][data-active]')).toBeTruthy()
    expect(container.querySelector('style')!.textContent).toContain('@keyframes beam-')
    expect(container.querySelector('canvas[aria-hidden="true"]')!.getAttribute('style')).toContain('64px')
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1)
    expect(container.querySelector('[role="status"]')!.classList.contains('dc-sr-only')).toBe(true)
    expect(container.querySelector('[role="status"]')!.textContent).toContain('42%')
    expect(container.querySelector('[tabindex]')).toBeNull()
    expect(paints.length).toBeGreaterThan(0); expect(orbFrames()).toBe(1)
  })
  it.each(['failed', 'unknown', 'save_failed'] as const)('replaces all loading effects with a red exclamation for %s even while old media is pending', (status) => {
    const { container, root } = mount(<NodeLoading task={task('generating')} title="语音" />)
    act(() => root.render(<NodeLoading task={task(status)} title="语音" mediaLoading />))
    expect(container.querySelector('.dc-node-failure svg[aria-hidden="true"]')).toBeTruthy()
    expect(container.querySelector('[role="status"]')!.textContent).toBe(status === 'unknown' ? '提交结果待确认' : status === 'save_failed' ? '结果保存失败' : '失败')
    expect(container.querySelector('[data-beam],canvas,.dc-node-loading,[data-loading-preset]')).toBeNull()
    expect(frames.size).toBe(0); expect(intersections.size).toBe(0)
  })
  it('keeps the old media element while a failed task overrides boundary loading, including compact previews', async () => {
    const api = new CanvasApi()
    vi.spyOn(api, 'mediaUrls').mockImplementation(async (_canvas, items) => ({
      items: items.map((item) => ({ ...item, url: `https://assets.example/${item.assetId}`, expiresAt: Date.now() + 3600000 })),
    }))
    const view = (status: TaskStatus) => <NodeLoadingBoundary>
      <SignedImage api={api} canvas="w" assetId="old-result" alt="图片" />
      <NodeLoading task={task(status)} title="图片" compact />
    </NodeLoadingBoundary>
    const { container, root } = mount(view('completed'))
    await act(async () => { await Promise.resolve() })
    const image = container.querySelector('img')
    expect(container.querySelector('[data-task-status="media-loading"]')).toBeTruthy()
    act(() => root.render(view('failed')))
    expect(container.querySelector('.dc-node-failure[data-compact]')).toBeTruthy()
    expect(container.querySelector('img')).toBe(image)
    expect(container.querySelector('[data-beam],canvas')).toBeNull(); expect(frames.size).toBe(0)
  })
  it.each(['completed', 'abandoned', undefined] as const)('removes loading and stops dependency frames for %s', (status) => {
    const { container, root } = mount(<NodeLoading task={task('generating')} title="视频" />)
    act(() => root.render(<NodeLoading task={status ? task(status) : undefined} title="视频" />))
    expect(container.childElementCount).toBe(0); expect(orbFrames()).toBe(0)
  })
  it('tears down the Beam pulse oscillator as well as the Orb when paused, and resumes the original preset', () => {
    const view = (paused: boolean) => <NodeLoadingContext.Provider value={{ theme: 'dark', ink: '#efedf4', paused }}>
      <NodeLoading task={task('queued')} title="任务" />
    </NodeLoadingContext.Provider>
    const { container, root } = mount(view(false))
    expect(frames.size).toBeGreaterThan(1)
    act(() => root.render(view(true)))
    expect(frames.size).toBe(0)
    expect(container.querySelector('[data-loading-paused]')).toBeTruthy()
    act(() => root.render(view(false)))
    expect(frames.size).toBeGreaterThan(1)
    expect(container.querySelector('[data-loading-preset="pulse-inner"]')).toBeTruthy()
  })
  it('routes every node branch through both dependencies, preserves media DOM and pauses a retained hidden canvas', async () => {
    const { container, show, api } = await workspace()
    expect(container.querySelector('[data-hide-attribution="true"]')).toBeTruthy()
    const cards = [...container.querySelectorAll('[data-test-node]')]
    expect(cards).toHaveLength(12)
    for (const card of cards) {
      expect(card.querySelector('article > .dc-node-loading [data-beam]')).toBeTruthy()
      expect(card.querySelector('.dc-node-loading canvas')).toBeTruthy()
      expect(card.querySelector('.dc-task-overlay')).toBeNull()
      expect(card.querySelector('.react-flow__handle.source')).toBeTruthy()
    }
    const audio = container.querySelector('audio'), canvas = container.querySelector('.dc-node-loading canvas')
    expect(orbFrames()).toBe(12)
    await show(false)
    expect(orbFrames()).toBe(0)
    expect(container.querySelectorAll('[data-loading-paused]')).toHaveLength(12)
    expect(container.querySelector('audio')).toBe(audio); expect(container.querySelector('.dc-node-loading canvas')).toBe(canvas)
    await show(true)
    expect(orbFrames()).toBe(12); expect(api.state).toHaveBeenCalledTimes(1)
  })
  it('uses Harness light/dark and text tint even when the OS chooses dark; updates without remounting media', async () => {
    const { container } = await workspace()
    const root = container.querySelector<HTMLElement>('.dc-root')!
    const canvas = container.querySelector('canvas'), audio = container.querySelector('audio')
    await act(async () => {
      root.style.setProperty('--dsw-alias-bg-base', '#ffffff'); root.style.color = 'rgb(24, 56, 88)'
      await Promise.resolve()
    })
    expect(container.querySelector('[data-loading-theme]')!.getAttribute('data-loading-theme')).toBe('light')
    const tinted = paints.slice(-10)
    await act(async () => {
      document.body.setAttribute('data-ds-dark-theme', ''); root.style.color = 'rgb(230, 210, 190)'
      await Promise.resolve()
    })
    expect(container.querySelector('[data-loading-theme]')!.getAttribute('data-loading-theme')).toBe('dark')
    expect(paints.slice(-10)).not.toEqual(tinted)
    expect(container.querySelector('canvas')).toBe(canvas); expect(container.querySelector('audio')).toBe(audio)
  })
  it('pauses on reduced-motion changes, offscreen nodes and page visibility without stopping the task', async () => {
    const { container } = await workspace()
    const reduced = media.get('(prefers-reduced-motion: reduce)')!
    act(() => { Object.assign(reduced, { matches: true }); reduced.dispatchEvent(new Event('change')) })
    expect(orbFrames()).toBe(0); expect(container.querySelectorAll('[data-loading-paused]')).toHaveLength(12)
    act(() => { Object.assign(reduced, { matches: false }); reduced.dispatchEvent(new Event('change')) })
    expect(orbFrames()).toBe(12)
    const overlay = container.querySelector('.dc-node-loading')!
    act(() => intersections.get(overlay)!(false))
    expect(overlay.querySelector('[data-loading-paused]')).toBeTruthy(); expect(orbFrames()).toBe(11)
    act(() => intersections.get(overlay)!(true))
    expect(orbFrames()).toBe(12)
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(orbFrames()).toBe(0)
    expect(container.querySelectorAll('[data-task-status="generating"]')).toHaveLength(12)
  })
  it('keeps one whole-node loader after success until the image URL and decoding finish, without exposing native alt/broken-image content', async () => {
    const api = new CanvasApi()
    vi.spyOn(api, 'mediaUrls').mockImplementation(async (_canvas, items) => ({
      items: items.map((item) => ({ ...item, url: `https://assets.example/${item.assetId}`, expiresAt: Date.now() + 3600000 })),
    }))
    let decode!: () => void
    const decoding = new Promise<void>((resolve) => { decode = resolve })
    const asset: Asset = { id: 'image', nodeId: 'node', taskId: 'task', kind: 'image', mime: 'image/png', filename: 'file.png', bytes: 100, width: 320, height: 180, createdAt: 1 }
    const node: CanvasNode = { id: 'node', kind: 'image-generation', title: '图片', position: { x: 0, y: 0 }, modelId: null,
      prompt: '', params: null, assetId: null, selectedResultId: null }
    const props = { node, asset, results: [asset], selected: false, expanded: false, api, workspace: 'w', playing: false,
      onPlay: vi.fn(), onStop: vi.fn(), onRename: vi.fn(), onResult: vi.fn(), onExpand: vi.fn(), onOpen: vi.fn(), onSize: vi.fn() }
    const view = (status: TaskStatus) => <ReactFlowProvider><GenerationNode {...props} task={task(status)} /></ReactFlowProvider>
    const { container, root } = mount(view('generating'))
    await act(async () => { await Promise.resolve() })
    const image = container.querySelector('img')!
    Object.defineProperty(image, 'decode', { value: () => decoding })
    expect(image.style.visibility).toBe('hidden')
    expect(container.querySelectorAll('[data-beam]')).toHaveLength(1)
    act(() => root.render(view('completed')))
    expect(container.querySelector('[data-task-status="media-loading"][data-loading-preset="pixels-organic"]')).toBeTruthy()
    expect(container.querySelector('[data-beam],canvas')).toBeNull()
    expect(container.querySelector('img')).toBe(image)
    act(() => image.dispatchEvent(new Event('load')))
    expect(container.querySelector('[data-task-status="media-loading"]')).toBeTruthy(); expect(image.style.visibility).toBe('hidden')
    await act(async () => { decode(); await Promise.resolve() })
    expect(container.querySelector('.dc-node-loading')).toBeNull()
    expect(image.style.visibility).toBe(''); expect(container.querySelector('img')).toBe(image)
    expect(api.mediaUrls).toHaveBeenCalledTimes(1)
  })
  it('waits for a video first frame, not just metadata, and clears the loading on a terminal media error', () => {
    const { root, container } = mount(<VideoPlayer src="video.mp4" label="视频" />)
    const video = container.querySelector('video')!
    act(() => video.dispatchEvent(new Event('loadedmetadata')))
    expect(container.querySelector('[data-task-status="media-loading"]')).toBeTruthy()
    act(() => video.dispatchEvent(new Event('loadeddata')))
    expect(container.querySelector('.dc-node-loading')).toBeNull()
    act(() => root.render(<VideoPlayer src="other.mp4" label="视频" />))
    expect(container.querySelector('[data-task-status="media-loading"]')).toBeTruthy()
    Object.defineProperty(video, 'error', { value: { code: 4 }, configurable: true })
    act(() => video.dispatchEvent(new Event('error')))
    expect(container.querySelector('.dc-node-loading')).toBeNull()
    expect(container.querySelector('[role="alert"]')!.textContent).toContain('暂不可播放')
  })
  it('invalidates an old image URL and ignores an old decode completion when the displayed asset changes', async () => {
    const api = new CanvasApi()
    vi.spyOn(api, 'mediaUrls').mockImplementation(async (_canvas, items) => ({
      items: items.map((item) => ({ ...item, url: `https://assets.example/${item.assetId}`, expiresAt: Date.now() + 3600000 })),
    }))
    const view = (id: string) => <NodeLoadingBoundary><SignedImage api={api} canvas="w" assetId={id} alt="图片" />
      <NodeLoading task={task('completed')} title="图片" /></NodeLoadingBoundary>
    const { container, root } = mount(view('old'))
    await act(async () => { await Promise.resolve() })
    const image = container.querySelector('img')!
    let finishOld!: () => void, finishNew!: () => void
    const old = new Promise<void>((resolve) => { finishOld = resolve })
    const current = new Promise<void>((resolve) => { finishNew = resolve })
    Object.defineProperty(image, 'decode', { value: () => image.getAttribute('src')?.endsWith('/old') ? old : current })
    act(() => image.dispatchEvent(new Event('load')))
    act(() => {
      root.render(view('new'))
    })
    expect(image.getAttribute('src') ?? '').not.toContain('/old')
    await act(async () => { await Promise.resolve(); finishOld(); await Promise.resolve() })
    expect(image.style.visibility).toBe('hidden')
    expect(container.querySelector('[data-task-status="media-loading"]')).toBeTruthy()
    act(() => image.dispatchEvent(new Event('load')))
    await act(async () => { finishNew(); await Promise.resolve() })
    expect(image.style.visibility).toBe(''); expect(image.getAttribute('src')).toContain('/new')
    expect(container.querySelector('.dc-node-loading')).toBeNull()
  })
  it('keeps audio loading until metadata and waveform settle and does not turn waveform failure into endless loading', async () => {
    const api = new CanvasApi()
    vi.spyOn(api, 'mediaUrls').mockImplementation(async (_canvas, items) => ({
      items: items.map((item) => ({ ...item, url: `https://assets.example/${item.assetId}`, expiresAt: Date.now() + 3600000 })),
    }))
    let rejectWave!: (reason: Error) => void
    vi.spyOn(api, 'waveform').mockReturnValue(new Promise((_resolve, reject) => { rejectWave = reject }))
    const asset: Asset = { id: 'audio', nodeId: 'node', taskId: 'task', kind: 'audio', mime: 'audio/wav', filename: 'file.wav', bytes: 100, createdAt: 1 }
    const { container } = mount(<NodeLoadingBoundary><AudioPlayer api={api} workspace="w" asset={asset} label="音频" />
      <NodeLoading task={task('completed')} title="音频" /></NodeLoadingBoundary>)
    await act(async () => { await Promise.resolve() })
    const audio = container.querySelector('audio')!
    act(() => audio.dispatchEvent(new Event('loadedmetadata')))
    expect(container.querySelector('[data-task-status="media-loading"]')).toBeTruthy()
    await act(async () => { rejectWave(new Error('waveform unavailable')); await Promise.resolve() })
    expect(container.querySelector('.dc-node-loading')).toBeNull()
    expect(container.querySelector('audio')).toBe(audio)
    expect(container.textContent).toContain('仍可播放')
  })
})
