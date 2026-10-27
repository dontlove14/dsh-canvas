import { useEffect, useRef, useState } from 'react'

export interface UiNumberCounterProps {
  label: string; value: number; onChange: (value: number) => void
  step?: number; precision?: number; min?: number; max?: number; disabled?: boolean
}
/** Editable controlled counter; rounding prevents accumulated floating point drift. */
export function UiNumberCounter({ label, value, onChange, step = 1, precision = 2, min = -Infinity, max = Infinity, disabled = false }: UiNumberCounterProps) {
  const format = (next: number) => next.toFixed(precision)
  const [draft, setDraft] = useState(() => format(value))
  const [editing, setEditing] = useState(false)
  const cancelled = useRef(false)
  useEffect(() => { if (!editing) setDraft(format(value)) }, [value, precision, editing])
  const normalize = (next: number) => Number(Math.max(min, Math.min(max, next)).toFixed(precision))
  const change = (delta: number) => {
    if (disabled) return
    const next = normalize(value + delta)
    if (Number.isFinite(next)) { onChange(next); setDraft(format(next)) }
  }
  const commit = () => {
    if (disabled || cancelled.current) { cancelled.current = false; setDraft(format(value)); setEditing(false); return }
    const next = Number(draft)
    if (draft.trim() && Number.isFinite(next)) { const bounded = normalize(next); onChange(bounded); setDraft(format(bounded)) }
    else setDraft(format(value))
    setEditing(false)
  }
  return <div className="dc-ui-counter nodrag nopan" data-disabled={disabled || undefined}
    onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
    <button type="button" disabled={disabled || value <= min} aria-label={`减少${label}`} onClick={() => change(-step)}>−</button>
    <input type="text" inputMode="decimal" role="spinbutton" aria-label={label} aria-valuenow={value}
      aria-valuemin={Number.isFinite(min) ? min : undefined} aria-valuemax={Number.isFinite(max) ? max : undefined}
      value={draft} disabled={disabled} onFocus={() => { cancelled.current = false; setEditing(true) }} onBlur={commit} onChange={(event) => {
        const raw = event.target.value; setDraft(raw)
        const next = Number(raw)
        if (raw.trim() && Number.isFinite(next) && next >= min && next <= max) onChange(normalize(next))
      }} onKeyDown={(event) => {
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); change(event.key === 'ArrowUp' ? step : -step) }
        if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() }
        if (event.key === 'Escape') { event.preventDefault(); cancelled.current = true; setDraft(format(value)); setEditing(false); event.currentTarget.blur() }
      }} />
    <button type="button" disabled={disabled || value >= max} aria-label={`增加${label}`} onClick={() => change(step)}>＋</button>
  </div>
}
