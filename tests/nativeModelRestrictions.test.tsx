// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { AgentModelPicker } from '../src/client/AgentControl'
import { MODEL_CAPABILITY_FAILED_HINT, MODEL_CAPABILITY_PENDING_HINT, NON_MULTIMODAL_MODEL_HINT } from '../src/client/nativeModelRestrictions'
import { nativeHarnessModelSelect } from './support/nativeHarnessModelSelect'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let root: Root | undefined
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {}; disconnect() {} })
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
})
afterEach(async () => {
  if (root) await act(() => root!.unmount())
  root = undefined; document.body.replaceChildren()
  vi.unstubAllGlobals(); vi.useRealTimers()
  delete (HTMLElement.prototype as any).scrollIntoView
})

const groups = [
  { id: 'p', name: 'Provider P', models: [
    { id: 'same', name: 'Text model' }, { id: 'vision', name: 'Vision model' }, { id: 'other', name: 'Other text' },
  ] },
  { id: 'q', name: 'Provider Q', models: [{ id: 'same', name: 'Same ID vision' }, { id: 'text', name: 'Q text' }] },
]
const models = groups.flatMap((group) => group.models.map((model) => ({
  provider: group.id, providerName: group.name, model: model.id, name: model.name,
  eligible: model.id === 'vision' || group.id === 'q' && model.id === 'same',
})))
async function fixture({ preset = true, capabilities = vi.fn(async () => ({ models })) } = {}) {
  let activePreset = preset
  let snapshot: ModelDirectoryState = { current: null, routable: true, groups, failures: [], status: 'ready', pending: null, error: null }
  const listeners = new Set<() => void>()
  const directory = { subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }, getSnapshot: () => snapshot }
  const select = vi.fn(async () => ({ ok: true })), load = vi.fn()
  const api = { agentSession: async () => ({ preset: activePreset, canvas: null }), agentModels: capabilities }
  const container = document.createElement('div'); document.body.append(container)
  root = createRoot(container)
  await act(async () => root!.render(<AgentModelPicker {...{
    sessionId: 'native-fixture', api, directory, load, select, available: true, locked: false,
    Original: nativeHarnessModelSelect(), openCanvas: vi.fn(),
    t: (key: string) => key, renderSlot: (_key: string, _owner: unknown, options: any) => options.fallback,
  } as any} />))
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!
  await act(async () => trigger.click())
  const row = (provider: string, model: string) => document.querySelector<HTMLElement>(`[data-provider-id="${provider}"][data-model-id="${model}"]`)!.closest<HTMLButtonElement>('button[role="menuitemradio"]')!
  const update = async (patch: Partial<ModelDirectoryState>) => act(async () => {
    snapshot = { ...snapshot, ...patch }; for (const listener of listeners) listener()
  })
  return { container, trigger, row, select, capabilities, update, setPreset: (value: boolean) => { activePreset = value } }
}

it('disables exact non-image routes in real native rows, preserves labels/classes and prevents pointer selection', async () => {
  const f = await fixture(), blocked = f.row('p', 'same'), allowed = f.row('q', 'same')
  expect(blocked.textContent).toBe('Text model')
  expect(blocked.className).not.toBe('')
  expect(blocked.disabled).toBe(true)
  expect(blocked.title).toBe(NON_MULTIMODAL_MODEL_HINT)
  expect(blocked.getAttribute('aria-disabled')).toBe('true')
  expect(allowed.disabled).toBe(false)
  expect(allowed.title).toBe('Same ID vision')
  expect(document.querySelector('select,.dc-agent-model')).toBeNull()
  await act(async () => blocked.click())
  expect(f.select).not.toHaveBeenCalled()
  await act(async () => allowed.click())
  expect(f.select).toHaveBeenCalledWith({ provider: 'q', model: 'same' })
})

it('blocks Enter/Tab on disabled search results and skips disabled rows during row focus navigation', async () => {
  const f = await fixture()
  const search = document.querySelector<HTMLInputElement>('input[role="searchbox"]')!
  await act(async () => { search.focus(); search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
  await act(async () => search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })))
  expect(f.select).not.toHaveBeenCalled()
  const allowed = f.row('p', 'vision')
  await act(async () => {
    allowed.focus()
    allowed.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
  })
  expect(document.activeElement).toBe(f.row('q', 'same'))
})

it('keeps unresolved routes disabled until capability results arrive and retains the same native DOM row', async () => {
  let resolve!: (value: { models: typeof models }) => void
  const capabilities = vi.fn(() => new Promise<{ models: typeof models }>((done) => { resolve = done }))
  const f = await fixture({ capabilities }), row = f.row('p', 'vision'), classes = row.className
  expect(row.disabled).toBe(true)
  expect(row.title).toBe(MODEL_CAPABILITY_PENDING_HINT)
  await act(async () => resolve({ models }))
  expect(f.row('p', 'vision')).toBe(row)
  expect(row.className).toBe(classes)
  expect(row.disabled).toBe(false)
  expect(row.title).toBe('Vision model')
})

it('does not allow metadata failures to become selectable non-multimodal rows', async () => {
  const f = await fixture({ capabilities: vi.fn(async () => { throw new Error('offline capability failure') }) })
  expect(f.row('p', 'vision').disabled).toBe(true)
  expect(f.row('p', 'vision').title).toBe(MODEL_CAPABILITY_FAILED_HINT)
  await act(async () => f.row('p', 'vision').click())
  expect(f.select).not.toHaveBeenCalled()
})

it('keeps native busy handling while reapplying disabled restrictions after a selection settles', async () => {
  const f = await fixture()
  await f.update({ pending: { provider: 'p', model: 'vision' }, status: 'selecting' })
  expect(f.row('p', 'vision').disabled).toBe(true)
  await f.update({ pending: null, status: 'ready' })
  expect(f.row('p', 'vision').disabled).toBe(false)
  expect(f.row('p', 'same').disabled).toBe(true)
  expect(f.row('p', 'same').title).toBe(NON_MULTIMODAL_MODEL_HINT)
})

it('preserves ordinary Agent menu choices and avoids capability calls for other presets', async () => {
  const f = await fixture({ preset: false })
  expect(f.row('p', 'same').disabled).toBe(false)
  expect(f.row('p', 'same').title).toBe('Text model')
  expect(f.capabilities).not.toHaveBeenCalled()
  await act(async () => f.row('p', 'same').click())
  expect(f.select).toHaveBeenCalledWith({ provider: 'p', model: 'same' })
})

it('removes restrictions when the same session switches away from the canvas Agent', async () => {
  vi.useFakeTimers()
  const f = await fixture()
  expect(f.row('p', 'same').disabled).toBe(true)
  f.setPreset(false)
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  expect(f.row('p', 'same').disabled).toBe(false)
  expect(f.row('p', 'same').title).toBe('Text model')
  expect(f.row('p', 'same').hasAttribute('aria-disabled')).toBe(false)
})
