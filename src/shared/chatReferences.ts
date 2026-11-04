import { z } from 'zod'
import { IdSchema, WorkspaceIdSchema } from './contracts'

export const CHAT_REFERENCE_SOURCE = 'canvas-hash'
const Common = { version: z.literal(1), sessionId: z.string().min(1).max(200), label: z.string().min(1).max(500) }
export const ChatReferenceSchema = z.discriminatedUnion('kind', [
  z.object({ version: z.literal(2), kind: z.literal('node'), sessionId: Common.sessionId, label: Common.label,
    canvasId: WorkspaceIdSchema, nodeId: IdSchema }).strict(),
  z.object({ ...Common, kind: z.literal('media'), canvasId: WorkspaceIdSchema, nodeId: IdSchema, assetId: IdSchema }).strict(),
  z.object({ ...Common, kind: z.literal('file'), cwd: z.string().min(1).max(4096), path: z.string().min(1).max(4096),
    pin: z.object({ bytes: z.number().nonnegative(), modified: z.number(), inode: z.string() }).strict().optional() }).strict(),
])
export type ChatReference = z.infer<typeof ChatReferenceSchema>
export const ChatReferenceBrowseSchema = z.object({
  currentCanvasId: WorkspaceIdSchema.nullable().optional(),
  folderId: IdSchema.nullable().optional(),
  browseCanvasId: WorkspaceIdSchema.optional(),
  view: z.literal('node-media').optional(),
  nodeId: IdSchema.optional(),
  taskId: IdSchema.optional(),
  cursor: z.string().min(1).max(500).optional(),
}).strict().refine((input) => (!input.nodeId || !!input.browseCanvasId) && (!input.taskId || !!input.nodeId) &&
  (!(input.nodeId || input.cursor) || input.view === 'node-media'), '节点、批次和分页需要对应画布及节点目录')
export type ChatReferenceBrowse = z.infer<typeof ChatReferenceBrowseSchema>
export interface ReferenceFolder {
  id: string | null
  name: string
  canvases: Array<{ id: string; name: string; updatedAt: number }>
}
export interface ChatReferenceChoices {
  preset: boolean
  cwd?: string
  folders?: ReferenceFolder[]
  expandedCanvasId?: string
  currentCanvasId?: string | null
  mediaTruncated?: boolean
  items?: ReferenceItem[]
  nextCursor?: string
  truncated?: boolean
  graphRevision?: number
  media: Array<{ label: string; description: string; ref: ChatReference; kind: 'image' | 'video' | 'audio'; section: string }>
}
export type ReferenceItem =
  | { type: 'node'; label: string; description: string; section: string; ref: Extract<ChatReference, { kind: 'node' }>; hasMedia: boolean }
  | { type: 'media'; label: string; description: string; section: string; ref: Extract<ChatReference, { kind: 'media' }>; kind: 'image' | 'video' | 'audio'; current: boolean }
  | { type: 'directory'; label: string; description: string; section: string; nodeId: string; taskId: string }
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
