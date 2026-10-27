type AudioClock = Pick<HTMLMediaElement, 'currentTime' | 'duration' | 'paused' | 'ended' | 'error' | 'addEventListener' | 'removeEventListener'>
interface FrameClock {
  request: (callback: FrameRequestCallback) => number
  cancel: (id: number) => void
}
type Visibility = Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'>

/** Paint only the playhead and newly crossed bars. React and canvas state stay out of the frame loop. */
export function createAudioPlayhead(audio: AudioClock, cursor: SVGLineElement, bars: readonly SVGRectElement[], fallbackDuration: number, clock: FrameClock, visibility: Visibility) {
  let disposed = false
  let frame: number | null = null
  let paintedCount = -1
  let position = NaN
  let waiting = false
  const draw = () => {
    if (disposed) return
    const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : fallbackDuration
    const progress = Number.isFinite(duration) && duration > 0 && Number.isFinite(audio.currentTime)
      ? Math.max(0, Math.min(1, audio.currentTime / duration)) : 0
    const x = progress * 320
    if (x !== position) {
      cursor.setAttribute('x1', String(x)); cursor.setAttribute('x2', String(x)); position = x
    }
    const count = Math.ceil(progress * bars.length)
    if (paintedCount < 0) bars.forEach((bar, index) => bar.classList.toggle('played', index < count))
    else for (let index = Math.min(count, paintedCount); index < Math.max(count, paintedCount); index++)
      bars[index].classList.toggle('played', index < count)
    paintedCount = count
  }
  const canAnimate = () => !disposed && !visibility.hidden && !waiting && !audio.paused && !audio.ended && !audio.error
  const cancel = () => { if (frame !== null) { clock.cancel(frame); frame = null } }
  const tick: FrameRequestCallback = () => {
    frame = null
    if (disposed) return
    draw()
    if (canAnimate()) frame = clock.request(tick)
  }
  const schedule = () => { if (frame === null && canAnimate()) frame = clock.request(tick) }
  const start = () => { waiting = false; draw(); schedule() }
  const stop = (event: Event) => {
    if (event.type === 'waiting' || event.type === 'stalled') waiting = true
    cancel(); draw()
  }
  const onVisibility = () => { cancel(); draw(); schedule() }
  const starts = ['play', 'playing']
  const stops = ['pause', 'ended', 'waiting', 'stalled', 'error']
  const updates = ['timeupdate', 'loadedmetadata', 'durationchange', 'seeking', 'seeked', 'ratechange']
  for (const event of starts) audio.addEventListener(event, start)
  for (const event of stops) audio.addEventListener(event, stop)
  for (const event of updates) audio.addEventListener(event, draw)
  visibility.addEventListener('visibilitychange', onVisibility)
  draw(); schedule()
  return {
    sync: draw,
    destroy: () => {
      disposed = true; cancel()
      for (const event of starts) audio.removeEventListener(event, start)
      for (const event of stops) audio.removeEventListener(event, stop)
      for (const event of updates) audio.removeEventListener(event, draw)
      visibility.removeEventListener('visibilitychange', onVisibility)
    },
  }
}
