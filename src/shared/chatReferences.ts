import { z } from 'zod'
import { IdSchema, WorkspaceIdSchema } from './contracts'

export const CHAT_REFERENCE_SOURCE = 'canvas-hash'
const Common = { version: z.literal(1), sessionId: z.string().min(1).max(200), label: z.string().min(1).max(500) }
export const ChatReferenceSchema = z.discriminatedUnion('kind', [
  z.object({ ...Common, kind: z.literal('media'), canvasId: WorkspaceIdSchema, nodeId: IdSchema, assetId: IdSchema }).strict(),
  z.object({ ...Common, kind: z.literal('file'), cwd: z.string().min(1).max(4096), path: z.string().min(1).max(4096),
    pin: z.object({ bytes: z.number().nonnegative(), modified: z.number(), inode: z.string() }).strict().optional() }).strict(),
])
export type ChatReference = z.infer<typeof ChatReferenceSchema>
export interface ChatReferenceChoices {
  preset: boolean
  cwd?: string
  media: Array<{ label: string; description: string; ref: ChatReference; kind: 'image' | 'video' | 'audio'; section: string }>
}
const START = '<canvas-reference>', END = '</canvas-reference>'
export function referenceText(ref: ChatReference): string {
  return START + JSON.stringify(ChatReferenceSchema.parse(ref)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + END
}
/** Preserve identity in model text, history and clipboard without admitting markup from labels. */
export function referenceSpans(text: string) {
  const results: Array<{ start: number; end: number; ref: ChatReference }> = []
  let from = 0
  while (from < text.length) {
    const start = text.indexOf(START, from)
    if (start < 0) break
    const close = text.indexOf(END, start + START.length)
    if (close < 0) break
    const end = close + END.length
    if (close - start < 14000) try {
      const json = text.slice(start + START.length, close).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
      const result = ChatReferenceSchema.safeParse(JSON.parse(json))
      if (result.success) results.push({ start, end, ref: result.data })
    } catch { /* Ordinary user text remains ordinary text. */ }
    from = end
  }
  return results
}
