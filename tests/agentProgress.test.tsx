// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as React from 'react'
import * as JSX from 'react/jsx-runtime'
import * as ReactDom from 'react-dom'
import { createRoot } from 'react-dom/client'
import * as Store from '@deepseek-ai/dsh-client-store'
import * as Cordis from '@deepseek-ai/cordis'
import * as Slots from '@deepseek-ai/dsh-client-ui-slots'
import { z } from 'zod'
import { canvasProgressDefinition, CanvasProgress, installAgentProgress } from '../src/client/agentProgress'

afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals() })
function native() {
  const peers: Record<string, unknown> = { react: React, 'react/jsx-runtime': JSX, 'react-dom': ReactDom,
    '@deepseek-ai/dsh-client-store': Store, '@deepseek-ai/cordis': Cordis, '@deepseek-ai/dsh-client-ui-slots': Slots,
    '@deepseek-ai/dsh-client-ui-primitives': new Proxy({}, { get: () => () => null }), '@tanstack/react-virtual': {}, zod: { z } }
  const evaluate = (name: string, expose = '') => {
    const source = readFileSync(resolve(`node_modules/@deepseek-ai/${name}/lib/client.js`), 'utf8').replace('exports.apply = apply;', `${expose}exports.apply = apply;`)
    let loaded: any
    const previous = (window as any).__ModuleLoader__
    ;(window as any).__ModuleLoader__ = { load: ({ factory }: any) => { loaded = factory((name: string) => {
      if (!(name in peers)) throw new Error(`Unexpected native peer ${name}`)
      return peers[name]
    }) } }
    try { new Function('window', source)(window) }
    finally { if (previous === undefined) delete (window as any).__ModuleLoader__; else (window as any).__ModuleLoader__ = previous }
    return loaded
  }
  const conversation = evaluate('dsh-client-ui-conversation')
  const chat = evaluate('dsh-client-ui-chat', 'exports.chatViewDefinition=chatViewDefinition;exports.processGroupDefinition=processGroupDefinition;exports.toolDefinition=toolDefinition;exports.turnProcessDefinition=turnProcessDefinition;')
  return { conversation, chat }
}
function entry(seq: number, type: string, data: any) { return { type: 'event', event: { type, seq, time: seq + 1, data, ...(type === 'tool/result' ? { surfaceOp: 'append' } : {}) } } }
it('renders a native visible row immediately on call, keeps the ordinary tool and updates without waiting for an assistant reply', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const { conversation, chat } = native()
  const definitions = [canvasProgressDefinition, chat.toolDefinition, chat.turnProcessDefinition]
  const assembler = new conversation.ConversationNodeAssembler({ entries: () => definitions, fallbackEntry: () => undefined },
    { entries: () => [chat.chatViewDefinition] }, { entries: () => [chat.processGroupDefinition], forTarget: () => chat.processGroupDefinition })
  assembler.replaceWindow([entry(0, 'turn/start', { turn: 1 }), entry(1, 'step/start', { turn: 1, step: 1 })], false)
  assembler.activateTarget('chat')
  const call = entry(2, 'tool/call', { turn: 1, step: 1, callId: 'call', name: 'canvas_open', arguments: JSON.stringify({ note: '我先准备产品广告画布。' }) })
  expect(assembler.append(call)).toBe('immediate')
  assembler.flush()
  const snapshot = assembler.snapshot('chat')
  let node = [...snapshot.nodes.values()].find((n: any) => n.kind === 'canvas-progress') as any
  expect(node).toMatchObject({ visibility: 'visible', groupTree: 'turn', data: { phase: 'running', text: '我先准备产品广告画布。' } })
  expect([...snapshot.nodes.values()].some((n: any) => n.kind === 'tool-call')).toBe(true)
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  try {
    await React.act(() => root.render(<CanvasProgress node={node} />))
    expect(document.querySelector('[data-dc-agent-progress="running"]')?.textContent).toBe('我先准备产品广告画布。')
    assembler.append(entry(3, 'tool/result', { turn: 1, step: 1, message: { id: 'result', role: 'tool', source: { kind: 'tool', callId: 'call' }, toolCallId: 'call', content: [{ type: 'text', text: '{"folderCreated":true}' }] } }))
    assembler.flush()
    node = [...assembler.snapshot('chat').nodes.values()].find((n: any) => n.kind === 'canvas-progress')
    expect(node.data).toMatchObject({ phase: 'submitted', outcome: expect.stringContaining('先创建「Agent 创作」') })
    await React.act(() => root.render(<CanvasProgress node={node} />))
    expect(document.body.textContent).toContain('归档项目')
    const groups = assembler.grouped('chat')
    // The custom node is a direct row, never a member hidden inside the native process group.
    expect(groups.entries).toContainEqual({ kind: 'node', key: node.key })
    for (const entry of groups.entries) if (entry.kind === 'group') {
      expect(groups.groupSource(entry.key).getSnapshot().members.some((member: any) => member.key === node.key)).toBe(false)
    }
    definitions.splice(0, 1); assembler.rebuildRegistry(); assembler.flush()
    expect([...assembler.snapshot('chat').nodes.values()].some((n: any) => n.kind === 'canvas-progress')).toBe(false)
    expect([...assembler.snapshot('chat').nodes.values()].some((n: any) => n.kind === 'tool-call')).toBe(true)
  } finally { await React.act(() => root.unmount()) }
})
it('does not claim unrelated tool calls and restores registration through owned disposal', () => {
  expect(canvasProgressDefinition.match(entry(0, 'tool/call', { name: 'bash', callId: 'other' }).event as any)).toBeNull()
  const effect = vi.fn(), register = vi.fn(() => () => {}), slot = vi.fn()
  installAgentProgress({ inject: (_names: unknown, run: (ctx: any) => void) => run({ effect, uiConversation: { events: { register } },
    slots: { inject: (_name: string, run: () => void) => run(), register: slot } }) } as any)
  expect(effect).toHaveBeenCalledTimes(1)
  effect.mock.calls[0][0]()
  expect(register).toHaveBeenCalledWith(canvasProgressDefinition)
  expect(slot).toHaveBeenCalledWith({ name: 'conversation.chat.node', key: 'canvas-progress' }, CanvasProgress)
})
