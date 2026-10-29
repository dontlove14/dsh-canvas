import type { GenerationParams } from '../shared/contracts'
import { seedanceFrameParams } from '../shared/seedance'
import { UiSelect } from './ui'

export function assignFrameRole(params: GenerationParams, id: string, role: string): GenerationParams {
  const { firstFrameId, lastFrameId, ...rest } = params
  return { ...rest,
    ...(firstFrameId && firstFrameId !== id && role !== 'first' ? { firstFrameId } : {}),
    ...(lastFrameId && lastFrameId !== id && role !== 'last' ? { lastFrameId } : {}),
    ...(role === 'first' ? { firstFrameId: id } : role === 'last' ? { lastFrameId: id } : {}) }
}
export function SeedanceFrameRole({ assetId, index, referenceIds, params, disabled, onChange }: {
  assetId: string; index: number; referenceIds: readonly string[]; params: GenerationParams; disabled: boolean; onChange: (params: GenerationParams) => void
}) {
  return <UiSelect className="dc-frame-role" label={`图片 ${index + 1} 的帧用途`} disabled={disabled || referenceIds.length < 2}
    value={params.firstFrameId === assetId ? 'first' : 'last'}
    options={[{ value: 'first', label: '首帧' }, { value: 'last', label: '尾帧' }]}
    onChange={(role) => onChange(seedanceFrameParams(assignFrameRole(params, assetId, role), referenceIds))} />
}
