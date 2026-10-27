import type { MediaKind } from '../shared/contracts'
import imageSvg from './icons/image.svg?raw'
import videoSvg from './icons/video.svg?raw'
import audioSvg from './icons/audio.svg?raw'

// Embed the supplied SVGs so both Vite and the Harness module need no asset routes.
const sources: Record<MediaKind, string> = {
  image: `data:image/svg+xml,${encodeURIComponent(imageSvg)}`,
  video: `data:image/svg+xml,${encodeURIComponent(videoSvg)}`,
  audio: `data:image/svg+xml,${encodeURIComponent(audioSvg)}`,
}

export function MediaIcon({ kind, size = 24, className = '' }: {
  kind: MediaKind
  size?: number
  className?: string
}) {
  return <span className={`dc-media-icon ${className}`} style={{ width: size, height: size }} aria-hidden="true">
    <img src={sources[kind]} alt="" width={size} height={size} draggable={false} />
  </span>
}
