import { useId, type CSSProperties } from 'react'
import { sliderScale, type SliderOptions } from './sliderScale'

export interface UiSliderProps extends SliderOptions {
  onChange: (value: number) => void
  label: string
  disabled?: boolean
  showStops?: boolean
  showLabels?: boolean
  formatValue?: (value: number) => string
}

/** Controlled slider shared by Harness and standalone UI; values enables discrete stops. */
export function UiSlider({ onChange, label, disabled = false, showStops = false, showLabels = false,
  formatValue = String, ...options }: UiSliderProps) {
  const id = useId()
  const scale = sliderScale(options)
  const inactive = disabled || scale.fixed
  return <div className="dc-ui-slider nodrag nopan nowheel" data-disabled={inactive || undefined}
    onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}
    onKeyDown={(event) => { if (event.key !== 'Tab' && event.key !== 'Escape') event.stopPropagation() }}>
    <output htmlFor={id} className="dc-ui-slider-value">{formatValue(scale.current)}</output>
    <div className="dc-ui-slider-track" style={{ '--dc-slider-progress': `${scale.percent}%` } as CSSProperties}>
      <div className="dc-ui-slider-rail" aria-hidden="true">
        {showStops && scale.stops.map((stop) => <span key={stop.value} className="dc-ui-slider-stop" style={{ left: `${stop.percent}%` }} />)}
      </div>
      <input id={id} type="range" min={0} max={scale.intervals || 1} step={1} value={scale.index} disabled={inactive}
        aria-label={label} aria-valuemin={scale.start} aria-valuemax={scale.end}
        aria-valuenow={scale.current} aria-valuetext={formatValue(scale.current)}
        onChange={(event) => { if (!inactive) onChange(scale.toValue(Number(event.target.value))) }}
        onKeyDown={(event) => {
          const changes: Record<string, number> = { ArrowRight: scale.index + 1, ArrowUp: scale.index + 1,
            ArrowLeft: scale.index - 1, ArrowDown: scale.index - 1, Home: 0, End: scale.intervals,
            PageUp: scale.index + Math.max(1, Math.round(scale.intervals / 10)), PageDown: scale.index - Math.max(1, Math.round(scale.intervals / 10)) }
          if (!inactive && event.key in changes) { event.preventDefault(); onChange(scale.toValue(changes[event.key])) }
        }} />
    </div>
    <div className="dc-ui-slider-labels" aria-hidden="true">
      {(showLabels && scale.stops.length ? scale.stops : [
        { value: scale.start, percent: 0 }, ...(scale.fixed ? [] : [{ value: scale.end, percent: 100 }]),
      ]).map((stop) => <span key={stop.value} style={{ left: `${stop.percent}%` }}>{stop.value}</span>)}
    </div>
  </div>
}
