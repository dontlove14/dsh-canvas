// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CanvasPresentationClient, installCanvasPresentation } from '../src/client/presentation'
import type { PresentationIntent } from '../src/shared/presentation'

afterEach(() => { sessionStorage.clear(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const intent = (id = 'one', fields = {}): PresentationIntent => ({ id, sessionId: 'session', canvasId: 'canvas', epoch: 1,
  action: 'create', graphRevision: 1, nodeIds: ['node'], createdAt: id === 'one' ? 1 : 2, ...fields })
describe('Independent canvas window coordinator', () => {
  it('retries a silently ignored open and confirms only an actually loaded target seat', async () => {
    const client = new CanvasPresentationClient(), open = vi.fn()
    client.receive({ intent: intent() })
    await client.navigate('session', open, 1000); await client.navigate('session', open, 1900)
    expect(open).toHaveBeenCalledTimes(2)
    const dispose = client.seat('view', { sessionId: 'session', canvasId: 'canvas', visible: true, loaded: true, prepare: async () => {} })
    await client.navigate('session', open, 2800)
    expect(open).toHaveBeenCalledTimes(2)
    dispose()
    await client.navigate('session', open, 3700)
    expect(client.following()).toBe(false)
    client.resume(); await client.navigate('session', open, 4600)
    expect(open).toHaveBeenCalledTimes(3)
  })
  it('protects unsaved drafts and drops navigation after session switch, takeover or disposal during a flush', async () => {
    for (const cancel of ['switch', 'takeover', 'dispose', 'hidden']) {
      const client = new CanvasPresentationClient(), open = vi.fn(), navigate = vi.fn()
      let finish!: () => void
      client.receive({ intent: intent() })
      client.seat('view', { sessionId: 'session', canvasId: 'old', visible: true, loaded: true, navigate,
        prepare: () => new Promise<void>((resolve) => { finish = resolve }) })
      let current = true
      const pending = client.navigate('session', open, 1000, () => current)
      if (cancel === 'dispose') client.clear()
      else if (cancel === 'hidden') current = false
      else client.receive({ intent: null })
      finish(); await pending
      expect(open).not.toHaveBeenCalled(); expect(navigate).not.toHaveBeenCalled()
    }
  })
  it('does not replay stale events, remembers paused follow state on refresh and resumes only latest input', async () => {
    const client = new CanvasPresentationClient(), open = vi.fn()
    client.receive({ intent: intent() }); client.pause(); client.receive({ intent: intent('two') })
    client.receive({ intent: intent() })
    expect(client.getSnapshot()?.id).toBe('two')
    const refreshed = new CanvasPresentationClient(); refreshed.receive({ intent: intent('two') })
    await refreshed.navigate('session', open, 1000)
    expect(open).not.toHaveBeenCalled()
    refreshed.resume(); await refreshed.navigate('session', open, 2000)
    expect(open).toHaveBeenCalledWith('canvas')
  })
  it('operates without any model picker or mounted canvas and suppresses wrong-session API completions', async () => {
    vi.useFakeTimers()
    const client = new CanvasPresentationClient(), open = vi.fn(), listeners = new Set<() => void>()
    let current: string | undefined = 'session', finish!: (value: any) => void
    const api = { presence: vi.fn(async () => {}), presentation: vi.fn(() => new Promise((resolve) => { finish = resolve })) }
    const dispose = installCanvasPresentation(api as any, client, { session: () => current,
      subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } }, open })
    expect(api.presentation).toHaveBeenCalledWith('session')
    current = 'other'; for (const listener of listeners) listener()
    finish({ intent: intent() }); await Promise.resolve(); await vi.advanceTimersByTimeAsync(1000)
    expect(open).not.toHaveBeenCalled(); expect(client.getSnapshot()).toBeNull()
    dispose(); expect(listeners.size).toBe(0)
  })
  it('keeps automatic focus paused across reordered creation/navigation schedules (seed 89)', async () => {
    let seed = 89
    const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32 }
    for (let round = 0; round < 64; round++) {
      sessionStorage.clear()
      const client = new CanvasPresentationClient(), open = vi.fn()
      client.receive({ intent: intent() }); client.pause()
      for (let step = 0; step < 12; step++) {
        if (random() < .5) client.receive({ intent: intent(`step-${step}`, { createdAt: step + 3 }) })
        else await client.navigate(random() < .5 ? 'other' : 'session', open, step * 1000 + 1000)
      }
      expect(open).not.toHaveBeenCalled()
    }
  })
})
