import { forwardRef, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import type * as Primitives from '@deepseek-ai/dsh-client-ui-primitives'
import type { HarnessUiProvider } from '../../src/client/ui'

// Adapter contract fixture: the Harness platform loader supplies the runtime,
// whose full npm entry requires host-only peers. Keep public props and portal
// shape here; this does not claim to test native styling or browser focus.
const Button = forwardRef<HTMLButtonElement, Parameters<typeof Primitives.Button>[0]>(
  function Button({ variant: _variant, size: _size, ...props }, ref) { return <button {...props} ref={ref} /> },
)
const Input = forwardRef<HTMLInputElement, Parameters<typeof Primitives.Input>[0]>(
  function Input(props, ref) { return <span><input {...props} ref={ref} /></span> },
)
function Menu({ open, anchor, items, onSelect, listClassName }: Parameters<typeof Primitives.Menu>[0]) {
  return <span>{anchor}{open && createPortal(<div role="menu" className={listClassName}>
    {items?.map((item) => 'label' in item ? <button key={item.id} role="menuitem" disabled={item.disabled} onClick={() => onSelect?.(item.id)}>{item.icon}{item.label}</button>
      : item.type === 'label' ? <div key={item.id}>{item.text}</div> : <hr key={item.id} />)}
  </div>, document.body)}</span>
}
function Modal({ title, closeLabel, onClose, children, className }: Parameters<typeof Primitives.Modal>[0]) {
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const before = document.activeElement as HTMLElement
    panel.current?.querySelector<HTMLElement>('[data-modal-autofocus]')?.focus()
    return () => before?.focus()
  }, [])
  return createPortal(<div ref={panel} className={className} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined}
    onKeyDown={(event) => { if (event.key === 'Escape') onClose() }}>
    <h2>{title}</h2><button aria-label={closeLabel} onClick={onClose}>×</button>{children}
  </div>, document.body)
}
export const harnessPrimitives = { Button, Input, Menu, Modal } as Parameters<typeof HarnessUiProvider>[0]['components']
