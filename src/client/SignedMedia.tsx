import { useCallback, useEffect, useRef, useState, type ImgHTMLAttributes, type RefObject } from 'react'
import type { MediaVariant } from '../shared/objectStorage'
import { CanvasApi } from './api'
import { MediaUrlCache, type CachedMediaUrl } from './mediaUrlCache'
import { NodeLoading, useNodeMediaLoading } from './NodeLoading'
import { observeVisibility } from './observeVisibility'

const caches = new WeakMap<CanvasApi, MediaUrlCache>()
export function invalidateMediaUrls(api: CanvasApi): void { caches.get(api)?.invalidate() }
function cache(api: CanvasApi): MediaUrlCache {
  let value = caches.get(api)
  if (!value) { value = new MediaUrlCache(api); caches.set(api, value) }
  return value
}
export function useMediaUrl(api: CanvasApi | undefined, canvas: string, id: string, variant: MediaVariant = 'original', enabled = true) {
  const key = JSON.stringify([canvas, id, variant])
  const [value, setValue] = useState<{ key: string; api?: CanvasApi; url: string; revision: number; error?: string }>({ key: '', url: '', revision: 0 })
  const currentValue = useRef(value)
  currentValue.current = value
  const failed = useRef(false)
  const live = useRef(false)
  const generation = useRef(0)
  const apply = useCallback(async (request: Promise<CachedMediaUrl>) => {
    const current = generation.current
    try {
      const next = await request
      if (!live.current || current !== generation.current) return
      failed.current = false
      setValue((old) => old.key === key && old.api === api && old.revision === next.revision && !old.error
        ? old : { key, api, url: next.url, revision: next.revision })
      return next.url
    } catch (error) {
      if (live.current && current === generation.current) {
        failed.current = true
        setValue((old) => ({ key, api, url: old.key === key && old.api === api ? old.url : '', revision: old.revision,
          error: error instanceof Error ? error.message : '媒体链接读取失败' }))
      }
    }
  }, [api, key])
  const retry = useCallback((revision = currentValue.current.revision) => {
    if (!api || !enabled || !live.current) return false
    if (revision !== currentValue.current.revision) return true
    const work = cache(api).recover(canvas, id, variant, currentValue.current.revision)
    if (work) { void apply(work); return true }
    failed.current = true
    setValue((old) => ({ ...old, error: '媒体暂不可用' }))
    return false
  }, [api, canvas, id, variant, enabled, apply])
  const resolve = useCallback(async (force = false) => {
    if (!api || !enabled || !live.current) return
    if (failed.current && !force) {
      const work = cache(api).recover(canvas, id, variant, currentValue.current.revision)
      return work ? apply(work) : undefined
    }
    return apply(cache(api).resolve(canvas, id, variant, force))
  }, [api, canvas, id, variant, enabled, apply])
  useEffect(() => {
    live.current = true; generation.current++
    if (currentValue.current.key !== key || currentValue.current.api !== api) {
      failed.current = false
      setValue({ key, api, url: '', revision: 0 })
    }
    const stop = api && enabled ? cache(api).watch(canvas, id, variant, (reason) => {
      const stored = cache(api).peek(canvas, id, variant)
      if (reason === 'updated') {
        if (stored && stored.revision !== currentValue.current.revision) void apply(Promise.resolve(stored))
      } else if (failed.current) {
        // Permanent media failures stay subscribed, but a minute tick does not start another forced round.
        if (reason !== 'timer') retry()
        else if (!cache(api).isFresh(canvas, id, variant)) void apply(cache(api).resolve(canvas, id, variant))
      } else void resolve()
    }) : undefined
    if (api && enabled) void resolve()
    return () => { live.current = false; generation.current++; stop?.() }
  }, [resolve, retry, apply, api, enabled, key, canvas, id, variant])
  const loaded = useCallback((revision = currentValue.current.revision) => {
    if (!api || !live.current) return
    if (revision !== currentValue.current.revision) return
    failed.current = false
    cache(api).loaded(canvas, id, variant, revision)
    setValue((old) => old.error ? { ...old, error: undefined } : old)
  }, [api, canvas, id, variant])
  const isFresh = () => !!api && !failed.current && cache(api).isFresh(canvas, id, variant)
  const current = value.key === key && value.api === api ? value : { url: '', revision: 0, error: undefined }
  return { url: current.url, revision: current.revision, error: current.error, ensure: resolve, retry, loaded, isFresh }
}
export function SignedImage({ api, canvas, assetId, variant = 'preview', onError, onLoad, trackLoading = true, ...props }: {
  api: CanvasApi; canvas: string; assetId: string; variant?: MediaVariant; trackLoading?: boolean
} & Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'>) {
  const ref = useRef<HTMLImageElement>(null)
  const [visible, setVisible] = useState(false)
  const media = useMediaUrl(api, canvas, assetId, variant, visible)
  const identity = JSON.stringify([canvas, assetId, variant])
  const [displayed, setDisplayed] = useState<{ identity: string; api?: CanvasApi; url: string; revision: number }>({ identity: '', url: '', revision: 0 })
  const [loadedRevision, setLoadedRevision] = useState(0)
  const source = displayed.identity === identity && displayed.api === api ? displayed : { url: '', revision: 0 }
  const ready = !!source.url && loadedRevision === source.revision
  const failed = !!media.error
  const pending = !ready && !failed
  const inNode = useNodeMediaLoading(trackLoading && pending)
  const currentSource = useRef(source)
  currentSource.current = source
  const retry = useRef(media.retry)
  retry.current = media.retry
  useEffect(() => observeVisibility(ref.current, setVisible, { rootMargin: '160px' }), [])
  useEffect(() => {
    if (!media.url || source.revision === media.revision) return
    const next = { identity, api, url: media.url, revision: media.revision }
    if (!ready) {
      if (source.url === next.url && ref.current) {
        ref.current.removeAttribute('src'); ref.current.src = next.url
      }
      setDisplayed(next); return
    }
    // Retain the decoded picture during renewal. A failed new signature must not erase it.
    const image = new Image()
    let cancelled = false
    image.onload = () => {
      const decoding = typeof image.decode === 'function' ? image.decode() : Promise.resolve()
      void decoding.then(() => {
        if (!cancelled) { setDisplayed(next); setLoadedRevision(next.revision); media.loaded(next.revision) }
      }).catch(() => { if (!cancelled) retry.current() })
    }
    image.onerror = () => { if (!cancelled) retry.current() }
    image.src = next.url
    return () => { cancelled = true; image.onload = null; image.onerror = null; image.removeAttribute('src') }
  }, [identity, api, media.url, media.revision, source.revision, source.url, ready, media.loaded])
  return <><img {...props} ref={ref} src={source.url || undefined} title={media.error ?? props.title}
    style={{ ...props.style, visibility: ready ? props.style?.visibility : 'hidden' }}
    onLoad={(event) => {
      const element = event.currentTarget, loadingSource = source, revision = source.revision
      onLoad?.(event)
      // Keep the native broken-image/alt surface hidden until decoding finishes.
      const decoded = typeof element.decode === 'function' ? element.decode() : Promise.resolve()
      void decoded.then(() => {
        if (ref.current === element && currentSource.current === loadingSource) {
          setLoadedRevision(revision); media.loaded(revision)
        }
      }).catch(() => {
        if (ref.current === element && currentSource.current === loadingSource) media.retry(revision)
      })
    }}
    onError={(event) => { if (!media.retry(source.revision)) onError?.(event) }} />
    {trackLoading && !inNode && <NodeLoading mediaLoading={pending} title={props.alt || '图片'} compact />}
    {failed && <span className="dc-missing" role="status">{media.error || '图片暂不可用'}</span>}</>
}
/** Set the source after capturing playback; React must not reset src before this capture. */
export function useRefreshingSource(ref: RefObject<HTMLMediaElement>, url: string, initialPlay = false, identity = '', revision = 0) {
  type Transfer = {
    element: HTMLMediaElement; url: string; ready: boolean; loading: boolean
    state: { time: number; playing: boolean; volume: number; muted: boolean; rate: number }
    promise: Promise<boolean>; cancel: () => void
  }
  const pending = useRef<Transfer>()
  const previousIdentity = useRef(identity)
  const previousRevision = useRef(revision)
  const latestRevision = useRef(revision)
  latestRevision.current = revision
  const prepare = useCallback((nextUrl: string, checkRevision = false): Promise<boolean> => {
    const element = ref.current
    if (!element || !nextUrl) return Promise.resolve(false)
    if (element.getAttribute('src') === nextUrl && previousIdentity.current === identity &&
      (!checkRevision || previousRevision.current === latestRevision.current || pending.current?.loading)) {
      previousRevision.current = latestRevision.current
      return pending.current?.promise ?? Promise.resolve(true)
    }
    const previous = pending.current
    const changed = previousIdentity.current !== identity
    const state = !changed && previous?.element === element && !previous.ready ? previous.state : {
      time: changed ? 0 : element.currentTime,
      playing: changed || !element.getAttribute('src') ? initialPlay : !element.paused,
      volume: element.volume, muted: element.muted, rate: element.playbackRate,
    }
    if (!changed && previous?.element === element && !previous.ready) {
      if (element.currentTime > 0) state.time = element.currentTime
      if (!element.paused) state.playing = true
    }
    previous?.cancel()
    previousIdentity.current = identity
    previousRevision.current = latestRevision.current
    let finish!: (ready: boolean) => void
    const promise = new Promise<boolean>((resolve) => { finish = resolve })
    const transfer: Transfer = { element, url: nextUrl, state, promise, ready: false, loading: true, cancel: () => {} }
    const cleanup = () => {
      element.removeEventListener('loadedmetadata', restore)
      element.removeEventListener('error', failed)
    }
    const restore = () => {
      cleanup(); transfer.ready = true; transfer.loading = false
      element.volume = state.volume; element.muted = state.muted; element.playbackRate = state.rate
      if (Number.isFinite(state.time) && state.time > 0) element.currentTime = Number.isFinite(element.duration) ? Math.min(state.time, element.duration) : state.time
      if (state.playing) void element.play().catch(() => {})
      finish(true)
    }
    const failed = () => { cleanup(); transfer.ready = false; transfer.loading = false; finish(false) }
    transfer.cancel = () => { cleanup(); finish(false) }
    pending.current = transfer
    element.addEventListener('loadedmetadata', restore)
    element.addEventListener('error', failed)
    if (element.getAttribute('src') === nextUrl) element.removeAttribute('src')
    element.src = nextUrl
    return promise
  }, [ref, initialPlay, identity])
  const pause = useCallback(() => {
    if (pending.current) pending.current.state.playing = false
    ref.current?.pause()
  }, [ref])
  useEffect(() => {
    if (url) void prepare(url, true)
  }, [url, prepare, revision])
  useEffect(() => () => { pending.current?.cancel(); pending.current = undefined }, [ref])
  const isReady = () => !pending.current || pending.current.ready
  return { prepare, pause, isReady }
}
