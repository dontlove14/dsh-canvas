import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { GenerationParams, PublicModel } from '../shared/contracts'
import { chooseResolution, paramsSummary, sizeChoices } from './generationParams'
import { UiButton, UiSlider } from './ui'

export function GenerationParameters({ model, params, disabled, onChange }: { model: PublicModel; params: GenerationParams; disabled: boolean; onChange: (params: GenerationParams) => void }) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: 0, top: 0 })
  const id = useId()
  const choices = sizeChoices(model)
  const current = choices.find((choice) => choice.size === params.size)
  useEffect(() => { setOpen(false) }, [model.id, disabled])
  useEffect(() => {
    if (!open) return
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect()
      const height = popup.current?.offsetHeight ?? 380
      const width = popup.current?.offsetWidth ?? 320
      if (rect) setPosition({ left: Math.max(12, Math.min(window.innerWidth - width - 12, rect.left)),
        top: Math.max(12, rect.top >= height + 20 ? rect.top - height - 10 : Math.min(window.innerHeight - height - 12, rect.bottom + 10)) })
    }
    place()
    popup.current?.querySelector<HTMLElement>('[aria-pressed="true"]')?.focus()
    const outside = (event: PointerEvent) => {
      if (!popup.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus() } }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape, true)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape, true); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [open])
  return <>
    <UiButton ref={trigger} className="dc-params-trigger" disabled={disabled} aria-label={`生成参数：${paramsSummary(model, params)}`} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => setOpen((value) => !value)}><span className="dc-ratio-mini" aria-hidden="true" />{paramsSummary(model, params)}<span aria-hidden="true">{open ? '⌃' : '⌄'}</span></UiButton>
    {open && createPortal(<div ref={popup} id={id} role="dialog" aria-label="生成参数" className="dc-overlay-scope dc-generation-params nodrag nopan nowheel"
      style={position} onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()} onBlur={(event) => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpen(false) }}>
      <fieldset><legend>分辨率</legend><div className="dc-param-options">
        {[...new Set(choices.map((choice) => choice.resolution))].map((resolution) => <UiButton key={resolution} aria-pressed={current?.resolution === resolution}
          onClick={() => onChange({ ...params, size: chooseResolution(choices, params.size, resolution) })}>{resolution}</UiButton>)}
      </div></fieldset>
      <fieldset><legend>比例</legend><div className="dc-ratio-options">
        {[...new Map(choices.filter((choice) => choice.resolution === current?.resolution).map((choice) => [choice.ratio, choice])).values()].map((choice) =>
          <UiButton key={choice.ratio} aria-pressed={params.size === choice.size} title={choice.size} onClick={() => onChange({ ...params, size: choice.size })}>
            <span className="dc-ratio-shape" style={{ width: Math.max(7, Math.round(18 * Math.min(1, choice.width / choice.height))), height: Math.max(7, Math.round(18 * Math.min(1, choice.height / choice.width))) }} />
            {choice.ratio}
          </UiButton>)}
      </div></fieldset>
      <fieldset><legend>生成数量</legend>
        <UiSlider label="生成数量" value={params.n} values={model.capabilities.counts} showStops showLabels disabled={disabled}
          formatValue={(count) => `${count}${model.kind === 'image' ? '张' : '条'}`} onChange={(n) => onChange({ ...params, n })} />
      </fieldset>
      {(model.capabilities.secondsRange || !!model.capabilities.seconds.length) && <fieldset><legend>时长</legend>
        <UiSlider label="视频时长" value={params.seconds ?? model.capabilities.secondsRange?.min ?? model.capabilities.seconds[0]}
          {...model.capabilities.secondsRange} values={model.capabilities.secondsRange ? undefined : model.capabilities.seconds}
          showStops={!model.capabilities.secondsRange} showLabels={!model.capabilities.secondsRange} disabled={disabled}
          formatValue={(seconds) => `${seconds}秒`} onChange={(seconds) => onChange({ ...params, seconds })} />
      </fieldset>}
    </div>, document.body)}
  </>
}
