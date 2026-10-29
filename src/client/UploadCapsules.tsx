import { useContext, useEffect, useLayoutEffect, useRef } from 'react'
import { BorderBeam } from 'border-beam'
import { UPLOAD_CONCURRENCY } from '../shared/uploads'
import { NodeLoadingContext } from './NodeLoading'
import type { UploadActivity } from './resumableUploads'

type MotionPosition = { left: number; top: number; animation?: Animation }
const beamCss = `
[data-beam="{id}"] {
  --beam-opacity-{id}: 1 !important;
  --beam-stroke-opacity: 1.2;
  --beam-inner-opacity: .6;
  --beam-bloom-opacity: .6;
}
[data-beam="{id}"][data-upload-theme="light"] {
  --beam-stroke-opacity: 3.2;
  --beam-inner-opacity: .65;
  --beam-bloom-opacity: .85;
}
[data-beam="{id}"][data-upload-paused],
[data-beam="{id}"][data-upload-paused]::before,
[data-beam="{id}"][data-upload-paused]::after,
[data-beam="{id}"][data-upload-paused] [data-beam-bloom] { animation-play-state: paused !important; }
@media (prefers-reduced-motion: reduce) {
  [data-beam="{id}"] { --beam-opacity-{id}: 1 !important; }
  [data-beam="{id}"], [data-beam="{id}"]::before, [data-beam="{id}"]::after,
  [data-beam="{id}"] [data-beam-bloom] { animation-play-state: paused !important; }
}`

export function UploadCapsules({ uploads }: { uploads: readonly UploadActivity[] }) {
  const { theme, paused } = useContext(NodeLoadingContext)
  const root = useRef<HTMLDivElement>(null)
  const positions = useRef(new Map<string, MotionPosition>())
  const canvas = useRef<string>()
  const visible = uploads.slice(0, UPLOAD_CONCURRENCY)
  const overflow = uploads.length - visible.length
  // Progress and +N increments do not replay entrances or measure the canvas.
  const layoutKey = JSON.stringify([visible.map((item) => item.id), overflow ? String(overflow).length : 0])
  useLayoutEffect(() => {
    const previous = positions.current
    if (canvas.current !== uploads[0]?.canvas) {
      for (const item of previous.values()) item.animation?.cancel()
      previous.clear(); canvas.current = uploads[0]?.canvas
    }
    const first = previous.size === 0
    const next = new Map<string, MotionPosition>()
    for (const element of root.current?.querySelectorAll<HTMLElement>('[data-upload-motion-id]') ?? []) {
      const id = element.dataset.uploadMotionId!, old = previous.get(id)
      // Preserve the current visual position when another completion interrupts
      // a move. Cancel our transform before measuring the new layout target.
      const moving = old?.animation ? element.getBoundingClientRect() : undefined
      old?.animation?.cancel()
      const target = element.getBoundingClientRect()
      const position: MotionPosition = { left: target.left, top: target.top }
      next.set(id, position)
      if (paused || typeof element.animate !== 'function') continue
      const x = old ? old.left + (moving ? moving.left - target.left : 0) - target.left : first ? 0 : 44
      const y = old ? old.top + (moving ? moving.top - target.top : 0) - target.top : first ? -18 : 0
      if (old && Math.abs(x) < .5 && Math.abs(y) < .5) continue
      const animation = element.animate([
        { transform: `translate(${x}px, ${y}px) scale(${old ? 1 : .96})`, opacity: old ? 1 : 0 },
        { transform: 'translate(0px, 0px) scale(1)', opacity: 1 },
      ], { duration: !old && first ? 300 : 240, easing: 'cubic-bezier(.16,1,.3,1)' })
      position.animation = animation
      void animation.finished.then(() => {
        if (position.animation === animation) position.animation = undefined
      }).catch(() => {})
    }
    for (const [id, item] of previous) if (!next.has(id)) item.animation?.cancel()
    positions.current = next
  }, [layoutKey, paused])
  useEffect(() => () => {
    for (const item of positions.current.values()) item.animation?.cancel()
    positions.current.clear()
  }, [])
  if (!uploads.length) return null
  return <div ref={root} className="dc-upload-capsules nodrag nopan nowheel" aria-label="文件上传进度">
    {visible.map((upload) => {
      const progress = Math.max(0, Math.min(100, upload.progress))
      const label = `${upload.filename}：${progress}%${upload.waiting ? '，等待自动恢复' : ''}`
      const body = <div className="dc-upload-capsule-body">
        <svg className="dc-upload-ring" viewBox="0 0 24 24" aria-hidden="true">
          <circle className="dc-upload-ring-track" cx="12" cy="12" r="9" />
          <circle className="dc-upload-ring-value" cx="12" cy="12" r="9" pathLength="100"
            strokeDasharray={`${progress} 100`} transform="rotate(-90 12 12)" />
        </svg>
        <span className="dc-upload-percentage">{progress}%</span>
      </div>
      return <div key={upload.id} className="dc-upload-capsule" role="progressbar" data-upload-motion-id={upload.id}
        aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}
        title={upload.error ?? label} data-waiting={upload.waiting || undefined}>
        {typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? <BorderBeam
          // The capsule owns the entrance fade; the colored edge is visible
          // immediately instead of waiting for Beam's independent 600ms fade.
          size="sm" colorVariant="colorful" theme={theme} staticColors duration={3.6} borderRadius={18}
          strength={.9} glowSize={.65} className="dc-upload-beam" css={beamCss}
          data-upload-theme={theme} data-upload-paused={paused ? '' : undefined}>{body}</BorderBeam> : body}
      </div>
    })}
    {overflow > 0 && <div className="dc-upload-more" data-upload-motion-id="overflow"
      aria-label={`还有 ${overflow} 个文件等待上传`} title={`还有 ${overflow} 个文件等待上传`}>+{overflow}</div>}
  </div>
}
