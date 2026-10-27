import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useStoreApi, type Rect } from '@xyflow/react'
import { fullyContainedNodeIds } from './marqueeSelection'

interface Selection { nodes: string[]; edges: string[] }
interface Gesture {
  original: Selection; extend: boolean; rect: Rect & { startX: number; startY: number }; moved: boolean
}
const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, i) => id === b[i])

/** Native Pane owns pointer capture/rectangle/auto-pan; we own geometric selection. */
export function useMarqueeSelection(selected: string[], selectedEdges: string[], onSelect: (value: Selection) => void) {
  const store = useStoreApi()
  const latest = useRef({ nodes: selected, edges: selectedEdges, onSelect })
  latest.current = { nodes: selected, edges: selectedEdges, onSelect }
  const gesture = useRef<Gesture | null>(null)
  const pointer = useRef<{ target: Element; id: number; extend: boolean } | null>(null)
  const [selecting, setSelecting] = useState(false)

  const apply = useCallback((value: Selection) => {
    const state = store.getState()
    const nodes = new Set(value.nodes), edges = new Set(value.edges)
    // getSelectionChanges mutates internal.selected before notifying controlled
    // callers. Repair both the controlled snapshot and native lookup immediately.
    const nextNodes = state.nodes.map((node) => !!node.selected !== nodes.has(node.id) ||
      !!state.nodeLookup.get(node.id)?.selected !== nodes.has(node.id) ? { ...node, selected: nodes.has(node.id) } : node)
    if (nextNodes.some((node, i) => node !== state.nodes[i])) state.setNodes(nextNodes)
    const nextEdges = state.edges.map((edge) => !!edge.selected !== edges.has(edge.id) ? { ...edge, selected: edges.has(edge.id) } : edge)
    if (nextEdges.some((edge, i) => edge !== state.edges[i])) state.setEdges(nextEdges)
    if (!same(latest.current.nodes, value.nodes) || !same(latest.current.edges, value.edges)) {
      latest.current = { ...latest.current, ...value }
      latest.current.onSelect(value)
    }
  }, [store])
  const reconcile = useCallback((rect: Rect) => {
    const current = gesture.current
    if (!current) return
    const state = store.getState()
    const nodes = new Set(current.extend ? current.original.nodes : [])
    for (const id of fullyContainedNodeIds(rect, state.transform, state.nodeLookup.values())) nodes.add(id)
    const edges = new Set(current.extend ? current.original.edges : [])
    for (const edge of state.edges) if ((edge.selectable ?? state.defaultEdgeOptions?.selectable ?? true) &&
      (nodes.has(edge.source) || nodes.has(edge.target))) edges.add(edge.id)
    apply({ nodes: [...nodes], edges: [...edges] })
  }, [apply, store])

  useEffect(() => {
    let lastRect = store.getState().userSelectionRect
    return store.subscribe((state) => {
      const rect = state.userSelectionRect
      if (rect && rect !== lastRect) {
        lastRect = rect
        if (!gesture.current) {
          gesture.current = { original: { nodes: [...latest.current.nodes], edges: [...latest.current.edges] },
            extend: pointer.current?.extend ?? false, rect, moved: false }
          setSelecting(true)
        }
        gesture.current.rect = rect
        gesture.current.moved ||= rect.width > 0 || rect.height > 0
        reconcile(rect)
      } else lastRect = rect
      // Pane sets this flag from its unfiltered candidate set after pointer-up.
      if (!rect && state.nodesSelectionActive && latest.current.nodes.length === 0) {
        store.setState({ nodesSelectionActive: false })
      }
    })
  }, [reconcile, store])

  const finish = useCallback((cancel = false) => {
    const current = gesture.current
    if (!current) return
    if (cancel) apply(current.original)
    gesture.current = null
    pointer.current = null
    store.setState({ userSelectionRect: null, userSelectionActive: false, nodesSelectionActive: latest.current.nodes.length > 0 })
    setSelecting(false)
  }, [apply, store])
  const cancel = useCallback(() => {
    // Let Pane release capture and stop its auto-pan frame loop as well.
    const current = pointer.current
    if (gesture.current && current) current.target.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: current.id }))
    finish(true)
  }, [finish])
  useEffect(() => {
    window.addEventListener('blur', cancel)
    return () => window.removeEventListener('blur', cancel)
  }, [cancel])

  const blocksNativeSelection = useCallback(() => !!gesture.current || !!store.getState().userSelectionRect, [store])
  return {
    selecting, blocksNativeSelection, cancel,
    onPointerDownCapture: (event: ReactPointerEvent) => {
      if (event.button === 0 && event.target instanceof Element) pointer.current = {
        target: event.target, id: event.pointerId, extend: event.shiftKey,
      }
    },
    onPointerUpCapture: (event: ReactPointerEvent) => {
      const current = gesture.current
      if (!current || event.button !== 0 || event.pointerId !== pointer.current?.id) return
      const bounds = store.getState().domNode?.getBoundingClientRect()
      if (current.moved && bounds) {
        const [tx, ty, zoom] = store.getState().transform
        const startX = current.rect.startX * zoom + tx, startY = current.rect.startY * zoom + ty
        const endX = event.clientX - bounds.left, endY = event.clientY - bounds.top
        reconcile({ x: Math.min(startX, endX), y: Math.min(startY, endY), width: Math.abs(endX - startX), height: Math.abs(endY - startY) })
      }
    },
    onPointerUp: (event: ReactPointerEvent) => { if (event.button === 0) finish() },
    onPointerCancel: () => finish(true),
  }
}
