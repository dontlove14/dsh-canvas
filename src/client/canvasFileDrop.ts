import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'

type DropPoint = { x: number; y: number }
type ReceiveFiles = (files: File[], point: DropPoint) => void

/** Own file drops before the host's document listeners, only over this visible canvas. */
export function bindCanvasFileDrop(root: HTMLElement, receive: ReceiveFiles): () => void {
  const doc = root.ownerDocument
  const view = doc.defaultView!
  let owned = false
  const withinCanvas = (event: DragEvent) => {
    if (!root.isConnected || doc.hidden || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return false
    const rect = root.getBoundingClientRect()
    const left = Math.max(0, rect.left), top = Math.max(0, rect.top)
    const right = Math.min(view.innerWidth, rect.right), bottom = Math.min(view.innerHeight, rect.bottom)
    if (rect.width <= 0 || rect.height <= 0 || right <= left || bottom <= top
      || event.clientX < left || event.clientX >= right || event.clientY < top || event.clientY >= bottom) return false
    const hit = typeof doc.elementFromPoint === 'function' ? doc.elementFromPoint(event.clientX, event.clientY) : event.target
    return hit instanceof view.Node && root.contains(hit) && view.getComputedStyle(root).visibility !== 'hidden'
  }
  const stop = (event: DragEvent) => {
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  const reset = () => { owned = false }
  const handle = (event: DragEvent) => {
    const transfer = event.dataTransfer
    if (!transfer || !(Array.from(transfer.types).includes('Files') || (event.type === 'drop' && transfer.files.length > 0))) return
    if (event.type === 'dragleave') {
      // The host never saw this canvas's enter. Forwarding its leave would unbalance
      // the host counter when the new Agent enter arrives before this old leave.
      if (event.target instanceof view.Node && root.contains(event.target)) stop(event)
      if (!withinCanvas(event)) owned = false
      return
    }
    if (!withinCanvas(event)) { owned = false; return }
    stop(event)
    if (!owned) {
      // Clear a host mask already raised while crossing from the Agent. Its native
      // dragend cleanup resets depth; no files or replayed drop enter that path.
      view.dispatchEvent(new view.Event('dragend'))
      owned = true
    }
    transfer.dropEffect = 'copy'
    if (event.type === 'drop') {
      owned = false
      const files = Array.from(transfer.files)
      if (files.length) receive(files, { x: event.clientX, y: event.clientY })
    }
  }
  const events = ['dragenter', 'dragover', 'dragleave', 'drop'] as const
  for (const name of events) view.addEventListener(name, handle, true)
  view.addEventListener('dragend', reset)
  view.addEventListener('blur', reset)
  return () => {
    for (const name of events) view.removeEventListener(name, handle, true)
    view.removeEventListener('dragend', reset)
    view.removeEventListener('blur', reset)
  }
}

export function useCanvasFileDrop(container: RefObject<HTMLElement>, active: boolean, receive: ReceiveFiles): void {
  const latest = useRef(receive)
  useLayoutEffect(() => { latest.current = receive }, [receive])
  useEffect(() => {
    if (active && container.current) return bindCanvasFileDrop(container.current, (files, point) => latest.current(files, point))
  }, [container, active])
}
