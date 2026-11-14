import type { Context } from '@deepseek-ai/cordis'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatNodeViewProps, ChatConversationViewNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import { TASK_ISSUES_URL, TaskDiagnosisSchema, type TaskDiagnosis } from '../shared/taskFailure'

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap { 'canvas-task-diagnosis': TaskDiagnosis }
}
export const taskDiagnosisDefinition: ConversationNodeDefinition<TaskDiagnosis | null> = {
  kind: 'canvas-task-diagnosis', target: 'chat',
  match: (event) => event.type === 'tool/call' && event.data.name === 'canvas_task_diagnose'
    ? { id: event.data.callId, role: 'start' }
    : event.type === 'tool/result' ? { id: event.data.message.toolCallId, role: 'update' } : null,
  start: () => null,
  update: (ctx, match) => {
    if (match.event.type !== 'tool/result' || match.event.data.message.isError) return ctx.state
    for (const part of match.event.data.message.content) if (part.type === 'text') {
      try {
        const parsed = TaskDiagnosisSchema.safeParse(JSON.parse(part.text).diagnosis)
        if (parsed.success) return parsed.data
      } catch {}
    }
    return ctx.state
  },
  publication: () => 'immediate',
  buildViewNode: (ctx) => !ctx.state || !ctx.start ? null : ({
    key: ctx.key, id: ctx.id, kind: 'canvas-task-diagnosis', target: 'chat', data: ctx.state,
    anchorSeq: ctx.start.event.seq, location: ctx.start.location, visibility: 'visible', groupTree: 'turn',
  } satisfies ChatConversationViewNode),
}
export function TaskDiagnosisCard({ node }: Pick<ChatNodeViewProps<'canvas-task-diagnosis'>, 'node'>) {
  const diagnosis = node.data
  return <article className="dc-task-diagnosis" aria-label="任务失败诊断" data-dc-text-selectable="true">
    <strong>{diagnosis.title}</strong>
    <small>任务 ID：{diagnosis.taskId}</small>
    <p>{diagnosis.reason}</p><p>{diagnosis.suggestion}</p>
    {diagnosis.category === 'plugin' && <a className="dc-task-issues-button" href={TASK_ISSUES_URL} target="_blank" rel="noopener noreferrer">反馈给插件作者</a>}
  </article>
}
export function installChatTaskDiagnosis(ctx: Context) {
  ctx.inject(['uiConversation'], (scope) => {
    scope.effect(() => scope.uiConversation.events.register(taskDiagnosisDefinition))
    scope.slots.inject('conversation.chat.node', () => scope.slots.register({
      name: 'conversation.chat.node', key: 'canvas-task-diagnosis',
    }, TaskDiagnosisCard))
  })
}
