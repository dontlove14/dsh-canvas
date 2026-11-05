import { useEffect, useId, useRef, useState, type CSSProperties } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { UseSessionStatus } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ChatNodeViewProps, ChatConversationViewNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { collaborationRole, collaborationStatus, type CollaborationTask, type CollaborationDetail } from '../shared/collaboration'
import { VoiceRing } from 'voice-ring'
import { CollaborationClient, useCollaboration, useCollaborationTask, useCollaborationView } from './collaboration'
import { collaborationGraph, collaborationMessage, RETURN_FLOW_MS } from './collaborationGraph'
import { collaborationOutset, collaborationRingMotion } from './collaborationLayout'
import { useNodeLoadingEnvironment } from './NodeLoading'
import { UiButton, UiModal } from './ui'

interface Dispatch { id: string; callId: string; role: string; title: string; phase: 'running' | 'returned' | 'failed' }
declare module '@deepseek-ai/dsh-client-ui-chat/client' { interface ChatNodeDataMap { 'canvas-dispatch': Dispatch } }
export const canvasDispatchDefinition: ConversationNodeDefinition<Dispatch | undefined> = {
  kind: 'canvas-dispatch', target: 'chat',
  match: (event) => event.type === 'tool/call' && ['canvas_specialist', 'canvas_execute'].includes(event.data.name) ?
    { id: event.data.callId, role: 'start' } : event.type === 'tool/result' ? { id: event.data.message.toolCallId, role: 'update' } : null,
  start: (_ctx, match) => {
    if (match.event.type !== 'tool/call') return
    try {
      const args = JSON.parse(match.event.data.arguments)
      return { id: typeof args.operationId === 'string' ? args.operationId : '', callId: match.event.data.callId,
        role: match.event.data.name === 'canvas_execute' ? 'executor' : args.role,
        title: String(args.note || args.task || '协作任务').slice(0, 180), phase: 'running' }
    } catch { return { id: '', callId: match.event.data.callId, role: '', title: '协作任务', phase: 'running' } }
  },
  update: (ctx, match) => ctx.state && match.event.type === 'tool/result' ?
    { ...ctx.state, phase: match.event.data.message.isError ? 'failed' : 'returned' } : ctx.state,
  publication: () => 'immediate',
  buildViewNode: (ctx) => !ctx.state || !ctx.start ? null : ({
    key: ctx.key, id: ctx.id, kind: 'canvas-dispatch', target: 'chat', data: ctx.state,
    anchorSeq: ctx.start.event.seq, location: ctx.start.location, visibility: 'visible', groupTree: 'turn',
  } satisfies ChatConversationViewNode),
}
function TaskSummary({ task }: { task: CollaborationTask }) {
  const decisions = task.artifactRefs
  return <div className="dc-collaboration-meta">
    <span>{collaborationStatus(task)}</span>
    {task.commandCount > 0 && <span>实际回执 {task.receiptIds.length}/{task.commandCount}</span>}
    {!['running', 'dispatched'].includes(task.state) && <span>{task.main === 'pending' ? '主 Agent 待处理' : '主 Agent 已接续'}</span>}
    {decisions.length > 0 && <span>{decisions.every((a) => a.status === 'approved' && !a.needsReview) ? '用户已认可' : '成果待认可 / 核对'}</span>}
  </div>
}
interface ViewProps { client: CollaborationClient; sessionId: string; locate?: (canvasId: string, nodeId: string) => void }
type LauncherProps = Omit<ViewProps, 'sessionId'> & { sessionId?: string; useSessionStatus?: UseSessionStatus }
/** The native composer overlay stays above the input while the transcript scrolls. */
export function CollaborationLauncher(props: LauncherProps) {
  return props.useSessionStatus ? <NativeCollaborationLauncher {...props} useSessionStatus={props.useSessionStatus} /> : <FloatingCollaboration {...props} />
}
function NativeCollaborationLauncher({ useSessionStatus, ...props }: LauncherProps & { useSessionStatus: UseSessionStatus }) {
  const running = useSessionStatus((status) => props.sessionId ? status.get(props.sessionId as SessionId)?.running : undefined)
  return <FloatingCollaboration {...props} mainRunning={running} />
}
function FloatingCollaboration(props: LauncherProps & { mainRunning?: boolean }) {
  const page = useCollaboration(props.client, props.sessionId)
  const view = useCollaborationView(props.client, props.sessionId)
  if (!props.sessionId || (!page.tasks.length && !view.expanded)) return null
  return <CollaborationFloat key={props.sessionId} {...props} sessionId={props.sessionId} page={page} />
}
function CollaborationFloat({ client, sessionId, mainRunning, locate, page }: ViewProps & {
  mainRunning?: boolean; page: ReturnType<typeof useCollaboration>
}) {
  const view = useCollaborationView(client, sessionId), frame = useRef<HTMLDivElement>(null), panelId = useId(), markerId = useId()
  const [visible, setVisible] = useState(!document.hidden), [layout, setLayout] = useState({ room: undefined as number | undefined, outset: 0 }), [now, setNow] = useState(Date.now())
  const environment = useNodeLoadingEnvironment(frame, visible)
  const [canvasSupported] = useState(() => {
    if (typeof CanvasRenderingContext2D === 'undefined') return false
    try { return !!document.createElement('canvas').getContext('2d') } catch { return false }
  })
  useEffect(() => {
    let intersecting = true
    const refresh = () => {
      setVisible(intersecting && !document.hidden)
      const element = frame.current
      if (!element) return
      const anchor = element.closest<HTMLElement>('[data-composer-overlay]') ?? element.parentElement
      const bounds = element.closest<HTMLElement>('[data-conversation-content]')
      const anchorRect = anchor?.getBoundingClientRect(), bottom = element.getBoundingClientRect().bottom
      const outset = anchorRect ? collaborationOutset(anchorRect, bounds?.getBoundingClientRect(),
        document.documentElement.clientWidth || window.innerWidth) : 0
      const room = bottom > 80 ? Math.max(80, bottom - 12) : undefined
      setLayout((old) => old.room === room && old.outset === outset ? old : { room, outset })
    }
    const observer = typeof IntersectionObserver === 'undefined' ? undefined : new IntersectionObserver(([entry]) => {
      intersecting = entry.isIntersecting; refresh()
    })
    if (frame.current) observer?.observe(frame.current)
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(refresh)
    // The overlay itself has zero height; measure the card/seat/chat as well
    // so growing the composer or resizing the sidebar recalculates the gutter.
    for (let ancestor = frame.current?.parentElement; ancestor && ancestor !== document.body; ancestor = ancestor.parentElement) {
      resize?.observe(ancestor)
      if (ancestor.hasAttribute('data-conversation-content')) break
    }
    refresh(); document.addEventListener('visibilitychange', refresh); window.addEventListener('resize', refresh)
    return () => { observer?.disconnect(); resize?.disconnect(); document.removeEventListener('visibilitychange', refresh); window.removeEventListener('resize', refresh) }
  }, [])
  useEffect(() => {
    const time = Date.now(); setNow(time)
    const expiries = new Set(page.tasks.map((task) => task.activity?.kind === 'returned' ? task.activity.time + RETURN_FLOW_MS : 0)
      .filter((value) => value > time))
    const timers = [...expiries].map((expiry) => setTimeout(() => setNow(Date.now()), expiry - time + 1))
    return () => timers.forEach(clearTimeout)
  }, [page.revision])
  const graph = collaborationGraph(page, page.tasks[0]?.rootId ?? sessionId, mainRunning, view.taskId, now)
  const message = page.error ? '连接中断，当前显示已保存的协作状态' : collaborationMessage(page)
  const busy = page.active > 0 || mainRunning === true
  const collapse = () => {
    client.collapse(sessionId)
    // Return keyboard focus to the resident launcher, never move the composer's caret.
    window.requestAnimationFrame?.(() => frame.current?.querySelector<HTMLButtonElement>('.dc-collaboration-compact')?.focus())
  }
  return <div ref={frame} className="dc-collaboration-launcher" data-expanded={view.expanded} data-motion-paused={environment.paused}
    style={{ '--dc-collaboration-outset': `${layout.outset}px`,
      ...(layout.room ? { '--dc-collaboration-room': `${layout.room}px` } : {}) } as CSSProperties}
    onKeyDown={(event) => { if (event.key === 'Escape' && view.expanded) { event.preventDefault(); event.stopPropagation(); collapse() } }}>
    {!view.expanded ? <>
      <div className="dc-collaboration-bubble" role="status" aria-live="polite" aria-atomic="true">
        <span className="dc-collaboration-bubble-indicator" data-working={busy} aria-hidden="true" />
        <p key={message} title={message}>{message}</p>
      </div>
      <button type="button" className="dc-collaboration-compact" aria-label={`展开智能体协作，${page.active} 个批次执行中`}
        aria-expanded={false} aria-controls={panelId} onClick={() => client.open(sessionId)}>
        <span className="dc-collaboration-ring" aria-hidden="true">
          {canvasSupported ? <VoiceRing size={58} theme={environment.theme} color={environment.ink} state={busy ? 'processing' : 'idle'}
            {...collaborationRingMotion} paused={environment.paused} dots={.65} /> : <span className="dc-collaboration-ring-fallback" />}
        </span>
        <span>智能体协作<small>{busy ? `${page.active} 个批次执行中` : '查看协作过程'}</small></span>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m7 14 5-5 5 5" /></svg>
      </button>
    </> : <section id={panelId} className="dc-collaboration-float" aria-label="智能体协作" tabIndex={-1}>
      <header className="dc-collaboration-heading"><div><strong>智能体协作</strong><small>{page.total} 个批次 · {page.active} 个执行中</small></div>
        <UiButton aria-label="缩小智能体协作" onClick={collapse}>缩小 ↘</UiButton></header>
      <div className="dc-collaboration-live-message" role="status" aria-live="polite" aria-atomic="true"><p key={message}>{message}</p></div>
      <div className="dc-collaboration-scroll">
        <div className="dc-collaboration-network" aria-label="智能体委派关系">
          <svg viewBox="0 0 480 330" aria-hidden="true" className="dc-collaboration-curves">
            <defs><marker id={markerId} markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto" markerUnits="userSpaceOnUse">
              <path d="M 0 0 L 6 3 L 0 6" fill="var(--dc-collaboration-accent)" /></marker></defs>
            {graph.links.map((link) => <g key={link.taskId} data-direction={link.direction} data-source={link.source} data-target={link.target}>
              <path className="dc-collaboration-curve" d={link.path} markerEnd={`url(#${markerId})`} />
              {link.flowing && <g className="dc-collaboration-flow"><path className="dc-edge-flow-glow" d={link.path} pathLength={100} />
                <path className="dc-edge-flow-trail" d={link.path} pathLength={100} /><path className="dc-edge-flow-core" d={link.path} pathLength={100} /></g>}
            </g>)}
          </svg>
          {graph.dots.map((dot) => <button key={dot.id} type="button" className="dc-collaboration-agent"
            style={{ left: `${dot.x / 480 * 100}%`, top: `${dot.y / 330 * 100}%` }}
            data-agent-id={dot.id} data-working={dot.working} data-selected={!!dot.taskId && view.taskId === dot.taskId}
            aria-label={`${dot.label}，${dot.status}${dot.taskId ? '，查看任务' : ''}`}
            onClick={() => dot.taskId && client.open(sessionId, dot.taskId)}>
            <span className="dc-collaboration-dot" aria-hidden="true" /><strong>{dot.label}</strong><small>{dot.status}</small>
          </button>)}
        </div>
        <div className="dc-collaboration-legend"><span>● 呼吸：处理中</span><span>● 灰色：未工作</span><span>箭头 / 流光：委派或回传方向</span></div>
        {(graph.omitted > 0 || graph.missingActive > 0) && <small className="dc-collaboration-network-note">
          {graph.omitted > 0 && `另有 ${graph.omitted} 个智能体，任务见下方。`}
          {graph.missingActive > 0 && `另有 ${graph.missingActive} 个活动批次尚未载入。`}
        </small>}
        <CollaborationPanel client={client} sessionId={sessionId} requestedTask={view.taskId} navigationRevision={view.revision} locate={locate} />
      </div>
    </section>}
  </div>
}
export function DispatchCard({ node, client, sessionId }: Pick<ChatNodeViewProps<'canvas-dispatch'>, 'node'> & Omit<ViewProps, 'locate'>) {
  const { task, error } = useCollaborationTask(client, sessionId, node.data.id)
  return <article className="dc-dispatch-card" data-dc-dispatch={task?.state ?? node.data.phase}>
    <header><span className="dc-collaboration-role">{collaborationRole[task?.role ?? node.data.role] ?? '子 Agent'}</span><span>主 Agent → 子 Agent</span></header>
    <p>{task?.title ?? node.data.title}</p>
    {task ? <TaskSummary task={task} /> : <small>{error ?? (node.data.phase === 'running' ? '派发中' : '该批次未记录协作详情，可查看原生工具返回')}</small>}
    <UiButton variant="primary" className="dc-collaboration-open" onClick={() => client.open(sessionId, node.data.id)}>查看协作过程</UiButton>
  </article>
}
function TaskDetail({ task, client, sessionId, locate }: { task: CollaborationTask } & ViewProps) {
  const [detail, setDetail] = useState<CollaborationDetail>()
  const [error, setError] = useState('')
  const [artifact, setArtifact] = useState<{ title: string; content: string; version: number; status: string; needsReview: boolean; relativePath: string }>()
  const [busy, setBusy] = useState(false)
  const request = useRef(0)
  const artifactAbort = useRef<AbortController>()
  useEffect(() => {
    const abort = new AbortController(), token = ++request.current
    const timer = setTimeout(() => {
      void client.detail(sessionId, task.id, abort.signal).then((next) => {
        if (abort.signal.aborted || token !== request.current) return
        setError('')
        setDetail((old) => {
          const events = new Map(old?.events.map((e) => [e.seq, e]) ?? [])
          for (const event of next.events) events.set(event.seq, event)
          return { ...next, events: [...events.values()].sort((a, b) => a.seq - b.seq), next: old && old.events[0]?.seq < next.events[0]?.seq ? old.next : next.next }
        })
      }).catch((error) => { if (!abort.signal.aborted) setError(error.message) })
    }, 200)
    return () => { clearTimeout(timer); abort.abort() }
  }, [client, sessionId, task.id, task.revision])
  useEffect(() => () => { request.current++; artifactAbort.current?.abort() }, [])
  const older = async () => {
    if (!detail?.next || busy) return
    const token = request.current, abort = new AbortController()
    artifactAbort.current?.abort(); artifactAbort.current = abort; setBusy(true)
    try {
      const page = await client.detail(sessionId, task.id, abort.signal, detail.next)
      if (token === request.current && !abort.signal.aborted) setDetail((old) => old ? { ...old, next: page.next, events: [...page.events, ...old.events] } : page)
    } catch (error) { if (!abort.signal.aborted) setError((error as Error).message) }
    finally { if (!abort.signal.aborted) setBusy(false) }
  }
  const showArtifact = async (id: string) => {
    const abort = new AbortController(); artifactAbort.current?.abort(); artifactAbort.current = abort
    try {
      const result = await client.read<NonNullable<typeof artifact>>('agent-collaboration-artifact', { sessionId, id: task.id, artifactId: id }, abort.signal)
      if (!abort.signal.aborted) setArtifact(result)
    } catch (error) { if (!abort.signal.aborted) setError((error as Error).message) }
  }
  return <section className="dc-collaboration-detail" aria-label="任务详情">
    <p className="dc-collaboration-task" data-dc-text-selectable="true">{task.task}</p>
    {[...task.sourceRefs, ...task.inputRefs].length > 0 && <div className="dc-collaboration-refs">输入：{[...task.sourceRefs, ...task.inputRefs].map((ref) => <span key={ref.id}>{ref.title}{ref.version && ` · v${ref.version}`}</span>)}</div>}
    {task.progress && <small>子 Agent 自报进度：{task.progress}</small>}
    {task.artifactRefs.length > 0 && <div className="dc-collaboration-refs">成果：{task.artifactRefs.map((ref) =>
      <UiButton key={ref.id} onClick={() => { void showArtifact(ref.id) }}>{ref.title} · v{ref.version}{ref.needsReview ? ' · 需核对' : ''}</UiButton>)}</div>}
    {task.canvasId && task.nodeIds.length > 0 && <div className="dc-collaboration-refs">画布节点：{[...new Set(task.nodeIds)].map((id, index) =>
      <UiButton key={id} onClick={() => locate?.(task.canvasId!, id)}>定位节点 {index + 1}</UiButton>)}</div>}
    {error && <p role="alert">{error}</p>}
    {task.droppedEvents > 0 && <small>较早的 {task.droppedEvents} 条过程已超出保留上限，原生会话记录仍可查看。</small>}
    {detail?.next && <UiButton disabled={busy} onClick={() => { void older() }}>加载更早过程</UiButton>}
    <ol className="dc-collaboration-timeline">
      {detail?.events.map((event) => <li key={event.seq} data-actor={event.actor}>
        <header><strong>{event.actor === 'host' ? '宿主回执' : event.actor === 'main' ? '主 Agent' : collaborationRole[task.role] ?? '子 Agent'}</strong>
          <time>{new Date(event.time).toLocaleTimeString()}</time></header>
        <p data-dc-text-selectable="true">{event.text}</p>
        {event.data !== undefined && <details><summary>查看工具输入 / 结果摘要</summary><pre data-dc-text-selectable="true">{JSON.stringify(event.data, null, 2)}</pre></details>}
      </li>)}
    </ol>
    {artifact && <UiModal label={`${artifact.title} · v${artifact.version}`} onClose={() => setArtifact(undefined)}>
      <div className="dc-collaboration-artifact"><small>{artifact.status === 'approved' ? '用户已认可' : artifact.status === 'rejected' ? '用户已否决' : '待用户认可'}{artifact.needsReview ? ' · 来源或依赖需重新核对' : ''} · {artifact.relativePath}</small>
        <pre data-dc-text-selectable="true">{artifact.content}</pre></div>
    </UiModal>}
  </section>
}
export function CollaborationPanel({ client, sessionId, active = true, requestedTask, navigationRevision, locate }: Omit<ViewProps, 'sessionId'> & {
  sessionId?: string; active?: boolean; requestedTask?: string; navigationRevision?: number
}) {
  const page = useCollaboration(client, sessionId, active)
  const [open, setOpen] = useState<string | undefined>(requestedTask)
  const [error, setError] = useState('')
  useEffect(() => { setOpen(requestedTask); setError('') }, [sessionId, requestedTask, navigationRevision])
  useEffect(() => {
    if (!active || !sessionId || !requestedTask || page.revision < 0 || page.tasks.some((t) => t.id === requestedTask)) return
    const abort = new AbortController()
    void client.ensureTask(sessionId, requestedTask, abort.signal).catch((e) => { if (!abort.signal.aborted) setError(e.message) })
    return () => abort.abort()
  }, [client, active, sessionId, requestedTask, page.revision])
  return <div className="dc-collaboration-panel">
    <div className="dc-collaboration-history">
      {(page.error || error) && <p role="alert">{page.error || error}</p>}
      {!page.tasks.length && <p className="dc-collaboration-empty">{!sessionId ? '选择聊天会话后查看协作过程' : page.revision < 0 ? '正在读取协作记录' : '主 Agent 派发任务后，会在这里显示协作过程。'}</p>}
      {page.tasks.map((task) => <article className="dc-collaboration-item" key={task.id}>
        <UiButton className="dc-collaboration-toggle" aria-expanded={open === task.id} onClick={() => {
          const id = open === task.id ? undefined : task.id
          setOpen(id); if (sessionId) client.open(sessionId, id)
        }}>
          <span className="dc-collaboration-role">{collaborationRole[task.role] ?? task.role}</span><span>{task.title}</span><span aria-hidden="true">{open === task.id ? '⌃' : '⌄'}</span>
        </UiButton>
        <TaskSummary task={task} />
        {open === task.id && sessionId && active && <TaskDetail key={`${sessionId}:${task.id}`} task={task} client={client} sessionId={sessionId} locate={locate} />}
      </article>)}
      {page.next !== null && sessionId && <UiButton onClick={() => { void client.older(sessionId).catch((e) => setError(e.message)) }}>加载更早批次</UiButton>}
    </div>
  </div>
}
export function installCollaborationDispatch(ctx: Context, face: { client: CollaborationClient; locate?: ViewProps['locate'] },
  wrap: (props: ViewProps & { node: ChatNodeViewProps<'canvas-dispatch'>['node'] }) => React.ReactNode,
  wrapLauncher: (props: LauncherProps) => React.ReactNode) {
  ctx.inject(['uiConversation'], (scope) => {
    scope.effect(() => scope.uiConversation.events.register(canvasDispatchDefinition))
    scope.slots.inject('conversation.chat.node', () => scope.slots.register({ name: 'conversation.chat.node', key: 'canvas-dispatch',
      inject: () => face }, wrap))
    scope.slots.inject('conversation.input.overlay', () => scope.slots.register({
      name: 'conversation.input.overlay', id: 'dsh-canvas-collaboration', order: 70,
    }, (props) => wrapLauncher({ ...face, sessionId: props.sessionId, useSessionStatus: props.useSessionStatus })))
  })
}
