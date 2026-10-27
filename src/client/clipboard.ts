/** Copy a user-selected value, keeping legacy selection inside the active modal. */
export async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(value); return } catch { /* Try the local selection fallback. */ }
  }
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const field = document.createElement('textarea')
  field.value = value; field.readOnly = true; field.tabIndex = -1
  field.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none'
  const scope = focused?.closest('.dc-native-modal,dialog') ?? document.body
  scope.append(field)
  try {
    field.focus({ preventScroll: true }); field.select()
    if (!document.execCommand?.('copy')) throw new Error('复制失败，请重试')
  } finally { field.remove(); focused?.focus({ preventScroll: true }) }
}
