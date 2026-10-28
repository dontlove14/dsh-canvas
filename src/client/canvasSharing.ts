import type { CanvasGraph, CanvasNode } from '../shared/contracts'
import type { CanvasSnapshot } from '../shared/v2'

/** JSON snapshots are immutable. Compare every field, including task/asset metadata. */
function shareValue(previous: unknown, next: unknown): unknown {
  if (Object.is(previous, next)) return previous
  if (!previous || !next || typeof previous !== 'object' || typeof next !== 'object') return next
  if (Array.isArray(next)) {
    if (!Array.isArray(previous)) return next
    const keyed = next.every((item) => item && typeof item === 'object' && typeof item.id === 'string')
    const byId = keyed ? new Map(previous.map((item) => [item.id, item])) : undefined
    const shared = next.map((item, index) => shareValue(byId ? byId.get(item.id) : previous[index], item))
    return previous.length === shared.length && shared.every((item, index) => item === previous[index]) ? previous : shared
  }
  if (Array.isArray(previous)) return next
  const old = previous as Record<string, unknown>, value = next as Record<string, unknown>
  const keys = Object.keys(value)
  let same = Object.keys(old).length === keys.length
  const shared: Record<string, unknown> = {}
  for (const key of keys) {
    shared[key] = shareValue(old[key], value[key])
    if (!Object.hasOwn(old, key) || shared[key] !== old[key]) same = false
  }
  return same ? previous : shared
}

export function shareCanvasSnapshot(previous: CanvasSnapshot | null, next: CanvasSnapshot): CanvasSnapshot {
  return previous?.workspaceId === next.workspaceId ? shareValue(previous, next) as CanvasSnapshot : next
}

export function sameFields(a: Record<string, unknown>, b: Record<string, unknown>, except?: string): boolean {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((key) => key === except || Object.is(a[key], b[key]))
}

/** Only renderers that never read position may use this comparison. */
export function sameNodeContent(a: CanvasNode, b: CanvasNode): boolean {
  return a === b || sameFields(a, b, 'position')
}

export function shareItems<T>(previous: readonly T[] | undefined, next: T[]): T[] {
  return previous?.length === next.length && next.every((item, index) => item === previous[index]) ? previous as T[] : next
}

/** Render-only reference graph. Writers must use the live graph, not this view. */
export function shareEditorGraph(previous: CanvasGraph | undefined, next: CanvasGraph): CanvasGraph {
  if (!previous) return next
  const byId = new Map(previous.nodes.map((node) => [node.id, node]))
  const nodes = shareItems(previous.nodes, next.nodes.map((node) => {
    const old = byId.get(node.id)
    return old && sameNodeContent(old, node) ? old : node
  }))
  return nodes === previous.nodes && next.edges === previous.edges ? previous : { ...next, nodes }
}
