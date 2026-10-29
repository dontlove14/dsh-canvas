/** Built-in identities and wire values. No credentials or persisted graph fields. */
export const PROVIDERS = [
  { id: 'model-link', label: 'Model Link', apiBase: 'https://api.modellink.online/v1' },
  { id: 'openai', label: 'OpenAI', apiBase: 'https://api.openai.com/v1' },
  { id: 'model-link', label: 'Model Link', apiBase: 'https://api.modellink.online' },
  { id: 'gemini', label: 'Gemini', apiBase: 'https://generativelanguage.googleapis.com' },
  { id: 'bytedance', label: 'ByteDance', apiBase: 'https://ark.cn-beijing.volces.com/api/v3' },
  { id: 'byteplus', label: 'BytePlus', apiBase: 'https://ark.ap-southeast.bytepluses.com/api/v3' },
  { id: 'model-link', label: 'Model Link', apiBase: 'https://api.modellink.online/seedance/api/v3' },
] as const
export const IMAGE_MODELS = [
  { id: 'gpt-image-2.5-sunburst', name: 'GPT Image 2.5 Sunburst' },
  { id: 'gpt-image-2.5-flare', name: 'GPT Image 2.5 Flare' },
] as const
export const BANANA_MODELS = [
  { id: 'gemini-3-pro-image', name: 'Nano Banana Pro' },
  { id: 'gemini-3.1-flash-image', name: 'Nano Banana 2' },
  { id: 'gemini-3.1-flash-lite-image', name: 'Nano Banana 2 Lite' },
  { id: 'gemini-nano-banana-2.1', name: 'Nano Banana 2.1' },
] as const
const gptModels = IMAGE_MODELS.flatMap((model, index) => PROVIDERS.slice(0, 2).map((provider, channel) => ({
  id: `00000000-0000-4000-b000-00000000000${index * 2 + channel + 1}`,
  kind: 'image' as const, name: model.name, model_id: model.id, api_base: provider.apiBase, protocol: 'openai-image' as const,
})))
const bananaModels = BANANA_MODELS.flatMap((model, index) => PROVIDERS.slice(2, 4).map((provider, channel) => ({
  id: `00000000-0000-4000-b000-${(index * 2 + channel + 5).toString(16).padStart(12, '0')}`,
  kind: 'image' as const, name: model.name, model_id: model.id, api_base: provider.apiBase, protocol: 'gemini-image' as const,
})))
export const SEEDREAM_MODELS = [
  { id: 'doubao-seedream-5-0-260128', name: 'Seedream 5.0 Lite' },
  { id: 'doubao-seedream-5-0-pro-260628', name: 'Seedream 5.0 Pro' },
  { id: 'dola-seedream-5-0-260128', name: 'Dola Seedream 5.0 Lite' },
  { id: 'dola-seedream-5-0-pro-260628', name: 'Dola Seedream 5.0 Pro' },
] as const
const seedreamModels = SEEDREAM_MODELS.flatMap((model, index) =>
  (index < 2 ? [PROVIDERS[0], PROVIDERS[4]] : [PROVIDERS[5]]).map((provider, channel) => ({
    id: `00000000-0000-4000-b000-${(13 + (index < 2 ? index * 2 + channel : index + 2)).toString(16).padStart(12, '0')}`,
    kind: 'image' as const, name: model.name, model_id: model.id, api_base: provider.apiBase, protocol: 'seedream-image' as const,
  })))
export const SEEDANCE_MODELS = [
  { id: 'doubao-seedance-2-0-260128', name: 'Doubao Seedance 2.0' },
  { id: 'doubao-seedance-2-0-mini-260615', name: 'Doubao Seedance 2.0 mini' },
  { id: 'doubao-seedance-2-0-fast-260128', name: 'Doubao Seedance 2.0 fast' },
  { id: 'doubao-seedance-2-5-260628', name: 'Doubao Seedance 2.5' },
  { id: 'dreamina-seedance-2-0-260128', name: 'Dreamina Seedance 2.0' },
  { id: 'dreamina-seedance-2-0-mini-260615', name: 'Dreamina Seedance 2.0 mini' },
  { id: 'dreamina-seedance-2-0-fast-260128', name: 'Dreamina Seedance 2.0 fast' },
  { id: 'dreamina-seedance-2-5-260628', name: 'Dreamina Seedance 2.5' },
] as const
const seedanceModels = SEEDANCE_MODELS.flatMap((model, index) =>
  (index < 4 ? [PROVIDERS[6], PROVIDERS[4]] : [PROVIDERS[5]]).map((provider, channel) => ({
    id: `00000000-0000-4000-b000-${(19 + (index < 4 ? index * 2 + channel : index + 4)).toString(16).padStart(12, '0')}`,
    kind: 'video' as const, name: model.name, model_id: model.id, api_base: provider.apiBase, protocol: 'seedance-video' as const,
  })))
