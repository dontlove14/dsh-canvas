import { useCallback, useEffect, useMemo, useRef, useState, type RefObject, type MouseEvent as ReactMouseEvent } from 'react'
import type { OnConnectStart, OnConnectEnd } from '@xyflow/react'
import type { CanvasGraph } from '../shared/contracts'
import {
  createCanvasNode, nodeCreationChoices, outputAvailable, resolveOutput,
  type CanvasPoint, type CreatableNodeKind, type NodeCreationEnvironment, type OutputReference,
} from './nodeCreation'

export function blankCanvasPoint(container: HTMLElement | null, event: { clientX: number; clientY: number; target: EventTarget | null }): CanvasPoint | undefined {
  if (!container?.isConnected) return
  const rect = container.getBoundingClientRect(), { clientX: x, clientY: y } = event
  if (!rect.width || !rect.height || x < Math.max(0, rect.left) || y < Math.max(0, rect.top)
    || x >= Math.min(window.innerWidth, rect.right) || y >= Math.min(window.innerHeight, rect.bottom)) return
  const target = typeof document.elementFromPoint === 'function' ? document.elementFromPoint(x, y) : event.target
  if (!(target instanceof Element) || !container.contains(target) || !target.closest('.react-flow__pane')) return
  if (target.closest('.react-flow__node,.react-flow__edge,.react-flow__controls,.react-flow__minimap,.dc-editor,.dc-tools,.dc-welcome,.dc-ui-popup,input,textarea,button,[contenteditable],[role="dialog"]')) return
  return { x, y }
}
interface CreationMenu { screen: CanvasPoint; position: CanvasPoint; reference?: OutputReference; from?: CanvasPoint }

export function useNodeCreationMenu(options: {
  container: RefObject<HTMLDivElement>; enabled: boolean; workspace: string
  graph: CanvasGraph; getGraph: () => CanvasGraph; environment: NodeCreationEnvironment
  screenToFlowPosition: (point: CanvasPoint) => CanvasPoint
  edit: (update: (graph: CanvasGraph) => CanvasGraph) => void
  onCreated: (id: string) => void; report: (failure: unknown) => void
}) {
  const [menu, setMenu] = useState<CreationMenu | null>(null)
  const pending = useRef<CreationMenu | null>(null)
  const start = useRef<OutputReference>()
  const live = useRef(options); live.current = options
  const close = useCallback((focus = false) => {
    pending.current = null; start.current = undefined; setMenu(null)
    if (focus && live.current.enabled) live.current.container.current?.focus({ preventScroll: true })
  }, [])
  const show = (value: CreationMenu) => { pending.current = value; setMenu(value) }
  const onPaneContextMenu = useCallback((event: ReactMouseEvent | MouseEvent) => {
    const current = live.current
    if (!current.enabled) return
    const screen = blankCanvasPoint(current.container.current, event)
    if (!screen) return
    event.preventDefault(); event.stopPropagation(); close()
    show({ screen, position: current.screenToFlowPosition(screen) })
  }, [close])
  const onConnectStart: OnConnectStart = useCallback((_event, value) => {
    close()
    const current = live.current
    if (current.enabled && value.handleType === 'source' && value.nodeId)
      start.current = resolveOutput(current.getGraph(), value.nodeId, value.handleId, current.environment)
  }, [close])
  const onConnectEnd: OnConnectEnd = useCallback((event, state) => {
    const reference = start.current; start.current = undefined
    const current = live.current
    if (!current.enabled || !reference || event.type.endsWith('cancel') || state.toNode || state.toHandle || state.isValid
      || state.fromHandle?.type !== 'source' || state.fromNode?.id !== reference.sourceId) return
    const pointer = 'changedTouches' in event ? event.changedTouches[0] : event
    if (!pointer) return
    const screen = blankCanvasPoint(current.container.current, { clientX: pointer.clientX, clientY: pointer.clientY, target: event.target })
    if (!screen || !outputAvailable(current.getGraph(), reference, current.environment)) return
    const position = current.screenToFlowPosition(screen)
    if (!nodeCreationChoices(current.getGraph(), position, current.environment, reference).length) return
    show({ screen, position, reference, from: state.from ?? undefined })
  }, [])
  const choose = useCallback((kind: CreatableNodeKind) => {
    const value = pending.current, current = live.current
    if (!value || !current.enabled) return
    close(true) // consume before editing; repeated clicks cannot create twice
    try {
      let id: string | undefined
      current.edit((graph) => {
        const result = createCanvasNode(graph, kind, value.position, current.environment, value.reference)
        id = result.node.id
        return result.graph
      })
      if (id) current.onCreated(id)
    } catch (error) { current.report(error) }
  }, [close])
  const choices = useMemo(() => menu ? nodeCreationChoices(options.graph, menu.position, options.environment, menu.reference) : [],
    [options.graph, options.environment, menu])
  useEffect(() => {
    if (!options.enabled || (menu && !choices.length)) close()
  }, [options.enabled, menu, choices.length, close])
  useEffect(() => { close(); return () => { pending.current = null; start.current = undefined } }, [options.workspace, close])
  useEffect(() => {
    if (!options.enabled) return
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && (pending.current || start.current)) { event.preventDefault(); event.stopPropagation(); close(true) }
    }
    const blur = () => close()
    document.addEventListener('keydown', key, true); window.addEventListener('blur', blur)
    return () => { document.removeEventListener('keydown', key, true); window.removeEventListener('blur', blur) }
  }, [options.enabled, close])
  useEffect(() => {
    if (!menu) return
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest('.dc-node-creation-menu')) close()
    }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [menu, close])
  return { menu, close, choose, onPaneContextMenu, onConnectStart, onConnectEnd,
    choices }
}
