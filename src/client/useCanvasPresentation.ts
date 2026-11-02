import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject, type SyntheticEvent } from 'react'
import type { ReactFlowInstance, Node } from '@xyflow/react'
import type { CanvasControl } from '../shared/agent'
import type { CanvasGraph } from '../shared/contracts'
import type { CanvasApi } from './api'
import type { CanvasPresentationClient } from './presentation'
import type { ViewReport } from '../shared/presentation'
import { installCanvasFollowGestures } from './canvasFollowGestures'

const emptySubscribe = () => () => {}
const emptySnapshot = () => null
const emptyRunningSnapshot = () => false
export function useCanvasPresentation({ api, presentation, viewId, sessionId, workspace, active, control, revision, graph, flow, container, focus, flush, refresh, report }: {
  api: CanvasApi; presentation?: CanvasPresentationClient; viewId: string; sessionId?: string
  workspace: string; active: boolean; control?: CanvasControl; revision: number; graph: CanvasGraph
  flow: ReactFlowInstance<any, any>; container: RefObject<HTMLDivElement | null>
  focus: (ids: string[]) => void
  flush?: () => Promise<number>; refresh?: () => Promise<void>; report?: (error: unknown) => void
}) {
  const intent = useSyncExternalStore(presentation?.subscribe ?? emptySubscribe, presentation?.getSnapshot ?? emptySnapshot, emptySnapshot)
  const running = useSyncExternalStore(presentation?.subscribe ?? emptySubscribe, presentation?.getRunningSnapshot ?? emptyRunningSnapshot, emptyRunningSnapshot)
  const [taskId, setTaskId] = useState<string>()
  const sequence = useRef(0), applied = useRef(''), acknowledged = useRef('')
  const focusRef = useRef(focus); focusRef.current = focus
  const current = useRef({ active, control, revision, graph, intent })
  current.current = { active, control, revision, graph, intent }
  const matching = !!intent && intent.sessionId === sessionId && intent.canvasId === workspace && intent.epoch === control?.epoch && control?.mode === 'agent' && control.sessionId === sessionId
  const following = matching && !!presentation?.following(intent)
  const gestures = useRef<ReturnType<typeof installCanvasFollowGestures>>()
  useEffect(() => {
    if (!presentation || !sessionId || !control || control.sessionId !== sessionId || !flush || !refresh) return
    return presentation.manualSeatFor(viewId, { control, active, report: report ?? (() => {}),
      resume: async (valid, source) => {
        const savedRevision = await flush()
        if (!valid()) return
        await api.delegate(workspace, sessionId, savedRevision, control.epoch, source)
        await refresh()
      } })
  }, [presentation, viewId, sessionId, workspace, active, control?.mode, control?.epoch, control?.sessionId, flush, refresh, report, api])
  useEffect(() => {
    const element = container.current
    if (!element || !presentation || !active || !control || control.sessionId !== sessionId) return
    const installed = installCanvasFollowGestures(element, presentation); gestures.current = installed
    return () => { if (gestures.current === installed) gestures.current = undefined; installed.dispose() }
  }, [presentation, container, active, control?.sessionId, sessionId, workspace])
  useEffect(() => {
    if (!following) { applied.current = ''; setTaskId(undefined) }
  }, [following])
  const highlighted = useMemo(() => new Set(matching && running && active && !document.hidden && intent && revision >= intent.graphRevision
    ? intent.nodeIds.filter((id) => graph.nodes.some((node) => node.id === id)) : []), [matching, running, active, intent, revision, graph.nodes])
  const reportRef = useRef<() => Promise<void>>(async () => {})
  useEffect(() => {
    if (!presentation || !sessionId || !control || control.mode !== 'agent' || control.sessionId !== sessionId) return
    let alive = true
    const send = async () => {
      const state = current.current, rect = container.current?.getBoundingClientRect()
      if (!alive || state.control?.epoch !== control.epoch) return
      const visible = state.active && !document.hidden && !!rect && rect.width > 0 && rect.height > 0 && flow.viewportInitialized
      const report: ViewReport = { sessionId, canvasId: workspace, epoch: control.epoch, viewId, sequence: ++sequence.current,
        visible, following: state.intent?.canvasId === workspace && presentation.following(state.intent) }
      if (visible && rect) {
        report.center = flow.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
        report.width = rect.width; report.height = rect.height; report.zoom = flow.getViewport().zoom
        report.sizes = Object.fromEntries(flow.getNodes().filter((node: Node) => !!node.width && !!node.height).map((node: Node) => [node.id, { width: node.width!, height: node.height! }]))
      }
      await api.reportView(report)
    }
    reportRef.current = send
    void send().catch(() => {})
    const timer = setInterval(() => { void send().catch(() => {}) }, 1000)
    return () => { alive = false; clearInterval(timer); reportRef.current = async () => {} }
  }, [api, presentation, sessionId, workspace, viewId, control?.epoch, control?.mode, flow, container])
  useEffect(() => {
    if (!matching || !following || !active || !intent || document.hidden || revision < intent.graphRevision) return
    let alive = true, frame = 0
    const captured = intent
    const valid = () => alive && presentation?.getSnapshot()?.id === captured.id && presentation.following() && current.current.active && current.current.control?.epoch === captured.epoch && !document.hidden
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => { void render().catch(() => {}) }) }
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(schedule)
    const observed = new Set<Element>()
    const observe = (element: Element) => { if (!observed.has(element)) { observed.add(element); observer?.observe(element) } }
    if (container.current) observe(container.current)
    const render = async () => {
      if (!valid()) return
      const rect = container.current?.getBoundingClientRect()
      if (!rect || !rect.width || !rect.height || !flow.viewportInitialized) { schedule(); return }
      const targets = captured.nodeIds.map((id) => graph.nodes.find((node) => node.id === id))
      if (targets.some((node) => !node)) return
      if (applied.current !== captured.id) {
        applied.current = captured.id; acknowledged.current = ''
        focusRef.current(captured.nodeIds)
        setTaskId(captured.action === 'generate' ? captured.taskId : undefined)
        schedule(); return
      }
      const primary = targets[0]
      if (primary) {
        const rendered = flow.getNodes().find((node: Node) => node.id === primary.id)
        const width = rendered?.measured?.width ?? rendered?.width ?? 320
        const height = rendered?.measured?.height ?? rendered?.height ?? 180
        const viewport = flow.getViewport()
        // Keep the current zoom unless the node and a scrollable input card need
        // more room. Center the primary node, never the combined card bounds.
        const zoom = Math.min(viewport.zoom, Math.max(.1, Math.min((rect.width - 80) / width, (rect.height - 470) / height)))
        const desired = { zoom, x: rect.width / 2 - (primary.position.x + width / 2) * zoom,
          y: rect.height / 2 - (primary.position.y + height / 2) * zoom }
        if (Math.abs(desired.x - viewport.x) > .5 || Math.abs(desired.y - viewport.y) > .5 || Math.abs(desired.zoom - viewport.zoom) > .001) {
          await flow.setViewport(desired)
          if (valid()) schedule()
          return
        }
      }
      const target = captured.nodeIds[0]
      const card = captured.taskId && captured.action === 'generate'
        ? container.current?.querySelector(`[data-dc-task-inspection="${captured.taskId}"]`)
        : target ? container.current?.querySelector(`[data-dc-current-inspection="${target}"]`) : container.current?.querySelector('.react-flow')
      const node = target ? container.current?.querySelector(`[data-id="${target}"]`) : card
      if (!card || !node) { schedule(); return }
      observe(node)
      observe(card.closest('.dc-editor') ?? card.querySelector('.dc-editor') ?? card)
      const cardBox = (card.closest('.dc-editor') ?? card.querySelector('.dc-editor') ?? card).getBoundingClientRect(), nodeBox = node.getBoundingClientRect()
      if (!cardBox.width || !nodeBox.width) { schedule(); return }
      const left = Math.min(cardBox.left, nodeBox.left), right = Math.max(cardBox.right, nodeBox.right)
      const top = Math.min(cardBox.top, nodeBox.top), bottom = Math.max(cardBox.bottom, nodeBox.bottom)
      if (target && (Math.abs((nodeBox.left + nodeBox.right) / 2 - (rect.left + rect.width / 2)) > 1 ||
        Math.abs((nodeBox.top + nodeBox.bottom) / 2 - (rect.top + rect.height / 2)) > 1)) return
      if (left < rect.left + 12 || right > rect.right - 12 || top < rect.top + 12 || bottom > rect.bottom - 65) return
      if (acknowledged.current !== captured.id) {
        await reportRef.current()
        if (!valid()) return
        await api.acknowledgePresentation({ sessionId: captured.sessionId, canvasId: workspace, epoch: captured.epoch, viewId,
          presentationId: captured.id, graphRevision: revision, status: 'presented' })
        if (valid()) acknowledged.current = captured.id
      }
    }
    void render().catch(() => {})
    return () => { alive = false; cancelAnimationFrame(frame); observer?.disconnect() }
  }, [api, presentation, viewId, sessionId, workspace, active, matching, following, intent, revision, graph, flow, container])
  const pause = () => { presentation?.pause(); applied.current = ''; setTaskId(undefined); void reportRef.current().catch(() => {}) }
  const resume = () => { applied.current = ''; presentation?.resume() }
  // Owned portals traverse this React ancestor even when outside its native DOM.
  const portalInput = (event: SyntheticEvent) => {
    if (!gestures.current || !event.nativeEvent.isTrusted || !(event.target instanceof globalThis.Node) || container.current?.contains(event.target)) return
    if (event.nativeEvent.type === 'pointerdown') gestures.current.pointerDown(event.nativeEvent as PointerEvent)
    else if (event.nativeEvent.type === 'keydown') gestures.current.keyDown(event.nativeEvent as KeyboardEvent)
    else gestures.current?.activity(event.nativeEvent)
  }
  return { following, pause, resume, portalInput, taskId: following ? taskId : undefined, highlighted }
}
