import { createContext, useContext, useSyncExternalStore } from 'react'

type ViewportSource = { getZoom: () => number; subscribe: (notify: () => void) => () => void }
const serverRatio = () => 1
const screenDpr = () => typeof window === 'undefined' ? 1 : window.devicePixelRatio

/** Integer buckets avoid reallocating a raster on every fractional zoom frame. */
export function loadingPixelRatio(dpr: number, zoom = 1): number {
  const screen = Number.isFinite(dpr) && dpr > 0 ? dpr : 1
  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1
  return Math.max(1, Math.min(8, Math.ceil(screen * scale)))
}

/** One lazy subscription per workspace; only loading indicators are notified. */
export function createLoadingResolutionStore(viewport?: ViewportSource) {
  const readers = { node: new Set<() => void>(), screen: new Set<() => void>() }
  const getNode = () => loadingPixelRatio(screenDpr(), viewport?.getZoom() ?? 1)
  const getScreen = () => loadingPixelRatio(screenDpr())
  let lastNode = 1, lastScreen = 1, watchedDpr = 1
  let query: MediaQueryList | undefined, stopViewport: (() => void) | undefined
  const notify = () => {
    const node = getNode(), screen = getScreen()
    if (node !== lastNode) { lastNode = node; readers.node.forEach((read) => read()) }
    if (screen !== lastScreen) { lastScreen = screen; readers.screen.forEach((read) => read()) }
    if (screenDpr() !== watchedDpr) watchDpr()
  }
  const watchDpr = () => {
    query?.removeEventListener('change', notify)
    watchedDpr = screenDpr()
    query = window.matchMedia?.(`(resolution: ${watchedDpr}dppx)`)
    query?.addEventListener('change', notify)
  }
  const subscribe = (kind: 'node' | 'screen', read: () => void) => {
    const first = readers.node.size + readers.screen.size === 0
    readers[kind].add(read)
    if (first && typeof window !== 'undefined') {
      lastNode = getNode(); lastScreen = getScreen()
      window.addEventListener('resize', notify)
      watchDpr()
      stopViewport = viewport?.subscribe(notify)
    }
    return () => {
      readers[kind].delete(read)
      if (readers.node.size + readers.screen.size === 0 && typeof window !== 'undefined') {
        window.removeEventListener('resize', notify)
        query?.removeEventListener('change', notify)
        query = undefined
        stopViewport?.(); stopViewport = undefined
      }
    }
  }
  return {
    getNode, getScreen,
    subscribeNode: (read: () => void) => subscribe('node', read),
    subscribeScreen: (read: () => void) => subscribe('screen', read),
  }
}

export const LoadingResolutionContext = createContext(createLoadingResolutionStore())

export function useLoadingPixelRatio(inNode: boolean): number {
  const store = useContext(LoadingResolutionContext)
  return useSyncExternalStore(inNode ? store.subscribeNode : store.subscribeScreen, inNode ? store.getNode : store.getScreen, serverRatio)
}
