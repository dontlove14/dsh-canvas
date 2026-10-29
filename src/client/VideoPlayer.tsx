import { memo, useEffect, useRef, useState, type CSSProperties } from 'react'
import { UiButton } from './ui'
import { createVideoPlayback, formatMediaTime, type VideoPlaybackState } from './videoPlayback'
import { CanvasApi } from './api'
import { useMediaUrl, useRefreshingSource } from './SignedMedia'
import { NodeLoading, useNodeMediaLoading } from './NodeLoading'

export const VideoPlayer = memo(function VideoPlayer({ src, poster, label, autoPlay = false, preview = false, api, canvas = '', assetId = '' }: {
  src: string; poster?: string; label: string; autoPlay?: boolean; preview?: boolean; api?: CanvasApi; canvas?: string; assetId?: string
}) {
  const video = useRef<HTMLVideoElement>(null)
  const controller = useRef<ReturnType<typeof createVideoPlayback> | null>(null)
  const [state, setState] = useState<VideoPlaybackState>({ time: 0, duration: 0, paused: true, error: null })
  const media = useMediaUrl(api, canvas, assetId)
  const actualSrc = api ? media.url : src
  const identity = api ? `${canvas}:${assetId}` : src
  const [readyMedia, setReadyMedia] = useState('')
  const pending = !media.error && state.error !== 'unavailable' && readyMedia !== identity
  const inNode = useNodeMediaLoading(pending)
  useRefreshingSource(video, actualSrc, autoPlay)
  useEffect(() => {
    const element = video.current
    if (!element) return
    const playback = createVideoPlayback(element, setState)
    controller.current = playback
    if (autoPlay && !api) void playback.play()
    return () => { controller.current = null; playback.destroy() }
  }, [api ? assetId : src, autoPlay])
  const time = Math.min(state.time, state.duration || state.time)
  // The inline picture remains a node drag surface; only controls opt out.
  return <div className={`dc-video-player nopan nowheel ${preview ? 'preview nodrag' : ''}`}
    onClick={(event) => event.stopPropagation()}
    onKeyDown={(event) => {
      const canvasModifier = !preview && (event.key === 'Meta' || event.key === 'Control')
      if (!canvasModifier && event.key !== 'Escape' && event.key !== 'Tab') event.stopPropagation()
    }}>
    <video ref={video} poster={poster} loop playsInline preload="auto" draggable={false} aria-label={label}
      onLoadedData={() => setReadyMedia(identity)}
      onError={() => media.retry()} onClick={() => { void media.ensure(); controller.current?.toggle() }} />
    {state.error && <span className="dc-video-message" role={state.error === 'unavailable' ? 'alert' : undefined}>
      {state.error === 'unavailable' ? '视频暂不可播放' : '请点击播放'}
    </span>}
    {media.error && <span className="dc-video-message" role="alert">{media.error}</span>}
    <div className="dc-video-controls" role="group" aria-label="视频播放控制"
      onDoubleClick={(event) => event.stopPropagation()}>
      <UiButton className="dc-video-toggle nodrag" aria-label={state.paused ? '播放视频' : '暂停视频'} title={state.paused ? '播放' : '暂停'}
        onClick={() => { void media.ensure(); controller.current?.toggle() }}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          {state.paused ? <path d="M4 2.5v11L13 8z" /> : <path d="M4 2.5h2.5v11H4zm5.5 0H12v11H9.5z" />}
        </svg>
      </UiButton>
      <span className="dc-video-time">{formatMediaTime(time)}</span>
      <input className="dc-video-progress nodrag" type="range" min={0} max={state.duration || 1} step="any" value={time}
        disabled={!state.duration || state.error === 'unavailable'} aria-label="视频播放进度"
        aria-valuetext={`${formatMediaTime(time)} / ${formatMediaTime(state.duration)}`}
        style={{ '--dc-progress': `${state.duration ? (time / state.duration) * 100 : 0}%` } as CSSProperties}
        onChange={(event) => { void media.ensure(); controller.current?.seek(Number(event.currentTarget.value)) }} />
      <span className="dc-video-time">{formatMediaTime(state.duration)}</span>
    </div>
    {!inNode && <NodeLoading mediaLoading={pending} title={label} />}
  </div>
})
