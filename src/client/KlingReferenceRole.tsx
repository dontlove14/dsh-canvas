import type { Asset, GenerationParams } from '../shared/contracts'
import { KLING_IMAGE_ROLES, KLING_VIDEO_ROLES, klingRole, type KlingRole } from '../shared/kling'
import { UiSelect } from './ui'

export function KlingReferenceRole({ asset, index, params, disabled, onChange }: {
  asset: Asset; index: number; params: GenerationParams; disabled: boolean; onChange: (params: GenerationParams) => void
}) {
  return <UiSelect className="dc-frame-role" label={`素材 ${index + 1} 的 Kling 用途`} disabled={disabled} side="top"
    value={klingRole(params, asset)} options={asset.kind === 'image' ? KLING_IMAGE_ROLES : KLING_VIDEO_ROLES}
    onChange={(role) => onChange({ ...params, klingReferenceRoles: { ...params.klingReferenceRoles, [asset.id]: role as KlingRole } })} />
}
