import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { CanvasGraph } from '../shared/contracts'
import type { CanvasPoint, NodeCreationEnvironment } from './nodeCreation'
import { copyCanvasNodes, pasteCanvasNodes, readCanvasNodes, type NodeClipboardPacket } from './nodeClipboard'
import { copyText } from './clipboard'

interface CopyMenu { screen: CanvasPoint; ids: string[] }
interface PasteAnchor { position: CanvasPoint; centered: boolean }
const TEXT_TARGET = 'input,textarea,select,[contenteditable],[role="textbox"],[data-dc-text-selectable="true"]'

export function nativeClipboardTarget(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest(TEXT_TARGET)
}

export function useCanvasNodeClipboard(options: {
  container: RefObject<HTMLDivElement>; enabled: boolean; workspace: string; selected: readonly string[]
  environment: NodeCreationEnvironment; getGraph: () => CanvasGraph
  getSizes: () => readonly { id: string; width?: number; height?: number }[]
  screenToFlowPosition: (point: CanvasPoint) => CanvasPoint
  edit: (update: (graph: CanvasGraph) => CanvasGraph) => void
  select: (ids: string[]) => void; report: (failure: unknown) => void
  notifySuccess: (message: string) => void; closeCreation: () => void
}) {
  const live = useRef(options); live.current = options
  const [menu, setMenu] = useState<CopyMenu | null>(null)
  const [pasteStatus, setPasteStatus] = useState('正在检查剪贴板')
  const pending = useRef<CopyMenu | null>(null), anchor = useRef<PasteAnchor | null>(null)
  const epoch = useRef(0), copying = useRef(false), pointer = useRef<CanvasPoint>()
  const pasteRequest = useRef<number>()
  const repetition = useRef<{ id: string; x: number; y: number; count: number }>()
  const rightGesture = useRef<{ x: number; y: number; moved: boolean }>()
  const close = useCallback((focus = false) => {
    ++epoch.current; pasteRequest.current = undefined; pending.current = null; anchor.current = null; setMenu(null)
    if (focus && live.current.enabled) live.current.container.current?.focus({ preventScroll: true })
  }, [])
  const apply = useCallback((packet: NodeClipboardPacket, target: PasteAnchor) => {
    const current = live.current
    const base = target.centered ? {
      x: target.position.x - packet.bounds.width / 2, y: target.position.y - packet.bounds.height / 2,
    } : target.position
    const previous = repetition.current
    const count = previous?.id === packet.id && previous.x === base.x && previous.y === base.y ? previous.count + 1 : 0
    let selected: string[] = []
    current.edit((graph) => {
      const result = pasteCanvasNodes(graph, packet, { x: base.x + count * 32, y: base.y + count * 32 }, current.environment)
      selected = result.ids
      return result.graph
    })
    repetition.current = { id: packet.id, ...base, count }
    current.select(selected)
  }, [])
  const keyboardAnchor = () => {
    const current = live.current, rect = current.container.current?.getBoundingClientRect()
    const point = pointer.current
    return point ? { position: current.screenToFlowPosition(point), centered: false }
      : { position: current.screenToFlowPosition({ x: (rect?.left ?? 0) + (rect?.width ?? 0) / 2,
        y: (rect?.top ?? 0) + (rect?.height ?? 0) / 2 }), centered: true }
  }
  const showCopy = useCallback((screen: CanvasPoint, ids: string[]) => {
    if (!live.current.enabled || !ids.length || rightGesture.current?.moved) return
    close(); live.current.closeCreation()
    const value = { screen, ids: [...ids] }
    pending.current = value; setMenu(value); live.current.select(value.ids)
  }, [close])
  const copy = useCallback(async () => {
    const current = live.current, value = pending.current
    if (!current.enabled || !value || copying.current) return
    close(true); current.closeCreation()
    const request = epoch.current
    try {
      const text = copyCanvasNodes(current.getGraph(), value.ids, current.workspace, location.origin, current.getSizes())
      copying.current = true
      await copyText(text)
      if (epoch.current === request && live.current.enabled) current.notifySuccess(`已复制 ${value.ids.length} 个节点`)
    } catch (error) { if (epoch.current === request && live.current.enabled) current.report(error) }
    finally { copying.current = false }
  }, [close])
  const probePaste = useCallback((screen: CanvasPoint) => {
    close()
    const current = live.current, request = epoch.current
    anchor.current = { position: current.screenToFlowPosition(screen), centered: false }
    setPasteStatus('正在检查剪贴板')
    if (!navigator.clipboard?.readText) { setPasteStatus('请使用 Command/Ctrl + V'); return }
    void navigator.clipboard.readText().then((text) => {
      if (epoch.current !== request || !live.current.enabled) return
      const packet = readCanvasNodes(text, current.workspace, location.origin)
      pasteCanvasNodes(current.getGraph(), packet, anchor.current!.position, live.current.environment)
      setPasteStatus('')
    }).catch((error) => {
      if (epoch.current === request && live.current.enabled)
        setPasteStatus(error instanceof Error && error.name !== 'NotAllowedError' ? error.message : '请使用 Command/Ctrl + V')
    })
  }, [close])
  const paste = useCallback(async () => {
    const current = live.current, target = anchor.current
    if (!current.enabled || !target) return
    close(true); current.closeCreation()
    const request = epoch.current
    pasteRequest.current = request
    try {
      if (!navigator.clipboard?.readText) throw new Error('请使用 Command/Ctrl + V 粘贴节点')
      const text = await navigator.clipboard.readText()
      if (epoch.current !== request || !live.current.enabled) return
      apply(readCanvasNodes(text, current.workspace, location.origin), target)
    } catch (error) { if (epoch.current === request && live.current.enabled) current.report(error) }
    finally { if (pasteRequest.current === request) pasteRequest.current = undefined }
  }, [apply, close])
  useEffect(() => {
    close(); pointer.current = undefined; repetition.current = undefined
    return () => { ++epoch.current; pending.current = null; anchor.current = null }
  }, [options.workspace, close])
  useEffect(() => {
    if (!options.enabled) { close(); pointer.current = undefined; return }
    const inScope = (event: Event) => {
      const current = live.current
      return current.enabled && !document.hidden && event.target instanceof Element && current.container.current?.contains(event.target)
        && !nativeClipboardTarget(event.target)
        && !event.target.closest('.dc-editor,.dc-tools,.dc-ui-popup,[role="dialog"]')
    }
    const onCopy = (event: ClipboardEvent) => {
      if (!inScope(event) || !live.current.selected.length || !event.clipboardData || copying.current) return
      const current = live.current
      try {
        const text = copyCanvasNodes(current.getGraph(), current.selected, current.workspace, location.origin, current.getSizes())
        event.clipboardData.setData('text/plain', text); event.preventDefault()
        close(); current.closeCreation()
        current.notifySuccess(`已复制 ${current.selected.length} 个节点`)
      } catch (error) { current.report(error) }
    }
    const onPaste = (event: ClipboardEvent) => {
      if (!inScope(event) || !event.clipboardData) return
      const text = event.clipboardData.getData('text/plain')
      // Ordinary text/files keep their normal browser behavior.
      if (!text.includes('"dsh-canvas/nodes"')) return
      event.preventDefault()
      close(); live.current.closeCreation()
      try { apply(readCanvasNodes(text, live.current.workspace, location.origin), keyboardAnchor()) }
      catch (error) { live.current.report(error) }
    }
    const move = (event: PointerEvent) => {
      const element = live.current.container.current, rect = element?.getBoundingClientRect()
      if (rect && event.target instanceof Element && element?.contains(event.target)
        && !event.target.closest('.dc-tools,.dc-editor,.dc-ui-popup,[role="dialog"]')
        && event.clientX >= rect.left && event.clientX < rect.right && event.clientY >= rect.top && event.clientY < rect.bottom)
        pointer.current = { x: event.clientX, y: event.clientY }
    }
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && (pending.current || anchor.current || pasteRequest.current !== undefined)) { event.preventDefault(); close(true) }
    }
    const down = (event: MouseEvent) => {
      rightGesture.current = event.button === 2 ? { x: event.clientX, y: event.clientY, moved: false } : undefined
    }
    const drag = (event: MouseEvent) => {
      const start = rightGesture.current
      if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 3) start.moved = true
    }
    const blur = () => close()
    document.addEventListener('copy', onCopy); document.addEventListener('paste', onPaste)
    document.addEventListener('pointermove', move, { passive: true }); document.addEventListener('keydown', key, true)
    document.addEventListener('mousedown', down, true); document.addEventListener('mousemove', drag, true)
    window.addEventListener('blur', blur)
    return () => {
      document.removeEventListener('copy', onCopy); document.removeEventListener('paste', onPaste)
      document.removeEventListener('pointermove', move); document.removeEventListener('keydown', key, true)
      document.removeEventListener('mousedown', down, true); document.removeEventListener('mousemove', drag, true)
      window.removeEventListener('blur', blur)
    }
  }, [options.enabled, apply, close])
  useEffect(() => {
    if (!menu) return
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest('.dc-node-creation-menu')) close()
    }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [menu, close])
  return { menu, close, showCopy, copy, probePaste, paste, pasteStatus }
}
