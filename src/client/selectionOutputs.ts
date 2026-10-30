import { isGeneration, nodeResults, type Asset, type CanvasGraph } from '../shared/contracts'
import { generationHistory, hasGenerationHistory, resultHandle } from './generationHistory'
import { connectReference, resolveOutput, type NodeCreationEnvironment, type OutputReference } from './nodeCreation'

/** Stable graph order; history only contributes its visible, explicit output ports. */
export function selectionOutputs(graph: CanvasGraph, ids: readonly string[], env: NodeCreationEnvironment): OutputReference[] {
  const selected = new Set(ids), seen = new Set<string>(), outputs: OutputReference[] = []
  for (const node of graph.nodes) {
    if (!selected.has(node.id)) continue
    const references = hasGenerationHistory(node, env.tasks) && env.expandedGroups[node.id]
      ? generationHistory(node.id, env.tasks, env.assets).flatMap((card) => card.results)
        .map((asset) => resolveOutput(graph, node.id, resultHandle(asset.id), env))
      : [resolveOutput(graph, node.id, null, env)]
    for (const reference of references) if (reference && !seen.has(reference.assetId)) {
      seen.add(reference.assetId); outputs.push(reference)
    }
  }
  return outputs
}

/** Each candidate sees references already accepted by this same mutation. */
export function connectSelection(graph: CanvasGraph, outputs: readonly OutputReference[], targetId: string, env: NodeCreationEnvironment): CanvasGraph {
  let next = graph
  for (const reference of outputs) {
    try { next = connectReference(next, reference, targetId, env) }
    catch { /* A batch intentionally skips incompatible, stale or full inputs. */ }
  }
  return next
}

export function selectionDownloads(graph: CanvasGraph, ids: readonly string[], env: NodeCreationEnvironment): Asset[] {
  const selected = new Set(ids), downloads = new Map<string, Asset>()
  for (const node of graph.nodes) {
    if (!selected.has(node.id)) continue
    const history = hasGenerationHistory(node, env.tasks)
    const cards = history ? generationHistory(node.id, env.tasks, env.assets) : undefined
    const results = isGeneration(node.kind) ? (history
      ? cards!.flatMap((card) => card.results)
      : nodeResults(node.id, env.tasks, env.assets)) : []
    const visible = env.expandedGroups[node.id] ? results : []
    const main = !history || !env.expandedGroups[node.id]
      ? (history ? cards![0]?.results[0]
        : isGeneration(node.kind) ? results.find((asset) => asset.id === node.selectedResultId) ?? results[0]
        : env.assets.find((asset) => asset.id === node.assetId)) : undefined
    for (const asset of visible.length ? visible : main ? [main] : []) downloads.set(asset.id, asset)
  }
  return [...downloads.values()]
}
