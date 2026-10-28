import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Asset } from '../shared/contracts'
import type { AudioWaveform as WaveformData } from '../shared/audioWaveform'
import { CanvasApi } from './api'
import { UiButton } from './ui'
import { createMediaPlayback, formatMediaTime, type VideoPlaybackState } from './videoPlayback'
import { createAudioPlayhead } from './audioPlayhead'
import { useMediaUrl, useRefreshingSource } from './SignedMedia'
import { NodeLoading, useNodeMediaLoading } from './NodeLoading'

const audioTime = (value: number) => formatMediaTime(value).padStart(5, '0')
export function AudioWaveform({ peaks, time, duration, onSeek, onToggle, media }: {
  peaks: readonly number[]; time: number; duration: number
  onSeek: (time: number) => void; onToggle: () => void
  media?: React.RefObject<HTMLAudioElement>
}) {
  const dragging = useRef(false)
  const svg = useRef<SVGSVGElement>(null)
  const animation = useRef<ReturnType<typeof createAudioPlayhead> | null>(null)
  useLayoutEffect(() => {
    const audio = media?.current, element = svg.current
    if (!audio || !element) return
    const document = element.ownerDocument, view = document.defaultView!
    const playhead = createAudioPlayhead(audio, element.querySelector<SVGLineElement>('.dc-audio-cursor')!,
      [...element.querySelectorAll<SVGRectElement>('rect')], duration, {
        request: (callback) => view.requestAnimationFrame(callback),
        cancel: (id) => view.cancelAnimationFrame(id),
      }, document)
    animation.current = playhead
    return () => { playhead.destroy(); animation.current = null }
  }, [media, peaks, duration])
  useLayoutEffect(() => { animation.current?.sync() }, [time, duration])
  const progress = duration > 0 ? Math.max(0, Math.min(1, time / duration)) : 0
  const seek = (event: React.PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    if (duration > 0 && box.width > 0) onSeek(Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)) * duration)
  }
  return <div className="dc-audio-waveform nodrag nopan" role="slider" tabIndex={duration > 0 ? 0 : -1}
    aria-label="音频播放进度" aria-valuemin={0} aria-valuemax={duration || 1} aria-valuenow={time}
    aria-valuetext={`${audioTime(time)} / ${audioTime(duration)}`} aria-disabled={!duration}
    onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}
    onPointerDown={(event) => {
      event.stopPropagation()
      if (event.button !== 0 || !duration) return
      event.preventDefault(); event.currentTarget.focus()
      event.currentTarget.setPointerCapture?.(event.pointerId); dragging.current = true; seek(event)
    }}
    onPointerMove={(event) => { if (dragging.current) seek(event) }}
    onPointerUp={(event) => { dragging.current = false; if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId) }}
    onPointerCancel={() => { dragging.current = false }}
    onKeyDown={(event) => {
      if (event.key !== 'Tab') event.stopPropagation()
      const current = media?.current?.currentTime ?? time
      const actions: Record<string, number> = { ArrowLeft: current - 5, ArrowDown: current - 5, ArrowRight: current + 5, ArrowUp: current + 5, Home: 0, End: duration }
      if (event.key in actions) { event.preventDefault(); if (duration) onSeek(Math.max(0, Math.min(duration, actions[event.key]))) }
      if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); onToggle() }
    }}>
    <svg ref={svg} viewBox="0 0 320 100" preserveAspectRatio="none" aria-hidden="true">
      {peaks.map((peak, index) => {
        const height = 3 + Math.sqrt(Math.max(0, Math.min(1, peak))) * 41
        return <rect key={index} x={index * 320 / peaks.length + 0.7} y={50 - height / 2} width={Math.max(1, 320 / peaks.length - 1.4)} height={height} rx="1"
          className={!media && index / peaks.length < progress ? 'played' : undefined} />
      })}
      <line x1={media ? undefined : progress * 320} y1="6" x2={media ? undefined : progress * 320} y2="94" className="dc-audio-cursor" />
    </svg>
  </div>
}
export const AudioPlayer = memo(function AudioPlayer({ asset, api, workspace, label, active = true, onPlay, onStop }: {
  asset: Asset; api: CanvasApi; workspace: string; label: string
  active?: boolean; onPlay?: () => void; onStop?: () => void
}) {
  const audio = useRef<HTMLAudioElement>(null)
  const playback = useRef<ReturnType<typeof createMediaPlayback> | null>(null)
  const [state, setState] = useState<VideoPlaybackState>({ time: 0, duration: 0, paused: true, error: null })
  const [waveform, setWaveform] = useState<WaveformData | null>(null)
  const [waveError, setWaveError] = useState(false)
  const [readyAsset, setReadyAsset] = useState('')
  const media = useMediaUrl(api, workspace, asset.id)
  const pending = !media.error && state.error !== 'unavailable' && (readyAsset !== asset.id || (!waveform && !waveError))
  const inNode = useNodeMediaLoading(pending)
  useRefreshingSource(audio, media.url)
  useEffect(() => {
    const controller = new AbortController()
    setWaveform(null); setWaveError(false)
    void api.waveform(workspace, asset.id, controller.signal).then((data) => {
      if (!controller.signal.aborted) setWaveform(data)
    }).catch(() => { if (!controller.signal.aborted) setWaveError(true) })
    return () => controller.abort()
  }, [api, workspace, asset.id])
  useEffect(() => {
    const instance = createMediaPlayback(audio.current!, setState)
    playback.current = instance
    return () => { instance.destroy(); playback.current = null }
  }, [api, workspace, asset.id])
  useEffect(() => { if (!active) playback.current?.pause() }, [active])
  const duration = state.duration || waveform?.duration || asset.duration || 0
  const time = Math.min(state.time, duration || state.time)
  const toggle = () => {
    void media.ensure()
    if (state.paused) { onPlay?.(); void playback.current?.play() }
    else { playback.current?.pause(); onStop?.() }
  }
  return <div className="dc-audio-player nopan" onDoubleClick={(event) => event.stopPropagation()}
    onKeyDown={(event) => { if (event.key !== 'Escape' && event.key !== 'Tab') event.stopPropagation() }}>
    <audio ref={audio} preload="metadata" aria-label={label} onEnded={onStop} onError={() => media.retry()}
      onLoadedMetadata={() => setReadyAsset(asset.id)} />
    <div className="dc-audio-wave-area">
      {waveform ? <AudioWaveform peaks={waveform.peaks} time={time} duration={duration} media={audio} onSeek={(value) => playback.current?.seek(value)} onToggle={toggle} />
        : <div className="dc-audio-wave-message" role={waveError ? 'status' : undefined}>{waveError ? '波形暂不可用，仍可播放' : <span className="dc-sr-only">正在读取音频波形</span>}</div>}
    </div>
    <div className="dc-audio-controls" role="group" aria-label="音频播放控制">
      <span>{audioTime(time)}</span>
      <UiButton className="dc-audio-toggle nodrag nopan" aria-label={state.paused ? '播放音频' : '暂停音频'}
        onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); toggle() }}
        onDoubleClick={(event) => event.stopPropagation()} disabled={state.error === 'unavailable'}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          {state.paused ? <path d="M7 3v18l15-9z" /> : <path d="M6 3h4v18H6zm8 0h4v18h-4z" />}
        </svg>
      </UiButton>
      <span>{audioTime(duration)}</span>
    </div>
    {state.error && <span className="dc-audio-play-message" role="alert">{state.error === 'unavailable' ? '音频暂不可播放，可下载原文件' : '请点击播放音频'}</span>}
    {media.error && <span className="dc-audio-play-message" role="alert">{media.error}</span>}
    {!inNode && <NodeLoading mediaLoading={pending} title={label} />}
  </div>
})
