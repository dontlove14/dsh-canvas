import { expect, it } from 'vitest'
import { collaborationGraph, collaborationMessage, COLLABORATION_GRAPH_LIMIT, RETURN_FLOW_MS } from '../src/client/collaborationGraph'
import type { CollaborationPage, CollaborationTask } from '../src/shared/collaboration'
function task(id: string, state: CollaborationTask['state'] = 'running'): CollaborationTask {
  return { id, rootId: 'main', projectId: 'project', childId: `child-${id}`, parentCallId: 'call', role: 'story', title: `任务${id}`, task: '公开任务',
    createdAt: Number(id) || 1, updatedAt: 10, revision: 1, state, main: 'pending', sourceRefs: [], inputRefs: [], nodeIds: [],
    artifactRefs: [], commandCount: 0, receiptIds: [], eventCount: 1, droppedEvents: 0 }
}
function page(tasks: CollaborationTask[], active = tasks.filter((t) => t.state === 'running').length): CollaborationPage {
  return { tasks, total: tasks.length, active, revision: 1, next: null }
}
it('keeps separate session identities for the same role and never invents idle specialists or cross-root links', () => {
  const graph = collaborationGraph(page([task('1'), task('2', 'completed'), { ...task('3'), rootId: 'other' }]), 'main', false)
  expect(graph.dots.map((d) => d.id)).toEqual(['main', 'child-1', 'child-2'])
  expect(graph.dots.map((d) => d.working)).toEqual([false, true, false])
  expect(graph.links.every((l) => l.source === 'main')).toBe(true)
})
it('prioritizes real active/selected identities, bounds dense graphs and keeps layout stable across status events', () => {
  const tasks = Array.from({ length: 18 }, (_, i) => task(String(i + 1), i === 0 ? 'running' : 'completed'))
  const graph = collaborationGraph(page(tasks), 'main', undefined, '2')
  expect(graph.dots).toHaveLength(COLLABORATION_GRAPH_LIMIT + 1)
  expect(graph.dots.map((d) => d.id)).toEqual(expect.arrayContaining(['child-1', 'child-2']))
  expect(graph.omitted).toBe(10)
  const next = collaborationGraph(page(tasks.map((t) => ({ ...t, updatedAt: 12, revision: 5, progress: '读取中' }))), 'main', undefined, '2')
  expect(next.dots.map(({ id, x, y }) => ({ id, x, y }))).toEqual(graph.dots.map(({ id, x, y }) => ({ id, x, y })))
  expect(graph.dots[0].status).toBe('状态未知')
})
it('returns from child to main briefly only after the actual host return and stops historical flow', () => {
  const t = { ...task('1', 'completed'), activity: { seq: 2, time: 100, actor: 'host' as const, kind: 'returned' as const, text: '已核验回传' } }
  expect(collaborationGraph(page([t]), 'main', true, undefined, 101).links[0]).toMatchObject({ source: 'child-1', target: 'main', direction: 'return', flowing: true })
  expect(collaborationGraph(page([t]), 'main', false, undefined, 100 + RETURN_FLOW_MS).links[0].flowing).toBe(false)
  expect(collaborationGraph(page([{ ...t, main: 'responded' }]), 'main', false, undefined, 101).links[0].flowing).toBe(false)
  expect(collaborationGraph(page([{ ...t, activity: { ...t.activity, actor: 'child', kind: 'message' } }]), 'main', false, undefined, 101).links[0].flowing).toBe(false)
})
it('labels public child claims as reports and derives completion from host state; shows dispatch/tool/main continuation', () => {
  const t = task('1')
  expect(collaborationMessage(page([{ ...t, state: 'dispatched' }]))).toContain('主智能体 → 编剧')
  const activity = { seq: 2, time: 100, actor: 'child' as const, kind: 'message' as const, text: '全部完成' }
  expect(collaborationMessage(page([{ ...t, activity }]))).toBe('编剧报告：全部完成')
  expect(collaborationMessage(page([{ ...t, activity: { ...activity, kind: 'tool-call', tool: 'creative_source_read' } }]))).toContain('正在阅读资料')
  expect(collaborationMessage(page([{ ...t, state: 'completed' }]))).toContain('已回传')
  expect(collaborationMessage(page([{ ...t, state: 'completed', main: 'responded', activity: { ...activity, actor: 'main' } }]))).toContain('主智能体已接续')
})
