import {
  createContext, forwardRef, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState,
  type ButtonHTMLAttributes, type ComponentProps, type CSSProperties, type InputHTMLAttributes, type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import type * as Primitives from '@deepseek-ai/dsh-client-ui-primitives'
import { useCanvasTextSelectionScope } from './canvasTextSelection'
export { UiSlider } from './UiSlider'
export { UiDateTimeRangePicker } from './UiDateTimeRangePicker'
export { UiPagination } from './UiPagination'

// Only the Harness entry imports the runtime. Standalone development has no
// platform module loader and uses semantic HTML with the same token families.
type HarnessUi = Pick<typeof Primitives, 'Button' | 'Input' | 'Checkbox' | 'SegmentedControl' | 'Menu' | 'Modal' | 'Tooltip'>
const UiContext = createContext<HarnessUi | null>(null)
export function HarnessUiProvider({ components, children }: { components: HarnessUi; children: ReactNode }) {
  return <UiContext.Provider value={components}>{children}</UiContext.Provider>
}

export const UiButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Primitives.ButtonVariant; size?: 'md' | 'sm'
}>(function UiButton({ variant = 'ghost', size = 'sm', className = '', type = 'button', ...props }, ref) {
  const ui = useContext(UiContext)
  return ui
    ? <ui.Button {...props} ref={ref} type={type} variant={variant} size={size} className={className} data-dc-ui="native" />
    : <button {...props} ref={ref} type={type} className={`dc-ui-button ${variant} ${size} ${className}`} />
})

export const UiInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function UiInput({ className = '', ...props }, ref) {
  const ui = useContext(UiContext)
  return ui
    ? <span className={`dc-ui-input ${className}`} data-dc-ui="native"><ui.Input {...props} ref={ref} /></span>
    : <input {...props} ref={ref} className={`dc-ui-input ${className}`} />
})

export function UiHelp({ label, description }: { label: string; description: string }) {
  const ui = useContext(UiContext)
  const id = useId()
  const anchor = <UiButton className="dc-ui-help-button" aria-label={label} aria-describedby={ui?.Tooltip ? undefined : id}>
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" /><path d="M9.6 9a2.4 2.4 0 0 1 4.8 0c0 1.8-2.4 1.8-2.4 3.6M12 16h.01" />
    </svg>
  </UiButton>
  return ui?.Tooltip ? <ui.Tooltip label={description} portal side="top" maxWidth={320} delayMs={120} openOnClick>{anchor}</ui.Tooltip>
    : <span className="dc-ui-help">{anchor}<span id={id} role="tooltip" className="dc-ui-help-text">{description}</span></span>
}

export function UiCheckbox(props: ComponentProps<typeof Primitives.Checkbox>) {
  const ui = useContext(UiContext)
  return ui
    ? <span data-dc-ui="native" className="dc-ui-checkbox"><ui.Checkbox {...props} /></span>
    : <label className="dc-checkbox"><input type="checkbox" checked={props.checked} disabled={props.disabled} onChange={(event) => props.onChange(event.target.checked)} />{props.label}</label>
}

interface Choice { value: string; label: string; disabled?: boolean; disabledReason?: string }
export function UiSelect({ value, options, onChange, label, disabled, className = '', side = 'bottom', placeholder = '请选择' }: {
  value: string | number | undefined; options: readonly Choice[]; onChange: (value: string) => void
  label: string; disabled?: boolean; className?: string; side?: 'top' | 'bottom'; placeholder?: string
}) {
  const ui = useContext(UiContext)
  const textScope = useCanvasTextSelectionScope()
  const [open, setOpen] = useState(false)
  const selected = String(value ?? '')
  const text = options.find((option) => option.value === selected)?.label ?? placeholder
  const choose = (next: string) => {
    if (disabled || !options.some((option) => option.value === next && !option.disabled)) return
    setOpen(false); onChange(next)
  }
  useEffect(() => { if (disabled) setOpen(false) }, [disabled])
  if (!ui) return <select className={`dc-ui-select ${className}`} aria-label={label} value={selected} disabled={disabled} onChange={(event) => choose(event.target.value)}>
    {!options.some((option) => option.value === selected) && <option value="" disabled hidden>{placeholder}</option>}
    {options.map((option) => <option key={option.value} value={option.value} disabled={option.disabled} title={option.disabledReason}>{option.label}</option>)}
  </select>
  return <span className={`dc-ui-select ${className}`} data-dc-ui="native">
    <ui.Menu open={open && !disabled} portal autoFocus selectedId={selected} side={side}
      className="dc-ui-select-anchor" listClassName={`dc-ui-popup ${textScope}`}
      anchor={<ui.Button type="button" variant="outline" size="sm" disabled={disabled}
        className="dc-ui-select-trigger" aria-label={`${label}：${text}`} aria-haspopup="menu" aria-expanded={open && !disabled}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true) } }}>
        <span className="dc-ui-select-value">{text}</span><span aria-hidden="true">⌄</span>
      </ui.Button>}
      items={options.map((option) => ({ id: option.value, label: option.disabledReason
        ? <span className="dc-ui-select-option" title={option.disabledReason}>{option.label}</span> : option.label, disabled: option.disabled }))}
      onSelect={choose} onClose={() => setOpen(false)} />
  </span>
}

