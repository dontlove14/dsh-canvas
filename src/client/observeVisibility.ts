/** Use the newest record for this element; a callback can contain both exit and reentry. */
export function observeVisibility(
  element: Element | null,
  onChange: (visible: boolean) => void,
  options?: IntersectionObserverInit,
): () => void {
  if (!element) return () => {}
  if (typeof IntersectionObserver === 'undefined') {
    onChange(true)
    return () => {}
  }
  let active = true
  let lastTime = -Infinity
  const observer = new IntersectionObserver((entries) => {
    if (!active) return
    let newest: IntersectionObserverEntry | undefined
    for (const entry of entries) {
      if (entry.target === element && (!newest || entry.time >= newest.time)) newest = entry
    }
    if (!newest || newest.time < lastTime) return
    lastTime = newest.time
    onChange(newest.isIntersecting)
  }, options)
  observer.observe(element)
  return () => { active = false; observer.disconnect() }
}
