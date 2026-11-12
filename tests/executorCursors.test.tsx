// @vitest-environment jsdom
import { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { ExecutorCursors } from '../src/client/executorCursors'
import { AgentCursorLayer } from '../src/client/AgentCursorLayer'
import { CanvasPresentationClient } from '../src/client/presentation'
import type { CursorActivity } from '../src/shared/presentation'

vi.mock('@xyflow/react', () => ({ ViewportPortal: ({ children }: any) => children, useViewport: () => ({ zoom: .5 }) }))
const event = (childId: string, sequence: number, extra: Partial<CursorActivity> = {}): CursorActivity => ({
  sessionId: 'root', canvasId: 'canvas', epoch: 1, childId, taskId: randomUUID(), role: 'executor',
  operationId: randomUUID(), sequence, action: 'update', phase: 'started', point: { x: 300, y: 200 },
  nodeIds: ['node'], graphRevision: 1, text: true, ...extra,
})
const state = (sequence: number, active: CursorActivity[], events: CursorActivity[] = []) => ({ streamId: 'host', floor: 1, sequence, active, events })
let root: Root | undefined
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
describe('executor cursor projection', () => {
  it('preserves multiple identities, consumes each motion once, removes only the ended child and rejects late or non-executor events', () => {
    const cursors = new ExecutorCursors(); cursors.receive(state(0, []), true)
    const A = event('A', 1), B = event('B', 2)
    cursors.receive(state(2, [A, B], [A, B]))
    expect(cursors.getSnapshot().map((cursor) => cursor.number)).toEqual([1, 2])
    expect(cursors.consume('A', 1)).toBe(true); expect(cursors.consume('A', 1)).toBe(false)
    const baseline = cursors.getSnapshot()
    cursors.receive(state(1, [A], [A])); expect(cursors.getSnapshot()).toBe(baseline)
    cursors.receive(state(3, [B], [{ ...A, sequence: 3, phase: 'ended' }]))
    expect(cursors.getSnapshot().map((cursor) => cursor.activity.childId)).toEqual(['B'])
    cursors.receive(state(4, [A, B, { ...A, childId: 'voice', role: 'voice' } as any]))
    expect(cursors.getSnapshot().map((cursor) => cursor.activity.childId)).toEqual(['B'])
  })
  it('uses static current facts after reconnect or buffer overflow without replaying clicks', () => {
    const cursors = new ExecutorCursors(), A = event('A', 1)
    cursors.receive(state(1, [A], [A]), true)
    expect(cursors.getSnapshot()[0].motion).toBeUndefined()
    const B = event('B', 10)
    cursors.receive({ ...state(10, [B], [B]), floor: 8 })
    expect(cursors.getSnapshot()[0].motion).toBeUndefined()
    cursors.receive(undefined); expect(cursors.getSnapshot()).toEqual([])
  })
  it('renders only the active canvas and epoch, keeps screen size, and cancels hidden animation without measuring or dispatching input', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const media = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }
    vi.stubGlobal('matchMedia', () => media)
    const cancel = vi.fn(), animate = vi.fn(() => ({ cancel }))
    Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate })
    const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    const clicked = vi.fn(), client = new CanvasPresentationClient()
    client.cursors.receive(state(0, []), true)
    function Probe() {
      const container = useRef<HTMLDivElement>(null)
      return <div ref={container} onClick={clicked}><AgentCursorLayer presentation={client} sessionId="root" workspace="canvas" active
        control={{ canvasId: 'canvas', sessionId: 'root', epoch: 1, mode: 'agent', updatedAt: 1 }} container={container} /></div>
    }
    const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
    await act(async () => root!.render(<Probe />))
    const A = event('A', 1)
    act(() => client.cursors.receive(state(1, [A, event('other', 1, { canvasId: 'elsewhere' }), event('old', 1, { epoch: 0 })], [A])))
    expect(container.querySelectorAll('[data-dc-executor-cursor]')).toHaveLength(1)
    expect(container.querySelector('.dc-executor-cursor-size')?.getAttribute('style')).toContain('scale(2)')
    expect(container.querySelector('.dc-executor-cursor-glyph svg')?.getAttribute('width')).toBe('13')
    expect(container.querySelector('.dc-executor-cursor-glyph svg')?.getAttribute('height')).toBe('15')
    expect(container.querySelector('.dc-executor-cursor-glyph svg')?.getAttribute('viewBox')).toBe('0 0 1024 1024')
    expect(container.querySelector('.dc-executor-cursor-glyph path')?.getAttribute('d')).toContain('M143.832313 5.834982H143.686438')
    expect(animate).toHaveBeenCalledTimes(2)
    expect(measure).not.toHaveBeenCalled(); expect(clicked).not.toHaveBeenCalled()
    const before = animate.mock.calls.length
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(cancel).toHaveBeenCalledTimes(2)
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(animate).toHaveBeenCalledTimes(before)
    act(() => client.cursors.receive(state(2, [], [{ ...A, sequence: 2, phase: 'ended' }])))
    expect(container.querySelector('[data-dc-executor-cursor]')).toBeNull()
    expect(clicked).not.toHaveBeenCalled()
  })
})
