import type { Context } from '@deepseek-ai/cordis'
import type { ConversationNodeDefinition, ConversationStartMatch } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatNodeViewProps, ChatConversationViewNode } from '@deepseek-ai/dsh-client-ui-chat/client'

const steps: Record<string, string> = {
  canvas_open: '我先打开并归档创作画布。',
  canvas_import_attachment: '我正在把你提供的原图或媒体导入画布，作为真实参考。',
  canvas_create_node: '我正在创建并排布这个创作节点。',
  canvas_update_node: '我正在调整节点的提示词或参数。',
  canvas_connect: '我正在连接真实参考素材。',
  canvas_generate: '我正在提交这一步生成任务。',
  canvas_specialist: '我正在请专业 Agent 整理这部分草稿。',
  canvas_draft: '我正在保存创作记录到当前工作区。',
  canvas_document: '我正在分类保存文档到当前工作区。',
  canvas_export_media: '我正在把你要求的素材下载到当前工作区。',
  canvas_review_plan: '我先保存方案，请你审阅后再继续。',
}
interface Progress { text: string; phase: 'running' | 'submitted' | 'failed'; outcome?: string }
declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap { 'canvas-progress': Progress }
}
function started(match: ConversationStartMatch): Progress | undefined {
  if (match.event.type !== 'tool/call') return
  const data = match.event.data
  if (!steps[data.name]) return
  let text = steps[data.name]
  try {
    const args = JSON.parse(data.arguments)
    if (typeof args.note === 'string' && args.note.trim()) text = args.note.trim().slice(0, 180)
  } catch {}
  return { text, phase: 'running' }
}
/** Nonexclusive evidence projection, outside the native Turn-process disclosure. */
export const canvasProgressDefinition: ConversationNodeDefinition<Progress | undefined> = {
  kind: 'canvas-progress', target: 'chat',
  match: (event) => {
    if (event.type === 'tool/call' && steps[event.data.name]) return { id: event.data.callId, role: 'start' }
    if (event.type === 'tool/result') return { id: event.data.message.toolCallId, role: 'update' }
    return null
  },
  start: (_ctx, match) => started(match),
  update: (ctx, match) => {
    if (!ctx.state || match.event.type !== 'tool/result') return ctx.state
    const message = match.event.data.message
    if (message.isError) return { ...ctx.state, phase: 'failed', outcome: '这一步未完成，请查看工具返回原因。' }
    let outcome: string | undefined
    for (const part of message.content) if (part.type === 'text') {
      try {
        const result = JSON.parse(part.text)
        if (result.folderCreated) outcome = '已先创建「Agent 创作」文件夹，并归档项目。'
        else if (result.folderName) outcome = '项目位于「Agent 创作」文件夹。'
        else if (result.referenceReady === false) outcome = '导入任务已提交，素材准备好后再连接引用。'
        else if (result.taskId) outcome = '任务已提交，生成结果以任务状态为准。'
        else if (result.file?.relativePath) outcome = `已保存：${String(result.file.relativePath).slice(0, 500)}`
      } catch {}
    }
    return { ...ctx.state, phase: 'submitted', outcome }
  },
  publication: () => 'immediate',
  buildViewNode: (ctx) => {
    if (!ctx.state || !ctx.start) return null
    return {
      key: ctx.key, id: ctx.id, kind: 'canvas-progress', target: 'chat', data: ctx.state,
      anchorSeq: ctx.start.event.seq, location: ctx.start.location, visibility: 'visible', groupTree: 'turn',
    } satisfies ChatConversationViewNode
  },
}
export function CanvasProgress({ node }: Pick<ChatNodeViewProps<'canvas-progress'>, 'node'>) {
  return <div className="dc-agent-progress" data-dc-agent-progress={node.data.phase} role={node.data.phase === 'failed' ? 'alert' : 'status'}>
    <span>{node.data.text}</span>{node.data.outcome && <small>{node.data.outcome}</small>}
  </div>
}
export function installAgentProgress(ctx: Context) {
  ctx.inject(['uiConversation'], (scope) => {
    scope.effect(() => scope.uiConversation.events.register(canvasProgressDefinition))
    scope.slots.inject('conversation.chat.node', () => scope.slots.register({ name: 'conversation.chat.node', key: 'canvas-progress' }, CanvasProgress))
  })
}
