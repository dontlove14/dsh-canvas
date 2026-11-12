import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import type { SessionBinding, UseProjection } from '@deepseek-ai/dsh-api-session-controller/client'
import { AGENT_SPACE_PRESET, agentSpaceRate } from '../shared/agentSpace'
import { CollaborationClient, useCollaboration } from './collaboration'
import { AgentSpaceResources } from './agentSpaceResources'
import { AgentSpaceGate } from './agentSpaceGate'
import { AgentSpaceMotions, AgentSpaceRoot, spaceActors, type SpaceActor, type ActorPose } from './agentSpaceState'
import { useNodeLoadingEnvironment } from './NodeLoading'
import { observeVisibility } from './observeVisibility'

export interface AgentSpaceProps {
  client: CollaborationClient; sessionId?: string; resources?: AgentSpaceResources; gate?: AgentSpaceGate
  getBinding?: (id: string) => SessionBinding | undefined; useProjection?: UseProjection
}
export function AgentSpaceLauncher(props: AgentSpaceProps) {
  return props.sessionId && props.resources ? <BoundSpace key={props.sessionId} {...props} sessionId={props.sessionId} resources={props.resources} /> : null
}
function BoundSpace({ client, resources, gate, sessionId, getBinding, useProjection }: AgentSpaceProps & {
  sessionId: string; resources: AgentSpaceResources
}) {
  // agentPreset is owned by the native preset registry; no local event folding.
  const preset = useProjection ? (useProjection as (key: string) => unknown)('agentPreset') : AGENT_SPACE_PRESET
  const [root] = useState(() => new AgentSpaceRoot())
  const state = useSyncExternalStore(root.subscribe, root.getSnapshot)
  const progress = useSyncExternalStore(resources.subscribe, resources.getSnapshot)
  const page = useCollaboration(client, sessionId, preset === AGENT_SPACE_PRESET)
  const binding = getBinding?.(sessionId)
  const anchor = useRef<HTMLSpanElement>(null)
  const [host, setHost] = useState<HTMLDivElement>()
  useEffect(() => binding ? root.bind(binding) : undefined, [binding, root])
  useEffect(() => {
    if (preset !== AGENT_SPACE_PRESET || resources.getSnapshot().status !== 'idle' || gate?.selecting) return
    // Restoring an existing conversation is not an explicit chooser click.
    // Explicit choices are held by the gate before the native select publishes.
    void gate?.prepareExisting()
  }, [gate, preset, resources])
  useLayoutEffect(() => {
    const container = anchor.current?.closest<HTMLElement>('[data-conversation-content]')
    if (!container || preset !== AGENT_SPACE_PRESET || !state.visible || progress.status !== 'ready') return
    const seat = document.createElement('div')
    seat.className = 'dc-agent-space-seat'
    container.prepend(seat); setHost(seat)
    return () => { seat.remove(); setHost(undefined) }
  }, [preset, state.visible, progress.status])
  return <span ref={anchor} className="dc-agent-space-anchor">
    {host && progress.status === 'ready' && preset === AGENT_SPACE_PRESET &&
      createPortal(<SpaceCard resources={resources} root={root} sessionId={sessionId} tasks={page.tasks} />, host)}
  </span>
}

function ActorSurface({ actor, pose, resources, front, paused }: {
  actor: SpaceActor; pose: ActorPose; resources: AgentSpaceResources; front: boolean; paused: boolean
}) {
  const frame = useRef<HTMLDivElement>(null), videoRef = useRef<HTMLVideoElement>()
  const { action } = pose
  const role = resources.manifest!.roles.find((role) => role.id === actor.role)!
  const height = (front ? 110 : 245) * role.heightScale / action.bodyHeight * action.size[1]
  const width = height * action.size[0] / action.size[1]
  const style = front ? {
    width: `${width}px`, height: `${height}px`, left: '50%', top: '112px',
    transform: `translate(${-action.foot[0] / action.size[0] * 100}%,${-action.foot[1] / action.size[1] * 100}%)`,
  } : {
    width: `${width / 1600 * 100}%`, height: `${height / 780 * 100}%`,
    left: `${pose.position[0] / 1600 * 100}%`, top: `${pose.position[1] / 780 * 100}%`,
    transform: `translate(${-action.foot[0] / action.size[0] * 100}%,${-action.foot[1] / action.size[1] * 100}%)`,
  }
  useLayoutEffect(() => {
    const element = frame.current, prepared = resources.video(action.video)
    if (!element || !prepared) return
    // Distinct conversation cards share cached Blobs, with one stable surface per role.
    const video = prepared.parentElement ? prepared.cloneNode() as HTMLVideoElement : prepared
    videoRef.current = video; video.muted = true; video.playsInline = true
    video.className = 'dc-agent-space-video'; video.loop = action.loop
    video.playbackRate = agentSpaceRate(resources.manifest!, action)
    video.currentTime = 0
    element.append(video)
    const ready = () => { if (video.readyState >= 2) video.dataset.ready = 'true' }
    video.addEventListener('loadeddata', ready); video.addEventListener('playing', ready); ready()
    return () => {
      video.pause(); video.removeEventListener('loadeddata', ready); video.removeEventListener('playing', ready)
      video.remove(); videoRef.current = undefined
    }
  }, [action.code, action.video, actor.id, resources])
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    let current = true
    if (paused || pose.held) video.pause()
    else void video.play().then(() => {
      if (current && video.readyState >= 2) video.dataset.ready = 'true'
    }).catch(() => {
      // Pausing or moving a prepared video can reject an older play request.
      // That does not invalidate its decoded frame or a later successful play.
    })
    return () => { current = false }
  }, [paused, action.code, action.video, actor.id, resources, pose.held])
  useLayoutEffect(() => {
    const video = videoRef.current
    if (!video || pose.time <= 0 && !pose.held) return
    const target = action.loop ? pose.time % action.duration : Math.min(pose.time, action.duration - 1 / 24)
    if (video.readyState >= 2 && Math.abs(video.currentTime - target) > .18) video.currentTime = target
  }, [pose.time, pose.held, action.duration, action.loop])
  return <div ref={frame} className="dc-agent-space-actor" style={style as CSSProperties} aria-label={role.name}
    data-agent-id={actor.role === 'main' ? actor.id : undefined} data-actor-id={actor.id} data-working={actor.working} data-role={actor.role}
    data-action={action.action} data-front-substitute={front && !action.action.endsWith('-front') ? '' : undefined}>
    <img src={resources.url(action.poster)} alt="" draggable={false} />
  </div>
}

