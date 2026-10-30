import { useContext, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import { BorderBeam } from 'border-beam'
import { NodeLoadingContext } from './NodeLoading'

export const CAPSULE_DISPLAY_LIMIT = 5
type MotionPosition = { left: number; top: number; animation?: Animation }
const beamCss = `
[data-beam="{id}"] {
  --beam-opacity-{id}: 1 !important;
  --beam-stroke-opacity: 1.2;
  --beam-inner-opacity: .6;
  --beam-bloom-opacity: .6;
}
[data-beam="{id}"][data-capsule-theme="light"] {
  --beam-stroke-opacity: 3.2;
  --beam-inner-opacity: .65;
  --beam-bloom-opacity: .85;
}
[data-beam="{id}"][data-capsule-paused],
[data-beam="{id}"][data-capsule-paused]::before,
[data-beam="{id}"][data-capsule-paused]::after,
[data-beam="{id}"][data-capsule-paused] [data-beam-bloom] { animation-play-state: paused !important; }
@media (prefers-reduced-motion: reduce) {
  [data-beam="{id}"] { --beam-opacity-{id}: 1 !important; }
  [data-beam="{id}"], [data-beam="{id}"]::before, [data-beam="{id}"]::after,
  [data-beam="{id}"] [data-beam-bloom] { animation-play-state: paused !important; }
}`

export function CapsuleBeam({ children, upload = false }: { children: ReactNode; upload?: boolean }) {
  const { theme, paused } = useContext(NodeLoadingContext)
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return <>{children}</>
  return <BorderBeam size="sm" colorVariant="colorful" theme={theme} staticColors duration={3.6} borderRadius={18}
    strength={.9} glowSize={.65} className={`dc-capsule-beam${upload ? ' dc-upload-beam' : ''}`} css={beamCss}
    data-capsule-theme={theme} data-capsule-paused={paused ? '' : undefined}
    data-upload-theme={upload ? theme : undefined} data-upload-paused={upload && paused ? '' : undefined}>
    {children}
  </BorderBeam>
}

export function CapsuleStack({ ids, overflow, scope, className, label, children }: {
  ids: readonly string[]; overflow: number; scope?: string; className: string; label: string; children: ReactNode
}) {
  const { paused } = useContext(NodeLoadingContext)
  const root = useRef<HTMLDivElement>(null)
  const positions = useRef(new Map<string, MotionPosition>())
  const previousScope = useRef<string>()
  // Progress, message text and same-width +N updates do not replay entrances.
  const layoutKey = JSON.stringify([ids, overflow ? String(overflow).length : 0])
  useLayoutEffect(() => {
    const previous = positions.current
    if (previousScope.current !== scope) {
      for (const item of previous.values()) item.animation?.cancel()
      previous.clear(); previousScope.current = scope
    }
    const first = previous.size === 0
    const next = new Map<string, MotionPosition>()
    for (const element of root.current?.querySelectorAll<HTMLElement>('[data-capsule-motion-id]') ?? []) {
      const id = element.dataset.capsuleMotionId!, old = previous.get(id)
      // Capture an interrupted move before cancelling the transform and
      // measuring its new target, so rapid removals keep their visual position.
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
  }, [layoutKey, paused, scope])
  useEffect(() => () => {
    for (const item of positions.current.values()) item.animation?.cancel()
    positions.current.clear()
  }, [])
  if (!ids.length) return null
  return <div ref={root} className={`dc-capsule-stack ${className} nodrag nopan nowheel`} aria-label={label}>
    {children}
  </div>
}