export const BUILTIN_MODELS = [...gptModels, ...bananaModels, ...seedreamModels, ...seedanceModels]
const previousSeedreamIds: Readonly<Record<string, string>> = {
  'doubao-seedream-5-0-lite-260628': 'doubao-seedream-5-0-260128',
  'dola-seedream-5-0-lite-260628': 'dola-seedream-5-0-260128',
}
/** Correct only shipped Lite configurations; retain UUID, EP and credential binding. */
export function correctSeedreamModelId<T extends { id: string; name: string; model_id: string; protocol: string; api_base: string; kind: string }>(model: T): T {
  const model_id = previousSeedreamIds[model.model_id]
  const definition = model_id && BUILTIN_MODELS.find((item) => item.id === model.id && item.model_id === model_id
    && item.name === model.name && item.protocol === model.protocol && item.api_base === model.api_base && item.kind === model.kind)
  return definition ? { ...model, model_id } : model
}
export const IMAGE_BACKGROUNDS = [
  { value: 'auto', label: '自动' }, { value: 'opaque', label: '不透明' }, { value: 'transparent', label: '透明' },
] as const
export const IMAGE_QUALITIES = [
  { value: 'auto', label: '自动' }, { value: 'low', label: '低' }, { value: 'medium', label: '中' },
  { value: 'high', label: '高' }, { value: 'xhigh', label: '超高' }, { value: 'max', label: '最高' },
] as const
export interface ImageSizePreset { size: string; resolution: string; ratio: string; width: number; height: number }
const ratios = [[1, 1], [16, 9], [9, 16], [4, 3], [3, 4], [3, 2], [2, 3], [4, 5], [5, 4], [21, 9]] as const
// Wide 1K presets need a longer edge to meet the model's minimum pixel count.
const wideOneKSizes: Readonly<Record<string, readonly [number, number]>> = {
  '16:9': [1280, 720], '9:16': [720, 1280], '21:9': [1344, 576],
}
export function validGptImageSize(width: number, height: number): boolean {
  return width > 0 && height > 0 && width % 16 === 0 && height % 16 === 0
    && Math.max(width, height) <= 3840 && Math.max(width, height) / Math.min(width, height) <= 3
    && width * height >= 655360 && width * height <= 8294400
}
/** Named resolution tiers; preserve existing sizes and use legal wide 1K presets. */
export const GPT_IMAGE_SIZES: readonly ImageSizePreset[] = [
  { resolution: '1K', side: 1024 }, { resolution: '2K', side: 2048 }, { resolution: '4K', side: 3840 },
].flatMap(({ resolution, side }) => ratios.map(([w, h]) => {
  const ratio = `${w}:${h}`
  const wideSize = resolution === '1K' ? wideOneKSizes[ratio] : undefined
  const width = wideSize?.[0] ?? Math.round(side * w / Math.max(w, h) / 16) * 16
  const height = wideSize?.[1] ?? Math.round(side * h / Math.max(w, h) / 16) * 16
  return { size: `${width}x${height}`, resolution, ratio, width, height }
})).filter(({ width, height }) => validGptImageSize(width, height))