function SpaceCard({ resources, root, sessionId, tasks }: {
  resources: AgentSpaceResources; root: AgentSpaceRoot; sessionId: string; tasks: ReturnType<typeof useCollaboration>['tasks']
}) {
  const state = useSyncExternalStore(root.subscribe, root.getSnapshot)
  const frame = useRef<HTMLDivElement>(null), control = useRef<HTMLButtonElement>(null)
  const [visible, setVisible] = useState(!document.hidden)
  const environment = useNodeLoadingEnvironment(frame, visible)
  const manifest = resources.manifest!
  const [motion] = useState(() => new AgentSpaceMotions(manifest))
  const [, tick] = useState(0)
  const actors = spaceActors(sessionId, state, tasks, manifest)
  const working = actors.filter((actor) => actor.working)
  // Keep the main identity visible when stopped/unknown without inventing activity.
  const compact = working.length ? working : [actors[0]]
  useLayoutEffect(() => {
    const seat = frame.current?.parentElement
    if (!seat?.classList.contains('dc-agent-space-seat')) return
    // Size only our absolute overlay; leave native chat, composer and width controls untouched.
    seat.dataset.expanded = String(state.expanded)
    seat.style.setProperty('--dc-agent-space-podium-width', `${Math.max(54, compact.length * 76 - 2)}px`)
  }, [state.expanded, compact.length])
  useEffect(() => { motion.observe(state, tasks, actors) }, [motion, state.epoch, state.phase, tasks])
  useEffect(() => {
    let intersecting = true
    const refresh = () => setVisible(intersecting && !document.hidden)
    const off = observeVisibility(frame.current, (value) => { intersecting = value; refresh() })
    document.addEventListener('visibilitychange', refresh); refresh()
    return () => { off(); document.removeEventListener('visibilitychange', refresh) }
  }, [])
  useEffect(() => {
    if (environment.paused || !state.expanded) return
    let frameId = 0, previous = performance.now(), lastRender = 0, alive = true
    const run = (now: number) => {
      if (!alive) return
      motion.advance(Math.min(.1, (now - previous) / 1000)); previous = now
      if (now - lastRender >= 1000 / 24) { lastRender = now; tick((value) => value + 1) }
      frameId = requestAnimationFrame(run)
    }
    frameId = requestAnimationFrame(run)
    return () => { alive = false; cancelAnimationFrame(frameId) }
  }, [motion, environment.paused, state.expanded])
  const collapse = () => { root.expand(false); control.current?.focus() }
  const paper = motion.paper()
  return <div ref={frame} className="dc-agent-space-card" data-expanded={state.expanded} data-motion-paused={environment.paused}
    role="region" aria-label="Agent 空间" onKeyDown={(event) => {
      if (event.key === 'Escape' && state.expanded) { event.preventDefault(); event.stopPropagation(); collapse() }
    }}>
    <button ref={control} type="button" className="dc-agent-space-toggle" aria-label={state.expanded ? '缩小 Agent 空间' : '展开 Agent 空间'}
      aria-expanded={state.expanded} onClick={() => state.expanded ? collapse() : root.expand(true)}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
        {state.expanded ? <path d="M5 5v6h6m8 8v-6h-6M5 11l5-5m9 7-5 5" /> : <path d="M9 5H5v4m10 10h4v-4M5 5l6 6m8 8-6-6" />}
      </svg>
    </button>
    {state.expanded ? <div className="dc-agent-space-office">
      <img className="dc-agent-space-scenery" src={resources.url('office.svg')} alt="" draggable={false} />
      <img className="dc-agent-space-scenery dc-agent-space-desks" src={resources.url('workstations.svg')} alt="" draggable={false} />
      {actors.map((actor) => <ActorSurface key={actor.id} actor={actor} pose={motion.pose(actor)} resources={resources} front={false} paused={environment.paused} />)}
      {paper && <svg className="dc-agent-space-paper" viewBox="0 0 1600 780" aria-hidden="true">
        <rect x={paper[0] - 12} y={paper[1] - 8} width="24" height="16" rx="2" fill="#fffaf0" stroke="#a58c62" strokeWidth="2" />
      </svg>}
    </div> : <div className="dc-agent-space-podiums">
      {compact.map((actor) => <div className="dc-agent-space-podium" key={actor.id}>
        <span className="dc-agent-space-platform" style={{ '--dc-agent-color': manifest.roles.find((role) => role.id === actor.role)!.color } as CSSProperties} />
        <ActorSurface actor={actor} pose={motion.pose(actor, true)} resources={resources} front paused={environment.paused} />
      </div>)}
    </div>}
  </div>
}
