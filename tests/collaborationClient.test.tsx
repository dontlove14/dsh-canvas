// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { CollaborationClient } from '../src/client/collaboration'
import { CollaborationLauncher, CollaborationPanel, DispatchCard } from '../src/client/collaborationView'
import type { CollaborationTask } from '../src/shared/collaboration'

vi.mock('voice-ring', () => ({ VoiceRing: ({ state, paused, theme, speed, idle }: any) =>
  <canvas data-ring-state={state} data-ring-paused={paused} data-ring-theme={theme} data-ring-speed={speed} data-ring-idle={idle} /> }))
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
  vi.stubGlobal('EventSource', Stream)
  vi.stubGlobal('fetch', fetcher)
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
  Stream.all[1].send(page([task('new')], 8))
  client.reset()
  Stream.all[1].send(page([task('stale')], 9))
  expect(client.snapshot('new').tasks).toEqual([])
  Stream.all.at(-1)!.send(page([task('fresh')], 1))
  expect(client.snapshot('new').tasks[0].id).toBe('fresh')
  next()
})
it('loads detail only after expansion, preserves scroll during live updates, and closes stream when collapsed', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const fetcher = vi.fn(async (input: string | URL | Request) => new Response(JSON.stringify(String(input).includes('detail') ?
    { task: task(), events: [{ seq: 1, time: 1, actor: 'main', kind: 'dispatch', text: '派发任务' }], next: null } : page())))
  const client = setup(fetcher as typeof fetch)
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const render = (active = true) => root.render(<CollaborationPanel client={client} sessionId="session" active={active} />)
  try {
    await act(async () => { render(); await Promise.resolve() })
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('detail'))).toBe(false)
    await act(async () => { (document.querySelector('.dc-collaboration-toggle') as HTMLElement).click() })
    await act(async () => { await new Promise((r) => setTimeout(r, 250)) })
    expect(document.body.textContent).toContain('派发任务')
    const scroll = document.querySelector('.dc-collaboration-history')!
    scroll.scrollTop = 55
    await act(async () => Stream.all[0].send(page([{ ...task(), revision: 2, progress: '继续阅读' }], 2)))
    expect(scroll.scrollTop).toBe(55)
    await act(async () => render(false))
    expect(Stream.all[0].close).toHaveBeenCalledOnce()
  } finally { await act(async () => root.unmount()); client.close() }
})
it('expands the resident float, keeps completed history visible and isolates session switches', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const client = setup(vi.fn(async () => Response.json(page([]))))
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const render = (sessionId?: string) => root.render(<CollaborationLauncher client={client} sessionId={sessionId} />)
  try {
    await act(async () => render())
    expect(Stream.all).toHaveLength(0)
    await act(async () => render('session'))
    expect(document.querySelector('.dc-collaboration-launcher')).toBeNull()
    await act(async () => Stream.all[0].send(page([task('older'), { ...task('newer'), createdAt: 2, state: 'dispatched' }], 2)))
    expect(document.querySelector('.dc-collaboration-compact')?.getAttribute('aria-label')).toContain('2 个批次执行中')
    await act(async () => (document.querySelector('.dc-collaboration-compact') as HTMLElement).click())
    expect(client.view('session').expanded).toBe(true)
    expect(document.querySelector('.dc-collaboration-float')).not.toBeNull()
    await act(async () => Stream.all[0].send(page([{ ...task('older'), revision: 3, state: 'blocked' },
      { ...task('newer'), createdAt: 2, revision: 3, state: 'completed' }], 3)))
    expect(document.querySelector('.dc-collaboration-launcher')).not.toBeNull()
    expect(document.querySelectorAll('[data-agent-id][data-working="true"]')).toHaveLength(0)
    await act(async () => (document.querySelector('[aria-label="缩小智能体协作"]') as HTMLElement).click())
    expect(document.querySelector('.dc-collaboration-float')).toBeNull()
    expect(document.querySelector('.dc-collaboration-bubble')?.textContent).toContain('已回传')
    await act(async () => Stream.all[0].send(page([{ ...task('older'), revision: 4 }], 4)))
    expect(document.querySelector('.dc-collaboration-launcher')).not.toBeNull()
    await act(async () => render('other'))
    expect(document.querySelector('.dc-collaboration-launcher')).toBeNull()
    expect(Stream.all[0].close).toHaveBeenCalledOnce()
    await act(async () => Stream.all[0].send(page([task('stale')], 5)))
    expect(document.querySelector('.dc-collaboration-launcher')).toBeNull()
  } finally { await act(async () => root.unmount()); client.close() }
})
it('shares the float/card feed and folds active tasks outside the latest metadata page without losing history pagination', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const fetcher = vi.fn(async () => Response.json(page([]))), client = setup(fetcher)
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const off = client.subscribe('session', () => {})
  try {
    await act(async () => root.render(<CollaborationLauncher client={client} sessionId="session" />))
    expect(Stream.all).toHaveLength(1); expect(fetcher).toHaveBeenCalledOnce()
    await act(async () => Stream.all[0].send({ ...page([{ ...task(), state: 'completed' }], 2), active: 1, total: 31, next: 30,
      activeTasks: [{ ...task('older-active'), childId: 'older-child', createdAt: 0 }] }))
    expect(client.snapshot('session').tasks.some((entry) => entry.id === 'older-active')).toBe(true)
    expect(client.snapshot('session').next).toBe(30)
    await act(async () => (document.querySelector('button') as HTMLElement).click())
    expect(document.querySelector('[data-agent-id="older-child"]')?.getAttribute('data-working')).toBe('true')
    await act(async () => root.unmount())
    expect(Stream.all[0].close).not.toHaveBeenCalled()
  } finally { off(); client.close() }
})
it('opens the same float from the dispatch card and reads only the requested task detail; live updates preserve reading position', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const fetcher = vi.fn(async (input: any) => Response.json(String(input).includes('detail') ?
    { task: task(), events: [], next: null } : page()))
  const client = setup(fetcher), root = createRoot(document.body.appendChild(document.createElement('div')))
  try {
    await act(async () => root.render(<><CollaborationLauncher client={client} sessionId="session" />
      <DispatchCard client={client} sessionId="session" node={{ data: { id: 'task', role: 'story', title: '分集', phase: 'running' } } as any} /></>))
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes('detail'))).toHaveLength(0)
    await act(async () => (document.querySelector('.dc-dispatch-card button') as HTMLElement).click())
    expect(client.view('session')).toMatchObject({ expanded: true, taskId: 'task' })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)) })
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes('detail'))).toHaveLength(1)
    const scroll = document.querySelector('.dc-collaboration-scroll')!
    scroll.scrollTop = 91
    await act(async () => Stream.all[0].send(page([{ ...task(), revision: 4, progress: '正在核对' }], 4)))
    expect(scroll.scrollTop).toBe(91)
    await act(async () => (document.querySelector('[aria-label="缩小智能体协作"]') as HTMLElement).click())
    expect(document.querySelector('.dc-collaboration-detail')).toBeNull()
    expect(Stream.all[0].close).not.toHaveBeenCalled()
  } finally { await act(async () => root.unmount()); client.close() }
})
it('uses actual native main running status, Voice Ring, and visibility/reduced-motion pausing', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('CanvasRenderingContext2D', class {})
  const canvas = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as any)
  let reduced = false
  const changes = new Set<() => void>()
  const media = { get matches() { return reduced }, addEventListener: (_: string, listener: () => void) => changes.add(listener),
    removeEventListener: (_: string, listener: () => void) => changes.delete(listener) }
  window.matchMedia = (() => media) as any
  const client = setup(vi.fn(async () => Response.json(page([{ ...task(), state: 'completed' }]))))
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  let running = true
  const useSessionStatus = ((selector: any) => selector(new Map([['session', { running }]]))) as any
  try {
    const render = () => root.render(<CollaborationLauncher client={client} sessionId="session" useSessionStatus={useSessionStatus} />)
    await act(async () => render())
    expect(document.querySelector('canvas')?.getAttribute('data-ring-state')).toBe('processing')
    expect(Number(document.querySelector('canvas')?.getAttribute('data-ring-speed'))).toBeGreaterThan(1)
    expect(Number(document.querySelector('canvas')?.getAttribute('data-ring-idle'))).toBeGreaterThan(.1)
    await act(async () => client.open('session'))
    expect(document.querySelector('[data-agent-id="session"]')?.getAttribute('data-working')).toBe('true')
    expect(document.querySelector('[data-agent-id="child"]')?.getAttribute('data-working')).toBe('false')
    running = false
    await act(async () => render())
    expect(document.querySelector('[data-agent-id="session"]')?.getAttribute('data-working')).toBe('false')
    await act(async () => { client.collapse('session'); reduced = true; for (const change of changes) change() })
    expect(document.querySelector('canvas')?.getAttribute('data-ring-paused')).toBe('true')
    expect(document.querySelector('.dc-collaboration-launcher')?.getAttribute('data-motion-paused')).toBe('true')
  } finally { await act(async () => root.unmount()); client.close(); canvas.mockRestore(); delete (window as any).matchMedia }
})
it('moves the overlay to the native chat gutter and updates on pane/composer resize without new reads', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const callbacks = new Set<() => void>(), watched = new Set<Element>(), disconnected = vi.fn()
  vi.stubGlobal('ResizeObserver', class {
    callback: () => void
    constructor(callback: () => void) { this.callback = callback; callbacks.add(callback) }
    observe(element: Element) { watched.add(element) }
    disconnect() { callbacks.delete(this.callback); disconnected() }
  })
  const body = document.body.appendChild(document.createElement('div')); body.dataset.conversationContent = ''
  const card = body.appendChild(document.createElement('div')); card.dataset.composerCard = ''
  const anchor = card.appendChild(document.createElement('div')); anchor.dataset.composerOverlay = ''
  let chatRight = 1272
  body.getBoundingClientRect = () => ({ left: 0, right: chatRight, width: chatRight }) as DOMRect
  anchor.getBoundingClientRect = () => ({ right: 1054, width: 980 }) as DOMRect
  const originalWidth = window.innerWidth
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 2048 })
  const fetcher = vi.fn(async () => Response.json(page())), client = setup(fetcher), root = createRoot(anchor)
  try {
    await act(async () => root.render(<CollaborationLauncher client={client} sessionId="session" />))
    const frame = document.querySelector<HTMLElement>('.dc-collaboration-launcher')!
    expect(frame.style.getPropertyValue('--dc-collaboration-outset')).toBe('206px')
    expect([...watched]).toEqual(expect.arrayContaining([anchor, card, body]))
    chatRight = 1100
    await act(async () => { for (const refresh of callbacks) refresh() })
    expect(frame.style.getPropertyValue('--dc-collaboration-outset')).toBe('34px')
    expect(fetcher).toHaveBeenCalledOnce()
    expect(Stream.all).toHaveLength(1)
  } finally {
    await act(async () => root.unmount()); client.close()
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth })
  }
  expect(disconnected).toHaveBeenCalled()
})
