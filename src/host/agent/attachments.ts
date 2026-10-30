import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ImageAttachmentRef, FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { Readable } from 'node:stream'
import { CanvasError, detectMedia } from '../store'
import type { MediaKind } from '../../shared/contracts'

type UserAttachment = { type: 'image'; attachment: ImageAttachmentRef } | { type: 'file'; attachment: FileAttachmentRef }
/** Raw user events retain admitted originals even when the model surface was compacted. */
export function userAttachments(agent: Agent) {
  const refs = new Map<string, UserAttachment & { messageId: string }>()
  for (const event of agent.session.snapshotEvents()) {
    if (event.type !== 'user/message' || event.data.source.kind !== 'user') continue
    for (const part of event.data.content) if (part.type === 'image' || part.type === 'file') {
      refs.set(part.attachment.attachmentId, { ...part, messageId: event.data.id })
    }
  }
  return [...refs.values()]
}
export function attachmentCatalog(agent: Agent) {
  return userAttachments(agent).map(({ type, attachment, messageId }) => ({
    type, attachmentId: attachment.attachmentId, messageId, name: attachment.name ?? '参考图片',
    bytes: attachment.bytes, ...(type === 'image' ? { mime: (attachment as ImageAttachmentRef).mediaType } : {}),
  }))
}
export async function readUserAttachment(ctx: Context, agent: Agent, id: string, limit: number, signal: AbortSignal): Promise<{ body: Readable; filename: string }> {
  signal.throwIfAborted()
  const entry = userAttachments(agent).find((item) => item.attachment.attachmentId === id)
  if (!entry) throw new CanvasError('附件不属于当前用户会话，请从 canvas_inspect 的附件列表选择', 403, 'ATTACHMENT_FORBIDDEN')
  if (entry.attachment.bytes > limit) throw new CanvasError('参考素材超过媒体大小限制', 413, 'MEDIA_TOO_LARGE')
  if (entry.type === 'image') {
    const image = await ctx.attachments.readImage(entry.attachment, signal)
    signal.throwIfAborted()
    return { body: Readable.from([Buffer.from(image.data)]), filename: entry.attachment.name ?? '参考图片.png' }
  }
  const stream = ctx.attachments.readFileStream(entry.attachment, signal)
  signal.throwIfAborted()
  return { body: Readable.from(stream), filename: entry.attachment.name }
}
/** Detect supported bytes before creating a node; keep the remainder streaming. */
export async function verifiedAttachmentStream(body: Readable, kind: MediaKind, signal: AbortSignal) {
  const iterator = body[Symbol.asyncIterator](), initial: Buffer[] = []
  let prefix = Buffer.alloc(0)
  while (prefix.length < 512) {
    signal.throwIfAborted()
    const item = await iterator.next()
    if (item.done) break
    const chunk = Buffer.from(item.value)
    initial.push(chunk); prefix = Buffer.concat([prefix, chunk.subarray(0, 512 - prefix.length)])
  }
  if (detectMedia(prefix)?.kind !== kind) throw new CanvasError('附件不是所选类型的受支持媒体', 415, 'UNSUPPORTED_MEDIA')
  return Readable.from((async function* () {
    for (const chunk of initial) yield chunk
    while (true) { signal.throwIfAborted(); const item = await iterator.next(); if (item.done) break; yield item.value }
  })())
}
