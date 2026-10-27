import ttsSvg from './icons/tts.svg?raw'
// Static repository SVG only; inline paths stay vector-based instead of a scaled mask texture.
const markup = ttsSvg.slice(ttsSvg.indexOf('<svg')).replace(/\bfill="#[a-fA-F0-9]+"/g, 'fill="currentColor"')
export function TtsIcon({ size = 24 }: { size?: number }) {
  return <span className="dc-tts-icon" style={{ width: size, height: size }} aria-hidden="true" dangerouslySetInnerHTML={{ __html: markup }} />
}
