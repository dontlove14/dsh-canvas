import type { UserTextRule, UserTextNodeProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { referenceSpans } from '../shared/chatReferences'

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface UserTextDataMap { 'canvas-hash': { label: string; kind: 'media' | 'file' | 'node' } }
}
export const chatReferenceTextRule: UserTextRule<'canvas-hash'> = {
  id: 'canvas-hash', order: 5,
  match(text, from) {
    const span = referenceSpans(text).find((item) => item.start >= from)
    if (span) return { id: 'canvas-hash', start: span.start, end: span.end, data: { label: span.ref.label, kind: span.ref.kind } }
  },
}
export function ChatReferenceText({ node }: UserTextNodeProps<'canvas-hash'>) {
  return <span className="dc-chat-reference" title={node.data.kind === 'node' ? '画布节点引用' : node.data.kind === 'media' ? '画布素材引用' : '工作区文件引用'}>#{node.data.label}</span>
}
