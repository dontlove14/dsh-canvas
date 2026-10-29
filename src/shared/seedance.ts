import type { Asset, CanvasGraph, GenerationParams, ModelCapabilities, PublicModel } from './contracts'
import { seedanceLimits } from './modelCatalog'

export function seedanceReferenceLimit(kind: Asset['kind']): number {
  return ({ image: 30, video: 200, audio: 15 }[kind]) * 1024 * 1024
}
/** Default by connection order while retaining valid explicit role changes. */
export function seedanceFrameParams(params: GenerationParams, referenceIds: readonly string[]): GenerationParams {
  if (params.videoMode !== 'frames') return params
  const { firstFrameId, lastFrameId, ...rest } = params
  const tail = referenceIds.includes(lastFrameId ?? '') ? lastFrameId : undefined
  const first = referenceIds.includes(firstFrameId ?? '') ? firstFrameId : referenceIds.find((id) => id !== tail) ?? referenceIds[0]
  const last = tail && tail !== first ? tail : referenceIds.find((id) => id !== first)
  if (first === firstFrameId && last === lastFrameId) return params
  return { ...rest, ...(first ? { firstFrameId: first } : {}), ...(last ? { lastFrameId: last } : {}) }
}
/** Text generation is inferred from no references; only frames require a manual choice. */
export function seedanceGenerationParams(params: GenerationParams, referenceIds: readonly string[]): GenerationParams {
  const mode = referenceIds.length ? params.videoMode === 'frames' ? 'frames' : 'reference' : 'text'
  if (mode === 'frames') return seedanceFrameParams(params, referenceIds)
  if (params.videoMode === mode && !params.firstFrameId && !params.lastFrameId) return params
  const { firstFrameId: _first, lastFrameId: _last, ...rest } = params
  return { ...rest, videoMode: mode }
}
/** Update only affected video nodes when edges change; dragging stays on the fast path. */
export function normalizeSeedanceGraphReferences(previous: CanvasGraph, next: CanvasGraph, models: readonly Pick<PublicModel, 'id' | 'protocol'>[]): CanvasGraph {
  if (previous.edges === next.edges) return next
  const oldReferences = new Map<string, string[]>(), newReferences = new Map<string, string[]>()
  for (const [graph, references] of [[previous, oldReferences], [next, newReferences]] as const)
    for (const edge of graph.edges) {
      const ids = references.get(edge.target) ?? []
      ids.push(edge.assetId); references.set(edge.target, ids)
    }
  const seedanceIds = new Set(models.filter((model) => model.protocol === 'seedance-video').map((model) => model.id))
  let changed = false
  const nodes = next.nodes.map((node) => {
    if (node.kind !== 'video-generation' || !node.modelId || !seedanceIds.has(node.modelId) || !node.params || 'type' in node.params) return node
    const before = oldReferences.get(node.id) ?? [], after = newReferences.get(node.id) ?? []
    if (before.length === after.length && before.every((id, index) => id === after[index])) return node
    const params = seedanceGenerationParams(seedanceGenerationParams(node.params, before), after)
    if (params === node.params) return node
    changed = true; return { ...node, params }
  })
  return changed ? { ...next, nodes } : next
}
export function seedanceInputCapabilities(model: PublicModel, params: GenerationParams | null): ModelCapabilities {
  if (model.protocol !== 'seedance-video') return model.capabilities
  const mode = params?.videoMode
  return { ...model.capabilities, referenceKinds: mode === 'frames' ? ['image'] : ['image', 'video', 'audio'],
    maxReferences: mode === 'frames' ? 2 : model.capabilities.maxReferences }
}
/** Connection/mode checks do not require a completed prompt or frame assignment. */
export function validateSeedanceConnections(params: GenerationParams, assets: readonly Asset[], modelId: string): void {
  const mode = params.videoMode ?? 'text', limits = seedanceLimits(modelId)
  if (mode === 'text' && assets.length) throw new Error('文生视频不接受素材，请切换到参考或首尾帧模式')
  if (mode === 'frames' && (assets.length > 2 || assets.some((asset) => asset.kind !== 'image')))
    throw new Error('首尾帧模式最多连接两张图片，不能混用音频或视频')
  if (mode === 'reference') for (const kind of ['image', 'video', 'audio'] as const) {
    const maximum = { image: limits.images, video: limits.videos, audio: limits.audios }[kind]
    if (assets.filter((asset) => asset.kind === kind).length > maximum)
      throw new Error(`参考模式最多接受 ${maximum} 份${{ image: '图片', video: '视频', audio: '音频' }[kind]}`)
  }
}
export function validateSeedanceInputs(params: GenerationParams, assets: readonly Asset[], modelId: string): void {
  validateSeedanceConnections(params, assets, modelId)
  const mode = params.videoMode ?? 'text', limits = seedanceLimits(modelId)
  if (mode !== 'frames' && (params.firstFrameId || params.lastFrameId)) throw new Error('参考与首尾帧模式不能混用')
  if (mode === 'reference') {
    if (!assets.length) throw new Error('请连接至少一份参考素材')
    if (!limits.audioOnly && assets.every((asset) => asset.kind === 'audio')) throw new Error('Seedance 2.0 系列需要至少一张图片或一段视频，不能仅参考音频')
  }
  if (mode === 'frames') {
    if (!assets.length || !params.firstFrameId || !assets.some((asset) => asset.id === params.firstFrameId))
      throw new Error('请连接图片并指定首帧')
    if (params.lastFrameId && (!assets.some((asset) => asset.id === params.lastFrameId) || params.firstFrameId === params.lastFrameId))
      throw new Error('首帧和尾帧需分别指定已连接的图片')
    if (assets.length === 2 && !params.lastFrameId) throw new Error('请为第二张图片指定尾帧')
    if (limits.audioOnly && !params.size.endsWith('/adaptive')) throw new Error('Seedance 2.5 首尾帧模式需跟随首帧比例')
  }
  for (const asset of assets) {
    if (asset.bytes > seedanceReferenceLimit(asset.kind)) throw new Error('Seedance 参考素材超过单文件大小限制')
    if (asset.kind === 'audio' && !['audio/wav', 'audio/mpeg'].includes(asset.mime)) throw new Error('Seedance 参考音频仅支持 WAV、MP3')
    if (asset.kind === 'video' && !['video/mp4', 'video/quicktime'].includes(asset.mime)) throw new Error('Seedance 参考视频仅支持 MP4、MOV')
    if (asset.kind !== 'audio' && asset.width && asset.height) {
      if (asset.width < 300 || asset.width > 6000 || asset.height < 300 || asset.height > 6000
        || asset.width / asset.height < .4 || asset.width / asset.height > 2.5) throw new Error('Seedance 参考画面宽高需在300至6000像素、比例在2:5至5:2之间')
      if (asset.kind === 'video' && (asset.width * asset.height < 407696 || asset.width * asset.height > 8295044))
        throw new Error('Seedance 参考视频像素总数超限')
    }
    if (asset.kind !== 'image' && asset.duration !== undefined && (asset.duration < 2 || asset.duration > limits.duration))
      throw new Error(`Seedance 参考${asset.kind === 'video' ? '视频' : '音频'}时长需在2至${limits.duration}秒之间`)
  }
  for (const kind of ['audio', 'video'] as const) if (assets.filter((asset) => asset.kind === kind).reduce((sum, asset) => sum + (asset.duration ?? 0), 0) > limits.duration)
    throw new Error(`Seedance 参考${kind === 'video' ? '视频' : '音频'}总时长不能超过${limits.duration}秒`)
}
