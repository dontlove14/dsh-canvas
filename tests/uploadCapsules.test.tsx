// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UploadCapsules } from '../src/client/UploadCapsules'
import { NodeLoadingContext } from '../src/client/NodeLoading'
import type { UploadActivity } from '../src/client/resumableUploads'

const roots: Root[] = []
const motions: Array<{ id: string; frames: Keyframe[]; animation: Animation; cancel: ReturnType<typeof vi.fn> }> = []
const offsets = new Map<string, number>()
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('matchMedia', (query: string) => Object.assign(new EventTarget(), { matches: query.includes('color-scheme'), media: query }))
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    const siblings = [...this.parentElement?.querySelectorAll('[data-upload-motion-id]') ?? []]
    return { x: 0, y: 0, left: 100 + siblings.indexOf(this) * 36 + (offsets.get(this.dataset.uploadMotionId!) ?? 0),
      top: 20, right: 0, bottom: 54, width: 88, height: 34, toJSON() {} } as DOMRect
  })
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: function (frames: Keyframe[]) {
    const id = this.dataset.uploadMotionId
    const cancel = vi.fn(() => offsets.delete(id))
    const animation = { cancel, finished: new Promise(() => {}) } as unknown as Animation
    motions.push({ id, frames, animation, cancel })
    return animation
  } })
})
afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()))
  document.body.replaceChildren(); offsets.clear(); motions.length = 0
  delete (HTMLElement.prototype as any).animate
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})
const upload = (id: string, progress = 37): UploadActivity => ({ id, canvas: 'w', filename: `${id}.png`, progress, waiting: false })
function mount(items: UploadActivity[] = []) {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host); roots.push(root)
  const render = (uploads: UploadActivity[], paused = false, theme: 'light' | 'dark' = 'dark') => act(() => root.render(
    <NodeLoadingContext.Provider value={{ theme, ink: '#eee', paused }}><UploadCapsules uploads={uploads} /></NodeLoadingContext.Provider>
  ))
  render(items)
  return { host, render }
}

