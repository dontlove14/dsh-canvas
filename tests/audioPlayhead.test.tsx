// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAudioPlayhead } from '../src/client/audioPlayhead'
import { AudioWaveform } from '../src/client/AudioPlayer'

class Audio extends EventTarget {
  currentTime = 0; duration = 10; paused = true; ended = false; error: MediaError | null = null
}
class Visibility extends EventTarget { hidden = false }
class Frames {
  private id = 0
  pending = new Map<number, FrameRequestCallback>()
  request = (callback: FrameRequestCallback) => { const id = this.id++; this.pending.set(id, callback); return id }
  cancel = (id: number) => { this.pending.delete(id) }
  step() {
    const callbacks = [...this.pending.values()]; this.pending.clear()
    for (const callback of callbacks) callback(0)
  }
}
const roots: Root[] = []
const controllers: Array<ReturnType<typeof createAudioPlayhead>> = []
afterEach(() => {
  act(() => { for (const root of roots.splice(0)) root.unmount() })
  for (const controller of controllers.splice(0)) controller.destroy()
  document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
function setup(duration = 10) {
  const audio = new Audio(), visibility = new Visibility(), frames = new Frames()
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  const line = document.createElementNS(svg.namespaceURI, 'line') as SVGLineElement
  const bars = Array.from({ length: 96 }, () => document.createElementNS(svg.namespaceURI, 'rect') as SVGRectElement)
  svg.append(...bars, line); document.body.append(svg)
  const controller = createAudioPlayhead(audio, line, bars, duration, frames, visibility)
  controllers.push(controller)
  const x = () => Number(line.getAttribute('x1'))
  const count = () => bars.filter((bar) => bar.classList.contains('played')).length
  return { audio, line, bars, controller, frames, visibility, x, count }
}
describe('audio playhead frame synchronization', () => {
  it('advances every frame without timeupdate, reads actual media time and never duplicates the loop', () => {
    const { audio, frames, x, count } = setup()
    audio.paused = false; audio.dispatchEvent(new Event('play')); audio.dispatchEvent(new Event('playing'))
    expect(frames.pending.size).toBe(1)
    for (const time of [.016, .032, .064, .1]) {
      audio.currentTime = time; frames.step()
      expect(x()).toBeCloseTo(time / 10 * 320)
      expect(frames.pending.size).toBe(1)
    }
    // A stalled media clock must not be replaced with a fabricated wall clock.
    frames.step(); frames.step(); expect(x()).toBeCloseTo(3.2)
    audio.currentTime = 5; frames.step()
    expect(x()).toBe(160); expect(count()).toBe(48)
  })
  it('freezes on pause, seeks while paused, resumes after buffering and finishes at the end', () => {
    const { audio, frames, x, count } = setup()
    audio.paused = false; audio.dispatchEvent(new Event('play'))
    audio.currentTime = 2; frames.step()
    audio.paused = true; audio.currentTime = 2.25; audio.dispatchEvent(new Event('pause'))
    expect(frames.pending.size).toBe(0); expect(x()).toBe(72)
    audio.currentTime = 4; audio.dispatchEvent(new Event('seeking')); audio.dispatchEvent(new Event('seeked'))
    expect(x()).toBe(128); expect(frames.pending.size).toBe(0)
    audio.paused = false; audio.dispatchEvent(new Event('playing'))
    audio.dispatchEvent(new Event('waiting'))
    expect(frames.pending.size).toBe(0)
    audio.currentTime = 4.5; audio.dispatchEvent(new Event('playing')); frames.step()
    expect(x()).toBe(144); expect(frames.pending.size).toBe(1)
    audio.ended = true; audio.paused = true; audio.currentTime = 10; audio.dispatchEvent(new Event('ended'))
    expect(x()).toBe(320); expect(count()).toBe(96); expect(frames.pending.size).toBe(0)
  })
  it('suspends hidden/error players and ignores callbacks after destruction', () => {
    const { audio, frames, visibility, controller, x } = setup()
    audio.paused = false; audio.dispatchEvent(new Event('play'))
    visibility.hidden = true; visibility.dispatchEvent(new Event('visibilitychange'))
    expect(frames.pending.size).toBe(0)
    audio.currentTime = 3
    visibility.hidden = false; visibility.dispatchEvent(new Event('visibilitychange'))
    expect(x()).toBe(96); expect(frames.pending.size).toBe(1)
    audio.error = { code: 3 } as MediaError; audio.dispatchEvent(new Event('error'))
    expect(frames.pending.size).toBe(0)
    audio.error = null; audio.dispatchEvent(new Event('playing'))
    const late = [...frames.pending.values()][0]
    controller.destroy()
    audio.currentTime = 8; late(0); audio.dispatchEvent(new Event('timeupdate')); controller.sync()
    expect(x()).toBe(96); expect(frames.pending.size).toBe(0)
  })
  it('supports duration fallback and backward seeks without leaving stale highlights or invalid coordinates', () => {
    const { audio, controller, x, count } = setup(8)
    audio.duration = NaN; audio.currentTime = 4; controller.sync()
    expect(x()).toBe(160); expect(count()).toBe(48)
    audio.currentTime = 1; audio.dispatchEvent(new Event('seeked'))
    expect(x()).toBe(40); expect(count()).toBe(12)
    audio.currentTime = 20; controller.sync()
    expect(x()).toBe(320); expect(count()).toBe(96)
    audio.currentTime = NaN; controller.sync()
    expect(x()).toBe(0); expect(count()).toBe(0)
  })
  it('paints the waveform without React frame renders and ignores stale parent time props', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    const frames = new Frames()
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(frames.request)
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(frames.cancel)
    const audio = document.createElement('audio')
    Object.defineProperties(audio, { duration: { value: 10 }, currentTime: { value: 0, writable: true }, paused: { value: false } })
    const media = { current: audio }, peaks = Array(96).fill(.5)
    let renders = 0
    function Wave({ time }: { time: number }) {
      renders++
      return <AudioWaveform peaks={peaks} duration={10} time={time} media={media} onSeek={() => {}} onToggle={() => {}} />
    }
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container); roots.push(root)
    act(() => root.render(<Wave time={0} />))
    for (const time of [.05, .1, .2]) { audio.currentTime = time; frames.step() }
    expect(renders).toBe(1)
    const line = container.querySelector('line')!
    expect(Number(line.getAttribute('x1'))).toBeCloseTo(6.4)
    act(() => root.render(<Wave time={.1} />))
    expect(Number(line.getAttribute('x1'))).toBeCloseTo(6.4)
    expect(container.querySelectorAll('.played')).toHaveLength(2)
    expect(frames.pending.size).toBe(1)
    act(() => root.unmount()); roots.pop()
    expect(frames.pending.size).toBe(0)
  })
})
