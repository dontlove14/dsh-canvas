export interface VideoPlaybackState {
  time: number
  duration: number
  paused: boolean
  error: 'blocked' | 'unavailable' | null
}

type VideoSurface = Pick<HTMLVideoElement, 'currentTime' | 'duration' | 'paused' | 'error' | 'muted' | 'volume' | 'play' | 'pause' | 'addEventListener' | 'removeEventListener'>
const finiteTime = (value: number) => Number.isFinite(value) ? Math.max(0, value) : 0

export function formatMediaTime(value: number): string {
  const seconds = Math.floor(finiteTime(value))
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`
}

/** Shared audio/video playback state; no canvas updates, fields or polling. */
export function createMediaPlayback(video: VideoSurface, onChange: (state: VideoPlaybackState) => void) {
  let disposed = false
  let blocked = false
  const notify = () => {
    if (!disposed) onChange({
      time: finiteTime(video.currentTime), duration: finiteTime(video.duration), paused: video.paused,
      error: video.error ? 'unavailable' : blocked ? 'blocked' : null,
    })
  }
  const onPlay = () => { blocked = false; notify() }
  const events = ['loadedmetadata', 'durationchange', 'timeupdate', 'pause', 'ended', 'error'] as const
  video.muted = false
  video.volume = 1
  for (const event of events) video.addEventListener(event, notify)
  video.addEventListener('play', onPlay)
  notify()

  const play = async () => {
    if (disposed) return
    try { await video.play() }
    catch (error) {
      // Unmount can interrupt play(); that rejection is not a new media failure.
      if (!disposed && !(error instanceof Error && error.name === 'AbortError')) { blocked = true; notify() }
    }
  }
  return {
    play,
    pause: () => { if (!disposed) video.pause() },
    toggle: () => { if (!disposed) { if (video.paused) void play(); else video.pause() } },
    seek: (time: number) => {
      if (disposed || !Number.isFinite(time) || !(video.duration > 0 && Number.isFinite(video.duration))) return
      video.currentTime = Math.max(0, Math.min(video.duration, time))
      notify()
    },
    destroy: () => {
      disposed = true
      for (const event of events) video.removeEventListener(event, notify)
      video.removeEventListener('play', onPlay)
      video.pause()
    },
  }
}
export const createVideoPlayback = createMediaPlayback
