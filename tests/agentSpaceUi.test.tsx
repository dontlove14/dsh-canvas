// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import original from '../src/client/assets/agent_team/motions/manifest.json'
import { AgentSpaceLauncher } from '../src/client/AgentSpaceView'
import { AgentSpaceGate, AgentSpaceGateOverlay, installAgentSpacePresetGate } from '../src/client/agentSpaceGate'
import { CollaborationClient } from '../src/client/collaboration'
import type { AgentSpaceResources } from '../src/client/agentSpaceResources'

vi.mock('thinking-orbs', () => ({ ThinkingOrb: (props: any) => <span data-orb={props.state} /> }))
function observable<T>(value: T) {
  const listeners = new Set<() => void>()
  return { getSnapshot: () => value, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set: (next: T) => { value = next; listeners.forEach((listener) => listener()) } }
}
function resources() {
  const progress = observable({ status: 'ready', percent: 100 }), videos = new Map<string, HTMLVideoElement>()
  return { ...progress, manifest: original, load: vi.fn(async () => {}), url: (file: string) => `blob:${file}`,
    video: (file: string) => {
      if (!videos.has(file)) {
        const video = document.createElement('video')
        Object.defineProperty(video, 'readyState', { get: () => 4 })
        videos.set(file, video)
      }
      return videos.get(file)
    } } as unknown as AgentSpaceResources
}
class Stream {
  static all: Stream[] = []
  onmessage?: (event: { data: string }) => void
  onerror?: () => void
  close = vi.fn()
  constructor() { Stream.all.push(this) }
  send(tasks: any[], revision = 1) { this.onmessage?.({ data: JSON.stringify({ tasks, revision, total: tasks.length, next: null, active: tasks.filter((t) => t.state === 'running').length }) }) }
}
const start = (seq = 1, turn = 1) => ({ type: 'event', event: { type: 'turn/start', seq, time: seq * 100, data: { turn } } })
const end = (seq = 2, turn = 1) => ({ type: 'event', event: { type: 'turn/end', seq, time: seq * 100, data: { turn, reason: { kind: 'completed' } } } })
const child = (id: string, state = 'running', role = 'story') =>
  ({ id, rootId: 'session', childId: id, createdAt: 200, revision: 1, role, state, artifactRefs: [] })
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1)); vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  HTMLDialogElement.prototype.showModal = vi.fn()
  HTMLDialogElement.prototype.close = vi.fn()
  Stream.all = []; vi.stubGlobal('EventSource', Stream)
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren() })
it('sizes only the floating card, shows actual working identities and shrinks on root final completion', async () => {
  const source = observable<any>({ entries: [], change: { kind: 'replace' }, revision: 0 })
  const session = observable<any>({ sessionId: 'session', running: false, pendingSubmissions: [], openState: 'open' })
  const binding = { session, eventSource: source }
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ tasks: [], revision: 0, total: 0, active: 0, next: null })))
  const client = new CollaborationClient({ url: (path) => `/api/${path}` }), bank = resources()
  const content = document.body.appendChild(document.createElement('div')); content.dataset.conversationContent = ''
  const scroll = content.appendChild(document.createElement('div')); scroll.dataset.conversationScroll = ''
  const root = createRoot(scroll)
  try {
    await act(async () => root.render(<AgentSpaceLauncher client={client} sessionId="session" resources={bank} getBinding={() => binding as any} />))
    expect(document.querySelector('.dc-agent-space-card')).toBeNull()
    expect(content.classList.contains('dc-agent-space-layout')).toBe(false)
    await act(async () => source.set({ entries: [start()], change: { kind: 'append' }, revision: 1 }))
    expect(content.firstElementChild?.className).toBe('dc-agent-space-seat')
    const seat = content.firstElementChild as HTMLElement
    expect(seat.dataset.expanded).toBe('true')
    expect(document.querySelector('.dc-agent-space-card')?.getAttribute('data-expanded')).toBe('true')
    expect(document.querySelector('.dc-agent-space-card')?.textContent).toBe('')
    expect(document.querySelector('.dc-collaboration-bubble')).toBeNull()
    await act(async () => Stream.all[0].send([child('one'), child('two'), child('queued', 'dispatched')]))
    await act(async () => (document.querySelector('.dc-agent-space-toggle') as HTMLElement).click())
    expect([...document.querySelectorAll('.dc-agent-space-podium [data-agent-id]')].map((node) => node.getAttribute('data-agent-id'))).toEqual(['session', 'one', 'two'])
    expect(seat.dataset.expanded).toBe('false')
    expect(seat.style.getPropertyValue('--dc-agent-space-podium-width')).toBe('226px')
    await act(async () => Stream.all[0].send([child('one', 'completed'), child('two'), child('queued', 'dispatched')], 2))
    expect(document.querySelectorAll('.dc-agent-space-podium')).toHaveLength(2)
    expect(seat.style.getPropertyValue('--dc-agent-space-podium-width')).toBe('150px')
    await act(async () => Stream.all[0].onerror?.())
    expect(document.querySelectorAll('.dc-agent-space-podium')).toHaveLength(2)
    await act(async () => source.set({ entries: [start(), end()], change: { kind: 'append' }, revision: 2 }))
    expect(document.querySelectorAll('.dc-agent-space-podium')).toHaveLength(1)
    expect(seat.style.getPropertyValue('--dc-agent-space-podium-width')).toBe('74px')
    expect(document.querySelector('.dc-agent-space-podium [data-action]')?.getAttribute('data-action')).toBe('idle-front')
    expect(document.querySelector('[data-agent-id="session"]')?.getAttribute('data-working')).toBe('false')
    await act(async () => source.set({ entries: [start(), end(), start(3, 2)], change: { kind: 'append' }, revision: 3 }))
    expect(document.querySelector('.dc-agent-space-card')?.getAttribute('data-expanded')).toBe('true')
    await act(async () => root.render(<AgentSpaceLauncher client={client} sessionId="other" resources={bank} />))
    expect(document.querySelector('.dc-agent-space-seat')).toBeNull()
    expect(content.classList.contains('dc-agent-space-layout')).toBe(false)
    expect(content.hasAttribute('data-dc-agent-space-expanded')).toBe(false)
    expect(content.style.getPropertyValue('--dc-agent-space-podium-width')).toBe('')
    expect(Stream.all[0].close).toHaveBeenCalled()
  } finally { await act(async () => root.unmount()); client.close() }
})
it('floats over unchanged native conversation layout in expanded and compact states', async () => {
  const source = observable<any>({ entries: [start()], change: { kind: 'replace' }, revision: 1 })
  const session = observable<any>({ sessionId: 'session', running: false, pendingSubmissions: [], openState: 'open' })
  const binding = { session, eventSource: source }, bank = resources()
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ tasks: [], revision: 0, total: 0, active: 0, next: null })))
  const style = document.head.appendChild(document.createElement('style'))
  style.textContent = '[data-conversation-content]{position:relative;display:flex;flex-direction:column}' +
    '[data-conversation-scroll]{flex:1;min-height:0;overflow-y:auto;margin-left:0px}' +
    '[data-width-handle]{width:10px;right:18px}' + readFileSync('src/client/agentSpace.css', 'utf8')
  const content = document.body.appendChild(document.createElement('div')); content.dataset.conversationContent = ''
  content.className = 'native-conversation'
  content.style.setProperty('--dsh-chat-user-width', '800px')
  const scroll = content.appendChild(document.createElement('div')); scroll.dataset.conversationScroll = ''; scroll.scrollTop = 240
  const mount = scroll.appendChild(document.createElement('div'))
  const composer = scroll.appendChild(document.createElement('div')); composer.dataset.composerSeat = ''
  const draft = composer.appendChild(document.createElement('textarea')); draft.value = '原生未发送草稿'
  const handle = content.appendChild(document.createElement('div')); handle.dataset.widthHandle = 'left'
  handle.dataset.side = 'left'
  const originalClass = content.className, originalStyle = content.getAttribute('style')
  const nativeLayout = () => {
    expect(content.className).toBe(originalClass)
    expect(content.getAttribute('style')).toBe(originalStyle)
    expect(content.hasAttribute('data-dc-agent-space-expanded')).toBe(false)
    expect(getComputedStyle(scroll).marginLeft).toBe('0px')
    expect(getComputedStyle(scroll).flex).toBe('1 1 0%')
    expect(getComputedStyle(scroll).minHeight).toBe('0')
    expect(getComputedStyle(handle).right).toBe('18px')
    expect(content.querySelector(':scope > [data-conversation-scroll]')).toBe(scroll)
    expect(scroll.querySelector(':scope > [data-composer-seat]')).toBe(composer)
    expect(scroll.scrollTop).toBe(240)
    expect(draft.value).toBe('原生未发送草稿')
  }
  const client = new CollaborationClient({ url: (path) => `/api/${path}` }), root = createRoot(mount)
  try {
    await act(async () => root.render(<AgentSpaceLauncher client={client} sessionId="session" resources={bank}
      getBinding={() => binding as any} />))
    const seat = content.querySelector('.dc-agent-space-seat')!
    expect(getComputedStyle(seat).position).toBe('absolute')
    expect(getComputedStyle(seat).height).toBe('')
    nativeLayout()
    await act(async () => (content.querySelector('.dc-agent-space-toggle') as HTMLButtonElement).click())
    expect(getComputedStyle(seat).position).toBe('absolute')
    nativeLayout()
    await act(async () => Stream.all[0].send([child('one'), child('two')]))
    nativeLayout()
    await act(async () => source.set({ entries: [start(), end()], change: { kind: 'append' }, revision: 2 }))
    nativeLayout()
    expect(handle.parentElement).toBe(content)
  } finally { await act(async () => root.unmount()); client.close(); style.remove() }
})
it('reserves no space before resources are ready and restores the native scope on preset change or resource failure', async () => {
  const source = observable<any>({ entries: [start(), end()], change: { kind: 'replace' }, revision: 1 })
  const session = observable<any>({ sessionId: 'session', running: false, pendingSubmissions: [], openState: 'open' })
  const preset = observable('canvas-creator'), bank = resources()
  ;(bank as any).set({ status: 'loading', percent: 30 })
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ tasks: [], revision: 0, total: 0, active: 0, next: null })))
  const content = document.body.appendChild(document.createElement('div')); content.dataset.conversationContent = ''
  content.style.setProperty('--dsh-chat-user-width', '800px')
  content.style.setProperty('--dc-agent-space-podium-width', '92px', 'important')
  const priority = content.style.getPropertyPriority('--dc-agent-space-podium-width')
  content.dataset.dcAgentSpaceExpanded = 'original'
  const scroll = content.appendChild(document.createElement('div')); scroll.dataset.conversationScroll = ''
  const client = new CollaborationClient({ url: (path) => `/api/${path}` }), root = createRoot(scroll)
  const projection = (() => useSyncExternalStore(preset.subscribe, preset.getSnapshot)) as any
  const binding = { session, eventSource: source }
  const native = () => {
    expect(content.classList.contains('dc-agent-space-layout')).toBe(false)
    expect(content.dataset.dcAgentSpaceExpanded).toBe('original')
    expect(content.style.getPropertyValue('--dc-agent-space-podium-width')).toBe('92px')
    expect(content.style.getPropertyPriority('--dc-agent-space-podium-width')).toBe(priority)
    expect(content.style.getPropertyValue('--dsh-chat-user-width')).toBe('800px')
  }
  try {
    await act(async () => root.render(<AgentSpaceLauncher client={client} sessionId="session" resources={bank}
      getBinding={() => binding as any} useProjection={projection} />))
    native()
    expect(content.querySelector('.dc-agent-space-seat')).toBeNull()
    await act(async () => (bank as any).set({ status: 'ready', percent: 100 }))
    expect(content.querySelector('.dc-agent-space-podium')).not.toBeNull()
    native()
    await act(async () => preset.set('standard'))
    native()
    await act(async () => preset.set('canvas-creator'))
    expect(content.querySelector('.dc-agent-space-podium')).not.toBeNull()
    native()
    await act(async () => (bank as any).set({ status: 'error', percent: 100 }))
    native()
    await act(async () => (bank as any).set({ status: 'ready', percent: 100 }))
    await act(async () => root.unmount())
    native()
    expect(content.querySelector('.dc-agent-space-seat')).toBeNull()
  } finally { client.close() }
})
it.each(['cancelled', 'error', 'blocked'])('keeps a frontal main idle podium when collapsing a restored %s root', async (kind) => {
  const terminal = end()
  terminal.event.data.reason.kind = kind
  const source = observable<any>({ entries: [start(), terminal], change: { kind: 'replace' }, revision: 1 })
  const session = observable<any>({ sessionId: 'session', running: false, pendingSubmissions: [], openState: 'open' })
  const binding = { session, eventSource: source }, bank = resources()
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ tasks: [child('old-child')], revision: 1, total: 1, active: 1, next: null })))
  const client = new CollaborationClient({ url: (path) => `/api/${path}` })
  const content = document.body.appendChild(document.createElement('div')); content.dataset.conversationContent = ''
  const scroll = content.appendChild(document.createElement('div')); scroll.dataset.conversationScroll = ''
  const root = createRoot(scroll)
  try {
    await act(async () => root.render(<AgentSpaceLauncher client={client} sessionId="session" resources={bank}
      getBinding={() => binding as any} />))
    expect(content.querySelector('.dc-agent-space-card')?.getAttribute('data-expanded')).toBe('true')
    expect(content.querySelector('[data-agent-id="session"]')?.getAttribute('data-action')).toBe('failure')
    await act(async () => (content.querySelector('.dc-agent-space-toggle') as HTMLButtonElement).click())
    expect(content.querySelectorAll('.dc-agent-space-podium')).toHaveLength(1)
    const main = content.querySelector('.dc-agent-space-podium [data-agent-id="session"]')!
    expect(main.getAttribute('data-working')).toBe('false')
    expect(main.getAttribute('data-action')).toBe('idle-front')
    const video = main.querySelector('video')!
    expect(video.loop).toBe(true)
    expect(video.playbackRate).toBe(1)
    expect((content.querySelector('.dc-agent-space-seat') as HTMLElement).style.getPropertyValue('--dc-agent-space-podium-width')).toBe('74px')
    await act(async () => (content.querySelector('.dc-agent-space-toggle') as HTMLButtonElement).click())
    expect(content.querySelector('[data-agent-id="session"]')?.getAttribute('data-action')).toBe('failure')
    expect(source.getSnapshot().entries[1].event.data.reason.kind).toBe(kind)
    expect(bank.load).not.toHaveBeenCalled()
  } finally { await act(async () => root.unmount()); client.close() }
})
it('retains a non-working main podium on an unknown status drop and resumes actual working identities on recovery', async () => {
  const source = observable<any>({ entries: [start()], change: { kind: 'replace' }, revision: 1 })
  const session = observable<any>({ sessionId: 'session', running: true, pendingSubmissions: [], openState: 'open' })
  const binding = { session, eventSource: source }, bank = resources()
  const task = child('one'), response = { tasks: [task], revision: 1, total: 1, active: 1, next: null }
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(response)))
  const client = new CollaborationClient({ url: (path) => `/api/${path}` })
  const content = document.body.appendChild(document.createElement('div')); content.dataset.conversationContent = ''
  const root = createRoot(content.appendChild(document.createElement('div')))
  try {
    await act(async () => root.render(<AgentSpaceLauncher client={client} sessionId="session" resources={bank}
      getBinding={() => binding as any} />))
    await act(async () => (content.querySelector('.dc-agent-space-toggle') as HTMLButtonElement).click())
    expect(content.querySelectorAll('.dc-agent-space-podium')).toHaveLength(2)
    await act(async () => session.set({ ...session.getSnapshot(), running: false }))
    expect(content.querySelectorAll('.dc-agent-space-podium')).toHaveLength(1)
    expect(content.querySelector('[data-agent-id="session"]')?.getAttribute('data-working')).toBe('false')
    expect(content.querySelector('[data-agent-id="session"]')?.getAttribute('data-action')).toBe('idle-front')
    expect((content.querySelector('.dc-agent-space-seat') as HTMLElement).style.getPropertyValue('--dc-agent-space-podium-width')).toBe('74px')
    await act(async () => session.set({ ...session.getSnapshot(), running: true }))
    expect(content.querySelector('.dc-agent-space-card')?.getAttribute('data-expanded')).toBe('false')
    expect([...content.querySelectorAll('.dc-agent-space-podium [data-agent-id]')].map((node) => node.getAttribute('data-agent-id')))
      .toEqual(['session', 'one'])
    expect(content.querySelector('[data-agent-id="session"]')?.getAttribute('data-action')).toBe('work-front')
    expect((content.querySelector('.dc-agent-space-seat') as HTMLElement).style.getPropertyValue('--dc-agent-space-podium-width')).toBe('150px')
    expect(task.state).toBe('running')
    expect(source.getSnapshot().entries).toHaveLength(1)
    expect(bank.load).not.toHaveBeenCalled()
  } finally { await act(async () => root.unmount()); client.close() }
})
it('shows confirmation after native selection, does not load on cancel and restores the previous or default preset', async () => {
  const bank = resources(), gate = new AgentSpaceGate(bank)
  const state = observable<any>({ current: 'standard', options: [{ id: 'standard', isDefault: true }, { id: 'canvas-creator' }] })
  const select = vi.fn(async (id: string) => { state.set({ ...state.getSnapshot(), current: id }); return undefined })
  const Original = (props: any) => <button onClick={() => { void props.select('canvas-creator') }}>选择</button>
  const entry = { component: Original }, off = installAgentSpacePresetGate({ entries: () => [entry], onMutate: () => () => {} } as any, gate)
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const render = () => {
    const Wrapper = entry.component
    root.render(<><Wrapper {...{ sessionId: 'session', select, useAgentPresetSeat: (selector: any) => selector(useSyncExternalStore(state.subscribe, state.getSnapshot)) }} />
      <AgentSpaceGateOverlay gate={gate} /></>)
  }
  try {
    await act(async () => render())
    await act(async () => (document.querySelector('button') as HTMLElement).click())
    expect(state.getSnapshot().current).toBe('canvas-creator')
    expect(document.body.textContent).toContain('当前 Agent 需提前加载资源，请耐心等待')
    expect(bank.load).not.toHaveBeenCalled()
    await act(async () => gate.cancel())
    expect(select.mock.calls.map(([id]) => id)).toEqual(['canvas-creator', 'standard'])
    expect(bank.load).not.toHaveBeenCalled()
    await act(async () => { state.set({ ...state.getSnapshot(), current: '' }); render() })
    await act(async () => (document.querySelector('button') as HTMLElement).click())
    await act(async () => gate.cancel())
    expect(state.getSnapshot().current).toBe('standard')
  } finally { await act(async () => root.unmount()); off(); gate.dispose() }
})
it('keeps the completed main idle loop visible when an older play abort arrives after background recovery', async () => {
  const source = observable<any>({ entries: [start(), end()], change: { kind: 'replace' }, revision: 1 })
  const session = observable<any>({ sessionId: 'session', running: false, pendingSubmissions: [], openState: 'open' })
  const binding = { session, eventSource: source }
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ tasks: [], revision: 0, total: 0, active: 0, next: null })))
  const client = new CollaborationClient({ url: (path) => `/api/${path}` }), bank = resources()
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  let rejectOlder!: (error: Error) => void
  vi.mocked(HTMLMediaElement.prototype.play).mockImplementationOnce(() => new Promise((_, reject) => { rejectOlder = reject }))
  const content = document.body.appendChild(document.createElement('div')); content.dataset.conversationContent = ''
  const root = createRoot(content.appendChild(document.createElement('div')))
  try {
    await act(async () => root.render(<AgentSpaceLauncher client={client} sessionId="session" resources={bank}
      getBinding={() => binding as any} />))
    const video = document.querySelector('.dc-agent-space-podium video') as HTMLVideoElement
    expect(video.loop).toBe(true)
    expect(video.playbackRate).toBe(1)
    expect(video.dataset.ready).toBe('true')
    await act(async () => { hidden.mockReturnValue(true); document.dispatchEvent(new Event('visibilitychange')) })
    expect(document.querySelector('.dc-agent-space-card')?.getAttribute('data-motion-paused')).toBe('true')
    await act(async () => { hidden.mockReturnValue(false); document.dispatchEvent(new Event('visibilitychange')) })
    expect(document.querySelector('.dc-agent-space-card')?.getAttribute('data-motion-paused')).toBe('false')
    await act(async () => rejectOlder(new DOMException('Earlier play was paused', 'AbortError')))
    expect(video.dataset.ready).toBe('true')
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2)
    expect(document.querySelector('.dc-agent-space-podium [data-action]')?.getAttribute('data-action')).toBe('idle-front')
  } finally { await act(async () => root.unmount()); client.close() }
})
it('reuses and starts the main idle loop after expand/collapse without a detached play failure hiding it', async () => {
  const source = observable<any>({ entries: [start(), end()], change: { kind: 'replace' }, revision: 1 })
  const session = observable<any>({ sessionId: 'session', running: false, pendingSubmissions: [], openState: 'open' })
  const binding = { session, eventSource: source }
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ tasks: [], revision: 0, total: 0, active: 0, next: null })))
  const client = new CollaborationClient({ url: (path) => `/api/${path}` }), bank = resources()
  let rejectDetached!: (error: Error) => void
  vi.mocked(HTMLMediaElement.prototype.play).mockImplementationOnce(() => new Promise((_, reject) => { rejectDetached = reject }))
  const content = document.body.appendChild(document.createElement('div')); content.dataset.conversationContent = ''
  const root = createRoot(content.appendChild(document.createElement('div')))
  try {
    await act(async () => root.render(<AgentSpaceLauncher client={client} sessionId="session" resources={bank}
      getBinding={() => binding as any} />))
    const idle = document.querySelector('.dc-agent-space-podium video') as HTMLVideoElement
    await act(async () => (document.querySelector('.dc-agent-space-toggle') as HTMLButtonElement).click())
    await act(async () => (document.querySelector('.dc-agent-space-toggle') as HTMLButtonElement).click())
    expect(document.querySelector('.dc-agent-space-podium video')).toBe(idle)
    await act(async () => rejectDetached(new DOMException('Detached video interrupted playback', 'AbortError')))
    expect(idle.dataset.ready).toBe('true')
    expect(idle.loop).toBe(true)
    expect(idle.playbackRate).toBe(1)
    expect(vi.mocked(HTMLMediaElement.prototype.play).mock.contexts.filter((video) => video === idle)).toHaveLength(2)
  } finally { await act(async () => root.unmount()); client.close() }
})
it('loads only after confirmation, uses Solving and percentage, and rejects cancellation after a chooser generation changes', async () => {
  let finish!: () => void
  const progress = observable({ status: 'loading', percent: 37 })
  const bank = { ...progress, load: vi.fn(() => new Promise<void>((resolve) => { finish = resolve })) } as unknown as AgentSpaceResources
  const gate = new AgentSpaceGate(bank), cancel = vi.fn(async () => undefined)
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  let valid = true
  try {
    await act(async () => root.render(<AgentSpaceGateOverlay gate={gate} />))
    await act(async () => { void gate.ask(cancel, () => valid) })
    expect(bank.load).not.toHaveBeenCalled()
    await act(async () => { void gate.confirm() })
    expect(document.querySelector('[data-orb]')?.getAttribute('data-orb')).toBe('solving')
    expect(document.querySelector('.dc-agent-space-loading')?.textContent).toBe('资源加载中37%')
    expect(document.activeElement).toBe(document.querySelector('.dc-agent-space-loading'))
    await act(async () => { finish(); await Promise.resolve() })
    expect(document.querySelector('.dc-agent-space-loading')).toBeNull()
    await act(async () => { void gate.ask(cancel, () => valid); valid = false })
    await act(async () => gate.cancel())
    expect(cancel).not.toHaveBeenCalled()
  } finally { await act(async () => root.unmount()); gate.dispose() }
})
it('does not start a load when restoring a preset fails, and serializes repeated cancel clicks', async () => {
  const bank = resources(), gate = new AgentSpaceGate(bank)
  let finish!: (error: string | undefined) => void
  const cancel = vi.fn(() => new Promise<string | undefined>((resolve) => { finish = resolve }))
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  try {
    await act(async () => root.render(<AgentSpaceGateOverlay gate={gate} />))
    await act(async () => { void gate.ask(cancel) })
    await act(async () => { void gate.cancel(); void gate.cancel() })
    expect(cancel).toHaveBeenCalledTimes(1)
    await act(async () => finish('offline'))
    expect(document.body.textContent).toContain('无法恢复预设，请重试')
    await act(async () => { window.dispatchEvent(new Event('online')); await gate.confirm() })
    expect(bank.load).not.toHaveBeenCalled()
    await act(async () => { void gate.cancel() })
    await act(async () => finish(undefined))
    expect(gate.getSnapshot()).toBeUndefined()
  } finally { await act(async () => root.unmount()); gate.dispose() }
})
it('restores native selection behavior even when a decorated chooser remains mounted after disposal', async () => {
  const bank = resources(), gate = new AgentSpaceGate(bank)
  const select = vi.fn(async () => undefined)
  const Original = (props: any) => <button onClick={() => { void props.select('canvas-creator') }}>选择</button>
  const entry = { component: Original }
  const off = installAgentSpacePresetGate({ entries: () => [entry], onMutate: () => () => {} } as any, gate)
  const Wrapper = entry.component, root = createRoot(document.body.appendChild(document.createElement('div')))
  try {
    await act(async () => root.render(<Wrapper {...{ select, useAgentPresetSeat: (selector: any) => selector({ current: 'standard', options: [] }) }} />))
    await act(async () => off())
    await act(async () => (document.querySelector('button') as HTMLElement).click())
    expect(select).toHaveBeenCalledTimes(1)
    expect(gate.getSnapshot()).toBeUndefined()
    expect(bank.load).not.toHaveBeenCalled()
  } finally { await act(async () => root.unmount()); gate.dispose() }
})
