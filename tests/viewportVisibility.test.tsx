// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ReactFlowProvider } from '@xyflow/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { observeVisibility } from '../src/client/observeVisibility'
import { ResourceNode } from '../src/client/ResourceNode'
import { ResultMedia } from '../src/client/GenerationNode'
import { SignedImage } from '../src/client/SignedMedia'
import { NodeLoading, NodeLoadingBoundary } from '../src/client/NodeLoading'
import { CanvasApi } from '../src/client/api'
import type { Asset, CanvasNode } from '../src/shared/contracts'

// Real visibility, URL, loading-boundary and image lifecycles; GPU drawing is covered separately.
vi.mock('../src/client/MediaLoadingEffect', () => ({ MediaLoadingEffect: () => null }))
type Entry = Pick<IntersectionObserverEntry, 'target' | 'time' | 'isIntersecting'>
const roots: Root[] = []
const callbacks = new Map<Element, (entries: Entry[]) => void>()
let initialVisibility: boolean[] = []
let clock = 0
beforeEach(() => {
  initialVisibility = [true]; clock = 0
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.stubGlobal('IntersectionObserver', class {
    targets: Element[] = []
    constructor(private notify: (entries: Entry[]) => void) {}
    observe(target: Element) {
      this.targets.push(target); callbacks.set(target, this.notify)
      this.notify(initialVisibility.map((isIntersecting) => ({ target, isIntersecting, time: ++clock })))
    }
    disconnect() { this.targets.forEach((target) => callbacks.delete(target)) }
  })
})
afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()))
  document.body.replaceChildren(); callbacks.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
function deliver(target: Element, visibility: boolean[]) {
  callbacks.get(target)!(visibility.map((isIntersecting) => ({ target, isIntersecting, time: ++clock })))
}
function mount(element: React.ReactNode) {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container); roots.push(root)
  act(() => root.render(element))
  return { root, container }
}
async function settle(action: () => void = () => {}) { await act(async () => { action(); await Promise.resolve() }) }
function apiFixture() {
  const api = new CanvasApi()
  const requests = vi.spyOn(api, 'mediaUrls').mockImplementation(async (_canvas, items) => ({
    items: items.map((item) => ({ ...item, url: `https://assets.invalid/${item.assetId}`, expiresAt: Date.now() + 3600000 })),
  }))
  return { api, requests }
}
async function load(container: HTMLElement) {
  const image = container.querySelector('img')!
  Object.defineProperties(image, { naturalWidth: { value: 240, configurable: true }, naturalHeight: { value: 400, configurable: true } })
  await settle(() => image.dispatchEvent(new Event('load')))
  expect(image.style.visibility).toBe('')
  expect(container.querySelector('[data-task-status="media-loading"]')).toBeNull()
  return image
}
const noop = () => {}
const asset = (id = 'a'): Asset => ({ id, kind: 'image', mime: 'image/png', filename: `${id}.png`,
  bytes: 1, createdAt: 1, nodeId: null, taskId: null, width: 240, height: 400 })
const node = (id = 'n', assetId = 'a'): CanvasNode => ({ id, kind: 'image-asset', title: id, position: { x: 0, y: 0 },
  assetId, selectedResultId: null, modelId: null, prompt: '', params: null })
function resource(api: CanvasApi, id = 'n', assetId = 'a') {
  return <ResourceNode node={node(id, assetId)} asset={asset(assetId)} selected={false} api={api} workspace="w" rotation={0} playing={false}
    onRename={noop} onRotate={noop} onPlay={noop} onStop={noop} onOpen={noop} onFocus={noop} onSize={noop} />
}

