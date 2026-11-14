import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import * as React from 'react'
import * as JSX from 'react/jsx-runtime'
import * as Store from '@deepseek-ai/dsh-client-store'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ILayout } from '@deepseek-ai/dsh-client-ui-layout/client'
import { TaskAgentNavigation, taskFailureQuestion } from '../src/client/taskAgent'

const target = { id: 'd0bcd0a4-7fbc-4306-95f0-1d5951767167', canvasId: 'canvas' }
// Exercise the installed SDK's actual navigation cancellation, without browser automation.
function nativeLayout(panelInfo: any) {
  const peers: Record<string, unknown> = { react: React, 'react/jsx-runtime': JSX, '@deepseek-ai/dsh-client-store': Store }
  let sdk: any
  const source = readFileSync('node_modules/@deepseek-ai/dsh-client-ui-layout/lib/client.js', 'utf8')
  new Function('window', source)({ __ModuleLoader__: { load: ({ factory }: any) => {
    sdk = factory((name: string) => {
      if (!(name in peers)) throw new Error(`Unexpected layout peer: ${name}`)
      return peers[name]
    })
  } } })
  return new sdk.LayoutController({ selectPanel: (id: any) => panelInfo.set({ activePanelId: id }) }, () => true, panelInfo) as ILayout
}
function fixture() {
  const old = { preset: 'standard', draft: '原对话未发送的草稿', messages: ['原对话内容'] }
  const list = { phase: 'ready', byId: {
    'old-session': { id: 'old-session', cwd: '/existing/workspace', updatedAt: 1, retainedBy: { mainView: 1 } },
  } as Record<string, any> }
  const workspaceState = { phase: 'ready', items: [{ workspaceId: 'workspace', path: '/existing/workspace',
    sessionIds: ['old-session'], createdAt: '2026-11-01T00:00:00.000Z' }] }
  let inputState = { draft: '', draftRev: 0, attachmentIds: [] as string[], phase: 'plain' }
  const input = {
    state: { getSnapshot: () => inputState },
    setDraft: vi.fn((draft: string) => { inputState = { ...inputState, draft, draftRev: inputState.draftRev + 1 } }),
    notify: vi.fn(),
  }
  const session = {
    projections: { faceOf: () => ({ getSnapshot: () => 'canvas-creator' }) },
    getSnapshot: () => ({ removed: false }),
    beginSubmission: vi.fn(() => ({ requestId: 'new-submission', abandon: vi.fn() })),
    prompt: vi.fn(async () => ({ ok: true })),
  }
  const binding = { session, ctx: { sessionId: 'new-session' } }
  const sessions = {
    list: { getSnapshot: () => list },
    create: vi.fn(async () => {
      list.byId['new-session'] = { id: 'new-session', cwd: '/existing/workspace', updatedAt: 2, retainedBy: {} }
      return 'new-session'
    }),
    using: vi.fn(async (_id, _options, run) => run({ ready: Promise.resolve(binding) })),
    refreshProjections: vi.fn(async () => {}),
    retainInfo: () => ({ getSnapshot: () => ({ retainedBy: { mainView: 1 } }) }),
  }
  const panelInfo = Store.createSnapshotStore({ activePanelId: 'dsh-canvas' })
  const layout = nativeLayout(panelInfo), preOpenSignals: AbortSignal[] = []
  const beginNavigation = layout.beginNavigation.bind(layout)
  vi.spyOn(layout, 'beginNavigation').mockImplementation(() => {
    const signal = beginNavigation(); preOpenSignals.push(signal); return signal
  })
  const workspace = { openSession: vi.fn(() => {
    list.byId['old-session'].retainedBy = {}
    list.byId['new-session'].retainedBy = { mainView: 1 }
    layout.selectPanel(null)
  }) }
  const workspaces = { list: { getSnapshot: () => workspaceState } }
  const conversation = { input: {
    for: vi.fn(() => input),
    requestDraftInitialization: vi.fn((_binding: any, { prompt }: any) => {
      if (inputState.draft || inputState.attachmentIds.length || inputState.phase !== 'plain') return 'preserved'
      input.setDraft(prompt ?? ''); return 'applied'
    }),
  } }
  const api = { searchTasks: vi.fn(async () => ({ items: [{ ...target, status: 'failed' }], total: 1, page: 1, pageSize: 10, upperBound: 1 })) }
  const prepare = vi.fn(async () => true)
  const nav = new TaskAgentNavigation(api as any, sessions as unknown as ISessions, layout, workspace as any, workspaces as any, conversation as any, prepare)
  return { nav, api, sessions, session, workspace, prepare, old, list, workspaceState, input, conversation, binding, layout, preOpenSignals }
}
describe('failed task opens an independent native conversation', () => {
  it('creates a fresh preset session, closes the task center, navigates and sends the full ID exactly once', async () => {
    const f = fixture(), close = vi.fn(() => expect(f.workspace.openSession).not.toHaveBeenCalled())
    const old = structuredClone(f.old)
    await f.nav.ask(target, close, new AbortController().signal)
    expect(f.sessions.create).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'workspace', agentPreset: 'canvas-creator' })
    expect(close).toHaveBeenCalledOnce(); expect(f.workspace.openSession).toHaveBeenCalledExactlyOnceWith('new-session')
    expect(f.session.prompt).toHaveBeenCalledExactlyOnceWith([{ type: 'text', text: taskFailureQuestion(target.id) }], 'queue', expect.any(AbortSignal), 'new-submission')
    expect(f.old).toEqual(old)
    expect(f.api.searchTasks).toHaveBeenCalledTimes(2)
    expect(f.preOpenSignals).toHaveLength(2)
    expect(f.preOpenSignals[0].aborted).toBe(true)
    expect(f.preOpenSignals[1].aborted).toBe(false)
    expect(f.input.state.getSnapshot().draft).toBe('')
    expect(f.conversation.input.requestDraftInitialization).toHaveBeenCalledExactlyOnceWith(f.binding, { prompt: taskFailureQuestion(target.id) })
  })
  it('coalesces repeated clicks and rejects a changed success status before sending', async () => {
    const f = fixture(), close = vi.fn()
    let resolve!: (value: string) => void
    const create = f.sessions.create.getMockImplementation()!
    f.sessions.create.mockImplementationOnce(async () => {
      await create()
      return new Promise<string>((done) => { resolve = done })
    })
    const a = f.nav.ask(target, close, new AbortController().signal)
    const b = f.nav.ask(target, close, new AbortController().signal)
    expect(a).toBe(b)
    await vi.waitFor(() => expect(f.sessions.create).toHaveBeenCalledOnce())
    f.api.searchTasks.mockResolvedValue({ items: [{ ...target, status: 'completed' }], total: 1, page: 1, pageSize: 10, upperBound: 1 })
    resolve('new-session')
    await expect(a).rejects.toThrow('不是失败')
    expect(f.session.prompt).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled()
  })
  it('rejects existing or wrongly preset sessions and leaves the old conversation intact', async () => {
    for (const mode of ['old', 'preset']) {
      const f = fixture()
      if (mode === 'old') f.sessions.create.mockResolvedValue('old-session')
      else f.session.projections.faceOf = () => ({ getSnapshot: () => 'standard' })
      await expect(f.nav.ask(target, vi.fn(), new AbortController().signal)).rejects.toThrow()
      expect(f.workspace.openSession).not.toHaveBeenCalled(); expect(f.session.prompt).not.toHaveBeenCalled()
      expect(f.old.draft).toBe('原对话未发送的草稿')
    }
  })
  it('does not navigate or send after cancellation or superseded navigation', async () => {
    const f = fixture(), controller = new AbortController()
    f.sessions.create.mockImplementationOnce(async () => { controller.abort(); return 'new-session' })
    await expect(f.nav.ask(target, vi.fn(), controller.signal)).rejects.toThrow()
    expect(f.workspace.openSession).not.toHaveBeenCalled(); expect(f.session.prompt).not.toHaveBeenCalled()
    const g = fixture()
    g.prepare.mockResolvedValue(false)
    await expect(g.nav.ask(target, vi.fn(), new AbortController().signal)).rejects.toThrow('取消')
    expect(g.sessions.create).not.toHaveBeenCalled()
    const h = fixture()
    h.prepare.mockImplementationOnce(async () => { h.layout.selectPanel('dsh-canvas' as any); return true })
    await expect(h.nav.ask(target, vi.fn(), new AbortController().signal)).rejects.toThrow()
    expect(h.sessions.create).not.toHaveBeenCalled(); expect(h.session.prompt).not.toHaveBeenCalled()
  })
  it('retains the new conversation and retires the local echo when prompt admission fails', async () => {
    const f = fixture(), abandon = vi.fn()
    f.session.beginSubmission.mockReturnValue({ requestId: 'new-submission', abandon })
    f.session.prompt.mockRejectedValue(new Error('connection lost'))
    await expect(f.nav.ask(target, vi.fn(), new AbortController().signal)).rejects.toThrow('connection lost')
    expect(abandon).toHaveBeenCalledOnce(); expect(f.sessions.create).toHaveBeenCalledOnce()
    expect(f.workspace.openSession).toHaveBeenCalledOnce()
    expect(f.input.state.getSnapshot().draft).toBe(taskFailureQuestion(target.id))
    expect(f.input.notify).toHaveBeenCalledWith('error', expect.stringContaining('手动发送'))
  })
  it('inherits the current workspace ahead of a more recent group, then uses the native recent-group fallback', async () => {
    for (const current of [true, false]) {
      const f = fixture()
      f.workspaceState.items.push({ workspaceId: 'recent', path: '/recent/workspace', sessionIds: ['recent-session'], createdAt: '2026-11-12T00:00:00.000Z' })
      f.list.byId['recent-session'] = { id: 'recent-session', updatedAt: 3, retainedBy: {} }
      if (!current) f.list.byId['old-session'].retainedBy = {}
      const create = f.sessions.create.getMockImplementation()!
      f.sessions.create.mockImplementationOnce(async () => {
        await create()
        f.list.byId['new-session'].cwd = current ? '/existing/workspace' : '/recent/workspace'
        return 'new-session'
      })
      await f.nav.ask(target, vi.fn(), new AbortController().signal)
      expect(f.sessions.create).toHaveBeenCalledWith({ workspaceId: current ? 'workspace' : 'recent', agentPreset: 'canvas-creator' })
    }
  })
  it('uses creation time for empty workspaces and host registry order for ties', async () => {
    const f = fixture()
    f.list.byId['old-session'].retainedBy = {}
    f.workspaceState.items = [
      { workspaceId: 'first', path: '/first', sessionIds: [], createdAt: '2026-11-12T00:00:00.000Z' },
      { workspaceId: 'second', path: '/second', sessionIds: [], createdAt: '2026-11-12T00:00:00.000Z' },
    ]
    f.sessions.create.mockImplementationOnce(async () => {
      f.list.byId['new-session'] = { id: 'new-session', cwd: '/first', retainedBy: {} }; return 'new-session'
    })
    await f.nav.ask(target, vi.fn(), new AbortController().signal)
    expect(f.sessions.create).toHaveBeenCalledWith({ workspaceId: 'first', agentPreset: 'canvas-creator' })
  })
  it('reports missing or pending workspaces before creating an empty conversation', async () => {
    for (const pending of [false, true]) {
      const f = fixture(), close = vi.fn()
      f.workspaceState.items = []
      if (pending) f.workspaceState.phase = 'pending'
      await expect(f.nav.ask(target, close, new AbortController().signal)).rejects.toThrow(pending ? '正在准备' : '选择一个工作区')
      expect(f.sessions.create).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled()
    }
  })
  it('rejects a new session without the selected cwd or an unavailable composer before navigation', async () => {
    for (const kind of ['cwd', 'input']) {
      const f = fixture(), close = vi.fn()
      if (kind === 'cwd') {
        const create = f.sessions.create.getMockImplementation()!
        f.sessions.create.mockImplementationOnce(async () => { await create(); delete f.list.byId['new-session'].cwd; return 'new-session' })
      } else f.conversation.input.requestDraftInitialization.mockReturnValue('blocked')
      await expect(f.nav.ask(target, close, new AbortController().signal)).rejects.toThrow()
      expect(close).not.toHaveBeenCalled(); expect(f.session.prompt).not.toHaveBeenCalled()
      expect(f.old.draft).toBe('原对话未发送的草稿')
    }
  })
  it('cancels the send on real subsequent navigation and preserves the new diagnostic draft', async () => {
    const f = fixture()
    f.session.prompt.mockImplementationOnce(async (...args: any[]) => {
      f.layout.selectPanel('dsh-canvas' as any)
      args[2].throwIfAborted()
      return { ok: true }
    })
    await expect(f.nav.ask(target, vi.fn(), new AbortController().signal)).rejects.toThrow()
    expect(f.preOpenSignals[1].aborted).toBe(true)
    expect(f.session.prompt).toHaveBeenCalledOnce(); expect(f.sessions.create).toHaveBeenCalledOnce()
    expect(f.input.state.getSnapshot().draft).toBe(taskFailureQuestion(target.id))
    expect(f.input.notify).not.toHaveBeenCalled()
  })
  it('keeps a newer user draft when admission fails and never retries automatically', async () => {
    const f = fixture()
    f.session.prompt.mockImplementationOnce(async () => { f.input.setDraft('用户新写的内容'); throw new Error('connection lost') })
    await expect(f.nav.ask(target, vi.fn(), new AbortController().signal)).rejects.toThrow('connection lost')
    expect(f.input.state.getSnapshot().draft).toBe('用户新写的内容')
    expect(f.conversation.input.requestDraftInitialization).toHaveBeenCalledOnce()
    expect(f.session.prompt).toHaveBeenCalledOnce(); expect(f.sessions.create).toHaveBeenCalledOnce()
  })
  it('restores the question and reports a resolved native admission refusal', async () => {
    const f = fixture()
    f.session.prompt.mockResolvedValueOnce({ ok: false, error: { message: '模型尚未配置' } } as any)
    await expect(f.nav.ask(target, vi.fn(), new AbortController().signal)).rejects.toThrow('模型尚未配置')
    expect(f.input.state.getSnapshot().draft).toBe(taskFailureQuestion(target.id))
    expect(f.input.notify).toHaveBeenCalledWith('error', expect.stringContaining('模型尚未配置'))
    expect(f.session.prompt).toHaveBeenCalledOnce(); expect(f.sessions.create).toHaveBeenCalledOnce()
  })
})
