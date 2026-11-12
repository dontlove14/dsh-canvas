import { useEffect, useRef, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { UseSessionStatus } from '@deepseek-ai/dsh-client-ui-session/client'
import type { ChatNodeViewProps, ChatConversationViewNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { collaborationRole, collaborationStatus, type CollaborationTask, type CollaborationDetail } from '../shared/collaboration'
import { CollaborationClient, useCollaboration, useCollaborationTask } from './collaboration'
import { UiButton, UiModal } from './ui'
import { AgentSpaceLauncher, type AgentSpaceProps } from './AgentSpaceView'

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
type LauncherProps = Omit<ViewProps, 'sessionId'> & AgentSpaceProps & { useSessionStatus?: UseSessionStatus }
/** The resident native slot supplies session sources; the card occupies the chat's upper-left seat. */
export function CollaborationLauncher(props: LauncherProps) {
  return <AgentSpaceLauncher {...props} />
}
export function DispatchCard({ node, client, sessionId }: Pick<ChatNodeViewProps<'canvas-dispatch'>, 'node'> & Omit<ViewProps, 'locate'>) {
  const { task, error } = useCollaborationTask(client, sessionId, node.data.id)
  const [open, setOpen] = useState(false)
  useEffect(() => setOpen(false), [sessionId, node.data.id])
  return <article className="dc-dispatch-card" data-dc-dispatch={task?.state ?? node.data.phase}>
    <header><span className="dc-collaboration-role">{collaborationRole[task?.role ?? node.data.role] ?? '子 Agent'}</span><span>主 Agent → 子 Agent</span></header>
    <p>{task?.title ?? node.data.title}</p>
    {task ? <TaskSummary task={task} /> : <small>{error ?? (node.data.phase === 'running' ? '派发中' : '该批次未记录协作详情，可查看原生工具返回')}</small>}
    <UiButton variant="primary" className="dc-collaboration-open" aria-expanded={open} onClick={() => {
      setOpen((value) => !value); client.open(sessionId, node.data.id)
    }}>{open ? '收起协作过程' : '查看协作过程'}</UiButton>
    {open && task && <TaskDetail task={task} client={client} sessionId={sessionId} />}
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
    }, (props) => wrapLauncher({ ...face, sessionId: props.sessionId, useSessionStatus: props.useSessionStatus, useProjection: props.useProjection })))
  })
}
