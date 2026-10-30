import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react'
import type { ReactFlowInstance, Node } from '@xyflow/react'
import type { CanvasControl } from '../shared/agent'
import type { CanvasGraph } from '../shared/contracts'
import type { CanvasApi } from './api'
import type { CanvasPresentationClient } from './presentation'
import type { ViewReport } from '../shared/presentation'

const emptySubscribe = () => () => {}
const emptySnapshot = () => null
export function useCanvasPresentation({ api, presentation, viewId, sessionId, workspace, active, control, revision, graph, flow, container, focus }: {
  api: CanvasApi; presentation?: CanvasPresentationClient; viewId: string; sessionId?: string
  workspace: string; active: boolean; control?: CanvasControl; revision: number; graph: CanvasGraph
  flow: ReactFlowInstance<any, any>; container: RefObject<HTMLDivElement | null>
  focus: (ids: string[]) => void
}) {
  const intent = useSyncExternalStore(presentation?.subscribe ?? emptySubscribe, presentation?.getSnapshot ?? emptySnapshot, emptySnapshot)
  const [taskId, setTaskId] = useState<string>()
  const sequence = useRef(0), applied = useRef(''), acknowledged = useRef('')
  const focusRef = useRef(focus); focusRef.current = focus
  const current = useRef({ active, control, revision, graph, intent })
  current.current = { active, control, revision, graph, intent }
  const matching = !!intent && intent.sessionId === sessionId && intent.canvasId === workspace && intent.epoch === control?.epoch && control?.mode === 'agent'
  const following = matching && !!presentation?.following(intent)
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
    const render = async () => {
      if (!valid()) return
      const rect = container.current?.getBoundingClientRect()
      if (!rect || !rect.width || !rect.height || !flow.viewportInitialized) { frame = requestAnimationFrame(() => { void render() }); return }
      const targets = captured.nodeIds.map((id) => graph.nodes.find((node) => node.id === id))
      if (targets.some((node) => !node)) return
      if (applied.current !== captured.id) {
        applied.current = captured.id; acknowledged.current = ''
        focusRef.current(captured.nodeIds)
        setTaskId(captured.action === 'generate' ? captured.taskId : undefined)
        if (targets.length) {
          const rendered = flow.getNodes().filter((node: Node) => captured.nodeIds.includes(node.id))
          const x = Math.min(...targets.map((node) => node!.position.x)), y = Math.min(...targets.map((node) => node!.position.y))
          const right = Math.max(...targets.map((node) => node!.position.x + (rendered.find((item: Node) => item.id === node!.id)?.width ?? 320)))
          const bottom = Math.max(...targets.map((node) => node!.position.y + (rendered.find((item: Node) => item.id === node!.id)?.height ?? 180)))
          const zoom = Math.min(1, Math.max(0.1, (rect.width - 80) / (right - x + 160), (rect.height - 380) / (bottom - y + 60)))
          await flow.setViewport({ zoom, x: rect.width / 2 - (x + right) / 2 * zoom, y: 65 - y * zoom })
        }
        frame = requestAnimationFrame(() => { void render() }); return
      }
      const target = captured.nodeIds[0]
      const card = captured.taskId && captured.action === 'generate'
        ? container.current?.querySelector(`[data-dc-task-inspection="${captured.taskId}"]`)
        : target ? container.current?.querySelector(`[data-dc-current-inspection="${target}"]`) : container.current?.querySelector('.react-flow')
      const node = target ? container.current?.querySelector(`[data-id="${target}"]`) : card
      if (!card || !node) { frame = requestAnimationFrame(() => { void render() }); return }
      const cardBox = (card.closest('.dc-editor') ?? card.querySelector('.dc-editor') ?? card).getBoundingClientRect(), nodeBox = node.getBoundingClientRect()
      if (!cardBox.width || !nodeBox.width) { frame = requestAnimationFrame(() => { void render() }); return }
      const left = Math.min(cardBox.left, nodeBox.left), right = Math.max(cardBox.right, nodeBox.right)
      const top = Math.min(cardBox.top, nodeBox.top), bottom = Math.max(cardBox.bottom, nodeBox.bottom)
      const dx = left < rect.left + 12 ? rect.left + 12 - left : right > rect.right - 12 ? rect.right - 12 - right : 0
      const dy = top < rect.top + 12 ? rect.top + 12 - top : bottom > rect.bottom - 65 ? rect.bottom - 65 - bottom : 0
      if (dx || dy) {
        if (right - left > rect.width - 24 || bottom - top > rect.height - 77) return
        const viewport = flow.getViewport()
        await flow.setViewport({ ...viewport, x: viewport.x + dx, y: viewport.y + dy })
        frame = requestAnimationFrame(() => { void render() }); return
      }
      if (acknowledged.current !== captured.id) {
        await reportRef.current()
        if (!valid()) return
        await api.acknowledgePresentation({ sessionId: captured.sessionId, canvasId: workspace, epoch: captured.epoch, viewId,
          presentationId: captured.id, graphRevision: revision, status: 'presented' })
        if (valid()) acknowledged.current = captured.id
      }
    }
    void render().catch(() => {})
    return () => { alive = false; cancelAnimationFrame(frame) }
  }, [api, presentation, viewId, sessionId, workspace, active, matching, following, intent, revision, graph, flow, container])
  const pause = () => { presentation?.pause(); applied.current = ''; setTaskId(undefined); void reportRef.current().catch(() => {}) }
  const resume = () => { applied.current = ''; presentation?.resume() }
  return { following, pause, resume, taskId: following ? taskId : undefined }
}