export function UiSegments({ id, value, options, onChange, label, disabled }: {
  id: string; value: string; options: readonly Choice[]; onChange: (value: string) => void; label: string; disabled?: boolean
}) {
  const ui = useContext(UiContext)
  if (ui) return <div className="dc-ui-segments" data-dc-ui="native"><ui.SegmentedControl id={id} value={value} options={options} onChange={onChange} label={label} disabled={disabled} /></div>
  return <div className="dc-tabs" role="tablist" aria-label={label}>
    {options.map((option, index) => <button key={option.value} id={`${id}-${option.value}`} type="button" role="tab"
      tabIndex={value === option.value ? 0 : -1} aria-controls={`${id}-${option.value}-panel`} aria-selected={value === option.value}
      disabled={disabled || option.disabled} onClick={() => onChange(option.value)}
      onKeyDown={(event) => {
        const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
        if (!step || disabled) return
        event.preventDefault()
        const next = options[(index + step + options.length) % options.length]
        if (!next.disabled) { onChange(next.value); document.getElementById(`${id}-${next.value}`)?.focus() }
      }}>{option.label}</button>)}
  </div>
}

export interface UiAction { id: string; label: ReactNode; icon?: ReactNode; disabled?: boolean; danger?: boolean; onSelect: () => void }
export function UiActionMenu({ label, children = '⋯', items, disabled, side = 'bottom', variant = 'ghost', gap = 4 }: {
  label: string; children?: ReactNode; items: readonly UiAction[]; disabled?: boolean
  side?: 'top' | 'bottom'; variant?: Primitives.ButtonVariant; gap?: number
}) {
  const ui = useContext(UiContext)
  const textScope = useCanvasTextSelectionScope()
  const [open, setOpen] = useState(false)
  const wrapper = useRef<HTMLSpanElement>(null)
  const getAnchorRect = useCallback(() => {
    const rect = wrapper.current?.querySelector('button')?.getBoundingClientRect()
    if (!rect) return null
    // The public Menu applies its own 4px gap, then clamps to the viewport.
    return new DOMRect(rect.x, rect.y + (side === 'top' ? 4 - gap : gap - 4), rect.width, rect.height)
  }, [gap, side])
  useEffect(() => { if (disabled) setOpen(false) }, [disabled])
  useEffect(() => {
    if (ui || !open) return
    const outside = (event: PointerEvent) => { if (!wrapper.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [ui, open])
  const trigger = <UiButton variant={variant} aria-label={label} aria-haspopup="menu" aria-expanded={open && !disabled} disabled={disabled} onClick={() => setOpen((current) => !current)}>{children}</UiButton>
  if (ui) return <span ref={wrapper} data-dc-ui="native"><ui.Menu open={open && !disabled} anchor={trigger} items={items} portal autoFocus side={side} align="end"
    getAnchorRect={gap === 4 ? undefined : getAnchorRect}
    listClassName={`dc-ui-popup ${textScope}`} onClose={() => setOpen(false)} onSelect={(id) => { setOpen(false); items.find((item) => item.id === id)?.onSelect() }} /></span>
  return <span ref={wrapper} className="dc-ui-action-menu" style={{ '--dc-action-menu-gap': `${gap}px` } as CSSProperties} onKeyDown={(event) => {
    if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); wrapper.current?.querySelector('button')?.focus() }
  }}>{trigger}{open && !disabled && <span role="menu" className={`dc-ui-action-list ${side}`}>
    {items.map((item) => <button key={item.id} type="button" role="menuitem" disabled={item.disabled} className={item.danger ? 'danger' : ''}
      onClick={() => { setOpen(false); item.onSelect(); wrapper.current?.querySelector('button')?.focus() }}>{item.icon}{item.label}</button>)}
  </span>}</span>
}

export function pointMenuPosition(point: { x: number; y: number }, bounds: DOMRect, size: { width: number; height: number }) {
  const left = Math.max(12, bounds.left + 8), top = Math.max(12, bounds.top + 8)
  return {
    x: Math.max(left, Math.min(point.x, Math.min(window.innerWidth - 12, bounds.right - 8) - size.width)),
    y: Math.max(top, Math.min(point.y, Math.min(window.innerHeight - 12, bounds.bottom - 8) - size.height)),
  }
}

/** Harness Menu anchored to a canvas point rather than a visible trigger. */
export function UiPointMenu({ label, point, bounds, items, onClose, onSelect }: {
  label: string; point: { x: number; y: number }; bounds: () => DOMRect | undefined
  items: readonly (UiAction & { disabledReason?: string })[]
  onClose: () => void; onSelect: (id: string) => void
}) {
  const ui = useContext(UiContext), textScope = useCanvasTextSelectionScope()
  const id = `dc-point-${useId().replace(/:/g, '')}`
  const getAnchorRect = useCallback(() => {
    const rect = bounds()
    if (!rect) return null
    const list = document.querySelector<HTMLElement>(`.${id}`)
    const position = pointMenuPosition(point, rect, { width: list?.offsetWidth || 208, height: list?.offsetHeight || 158 })
    return new DOMRect(position.x, position.y - 4, 0, 0)
  }, [bounds, id, point])
  const entries = items.map((item) => ({ ...item, label: <span title={item.disabledReason}>{item.label}</span> }))
  const className = `dc-ui-popup dc-node-creation-menu nodrag nopan nowheel ${textScope} ${id}`
  const choose = (value: string) => { if (items.some((item) => item.id === value && !item.disabled)) onSelect(value) }
  return ui ? <ui.Menu open anchor={null} portal autoFocus side="bottom" align="start" getAnchorRect={getAnchorRect}
    items={[{ type: 'label', id: 'creation-title', text: label }, ...entries]}
    listClassName={className} onClose={onClose} onSelect={choose} />
    : <StandalonePointMenu label={label} className={className} items={entries} getAnchorRect={getAnchorRect} choose={choose} onClose={onClose} />
}

function StandalonePointMenu({ label, className, items, getAnchorRect, choose, onClose }: {
  label: string; className: string; items: readonly UiAction[]; getAnchorRect: () => DOMRect | null
  choose: (id: string) => void; onClose: () => void
}) {
  const list = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const place = () => {
      const rect = getAnchorRect()
      if (rect && list.current) { list.current.style.left = `${rect.x}px`; list.current.style.top = `${rect.y + 4}px` }
    }
    place(); list.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [getAnchorRect])
  return createPortal(<div ref={list} role="menu" aria-label={label} className={`${className} dc-point-menu-fallback`} onKeyDown={(event) => {
    event.stopPropagation()
    const buttons = [...list.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []]
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (event.key === 'Escape' || (event.key === 'Tab' && event.shiftKey)) { event.preventDefault(); onClose() }
    else if (event.key === 'Tab' || event.key === 'Enter') { event.preventDefault(); buttons[index]?.click() }
    else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
      buttons[next]?.focus()
    }
  }}><div className="dc-point-menu-heading">{label}</div>
    {items.map((item) => <button key={item.id} type="button" role="menuitem" disabled={item.disabled} onClick={() => choose(item.id)}>{item.icon}{item.label}</button>)}
  </div>, document.body)
}

