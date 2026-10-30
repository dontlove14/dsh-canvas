// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NotificationCapsules, type CanvasNotification } from '../src/client/NotificationCapsules'
import { NodeLoadingContext } from '../src/client/NodeLoading'
import { useCanvas } from '../src/client/useCanvas'
import { CanvasApi } from '../src/client/api'
import { emptyGraph } from '../src/shared/contracts'
import type { CanvasSnapshot } from '../src/shared/v2'

const roots: Root[] = []
const motions: Array<{ id: string; frames: Keyframe[]; cancel: ReturnType<typeof vi.fn> }> = []
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('matchMedia', (query: string) => Object.assign(new EventTarget(), { matches: false, media: query }))
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    const siblings = [...this.parentElement?.querySelectorAll('[data-capsule-motion-id]') ?? []]
    return { left: 100 + siblings.indexOf(this) * 120, top: 20 } as DOMRect
  })
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: function (frames: Keyframe[]) {
    const cancel = vi.fn()
    motions.push({ id: this.dataset.capsuleMotionId!, frames, cancel })
    return { cancel, finished: new Promise(() => {}) }
  } })
})
afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()))
  document.body.replaceChildren(); motions.length = 0
  delete (HTMLElement.prototype as any).animate
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers()
})
const notice = (id: string): CanvasNotification => ({ id, message: `通知 ${id}` })
const tick = (ms: number) => act(() => vi.advanceTimersByTime(ms))
function mount(initial: CanvasNotification[] = []) {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host); roots.push(root)
  let update!: (items: CanvasNotification[]) => void
  const dismiss = vi.fn()
  function View({ active, paused, theme }: { active: boolean; paused: boolean; theme: 'light' | 'dark' }) {
    const [items, setItems] = useState(initial); update = setItems
    return <NodeLoadingContext.Provider value={{ theme, ink: '#eee', paused }}>
      <NotificationCapsules notifications={items} active={active} onDismiss={(id) => {
        dismiss(id); setItems((current) => current.filter((item) => item.id !== id))
      }} />
    </NodeLoadingContext.Provider>
  }
  const render = (active = true, paused = false, theme: 'light' | 'dark' = 'dark') =>
    act(() => root.render(<View active={active} paused={paused} theme={theme} />))
  render()
  return { host, root, dismiss, render, update: (items: CanvasNotification[]) => act(() => update(items)) }
}
const messages = (host: HTMLElement) => [...host.querySelectorAll('.dc-notification-message')].map((item) => item.textContent)

