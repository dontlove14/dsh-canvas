import type { CanvasGraph } from '../../shared/contracts'
import { hash } from '../persistence/database'

/** Bounded factual changes, not a model-generated account of the user's intentions. */
export function handoffSummary(before: CanvasGraph | undefined, after: CanvasGraph, revision: number): string {
  if (!before) return `当前画布 revision=${revision}，请读取全部节点与引用。`
  const old = new Map(before.nodes.map((n) => [n.id, n]))
  const current = new Map(after.nodes.map((n) => [n.id, n]))
  const changes: string[] = []
  for (const node of after.nodes) {
    const previous = old.get(node.id)
    if (!previous) { changes.push(`新增节点 ${node.id}「${node.title}」(${node.kind})`); continue }
    for (const field of ['title', 'prompt', 'modelId', 'params', 'selectedResultId', 'assetId', 'position'] as const) {
      if (hash(previous[field]) !== hash(node[field])) changes.push(`节点 ${node.id} ${field} 改为 ${JSON.stringify(node[field]).slice(0, 1000)}`)
    }
  }
  for (const node of before.nodes) if (!current.has(node.id)) changes.push(`删除节点 ${node.id}「${node.title}」`)
  const oldEdges = new Map(before.edges.map((e) => [e.id, e]))
  for (const edge of after.edges) if (hash(oldEdges.get(edge.id) ?? null) !== hash(edge)) changes.push(`新增/修改引用 ${edge.source} → ${edge.target}，assetId=${edge.assetId}`)
  for (const edge of before.edges) if (!after.edges.some((e) => e.id === edge.id)) changes.push(`删除引用 ${edge.source} → ${edge.target}，assetId=${edge.assetId}`)
  return (`人工操作后的画布 revision=${revision}。\n${changes.join('\n') || '节点和引用未改变。'}`).slice(0, 12000)
}
