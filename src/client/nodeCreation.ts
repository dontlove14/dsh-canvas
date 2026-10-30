import {
  isGeneration, nodeMediaKind,
  nodeResults, type CanvasGraph, type CanvasNode, type Asset, type PublicModel,
} from '../shared/contracts'
import { modelConfigured } from '../shared/modelCatalog'
import { connectAssetReference } from '../shared/referenceConnection'
import type { TaskSummary } from '../shared/v2'
import { connectionAsset } from './generationLayout'
import { generationHistory, hasGenerationHistory } from './generationHistory'

import { CREATABLE_NODES, nodeFor, type CreatableNodeKind } from '../shared/nodeFactory'
export { CREATABLE_NODES, type CreatableNodeKind } from '../shared/nodeFactory'
export interface NodeCreationEnvironment {
  assets: readonly Asset[]; tasks: readonly TaskSummary[]; models: readonly PublicModel[]
  expandedGroups: Readonly<Record<string, boolean>>
}
export interface OutputReference { sourceId: string; assetId: string; handleId: string | null; history: boolean }
export type CanvasPoint = { x: number; y: number }

export function resolveOutput(graph: CanvasGraph, sourceId: string, handleId: string | null, env: NodeCreationEnvironment): OutputReference | undefined {
  const source = graph.nodes.find((node) => node.id === sourceId)
  if (!source) return
  const history = hasGenerationHistory(source, env.tasks)
  const results = history ? generationHistory(source.id, env.tasks, env.assets).flatMap((card) => card.results)
    : nodeResults(source.id, env.tasks, env.assets)
  const asset = connectionAsset(source, env.assets, results, handleId, history, !!env.expandedGroups[source.id])
  return asset ? { sourceId, assetId: asset.id, handleId, history } : undefined
}

/** Keep the picked result fixed even if the main image changes while the menu is open. */
export function outputAvailable(graph: CanvasGraph, reference: OutputReference, env: NodeCreationEnvironment): boolean {
  const source = graph.nodes.find((node) => node.id === reference.sourceId)
  if (!source || !env.assets.some((asset) => asset.id === reference.assetId)) return false
  if (reference.history && (!env.expandedGroups[source.id] || reference.handleId !== `result:${reference.assetId}`)) return false
  return isGeneration(source.kind)
    ? env.tasks.some((task) => task.nodeId === source.id && task.resultIds.includes(reference.assetId))
    : source.assetId === reference.assetId
}

/** Same connection policy for direct wiring and wiring to a newly created node. */
export function connectReference(graph: CanvasGraph, reference: OutputReference, targetId: string, env: NodeCreationEnvironment): CanvasGraph {
  if (!outputAvailable(graph, reference, env)) throw new Error('请从已有素材连接到生成节点')
  return connectAssetReference(graph, reference.sourceId, targetId, reference.assetId, env.assets, env.tasks, env.models)
}

/** Returns the complete mutation, or throws before any graph is changed. */
export function createCanvasNode(graph: CanvasGraph, kind: CreatableNodeKind, position: CanvasPoint, env: NodeCreationEnvironment, reference?: OutputReference) {
  if (!CREATABLE_NODES.some((entry) => entry.kind === kind)) throw new Error('节点类型不可用')
  const candidates = env.models.filter((model) => model.kind === nodeMediaKind(kind) && modelConfigured(model))
  if (!reference) {
    const node = nodeFor(graph, kind, position, candidates[0])
    return { node, graph: { ...graph, nodes: [...graph.nodes, node] } }
  }
  let failure: unknown
  for (const model of candidates.length ? candidates : [undefined]) {
    const node = nodeFor(graph, kind, position, model)
    try {
      const next = connectReference({ ...graph, nodes: [...graph.nodes, node] }, reference, node.id, env)
      return { node, graph: next }
    } catch (error) { failure = error }
  }
  throw failure
}

export function nodeCreationChoices(graph: CanvasGraph, position: CanvasPoint, env: NodeCreationEnvironment, reference?: OutputReference) {
  return CREATABLE_NODES.map((entry) => {
    let disabledReason: string | undefined
    if (reference) try { createCanvasNode(graph, entry.kind, position, env, reference) }
    catch (error) { disabledReason = error instanceof Error ? error.message : '当前素材不支持此节点' }
    return { ...entry, disabled: !!disabledReason, disabledReason }
  }).filter((entry) => !entry.disabled)
}
