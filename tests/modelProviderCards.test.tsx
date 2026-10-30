// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CanvasApi } from '../src/client/api'
import { ModelSettings } from '../src/client/Settings'
import { BUILTIN_MODELS, modelRequiresEndpoint, providerFor } from '../src/shared/modelCatalog'
import { capabilitiesFor, KEY_MASK, type PublicModel } from '../src/shared/contracts'

const roots: Root[] = []
const catalog = (): PublicModel[] => BUILTIN_MODELS.map((model) => ({
  ...model, capabilities: capabilitiesFor(model), has_api_key: false, api_key_mask: '',
}))
beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true))
afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()))
  document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
async function mount(list: PublicModel[]) {
  const api = new CanvasApi(), changed = vi.fn()
  vi.spyOn(api, 'models').mockResolvedValue(list)
  const save = vi.spyOn(api, 'saveModel').mockResolvedValue(list)
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host); roots.push(root)
  await act(async () => root.render(<ModelSettings api={api} onChanged={changed} />))
  const button = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
  const submit = () => [...host.querySelectorAll<HTMLButtonElement>('button')].find((element) => element.textContent === '保存配置')!
  const edit = (model: PublicModel) => act(() => button(`编辑 ${model.name} · ${providerFor(model)!.label}`).click())
  return { api, host, save, changed, button, submit, edit }
}
function input(host: ParentNode, label: string, value: string) {
  const element = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value)
  act(() => element.dispatchEvent(new Event('input', { bubbles: true })))
}
function choose(host: ParentNode, value: string) {
  const element = host.querySelector<HTMLSelectElement>('select[aria-label="配置模型"]')!
  act(() => { element.value = value; element.dispatchEvent(new Event('change', { bubbles: true })) })
}

it('groups all image/video endpoints into seven provider cards and shows each saved combination once without addresses', async () => {
  const list = catalog().map((model) => ({ ...model, has_api_key: true, api_key_mask: KEY_MASK,
    ...(modelRequiresEndpoint(model) ? { endpoint_id: 'ep-private-card' } : {}) }))
  const f = await mount(list)
  expect([...f.host.querySelectorAll('.dc-provider-heading h4')].map((heading) => heading.textContent))
    .toEqual(['Model Link', 'OpenAI', 'Gemini', 'ByteDance', 'BytePlus', 'Aliyun', 'MiniMax'])
  expect(f.host.querySelectorAll('.dc-provider-model')).toHaveLength(39)
  const link = f.host.querySelector('[data-provider="model-link"]')!
  expect(link.querySelectorAll('.dc-provider-model')).toHaveLength(15)
  expect(link.textContent).toContain('15 / 15 已配置')
  expect(link.textContent).toContain('Nano Banana Pro')
  expect(link.textContent).toContain('Doubao Seedance 2.5')
  expect(f.host.textContent).not.toMatch(/https?:|Base URL|ep-private-card/)
  expect(f.host.querySelector('input[type="password"]')).toBeNull()
  expect(f.save).not.toHaveBeenCalled()
})

it('edits the exact official model EP while preserving its key and every other model identity', async () => {
  const list = catalog(), index = 13
  list[index] = { ...list[index], has_api_key: true, endpoint_id: 'ep-old-model' }
  const before = JSON.stringify(list), model = list[index], f = await mount(list)
  f.edit(model)
  expect(f.host.querySelector('h3')!.textContent).toBe('编辑模型')
  expect(f.host.querySelector<HTMLSelectElement>('[aria-label="配置模型"]')!.disabled).toBe(true)
  expect(f.host.querySelector<HTMLSelectElement>('[aria-label="配置供应商"]')!.value).toBe(model.api_base)
  expect(f.host.querySelector<HTMLInputElement>('[aria-label="模型供应商 API Key"]')!.value).toBe('')
  const ep = f.host.querySelector<HTMLInputElement>('[aria-label="模型供应商 EP"]')!
  expect(ep.value).toBe('ep-old-model'); expect(document.activeElement).toBe(ep)
  input(f.host, '模型供应商 EP', 'ep-updated-model')
  await act(async () => f.submit().click())
  expect(f.save).toHaveBeenCalledExactlyOnceWith({ ...BUILTIN_MODELS[index], api_key: undefined, endpoint_id: 'ep-updated-model' })
  expect(f.changed).toHaveBeenCalledTimes(1); expect(f.host.querySelector('form')).toBeNull()
  expect(document.activeElement).toBe(f.button(`编辑 ${model.name} · ByteDance`))
  expect(JSON.stringify(list)).toBe(before)
})

it.each([0, 4, 18])('replaces only the selected Model Link key using its exact protocol endpoint at index %s', async (index) => {
  const list = catalog()
  list[index] = { ...list[index], has_api_key: true }
  const f = await mount(list), model = list[index]
  f.edit(model)
  input(f.host, '模型供应商 API Key', 'new-single-model-key')
  await act(async () => f.submit().click())
  expect(f.save).toHaveBeenCalledExactlyOnceWith({ ...BUILTIN_MODELS[index], api_key: 'new-single-model-key' })
  expect(f.host.textContent).not.toContain('new-single-model-key')
})

