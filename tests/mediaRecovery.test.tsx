// @vitest-environment jsdom
import { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ReactFlowProvider } from '@xyflow/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CanvasApi } from '../src/client/api'
import { SignedImage, useRefreshingSource } from '../src/client/SignedMedia'
import { MediaUrlCache } from '../src/client/mediaUrlCache'
import { ResourceNode } from '../src/client/ResourceNode'
import { ResultMedia } from '../src/client/GenerationNode'
import { VideoPlayer } from '../src/client/VideoPlayer'
import type { Asset, CanvasNode } from '../src/shared/contracts'

// The lifecycle and native load events stay real; this suite does not exercise GPU drawing.
vi.mock('../src/client/MediaLoadingEffect', () => ({ MediaLoadingEffect: () => null }))
const roots: Root[] = []
const intersections = new Map<Element, (visible: boolean) => void>()
const preloads: HTMLImageElement[] = []
let hidden = false
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(1000000)
  hidden = false
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden)
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('IntersectionObserver', class {
    targets: Element[] = []
    constructor(private notify: (entries: Array<{ target: Element; time: number; isIntersecting: boolean }>) => void) {}
    observe(target: Element) {
      this.targets.push(target); intersections.set(target, (visible) => this.notify([{ target, time: 0, isIntersecting: visible }]))
      this.notify([{ target, time: 0, isIntersecting: target.getAttribute('alt') !== 'offscreen' }])
    }
    disconnect() { this.targets.forEach((target) => intersections.delete(target)) }
  })
  const NativeImage = window.Image
  vi.stubGlobal('Image', class extends NativeImage { constructor() { super(); preloads.push(this) } })
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
})
afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()))
  document.body.replaceChildren(); intersections.clear(); preloads.length = 0
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
function mount(element: React.ReactNode) {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container); roots.push(root)
  act(() => root.render(element))
  return { root, container }
}
async function settle(action: () => void = () => {}) { await act(async () => { action(); await Promise.resolve() }) }
async function advance(minutes: number) { await act(async () => { await vi.advanceTimersByTimeAsync(minutes * 60000) }) }
function signedApi() {
  const api = new CanvasApi()
  let count = 0
  const sign = vi.spyOn(api, 'mediaUrls').mockImplementation(async (_canvas, items) => ({
    items: items.map((item) => ({ ...item, url: `https://assets.example/${item.assetId}?v=${++count}`, expiresAt: Date.now() + 3600000 })),
  }))
  return { api, sign }
}
const image = (api: CanvasApi, id = 'a', alt = 'image') => <SignedImage api={api} canvas="w" assetId={id} variant="original" alt={alt} trackLoading={false} />

