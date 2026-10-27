import { useEffect, type RefObject } from 'react'
import { useStoreApi } from '@xyflow/react'
import { ViewportCompositing } from './viewportCompositing'

/** Observe actual transforms, including fitView/minimap animations, without React frame updates. */
export function useViewportCompositing(container: RefObject<HTMLElement>, enabled: boolean): void {
  const store = useStoreApi()
  useEffect(() => {
    const root = container.current
    if (!root || !enabled) return
    const controller = new ViewportCompositing(root, store.getState().transform)
    const unsubscribe = store.subscribe((state, previous) => {
      if (state.transform !== previous.transform) controller.update(state.transform)
    })
    const hide = () => { if (root.ownerDocument.hidden) controller.settle() }
    const win = root.ownerDocument.defaultView
    root.ownerDocument.addEventListener('visibilitychange', hide)
    win?.addEventListener('blur', controller.settle)
    return () => {
      unsubscribe()
      root.ownerDocument.removeEventListener('visibilitychange', hide)
      win?.removeEventListener('blur', controller.settle)
      controller.destroy()
    }
  }, [container, enabled, store])
}
