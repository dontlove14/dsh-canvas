/** Built-in identities and wire values. No credentials or persisted graph fields. */
export const PROVIDERS = [
  { id: 'model-link', label: 'Model Link', apiBase: 'https://api.modellink.online/v1' },
  { id: 'openai', label: 'OpenAI', apiBase: 'https://api.openai.com/v1' },
  { id: 'model-link', label: 'Model Link', apiBase: 'https://api.modellink.online' },
  { id: 'gemini', label: 'Gemini', apiBase: 'https://generativelanguage.googleapis.com' },
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
const bananaModels = BANANA_MODELS.flatMap((model, index) => PROVIDERS.slice(2).map((provider, channel) => ({
  id: `00000000-0000-4000-b000-${(index * 2 + channel + 5).toString(16).padStart(12, '0')}`,
  kind: 'image' as const, name: model.name, model_id: model.id, api_base: provider.apiBase, protocol: 'gemini-image' as const,
})))
export const BUILTIN_MODELS = [...gptModels, ...bananaModels]
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
export function builtinDefinition(model: { model_id: string; api_base: string; protocol: string; kind: string }) {
  return BUILTIN_MODELS.find((item) => item.model_id === model.model_id && item.api_base === model.api_base
    && item.protocol === model.protocol && item.kind === model.kind)
}
export function providerFor(model: { api_base: string }) {
  return PROVIDERS.find((provider) => provider.apiBase === model.api_base)
}