describe('long-lived media recovery', () => {
  it('renews visible images before expiry and retains the decoded image until the replacement is ready', async () => {
    const { api, sign } = signedApi()
    const { container } = mount(image(api))
    await settle()
    const displayed = container.querySelector('img')!
    await settle(() => displayed.dispatchEvent(new Event('load')))
    const old = displayed.src
    expect(displayed.style.visibility).toBe('')
    await advance(10)
    expect(sign).toHaveBeenCalledTimes(1)
    await advance(46)
    expect(sign).toHaveBeenCalledTimes(2)
    expect(displayed.src).toBe(old); expect(displayed.style.visibility).toBe('')
    const replacement = preloads.at(-1)!
    expect(replacement.src).not.toBe(old)
    const nextUrl = replacement.src
    await settle(() => replacement.dispatchEvent(new Event('load')))
    expect(displayed.src).toBe(nextUrl); expect(displayed.style.visibility).toBe('')
  })
  it('does not sign unseen regions and checks old cached links when a region returns after an hour', async () => {
    const { api, sign } = signedApi()
    const { container } = mount(<>{image(api)}{image(api, 'b', 'offscreen')}</>)
    await settle()
    const [visible, unseen] = [...container.querySelectorAll('img')]
    expect(sign.mock.calls[0][1]).toEqual([{ assetId: 'a', variant: 'original' }])
    await settle(() => visible.dispatchEvent(new Event('load')))
    await settle(() => intersections.get(visible)!(false))
    await advance(70)
    expect(sign).toHaveBeenCalledTimes(1)
    await settle(() => { intersections.get(visible)!(true); intersections.get(unseen)!(true) })
    expect(sign).toHaveBeenCalledTimes(2)
    expect(sign.mock.calls[1][1]).toHaveLength(2)
    expect(unseen.src).toContain('/b')
    expect(preloads.at(-1)!.src).not.toBe(visible.src)
  })
  it('checks immediately after hidden tabs and pageshow resume, even when timers were suspended', async () => {
    const { api, sign } = signedApi()
    mount(image(api)); await settle()
    hidden = true
    await advance(70)
    expect(sign).toHaveBeenCalledTimes(1)
    hidden = false
    await settle(() => {
      document.dispatchEvent(new Event('visibilitychange'))
      window.dispatchEvent(new Event('pageshow'))
    })
    expect(sign).toHaveBeenCalledTimes(2)
  })
  it('shares one forced retry, stops persistent failures, recovers online and permits later independent failures', async () => {
    const { api, sign } = signedApi()
    const { container } = mount(<>{image(api)}{image(api)}</>)
    await settle()
    const images = [...container.querySelectorAll('img')]
    await settle(() => images.forEach((element) => element.dispatchEvent(new Event('error'))))
    expect(sign).toHaveBeenCalledTimes(2); expect(sign.mock.calls[1][2]).toBe(true)
    await settle(() => images.forEach((element) => element.dispatchEvent(new Event('error'))))
    expect(container.textContent).toContain('媒体暂不可用')
    await advance(3)
    expect(sign).toHaveBeenCalledTimes(2)
    await settle(() => window.dispatchEvent(new Event('online')))
    expect(sign).toHaveBeenCalledTimes(3)
    await settle(() => images.forEach((element) => element.dispatchEvent(new Event('load'))))
    expect(container.textContent).not.toContain('媒体暂不可用')
    await settle(() => images.forEach((element) => element.dispatchEvent(new Event('error'))))
    expect(sign).toHaveBeenCalledTimes(4)
  })
  it.each(['resource', 'result'] as const)('keeps the %s image subscribed after a terminal load error', async (kind) => {
    const { api, sign } = signedApi()
    const asset: Asset = { id: 'a', kind: 'image', mime: 'image/png', filename: 'a.png', bytes: 1, createdAt: 1, nodeId: null, taskId: null }
    const noop = () => {}
    const node: CanvasNode = { id: 'n', kind: 'image-asset', title: 'a', position: { x: 0, y: 0 }, assetId: 'a', selectedResultId: null, modelId: null, prompt: '', params: null }
    const { container } = mount(<ReactFlowProvider>{kind === 'resource'
      ? <ResourceNode node={node} asset={asset} selected={false} api={api} workspace="w" rotation={0} playing={false}
        onRename={noop} onRotate={noop} onPlay={noop} onStop={noop} onOpen={noop} onFocus={noop} onSize={noop} />
      : <ResultMedia asset={asset} api={api} workspace="w" playing={false} onPlay={noop} onStop={noop} onOpen={noop} onDimensions={noop} />}</ReactFlowProvider>)
    await settle()
    const element = container.querySelector('img')!
    await settle(() => element.dispatchEvent(new Event('error')))
    await settle(() => element.dispatchEvent(new Event('error')))
    expect(container.querySelector('img')).toBe(element)
    await settle(() => window.dispatchEvent(new Event('online')))
    expect(sign).toHaveBeenCalledTimes(3)
    await settle(() => element.dispatchEvent(new Event('load')))
    expect(element.style.visibility).toBe('')
    expect(container.textContent).not.toContain('媒体暂不可用')
  })
  it('normal readers join a forced renewal instead of obtaining a known bad cached URL', async () => {
    const { api, sign } = signedApi()
    const cache = new MediaUrlCache(api)
    const old = await cache.resolve('w', 'a', 'original')
    let complete!: (value: Awaited<ReturnType<CanvasApi['mediaUrls']>>) => void
    sign.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve }))
    const forced = cache.recover('w', 'a', 'original', old.revision)!
    const normal = cache.resolve('w', 'a', 'original')
    expect(normal).toBe(forced)
    await Promise.resolve()
    complete({ items: [{ assetId: 'a', variant: 'original', url: 'https://assets.example/fresh', expiresAt: Date.now() + 3600000 }] })
    expect((await normal).url).not.toBe(old.url)
    expect(cache.recover('w', 'a', 'original', (await normal).revision)).toBeUndefined()
  })
  it('retains the decoded picture when renewed links fail and limits forced refresh until online recovery', async () => {
    const { api, sign } = signedApi()
    const { container } = mount(image(api)); await settle()
    const displayed = container.querySelector('img')!
    await settle(() => displayed.dispatchEvent(new Event('load')))
    const old = displayed.src
    await advance(56)
    await settle(() => preloads.at(-1)!.dispatchEvent(new Event('error')))
    expect(sign).toHaveBeenCalledTimes(3)
    await settle(() => preloads.at(-1)!.dispatchEvent(new Event('error')))
    expect(displayed.src).toBe(old); expect(displayed.style.visibility).toBe('')
    await advance(3)
    expect(sign).toHaveBeenCalledTimes(3)
    await settle(() => window.dispatchEvent(new Event('online')))
    expect(sign).toHaveBeenCalledTimes(4)
    await settle(() => preloads.at(-1)!.dispatchEvent(new Event('load')))
    expect(displayed.src).not.toBe(old)
    expect(container.textContent).not.toContain('媒体暂不可用')
  })
  it('cleans timer and global recovery listeners after the last media subscriber unmounts', async () => {
    const { api, sign } = signedApi()
    const { root } = mount(image(api)); await settle()
    act(() => root.unmount()); roots.pop()
    expect(vi.getTimerCount()).toBe(0)
    await settle(() => window.dispatchEvent(new Event('online')))
    expect(sign).toHaveBeenCalledTimes(1)
  })
})