export function isGptImage25(model: { model_id: string; protocol: string }): boolean {
  return model.protocol === 'openai-image' && IMAGE_MODELS.some((item) => item.id === model.model_id)
}
/** Nominal output dimensions from Google's image-generation table; wire uses ratio/tier. */
const bananaOneK = [
  ['1:1', 1024, 1024], ['2:3', 848, 1264], ['3:2', 1264, 848],
  ['3:4', 896, 1200], ['4:3', 1200, 896], ['4:5', 928, 1152],
  ['5:4', 1152, 928], ['9:16', 768, 1376], ['16:9', 1376, 768], ['21:9', 1584, 672],
] as const
export function bananaSizePresets(modelId: string): readonly ImageSizePreset[] {
  const tiers: Array<[string, number]> = modelId === 'gemini-3.1-flash-lite-image' ? [['1K', 1]]
    : modelId === 'gemini-3.1-flash-image' ? [['0.5K', .5], ['1K', 1], ['2K', 2], ['4K', 4]]
    : [['1K', 1], ['2K', 2], ['4K', 4]]
  return tiers.flatMap(([resolution, factor]) => bananaOneK.map(([ratio, w, h]) => {
    const width = w * factor, height = resolution === '0.5K' && ratio === '21:9' ? 168 : h * factor
    return { size: `${width}x${height}`, resolution, ratio, width, height }
  }))
}
export function isBananaImage(model: { model_id: string; protocol: string }): boolean {
  return model.protocol === 'gemini-image' && BANANA_MODELS.some((item) => item.id === model.model_id)
}
export function isSeedreamImage(model: { model_id: string; protocol: string }): boolean {
  return model.protocol === 'seedream-image' && (SEEDREAM_MODELS.some((item) => item.id === model.model_id) || !!previousSeedreamIds[model.model_id])
}
export function seedreamRequiresEndpoint(model: { protocol: string; api_base: string }): boolean {
  return model.protocol === 'seedream-image' && ['bytedance', 'byteplus'].includes(providerFor(model)?.id ?? '')
}
export function seedanceRequiresEndpoint(model: { protocol: string; api_base: string }): boolean {
  return model.protocol === 'seedance-video' && ['bytedance', 'byteplus'].includes(providerFor(model)?.id ?? '')
}
export function modelRequiresEndpoint(model: { protocol: string; api_base: string }): boolean {
  return seedreamRequiresEndpoint(model) || seedanceRequiresEndpoint(model)
}
export function modelConfigured(model: { protocol: string; api_base: string; endpoint_id?: string; has_api_key: boolean }): boolean {
  return model.has_api_key && (!modelRequiresEndpoint(model) || !!model.endpoint_id)
}
export function seedanceLimits(modelId: string) {
  const newer = modelId.includes('-2-5-')
  return { images: newer ? 30 : 9, videos: newer ? 10 : 3, audios: newer ? 10 : 3,
    duration: newer ? 30 : 15, audioOnly: newer }
}
export const SEEDANCE_VIDEO_MODES = [
  { value: 'text', label: '文生视频' },
  { value: 'reference', label: '参考生视频' },
  { value: 'frames', label: '首尾帧生成' },
] as const
/** Wire resolution/ratio, rather than fabricated output dimensions (adaptive varies). */
export function seedanceSizePresets(modelId: string): readonly ImageSizePreset[] {
  const resolutions = modelId.includes('-mini-') || modelId.includes('-fast-') ? ['480p', '720p']
    : modelId.includes('-2-5-') ? ['480p', '720p', '1080p'] : ['480p', '720p', '1080p', '4k']
  const ratios = [[1, 1], [4, 3], [3, 4], [16, 9], [9, 16], [21, 9]] as const
  return resolutions.flatMap((resolution) => [
    ...ratios.map(([width, height]) => ({ resolution, ratio: `${width}:${height}`, size: `${resolution}/${width}:${height}`, width, height })),
    { resolution, ratio: 'adaptive', size: `${resolution}/adaptive`, width: 16, height: 9 },
  ])
}
const seedreamRatios = ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3', '21:9'] as const
// Explicit official presets: a tier is a pixel budget, not the longest edge.
const seedreamProSizes = [
  ['1K', [[1024, 1024], [1152, 864], [864, 1152], [1424, 800], [800, 1424], [1248, 832], [832, 1248], [1568, 672]]],
  ['1.5K', [[1536, 1536], [1792, 1344], [1344, 1792], [2048, 1152], [1152, 2048], [1872, 1248], [1248, 1872], [2352, 1008]]],
  ['2K', [[2048, 2048], [2368, 1776], [1776, 2368], [2816, 1584], [1584, 2816], [2496, 1664], [1664, 2496], [3136, 1344]]],
] as const
const seedreamLiteSizes = [
  ['2K', [[2048, 2048], [2304, 1728], [1728, 2304], [2848, 1600], [1600, 2848], [2496, 1664], [1664, 2496], [3136, 1344]]],
  ['3K', [[3072, 3072], [3456, 2592], [2592, 3456], [4096, 2304], [2304, 4096], [3744, 2496], [2496, 3744], [4704, 2016]]],
  ['4K', [[4096, 4096], [4704, 3520], [3520, 4704], [5504, 3040], [3040, 5504], [4992, 3328], [3328, 4992], [6240, 2656]]],
] as const
export function seedreamSizePresets(modelId: string): readonly ImageSizePreset[] {
  if (!SEEDREAM_MODELS.some((model) => model.id === modelId) && !previousSeedreamIds[modelId]) return []
  return (modelId.includes('-pro-') ? seedreamProSizes : seedreamLiteSizes).flatMap(([resolution, sizes]) =>
    sizes.map(([width, height], index) => ({ size: `${width}x${height}`, resolution, ratio: seedreamRatios[index], width, height })))
}
export function builtinDefinition(model: { model_id: string; api_base: string; protocol: string; kind: string }) {
  return BUILTIN_MODELS.find((item) => item.model_id === model.model_id && item.api_base === model.api_base
    && item.protocol === model.protocol && item.kind === model.kind)
}
export function providerFor(model: { api_base: string }) {
  return PROVIDERS.find((provider) => provider.apiBase === model.api_base)
}
