import { describe, expect, it, vi } from 'vitest'
import { createVideoPlayback, formatMediaTime, type VideoPlaybackState } from '../src/client/videoPlayback'

class Video extends EventTarget {
  currentTime = 0
  duration = 12
  paused = true
  muted = true
  volume = 0.2
  error: MediaError | null = null
  play = vi.fn(async () => { this.paused = false; this.dispatchEvent(new Event('play')) })
  pause = vi.fn(() => { this.paused = true; this.dispatchEvent(new Event('pause')) })
}
function setup() {
  const video = new Video()
  const onChange = vi.fn<(state: VideoPlaybackState) => void>()
  const playback = createVideoPlayback(video, onChange)
  return { video, onChange, playback }
}

describe('custom video playback', () => {
  it('enables sound and follows actual media playback and time events', async () => {
    const { video, playback, onChange } = setup()
    expect(video.muted).toBe(false); expect(video.volume).toBe(1)
    expect(onChange).toHaveBeenLastCalledWith({ time: 0, duration: 12, paused: true, error: null })
    await playback.play()
    video.currentTime = 3.4; video.dispatchEvent(new Event('timeupdate'))
    expect(onChange).toHaveBeenLastCalledWith({ time: 3.4, duration: 12, paused: false, error: null })
    playback.toggle()
    expect(video.paused).toBe(true)
    playback.destroy()
  })
  it('bounds seeking, updates the displayed time, and rejects invalid positions', () => {
    const { video, playback, onChange } = setup()
    playback.seek(5.5)
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ time: 5.5 }))
    playback.seek(-20); expect(video.currentTime).toBe(0)
    playback.seek(40); expect(video.currentTime).toBe(12)
    playback.seek(NaN); expect(video.currentTime).toBe(12)
    playback.destroy()
  })
  it.each([NaN, Infinity])('keeps an unknown duration safe until metadata becomes available (%s)', (duration) => {
    const { video, playback, onChange } = setup()
    video.duration = duration; video.dispatchEvent(new Event('durationchange'))
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ duration: 0 }))
    playback.seek(3); expect(video.currentTime).toBe(0)
    video.duration = 8; video.dispatchEvent(new Event('loadedmetadata'))
    playback.seek(3); expect(video.currentTime).toBe(3)
    playback.destroy()
  })
  it('shows a blocked autoplay as paused and allows explicit play to recover without muting', async () => {
    const { video, playback, onChange } = setup()
    video.play.mockRejectedValueOnce(new DOMException('User activation required', 'NotAllowedError'))
    await playback.play()
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ paused: true, error: 'blocked' }))
    await playback.play()
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ paused: false, error: null }))
    expect(video.muted).toBe(false)
    playback.destroy()
  })
  it('exposes decoder errors and stops playback and notifications when unmounted', () => {
    const { video, playback, onChange } = setup()
    video.error = { code: 3 } as MediaError; video.dispatchEvent(new Event('error'))
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ error: 'unavailable' }))
    const calls = onChange.mock.calls.length
    playback.destroy()
    video.dispatchEvent(new Event('timeupdate')); playback.seek(5); playback.toggle()
    expect(onChange).toHaveBeenCalledTimes(calls)
    expect(video.pause).toHaveBeenCalledOnce()
    expect(video.currentTime).toBe(0)
  })
  it('ignores late rejection from a player that was closed', async () => {
    const { video, playback, onChange } = setup()
    let reject!: (error: Error) => void
    video.play.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
    const pending = playback.play()
    playback.destroy()
    const calls = onChange.mock.calls.length
    reject(new DOMException('Closed', 'AbortError'))
    await pending
    expect(onChange).toHaveBeenCalledTimes(calls)
  })
  it.each([[0, '0:00'], [65.9, '1:05'], [3600, '60:00'], [NaN, '0:00'], [-10, '0:00']])('formats media time %s', (value, expected) => {
    expect(formatMediaTime(Number(value))).toBe(expected)
  })
})