describe('renewed playback sources', () => {
  it('reloads a failed video even when a same-second forced signature returns the same URL', async () => {
    const { api, sign } = signedApi()
    sign.mockImplementation(async (_canvas, items) => ({
      items: items.map((item) => ({ ...item, url: 'https://assets.example/same', expiresAt: Date.now() + 3600000 })),
    }))
    const setSource = vi.spyOn(HTMLMediaElement.prototype, 'src', 'set')
    const { container } = mount(<VideoPlayer src="" api={api} canvas="w" assetId="v" label="video" />)
    await settle()
    const video = container.querySelector('video')!
    await settle(() => { video.dispatchEvent(new Event('loadedmetadata')); video.dispatchEvent(new Event('loadeddata')) })
    await settle(() => video.dispatchEvent(new Event('error')))
    expect(sign).toHaveBeenCalledTimes(2); expect(setSource).toHaveBeenCalledTimes(2)
    await settle(() => video.dispatchEvent(new Event('error')))
    expect(sign).toHaveBeenCalledTimes(2)
    await advance(3)
    expect(sign).toHaveBeenCalledTimes(2)
  })
  it('preserves current playback state across successive renewals and honours pause during metadata loading', async () => {
    let source!: ReturnType<typeof useRefreshingSource>
    function Player({ url }: { url: string }) {
      const ref = useRef<HTMLAudioElement>(null)
      source = useRefreshingSource(ref, url)
      return <audio ref={ref} />
    }
    const { container, root } = mount(<Player url="https://assets.example/one" />)
    const audio = container.querySelector('audio')!
    await settle(() => audio.dispatchEvent(new Event('loadedmetadata')))
    Object.defineProperties(audio, { currentTime: { value: 31, writable: true, configurable: true },
      duration: { value: 120, configurable: true }, paused: { value: false, configurable: true } })
    audio.volume = .4; audio.muted = true; audio.playbackRate = 1.5
    act(() => root.render(<Player url="https://assets.example/two" />))
    audio.currentTime = 0
    await settle(() => audio.dispatchEvent(new Event('loadedmetadata')))
    expect(audio.currentTime).toBe(31); expect(audio.play).toHaveBeenCalledTimes(1)
    expect([audio.volume, audio.muted, audio.playbackRate]).toEqual([.4, true, 1.5])
    audio.currentTime = 78
    act(() => root.render(<Player url="https://assets.example/three" />))
    audio.currentTime = 0
    act(() => source.pause())
    await settle(() => audio.dispatchEvent(new Event('loadedmetadata')))
    expect(audio.currentTime).toBe(78); expect(audio.play).toHaveBeenCalledTimes(1)
  })
  it('waits for a fresh source before playing an expired video and ignores actions after unmount', async () => {
    const { api, sign } = signedApi()
    const { container, root } = mount(<VideoPlayer src="" api={api} canvas="w" assetId="v" label="video" />)
    await settle()
    const video = container.querySelector('video')!
    await settle(() => { video.dispatchEvent(new Event('loadedmetadata')); video.dispatchEvent(new Event('loadeddata')) })
    const old = video.src
    vi.setSystemTime(Date.now() + 70 * 60000)
    await settle(() => container.querySelector<HTMLButtonElement>('button')!.click())
    expect(sign).toHaveBeenCalledTimes(2)
    expect(video.src).not.toBe(old); expect(video.play).not.toHaveBeenCalled()
    await settle(() => video.dispatchEvent(new Event('loadedmetadata')))
    expect(video.play).toHaveBeenCalledTimes(1)
    vi.setSystemTime(Date.now() + 70 * 60000)
    await settle(() => container.querySelector<HTMLButtonElement>('button')!.click())
    act(() => root.unmount()); roots.pop()
    await settle(() => video.dispatchEvent(new Event('loadedmetadata')))
    expect(video.play).toHaveBeenCalledTimes(1)
  })
})
