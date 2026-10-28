// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CanvasApi } from '../src/client/api'
import { GenerationParameters } from '../src/client/GenerationParameters'
import { ModelPicker } from '../src/client/ModelPicker'
import { ModelSettings, CanvasSettings } from '../src/client/Settings'
import { capabilitiesFor, defaultParams, FISH_TTS_ENDPOINT, type GenerationParams, type PublicModel } from '../src/shared/contracts'
import { BUILTIN_MODELS } from '../src/shared/modelCatalog'
import { MOCK_MODELS } from '../src/shared/mockModels'

const roots: Root[] = []
afterEach(() => { act(() => roots.splice(0).forEach((root) => root.unmount())); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
function models(): PublicModel[] { return BUILTIN_MODELS.filter((model) => model.protocol === 'openai-image').map((model) => ({ ...model, has_api_key: true, api_key_mask: '••••••••', configurable: true, capabilities: capabilitiesFor(model) })) }
function mount(element: React.ReactNode) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container); roots.push(root); act(() => root.render(element)); return container
}
function button(text: string, host: ParentNode = document.body) {
  return [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === text)!
}
function choose(host: ParentNode, label: string, value: string) {
  const select = host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!
  act(() => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })) })
}
function keyValue(host: ParentNode, value: string) {
  const input = host.querySelector<HTMLInputElement>('input[type="password"]')!
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  act(() => { input.dispatchEvent(new Event('input', { bubbles: true })) })
}
describe('image model controls', () => {
  it('groups both channels under each model and reports the exact selected identity', () => {
    const list = models(), change = vi.fn()
    const container = mount(<ModelPicker models={list} value={list[0].id} disabled={false} onChange={change} />)
    act(() => { container.querySelector('button')!.click() })
    const dialog = document.querySelector('[role="dialog"]')!
    expect([...dialog.querySelectorAll('legend')].map((element) => element.textContent)).toEqual(['GPT Image 2.5 Sunburst', 'GPT Image 2.5 Flare'])
    const options = [...dialog.querySelectorAll('button')]
    expect(options.map((option) => option.textContent)).toEqual(['Model Link · 默认已配置', 'OpenAI已配置', 'Model Link · 默认已配置', 'OpenAI已配置'])
    act(() => { options[1].click() })
    expect(change).toHaveBeenCalledWith(list[1]); expect(document.querySelector('[role="dialog"]')).toBeNull()
  })
  it.each([2, 3])('shows only the configured provider %s and hides all other channels, models and image mocks', (configuredIndex) => {
    const list = models().map((model, index) => ({ ...model, has_api_key: index === configuredIndex }))
    const input = [...list, ...MOCK_MODELS.filter((model) => model.kind === 'image')]
    const before = JSON.stringify(input), changed = vi.fn()
    const container = mount(<ModelPicker models={input} value={MOCK_MODELS[0].id} disabled={false} onChange={changed} />)
    expect(container.textContent).toContain('选择模型')
    expect(container.textContent).not.toContain('Mock Image')
    act(() => { container.querySelector('button')!.click() })
    const dialog = document.querySelector('[role="dialog"]')!
    expect([...dialog.querySelectorAll('legend')].map((element) => element.textContent)).toEqual(['GPT Image 2.5 Flare'])
    expect(dialog.textContent).not.toContain('Sunburst'); expect(dialog.textContent).not.toContain('Mock Image')
    expect([...dialog.querySelectorAll('button')].map((option) => option.textContent)).toEqual([configuredIndex === 2 ? 'Model Link · 默认已配置' : 'OpenAI已配置'])
    expect(dialog.textContent).not.toContain('未配置')
    act(() => { dialog.querySelector<HTMLButtonElement>('button')!.click() })
    expect(changed).toHaveBeenCalledWith(list[configuredIndex])
    expect(JSON.stringify(input)).toBe(before)
  })
  it('removes a cleared provider immediately while retaining another configured channel without changing the selection', () => {
    const list = models().map((model, index) => ({ ...model, has_api_key: index < 2 }))
    const changed = vi.fn()
    const container = mount(<ModelPicker models={list} value={list[0].id} disabled={false} onChange={changed} />)
    act(() => { container.querySelector('button')!.click() })
    expect(document.querySelector('[role="dialog"]')!.querySelectorAll('button')).toHaveLength(2)
    act(() => { roots.at(-1)!.render(<ModelPicker models={list.map((model, index) => ({ ...model, has_api_key: index === 1 }))} value={list[0].id} disabled={false} onChange={changed} />) })
    const dialog = document.querySelector('[role="dialog"]')!
    expect([...dialog.querySelectorAll('button')].map((button) => button.textContent)).toEqual(['OpenAI已配置'])
    expect(dialog.textContent).not.toContain('Model Link')
    expect(container.textContent).toContain('选择模型')
    expect(changed).not.toHaveBeenCalled()
  })
  it('updates eligibility after the last provider key is cleared and offers settings when no image model is available', () => {
    const list = models().map((model, index) => ({ ...model, has_api_key: index === 1 }))
    const changed = vi.fn()
    const container = mount(<ModelPicker models={list} value={list[1].id} disabled={false} onChange={changed} />)
    act(() => { container.querySelector('button')!.click() })
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Sunburst')
    act(() => { roots.at(-1)!.render(<ModelPicker models={list.map((model) => ({ ...model, has_api_key: false }))} value={list[1].id} disabled={false} onChange={changed} />) })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(container.textContent).toContain('请前往设置页面配置模型')
    expect(container.querySelector<HTMLButtonElement>('button')!.disabled).toBe(true)
    expect(changed).not.toHaveBeenCalled()
  })
  it('does not fill an unconfigured picker with a mock fallback of either kind', () => {
    const changed = vi.fn()
    const input = [...models().map((model) => ({ ...model, has_api_key: false })), ...MOCK_MODELS]
    const before = JSON.stringify(input)
    const container = mount(<ModelPicker models={input} value={MOCK_MODELS[0].id} disabled={false} onChange={changed} />)
    expect(container.querySelector('button')!.textContent).toContain('请前往设置页面配置模型')
    expect(container.querySelector<HTMLButtonElement>('button')!.disabled).toBe(true)
    expect(container.textContent).not.toContain('Mock')
    act(() => { container.querySelector('button')!.click() })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(changed).not.toHaveBeenCalled()
    expect(JSON.stringify(input)).toBe(before)
  })
  it('uses Chinese enums with English values and offers only allowed ratios per resolution', () => {
    const model = models()[0], changed = vi.fn()
    function Parameters() {
      const [params, setParams] = useState(defaultParams(model))
      return <GenerationParameters model={model} params={params} disabled={false} onChange={(next) => { setParams(next); changed(next) }} />
    }
    const container = mount(<Parameters />)
    act(() => { container.querySelector('button')!.click() })
    const dialog = document.querySelector('[role="dialog"]')!
    const ratioButtons = () => [...dialog.querySelectorAll<HTMLButtonElement>('.dc-ratio-options button')].map((button) => button.textContent)
    expect(ratioButtons()).toEqual(['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'])
    act(() => { button('2K', dialog).click() })
    expect(ratioButtons()).toEqual(['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'])
    act(() => { button('16:9', dialog).click() })
    expect(changed).toHaveBeenLastCalledWith({ ...defaultParams(model), size: '2048x1152' })
    act(() => { button('4K', dialog).click() })
    expect(ratioButtons()).toEqual(['9:16', '16:9', '21:9'])
    act(() => { button('透明', dialog).click() })
    act(() => { button('最高', dialog).click() })
    expect(changed).toHaveBeenLastCalledWith({ size: '3840x2160', n: 1, background: 'transparent', quality: 'max' })
  })
  it.each([0, 2])('selects the requested wide ratios at 1K and keeps them across resolution changes for model %s', (index) => {
    const model = models()[index], changed = vi.fn()
    function Parameters() {
      const [params, setParams] = useState<GenerationParams>({ ...defaultParams(model), n: 3, background: 'transparent', quality: 'max' })
      return <GenerationParameters model={model} params={params} disabled={false} onChange={(next) => { setParams(next); changed(next) }} />
    }
    const container = mount(<Parameters />)
    act(() => { container.querySelector('button')!.click() })
    const dialog = document.querySelector('[role="dialog"]')!
    for (const [ratio, size] of [['16:9', '1280x720'], ['9:16', '720x1280'], ['21:9', '1344x576']]) {
      const option = button(ratio, dialog)
      expect(option.title).toBe(size)
      act(() => { option.click() })
      expect(changed).toHaveBeenLastCalledWith({ size, n: 3, background: 'transparent', quality: 'max' })
      expect(option.getAttribute('aria-pressed')).toBe('true')
      expect(container.querySelector('button')!.textContent).toContain(`${ratio} · 1K`)
    }
    act(() => { button('2K', dialog).click() })
    expect(changed.mock.lastCall![0].size).toBe('2048x880')
    act(() => { button('4K', dialog).click() })
    expect(changed.mock.lastCall![0].size).toBe('3840x1648')
    act(() => { button('1K', dialog).click() })
    expect(changed.mock.lastCall![0].size).toBe('1344x576')
    expect(dialog.textContent).not.toContain('7:3')
  })
  it.each([0, 1, 2, 3])('orders supported ratios through 21:9 without changing defaults or resolution fallback on model %s', (index) => {
    const model = models()[index], changed = vi.fn()
    function Parameters() {
      const [params, setParams] = useState(defaultParams(model))
      return <GenerationParameters model={model} params={params} disabled={false} onChange={(next) => { setParams(next); changed(next) }} />
    }
    const container = mount(<Parameters />)
    act(() => { container.querySelector('button')!.click() })
    const dialog = document.querySelector('[role="dialog"]')!
    const ratios = () => [...dialog.querySelectorAll('.dc-ratio-options button')].map((option) => option.textContent)
    const expected = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']
    expect(ratios()).toEqual(expected)
    expect(button('1:1', dialog).getAttribute('aria-pressed')).toBe('true')
    expect(changed).not.toHaveBeenCalled()
    act(() => { button('2K', dialog).click() })
    expect(ratios()).toEqual(expected)
    act(() => { button('4K', dialog).click() })
    expect(ratios()).toEqual(['9:16', '16:9', '21:9'])
    expect(changed.mock.lastCall![0].size).toBe('3840x2160')
    expect(button('16:9', dialog).getAttribute('aria-pressed')).toBe('true')
    expect(dialog.textContent).not.toMatch(/9:25|25:9/)
  })
  it('configures only the selected model/provider key without editable addresses or custom model fields', async () => {
    const api = new CanvasApi(), list = models()
    vi.spyOn(api, 'models').mockResolvedValue(list)
    vi.spyOn(api, 'ttsSettings').mockResolvedValue({ endpoint: FISH_TTS_ENDPOINT, revision: 0, configured: true, has_api_key: true, api_key_mask: '••••••••' })
    const save = vi.spyOn(api, 'saveModel').mockResolvedValue(list)
    const container = mount(<ModelSettings api={api} />)
    await act(async () => { await Promise.resolve() })
    expect(container.querySelectorAll('.dc-model-row')).toHaveLength(2)
    expect(container.querySelectorAll('.dc-model-row button')).toHaveLength(0)
    act(() => { button('＋ 配置模型', container).click() })
    choose(container, '配置模型', 'image:gpt-image-2.5-sunburst')
    choose(container, '配置供应商', BUILTIN_MODELS[1].api_base)
    expect(container.querySelectorAll('input[type="url"]')).toHaveLength(0)
    expect(container.textContent).not.toContain('添加模型')
    await act(async () => { button('保存配置', container).click(); await Promise.resolve() })
    expect(save).toHaveBeenCalledWith({ ...BUILTIN_MODELS[1], api_key: undefined })
  })
  it('keeps FishTTS in its separate tab and saves its independent key', async () => {
    const api = new CanvasApi(), list = models().map((model) => ({ ...model, has_api_key: false }))
    vi.spyOn(api, 'models').mockResolvedValue(list)
    vi.spyOn(api, 'ttsSettings').mockResolvedValue({ endpoint: FISH_TTS_ENDPOINT, revision: 2, configured: false, has_api_key: false, api_key_mask: '' })
    const save = vi.spyOn(api, 'saveTtsSettings').mockResolvedValue({ endpoint: FISH_TTS_ENDPOINT, revision: 3, configured: true, has_api_key: true, api_key_mask: '••••••••' })
    const imageSave = vi.spyOn(api, 'saveModel')
    const container = mount(<CanvasSettings api={api} initialTab="models" />)
    await act(async () => { await Promise.resolve() })
    expect(container.querySelectorAll('.dc-model-row')).toHaveLength(0)
    expect(container.querySelector('form')).toBeNull()
    expect(container.querySelector('input[type="password"]')).toBeNull()
    act(() => { button('TTS 设置', container).click() })
    await act(async () => { await Promise.resolve() })
    expect(container.textContent).toContain('供应商：Model Link')
    keyValue(container, 'tts-ui-secret')
    await act(async () => { button('保存语音服务', container).click(); await Promise.resolve() })
    expect(save).toHaveBeenCalledWith({ endpoint: FISH_TTS_ENDPOINT, revision: 2, api_key: 'tts-ui-secret' })
    expect(imageSave).not.toHaveBeenCalled()
    expect(container.textContent).toContain('FishTTS')
    expect(container.textContent).not.toContain('tts-ui-secret')
  })
  it('resets an unsaved secret when changing provider and lists only the saved combination', async () => {
    const api = new CanvasApi(), list = models().map((model) => ({ ...model, has_api_key: false }))
    vi.spyOn(api, 'models').mockResolvedValue(list)
    vi.spyOn(api, 'ttsSettings').mockResolvedValue({ endpoint: FISH_TTS_ENDPOINT, revision: 0, configured: false, has_api_key: false, api_key_mask: '' })
    const save = vi.spyOn(api, 'saveModel').mockResolvedValue(list.map((model, index) => ({ ...model, has_api_key: index === 1 })))
    const container = mount(<ModelSettings api={api} />)
    await act(async () => { await Promise.resolve() })
    act(() => { button('＋ 配置模型', container).click() })
    choose(container, '配置模型', 'image:gpt-image-2.5-sunburst')
    expect(container.querySelector<HTMLSelectElement>('select[aria-label="配置供应商"]')!.value).toBe(BUILTIN_MODELS[0].api_base)
    keyValue(container, 'link-unsaved-secret')
    choose(container, '配置供应商', BUILTIN_MODELS[1].api_base)
    expect(container.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe('')
    expect(button('保存配置', container).disabled).toBe(true)
    keyValue(container, 'official-ui-secret')
    await act(async () => { button('保存配置', container).click(); await Promise.resolve() })
    expect(save).toHaveBeenCalledWith({ ...BUILTIN_MODELS[1], api_key: 'official-ui-secret' })
    expect(container.querySelectorAll('.dc-model-row')).toHaveLength(1)
    expect(container.querySelector('.dc-model-row small')!.textContent).toBe('OpenAI · 已配置')
    expect(container.querySelector('.dc-model-row')!.textContent).not.toContain('Flare')
  })
  it('clears only the selected provider while retaining the other configured channel in the summary', async () => {
    const api = new CanvasApi(), list = models()
    vi.spyOn(api, 'models').mockResolvedValue(list)
    vi.spyOn(api, 'ttsSettings').mockResolvedValue({ endpoint: FISH_TTS_ENDPOINT, revision: 0, configured: false, has_api_key: false, api_key_mask: '' })
    const save = vi.spyOn(api, 'saveModel').mockResolvedValue(list.map((model, index) => ({ ...model, has_api_key: index !== 0 })))
    const container = mount(<ModelSettings api={api} />)
    await act(async () => { await Promise.resolve() })
    act(() => { button('＋ 配置模型', container).click() })
    choose(container, '配置模型', 'image:gpt-image-2.5-sunburst')
    act(() => { container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click() })
    await act(async () => { button('保存配置', container).click(); await Promise.resolve() })
    expect(save).toHaveBeenCalledWith({ ...BUILTIN_MODELS[0], api_key: '' })
    expect(container.querySelector('.dc-model-row small')!.textContent).toBe('OpenAI · 已配置')
  })
})
