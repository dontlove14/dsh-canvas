import { Component, type ReactNode } from 'react'
import { ImageGeneration } from 'img-fx'

/** Dependency renders only a loading mosaic; media readiness owns its lifetime. */
export function MediaLoadingEffect({ theme, surface, paused, radius }: {
  theme: 'light' | 'dark'; surface: string; paused: boolean; radius: number
}) {
  const fallback = <div className="dc-media-loading-fallback" data-loading-fallback="webgl" aria-hidden="true">
    <svg width="36" height="36" viewBox="0 0 36 36" fill="currentColor">
      <path opacity=".3" d="M0 0h10v10H0zM13 13h10v10H13zM26 26h10v10H26z" />
      <path opacity=".6" d="M13 0h10v10H13zM26 13h10v10H26zM0 26h10v10H0z" />
      <path opacity=".9" d="M26 0h10v10H26zM0 13h10v10H0zM13 26h10v10H13z" />
    </svg>
  </div>
  // Do not allocate a probe WebGL context per node. Initialization failures are
  // isolated below; a browser without WebGL2 retains a static themed indicator.
  if (typeof WebGL2RenderingContext === 'undefined' || typeof ResizeObserver === 'undefined') return fallback
  return <MediaEffectBoundary fallback={fallback}>
    <ImageGeneration preset="pixels-organic" theme={theme} cardBg={surface}
      paused={paused} autoReveal={false} borderRadius={radius} strength={1}
      className="dc-media-loading-effect" aria-hidden="true">
      <div className="dc-media-loading-size" />
    </ImageGeneration>
  </MediaEffectBoundary>
}

class MediaEffectBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() { return this.state.failed ? this.props.fallback : this.props.children }
}