it('cancels an edit without a write, restores focus and clears the abandoned secret on reopening', async () => {
  const list = catalog(); list[1] = { ...list[1], has_api_key: true }
  const f = await mount(list), model = list[1]
  f.edit(model); input(f.host, '模型供应商 API Key', 'abandoned-key')
  act(() => [...f.host.querySelectorAll<HTMLButtonElement>('button')].find((element) => element.textContent === '取消')!.click())
  expect(f.save).not.toHaveBeenCalled(); expect(f.changed).not.toHaveBeenCalled()
  expect(document.activeElement).toBe(f.button(`编辑 ${model.name} · OpenAI`))
  f.edit(model)
  expect(f.host.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe('')
})

it('retains a failed edit for an explicit retry and does not apply its draft to the card', async () => {
  const list = catalog(); list[0] = { ...list[0], has_api_key: true }
  const f = await mount(list); f.save.mockRejectedValueOnce(new Error('Unable to save configuration'))
  f.edit(list[0]); input(f.host, '模型供应商 API Key', 'retry-key')
  await act(async () => f.submit().click())
  expect(f.host.querySelector('[role="alert"]')!.textContent).toBe('Unable to save configuration')
  expect(f.host.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe('retry-key')
  expect(f.changed).not.toHaveBeenCalled(); expect(f.submit().disabled).toBe(false)
  await act(async () => f.submit().click())
  expect(f.save).toHaveBeenCalledTimes(2); expect(f.changed).toHaveBeenCalledTimes(1)
})

it('clears one channel from its card while retaining the same model on another provider', async () => {
  const list = catalog().map((model, index) => ({ ...model, has_api_key: index < 2 }))
  const f = await mount(list)
  f.save.mockResolvedValue(list.map((model, index) => ({ ...model, has_api_key: index === 1 })))
  f.edit(list[0])
  act(() => f.host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
  await act(async () => f.submit().click())
  expect(f.save).toHaveBeenCalledExactlyOnceWith({ ...BUILTIN_MODELS[0], api_key: '' })
  expect(f.host.querySelector('[data-provider="model-link"] .dc-provider-status')!.textContent).toBe('未配置')
  expect(f.host.querySelector('[data-provider="openai"] .dc-provider-model')!.textContent).toContain(list[1].name)
  expect(document.activeElement).toBe(f.button('配置新模型'))
})

it('adds from a provider card with only supported models and resolves the video endpoint after choosing a model', async () => {
  const list = catalog(), f = await mount(list)
  act(() => f.button('配置 Model Link 模型').click())
  const choices = [...f.host.querySelector<HTMLSelectElement>('[aria-label="配置模型"]')!.options].map((option) => option.value).filter(Boolean)
  expect(choices).toHaveLength(15); expect(choices).not.toContain('image:dola-seedream-5-0-260128')
  choose(f.host, 'video:doubao-seedance-2-0-260128')
  expect(f.host.querySelector<HTMLSelectElement>('[aria-label="配置供应商"]')!.value).toBe(list[18].api_base)
  input(f.host, '模型供应商 API Key', 'new-video-key')
  await act(async () => f.submit().click())
  expect(f.save).toHaveBeenCalledExactlyOnceWith({ ...BUILTIN_MODELS[18], api_key: 'new-video-key' })
})

it('keeps a key-only official configuration editable until a valid EP completes the combination', async () => {
  const list = catalog(); list[13] = { ...list[13], has_api_key: true }
  const f = await mount(list)
  expect(f.host.querySelector('[data-provider="bytedance"] .dc-provider-status')!.textContent).toBe('待完善')
  f.edit(list[13]); expect(f.submit().disabled).toBe(true)
  input(f.host, '模型供应商 EP', 'invalid-ep'); expect(f.submit().disabled).toBe(true)
  input(f.host, '模型供应商 EP', 'ep-complete')
  f.save.mockResolvedValue(list.map((model, index) => index === 13 ? { ...model, endpoint_id: 'ep-complete' } : model))
  await act(async () => f.submit().click())
  expect(f.host.querySelector('[data-provider="bytedance"] .dc-provider-status')!.textContent).toBe('已配置')
  expect(f.save.mock.calls[0][0].api_key).toBeUndefined()
})

it('prevents duplicate writes while a save is pending and locks the clear-key checkbox', async () => {
  const list = catalog(); list[0] = { ...list[0], has_api_key: true }
  const f = await mount(list)
  let finish!: (value: PublicModel[]) => void
  f.save.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
  f.edit(list[0])
  act(() => {
    f.host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    f.host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  expect(f.save).toHaveBeenCalledTimes(1)
  expect(f.host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.disabled).toBe(true)
  await act(async () => finish(list))
  expect(f.changed).toHaveBeenCalledTimes(1)
})
