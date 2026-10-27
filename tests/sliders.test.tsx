// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UiSlider, type UiSliderProps } from '../src/client/UiSlider'
import { sliderScale } from '../src/client/sliderScale'
import { GenerationParameters } from '../src/client/GenerationParameters'
import { defaultParams, type GenerationParams, type PublicModel } from '../src/shared/contracts'
import { MOCK_MODELS } from '../src/shared/mockModels'

const roots: Root[] = []
afterEach(() => {
  act(() => { roots.splice(0).forEach((root) => root.unmount()) })
  document.body.replaceChildren(); vi.unstubAllGlobals()
})
function mount(element: React.ReactNode) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container); roots.push(root); act(() => root.render(element))
  return container
}
function key(input: HTMLInputElement, name: string) {
  act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })) })
}
function inputValue(input: HTMLInputElement, value: number) {
  // Use the native setter to exercise React's actual range change event path.
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, String(value))
  act(() => { input.dispatchEvent(new Event('input', { bubbles: true })) })
}
function Stateful(props: Omit<UiSliderProps, 'onChange'> & { onValue?: (value: number) => void }) {
  const [value, setValue] = useState(props.value)
  return <UiSlider {...props} value={value} onChange={(next) => { setValue(next); props.onValue?.(next) }} />
}
function Parameters({ model, onValue }: { model: PublicModel; onValue: (params: GenerationParams) => void }) {
  const [params, setParams] = useState(defaultParams(model))
  return <GenerationParameters model={model} params={params} disabled={false} onChange={(next) => { setParams(next); onValue(next) }} />
}
describe('shared sliders and generation parameter integration', () => {
  it('snaps only to uneven allowed values, sorts/deduplicates and exposes actual accessible values', () => {
    const changed = vi.fn(), canvasKey = vi.fn()
    const container = mount(<Stateful value={4} values={[10, 4, 8, 8]} label="时长" showStops showLabels formatValue={(n) => `${n}秒`} onValue={changed} />)
    const input = container.querySelector('input')!
    expect(container.querySelectorAll('.dc-ui-slider-stop')).toHaveLength(3)
    expect(input.getAttribute('aria-valuemin')).toBe('4'); expect(input.getAttribute('aria-valuemax')).toBe('10')
    window.addEventListener('keydown', canvasKey)
    key(input, 'ArrowRight'); expect(changed).toHaveBeenLastCalledWith(8)
    key(input, 'ArrowRight'); expect(changed).toHaveBeenLastCalledWith(10)
    key(input, 'Home'); expect(changed).toHaveBeenLastCalledWith(4)
    key(input, 'End'); expect(input.getAttribute('aria-valuetext')).toBe('10秒')
    key(input, 'ArrowLeft'); expect(input.getAttribute('aria-valuenow')).toBe('8')
    window.removeEventListener('keydown', canvasKey); expect(canvasKey).not.toHaveBeenCalled()
    inputValue(input, 0); expect(changed).toHaveBeenLastCalledWith(4)
    inputValue(input, 2); expect(changed).toHaveBeenLastCalledWith(10)
  })
  it('supports continuous ranges without stops, stepped stops, floating values and disabled single choices', () => {
    const container = mount(<Stateful label="区间" value={0} min={0} max={12} step={1} />)
    const input = container.querySelector('input')!
    expect(container.querySelectorAll('.dc-ui-slider-stop')).toHaveLength(0)
    inputValue(input, 7); expect(input.getAttribute('aria-valuenow')).toBe('7')
    key(input, 'End'); expect(input.getAttribute('aria-valuenow')).toBe('12')
    key(input, 'PageDown'); expect(input.getAttribute('aria-valuenow')).toBe('11')
    const decimal = sliderScale({ value: .3, min: .1, max: .6, step: .1 })
    expect(decimal.current).toBe(.3); expect(decimal.toValue(5)).toBe(.6)
    const stepped = mount(<Stateful label="步长" value={20} min={0} max={100} step={10} showStops />)
    expect(stepped.querySelectorAll('.dc-ui-slider-stop')).toHaveLength(11)
    const changed = vi.fn()
    const fixed = mount(<Stateful label="数量" value={1} values={[1]} onValue={changed} />).querySelector('input')!
    expect(fixed.disabled).toBe(true); key(fixed, 'End'); expect(changed).not.toHaveBeenCalled()
    const disabled = mount(<Stateful label="禁用" value={1} min={1} max={10} disabled onValue={changed} />).querySelector('input')!
    key(disabled, 'End'); expect(changed).not.toHaveBeenCalled()
  })
  it.each([0, 1, 2, 3])('uses 1–10 stops and preserves size/count while changing duration for preset %s', (index) => {
    const model = MOCK_MODELS[index], changed = vi.fn()
    const container = mount(<Parameters model={model} onValue={changed} />)
    act(() => { container.querySelector('button')!.click() })
    const popup = document.querySelector('[role="dialog"]')!
    const quantity = popup.querySelector<HTMLInputElement>('input[aria-label="生成数量"]')!
    expect(quantity.parentElement?.parentElement?.querySelectorAll('.dc-ui-slider-stop')).toHaveLength(10)
    key(quantity, 'End'); expect(changed).toHaveBeenLastCalledWith({ ...defaultParams(model), n: 10 })
    const duration = popup.querySelector<HTMLInputElement>('input[aria-label="视频时长"]')
    if (model.kind === 'video') {
      const discrete = !model.capabilities.secondsRange
      expect(duration!.parentElement?.parentElement?.querySelectorAll('.dc-ui-slider-stop')).toHaveLength(discrete ? 3 : 0)
      inputValue(duration!, discrete ? 1 : 7)
      expect(changed).toHaveBeenLastCalledWith({ ...defaultParams(model), n: 10, seconds: discrete ? 8 : 7 })
    } else expect(duration).toBeNull()
  })
})
