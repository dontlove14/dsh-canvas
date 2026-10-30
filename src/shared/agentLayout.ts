import type { CanvasNode } from './contracts'
import type { AutoPlacement } from './presentation'

export interface NodeSize { width: number; height: number }
export const initialNodeSize = (_kind: CanvasNode['kind']): NodeSize => ({ width: 320, height: 180 })

/** Only new nodes move. Reserve titles, handles and a full prompt card between rows. */
export function placeAgentNode(nodes: readonly CanvasNode[], size: NodeSize, origin: { x: number; y: number },
  placement: AutoPlacement, sizes: Record<string, NodeSize> = {}) {
  const anchor = nodes.find((node) => node.id === placement.anchorNodeId)
  if (placement.anchorNodeId && !anchor) throw new Error('排布锚点不存在')
  const anchorSize = anchor ? sizes[anchor.id] ?? initialNodeSize(anchor.kind) : null
  const start = anchor && anchorSize
    ? { x: anchor.position.x + Math.max(600, anchorSize.width + 180), y: anchor.position.y }
    : { x: origin.x, y: origin.y + (nodes.length ? { assets: 0, shots: 850, audio: 1700 }[placement.group] : 0) }
  const occupied = nodes.map((node) => {
    const frame = sizes[node.id] ?? initialNodeSize(node.kind)
    return { x: node.position.x - Math.max(40, (530 - frame.width) / 2), y: node.position.y - 55,
      width: Math.max(530, frame.width) + 80, height: frame.height + 620 }
  })
  for (let index = 0; index < 10000; index++) {
    const point = { x: start.x + index % 4 * Math.max(640, size.width + 220), y: start.y + Math.floor(index / 4) * Math.max(850, size.height + 670) }
    const rect = { x: point.x - Math.max(40, (530 - size.width) / 2), y: point.y - 55, width: Math.max(530, size.width) + 80, height: size.height + 620 }
    if (!occupied.some((other) => rect.x < other.x + other.width && rect.x + rect.width > other.x && rect.y < other.y + other.height && rect.y + rect.height > other.y)) return point
  }
  throw new Error('自动排布空间不足，请指定新区域')
}
