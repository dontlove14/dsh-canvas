import type { CanvasPresentationClient } from './presentation'

/** Only real input pauses follow; React Flow's programmatic viewport moves do not. */
export function installCanvasFollowGestures(root: HTMLElement, client: CanvasPresentationClient) {
  const pointers = new Set<number>(), keys = new Set<string>()
  const pointerDown = (event: PointerEvent) => {
    if (!event.isTrusted) return
    pointers.add(event.pointerId); client.activity(`pointer:${event.pointerId}`)
  }
  const pointerMove = (event: PointerEvent) => {
    if (event.isTrusted && pointers.has(event.pointerId)) client.activity(`pointer:${event.pointerId}`)
  }
  const pointerEnd = (event: PointerEvent) => {
    if (event.isTrusted && pointers.delete(event.pointerId)) client.activity(`pointer:${event.pointerId}`, true)
  }
  const keyDown = (event: KeyboardEvent) => {
    if (!event.isTrusted) return
    keys.add(event.code); client.activity(`key:${event.code}`)
  }
  const keyUp = (event: KeyboardEvent) => {
    if (event.isTrusted && keys.delete(event.code)) client.activity(`key:${event.code}`, true)
  }
  const activity = (event: Event) => { if (event.isTrusted) client.activity() }
  const release = () => {
    for (const id of pointers) client.activity(`pointer:${id}`, true)
    for (const code of keys) client.activity(`key:${code}`, true)
    pointers.clear(); keys.clear()
  }
  const visibility = () => { if (document.hidden) { release(); client.cancelActivity() } }
  root.addEventListener('pointerdown', pointerDown, true)
  root.addEventListener('keydown', keyDown, true)
  for (const type of ['wheel', 'input', 'click', 'contextmenu']) root.addEventListener(type, activity, { capture: true, passive: true })
  window.addEventListener('pointermove', pointerMove, true)
  window.addEventListener('pointerup', pointerEnd, true)
  window.addEventListener('pointercancel', pointerEnd, true)
  window.addEventListener('keyup', keyUp, true)
  window.addEventListener('blur', release)
  document.addEventListener('visibilitychange', visibility)
  const dispose = () => {
    root.removeEventListener('pointerdown', pointerDown, true)
    root.removeEventListener('keydown', keyDown, true)
    for (const type of ['wheel', 'input', 'click', 'contextmenu']) root.removeEventListener(type, activity, true)
    window.removeEventListener('pointermove', pointerMove, true)
    window.removeEventListener('pointerup', pointerEnd, true)
    window.removeEventListener('pointercancel', pointerEnd, true)
    window.removeEventListener('keyup', keyUp, true)
    window.removeEventListener('blur', release)
    document.removeEventListener('visibilitychange', visibility)
    client.cancelActivity()
  }
  return { pointerDown, keyDown, activity, dispose }
}
