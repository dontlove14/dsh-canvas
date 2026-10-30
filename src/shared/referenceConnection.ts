import { isGeneration, isTtsParams, validateGraph, type Asset, type CanvasGraph, type PublicModel, type Task } from './contracts'
import { isMultimodalVideo } from './modelCatalog'
import { videoGenerationParams, videoInputCapabilities, validateVideoConnections } from './video'

/** Shared admission rule for manual wiring and Agent tools; references keep exact asset identities. */
export function connectAssetReference(graph: CanvasGraph, sourceId: string, targetId: string, assetId: string,
  assets: readonly Asset[], tasks: readonly Pick<Task, 'nodeId' | 'resultIds'>[], models: readonly PublicModel[], edgeId: string = crypto.randomUUID()): CanvasGraph {
  const target = graph.nodes.find((node) => node.id === targetId)
  const asset = assets.find((asset) => asset.id === assetId)
  if (!target || !asset || !isGeneration(target.kind)) throw new Error('请从已有素材连接到生成节点')
  if (target.kind === 'tts-generation') throw new Error('语音生成节点不支持输入连线')
  const model = models.find((item) => item.id === target.modelId)
  if (asset.kind === 'image' && !['image/png', 'image/jpeg', 'image/webp'].includes(asset.mime))
    throw new Error('当前协议的参考图仅支持 PNG、JPEG 和 WebP')
  const previousIds = graph.edges.filter((edge) => edge.target === target.id).map((edge) => edge.assetId)
  const params = target.params && !isTtsParams(target.params) && model && isMultimodalVideo(model)
    ? videoGenerationParams(target.params, previousIds, model) : target.params
  const caps = model && videoInputCapabilities(model, !isTtsParams(params) ? params : null)
  if (caps && (!caps.referenceKinds.includes(asset.kind) || previousIds.length >= caps.maxReferences))
    throw new Error('当前模型不支持这份素材，或引用数量已达上限')
  if (!model && asset.kind !== 'image') throw new Error('请先配置支持这类素材的模型')
  const next = { ...graph, edges: [...graph.edges, { id: edgeId, source: sourceId, target: target.id, assetId: asset.id }] }
  if (model && isMultimodalVideo(model) && params && !isTtsParams(params)) {
    const inputs = next.edges.filter((edge) => edge.target === target.id).map((edge) => assets.find((asset) => asset.id === edge.assetId))
    if (inputs.some((asset) => !asset)) throw new Error('引用素材不可用')
    validateVideoConnections(videoGenerationParams(params, [...previousIds, asset.id], model), inputs as Asset[], model)
  }
  validateGraph(next, assets, tasks)
  return next
}
