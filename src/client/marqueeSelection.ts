import type { InternalNode, Rect, Transform } from '@xyflow/react'

/** Screen-space marquee against actual node bodies, including unmounted nodes. */
export function fullyContainedNodeIds(rect: Rect, transform: Transform, nodes: Iterable<InternalNode>): string[] {
  if (!(rect.width > 0 && rect.height > 0 && transform[2] > 0) ||
    ![rect.x, rect.y, rect.width, rect.height, ...transform].every(Number.isFinite)) return []
  const [tx, ty, zoom] = transform
  const left = (rect.x - tx) / zoom, top = (rect.y - ty) / zoom
  const right = left + rect.width / zoom, bottom = top + rect.height / zoom
  const result: string[] = []
  for (const node of nodes) {
    if (node.hidden || node.selectable === false) continue
    const width = node.width ?? node.measured.width, height = node.height ?? node.measured.height
    const { x, y } = node.internals.positionAbsolute
    if (width && height && width > 0 && height > 0 && [x, y, width, height].every(Number.isFinite) &&
      x >= left && y >= top && x + width <= right && y + height <= bottom) result.push(node.id)
  }
  return result
}
