export interface SliderOptions {
  value: number
  min?: number
  max?: number
  step?: number
  /** Uneven allowed values are mapped to equally spaced native range positions. */
  values?: readonly number[]
}

const clean = (value: number) => Number(value.toFixed(12))
export function sliderScale({ value, min = 0, max = 100, step = 1, values }: SliderOptions) {
  const discrete = values !== undefined
  const choices = [...new Set(values?.filter(Number.isFinite) ?? [])].sort((a, b) => a - b)
  const validRange = Number.isFinite(min) && Number.isFinite(max) && max >= min && Number.isFinite(step) && step > 0
  const start = discrete ? choices[0] ?? 0 : validRange ? min : 0
  const intervals = discrete ? Math.max(0, choices.length - 1)
    : validRange ? Math.floor((max - min) / step + 1e-9) : 0
  const end = discrete ? choices.at(-1) ?? start : clean(start + intervals * step)
  const nearest = discrete
    ? choices.reduce((best, item, index) => Math.abs(item - value) < Math.abs(choices[best] - value) ? index : best, 0)
    : Math.max(0, Math.min(intervals, Math.round((value - start) / step)))
  const index = Number.isFinite(value) ? nearest : 0
  const toValue = (position: number) => {
    const next = Math.max(0, Math.min(intervals, Math.round(Number.isFinite(position) ? position : 0)))
    return discrete ? choices[next] ?? start : clean(start + next * step)
  }
  // Native range works in step indices, so floats and uneven choices never drift.
  const stops = intervals <= 200 ? Array.from({ length: intervals + 1 }, (_, i) => ({ value: toValue(i), percent: intervals ? i / intervals * 100 : 0 })) : []
  return { start, end, intervals, index, current: toValue(index), toValue, stops,
    percent: intervals ? index / intervals * 100 : 0, fixed: intervals === 0 }
}
