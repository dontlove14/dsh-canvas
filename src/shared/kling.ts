import type { Asset, GenerationParams } from './contracts'
import { promptParts } from './promptMentions'
import { KLING_VIDEO_LIMITS } from './modelCatalog'

export const KLING_IMAGE_ROLES = [
  { value: 'refer_image', label: '参考图片' }, { value: 'first_frame', label: '首帧' },
  { value: 'middle_frame', label: '中间帧' }, { value: 'last_frame', label: '尾帧' },
] as const
export const KLING_VIDEO_ROLES = [
  { value: 'feature_video', label: '特征参考' }, { value: 'base_video', label: '待编辑视频' },
] as const
export type KlingRole = NonNullable<GenerationParams['klingReferenceRoles']>[string]
export function klingRole(params: GenerationParams, asset: Pick<Asset, 'id' | 'kind'>): KlingRole {
  return params.klingReferenceRoles?.[asset.id] ?? (asset.kind === 'video' ? 'feature_video' : 'refer_image')
}
export function klingRoleLabel(role: KlingRole): string {
  return [...KLING_IMAGE_ROLES, ...KLING_VIDEO_ROLES].find((item) => item.value === role)!.label
}
export function klingReferenceId(kind: Asset['kind'], index: number): string { return `${kind}_${index + 1}` }
/** Translate bound tokens once at acceptance; literal text remains literal. */
export function resolveKlingPrompt(prompt: string, ids: readonly string[], assets: readonly Asset[]): string {
  return promptParts(prompt).map((part) => {
    if (part.kind === 'text') return part.value
    const index = ids.indexOf(part.assetId), asset = assets.find((asset) => asset.id === part.assetId)
    if (!asset || index < 0) throw new Error('提示词中的参考素材已丢失或未连接，请重新引用')
    return `@${klingReferenceId(asset.kind, index)}`
  }).join('')
}
export function validateKlingPrompt(prompt: string): void {
  let english = 0, other = 0
  for (const char of prompt) { if (char.codePointAt(0)! <= 127) english++; else other++ }
  if (english / 26000 + other / 11000 > 1) throw new Error('Kling 提示词超限：英文最多26000字符、非英文最多11000字符，混合输入按比例合计')
}
export function klingGenerationParams(params: GenerationParams, ids: readonly string[]): GenerationParams {
  const mode = ids.length ? 'reference' : 'text'
  const roles = params.klingReferenceRoles && Object.fromEntries(Object.entries(params.klingReferenceRoles).filter(([id]) => ids.includes(id)))
  const size = mode === 'text' && params.size.endsWith('/adaptive') ? `${params.size.split('/')[0]}/16:9` : params.size
  if (params.videoMode === mode && !params.firstFrameId && !params.lastFrameId && size === params.size
    && (!params.klingReferenceRoles || Object.keys(roles!).length === Object.keys(params.klingReferenceRoles).length)) return params
  const { firstFrameId: _first, lastFrameId: _last, klingReferenceRoles: _roles, ...rest } = params
  return { ...rest, size, videoMode: mode, ...(roles && Object.keys(roles).length ? { klingReferenceRoles: roles } : {}) }
}
export function validateKlingConnections(params: GenerationParams, assets: readonly Asset[]): void {
  if (params.videoMode === 'frames' || params.firstFrameId || params.lastFrameId)
    throw new Error('Kling 请在 Omni 中选择图片的首帧、中间帧或尾帧用途')
  if ((params.videoMode ?? 'text') === 'text' && assets.length) throw new Error('文生视频不接受素材，请使用 Omni 全能参考')
  if (assets.some((asset) => asset.kind === 'audio')) throw new Error('Kling 不支持音频参考')
  if (assets.length > 15) throw new Error('Kling 最多接受15份素材')
  for (const [kind, maximum] of [['image', KLING_VIDEO_LIMITS.images], ['video', KLING_VIDEO_LIMITS.videos]] as const)
    if (assets.filter((asset) => asset.kind === kind).length > maximum) throw new Error(`Kling 最多接受${maximum}份${kind === 'image' ? '图片' : '视频'}`)
  const byId = new Map(assets.map((asset) => [asset.id, asset]))
  for (const [id, role] of Object.entries(params.klingReferenceRoles ?? {})) {
    const asset = byId.get(id), options = asset?.kind === 'video' ? KLING_VIDEO_ROLES : KLING_IMAGE_ROLES
    if (!asset || !options.some((item) => item.value === role)) throw new Error('Kling 素材用途与已连接的素材类型不匹配')
  }
  for (const role of ['first_frame', 'last_frame', 'base_video'] as const)
    if (assets.filter((asset) => klingRole(params, asset) === role).length > 1) throw new Error(`Kling 最多设置一份${klingRoleLabel(role)}`)
}
export function validateKlingInputs(params: GenerationParams, assets: readonly Asset[]): void {
  validateKlingConnections(params, assets)
  if (params.videoMode === 'reference' && !assets.length) throw new Error('请连接至少一份 Omni 参考素材')
  if ((params.videoMode ?? 'text') === 'text' && params.size.endsWith('/adaptive')) throw new Error('Kling 文生视频请选择明确的画面比例')
  for (const asset of assets) {
    const image = asset.kind === 'image'
    if (!image && !['video/mp4', 'video/quicktime'].includes(asset.mime)) throw new Error('Kling 参考视频仅支持 MP4、MOV')
    if (image && !['image/png', 'image/jpeg'].includes(asset.mime)) throw new Error('Kling 参考图片仅支持 JPG、JPEG、PNG')
    if (asset.bytes > (image ? 30 : 300) * 1024 * 1024) throw new Error(`Kling 参考${image ? '图片' : '视频'}超过单文件大小限制`)
    if (asset.width && asset.height && (asset.width < (image ? 300 : 700) || asset.height < (image ? 300 : 700)
      || asset.width / asset.height < .4 || asset.width / asset.height > 2.5
      || !image && (asset.width > 4553 || asset.height > 4553 || asset.width * asset.height > 8294400)))
      throw new Error(image ? 'Kling 参考图片宽高需至少300像素、比例在2:5至5:2之间'
        : 'Kling 参考视频宽高需在700至4553像素、总像素不超过8294400、比例在2:5至5:2之间')
    if (!image && asset.duration !== undefined && (asset.duration < 3 || asset.duration > 30)) throw new Error('Kling 参考视频时长需在3至30秒之间')
  }
  if (assets.filter((asset) => asset.kind === 'video').reduce((total, asset) => total + (asset.duration ?? 0), 0) > 30)
    throw new Error('Kling 参考视频总时长不能超过30秒')
}
