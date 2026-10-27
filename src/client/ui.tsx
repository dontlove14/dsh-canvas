import {
  createContext, forwardRef, useCallback, useContext, useEffect, useId, useRef, useState,
  type ButtonHTMLAttributes, type ComponentProps, type CSSProperties, type InputHTMLAttributes, type ReactNode,
} from 'react'
import type * as Primitives from '@deepseek-ai/dsh-client-ui-primitives'
export { UiSlider } from './UiSlider'
export { UiDateTimeRangePicker } from './UiDateTimeRangePicker'
export { UiPagination } from './UiPagination'

// Only the Harness entry imports the runtime. Standalone development has no
// platform module loader and uses semantic HTML with the same token families.
type HarnessUi = Pick<typeof Primitives, 'Button' | 'Input' | 'Checkbox' | 'SegmentedControl' | 'Menu' | 'Modal'>
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

export function UiCheckbox(props: ComponentProps<typeof Primitives.Checkbox>) {
  const ui = useContext(UiContext)
  return ui
    ? <span data-dc-ui="native" className="dc-ui-checkbox"><ui.Checkbox {...props} /></span>
    : <label className="dc-checkbox"><input type="checkbox" checked={props.checked} disabled={props.disabled} onChange={(event) => props.onChange(event.target.checked)} />{props.label}</label>
}

interface Choice { value: string; label: string; disabled?: boolean }
export function UiSelect({ value, options, onChange, label, disabled, className = '' }: {
  value: string | number | undefined; options: readonly Choice[]; onChange: (value: string) => void
  label: string; disabled?: boolean; className?: string
}) {
  const ui = useContext(UiContext)
  const [open, setOpen] = useState(false)
  const selected = String(value ?? '')
  const text = options.find((option) => option.value === selected)?.label ?? options[0]?.label ?? '请选择'
  useEffect(() => { if (disabled) setOpen(false) }, [disabled])
  if (!ui) return <select className={`dc-ui-select ${className}`} aria-label={label} value={selected} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
    {options.map((option) => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
  </select>
  return <span className={`dc-ui-select ${className}`} data-dc-ui="native">
    <ui.Menu open={open && !disabled} portal autoFocus selectedId={selected}
      className="dc-ui-select-anchor" listClassName="dc-ui-popup"
      anchor={<ui.Button type="button" variant="outline" size="sm" disabled={disabled}
        className="dc-ui-select-trigger" aria-label={`${label}：${text}`} aria-haspopup="menu" aria-expanded={open && !disabled}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true) } }}>
        <span className="dc-ui-select-value">{text}</span><span aria-hidden="true">⌄</span>
      </ui.Button>}
      items={options.map((option) => ({ id: option.value, label: option.label, disabled: option.disabled }))}
      onSelect={(next) => { setOpen(false); onChange(next) }} onClose={() => setOpen(false)} />
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
    listClassName="dc-ui-popup" onClose={() => setOpen(false)} onSelect={(id) => { setOpen(false); items.find((item) => item.id === id)?.onSelect() }} /></span>
  return <span ref={wrapper} className="dc-ui-action-menu" style={{ '--dc-action-menu-gap': `${gap}px` } as CSSProperties} onKeyDown={(event) => {
    if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); wrapper.current?.querySelector('button')?.focus() }
  }}>{trigger}{open && !disabled && <span role="menu" className={`dc-ui-action-list ${side}`}>
    {items.map((item) => <button key={item.id} type="button" role="menuitem" disabled={item.disabled} className={item.danger ? 'danger' : ''}
      onClick={() => { setOpen(false); item.onSelect(); wrapper.current?.querySelector('button')?.focus() }}>{item.icon}{item.label}</button>)}
  </span>}</span>
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
