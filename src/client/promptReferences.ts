import { isGeneration, nodeResults, validateGraph, type Asset, type CanvasGraph, type ModelCapabilities, type Task } from '../shared/contracts'
import { assetToken, referenceLabel } from '../shared/promptMentions'
import { connectionAsset } from './generationLayout'
import { hasGenerationHistory } from './generationHistory'

export interface PromptReference {
  assetId: string; sourceId: string; token: string; label: string; name: string; kind: Asset['kind']; connected: boolean
}
export function connectedPromptReferences(graph: CanvasGraph, targetId: string, assets: readonly Asset[]): PromptReference[] {
  const byId = new Map(assets.map((asset) => [asset.id, asset]))
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]))
  return graph.edges.filter((edge) => edge.target === targetId).flatMap((edge, index) => {
    const asset = byId.get(edge.assetId)
    return asset ? [{
      assetId: asset.id, sourceId: edge.source, token: assetToken(asset.id), kind: asset.kind, connected: true,
      label: referenceLabel(asset.kind, index), name: nodes.get(edge.source)?.title ?? asset.filename,
    }] : []
  })
}
function compatible(asset: Asset, caps: ModelCapabilities): boolean {
  return caps.referenceKinds.includes(asset.kind) && (asset.kind !== 'image' || ['image/png', 'image/jpeg', 'image/webp'].includes(asset.mime))
}
export function promptCandidates(graph: CanvasGraph, targetId: string, assets: readonly Asset[], tasks: readonly Pick<Task, 'nodeId' | 'resultIds'>[], caps: ModelCapabilities): PromptReference[] {
  const connected = connectedPromptReferences(graph, targetId, assets)
  const target = graph.nodes.find((node) => node.id === targetId)
  if (!target || !isGeneration(target.kind)) return []
  const byId = new Map(assets.map((asset) => [asset.id, asset]))
  const candidates = connected.filter((item) => compatible(byId.get(item.assetId)!, caps))
  if (connected.length >= caps.maxReferences) return candidates
  const seen = new Set(connected.map((item) => item.assetId))
  // A downstream node cannot be connected back to this target.
  const adjacency = new Map<string, string[]>()
  for (const edge of graph.edges) adjacency.set(edge.source, [...adjacency.get(edge.source) ?? [], edge.target])
  const downstream = new Set([targetId])
  const pending = [targetId]
  while (pending.length) for (const id of adjacency.get(pending.pop()!) ?? []) if (!downstream.has(id)) { downstream.add(id); pending.push(id) }
  for (const node of graph.nodes) {
    if (downstream.has(node.id) || hasGenerationHistory(node, tasks)) continue
    const asset = connectionAsset(node, assets, nodeResults(node.id, tasks, assets), null)
    if (!asset || seen.has(asset.id) || !compatible(asset, caps)) continue
    seen.add(asset.id)
    candidates.push({ assetId: asset.id, sourceId: node.id, token: assetToken(asset.id), kind: asset.kind, connected: false, label: node.title, name: node.title })
  }
  return candidates
}
/** Prompt and new edge are one graph edit. Removing a chip never removes an edge. */
export function insertPromptReference(graph: CanvasGraph, targetId: string, item: PromptReference, prompt: string, assets: readonly Asset[], tasks: readonly Pick<Task, 'nodeId' | 'resultIds'>[], caps: ModelCapabilities): { graph: CanvasGraph; reference: PromptReference } {
  const current = promptCandidates(graph, targetId, assets, tasks, caps).find((candidate) => candidate.assetId === item.assetId && candidate.sourceId === item.sourceId)
  if (!current) throw new Error('这份素材现在不可引用，请重新选择')
  const next: CanvasGraph = {
    ...graph,
    nodes: graph.nodes.map((node) => node.id === targetId ? { ...node, prompt } : node),
    edges: current.connected ? graph.edges : [...graph.edges, { id: crypto.randomUUID(), source: current.sourceId, target: targetId, assetId: current.assetId }],
  }
  validateGraph(next, assets, tasks)
  return { graph: next, reference: connectedPromptReferences(next, targetId, assets).find((reference) => reference.assetId === current.assetId)! }
}
