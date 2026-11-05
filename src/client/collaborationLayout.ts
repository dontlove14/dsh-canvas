/** Display-only tuning; actual Agent state continues to select idle/processing. */
export const collaborationRingMotion = {
  speed: 2, calm: .75, idle: .32, opts: { lean: 1.15, zoom: .24 },
}
const EDGE_GAP = 12

/** Move the composer-owned overlay into the chat's right gutter, never a neighboring pane. */
export function collaborationOutset(anchor: Pick<DOMRect, 'right' | 'width'>,
  bounds: Pick<DOMRect, 'left' | 'right' | 'width'> | undefined, viewportRight: number) {
  if (anchor.width <= 0 || !Number.isFinite(anchor.right) || !Number.isFinite(viewportRight) || viewportRight <= 0) return 0
  const right = Math.min(bounds && bounds.width > 0 ? bounds.right : anchor.right + 48, viewportRight)
  const left = bounds && bounds.width > 0 ? bounds.left : 0
  const target = Math.max(left, right - EDGE_GAP)
  return Math.round(target - anchor.right)
}
