import type { SessionSnapshot, SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { CollaborationTask } from '../shared/collaboration'
import { agentSpaceAction, agentSpaceRate, agentSpaceRole, type AgentSpaceAction, type AgentSpaceManifest } from '../shared/agentSpace'

export interface AgentSpaceRootState {
  visible: boolean; expanded: boolean; phase: 'idle' | 'running' | 'unknown' | 'failed' | 'completed'
  turn?: number; since: number; epoch: number
}
/** Only native root turn/end completes a round; disappearance of a stream is unknown. */
export class AgentSpaceRoot {
  private state: AgentSpaceRootState = { visible: false, expanded: true, phase: 'idle', since: Infinity, epoch: 0 }
  private listeners = new Set<() => void>()
  private seen = -1
  private previous?: SessionSnapshot
  private admission = false
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  readonly getSnapshot = () => this.state
  private set(next: Partial<AgentSpaceRootState>) {
    this.state = { ...this.state, ...next }
    for (const listener of this.listeners) listener()
  }
  expand(value: boolean) { this.set({ expanded: value }) }
  observe(snapshot: SessionSnapshot, baseline = false) {
    const previous = this.previous; this.previous = snapshot
    const pending = snapshot.pendingSubmissions.find((entry) => entry.placement !== 'queued' &&
      !previous?.pendingSubmissions.some((old) => old.requestId === entry.requestId))
    if ((!baseline && pending) || (snapshot.running && (this.state.phase === 'idle' || baseline && this.state.phase !== 'running'))) {
      this.admission = !!pending
      this.set({ visible: true, expanded: true, phase: 'running', turn: undefined,
        since: pending?.time ?? -Infinity, epoch: this.state.epoch + 1 })
    } else if (snapshot.running && this.state.phase === 'unknown') this.set({ phase: 'running' })
    else if (snapshot.removed || snapshot.openState === 'error' ||
      (!snapshot.running && this.state.phase === 'running' && !snapshot.pendingSubmissions.length)) {
      // EventSource/network errors cannot masquerade as a successful final reply.
      this.set({ phase: snapshot.promptError || snapshot.lastAgentError ? 'failed' : 'unknown' })
    }
  }
  events(entries: readonly { type: string; seq: number; time: number; data: any }[], baseline = false) {
    const relevant = entries.filter((entry) => entry.type === 'turn/start' || entry.type === 'turn/end')
    if (baseline) {
      this.seen = Math.max(-1, ...relevant.map((entry) => entry.seq))
      const last = relevant.at(-1)
      if (!last) return
      if (last.type === 'turn/start') this.set({ visible: true, phase: 'running', turn: last.data.turn,
        since: last.time, epoch: this.state.epoch + 1 })
      else this.set({ visible: true, expanded: last.data.reason?.kind !== 'completed', turn: last.data.turn,
        phase: last.data.reason?.kind === 'completed' ? 'completed' : 'failed', since: Infinity })
      return
    }
    for (const event of relevant) {
      if (event.seq <= this.seen) continue
      this.seen = event.seq
      if (event.type === 'turn/start') {
        const sameAdmission = this.admission && this.state.phase === 'running'
        this.admission = false
        this.set({ visible: true, expanded: sameAdmission ? this.state.expanded : true, phase: 'running',
          turn: event.data.turn, since: event.time, epoch: this.state.epoch + (sameAdmission ? 0 : 1) })
      } else if (event.data.turn === this.state.turn || this.state.turn === undefined &&
        ['running', 'unknown', 'failed'].includes(this.state.phase) && event.time >= this.state.since) {
        const completed = event.data.reason?.kind === 'completed'
        this.set({ visible: true, expanded: !completed, turn: event.data.turn, phase: completed ? 'completed' : 'failed' })
      }
    }
  }
  bind(binding: SessionBinding) {
    this.seen = -1; this.previous = undefined
    const feed = () => {
      const window = binding.eventSource.getSnapshot()
      if (window.change.kind === 'prepend') return
      this.events(window.entries.filter((entry) => entry.type === 'event').map((entry) => entry.event))
    }
    this.events(binding.eventSource.getSnapshot().entries.filter((entry) => entry.type === 'event').map((entry) => entry.event), true)
    this.observe(binding.session.getSnapshot(), true)
    const stopEvents = binding.eventSource.subscribe(feed)
    const stopSnapshot = binding.session.subscribe(() => this.observe(binding.session.getSnapshot()))
    return () => { stopEvents(); stopSnapshot() }
  }
}

export interface SpaceActor {
  id: string; role: string; working: boolean; failed: boolean; home: [number, number]
}
export function spaceActors(rootId: string, state: AgentSpaceRootState, tasks: readonly CollaborationTask[], manifest: AgentSpaceManifest) {
  const current = tasks.filter((task) => task.rootId === rootId && (state.since === -Infinity
    ? ['running', 'dispatched'].includes(task.state) : task.createdAt >= state.since))
  const root: SpaceActor = { id: rootId, role: 'main', home: [180, 660], working: state.phase === 'running', failed: state.phase === 'failed' }
  const actors = [root]
  for (const [index, role] of manifest.roles.filter((role) => role.id !== 'main').entries()) {
    const own = current.filter((task) => agentSpaceRole[task.role] === role.id)
    for (const [lane, task] of own.entries()) actors.push({
      id: task.childId, role: role.id, home: [430 + index * 170 + lane * 35, 612 + lane * 35],
      working: state.phase === 'running' && task.state === 'running',
      failed: !['completed', 'idle'].includes(state.phase) && task.state === 'blocked',
    })
    if (!own.length) actors.push({ id: `idle:${role.id}`, role: role.id, home: [430 + index * 170, 612], working: false, failed: false })
  }
  return actors
}

export interface ActorPose { action: AgentSpaceAction; position: [number, number]; time: number; held?: boolean }
interface Motion { id: string; action: AgentSpaceAction; from: [number, number]; to: [number, number]; delay: number }
interface Step { duration: number; motions: Motion[]; contact?: number }
interface Job { taskId: string; childId: string; steps: Step[] }
const mix = (a: number, b: number, value: number) => a + (b - a) * value
export function palmOffset(manifest: AgentSpaceManifest, action: AgentSpaceAction, time: number): [number, number] {
  const samples = action.hand?.samples
  if (!samples?.length) return [0, 0]
  let hand = samples.at(-1)!
  for (let index = 1; index < samples.length; index++) if (time <= samples[index][0]) {
    const a = samples[index - 1], b = samples[index], weight = Math.max(0, Math.min(1, (time - a[0]) / (b[0] - a[0])))
    hand = [time, mix(a[1], b[1], weight), mix(a[2], b[2], weight)]; break
  }
  const scale = 245 * (manifest.roles.find((role) => role.id === action.role)?.heightScale ?? 1) / action.bodyHeight
  return [(hand[1] - action.foot[0]) * scale, (hand[2] - action.foot[1]) * scale]
}
/** Public root→child dispatch / child→root return only. Baselines never replay a handoff. */
export class AgentSpaceMotions {
  private prior?: Map<string, CollaborationTask['state']>
  private jobs: Job[] = []
  private current?: { job: Job; step: number; elapsed: number }
  private epoch = -1
  constructor(private manifest: AgentSpaceManifest) {}
  observe(root: AgentSpaceRootState, tasks: readonly CollaborationTask[], actors: SpaceActor[]) {
    if (this.epoch !== root.epoch || root.phase !== 'running') {
      this.epoch = root.epoch; this.jobs = []; this.current = undefined; this.prior = undefined
    }
    const current = tasks.filter((task) => actors.some((actor) => actor.id === task.childId) && task.createdAt >= root.since)
    if (root.phase === 'running' && this.prior) for (const task of current) {
      const old = this.prior.get(task.id)
      if (!old && ['running', 'dispatched'].includes(task.state)) this.enqueue(task, actors, false)
      else if (old && ['running', 'dispatched'].includes(old) && task.state === 'completed') this.enqueue(task, actors, true)
    }
    this.prior = new Map(current.map((task) => [task.id, task.state]))
  }
  private enqueue(task: CollaborationTask, actors: SpaceActor[], returning: boolean) {
    const main = actors[0], child = actors.find((actor) => actor.id === task.childId)
    if (!child) return
    // Do not play an obsolete outward gesture after the actual result has returned.
    this.jobs = this.jobs.filter((job) => job.taskId !== task.id)
    if (this.current?.job.taskId === task.id) this.current = undefined
    const give = agentSpaceAction(this.manifest, returning ? child.role : 'main', 'give')
    const receive = agentSpaceAction(this.manifest, returning ? 'main' : child.role, 'receive')
    if (!give?.hand || !receive?.hand) return
    const a = palmOffset(this.manifest, give, give.hand.contactAt), b = palmOffset(this.manifest, receive, receive.hand.contactAt)
    const contact: [number, number] = returning ? [child.home[0] + a[0] - b[0], child.home[1] + a[1] - b[1]]
      : [child.home[0] + b[0] - a[0], child.home[1] + b[1] - a[1]]
    const walk = (from: [number, number], to: [number, number]): Step => {
      const action = agentSpaceAction(this.manifest, 'main', to[0] > from[0] ? 'walk-right' : 'walk-left')
      return { duration: Math.hypot(to[0] - from[0], to[1] - from[1]) / (135 * agentSpaceRate(this.manifest, action)),
        motions: [{ id: main.id, action, from, to, delay: 0 }] }
    }
    const giveTime = give.hand.contactAt / agentSpaceRate(this.manifest, give), receiveTime = receive.hand.contactAt / agentSpaceRate(this.manifest, receive)
    const contactTime = Math.max(giveTime, receiveTime)
    const giveDelay = contactTime - giveTime, receiveDelay = contactTime - receiveTime
    const duration = Math.max(giveDelay + give.duration / agentSpaceRate(this.manifest, give),
      receiveDelay + receive.duration / agentSpaceRate(this.manifest, receive)) + .25
    this.jobs.push({ taskId: task.id, childId: child.id, steps: [
      walk(main.home, contact),
      { duration, contact: contactTime, motions: [
        { id: returning ? child.id : main.id, action: give, from: returning ? child.home : contact, to: returning ? child.home : contact, delay: giveDelay },
        { id: returning ? main.id : child.id, action: receive, from: returning ? contact : child.home, to: returning ? contact : child.home, delay: receiveDelay },
      ] }, walk(contact, main.home),
    ] })
  }
  advance(seconds: number) {
    if (!this.current && this.jobs.length) this.current = { job: this.jobs.shift()!, step: 0, elapsed: 0 }
    if (!this.current) return
    this.current.elapsed += seconds
    while (this.current && this.current.elapsed >= this.current.job.steps[this.current.step].duration) {
      this.current.elapsed -= this.current.job.steps[this.current.step].duration
      if (++this.current.step >= this.current.job.steps.length)
        this.current = this.jobs.length ? { job: this.jobs.shift()!, step: 0, elapsed: this.current.elapsed } : undefined
    }
  }
  pose(actor: SpaceActor, front = false): ActorPose {
    const motion = !front && this.current?.job.steps[this.current.step].motions.find((motion) => motion.id === actor.id)
    if (motion && this.current) {
      const step = this.current.job.steps[this.current.step], elapsed = Math.max(0, this.current.elapsed - motion.delay)
      const fraction = Math.min(1, elapsed / step.duration)
      return { action: motion.action, position: [mix(motion.from[0], motion.to[0], fraction), mix(motion.from[1], motion.to[1], fraction)],
        time: elapsed * agentSpaceRate(this.manifest, motion.action),
        held: this.current.elapsed < motion.delay || !motion.action.loop &&
          elapsed * agentSpaceRate(this.manifest, motion.action) >= motion.action.duration }
    }
    const action = front ? actor.working ? 'work-front' : 'idle-front'
      : actor.working ? 'work' : actor.failed ? 'failure' : 'idle'
    return { action: agentSpaceAction(this.manifest, actor.role, action),
      position: actor.home, time: 0 }
  }
  paper(): [number, number] | undefined {
    if (!this.current) return
    const step = this.current.job.steps[this.current.step]
    if (step.contact === undefined) return
    const owner = step.motions[this.current.elapsed < step.contact ? 0 : 1]
    const elapsed = Math.max(0, this.current.elapsed - owner.delay) * agentSpaceRate(this.manifest, owner.action)
    const palm = palmOffset(this.manifest, owner.action, elapsed)
    return [owner.from[0] + palm[0], owner.from[1] + palm[1]]
  }
}