export function UiModal({ label, onClose, children, wide = false, className = '' }: {
  label: string; onClose: () => void; children: ReactNode; wide?: boolean; className?: string
}) {
  const ui = useContext(UiContext)
  return ui
    ? <ui.Modal open title={label} closeLabel="关闭" onClose={onClose} className={`dc-overlay-scope dc-native-modal ${wide ? 'wide' : ''} ${className}`} contentClassName="dc-ui-modal-content">
      {children}
    </ui.Modal>
    : <StandaloneModal label={label} onClose={onClose} wide={wide} className={className}>{children}</StandaloneModal>
}
export function UiMediaModal({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  const ui = useContext(UiContext)
  const content = <div className="dc-media-stage" onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <UiButton className="dc-media-close" aria-label="关闭预览" title="关闭预览" data-modal-autofocus onClick={onClose}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6" /></svg>
    </UiButton>
    {children}
  </div>
  return ui
    ? <ui.Modal open headless title={label} onClose={onClose} backdropBlur={false} className="dc-overlay-scope dc-media-modal">{content}</ui.Modal>
    : <StandaloneModal label={label} onClose={onClose} wide={false} headless className="dc-media-modal">{content}</StandaloneModal>
}
function StandaloneModal({ label, onClose, children, wide, className, headless = false }: {
  label: string; onClose: () => void; children: ReactNode; wide: boolean; className: string; headless?: boolean
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close() }, [])
  return <dialog ref={dialog} className={`dc-modal ${wide ? 'wide' : ''} ${className}`} aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); onClose() }}>
    <h2 id={titleId} className="dc-sr-only">{label}</h2>
    {!headless && <button type="button" className="dc-modal-close" aria-label="关闭" onClick={onClose}>×</button>}{children}
  </dialog>
}
