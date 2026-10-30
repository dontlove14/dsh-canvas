import type { Asset, CanvasGraph, GenerationParams, ModelCapabilities, ModelRecord, PublicModel } from './contracts'
import { isMultimodalVideo, WAN_VIDEO_LIMITS, MINIMAX_VIDEO_LIMITS } from './modelCatalog'
import { seedanceGenerationParams, seedanceReferenceLimit, validateSeedanceConnections, validateSeedanceInputs } from './seedance'

type VideoModel = Pick<ModelRecord, 'protocol' | 'model_id'>
/** Native video families share mode inference while retaining their own wire protocol. */
export function videoGenerationParams(params: GenerationParams, ids: readonly string[], model: VideoModel): GenerationParams {
  const next = isMultimodalVideo(model) ? seedanceGenerationParams(params, ids) : params
  if (model.protocol !== 'minimax-video' || videoSizeAllowed(model, next, next.size.split('/')[1])) return next
  return { ...next, size: `${next.size.split('/')[0]}/${next.videoMode === 'frames' ? 'adaptive' : '16:9'}` }
}
export function videoSizeAllowed(model: VideoModel, params: GenerationParams, ratio: string): boolean {
  if (model.protocol === 'minimax-video') return params.videoMode === 'frames' ? ratio === 'adaptive'
    : (params.videoMode ?? 'text') === 'text' || model.model_id === 'MiniMax-H3-Lite' ? ratio !== 'adaptive' : true
  return model.protocol !== 'seedance-video' || !model.model_id.includes('-2-5-') || params.videoMode !== 'frames' || ratio === 'adaptive'
}
export function videoInputCapabilities(model: PublicModel, params: GenerationParams | null): ModelCapabilities {
  if (!isMultimodalVideo(model)) return model.capabilities
  return { ...model.capabilities, referenceKinds: params?.videoMode === 'frames' ? ['image'] : model.capabilities.referenceKinds,
    maxReferences: params?.videoMode === 'frames' ? 2 : model.capabilities.maxReferences }
}
export function videoReferenceLimit(kind: Asset['kind'], protocol: string): number {
  if (protocol === 'seedance-video') return seedanceReferenceLimit(kind)
  const limits = protocol === 'minimax-video' ? MINIMAX_VIDEO_LIMITS : WAN_VIDEO_LIMITS
  return ({ image: limits.imageMB, video: limits.videoMB, audio: limits.audioMB }[kind]) * 1024 * 1024
}
export function validateVideoConnections(params: GenerationParams, assets: readonly Asset[], model: VideoModel): void {
  if (model.protocol === 'seedance-video') return validateSeedanceConnections(params, assets, model.model_id)
  if (!isMultimodalVideo(model)) return
  const mode = params.videoMode ?? 'text', limits = model.protocol === 'minimax-video' ? MINIMAX_VIDEO_LIMITS : WAN_VIDEO_LIMITS
  if (mode === 'text' && assets.length) throw new Error('文生视频不接受素材，请切换到参考或首尾帧模式')
  if (mode === 'frames' && (assets.length > 2 || assets.some((asset) => asset.kind !== 'image')))
    throw new Error('首尾帧模式最多连接两张图片，不能混用音频或视频')
  if (mode === 'reference') for (const kind of ['image', 'video', 'audio'] as const) {
    const maximum = { image: limits.images, video: limits.videos, audio: limits.audios }[kind]
    if (assets.filter((asset) => asset.kind === kind).length > maximum)
      throw new Error(`参考模式最多接受 ${maximum} 份${{ image: '图片', video: '视频', audio: '音频' }[kind]}`)
  }
}
export function validateVideoInputs(params: GenerationParams, assets: readonly Asset[], model: VideoModel): void {
  if (model.protocol === 'seedance-video') return validateSeedanceInputs(params, assets, model.model_id)
  validateVideoConnections(params, assets, model)
  const mode = params.videoMode ?? 'text', limits = model.protocol === 'minimax-video' ? MINIMAX_VIDEO_LIMITS : WAN_VIDEO_LIMITS
  if (mode !== 'frames' && (params.firstFrameId || params.lastFrameId)) throw new Error('参考与首尾帧模式不能混用')
  if (mode === 'reference' && !assets.length) throw new Error('请连接至少一份参考素材')
  if (mode === 'frames') {
    if (!assets.length || !params.firstFrameId || !assets.some((asset) => asset.id === params.firstFrameId)) throw new Error('请连接图片并指定首帧')
    if (params.lastFrameId && (params.lastFrameId === params.firstFrameId || !assets.some((asset) => asset.id === params.lastFrameId)))
      throw new Error('首帧和尾帧需分别指定已连接的图片')
    if (assets.length === 2 && !params.lastFrameId) throw new Error('请为第二张图片指定尾帧')
  }
  if (!videoSizeAllowed(model, params, params.size.split('/')[1])) throw new Error('当前视频模式不支持这个比例')
  for (const asset of assets) {
    if (asset.bytes > videoReferenceLimit(asset.kind, model.protocol)) throw new Error('视频参考素材超过单文件大小限制')
    if (asset.kind === 'audio' && !['audio/wav', 'audio/mpeg'].includes(asset.mime)) throw new Error('参考音频仅支持 WAV、MP3')
    if (asset.kind === 'video' && !['video/mp4', 'video/quicktime'].includes(asset.mime)) throw new Error('参考视频仅支持 MP4、MOV')
    if (model.protocol === 'minimax-video' && asset.kind !== 'audio' && asset.width && asset.height
      && (asset.width < 256 || asset.width > 5760 || asset.height < 256 || asset.height > 5760
        || asset.width / asset.height < .4 || asset.width / asset.height > 2.5))
      throw new Error('MiniMax H3 参考画面宽高需在256至5760像素、比例在2:5至5:2之间')
    if (asset.kind !== 'image' && asset.duration !== undefined
      && (model.protocol === 'minimax-video' ? asset.duration < 2 || asset.duration > limits.totalDuration : asset.duration <= 0 || asset.duration > limits.totalDuration))
      throw new Error('参考音视频时长超出当前模型限制')
  }
  for (const kind of ['audio', 'video'] as const) {
    const total = assets.filter((asset) => asset.kind === kind).reduce((sum, asset) => sum + (asset.duration ?? 0), 0)
    if (total > limits.totalDuration) throw new Error('参考音视频同类总时长不能超过15秒')
    if (kind === 'video' && model.protocol === 'wan-video' && total + (params.seconds ?? 0) > 30)
      throw new Error('Wan 输入视频与输出视频总时长不能超过30秒')
  }
}
/** Reference changes and mode inference commit together; position-only edits stay untouched. */
export function normalizeVideoGraphReferences(previous: CanvasGraph, next: CanvasGraph, models: readonly PublicModel[]): CanvasGraph {
  if (previous.edges === next.edges) return next
  const byId = new Map(models.filter(isMultimodalVideo).map((model) => [model.id, model]))
  const references = (graph: CanvasGraph) => {
    const byTarget = new Map<string, string[]>()
    for (const edge of graph.edges) {
      const ids = byTarget.get(edge.target) ?? []
      ids.push(edge.assetId); byTarget.set(edge.target, ids)
    }
    return byTarget
  }
  const oldReferences = references(previous), newReferences = references(next)
  let changed = false
  const nodes = next.nodes.map((node) => {
    const model = node.modelId && byId.get(node.modelId)
    if (node.kind !== 'video-generation' || !model || !node.params || 'type' in node.params) return node
    const before = oldReferences.get(node.id) ?? [], after = newReferences.get(node.id) ?? []
    if (before.length === after.length && before.every((id, index) => id === after[index])) return node
    const params = videoGenerationParams(videoGenerationParams(node.params, before, model), after, model)
    if (params === node.params) return node
    changed = true; return { ...node, params }
  })
  return changed ? { ...next, nodes } : next
}
