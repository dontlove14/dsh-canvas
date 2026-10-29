import type { GenerationParams, PublicModel } from '../shared/contracts'

export interface SizeChoice { size: string; resolution: string; ratio: string; width: number; height: number }
const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a
export function sizeChoices(model: PublicModel): SizeChoice[] {
  if (model.capabilities.sizePresets) return model.capabilities.sizePresets.map((preset) => ({ ...preset }))
  return model.capabilities.sizes.map((size) => {
    const [width, height] = size.split('x').map(Number)
    const factor = gcd(width, height)
    const resolution = model.kind === 'video' ? `${Math.min(width, height)}p`
      : Math.max(width, height) <= 1088 ? '1K' : Math.max(width, height) <= 2176 ? '2K' : Math.max(width, height) <= 4352 ? '4K' : `${Math.max(width, height)}px`
    return { size, resolution, ratio: `${width / factor}:${height / factor}`, width, height }
  })
}
export function chooseResolution(choices: readonly SizeChoice[], current: string, resolution: string): string {
  const ratio = choices.find((choice) => choice.size === current)?.ratio
  return (choices.find((choice) => choice.resolution === resolution && choice.ratio === ratio)
    ?? choices.find((choice) => choice.resolution === resolution))?.size ?? current
}
/** Sort paired nominal ratios without changing capability order or resolution fallbacks. */
export function ratioChoices(choices: readonly SizeChoice[], resolution: string | undefined): SizeChoice[] {
  return [...new Map(choices.filter((choice) => choice.resolution === resolution).map((choice) => [choice.ratio, choice])).values()]
    .sort((a, b) => {
      const [aw, ah] = a.ratio.split(':').map(Number), [bw, bh] = b.ratio.split(':').map(Number)
      return Math.min(aw, ah) - Math.min(bw, bh) || Math.max(aw, ah) - Math.max(bw, bh) || aw - bw
    })
}
export function paramsSummary(model: PublicModel, params: GenerationParams): string {
  const choice = sizeChoices(model).find((choice) => choice.size === params.size)
  return [choice?.ratio === 'adaptive' ? '自动比例' : choice?.ratio ?? params.size, choice?.resolution, `${params.n}${model.kind === 'video' ? '条' : '张'}`,
    ...(model.kind === 'video' ? [`${params.seconds}秒`] : [])].filter(Boolean).join(' · ')
}