describe('canvas capsule notifications', () => {
  it('renders successful copy as a status check and legacy failures as an alert, with shared expiry', () => {
    const { host, dismiss } = mount([{ id: 'copied', message: '已复制 11 个节点', tone: 'success' }, notice('failure')])
    const success = host.querySelector('[role="status"]')!, error = host.querySelector('[role="alert"]')!
    expect(success.getAttribute('data-tone')).toBe('success')
    expect(success.textContent).toContain('已复制 11 个节点')
    expect(success.querySelector('.dc-notification-icon path')?.getAttribute('d')).toBe('m7.5 12 3 3 6-6')
    expect(success.querySelectorAll('.dc-notification-icon circle')).toHaveLength(1)
    expect(error.getAttribute('data-tone')).toBe('error')
    expect(error.querySelectorAll('.dc-notification-icon circle')).toHaveLength(2)
    tick(5000)
    expect(dismiss).toHaveBeenCalledTimes(2)
    expect(messages(host)).toEqual([])
  })
  it('gives appended messages independent five-second lifetimes and slides remaining messages forward', () => {
    const { host, update, dismiss } = mount([notice('one')])
    tick(2000); update([notice('one'), notice('two')])
    expect(motions.at(-1)?.frames[0].transform).toBe('translate(44px, 0px) scale(0.96)')
    motions.length = 0
    tick(2999)
    expect(messages(host)).toEqual(['通知 one', '通知 two'])
    tick(1)
    expect(messages(host)).toEqual(['通知 two'])
    expect(dismiss).toHaveBeenCalledExactlyOnceWith('one')
    expect(motions[0].frames[0].transform).toBe('translate(120px, 0px) scale(1)')
    tick(1999); expect(messages(host)).toEqual(['通知 two'])
    tick(1); expect(host.childElementCount).toBe(0)
  })
  it('bounds a hundred messages to five real beams and starts queued timers only after promotion', () => {
    const items = Array.from({ length: 100 }, (_, index) => notice(String(index)))
    const { host, dismiss } = mount(items)
    expect(host.querySelectorAll('[role="alert"]')).toHaveLength(5)
    expect(host.querySelectorAll('[data-beam]')).toHaveLength(5)
    expect(host.querySelector('.dc-capsule-more')?.textContent).toBe('+95')
    tick(4999); expect(dismiss).not.toHaveBeenCalled()
    tick(1); expect(dismiss).toHaveBeenCalledTimes(5)
    expect(messages(host)).toEqual(['通知 5', '通知 6', '通知 7', '通知 8', '通知 9'])
    expect(host.querySelector('.dc-capsule-more')?.textContent).toBe('+90')
    tick(4999); expect(dismiss).toHaveBeenCalledTimes(5)
    tick(1); expect(dismiss).toHaveBeenCalledTimes(10)
  })
  it('closes only the chosen message and gives the promoted message its full remaining lifetime', () => {
    const { host, dismiss } = mount(Array.from({ length: 6 }, (_, index) => notice(String(index))))
    tick(2000)
    act(() => (host.querySelector('[data-capsule-motion-id="0"] button') as HTMLButtonElement).click())
    expect(dismiss).toHaveBeenCalledExactlyOnceWith('0')
    expect(messages(host)).toEqual(['通知 1', '通知 2', '通知 3', '通知 4', '通知 5'])
    tick(3000); expect(messages(host)).toEqual(['通知 5'])
    tick(1999); expect(messages(host)).toEqual(['通知 5'])
    tick(1); expect(host.childElementCount).toBe(0)
  })
  it('holds hover and focus independently, then resumes the remaining time', () => {
    const { host, dismiss } = mount([notice('one')])
    const pill = host.querySelector('[role="alert"]')!, close = pill.querySelector('button')!
    tick(2000)
    act(() => pill.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    tick(6000); expect(dismiss).not.toHaveBeenCalled()
    act(() => close.focus())
    act(() => pill.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })))
    tick(6000); expect(dismiss).not.toHaveBeenCalled()
    act(() => close.blur())
    tick(2999); expect(dismiss).not.toHaveBeenCalled()
    tick(1); expect(dismiss).toHaveBeenCalledExactlyOnceWith('one')
  })
  it('freezes hidden workspaces but still auto-dismisses with reduced motion and preserves theme Beam', () => {
    const { host, render, dismiss } = mount([notice('one')])
    tick(2000); render(false, true)
    tick(20000); expect(dismiss).not.toHaveBeenCalled()
    const beam = host.querySelector('[data-beam]')!
    expect(beam.hasAttribute('data-capsule-paused')).toBe(true)
    render(true, true, 'light')
    expect(host.querySelector('[data-beam]')).toBe(beam)
    expect(beam.getAttribute('data-capsule-theme')).toBe('light')
    expect(host.querySelector('style')?.textContent).toContain('rgb(40, 140, 255)')
    expect(host.querySelector('style')?.textContent).toContain('--beam-bloom-opacity: .85')
    tick(2999); expect(dismiss).not.toHaveBeenCalled()
    tick(1); expect(dismiss).toHaveBeenCalledExactlyOnceWith('one')
  })
  it('cleans timers and animations on unmount without dismiss callbacks', () => {
    const { root, dismiss } = mount([notice('one'), notice('two')])
    const animations = motions.slice()
    act(() => root.unmount()); roots.splice(roots.indexOf(root), 1)
    tick(20000)
    expect(dismiss).not.toHaveBeenCalled()
    expect(animations.every((item) => item.cancel.mock.calls.length > 0)).toBe(true)
  })
  it('queues distinct useCanvas reports, deduplicates repeated errors, and clears notices on reload', async () => {
    const snapshot: CanvasSnapshot = { version: 1, workspaceId: 'w', graphRevision: 1, graph: emptyGraph(), assets: [], tasks: [],
      updatedAt: 1, commitHash: 'a'.repeat(64), hashes: { nodes: {}, edges: {}, viewport: '' } }
    const api = new CanvasApi()
    vi.spyOn(api, 'state').mockResolvedValue(snapshot)
    let canvas!: ReturnType<typeof useCanvas>
    function View() {
      canvas = useCanvas(api, 'w')
      return <NotificationCapsules notifications={canvas.notifications} onDismiss={canvas.dismissNotification} />
    }
    const host = document.createElement('div'); document.body.append(host)
    const root = createRoot(host); roots.push(root)
    await act(async () => root.render(<View />))
    act(() => { canvas.report(new Error('图片过多')); canvas.report('上传失败'); canvas.report(new Error('图片过多')) })
    expect(messages(host)).toEqual(['图片过多', '上传失败'])
    expect(canvas.error).toBe('上传失败')
    act(() => { canvas.notifySuccess('已复制 11 个节点'); canvas.notifySuccess('已复制 11 个节点') })
    expect(messages(host)).toEqual(['图片过多', '上传失败', '已复制 11 个节点'])
    expect(canvas.error).toBe('上传失败')
    expect(host.querySelectorAll('[role="status"]')).toHaveLength(1)
    // Equal text from separate outcomes must not hide an actual error.
    act(() => canvas.report('已复制 11 个节点'))
    expect(messages(host)).toEqual(['图片过多', '上传失败', '已复制 11 个节点', '已复制 11 个节点'])
    expect(host.querySelectorAll('[role="alert"]')).toHaveLength(3)
    act(() => canvas.dismissNotification(canvas.notifications.at(-1)!.id))
    const first = canvas.notifications[0].id
    act(() => canvas.dismissNotification(first))
    expect(messages(host)).toEqual(['上传失败', '已复制 11 个节点'])
    act(() => canvas.report('图片过多'))
    expect(messages(host)).toEqual(['上传失败', '已复制 11 个节点', '图片过多'])
    expect(canvas.notifications[2].id).not.toBe(first)
    act(() => canvas.notifications.filter((item) => item.tone !== 'success').forEach((item) => canvas.dismissNotification(item.id)))
    expect(messages(host)).toEqual(['已复制 11 个节点'])
    expect(canvas.error).toBe('')
    await act(async () => canvas.reload())
    expect(messages(host)).toEqual([])
    await act(async () => vi.advanceTimersByTimeAsync(5000))
    expect(canvas.error).toBe('')
  })
})
