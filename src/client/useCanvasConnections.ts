import { useCallback, useEffect, useRef, type RefObject } from 'react'
import type { Connection, OnConnectStart, OnConnectEnd } from '@xyflow/react'
import type { CanvasGraph } from '../shared/contracts'
import { connectReference, resolveOutput, type NodeCreationEnvironment, type OutputReference } from './nodeCreation'
import { connectSelection, selectionOutputs } from './selectionOutputs'

export function connectionBody(container: HTMLElement | null, event: { clientX: number; clientY: number; target: EventTarget | null }): string | undefined {
  if (!container?.isConnected) return
  const bounds = container.getBoundingClientRect(), { clientX: x, clientY: y } = event
  if (!bounds.width || !bounds.height || x < Math.max(0, bounds.left) || y < Math.max(0, bounds.top)
    || x >= Math.min(window.innerWidth, bounds.right) || y >= Math.min(window.innerHeight, bounds.bottom)) return
  const hit = typeof document.elementFromPoint === 'function' ? document.elementFromPoint(x, y) : event.target
  if (!(hit instanceof Element) || !container.contains(hit)
    || hit.closest('.react-flow__handle,.dc-editor,.dc-tools,.dc-selection-toolbar,.dc-resource-toolbar,.dc-group-actions,.dc-ui-popup,input,textarea,select,button,a,[contenteditable],[role="dialog"]')) return
  return hit.closest<HTMLElement>('.react-flow__node-media')?.dataset.id
}

export function useCanvasConnections(options: {
  enabled: boolean; workspace: string; container: RefObject<HTMLDivElement>; selectionId: string; selected: string[]
  environment: NodeCreationEnvironment; getGraph: () => CanvasGraph
  edit: (update: (graph: CanvasGraph) => CanvasGraph) => void; report: (failure: unknown) => void
  creation: { close: (focus?: boolean) => void; onConnectStart: OnConnectStart; onConnectEnd: OnConnectEnd }
}) {
  const live = useRef(options); live.current = options
  const start = useRef<{ sourceId: string; batch: boolean; references: OutputReference[] }>()
  const reverse = useRef(false)
  const clear = useCallback(() => { start.current = undefined; reverse.current = false }, [])
  const onConnectStart: OnConnectStart = useCallback((event, value) => {
    clear()
    const current = live.current
    if (!current.enabled || !value.nodeId) return
    if (value.handleType === 'target') { reverse.current = true; current.creation.close(); return }
    if (value.handleType !== 'source') return
    const batch = value.nodeId === current.selectionId
    if (batch) current.creation.close()
    else current.creation.onConnectStart(event, value)
    const graph = current.getGraph()
    const reference = batch ? undefined : resolveOutput(graph, value.nodeId, value.handleId, current.environment)
    const references = batch ? selectionOutputs(graph, current.selected, current.environment) : reference ? [reference] : []
    if (references.length) start.current = { sourceId: value.nodeId, batch, references }
  }, [clear])
  const commit = useCallback((targetId: string) => {
    const picked = start.current; clear()
    const current = live.current
    if (!picked || !current.enabled) return
    current.creation.close()
    try {
      current.edit((graph) => picked.batch ? connectSelection(graph, picked.references, targetId, current.environment)
        : connectReference(graph, picked.references[0], targetId, current.environment))
    } catch (error) { current.report(error) }
  }, [clear])
  const onConnect = useCallback((connection: Connection) => {
    if (start.current?.sourceId === connection.source) { commit(connection.target); return }
    const current = live.current
    if (!reverse.current || !current.enabled) return
    clear(); current.creation.close()
    try {
      current.edit((graph) => {
        if (connection.source === current.selectionId)
          return connectSelection(graph, selectionOutputs(graph, current.selected, current.environment), connection.target, current.environment)
        const reference = resolveOutput(graph, connection.source, connection.sourceHandle, current.environment)
        if (!reference) throw new Error('请从已有素材连接到生成节点')
        return connectReference(graph, reference, connection.target, current.environment)
      })
    } catch (error) { current.report(error) }
  }, [commit, clear])
  const onConnectEnd: OnConnectEnd = useCallback((event, state) => {
    const current = live.current, picked = start.current
    if (!picked) { clear(); return }
    if (!current.enabled || event.type.endsWith('cancel') || state.isValid || state.toHandle
      || state.fromHandle?.type !== 'source' || state.fromNode?.id !== picked.sourceId) { clear(); current.creation.close(); return }
    const pointer = 'changedTouches' in event ? event.changedTouches[0] : event
    const body = pointer && connectionBody(current.container.current, { clientX: pointer.clientX, clientY: pointer.clientY, target: event.target })
    if (body) { commit(body); return }
    clear()
    if (!picked.batch) current.creation.onConnectEnd(event, state)
    else current.creation.close()
  }, [clear, commit])
  useEffect(() => { clear(); return clear }, [options.workspace, clear])
  useEffect(() => { if (!options.enabled) clear() }, [options.enabled, clear])
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') clear() }
    document.addEventListener('keydown', key, true); window.addEventListener('blur', clear)
    return () => { document.removeEventListener('keydown', key, true); window.removeEventListener('blur', clear) }
  }, [clear])
  return { onConnect, onConnectStart, onConnectEnd, clear }
}
