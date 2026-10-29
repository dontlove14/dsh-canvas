import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { PublicModel } from '../shared/contracts'
import { providerFor, modelConfigured } from '../shared/modelCatalog'
import { isMockModel } from '../shared/mockModels'
import { UiButton } from './ui'
import { useCanvasTextSelectionScope } from './canvasTextSelection'

/** Only configured real model-provider combinations are selectable. */
export function selectableModels(models: readonly PublicModel[]): PublicModel[] {
  return models.filter((model) => modelConfigured(model) && !isMockModel(model))
}

export function ModelPicker({ models, value, disabled, onChange }: {
  models: readonly PublicModel[]; value: string | null; disabled: boolean; onChange: (model: PublicModel) => void
}) {
  const textScope = useCanvasTextSelectionScope()
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ left: 12, top: 12 })
  const anchor = useRef<HTMLButtonElement>(null), popup = useRef<HTMLDivElement>(null)
  const id = useId()
  const options = selectableModels(models)
  const selected = options.find((model) => model.id === value)
  const groups = [...new Set(options.map((model) => model.model_id))]
  useEffect(() => { if (disabled || !options.length) setOpen(false) }, [disabled, options.length])
  useEffect(() => {
    if (!open) return
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect(), height = popup.current?.offsetHeight ?? 330
      if (rect) setPosition({ left: Math.max(12, Math.min(window.innerWidth - 352, rect.left)),
        top: Math.max(12, rect.top > height + 20 ? rect.top - height - 10 : Math.min(window.innerHeight - height - 12, rect.bottom + 10)) })
    }
    place(); popup.current?.querySelector<HTMLElement>('button[aria-pressed="true"],button')?.focus()
    const outside = (e: PointerEvent) => { if (!popup.current?.contains(e.target as Node) && !anchor.current?.contains(e.target as Node)) setOpen(false) }
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); anchor.current?.focus() } }
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape, true)
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true)
    return () => {
      document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape, true)
      window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true)
    }
  }, [open])
  return <>
    <UiButton ref={anchor} disabled={disabled || !options.length} className="dc-model-picker-trigger" aria-label="生成模型" aria-haspopup="dialog" aria-expanded={open}
      aria-controls={open ? id : undefined} onClick={() => setOpen((current) => !current)}>
      <span>{selected ? `${selected.name}${providerFor(selected) ? ` · ${providerFor(selected)!.label}` : ''}` : options.length ? '选择模型' : '请前往设置页面配置模型'}</span><span aria-hidden="true">⌄</span>
    </UiButton>
    {open && createPortal(<div ref={popup} id={id} role="dialog" aria-label="选择模型和供应商" className={`dc-overlay-scope dc-model-picker nodrag nopan nowheel ${textScope}`} style={position}
      onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}
      onBlur={(e) => { if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget)) setOpen(false) }}>
      {groups.map((modelId) => <fieldset key={modelId}><legend>{options.find((model) => model.model_id === modelId)!.name}</legend>
        {options.filter((model) => model.model_id === modelId).map((model) => <UiButton key={model.id} aria-pressed={value === model.id}
          onClick={() => { onChange(model); setOpen(false); anchor.current?.focus() }}>
          <span>{providerFor(model)?.label ?? model.name}{providerFor(model)?.id === 'model-link' ? ' · 默认' : ''}</span>
          <small>已配置</small>
        </UiButton>)}
      </fieldset>)}
      {!options.length && <p className="dc-muted">请前往设置页面配置模型</p>}
    </div>, document.body)}
  </>
}
