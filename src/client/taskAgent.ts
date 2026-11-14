import { createContext } from 'react'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { IConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ILayout } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { UiWorkspace } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { CanvasApi } from './api'
import { canAskTaskAgent } from '../shared/taskFailure'

export interface TaskAgentTarget { id: string; canvasId: string }
export interface TaskAgent {
  ask(target: TaskAgentTarget, close: () => void, signal: AbortSignal): Promise<void>
}
export const TaskAgentContext = createContext<TaskAgent | null>(null)
export const taskFailureQuestion = (taskId: string) => `请帮我分析这个任务为什么失败，并用通俗的话说明原因和建议。\n任务 ID：${taskId}`

/** Owns only the new Session; never stages a preset or edits a previous composer. */
export class TaskAgentNavigation implements TaskAgent {
  private pending?: Promise<void>
  private lifetime = new AbortController()
  constructor(private api: Pick<CanvasApi, 'searchTasks'>, private sessions: ISessions,
    private layout: ILayout, private workspace: Pick<UiWorkspace, 'openSession'>,
    private workspaces: Pick<IWorkspaces, 'list'>, private conversation: Pick<IConversation, 'input'>,
    private prepare: (signal: AbortSignal) => Promise<boolean>) {}
  dispose() { this.lifetime.abort() }
  ask(target: TaskAgentTarget, close: () => void, callerSignal: AbortSignal) {
    if (this.pending) return this.pending
    const operation = this.open(target, close, AbortSignal.any([callerSignal, this.lifetime.signal, AbortSignal.timeout(120000)]))
    this.pending = operation
    void operation.finally(() => { if (this.pending === operation) this.pending = undefined }).catch(() => {})
    return operation
  }
  private targetWorkspace() {
    const workspaces = this.workspaces.list.getSnapshot(), sessions = this.sessions.list.getSnapshot()
    if (workspaces.phase !== 'ready' || sessions.phase !== 'ready')
      throw new Error('工作区正在准备，请稍后再试。')
    // mainView is the public ownership projection of UiWorkspace's current selection.
    const current = Object.values(sessions.byId).find((session) => (session.retainedBy.mainView ?? 0) > 0)
    const selected = workspaces.items.find((item) => current && item.sessionIds.includes(current.id))
    if (selected) return selected
    // Match native startSession: latest member activity, creation time for empty groups,
    // and host registry order for ties. Never register or initialize a workspace here.
    let recent: (typeof workspaces.items)[number] | undefined, recentTime = Number.NEGATIVE_INFINITY
    for (const item of workspaces.items) {
      let latest = Number.NEGATIVE_INFINITY
      for (const id of item.sessionIds) {
        const session = sessions.byId[id]
        if (session) latest = Math.max(latest, session.updatedAt)
      }
      if (latest === Number.NEGATIVE_INFINITY) latest = Date.parse(item.createdAt)
      if (!recent || latest > recentTime) { recent = item; recentTime = latest }
    }
    if (!recent) throw new Error('请先选择一个工作区，再点击“询问 Agent”。')
    return recent
  }
  private async open(target: TaskAgentTarget, close: () => void, signal: AbortSignal) {
    let navigation = AbortSignal.any([signal, this.layout.beginNavigation()])
    const failed = async () => {
      const page = await this.api.searchTasks({ taskId: target.id, page: 1, pageSize: 10 }, navigation)
      navigation.throwIfAborted()
      if (!page.items.some((item) => item.id === target.id && item.canvasId === target.canvasId && canAskTaskAgent(item.status)))
        throw new Error('该任务当前不是失败状态或已不可用，请刷新任务列表。')
    }
    await failed()
    if (!await this.prepare(navigation)) throw new Error('已取消打开诊断对话。')
    navigation.throwIfAborted()
    const selected = this.targetWorkspace()
    const oldIds = new Set(Object.keys(this.sessions.list.getSnapshot().byId))
    const sessionId = await this.sessions.create({ workspaceId: selected.workspaceId, agentPreset: 'canvas-creator' })
    navigation.throwIfAborted()
    if (oldIds.has(sessionId)) throw new Error('未取得全新对话，请重新尝试。')
    await this.sessions.using(sessionId, { source: 'workspaceOperation', signal: navigation }, async (reference) => {
      const binding = await reference.ready, { session } = binding
      navigation.throwIfAborted()
      await this.sessions.refreshProjections(sessionId)
      navigation.throwIfAborted()
      const valid = () => {
        navigation.throwIfAborted()
        if (session.projections.faceOf('agentPreset').getSnapshot() !== 'canvas-creator' || session.getSnapshot().removed)
          throw new Error('新对话未能加载无限画布 Agent，请重新尝试。')
        if (this.sessions.list.getSnapshot().byId[sessionId]?.cwd !== selected.path)
          throw new Error('新对话未能关联工作区，未发送诊断请求。')
      }
      valid()
      await failed()
      valid()
      const text = taskFailureQuestion(target.id)
      const resolver = this.conversation.input
      if (resolver.requestDraftInitialization(binding, { prompt: text }) !== 'applied')
        throw new Error('新对话的问题未能准备好，请重新尝试。')
      const input = resolver.for(binding.ctx), preparedRevision = input.state.getSnapshot().draftRev
      let clearedRevision: number | undefined
      try {
        valid()
        close()
        this.workspace.openSession(sessionId)
        // Native openSession reveals the conversation with selectPanel(null), which
        // aborts the pre-open navigation even on success. Own the send separately.
        signal.throwIfAborted()
        navigation = AbortSignal.any([signal, this.layout.beginNavigation()])
        valid()
        if (!(this.sessions.retainInfo(sessionId).getSnapshot().retainedBy.mainView ?? 0) || this.layout.panelInfo.getSnapshot().activePanelId !== null)
          throw new Error('新对话未能打开，未发送诊断请求。')
        const draft = input.state.getSnapshot()
        if (draft.draftRev !== preparedRevision || draft.draft !== text || draft.attachmentIds.length > 0 || draft.phase !== 'plain')
          throw new Error('新对话的输入内容已变化，诊断问题未自动发送。')
        input.setDraft('')
        clearedRevision = input.state.getSnapshot().draftRev
        const submission = session.beginSubmission({ mode: 'queue', text, attachments: [] })
        try {
          valid()
          const result = await session.prompt([{ type: 'text', text }], 'queue', navigation, submission.requestId)
          if (!result.ok) throw new Error(`诊断请求发送失败：${result.error.message}`)
        } catch (error) { submission.abandon(); throw error }
      } catch (error) {
        if (!this.lifetime.signal.aborted) {
          const draft = input.state.getSnapshot()
          if (clearedRevision !== undefined && draft.draftRev === clearedRevision && draft.draft === '')
            resolver.requestDraftInitialization(binding, { prompt: text })
          if (!navigation.aborted || signal.reason?.name === 'TimeoutError')
            input.notify('error', `${error instanceof Error ? error.message : '诊断请求发送失败。'} 请检查新对话的输入内容后手动发送。`)
        }
        throw error
      }
    })
  }
}
