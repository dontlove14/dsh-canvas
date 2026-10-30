import {
  NodeLabels, defaultParams, defaultTtsParams, isGeneration, isTtsParams, nodeMediaKind,
  nodeResults, validateGraph, type CanvasGraph, type CanvasNode, type Asset, type PublicModel,
} from '../shared/contracts'
import { modelConfigured, isMultimodalVideo } from '../shared/modelCatalog'
import { videoGenerationParams, videoInputCapabilities, validateVideoConnections } from '../shared/video'
import type { TaskSummary } from '../shared/v2'
import { connectionAsset } from './generationLayout'
import { generationHistory, hasGenerationHistory } from './generationHistory'

/** All three creation entrances consume this registry; importing media is separate. */
export const CREATABLE_NODES = [
  { kind: 'image-generation', icon: 'image' },
  { kind: 'video-generation', icon: 'video' },
  { kind: 'tts-generation', icon: 'tts' },
] as const
export type CreatableNodeKind = typeof CREATABLE_NODES[number]['kind']
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
  const target = graph.nodes.find((node) => node.id === targetId)
  const asset = env.assets.find((asset) => asset.id === reference.assetId)
  if (!outputAvailable(graph, reference, env) || !target || !asset || !isGeneration(target.kind))
    throw new Error('请从已有素材连接到生成节点')
  if (target.kind === 'tts-generation') throw new Error('语音生成节点不支持输入连线')
  const model = env.models.find((item) => item.id === target.modelId)
  if (asset.kind === 'image' && !['image/png', 'image/jpeg', 'image/webp'].includes(asset.mime))
    throw new Error('当前协议的参考图仅支持 PNG、JPEG 和 WebP')
  const previousIds = graph.edges.filter((edge) => edge.target === target.id).map((edge) => edge.assetId)
  const params = target.params && !isTtsParams(target.params) && model && isMultimodalVideo(model)
    ? videoGenerationParams(target.params, previousIds, model) : target.params
  const caps = model && videoInputCapabilities(model, !isTtsParams(params) ? params : null)
  if (caps && (!caps.referenceKinds.includes(asset.kind) || previousIds.length >= caps.maxReferences))
    throw new Error('当前模型不支持这份素材，或引用数量已达上限')
  if (!model && asset.kind !== 'image') throw new Error('请先配置支持这类素材的模型')
  const next = { ...graph, edges: [...graph.edges, {
    id: crypto.randomUUID(), source: reference.sourceId, target: target.id, assetId: asset.id,
  }] }
  if (model && isMultimodalVideo(model) && params && !isTtsParams(params)) {
    const inputs = next.edges.filter((edge) => edge.target === target.id).map((edge) => env.assets.find((asset) => asset.id === edge.assetId))
    if (inputs.some((asset) => !asset)) throw new Error('引用素材不可用')
    validateVideoConnections(videoGenerationParams(params, [...previousIds, asset.id], model), inputs as Asset[], model)
  }
  validateGraph(next, env.assets, env.tasks)
  return next
}

function nodeFor(graph: CanvasGraph, kind: CreatableNodeKind, position: CanvasPoint, model?: PublicModel): CanvasNode {
  return {
    id: crypto.randomUUID(), kind, title: `${NodeLabels[kind]} ${graph.nodes.filter((node) => node.kind === kind).length + 1}`,
    position, modelId: model?.id ?? null,
    params: kind === 'tts-generation' ? defaultTtsParams() : model ? defaultParams(model) : null,
    prompt: '', assetId: null, selectedResultId: null,
  }
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
