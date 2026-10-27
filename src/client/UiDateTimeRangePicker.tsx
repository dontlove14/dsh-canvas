import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { UiButton, UiInput } from './ui'
import { calendarDays, dateText, timeText, rangeFromFields, type DateTimeRange } from './dateTimeRange'

export interface UiDateTimeRangePickerProps {
  value: DateTimeRange; onChange: (value: DateTimeRange) => void; label?: string; disabled?: boolean
}
const weekdays = ['日', '一', '二', '三', '四', '五', '六']
export function UiDateTimeRangePicker({ value, onChange, label = '时间范围', disabled }: UiDateTimeRangePickerProps) {
  const [open, setOpen] = useState(false)
  const [fields, setFields] = useState({ startDate: '', startTime: '00:00:00', endDate: '', endTime: '23:59:59' })
  const [active, setActive] = useState<'start' | 'end'>('start')
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1))
  const [error, setError] = useState('')
  const [position, setPosition] = useState({ left: 12, top: 12, width: 650 })
  const trigger = useRef<HTMLButtonElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const id = useId()
  const close = () => { setOpen(false); trigger.current?.focus() }
  const show = () => {
    const start = value.start === undefined ? null : new Date(value.start)
    const end = value.end === undefined ? null : new Date(value.end)
    setFields({ startDate: start ? dateText(start) : '', startTime: start ? timeText(start) : '00:00:00',
      endDate: end ? dateText(end) : '', endTime: end ? timeText(end) : '23:59:59' })
    const initial = start ?? end ?? new Date()
    setMonth(new Date(initial.getFullYear(), initial.getMonth(), 1)); setActive('start'); setError(''); setOpen(true)
  }
  useEffect(() => { if (disabled) setOpen(false) }, [disabled])
  useLayoutEffect(() => {
    if (!open) return
    const locate = () => {
      const rect = trigger.current?.getBoundingClientRect()
      if (!rect) return
      const width = Math.min(650, window.innerWidth - 24)
      const height = popup.current?.getBoundingClientRect().height ?? 410
      setPosition({ width, left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
        top: Math.max(12, Math.min(rect.bottom + 8 + height <= window.innerHeight - 12 ? rect.bottom + 8 : rect.top - height - 8, window.innerHeight - height - 12)) })
    }
    locate()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(locate)
    if (popup.current) observer?.observe(popup.current)
    window.addEventListener('resize', locate); window.addEventListener('scroll', locate, true)
    popup.current?.querySelector<HTMLInputElement>('input')?.focus()
    const outside = (event: PointerEvent) => {
      if (!popup.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false)
    }
    // Capture before the enclosing modal handles Escape.
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close() }
    }
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape, true)
    return () => {
      observer?.disconnect(); window.removeEventListener('resize', locate); window.removeEventListener('scroll', locate, true)
      document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape, true)
    }
  }, [open])
  const shift = (offset: number) => setMonth((old) => new Date(old.getFullYear(), old.getMonth() + offset, 1))
  const choose = (day: string) => {
    setError('')
    if (active === 'start' || (fields.startDate && day < fields.startDate)) {
      setFields((old) => ({ ...old, startDate: day, endDate: old.endDate && old.endDate < day ? '' : old.endDate })); setActive('end')
    } else { setFields((old) => ({ ...old, endDate: day })); setActive('start') }
  }
  const keyboard = (event: KeyboardEvent<HTMLButtonElement>, day: Date) => {
    const target = new Date(day)
    const step = ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 } as Record<string, number>)[event.key]
    if (step) target.setDate(target.getDate() + step)
    else if (event.key === 'Home') target.setDate(target.getDate() - target.getDay())
    else if (event.key === 'End') target.setDate(target.getDate() + 6 - target.getDay())
    else if (event.key === 'PageUp' || event.key === 'PageDown') {
      const wanted = target.getDate()
      target.setDate(1); target.setMonth(target.getMonth() + (event.key === 'PageUp' ? -1 : 1))
      target.setDate(Math.min(wanted, new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate()))
    } else return
    event.preventDefault()
    const last = new Date(month.getFullYear(), month.getMonth() + 2, 0)
    if (target < month || target > last) setMonth(new Date(target.getFullYear(), target.getMonth(), 1))
    requestAnimationFrame(() => popup.current?.querySelector<HTMLButtonElement>(`button[data-date="${dateText(target)}"][data-in-month="true"]`)?.focus())
  }
  const commit = () => {
    try { onChange(rangeFromFields(fields.startDate, fields.startTime, fields.endDate, fields.endTime)); close() }
    catch (reason) { setError(reason instanceof Error ? reason.message : '时间无效') }
  }
  const display = (stamp: number | undefined, placeholder: string) => stamp === undefined ? placeholder : `${dateText(new Date(stamp))} ${timeText(new Date(stamp))}`
  const portal = trigger.current?.closest('.dc-native-modal,dialog') ?? document.body
  return <span className="dc-datetime-picker">
    <UiButton ref={trigger} variant="outline" className="dc-datetime-trigger" disabled={disabled} aria-label={label}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => open ? close() : show()}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M7 2v6m10-6v6M3 11h18" /></svg>
      <span className={value.start === undefined ? 'placeholder' : ''}>{display(value.start, '开始时间')}</span>
      <span>至</span><span className={value.end === undefined ? 'placeholder' : ''}>{display(value.end, '结束时间')}</span>
    </UiButton>
    {open && createPortal(<div id={id} ref={popup} role="dialog" aria-label={`${label}选择器`}
      className="dc-overlay-scope dc-datetime-popup" style={position}>
      <div className="dc-datetime-fields">
        <UiInput type="date" aria-label="开始日期" value={fields.startDate} min="1970-01-01" max="9999-12-31" onFocus={() => setActive('start')} onChange={(event) => { setError(''); setFields({ ...fields, startDate: event.target.value }) }} />
        <UiInput type="time" step="1" aria-label="开始时刻" value={fields.startTime} onFocus={() => setActive('start')} onChange={(event) => { setError(''); setFields({ ...fields, startTime: event.target.value }) }} />
        <span aria-hidden="true">›</span>
        <UiInput type="date" aria-label="结束日期" value={fields.endDate} min="1970-01-01" max="9999-12-31" onFocus={() => setActive('end')} onChange={(event) => { setError(''); setFields({ ...fields, endDate: event.target.value }) }} />
        <UiInput type="time" step="1" aria-label="结束时刻" value={fields.endTime} onFocus={() => setActive('end')} onChange={(event) => { setError(''); setFields({ ...fields, endTime: event.target.value }) }} />
      </div>
      <div className="dc-datetime-calendars">{[0, 1].map((offset) => {
        const current = new Date(month.getFullYear(), month.getMonth() + offset, 1)
        return <section className="dc-datetime-calendar" key={offset} aria-label={`${current.getFullYear()}年${current.getMonth() + 1}月`}>
          <header>
            {offset === 0 ? <span><UiButton aria-label="上一年" onClick={() => shift(-12)}>«</UiButton><UiButton aria-label="上一月" onClick={() => shift(-1)}>‹</UiButton></span> : <span />}
            <strong>{current.getFullYear()} 年 {current.getMonth() + 1} 月</strong>
            {offset === 1 ? <span><UiButton aria-label="下一月" onClick={() => shift(1)}>›</UiButton><UiButton aria-label="下一年" onClick={() => shift(12)}>»</UiButton></span> : <span />}
          </header>
          <div className="dc-calendar-weekdays" aria-hidden="true">{weekdays.map((name) => <span key={name}>{name}</span>)}</div>
          <div className="dc-calendar-days">{calendarDays(current).map((day) => {
            const text = dateText(day); const own = day.getMonth() === current.getMonth()
            const endpoint = text === fields.startDate || text === fields.endDate
            const between = fields.startDate && fields.endDate && text > fields.startDate && text < fields.endDate
            return <button type="button" key={text} data-date={text} data-in-month={own} aria-label={text}
              aria-pressed={endpoint} aria-current={text === dateText(new Date()) ? 'date' : undefined}
              tabIndex={own && (text === fields[`${active}Date`] || (!fields[`${active}Date`] && day.getDate() === 1)) ? 0 : -1}
              className={`${own ? '' : 'outside'} ${endpoint ? 'endpoint' : ''} ${between ? 'in-range' : ''}`}
              onClick={() => choose(text)} onKeyDown={(event) => keyboard(event, day)}>{day.getDate()}</button>
          })}</div>
        </section>
      })}</div>
      <footer>{error && <span role="alert">{error}</span>}<span className="dc-datetime-hint">可只选择开始或结束时间</span>
        <UiButton className="dc-link-button" onClick={() => { onChange({}); close() }}>清空</UiButton>
        <UiButton variant="outline" onClick={commit}>确定</UiButton>
      </footer>
    </div>, portal)}
  </span>
}
