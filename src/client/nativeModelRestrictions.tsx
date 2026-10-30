import { useEffect, useLayoutEffect, useRef } from 'react'
import type { ModelSelectInjected } from '@deepseek-ai/dsh-client-ui-model-selection/client'

export const NON_MULTIMODAL_MODEL_HINT = '非多模态模型，当前 Agent 不支持使用'
export const MODEL_CAPABILITY_PENDING_HINT = '模型能力尚未核验，暂不可用'
export const MODEL_CAPABILITY_FAILED_HINT = '模型能力核验失败，暂不可用'
export const modelRouteKey = (provider: string, model: string) => JSON.stringify([provider, model])
const ROW = 'button[role="menuitemradio"]'
const BLOCKED = 'data-dc-agent-model-disabled'
const menuGuards = new WeakMap<HTMLElement, { count: number; dispose: () => void }>()

function guardKeyboard(menu: HTMLElement) {
  const existing = menuGuards.get(menu)
  if (existing) existing.count++
  else {
    const stop = (event: Event) => { event.preventDefault(); event.stopImmediatePropagation() }
    const click = (event: MouseEvent) => {
      const row = event.target instanceof Element ? event.target.closest(ROW) : null
      if (row?.hasAttribute(BLOCKED)) stop(event)
    }
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing || event.defaultPrevented) return
      const target = event.target
      if (!(target instanceof Element)) return
      if (target.matches('input[role="searchbox"]')) {
        if (event.key !== 'Enter' && !(event.key === 'Tab' && !event.shiftKey)) return
        const id = target.getAttribute('aria-activedescendant')
        const row = id ? document.getElementById(id) : null
        if (row && menu.contains(row) && row.hasAttribute(BLOCKED)) stop(event)
        return
      }
      const row = target.closest<HTMLButtonElement>(ROW)
      if (!row) return
      if (row.hasAttribute(BLOCKED) && ['Enter', ' ', 'Tab'].includes(event.key)) { stop(event); return }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
      const rows = [...menu.querySelectorAll<HTMLButtonElement>(ROW)].filter((item) => !item.disabled)
      const direction = event.key === 'ArrowDown' ? 1 : -1
      const index = rows.indexOf(row)
      const next = index < 0 ? (direction > 0 ? 0 : rows.length - 1) : (index + direction + rows.length) % rows.length
      rows[next]?.focus()
      stop(event)
    }
    menu.addEventListener('click', click, true)
    menu.addEventListener('keydown', keydown, true)
    menuGuards.set(menu, { count: 1, dispose: () => {
      menu.removeEventListener('click', click, true)
      menu.removeEventListener('keydown', keydown, true)
    } })
  }
  return () => {
    const guard = menuGuards.get(menu)
    if (guard && --guard.count === 0) { guard.dispose(); menuGuards.delete(menu) }
  }
}

/** Native labels identify the exact provider/model row, including inside a body portal. */
export function restrictNativeModelRow(anchor: HTMLElement, hint: string, modelName: string,
  directory: ModelSelectInjected['directory']) {
  const row = anchor.closest<HTMLButtonElement>(ROW)
  if (!row) return () => {}
  const previousAria = row.getAttribute('aria-disabled'), previousDescription = row.getAttribute('aria-description')
  const menu = row.closest<HTMLElement>('[role="menu"]')?.closest<HTMLElement>('[role="group"]')
  const releaseMenu = menu ? guardKeyboard(menu) : () => {}
  const apply = () => {
    if (!row.disabled) row.disabled = true
    if (row.title !== hint) row.title = hint
    if (row.getAttribute('aria-disabled') !== 'true') row.setAttribute('aria-disabled', 'true')
    if (row.getAttribute('aria-description') !== hint) row.setAttribute('aria-description', hint)
    if (!row.hasAttribute(BLOCKED)) row.setAttribute(BLOCKED, 'true')
  }
  apply()
  // Native selection can briefly write its own busy/disabled and title props.
  // Keep this policy active until this exact option or Agent scope leaves.
  const observer = new MutationObserver(apply)
  observer.observe(row, { attributes: true, attributeFilter: ['disabled', 'title', 'aria-disabled', 'aria-description', BLOCKED] })
  return () => {
    observer.disconnect(); releaseMenu()
    row.disabled = directory.getSnapshot().pending != null
    row.title = modelName
    row.removeAttribute(BLOCKED)
    if (previousAria === null) row.removeAttribute('aria-disabled'); else row.setAttribute('aria-disabled', previousAria)
    if (previousDescription === null) row.removeAttribute('aria-description'); else row.setAttribute('aria-description', previousDescription)
  }
}

export function NativeModelOptionRestriction({ hint, modelName, directory, refresh }: {
  hint: string | null; modelName: string; directory: ModelSelectInjected['directory']; refresh: () => void
}) {
  const anchor = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    if (!hint || !anchor.current) return
    return restrictNativeModelRow(anchor.current, hint, modelName, directory)
  }, [hint, modelName, directory])
  useEffect(() => { refresh() }, [refresh])
  return <span ref={anchor} hidden aria-hidden="true" />
}