describe('visibility notification ordering', () => {
  it.each([[false, true], [true, false], [false, true, false]])('uses the final state of an ordered batch %j', (...visibility) => {
    const target = document.createElement('div'), changed = vi.fn()
    const stop = observeVisibility(target, changed)
    changed.mockClear()
    deliver(target, visibility)
    expect(changed.mock.calls).toEqual([[visibility.at(-1)]])
    stop()
  })
  it('selects by timestamp, ignores other targets and does not let older batches overwrite the current state', () => {
    const target = document.createElement('div'), foreign = document.createElement('div'), changed = vi.fn()
    const stop = observeVisibility(target, changed)
    changed.mockClear()
    const notify = callbacks.get(target)!
    notify([{ target, time: 30, isIntersecting: true }, { target: foreign, time: 100, isIntersecting: false },
      { target, time: 10, isIntersecting: false }])
    expect(changed.mock.calls).toEqual([[true]])
    notify([{ target, time: 20, isIntersecting: false }]); notify([])
    notify([{ target: foreign, time: 200, isIntersecting: false }])
    expect(changed).toHaveBeenCalledTimes(1)
    notify([{ target, time: 30, isIntersecting: true }, { target, time: 30, isIntersecting: false }])
    expect(changed).toHaveBeenLastCalledWith(false)
    stop()
  })
  it('ignores a queued callback after disconnect and keeps the next observation independent', () => {
    const target = document.createElement('div'), changed = vi.fn()
    const stop = observeVisibility(target, changed), old = callbacks.get(target)!
    stop(); changed.mockClear()
    const next = observeVisibility(target, changed)
    expect(changed).toHaveBeenLastCalledWith(true)
    old([{ target, time: 100, isIntersecting: false }])
    expect(changed).toHaveBeenCalledTimes(1)
    next()
    expect(callbacks.has(target)).toBe(false)
  })
  it('allows rendering without IntersectionObserver and does not subscribe without an element', () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    const changed = vi.fn()
    observeVisibility(null, changed)()
    expect(changed).not.toHaveBeenCalled()
    observeVisibility(document.createElement('div'), changed)()
    expect(changed.mock.calls).toEqual([[true]])
  })
})

describe('canvas media viewport reentry regressions', () => {
  it.each(['resource', 'result'] as const)('keeps the %s image mounted when a batch ends inside the viewport', async (kind) => {
    const { api, requests } = apiFixture()
    const { container } = mount(<ReactFlowProvider>{kind === 'resource' ? resource(api)
      : <NodeLoadingBoundary><ResultMedia asset={asset()} api={api} workspace="w" playing={false}
        onPlay={noop} onStop={noop} onOpen={noop} onDimensions={noop} /><NodeLoading title="image" /></NodeLoadingBoundary>}</ReactFlowProvider>)
    await settle()
    const image = await load(container)
    const frame = container.querySelector(kind === 'resource' ? '.dc-resource-frame' : '.dc-generation-media')!
    await settle(() => deliver(frame, [false, true]))
    expect(container.querySelector('img')).toBe(image)
    expect(image.style.visibility).toBe('')
    expect(container.querySelector('[data-task-status="media-loading"]')).toBeNull()
    expect(container.querySelector('.dc-missing')).toBeNull()
    expect(requests).toHaveBeenCalledTimes(1)
    await settle(() => deliver(frame, [true, false]))
    expect(container.querySelector('img')).toBeNull()
    await settle(() => deliver(frame, [false, true]))
    await load(container)
    expect(requests).toHaveBeenCalledTimes(1)
  })
  it('loads a valid shared cached URL when the first inner image batch includes exit and reentry', async () => {
    const { api, requests } = apiFixture()
    const first = mount(<SignedImage api={api} canvas="w" assetId="a" trackLoading={false} />)
    await settle(); await load(first.container)
    initialVisibility = [false, true]
    const second = mount(<SignedImage api={api} canvas="w" assetId="a" trackLoading={false} />)
    await settle()
    expect(second.container.querySelector('img')!.src).toBe(first.container.querySelector('img')!.src)
    await load(second.container)
    expect(requests).toHaveBeenCalledTimes(1)
  })
  it('reloads every node after repeated row reentries with different mixed notification batches', async () => {
    const { api, requests } = apiFixture()
    const { container } = mount(<ReactFlowProvider>{Array.from({ length: 10 }, (_, i) =>
      <div key={i} data-test-node={i}>{resource(api, `n${i}`, `a${i}`)}</div>)}</ReactFlowProvider>)
    await settle()
    const rows = [...container.querySelectorAll<HTMLElement>('[data-test-node]')]
    for (const row of rows) await load(row)
    const frames = rows.map((row) => row.querySelector('.dc-resource-frame')!)
    for (const mixed of [[2, 5, 8], [1, 3, 9], [0, 4, 6, 7]]) {
      await settle(() => frames.forEach((frame) => deliver(frame, [false])))
      expect(container.querySelectorAll('img')).toHaveLength(0)
      await settle(() => frames.forEach((frame, i) => deliver(frame, mixed.includes(i) ? [false, true] : [true])))
      expect(container.querySelectorAll('img')).toHaveLength(10)
      for (const row of rows) await load(row)
      expect(container.querySelectorAll('[data-task-status="media-loading"],.dc-missing')).toHaveLength(0)
    }
    expect(requests).toHaveBeenCalledTimes(1)
  })
})
