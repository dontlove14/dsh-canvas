import { PanOnScrollMode, type ReactFlowProps } from '@xyflow/react'
import { useEffect, type RefObject } from 'react'

// Both wheel axes pan in screen pixels; modifier keys switch the native handler to zoom.
export const canvasScrollGestures = {
  panOnScroll: true,
  panOnScrollMode: PanOnScrollMode.Free,
  panOnScrollSpeed: 1,
  zoomOnScroll: false,
  zoomOnPinch: true,
  zoomActivationKeyCode: ['Meta', 'Control'],
} satisfies Pick<ReactFlowProps, 'panOnScroll' | 'panOnScrollMode' | 'panOnScrollSpeed' | 'zoomOnScroll' | 'zoomOnPinch' | 'zoomActivationKeyCode'>

/** Keep pointer guards on controls while forwarding pan/zoom wheels to the native canvas handler. */
export function bindCanvasActionBarGestures(root: HTMLElement): () => void {
  const view = root.ownerDocument.defaultView!
  const wheel = (event: WheelEvent) => {
    if (root.ownerDocument.hidden || !(event.target instanceof view.Element)) return
    const surface = event.target.closest('.dc-group-actions,.dc-resource-toolbar,.dc-node .dc-video-player:not(.preview)')
    const renderer = surface?.closest('.react-flow__renderer')
    if (!renderer || !root.contains(renderer)) return
    event.preventDefault(); event.stopPropagation()
    renderer.dispatchEvent(new view.WheelEvent('wheel', {
      bubbles: true, cancelable: true, deltaX: event.deltaX, deltaY: event.deltaY, deltaZ: event.deltaZ,
      deltaMode: event.deltaMode, clientX: event.clientX, clientY: event.clientY,
      ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey, altKey: event.altKey,
    }))
  }
  root.addEventListener('wheel', wheel, { capture: true, passive: false })
  return () => root.removeEventListener('wheel', wheel, true)
}

export function useCanvasActionBarGestures(container: RefObject<HTMLElement>, active: boolean): void {
  useEffect(() => {
    if (active && container.current) return bindCanvasActionBarGestures(container.current)
  }, [container, active])
}
