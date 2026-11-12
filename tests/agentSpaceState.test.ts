import { expect, it } from 'vitest'
import original from '../src/client/assets/agent_team/motions/manifest.json'
import { agentSpaceAction, agentSpaceRate, type AgentSpaceManifest } from '../src/shared/agentSpace'
import { AgentSpaceRoot, AgentSpaceMotions, spaceActors } from '../src/client/agentSpaceState'
import type { SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type { CollaborationTask } from '../src/shared/collaboration'

const manifest = original as unknown as AgentSpaceManifest
const snapshot = (running = false, extra = {}): SessionSnapshot => ({
  sessionId: 'root', running, pendingSubmissions: [], removed: false, openState: 'open', promptError: null, ...extra,
}) as SessionSnapshot
const event = (seq: number, type = 'turn/start', turn = 1, kind = 'completed') =>
  ({ seq, type, time: seq * 100, data: { turn, reason: { kind } } })
function task(id: string, state: CollaborationTask['state'] = 'running', role = 'story') {
  return { id, rootId: 'root', childId: id, role, state, createdAt: 200 } as CollaborationTask
}
it('shows the main immediately on a submission, preserves manual collapse on admission and resets on the next round', () => {
  const root = new AgentSpaceRoot()
  root.observe(snapshot(), true)
  expect(root.getSnapshot().visible).toBe(false)
  root.observe(snapshot(false, { pendingSubmissions: [{ requestId: 'send', time: 10, placement: 'transcript' }] }))
  expect(root.getSnapshot()).toMatchObject({ visible: true, expanded: true, phase: 'running' })
  root.expand(false); root.events([event(1)])
  expect(root.getSnapshot().expanded).toBe(false)
  root.events([event(2, 'turn/end')])
  expect(root.getSnapshot()).toMatchObject({ expanded: false, phase: 'completed' })
  root.events([event(3, 'turn/start', 2)])
  expect(root.getSnapshot()).toMatchObject({ expanded: true, phase: 'running', turn: 2, epoch: 2 })
})
it('does not interpret a status drop, unrelated completion, history prepend or duplicate as final completion', () => {
  const root = new AgentSpaceRoot()
  root.events([event(1)])
  root.observe(snapshot(false))
  expect(root.getSnapshot().phase).toBe('unknown')
  root.events([event(2, 'turn/end', 0)])
  expect(root.getSnapshot().phase).toBe('unknown')
  root.observe(snapshot(true)); root.expand(false)
  root.events([event(1)])
  expect(root.getSnapshot().expanded).toBe(false)
  root.events([event(3, 'turn/end', 1, 'blocked')])
  expect(root.getSnapshot()).toMatchObject({ expanded: true, phase: 'failed' })
})
it('uses only actually running identities on podiums, including simultaneous children of the same role', () => {
  const root = new AgentSpaceRoot(); root.events([event(1)])
  const tasks = [task('one'), task('two'), task('queued', 'dispatched'), task('done', 'completed'),
    { ...task('foreign'), rootId: 'other' }, { ...task('old'), createdAt: 1 }]
  const actors = spaceActors('root', root.getSnapshot(), tasks, manifest)
  expect(actors.filter((actor) => actor.working).map((actor) => actor.id)).toEqual(['root', 'one', 'two'])
  root.events([event(2, 'turn/end')])
  expect(spaceActors('root', root.getSnapshot(), tasks, manifest).filter((actor) => actor.working)).toEqual([])
})
it('uses delivered frontal loops for every podium role and preserves all action-specific rates', () => {
  expect(agentSpaceAction(manifest, 'main', 'idle-front').code).toBe('M09')
  for (const role of manifest.roles) {
    const action = agentSpaceAction(manifest, role.id, 'work-front')
    expect(action.action).toBe('work-front')
    expect(action.loop).toBe(true)
    expect(agentSpaceRate(manifest, action)).toBe(1.8)
  }
  expect(agentSpaceRate(manifest, agentSpaceAction(manifest, 'main', 'idle-front'))).toBe(1)
  for (const [code, expected] of Object.entries({ M06: 1, M08: 1.2, V07: 1.6, R07: 1.6, 'V07-LR': 1.8, 'R07-RL': 1.8 })) {
    expect(agentSpaceRate(manifest, manifest.actions.find((entry) => entry.code === code)!)).toBe(expected)
  }
})
it('falls back to the same role only when a frontal resource is absent', () => {
  const partial = { ...manifest, actions: manifest.actions.filter((action) => !action.action.endsWith('-front')) }
  expect(agentSpaceAction(partial, 'main', 'idle-front').code).toBe('M06')
  for (const role of partial.roles) expect(agentSpaceAction(partial, role.id, 'work-front')).toMatchObject({ role: role.id, action: 'work' })
})
it('does not replay historical dispatch; completion cancels an in-progress handoff and restores main at home facing right', () => {
  const root = new AgentSpaceRoot(); root.events([event(1)])
  const motions = new AgentSpaceMotions(manifest), first = [task('baseline')]
  let actors = spaceActors('root', root.getSnapshot(), first, manifest)
  motions.observe(root.getSnapshot(), first, actors); motions.advance(1)
  expect(motions.pose(actors[0]).action.action).toBe('work')
  const next = [...first, task('new')]
  actors = spaceActors('root', root.getSnapshot(), next, manifest)
  motions.observe(root.getSnapshot(), next, actors); motions.advance(.2)
  expect(motions.pose(actors[0]).action.action).toBe('walk-right')
  root.events([event(2, 'turn/end')])
  actors = spaceActors('root', root.getSnapshot(), next, manifest)
  motions.observe(root.getSnapshot(), next, actors)
  expect(motions.pose(actors[0])).toMatchObject({ position: [180, 660], action: { code: 'M06' } })
})
it('searches reproducible status-drop / duplicate / wrong-turn schedules without false successful completion', () => {
  let seed = 100
  for (let run = 0; run < 64; run++) {
    const root = new AgentSpaceRoot(); root.events([event(1)])
    for (let index = 0; index < 12; index++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      if (seed % 3 === 0) root.observe(snapshot(!!(seed & 8)))
      else if (seed % 3 === 1) root.events([event(1)])
      else root.events([event(2, 'turn/end', 0)])
      expect(root.getSnapshot().phase).not.toBe('completed')
    }
    root.events([event(3, 'turn/end')])
    expect(root.getSnapshot().phase).toBe('completed')
  }
})
it('restores actual running children when the native event window has not loaded the current start', () => {
  const root = new AgentSpaceRoot()
  root.observe(snapshot(true), true)
  const tasks = [task('current'), task('old-done', 'completed'), { ...task('foreign'), rootId: 'other' }]
  expect(spaceActors('root', root.getSnapshot(), tasks, manifest).filter((actor) => actor.working).map((actor) => actor.id))
    .toEqual(['root', 'current'])
  root.events([event(2, 'turn/end')])
  expect(root.getSnapshot()).toMatchObject({ phase: 'completed', expanded: false, turn: 1 })
})
