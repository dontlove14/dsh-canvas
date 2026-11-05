import { createHash } from 'node:crypto'
import { CanvasError } from '../store'
import { FISH_VOICE_MANUAL_GUIDANCE } from '../../shared/agent'

export const FISH_DISCOVERY = 'https://fish.audio/zh-CN/discovery/'
const MAX_PAGE_BYTES = 2 * 1024 * 1024
export interface FishVoice {
  id: string; title: string; description: string; sourceUrl: string; retrievedAt: number; sourceHash: string
}
/** Public website only: no arbitrary URL, private API, authentication or sample download. */
export function fishPageUrl(input: string, detail = false): URL {
  let url: URL
  try { url = new URL(input, FISH_DISCOVERY) } catch { throw new CanvasError('请输入 Fish Audio 官网地址') }
  if (url.protocol !== 'https:' || url.hostname !== 'fish.audio' || url.port || url.username || url.password || url.hash)
    throw new CanvasError('仅支持 https://fish.audio 的公开音色页面', 400, 'FISH_SOURCE_INVALID')
  const voice = /^\/(?:[a-z]{2}(?:-[A-Z]{2})\/)?m\/([a-f0-9]{32})\/?$/i.exec(url.pathname)
  const listing = /^\/(?:[a-z]{2}(?:-[A-Z]{2})\/)?discovery\/?$/.test(url.pathname)
  if (!voice && (detail || !listing)) throw new CanvasError('请提供官网音色详情或 discovery 页面', 400, 'FISH_SOURCE_INVALID')
  if (voice) url.search = ''
  return url
}
function plain(input: string): string {
  return input.replace(/<[^>]*>/g, ' ').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim()
}
function meta(html: string, key: string): string {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs = Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*["']([^"']*)["']/g)].map((m) => [m[1].toLowerCase(), m[2]]))
    if ((attrs.property ?? attrs.name) === key) return plain(attrs.content ?? '')
  }
  return ''
}
export function parseFishListing(html: string, sourceUrl: string, query = '') {
  const voices = new Map<string, { id: string; title: string; sourceUrl: string }>()
  const pages = new Set<string>()
  for (const anchor of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    try {
      const url = fishPageUrl(anchor[1]), id = /\/m\/([a-f0-9]{32})/i.exec(url.pathname)?.[1].toLowerCase()
      if (id) {
        const title = plain(anchor[2]).slice(0, 240)
        if (title) voices.set(id, { id, title, sourceUrl: url.href })
      } else if (url.href !== sourceUrl) pages.add(url.href)
    } catch { /* Ignore media URLs, scripts and external links. */ }
  }
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  return { items: [...voices.values()].filter((voice) => terms.every((term) => voice.title.toLowerCase().includes(term))).slice(0, 20),
    totalListed: voices.size, pages: [...pages].slice(0, 10) }
}
export function parseFishVoice(html: string, sourceUrl: string): FishVoice {
  const url = fishPageUrl(sourceUrl, true), id = /\/m\/([a-f0-9]{32})/i.exec(url.pathname)![1].toLowerCase()
  const title = (meta(html, 'og:title') || plain(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '')).slice(0, 240)
  const canonical = meta(html, 'og:url')
  if (!title || /^(?:Fish Audio|最佳 AI 文字转语音|404|Not Found)/i.test(title) || /not found|页面不存在/i.test(title) ||
    canonical && fishPageUrl(canonical, true).pathname.replace(/\/$/, '') !== url.pathname.replace(/\/$/, ''))
    throw new CanvasError(`官网未返回可核验的音色详情；不能将通用首页或错误页当作音色。${FISH_VOICE_MANUAL_GUIDANCE}`, 502, 'FISH_PAGE_UNAVAILABLE')
  return { id, title, description: (meta(html, 'og:description') || meta(html, 'description')).slice(0, 2000),
    sourceUrl: url.href, retrievedAt: Date.now(), sourceHash: createHash('sha256').update(html).digest('hex') }
}
export async function readFishPage(input: string, signal: AbortSignal): Promise<{ html: string; url: string }> {
  const url = fishPageUrl(input)
  try {
    const response = await fetch(url, { headers: { Accept: 'text/html', 'User-Agent': 'dsh-canvas/voice-discovery' },
      redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]) })
    if (!response.ok || !response.headers.get('content-type')?.includes('text/html') || !response.body)
      throw new Error('unavailable')
    const reader = response.body.getReader(), chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        size += next.value.length
        if (size > MAX_PAGE_BYTES) throw new Error('oversized')
        chunks.push(next.value)
      }
    } finally { await reader.cancel().catch(() => {}) }
    return { html: Buffer.concat(chunks).toString('utf8'), url: url.href }
  } catch {
    signal.throwIfAborted()
    throw new CanvasError(`Fish Audio 官网暂不可读取（网络、访问限制或页面格式变化）；本次没有核验到音色，不下载官网示例，也不猜音色 ID。${FISH_VOICE_MANUAL_GUIDANCE}`, 502, 'FISH_PAGE_UNAVAILABLE')
  }
}
