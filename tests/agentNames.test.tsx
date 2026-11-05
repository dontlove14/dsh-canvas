// @vitest-environment jsdom
import { act, type ComponentType } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import { createAgentNameView, installAgentNames } from '../src/client/agentNames'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let root: Root | undefined
afterEach(async () => {
  if (root) await act(() => root!.unmount())
  root = undefined
  document.body.replaceChildren()
  vi.useRealTimers()
})
function fixture() {
  return {
    ids: ['root'], byId: { root: { id: 'root', running: false } }, phase: 'ready',
    projectionsBySession: {
      root: { state: 'ready', error: null, values: {
        agentPreset: 'canvas-creator',
        agentTeam: { revision: 7, members: [
          { id: 'root', name: 'lead', phase: 'active' }, { id: 'custom', name: '我的助手', phase: 'failed' },
        ], tasks: [{ id: 'task', owner: 'root', status: 'completed' }] },
        subagentCatalog: [
          { id: 'child', label: 'story', parentId: 'root', status: 'completed' },
          ...['assets', 'shots', 'audio', 'review', 'executor'].map((label) => ({ id: label, label, parentId: 'root' })),
          { id: 'unknown', label: 'constructor', parentId: 'root' },
        ],
        modelSelection: { next: { model: '原模型' } },
      } },
    },
  } as unknown as SessionListState
}
it('localizes historical rosters without mutating source projections or breaking snapshot stability', () => {
  const source = fixture(), before = structuredClone(source), view = createAgentNameView()
  const first = view(source), values = first.projectionsBySession.root!.values as any
  expect(values.agentTeam.members.map((row: any) => row.name)).toEqual(['主智能体', '我的助手'])
  expect(values.subagentCatalog.map((row: any) => row.label))
    .toEqual(['编剧', '视觉资产', '分镜', '音频', '审查', '画布执行', 'constructor'])
  expect(source).toEqual(before)
  expect(first.byId).toBe(source.byId)
  expect(first.ids).toBe(source.ids)
  expect(values.agentTeam.tasks).toBe((source.projectionsBySession.root!.values as any).agentTeam.tasks)
  expect(values.modelSelection).toBe(source.projectionsBySession.root!.values.modelSelection)
  expect(values.subagentCatalog[0]).toMatchObject({ id: 'child', parentId: 'root', status: 'completed' })
  expect(view(source)).toBe(first)
  expect(view({ ...source, byId: { ...source.byId } }).projectionsBySession).toBe(first.projectionsBySession)
  const updated = { ...source, projectionsBySession: {
    ...source.projectionsBySession, child: { state: 'loading', error: null, values: {} },
  } } as unknown as SessionListState
  expect(view(updated).projectionsBySession.root).toBe(first.projectionsBySession.root)
  expect(view(updated).projectionsBySession.child).toBe(updated.projectionsBySession.child)
  const empty = { ...source, projectionsBySession: {} }
  expect(view(empty)).toBe(empty)
})
it.each([false, true])('preserves both native list actions, scope switching and unload (late=%s)', async (late) => {
  vi.useFakeTimers()
  const slots = new SlotCore()
  const declare = slots.register({ name: 'root', children: {
    'conversation.session.header.actions': { kind: 'list', scope: 'session' },
  } }, () => null)
  const source = fixture(), before = structuredClone(source), open = vi.fn()
  const Original = (props: any) => {
    const values = props.useSessions((state: any) => state.projectionsBySession.root.values)
    const rows = props.kind === 'team' ? values.agentTeam.members : values.subagentCatalog
    return <button onClick={() => props.open('child')}>{rows.map((row: any) => row.name ?? row.label).join('、')}</button>
  }
  const inject = vi.fn(() => ({ open }))
  const registerNative = () => ['agent-team', 'subagent-catalog'].map((id, order) =>
    slots.register({ name: 'conversation.session.header.actions', id, order, locale: id, inject }, Original))
  let remove: (() => void)[] = []
  if (!late) remove = registerNative()
  const dispose = installAgentNames(slots)
  if (late) remove = registerNative()
  const unrelated = slots.register({ name: 'conversation.session.header.actions', id: 'other' }, Original)
  const entries = slots.entries('conversation.session.header.actions')
  expect(entries).toHaveLength(3)
  expect(entries.find((entry) => entry.options.id === 'other')!.component).toBe(Original)
  const nativeEntries = entries.filter((entry) => entry.options.id !== 'other')
  for (const entry of nativeEntries) {
    expect(entry.component).not.toBe(Original)
    expect(entry.inject).toBe(inject)
    expect(entry.locale).toBe(entry.options.id)
  }
  const Team = entries.find((entry) => entry.options.id === 'agent-team')!.component as ComponentType<any>
  const Catalog = entries.find((entry) => entry.options.id === 'subagent-catalog')!.component as ComponentType<any>
  let preset = 'canvas-creator'
  const props = {
    open, useSessions: (selector: any) => selector(source),
    useProjection: (_key: string, selector: any) => selector(preset),
  }
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  const render = async () => act(() => root!.render(<><Team {...props} kind="team" /><Catalog {...props} kind="catalog" /></>))
  await render()
  expect(container.textContent).toContain('主智能体')
  expect(container.textContent).toContain('编剧')
  await act(() => container.querySelector('button')!.click())
  expect(open).toHaveBeenCalledWith('child')
  preset = 'standard'; await render()
  expect(container.textContent).toContain('lead')
  expect(container.textContent).toContain('story')
  preset = 'canvas-story'; await render()
  expect(container.textContent).toContain('主智能体')
  await act(() => dispose())
  expect(container.textContent).toContain('lead')
  expect(container.textContent).toContain('story')
  for (const entry of entries) expect(entry.component).toBe(Original)
  expect(source).toEqual(before)
  remove.forEach((remove) => remove())
  const replacements = registerNative()
  for (const entry of slots.entries('conversation.session.header.actions')) expect(entry.component).toBe(Original)
  replacements.forEach((remove) => remove()); unrelated(); declare()
})
