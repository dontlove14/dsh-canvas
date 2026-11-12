import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react'
import { ViewportPortal, useViewport } from '@xyflow/react'
import type { CanvasControl } from '../shared/agent'
import type { CanvasPresentationClient } from './presentation'
import { type ExecutorCursor, type ExecutorCursors } from './executorCursors'
import { observeVisibility } from './observeVisibility'

const empty: ExecutorCursor[] = []
const subscribeEmpty = () => () => {}
const snapshotEmpty = () => empty
function CursorActor({ cursor, store, enabled, zoom }: { cursor: ExecutorCursor; store: ExecutorCursors; enabled: boolean; zoom: number }) {
  const frame = useRef<HTMLDivElement>(null), glyph = useRef<HTMLDivElement>(null)
  const activity = cursor.activity, motion = cursor.motion
  useEffect(() => {
    const element = frame.current
    if (!element || !motion || !store.consume(activity.childId, motion.sequence)) return
    if (!enabled || typeof element.animate !== 'function') return
    const from = motion.from ?? motion.point, to = motion.point
    const distance = Math.hypot(to.x - from.x, to.y - from.y)
    const duration = Math.min(900, Math.max(140, distance * .65))
    const move = element.animate([
      { transform: `translate(${from.x}px,${from.y}px)` },
      { transform: `translate(${(from.x + to.x) / 2}px,${(from.y + to.y) / 2 - Math.min(28, distance * .08)}px)`, offset: .5 },
      { transform: `translate(${to.x}px,${to.y}px)` },
    ], { duration, easing: 'cubic-bezier(.22,.7,.2,1)' })
    const press = glyph.current?.animate([{ transform: 'scale(1)' }, { transform: 'scale(.88)' }, { transform: 'scale(1)' }],
      { duration: 180, delay: duration })
    return () => { move.cancel(); press?.cancel() }
  }, [activity.childId, motion?.sequence, enabled, store])
  return <div ref={frame} className="dc-executor-cursor" data-dc-executor-cursor={activity.childId} data-operation={activity.operationId}
    data-phase={activity.phase} data-instance={(cursor.number - 1) % 4} style={{ transform: `translate(${activity.point.x}px,${activity.point.y}px)` }}>
    <div className="dc-executor-cursor-size" style={{ transform: `scale(${1 / zoom})` }}>
      <div ref={glyph} className="dc-executor-cursor-glyph">
        <svg width="13" height="15" viewBox="0 0 1024 1024" aria-hidden="true">
          <path d="M143.832313 5.834982H143.686438A108.676545 108.676545 0 0 0 5.834982 143.686438l34.499333-11.815839-34.499333 11.815839 0.072938 0.218812 0.145874 0.437624 0.583498 1.750494 2.333993 6.71023 8.752474 25.528047L49.232663 269.867929a2254749.467572 2254749.467572 0 0 1 223.917444 652.351017l9.335972 27.205605 2.552804 7.585476 0.729373 2.188119a72.572592 72.572592 0 0 0 126.181491 40.844876 72.134968 72.134968 0 0 0 14.076895-18.963693c3.282178-6.41848 5.689108-13.639271 8.023101-20.3495l0.072937-0.291749 72.572592-209.329989 47.409231-136.830334 15.53564-44.710551 0.145874-0.364687 0.510561-0.145874 45.002301-15.900327 137.486769-48.649165c99.340573-35.228705 202.984445-71.989094 209.913487-74.906584l3.355115-1.312871c8.023101-3.136303 22.391744-8.606599 33.915834-20.130689a72.499655 72.499655 0 0 0 0-102.549813L999.240712 304.877823c-1.823432-1.969307-7.293728-7.731351-13.274585-11.961714a89.056417 89.056417 0 0 0-27.205605-12.3264h-0.145874l-2.552805-0.875247L948.184617 277.161657l-27.86204-9.263034-94.672588-31.800653A405018.007245 405018.007245 0 0 1 268.919745 48.138604L178.039896 17.504947 152.657723 8.752473 145.874556 6.637292 144.196999 5.90792 143.832313 5.834982z" />
        </svg>
      </div>
      <span className="dc-executor-cursor-label">画布操作 {cursor.number}{activity.phase === 'failed' ? ' · !' : ''}</span>
    </div>
  </div>
}
export function AgentCursorLayer({ presentation, sessionId, workspace, control, active, container }: {
  presentation?: CanvasPresentationClient; sessionId?: string; workspace: string; control?: CanvasControl; active: boolean
  container: RefObject<HTMLDivElement | null>
}) {
  const cursors = useSyncExternalStore(presentation?.cursors.subscribe ?? subscribeEmpty, presentation?.cursors.getSnapshot ?? snapshotEmpty, snapshotEmpty)
  const { zoom } = useViewport()
  const [visible, setVisible] = useState(false), [page, setPage] = useState(!document.hidden), [reduced, setReduced] = useState(false)
  useEffect(() => observeVisibility(container.current, setVisible), [container])
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    const changed = () => { setPage(!document.hidden); setReduced(media?.matches ?? false) }
    changed(); document.addEventListener('visibilitychange', changed); media?.addEventListener?.('change', changed)
    return () => { document.removeEventListener('visibilitychange', changed); media?.removeEventListener?.('change', changed) }
  }, [])
  const shown = active && visible && page, enabled = shown && !reduced
  const matching = control?.mode === 'agent' && control.sessionId === sessionId ? cursors.filter(({ activity }) =>
    activity.sessionId === sessionId && activity.canvasId === workspace && activity.epoch === control.epoch) : empty
  return <ViewportPortal><div className="dc-executor-cursor-layer" aria-hidden="true" style={{ visibility: shown ? 'visible' : 'hidden' }}>
    {presentation && matching.map((cursor) => <CursorActor key={cursor.activity.childId} cursor={cursor} store={presentation.cursors} enabled={enabled} zoom={zoom} />)}
  </div></ViewportPortal>
}
