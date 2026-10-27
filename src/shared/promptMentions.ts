import type { Asset } from './contracts'

export const PROMPT_LIMIT = 32000
export type PromptPart = { kind: 'text'; value: string; start: number; end: number }
  | { kind: 'mention'; value: string; assetId: string; start: number; end: number }

/** IDs live in the existing prompt string; labels never determine a reference. */
export function assetToken(id: string): string { return `{{asset:${id}}}` }
export function promptParts(prompt: string): PromptPart[] {
  const parts: PromptPart[] = []
  let cursor = 0
  for (const match of prompt.matchAll(/\{\{asset:([^{}]*)\}\}/g)) {
    const start = match.index!
    if (start > cursor) parts.push({ kind: 'text', value: prompt.slice(cursor, start), start: cursor, end: start })
    cursor = start + match[0].length
    parts.push({ kind: 'mention', value: match[0], assetId: match[1], start, end: cursor })
  }
  if (cursor < prompt.length) parts.push({ kind: 'text', value: prompt.slice(cursor), start: cursor, end: prompt.length })
  return parts
}
export function referenceLabel(kind: Asset['kind'], index: number): string {
  return `参考${kind === 'image' ? '图' : kind === 'video' ? '视频' : '音频'}${index + 1}`
}
/** Resolve only against the exact ordered inputs captured for this submission. */
export function resolvePrompt(prompt: string, referenceIds: readonly string[], assets: readonly Asset[]): string {
  const byId = new Map(assets.map((asset) => [asset.id, asset]))
  const indices = new Map(referenceIds.map((id, index) => [id, index]))
  return promptParts(prompt).map((part) => {
    if (part.kind === 'text') return part.value
    const asset = byId.get(part.assetId)
    if (!asset) throw new Error('提示词中的参考素材已丢失，请删除标签或重新引用')
    const index = indices.get(part.assetId)
    if (index === undefined) throw new Error('提示词中的参考素材未连接，请重新引用或删除标签')
    return `[${referenceLabel(asset.kind, index)}]`
  }).join('')
}
export interface MentionQuery { start: number; end: number; query: string }
export function mentionQuery(prompt: string, caret: number): MentionQuery | null {
  const part = promptParts(prompt).find((part) => part.kind === 'text' && caret > part.start && caret <= part.end)
  if (!part) return null
  const prefix = prompt.slice(part.start, caret)
  const match = /(?:^|[\s（(，,。;；:：])@([^@\n\r{}]{0,80})$/.exec(prefix)
  if (!match) return null
  return { start: caret - match[1].length - 1, end: caret, query: match[1].trim() }
}
