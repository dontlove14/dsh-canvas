import { memo, useEffect, useRef, useState, type CSSProperties } from 'react'
import { UiButton } from './ui'
import { createVideoPlayback, formatMediaTime, type VideoPlaybackState } from './videoPlayback'

export const VideoPlayer = memo(function VideoPlayer({ src, poster, label, autoPlay = false, preview = false }: {
  src: string; poster?: string; label: string; autoPlay?: boolean; preview?: boolean
}) {
  const video = useRef<HTMLVideoElement>(null)
  const controller = useRef<ReturnType<typeof createVideoPlayback> | null>(null)
  const [state, setState] = useState<VideoPlaybackState>({ time: 0, duration: 0, paused: true, error: null })
  useEffect(() => {
    const element = video.current
    if (!element) return
    const playback = createVideoPlayback(element, setState)
    controller.current = playback
    if (autoPlay) void playback.play()
    return () => { controller.current = null; playback.destroy() }
  }, [src, autoPlay])
  const time = Math.min(state.time, state.duration || state.time)
  return <div className={`dc-video-player nodrag nopan nowheel ${preview ? 'preview' : ''}`}
    onClick={(event) => event.stopPropagation()}
    onKeyDown={(event) => { if (event.key !== 'Escape' && event.key !== 'Tab') event.stopPropagation() }}>
    <video ref={video} src={src} poster={poster} loop playsInline preload="metadata" aria-label={label}
      onClick={() => controller.current?.toggle()} />
    {state.error && <span className="dc-video-message" role={state.error === 'unavailable' ? 'alert' : undefined}>
      {state.error === 'unavailable' ? '视频暂不可播放' : '请点击播放'}
    </span>}
    <div className="dc-video-controls" role="group" aria-label="视频播放控制"
      onPointerDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
      <UiButton className="dc-video-toggle" aria-label={state.paused ? '播放视频' : '暂停视频'} title={state.paused ? '播放' : '暂停'}
        onClick={() => controller.current?.toggle()}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          {state.paused ? <path d="M4 2.5v11L13 8z" /> : <path d="M4 2.5h2.5v11H4zm5.5 0H12v11H9.5z" />}
        </svg>
      </UiButton>
      <span className="dc-video-time">{formatMediaTime(time)}</span>
      <input className="dc-video-progress" type="range" min={0} max={state.duration || 1} step="any" value={time}
        disabled={!state.duration || state.error === 'unavailable'} aria-label="视频播放进度"
        aria-valuetext={`${formatMediaTime(time)} / ${formatMediaTime(state.duration)}`}
        style={{ '--dc-progress': `${state.duration ? (time / state.duration) * 100 : 0}%` } as CSSProperties}
        onChange={(event) => controller.current?.seek(Number(event.currentTarget.value))} />
      <span className="dc-video-time">{formatMediaTime(state.duration)}</span>
    </div>
  </div>
})
