import { isTtsParams, validateGeneration, validateTtsReferences, validateGraph, type Asset, type CanvasGraph, type CanvasNode, type PublicModel, type Task, type AnyTaskSnapshot } from '../../shared/contracts'
import { assetToken, promptParts, resolvePrompt } from '../../shared/promptMentions'
import { connectAssetReference } from '../../shared/referenceConnection'
import { isMultimodalVideo } from '../../shared/modelCatalog'
import { videoGenerationParams, validateVideoInputs, videoReferenceLimits } from '../../shared/video'
import { CanvasError } from '../store'

export interface AgentReference { source: string; assetId: string }
export interface ReferenceExclusion { assetId: string; reason: string }
type ReferenceState = { graph: CanvasGraph; assets: Asset[]; tasks: readonly (Pick<Task, 'nodeId' | 'resultIds'> &
  Partial<Pick<Task, 'id'>> & { snapshot?: Pick<AnyTaskSnapshot, 'referenceIds'> })[] }
function referenceIndex(state: ReferenceState) {
  const nodes = new Set(state.graph.nodes.map((node) => node.id)), sources = new Map<string, string>()
  for (const node of state.graph.nodes) if (node.assetId) sources.set(node.assetId, node.id)
  for (const task of state.tasks) if (nodes.has(task.nodeId))
    for (const id of task.resultIds) if (!sources.has(id)) sources.set(id, task.nodeId)
  return sources
}
export function promptReference(state: ReferenceState, ref: AgentReference) {
  const asset = state.assets.find((asset) => asset.id === ref.assetId)
  if (!asset) throw new CanvasError('参考素材不可用')
  return { source: ref.source, assetId: ref.assetId, kind: asset.kind, filename: asset.filename, token: assetToken(asset.id) }
}
export function promptReferenceCatalog(state: ReferenceState) {
  const sources = referenceIndex(state)
  return state.assets.flatMap((asset) => {
    const source = sources.get(asset.id)
    return source ? [promptReference(state, { source, assetId: asset.id })] : []
  })
}
/** Exact saved inputs of this result; current source edges and selected output are not provenance. */
export function referenceDependencyCatalog(state: ReferenceState) {
  const sources = referenceIndex(state), assets = new Map(state.assets.map((asset) => [asset.id, asset]))
  const tasks = new Map(state.tasks.filter((task) => task.id).map((task) => [task.id!, task]))
  const outputs = new Map<string, ReferenceState['tasks'][number]>()
  for (const task of state.tasks) for (const id of task.resultIds) outputs.set(id, task)
  return state.assets.map((asset) => {
    const task = asset.taskId ? tasks.get(asset.taskId) : outputs.get(asset.id)
    const saved = task && task.resultIds.includes(asset.id) && task.nodeId === asset.nodeId ? task.snapshot : undefined
    return { assetId: asset.id, provenance: saved ? 'task-snapshot' : task || asset.taskId ? 'unavailable' : 'imported',
      ...(saved && task?.id ? { originTaskId: task.id } : {}),
      dependencies: (saved?.referenceIds ?? []).map((assetId) => {
        const source = sources.get(assetId), dependency = assets.get(assetId)
        return { assetId, available: !!source && !!dependency,
          ...(source && dependency ? promptReference(state, { source, assetId }) : {}) }
      }) }
  })
}
function referenceCoverage(state: ReferenceState, ids: string[], exclusions: readonly ReferenceExclusion[], model: PublicModel) {
  const catalog = new Map(referenceDependencyCatalog(state).map((row) => [row.assetId, row]))
  const dependencies = new Map<string, { assetId: string; via: string[]; available: boolean }>()
  for (const id of ids) for (const ref of catalog.get(id)?.dependencies ?? []) {
    const existing = dependencies.get(ref.assetId)
    if (existing) existing.via.push(id)
    else dependencies.set(ref.assetId, { assetId: ref.assetId, via: [id], available: ref.available })
  }
  const decisions = new Map<string, string>()
  for (const exclusion of exclusions) {
    if (decisions.has(exclusion.assetId) || !dependencies.has(exclusion.assetId) || ids.includes(exclusion.assetId) || !exclusion.reason.trim())
      throw new CanvasError('排除参考须为当前已连接素材的真实依赖，且不能重复或同时连入', 409, 'AGENT_REFERENCE_INVALID')
    decisions.set(exclusion.assetId, exclusion.reason)
  }
  // Voice consistency is inapplicable when the selected model cannot accept audio.
  const audioLimit = videoReferenceLimits(model).reference?.audio ?? 0
  const unsupportedVoice = (id: string) => audioLimit === 0 && state.assets.find((asset) => asset.id === id)?.kind === 'audio'
  const missing = [...dependencies.values()].filter((ref) => !ids.includes(ref.assetId) && !decisions.has(ref.assetId) && !unsupportedVoice(ref.assetId))
  if (missing.length) throw new CanvasError(`视频参考缺少原始一致性素材：${missing.map((ref) => `${ref.assetId}${ref.available ? '' : '（不可用）'}`).join('、')}。请直接连接并用 @ 说明用途；确与本镜头无关时提供 referenceExclusions 和原因。`, 409, 'AGENT_REFERENCE_INCOMPLETE')
  return [...dependencies.values()].map((ref) => ({ ...ref, status: ids.includes(ref.assetId) ? 'connected' : decisions.has(ref.assetId) ? 'excluded' : 'unsupported',
    ...(decisions.has(ref.assetId) ? { reason: decisions.get(ref.assetId)! } : unsupportedVoice(ref.assetId) ? { reason: '所选模型不支持音频参考，跳过人物音色一致性' } : {}) }))
}
/** Build the whole edit before committing: token identity and edges cannot diverge. */
export function referencedNode(state: ReferenceState, input: CanvasNode, references: readonly AgentReference[] | undefined,
  models: readonly PublicModel[], edgeId: (index: number) => string, checkPrompt = true, exclusions: readonly ReferenceExclusion[] = []) {
  let graph = { ...state.graph, nodes: state.graph.nodes.filter((node) => node.id !== input.id).concat(input) }
  const added = []
  const seen = new Set<string>()
  for (const [index, ref] of (references ?? []).entries()) {
    if (seen.has(ref.assetId)) throw new CanvasError('不能重复引用同一素材')
    seen.add(ref.assetId)
    const existing = graph.edges.find((edge) => edge.target === input.id && edge.assetId === ref.assetId)
    if (existing) {
      if (existing.source !== ref.source) throw new CanvasError('引用的素材不属于指定上游节点')
    } else {
      graph = connectAssetReference(graph, ref.source, input.id, ref.assetId, state.assets, state.tasks, models, edgeId(index))
      added.push(graph.edges[graph.edges.length - 1])
    }
  }
  const ids = graph.edges.filter((edge) => edge.target === input.id).map((edge) => edge.assetId)
  const mentions = new Set(promptParts(input.prompt).flatMap((part) => part.kind === 'mention' ? [part.assetId] : []))
  if (input.kind === 'tts-generation' && isTtsParams(input.params)) {
    // TTS reads the prompt aloud; media tokens belong to image/video prompts only.
    if (mentions.size) throw new CanvasError('语音朗读文字不能包含素材 @ 标签，请将参考原文填写到 reference_text')
    validateTtsReferences(input.params, ids.map((id) => {
      const asset = state.assets.find((asset) => asset.id === id)
      if (!asset) throw new CanvasError('参考音频不可用')
      return asset
    }), checkPrompt)
    validateGraph(graph, state.assets, state.tasks)
  } else if (checkPrompt) resolvePrompt(input.prompt, ids, state.assets)
  if (input.kind !== 'tts-generation' && (references ?? []).some((ref) => !mentions.has(ref.assetId)))
    throw new CanvasError('请在提示词中使用每份参考的 @ 标签并说明用途', 409, 'AGENT_REFERENCE_INVALID')
  let node = input
  const model = models.find((model) => model.id === input.modelId)
  if (references !== undefined && model && isMultimodalVideo(model) && input.params && !isTtsParams(input.params)) {
    for (const id of [input.params.firstFrameId, input.params.lastFrameId])
      if (id && !ids.includes(id)) throw new CanvasError('首帧或尾帧参数不能代替真实连线', 409, 'AGENT_REFERENCE_INVALID')
    node = { ...input, params: videoGenerationParams(input.params, ids, model) }
  }
  const referenceMode = node.kind === 'video-generation' && node.params && !isTtsParams(node.params) &&
    (model && isMultimodalVideo(model) ? videoGenerationParams(node.params, ids, model).videoMode : node.params.videoMode) === 'reference'
  if (exclusions.length && !referenceMode) throw new CanvasError('仅参考生视频使用 referenceExclusions', 409, 'AGENT_REFERENCE_INVALID')
  const coverage = checkPrompt && referenceMode && model ? referenceCoverage(state, ids, exclusions, model) : []
  return { node, edges: added, references: graph.edges.filter((edge) => edge.target === input.id).map((edge) => promptReference(state, edge)), referenceCoverage: coverage }
}
/** Preparation is checked without dispatching a task or rewriting a saved graph. */
export function validateAgentGeneration(state: ReferenceState, node: CanvasNode, model: PublicModel, exclusions: readonly ReferenceExclusion[] = []) {
  if (!node.params || isTtsParams(node.params)) throw new CanvasError('请先填写生成参数')
  const edges = state.graph.edges.filter((edge) => edge.target === node.id), ids = edges.map((edge) => edge.assetId)
  const assets = ids.map((id) => {
    const asset = state.assets.find((asset) => asset.id === id)
    if (!asset) throw new CanvasError('参考素材不可用')
    return asset
  })
  // Check raw explicit modes first: inference must not hide an unconnected frame ID.
  if (isMultimodalVideo(model) && (node.params.videoMode !== undefined || node.params.firstFrameId || node.params.lastFrameId))
    validateVideoInputs(node.params, assets, model)
  const mentions = new Set(promptParts(node.prompt).flatMap((part) => part.kind === 'mention' ? [part.assetId] : []))
  if (ids.some((id) => !mentions.has(id)))
    throw new CanvasError('每份已连接参考都需在提示词中使用 @ 标签并说明用途', 409, 'AGENT_REFERENCE_INVALID')
  const params = isMultimodalVideo(model) ? videoGenerationParams(node.params, ids, model) : node.params
  validateGeneration({ model, prompt: node.prompt, params, referenceIds: ids }, state.assets)
  const referenceMode = model.kind === 'video' && params.videoMode === 'reference'
  if (exclusions.length && !referenceMode) throw new CanvasError('仅参考生视频使用 referenceExclusions', 409, 'AGENT_REFERENCE_INVALID')
  return { ...(model.kind === 'video' ? { videoMode: params.videoMode ?? 'text' } : {}),
    referenceCoverage: referenceMode ? referenceCoverage(state, ids, exclusions, model) : [],
    references: edges.map((edge) => promptReference(state, edge)) }
}