describe('compact canvas upload capsules', () => {
  it('shows each upload as a separate ring and percentage, including interrupted transfers', () => {
    const { host } = mount([
      { id: 'one', canvas: 'w', filename: 'a.png', progress: 37, waiting: false },
      { id: 'two', canvas: 'w', filename: 'b.mp4', progress: 64, waiting: true },
    ])
    const capsules = host.querySelectorAll('[role="progressbar"]')
    expect(capsules).toHaveLength(2)
    expect(capsules[0].getAttribute('aria-valuenow')).toBe('37')
    expect(capsules[1].getAttribute('aria-label')).toContain('等待自动恢复')
    expect(capsules[0].querySelector('.dc-upload-ring-value')?.getAttribute('stroke-dasharray')).toBe('37 100')
    expect(capsules[1].querySelector('.dc-upload-percentage')?.textContent).toBe('64%')
  })
  it('removes the capsule strip once all uploads complete', () => {
    const { host, render } = mount([upload('one')])
    render([])
    expect(host.childElementCount).toBe(0)
    expect(motions[0].cancel).toHaveBeenCalled()
    motions.length = 0
    render([upload('later')])
    expect(motions[0].frames[0].transform).toContain('translate(0px, -18px)')
  })
  it('bounds a hundred uploads to five real beams and rings, counts overflow, and promotes the next after completion', () => {
    const items = Array.from({ length: 100 }, (_, index) => upload(String(index)))
    const { host, render } = mount(items)
    expect(host.querySelectorAll('[role="progressbar"]')).toHaveLength(5)
    expect(host.querySelectorAll('[data-beam]')).toHaveLength(5)
    expect(host.querySelector('.dc-upload-more')?.textContent).toBe('+95')
    const second = host.querySelector('[data-upload-motion-id="1"]')
    render(items.slice(1))
    expect(host.querySelectorAll('[role="progressbar"]')).toHaveLength(5)
    expect(host.querySelector('[data-upload-motion-id="1"]')).toBe(second)
    expect(host.querySelector('[data-upload-motion-id="5"]')).toBeTruthy()
    expect(host.querySelector('.dc-upload-more')?.textContent).toBe('+94')
    render(items.slice(95))
    expect(host.querySelectorAll('[role="progressbar"]')).toHaveLength(5)
    expect(host.querySelector('.dc-upload-more')).toBeNull()
  })
  it('enters from above first, then from the right, without restarting motion for progress or overflow increments', () => {
    const { host, render } = mount()
    render([upload('one')])
    expect(motions[0].frames[0].transform).toContain('translate(0px, -18px)')
    motions.length = 0
    render([upload('one', 64), upload('two')])
    expect(motions).toHaveLength(1)
    expect(motions[0].id).toBe('two')
    expect(motions[0].frames[0].transform).toContain('translate(44px, 0px)')
    motions.length = 0
    render([upload('one', 90), upload('two', 80)])
    expect(motions).toHaveLength(0)
    const more = Array.from({ length: 5 }, (_, index) => upload(`other-${index}`))
    render(more.concat(upload('extra')))
    motions.length = 0
    render(more.concat(upload('extra'), upload('new')))
    expect(host.querySelector('.dc-upload-more')?.textContent).toBe('+2')
    expect(motions).toHaveLength(0)
  })
  it('moves remaining capsules left and preserves an interrupted move during rapid completions', () => {
    const items = ['one', 'two', 'three'].map((id) => upload(id))
    const { render } = mount(items)
    motions.length = 0
    render(items.slice(1))
    expect(motions.map((item) => item.frames[0].transform)).toEqual([
      'translate(36px, 0px) scale(1)', 'translate(36px, 0px) scale(1)',
    ])
    const moving = motions[1]
    offsets.set('three', 18) // Halfway through its previous 36px move.
    motions.length = 0
    render(items.slice(2))
    expect(moving.cancel).toHaveBeenCalledTimes(1)
    expect(motions[0].frames[0].transform).toBe('translate(54px, 0px) scale(1)')
  })
  it('uses the actual colored Beam with visible glow in both Harness themes, pauses motion, and cleans up', () => {
    const items = [upload('one')]
    const { host, render } = mount(items)
    const beam = host.querySelector('[data-beam]')!
    expect(beam.getAttribute('data-upload-theme')).toBe('dark')
    const darkCss = host.querySelector('style')!.textContent!
    expect(darkCss).toContain('@keyframes beam-spin-')
    expect(darkCss).toContain('rgb(40, 140, 255)')
    expect(darkCss).toContain('rgb(240, 50, 180)')
    expect(darkCss).toContain('--beam-inner-opacity: .6')
    expect(darkCss).toContain('--beam-bloom-opacity: .6')
    expect(darkCss).toContain(`--beam-opacity-${beam.getAttribute('data-beam')}: 1 !important`)
    expect((beam as HTMLElement).style.getPropertyValue('--beam-strength')).toBe('0.9')
    render(items, false, 'light')
    expect(host.querySelector('[data-beam]')).toBe(beam)
    expect(beam.getAttribute('data-upload-theme')).toBe('light')
    const lightCss = host.querySelector('style')!.textContent!
    expect(lightCss).toContain('rgba(0, 0, 0, 0.55)')
    expect(lightCss).toContain('rgb(40, 140, 255)')
    expect(lightCss).toContain('--beam-stroke-opacity: 3.2')
    expect(lightCss).toContain('--beam-inner-opacity: .65')
    expect(lightCss).toContain('--beam-bloom-opacity: .85')
    render(items, true, 'light')
    expect(beam.hasAttribute('data-upload-paused')).toBe(true)
    expect(host.querySelector('style')?.textContent).toContain('animation-play-state: paused !important')
    expect(motions[0].cancel).toHaveBeenCalled()
    motions.length = 0
    render([upload('one'), upload('two')], true, 'light')
    expect(motions).toHaveLength(0)
    render([upload('one'), upload('two'), upload('three')], false)
    const last = motions.at(-1)!
    act(() => roots.pop()!.unmount())
    expect(last.cancel).toHaveBeenCalled()
  })
})
