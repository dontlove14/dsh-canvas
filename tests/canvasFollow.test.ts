// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { webcrypto } from 'node:crypto'
import * as Cordis from '@deepseek-ai/cordis'
import * as Store from '@deepseek-ai/dsh-client-store'
import { afterEach, expect, it, vi } from 'vitest'
import { CanvasPresentationClient, installCanvasPresentation } from '../src/client/presentation'
import { installCanvasFollowGestures } from '../src/client/canvasFollowGestures'
import type { PresentationIntent } from '../src/shared/presentation'
import { GENERATION_HANDOFF_REASON } from '../src/shared/agent'

afterEach(() => { sessionStorage.clear(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const intent = (fields = {}): PresentationIntent => ({ id: 'one', sessionId: 'session', canvasId: 'canvas', epoch: 1,
  action: 'create', graphRevision: 1, nodeIds: ['node'], createdAt: 1, ...fields })
const snapshot = (fields = {}): any => ({ sessionId: 'session', running: false, pendingSubmissions: [], removed: false, openState: 'open', promptError: null, ...fields })

/** Execute the published native Session unchanged; expose its class only for tests. */
function nativeSession() {
  const peers: Record<string, unknown> = {
    '@deepseek-ai/cordis': Cordis, '@deepseek-ai/dsh-client-store': Store,
    '@deepseek-ai/dsh-api-gateway/client': { RemoteJournalStream: class {}, RemoteSnapshotStream: class {} },
  }
  const source = readFileSync(resolve('node_modules/@deepseek-ai/dsh-api-session-controller/lib/client.js'), 'utf8')
    .replace('exports.SessionEventStream = SessionEventStream;', 'exports.Session = Session; exports.SessionEventStream = SessionEventStream;')
  let sdk: any
  new Function('window', source)({ __ModuleLoader__: { load: ({ factory }: any) => {
    sdk = factory((name: string) => { if (!(name in peers)) throw new Error(`Unexpected session peer ${name}`); return peers[name] })
  } } })
  return new sdk.Session('session', { session: { prompt: async () => ({ ok: true, value: { accepted: true } }) } })
}

it('observes real native submissions and reply completion through the installed public session face, without replaying the baseline', async () => {
  vi.stubGlobal('crypto', webcrypto)
  const session = nativeSession()
  session.beginSubmission({ mode: 'queue', text: '已有提交', attachments: [] })
  const client = new CanvasPresentationClient(), open = vi.fn()
  const api = { presence: vi.fn(async () => {}), presentation: vi.fn(async () => ({ intent: intent(), running: true })) }
  const dispose = installCanvasPresentation(api as any, client, {
    session: () => 'session', subscribe: () => () => {}, open, conversation: () => session,
  })
  try {
    await vi.waitFor(() => expect(client.getSnapshot()?.id).toBe('one'))
    expect(client.following()).toBe(false)
    expect(open).not.toHaveBeenCalled()
    session.beginSubmission({ mode: 'queue', text: '修改这张图', attachments: [] })
    await vi.waitFor(() => expect(client.following()).toBe(true))
    session.handleRunning(true)
    await vi.waitFor(() => expect(client.getRunningSnapshot()).toBe(true))
    const shown = client.getSnapshot(), notify = vi.fn(), unsubscribe = client.subscribe(notify)
    const state = session.getSnapshot()
    for (let frame = 0; frame < 50; frame++) expect(client.observeConversation({ ...state, lastAgentError: `text-${frame}` } as any)).toBe(false)
    expect(client.getSnapshot()).toBe(shown)
    expect(notify).not.toHaveBeenCalled()
    unsubscribe()
    client.activity()
    expect(client.following()).toBe(false)
    session.beginSubmission({ mode: 'steer', text: '再调整一下', attachments: [] })
    await vi.waitFor(() => expect(client.following()).toBe(true))
    session.handleRunning(false)
    await vi.waitFor(() => expect(client.following()).toBe(false))
    client.receive({ intent: intent({ id: 'late', createdAt: 2 }), running: true })
    expect(client.following()).toBe(false)
    expect(client.getRunningSnapshot()).toBe(false)
  } finally { dispose(); await session.dispose() }
  session.handleRunning(true)
  expect(client.getSnapshot()).toBeNull()
})

it('resumes only the latest operation after more than ten seconds of inactivity', async () => {
  vi.useFakeTimers()
  const client = new CanvasPresentationClient()
  client.receive({ intent: intent(), running: true }); client.activity()
  client.receive({ intent: intent({ id: 'latest', nodeIds: ['new'], createdAt: 2 }), running: true })
  await vi.advanceTimersByTimeAsync(10_000)
  expect(client.following()).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  expect(client.following()).toBe(true)
  expect(client.getSnapshot()?.nodeIds).toEqual(['new'])
  client.clear()
})

it('holds manual view throughout long drags and keys, then starts the full idle interval after the last release', async () => {
  vi.useFakeTimers()
  const client = new CanvasPresentationClient()
  client.receive({ intent: intent(), running: true })
  client.activity('pointer:1'); client.activity('key:Space')
  await vi.advanceTimersByTimeAsync(30_000)
  expect(client.following()).toBe(false)
  client.activity('pointer:1', true)
  await vi.advanceTimersByTimeAsync(15_000)
  expect(client.following()).toBe(false)
  client.activity('key:Space', true)
  await vi.advanceTimersByTimeAsync(10_001)
  expect(client.following()).toBe(true)
  client.clear()
})

it('extends the idle deadline on scrolling or input without notifying React on every gesture event', async () => {
  vi.useFakeTimers()
  const client = new CanvasPresentationClient(), changed = vi.fn()
  client.receive({ intent: intent(), running: true }); client.subscribe(changed)
  client.activity()
  await vi.advanceTimersByTimeAsync(9_000); client.activity()
  await vi.advanceTimersByTimeAsync(9_000); client.activity()
  expect(changed).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(10_000)
  expect(client.following()).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  expect(client.following()).toBe(true)
  client.clear()
})

it('cancels idle recovery on completion, a cleared intent or a new epoch, and never follows an idle reply', async () => {
  vi.useFakeTimers()
  for (const stop of ['complete', 'clear', 'epoch', 'dispose', 'leave']) {
    const client = new CanvasPresentationClient()
    client.receive({ intent: intent(), running: true }); client.activity()
    if (stop === 'complete') client.receive({ intent: intent(), running: false })
    if (stop === 'clear') client.receive({ intent: null })
    if (stop === 'epoch') client.receive({ intent: intent({ id: 'next', epoch: 2, createdAt: 2 }), running: false })
    if (stop === 'dispose') client.clear()
    if (stop === 'leave') { client.pause(); client.receive({ intent: intent({ id: 'later', createdAt: 2 }), running: true }) }
    await vi.advanceTimersByTimeAsync(20_000)
    expect(client.following()).toBe(false)
    client.clear()
  }
})

it('bounds pre-running admission and clears failed sends instead of keeping an idle watermark forever', async () => {
  vi.useFakeTimers()
  const client = new CanvasPresentationClient()
  client.observeConversation(snapshot(), true)
  client.observeConversation(snapshot({ pendingSubmissions: [{ requestId: 'first' }] }))
  client.receive({ intent: intent(), running: false })
  expect(client.following()).toBe(true)
  client.observeConversation(snapshot({ promptError: { op: 'send', error: new Error('failed') } }))
  expect(client.following()).toBe(false)
  client.observeConversation(snapshot({ pendingSubmissions: [{ requestId: 'second' }] }))
  expect(client.following()).toBe(true)
  await vi.advanceTimersByTimeAsync(15_000)
  expect(client.following()).toBe(false)
  client.clear()
})

it('tracks trusted pointer, keyboard, wheel and input activity including releases outside the canvas, and cleans all listeners', async () => {
  vi.useFakeTimers()
  const client = new CanvasPresentationClient(), root = document.createElement('div')
  const rootEvents = new Map<string, any>(), windowEvents = new Map<string, any>()
  const nativeRootAdd = root.addEventListener.bind(root), nativeWindowAdd = window.addEventListener.bind(window)
  vi.spyOn(root, 'addEventListener').mockImplementation((type, listener, options) => { rootEvents.set(type, listener); nativeRootAdd(type, listener, options) })
  vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => { windowEvents.set(type, listener); nativeWindowAdd(type, listener, options) })
  const removed = vi.spyOn(window, 'removeEventListener')
  client.receive({ intent: intent(), running: true })
  const gestures = installCanvasFollowGestures(root, client)
  rootEvents.get('wheel')({ isTrusted: false })
  expect(client.following()).toBe(true)
  rootEvents.get('pointerdown')({ isTrusted: true, pointerId: 1 })
  await vi.advanceTimersByTimeAsync(20_000)
  expect(client.following()).toBe(false)
  windowEvents.get('pointerup')({ isTrusted: true, pointerId: 1 })
  await vi.advanceTimersByTimeAsync(9_000)
  rootEvents.get('keydown')({ isTrusted: true, code: 'Space' })
  await vi.advanceTimersByTimeAsync(20_000)
  expect(client.following()).toBe(false)
  windowEvents.get('keyup')({ isTrusted: true, code: 'Space' })
  await vi.advanceTimersByTimeAsync(9_000)
  rootEvents.get('wheel')({ isTrusted: true })
  await vi.advanceTimersByTimeAsync(9_000)
  rootEvents.get('input')({ isTrusted: true })
  await vi.advanceTimersByTimeAsync(10_001)
  expect(client.following()).toBe(true)
  gestures.pointerDown({ isTrusted: true, pointerId: 2 } as PointerEvent)
  await vi.advanceTimersByTimeAsync(20_000)
  expect(client.following()).toBe(false)
  windowEvents.get('pointerup')({ isTrusted: true, pointerId: 2 })
  await vi.advanceTimersByTimeAsync(10_001)
  expect(client.following()).toBe(true)
  client.activity(); gestures.dispose()
  await vi.advanceTimersByTimeAsync(20_000)
  expect(client.following()).toBe(false)
  expect(removed).toHaveBeenCalledWith('pointerup', windowEvents.get('pointerup'), true)
  client.clear()
})

it('keeps the manual ownership idle clock without a presentation intent and restores only after saving', async () => {
  vi.useFakeTimers()
  const client = new CanvasPresentationClient(), resume = vi.fn(async (valid: () => boolean) => { expect(valid()).toBe(true) }), report = vi.fn()
  client.observeConversation(snapshot(), true)
  const remove = client.manualSeatFor('view', {
    control: { canvasId: 'canvas', sessionId: 'session', mode: 'manual', epoch: 4, updatedAt: 1 },
    active: true, resume, report,
  })
  client.activity('pointer:1')
  client.receive({ intent: null })
  await vi.advanceTimersByTimeAsync(20_000)
  expect(resume).not.toHaveBeenCalled()
  client.activity('pointer:1', true)
  await vi.advanceTimersByTimeAsync(10_000)
  expect(resume).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(resume).toHaveBeenCalledTimes(1)
  expect(client.following()).toBe(false) // no active reply: no watermark
  expect(report).not.toHaveBeenCalled()
  remove(); client.clear()
})

it('flushes and renews manual ownership before native message admission and preserves native arguments and receiver', async () => {
  const client = new CanvasPresentationClient(), order: string[] = []
  const original = vi.fn(async function (this: any, ..._args: any[]) {
    expect(this).toBe(face); order.push('prompt'); return { ok: true, value: { accepted: true } }
  })
  const face: any = { getSnapshot: () => snapshot(), subscribe: () => () => {}, prompt: original }
  const dispose = installCanvasPresentation({ presence: async () => {}, presentation: async () => ({ intent: null }) } as any, client, {
    session: () => 'session', subscribe: () => () => {}, open: () => {}, conversation: () => face,
  })
  client.seat('view', { sessionId: 'session', canvasId: 'canvas', loaded: true, visible: true, prepare: async () => { order.push('flush') } })
  client.manualSeatFor('view', { control: { canvasId: 'canvas', sessionId: 'session', mode: 'manual', epoch: 3, updatedAt: 1 },
    active: true, resume: async (valid) => { expect(valid()).toBe(true); order.push('delegate') }, report: vi.fn() })
  const signal = new AbortController().signal, parts = [{ type: 'text', text: '继续修改' }]
  await face.prompt(parts, 'steer', signal, 'request-one')
  expect(order).toEqual(['flush', 'delegate', 'prompt'])
  expect(original).toHaveBeenCalledWith(parts, 'steer', signal, 'request-one')
  dispose()
  expect(face.prompt).toBe(original)
})

it('does not admit a message or overwrite manual drafts when saving fails', async () => {
  vi.stubGlobal('crypto', webcrypto)
  const client = new CanvasPresentationClient(), face = nativeSession()
  const original = vi.spyOn(face, 'prompt'), originalBegin = face.beginSubmission, retired = vi.fn()
  const dispose = installCanvasPresentation({ presence: async () => {}, presentation: async () => ({ intent: null }) } as any, client, {
    session: () => 'session', subscribe: () => () => {}, open: () => {}, conversation: () => face,
  })
  client.seat('view', { sessionId: 'session', visible: true, loaded: true, prepare: async () => { throw new Error('保存冲突') } })
  const handle = face.beginSubmission({ mode: 'queue', text: '保留草稿', attachments: [], onRetire: retired })
  expect(face.getSnapshot().pendingSubmissions).toHaveLength(1)
  await expect(face.prompt([], 'queue', undefined, handle.requestId)).rejects.toThrow('保存冲突')
  expect(original).not.toHaveBeenCalled()
  expect(face.getSnapshot().pendingSubmissions).toHaveLength(0)
  expect(retired).toHaveBeenCalledWith({ reason: 'failed' })
  dispose()
  expect(face.beginSubmission).toBe(originalBegin)
  await face.dispose()
})

it('invalidates a delayed manual restore if new user input arrives or the canvas leaves during its save (seed 98)', async () => {
  vi.useFakeTimers()
  let seed = 98
  for (let round = 0; round < 32; round++) {
    seed = (seed * 1664525 + 1013904223) >>> 0
    const client = new CanvasPresentationClient(), commits = vi.fn(), report = vi.fn()
    let release!: () => void
    const wait = new Promise<void>((resolve) => { release = resolve })
    client.observeConversation(snapshot(), true)
    const remove = client.manualSeatFor('view', { control: { canvasId: 'canvas', sessionId: 'session', mode: 'manual', epoch: 5, updatedAt: 1 },
      active: true, resume: async (valid) => { await wait; if (valid()) commits() }, report })
    await vi.advanceTimersByTimeAsync(10_001)
    if (seed % 2) client.activity('key:Space')
    else remove()
    release(); await Promise.resolve(); await Promise.resolve()
    expect(commits).not.toHaveBeenCalled(); expect(report).not.toHaveBeenCalled()
    remove(); client.clear()
  }
})

it('keeps a generation handoff manual through completion, late intents, interactions and idle, then resumes only for a fresh message (seed 100)', async () => {
  vi.useFakeTimers()
  let seed = 100
  for (let round = 0; round < 32; round++) {
    seed = (seed * 1664525 + 1013904223) >>> 0
    const client = new CanvasPresentationClient(), resume = vi.fn(async () => {}), report = vi.fn()
    client.observeConversation(snapshot({ running: true }), true)
    client.receive({ intent: intent(), running: true })
    const remove = client.manualSeatFor('view', { active: true, control: { canvasId: 'canvas', sessionId: 'session',
      mode: 'manual', epoch: 2, updatedAt: 1, reason: GENERATION_HANDOFF_REASON }, resume, report })
    client.receive({ intent: null })
    if (seed & 1) client.activity('pointer:1')
    if (seed & 2) client.observeConversation(snapshot({ running: false }))
    await vi.advanceTimersByTimeAsync(20_000)
    client.activity('pointer:1', true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(resume).not.toHaveBeenCalled()
    expect(client.following()).toBe(false)
    await client.prepareMessage('session')
    expect(resume).toHaveBeenCalledOnce()
    expect(resume).toHaveBeenCalledWith(expect.any(Function), 'user-message')
    expect(report).not.toHaveBeenCalled()
    remove(); client.clear()
  }
})
