// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { CanvasApi } from '../src/client/api'
import { ModelSettings } from '../src/client/Settings'
import { ModelPicker } from '../src/client/ModelPicker'
import { GenerationParameters } from '../src/client/GenerationParameters'
import { capabilitiesFor, defaultParams, type PublicModel } from '../src/shared/contracts'
import { BANANA_MODELS, BUILTIN_MODELS } from '../src/shared/modelCatalog'

const roots: Root[] = []
const catalog = (): PublicModel[] => BUILTIN_MODELS.map((model) => ({ ...model, has_api_key: false, api_key_mask: '',
  configurable: true, capabilities: capabilitiesFor(model) }))
afterEach(() => { act(() => roots.splice(0).forEach((root) => root.unmount())); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
function mount(element: React.ReactNode) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container); roots.push(root); act(() => root.render(element)); return container
}
const button = (host: ParentNode, text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((element) => element.textContent === text)!
function choose(host: ParentNode, label: string, value: string) {
  const select = host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!
  act(() => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })) })
}
function key(host: ParentNode, value: string) {
  const input = host.querySelector<HTMLInputElement>('input[type="password"]')!
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  act(() => input.dispatchEvent(new Event('input', { bubbles: true })))
}

it.each(BANANA_MODELS)('offers only Model Link/Gemini for $name, resets unsaved secrets and saves the selected identity', async (model) => {
  const api = new CanvasApi(), list = catalog()
  vi.spyOn(api, 'models').mockResolvedValue(list)
  const definition = BUILTIN_MODELS.find((item) => item.model_id === model.id && item.api_base === 'https://generativelanguage.googleapis.com')!
  const save = vi.spyOn(api, 'saveModel').mockResolvedValue(list.map((item) => ({ ...item, has_api_key: item.id === definition.id })))
  const container = mount(<ModelSettings api={api} />)
  await act(async () => { await Promise.resolve() })
  act(() => button(container, '＋ 配置模型').click())
  choose(container, '配置模型', `image:${model.id}`)
  const provider = container.querySelector<HTMLSelectElement>('select[aria-label="配置供应商"]')!
  expect([...provider.options].map((option) => option.text)).toEqual(['Model Link', 'Gemini'])
  expect(provider.value).toBe('https://api.modellink.online')
  key(container, 'unsaved-link-key')
  choose(container, '配置供应商', 'https://generativelanguage.googleapis.com')
  expect(container.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe('')
  expect(button(container, '保存配置').disabled).toBe(true)
  key(container, 'google-ui-secret')
  await act(async () => { button(container, '保存配置').click(); await Promise.resolve() })
  expect(save).toHaveBeenCalledWith({ ...definition, api_key: 'google-ui-secret' })
  expect(container.querySelectorAll('.dc-provider-model')).toHaveLength(1)
  expect(container.querySelector('[data-provider="gemini"] .dc-provider-model')!.textContent).toContain(model.name)
  expect(container.querySelector('[data-provider="gemini"] .dc-provider-status')!.textContent).toBe('已配置')
  expect(container.textContent).not.toContain('google-ui-secret')
})

it.each([0, 2, 4, 6])('uses the supported Banana parameter tiers on model %s and sends exact nominal sizes without GPT-only options', (index) => {
  const model = catalog().filter((item) => item.protocol === 'gemini-image')[index], changed = vi.fn()
  function Parameters() {
    const [params, setParams] = useState(defaultParams(model))
    return <GenerationParameters model={model} params={params} disabled={false} onChange={(next) => { setParams(next); changed(next) }} />
  }
  const container = mount(<Parameters />)
  act(() => container.querySelector('button')!.click())
  const dialog = document.querySelector('[role="dialog"]')!
  expect(dialog.textContent).not.toMatch(/背景|画质/)
  expect(button(dialog, '1K').getAttribute('aria-pressed')).toBe('true')
  expect([...dialog.querySelectorAll('.dc-ratio-options button')].map((option) => option.textContent))
    .toEqual(['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'])
  act(() => button(dialog, '21:9').click())
  expect(changed).toHaveBeenLastCalledWith({ size: '1584x672', n: 1 })
  if (index === 4) {
    expect(button(dialog, '2K')).toBeUndefined(); expect(button(dialog, '4K')).toBeUndefined()
  } else {
    act(() => button(dialog, '4K').click())
    expect(changed).toHaveBeenLastCalledWith({ size: '6336x2688', n: 1 })
  }
  if (index === 2) {
    act(() => button(dialog, '0.5K').click())
    expect(changed).toHaveBeenLastCalledWith({ size: '792x168', n: 1 })
  } else expect(button(dialog, '0.5K')).toBeUndefined()
})

it('groups configured Banana channels in the node picker and hides all unconfigured ones', () => {
  const list = catalog().filter((item) => item.protocol === 'gemini-image').map((item, index) => ({ ...item, has_api_key: index < 2 || index === 6 }))
  const changed = vi.fn()
  const container = mount(<ModelPicker models={list} value={list[1].id} disabled={false} onChange={changed} />)
  expect(container.textContent).toContain('Nano Banana Pro · Gemini')
  act(() => container.querySelector('button')!.click())
  const dialog = document.querySelector('[role="dialog"]')!
  expect([...dialog.querySelectorAll('legend')].map((element) => element.textContent)).toEqual(['Nano Banana Pro', 'Nano Banana 2.1'])
  const options = [...dialog.querySelectorAll<HTMLButtonElement>('button')]
  expect(options.map((option) => option.textContent)).toEqual(['Model Link · 默认已配置', 'Gemini已配置', 'Model Link · 默认已配置'])
  act(() => options[2].click())
  expect(changed).toHaveBeenCalledWith(list[6])
})
