import { useCallback, useEffect, useRef, useState, type ImgHTMLAttributes, type RefObject } from 'react'
import type { MediaVariant } from '../shared/objectStorage'
import { CanvasApi } from './api'
import { MediaUrlCache } from './mediaUrlCache'
import { NodeLoading, useNodeMediaLoading } from './NodeLoading'

const caches = new WeakMap<CanvasApi, MediaUrlCache>()
export function invalidateMediaUrls(api: CanvasApi): void { caches.get(api)?.invalidate() }
function cache(api: CanvasApi): MediaUrlCache {
  let value = caches.get(api)
  if (!value) { value = new MediaUrlCache(api); caches.set(api, value) }
  return value
}
export function useMediaUrl(api: CanvasApi | undefined, canvas: string, id: string, variant: MediaVariant = 'original', enabled = true) {
  const key = JSON.stringify([canvas, id, variant])
  const [value, setValue] = useState<{ key: string; api?: CanvasApi; url: string; error?: string }>({ key: '', url: '' })
  const retried = useRef(false)
  const live = useRef(false)
  const generation = useRef(0)
  const resolve = useCallback(async (force = false) => {
    if (!api || !enabled) return
    const current = generation.current
    try {
      const next = await cache(api).resolve(canvas, id, variant, force)
      if (live.current && current === generation.current) setValue({ key, api, url: next.url })
      return next.url
    } catch (error) { if (live.current && current === generation.current) setValue((old) => ({ key, api, url: old.key === key && old.api === api ? old.url : '', error: error instanceof Error ? error.message : '媒体链接读取失败' })) }
  }, [api, canvas, id, variant, enabled, key])
  useEffect(() => {
    live.current = true; generation.current++; retried.current = false; setValue({ key, api, url: '' })
    if (api && enabled) void resolve()
    const stop = api && enabled ? cache(api).watch(() => void resolve()) : undefined
    return () => { live.current = false; generation.current++; stop?.() }
  }, [resolve, api, enabled, key])
  const retry = useCallback(() => {
    if (retried.current) return false
    retried.current = true; void resolve(true); return true
  }, [resolve])
  const current = value.key === key && value.api === api ? value : { url: '', error: undefined }
  return { url: current.url, error: current.error, ensure: resolve, retry }
}
export function SignedImage({ api, canvas, assetId, variant = 'preview', onError, onLoad, trackLoading = true, ...props }: {
  api: CanvasApi; canvas: string; assetId: string; variant?: MediaVariant; trackLoading?: boolean
} & Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'>) {
  const ref = useRef<HTMLImageElement>(null)
  const [visible, setVisible] = useState(false)
  const media = useMediaUrl(api, canvas, assetId, variant, visible)
  const [loadedUrl, setLoadedUrl] = useState('')
  const [failedUrl, setFailedUrl] = useState('')
  const ready = !!media.url && loadedUrl === media.url
  const failed = !!media.error || (!!failedUrl && failedUrl === media.url)
  const pending = !ready && !failed
  const inNode = useNodeMediaLoading(trackLoading && pending)
  const currentUrl = useRef(media.url)
  currentUrl.current = media.url
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { rootMargin: '160px' })
    if (ref.current) observer.observe(ref.current)
    return () => observer.disconnect()
  }, [])
  return <><img {...props} ref={ref} src={media.url || undefined} title={media.error ?? props.title}
    style={{ ...props.style, visibility: ready ? props.style?.visibility : 'hidden' }}
    onLoad={(event) => {
      const element = event.currentTarget, url = media.url
      onLoad?.(event)
      // Keep the native broken-image/alt surface hidden until decoding finishes.
      const decoded = typeof element.decode === 'function' ? element.decode() : Promise.resolve()
      void decoded.then(() => {
        if (ref.current === element && currentUrl.current === url) setLoadedUrl(url)
      }).catch(() => {
        if (ref.current === element && currentUrl.current === url) setFailedUrl(url)
      })
    }}
    onError={(event) => { if (!media.retry()) { setFailedUrl(media.url); onError?.(event) } }} />
    {trackLoading && !inNode && <NodeLoading mediaLoading={pending} title={props.alt || '图片'} compact />}
    {failed && <span className="dc-missing" role="status">{media.error || '图片暂不可用'}</span>}</>
}
/** Set the source after capturing playback; React must not reset src before this capture. */
export function useRefreshingSource(ref: RefObject<HTMLMediaElement>, url: string, initialPlay = false) {
  useEffect(() => {
    const element = ref.current
    if (!element || !url || element.getAttribute('src') === url) return
    const time = element.currentTime
    const playing = element.getAttribute('src') ? !element.paused : initialPlay
    const restore = () => {
      if (time) element.currentTime = time
      if (playing) void element.play().catch(() => {})
    }
    element.addEventListener('loadedmetadata', restore, { once: true })
    element.src = url
    return () => element.removeEventListener('loadedmetadata', restore)
  }, [ref, url, initialPlay])
}
