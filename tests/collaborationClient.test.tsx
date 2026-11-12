// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { CollaborationClient } from '../src/client/collaboration'
import { CollaborationPanel, DispatchCard } from '../src/client/collaborationView'
import type { CollaborationTask } from '../src/shared/collaboration'

afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren() })
function task(id = 'task'): CollaborationTask {
  return { id, rootId: 'session', projectId: 'project', childId: 'child', parentCallId: 'call', role: 'story', title: '分集任务', task: '授权章节任务',
    createdAt: 1, updatedAt: 1, revision: 1, state: 'running', main: 'pending', sourceRefs: [], inputRefs: [], nodeIds: [],
    artifactRefs: [], commandCount: 0, receiptIds: [], eventCount: 1, droppedEvents: 0 }
}
function page(tasks: CollaborationTask[] = [task()], revision = 1) {
  return { tasks, revision, total: tasks.length, next: null,
    active: tasks.filter((entry) => entry.state === 'dispatched' || entry.state === 'running').length }
}
class Stream {
  static all: Stream[] = []
  onmessage?: (event: { data: string }) => void
  onerror?: () => void
  close = vi.fn()
  constructor(readonly url: string) { Stream.all.push(this) }
  send(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }) }
}
function setup(fetcher: typeof fetch) {
  Stream.all = []
  vi.stubGlobal('EventSource', Stream); vi.stubGlobal('fetch', fetcher)
  return new CollaborationClient({ url: (path, params) => `/api/${path}?${new URLSearchParams(params)}` })
}
it('shares one root stream, rejects stale HTTP and closes after final observer leaves', async () => {
  let resolve!: (response: Response) => void
  const fetcher = vi.fn(() => new Promise<Response>((r) => { resolve = r }))
  const client = setup(fetcher), first = client.subscribe('session', () => {}), second = client.subscribe('session', () => {})
  expect(Stream.all).toHaveLength(1)
  Stream.all[0].send(page([{ ...task(), revision: 4, state: 'completed' }], 4))
  resolve(new Response(JSON.stringify(page())))
  await Promise.resolve(); await Promise.resolve()
  expect(client.snapshot('session').tasks[0].state).toBe('completed')
  first(); expect(Stream.all[0].close).not.toHaveBeenCalled()
  second(); expect(Stream.all[0].close).toHaveBeenCalledOnce()
  Stream.all[0].send(page([{ ...task(), state: 'blocked' }], 5))
  expect(client.snapshot('session').tasks[0].state).toBe('completed')
})
it('isolates a session switch and connection reset from late stream responses', async () => {
  const client = setup(vi.fn(async () => new Response(JSON.stringify(page([])))))
  const off = client.subscribe('old', () => {}); off()
  const next = client.subscribe('new', () => {})
  Stream.all[0].send(page())
  expect(client.snapshot('new').tasks).toEqual([])
  Stream.all[1].send(page([task('new')], 8)); client.reset()
  Stream.all[1].send(page([task('stale')], 9))
  expect(client.snapshot('new').tasks).toEqual([])
  Stream.all.at(-1)!.send(page([task('fresh')], 1))
  expect(client.snapshot('new').tasks[0].id).toBe('fresh')
  next(); client.close()
})
it('loads detail only after expansion and preserves reading position during live updates', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const fetcher = vi.fn(async (input: any) => Response.json(String(input).includes('detail') ?
    { task: task(), events: [{ seq: 1, time: 1, actor: 'main', kind: 'dispatch', text: '派发任务' }], next: null } : page()))
  const client = setup(fetcher), root = createRoot(document.body.appendChild(document.createElement('div')))
  try {
    await act(async () => root.render(<CollaborationPanel client={client} sessionId="session" />))
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('detail'))).toBe(false)
    await act(async () => (document.querySelector('.dc-collaboration-toggle') as HTMLElement).click())
    await act(async () => { await new Promise((r) => setTimeout(r, 250)) })
    expect(document.body.textContent).toContain('派发任务')
    const scroll = document.querySelector('.dc-collaboration-history')!
    scroll.scrollTop = 55
    await act(async () => Stream.all[0].send(page([{ ...task(), revision: 2, progress: '继续阅读' }], 2)))
    expect(scroll.scrollTop).toBe(55)
    await act(async () => root.render(<CollaborationPanel client={client} sessionId="session" active={false} />))
    expect(Stream.all[0].close).toHaveBeenCalledOnce()
  } finally { await act(async () => root.unmount()); client.close() }
})
it('retains active metadata outside the newest history page and shares subscriptions', async () => {
  const client = setup(vi.fn(async () => Response.json(page([]))))
  const first = client.subscribe('session', () => {}), second = client.subscribe('session', () => {})
  Stream.all[0].send({ ...page([{ ...task(), state: 'completed' }], 2), active: 1, total: 31, next: 30,
    activeTasks: [{ ...task('older-active'), childId: 'older-child', createdAt: 0 }] })
  expect(client.snapshot('session').tasks.some((entry) => entry.id === 'older-active')).toBe(true)
  expect(client.snapshot('session').next).toBe(30)
  first(); expect(Stream.all[0].close).not.toHaveBeenCalled()
  second(); client.close()
})
it('keeps dispatch details available outside the action-only card and closes them without stopping the feed', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const fetcher = vi.fn(async (input: any) => Response.json(String(input).includes('detail') ?
    { task: task(), events: [], next: null } : page()))
  const client = setup(fetcher), root = createRoot(document.body.appendChild(document.createElement('div')))
  try {
    await act(async () => root.render(<DispatchCard client={client} sessionId="session"
      node={{ data: { id: 'task', role: 'story', title: '分集', phase: 'running' } } as any} />))
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes('detail'))).toHaveLength(0)
    await act(async () => (document.querySelector('.dc-dispatch-card button') as HTMLElement).click())
    await act(async () => { await new Promise((r) => setTimeout(r, 250)) })
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes('detail'))).toHaveLength(1)
    expect(document.querySelector('.dc-collaboration-detail')).not.toBeNull()
    await act(async () => (document.querySelector('.dc-dispatch-card button') as HTMLElement).click())
    expect(document.querySelector('.dc-collaboration-detail')).toBeNull()
    expect(Stream.all[0].close).not.toHaveBeenCalled()
  } finally { await act(async () => root.unmount()); client.close() }
})
