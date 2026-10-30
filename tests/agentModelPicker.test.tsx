// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentModelPicker } from '../src/client/AgentControl'
import { installAgentModelPicker } from '../src/client/agentModelSlot'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import type { ComponentType } from 'react'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let root: Root | undefined
afterEach(async () => { if (root) await act(() => root!.unmount()); root = undefined; document.body.replaceChildren(); vi.useRealTimers() })
async function render(models: any[], preset = true) {
  const container = document.createElement('div'); document.body.append(container)
  root = createRoot(container)
  const snapshot = { status: 'ready', current: null, groups: [] }
  const select = vi.fn(async () => ({ ok: true }))
  const load = vi.fn(), agentModels = vi.fn(async () => ({ models })), Original = vi.fn(() => <button className="native-model-select">原生模型选择</button>)
  const directory = { subscribe: () => () => {}, getSnapshot: () => snapshot }
  await act(async () => {
    root!.render(<AgentModelPicker {...{
      api: { agentSession: async () => ({ preset, canvas: null }), agentModels },
      sessionId: 'fixture', Original, directory, load, select,
    } as any} />)
  })
  return { container, select, Original, directory, load, agentModels }
}
it('keeps the native selector and unchanged model directory/actions in the creative preset', async () => {
  const f = await render([{ provider: 'p', providerName: 'P', model: 'text', name: 'Text', eligible: false }])
  expect(f.container.textContent).toBe('原生模型选择')
  expect(f.container.querySelector('select,.dc-agent-model')).toBeNull()
  expect(f.Original.mock.calls[0][0]).toMatchObject({ directory: f.directory, load: f.load, select: f.select })
  expect(f.agentModels).toHaveBeenCalledTimes(1)
})
it('preserves the ordinary model selector outside the creative preset', async () => {
  const f = await render([], false)
  expect(f.container.textContent).toBe('原生模型选择')
  expect(f.container.querySelector('select')).toBeNull()
})
it.each([true, false])('decorates the real native slot with native children/injection preserved (late=%s)', async (late) => {
  vi.useFakeTimers()
  const slots = new SlotCore()
  const declare = slots.register({ name: 'root', children: { 'conversation.input.model': { kind: 'single', scope: 'session' } } }, () => null)
  const Original = ({ renderSlot }: any) => <button>{renderSlot('conversation.input.model.label')}</button>
  const api = { agentSession: async () => ({ preset: false, canvas: null }) } as any
  const snapshot = { status: 'ready', current: null, groups: [] }
  const inject = vi.fn(() => ({ available: true, directory: { subscribe: () => () => {}, getSnapshot: () => snapshot }, load: vi.fn(), select: vi.fn() }))
  const registerNative = () => slots.register({
    name: 'conversation.input.model', locale: 'model',
    children: { 'conversation.input.model.label': { kind: 'single', scope: 'session', inline: true } }, inject,
  }, Original)
  let native: () => void = () => {}
  if (!late) native = registerNative()
  const dispose = installAgentModelPicker(slots, api)
  if (late) native = registerNative()
  const entry = slots.entriesOfSlot('conversation.input.model')[0]
  expect(entry.component).not.toBe(Original)
  expect(entry.inject).toBe(inject)
  expect(entry.children).toHaveProperty('conversation.input.model.label')
  expect(entry.locale).toBe('model')
  expect(slots.entries('conversation.input.model')).toHaveLength(1)
  const label = slots.register({ name: 'conversation.input.model.label' }, () => null)
  const Wrapped = entry.component as ComponentType<any>
  const renderSlot = vi.fn(() => '原生标签贡献')
  const container = document.createElement('div'); document.body.append(container)
  root = createRoot(container)
  await act(async () => root!.render(<Wrapped {...inject()} sessionId="fixture" renderSlot={renderSlot} />))
  expect(container.textContent).toBe('原生标签贡献')
  expect(renderSlot).toHaveBeenCalledWith('conversation.input.model.label')
  expect(vi.getTimerCount()).toBe(1)
  const wrapped = entry.component
  label()
  expect(entry.component).toBe(wrapped)
  await act(() => dispose())
  expect(vi.getTimerCount()).toBe(0)
  expect(container.textContent).toBe('原生标签贡献')
  expect(entry.component).toBe(Original)
  native()
  const replacement = registerNative()
  expect(slots.entriesOfSlot('conversation.input.model')[0].component).toBe(Original)
  replacement(); declare()
})
