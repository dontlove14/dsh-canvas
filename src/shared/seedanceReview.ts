import { z } from 'zod'

export const ReviewProviderSchema = z.enum(['bytedance', 'byteplus'])
export type ReviewProvider = z.infer<typeof ReviewProviderSchema>
export const REVIEW_PROVIDERS = [
  { id: 'bytedance', label: 'Bytedance', host: 'ark.cn-beijing.volcengineapi.com', region: 'cn-beijing',
    consoleUrl: 'https://ark.volcengine.com/region:cn-beijing/experience/gen_video?model=doubao-seedance-2-0-260128' },
  { id: 'byteplus', label: 'BytePlus', host: 'ark.ap-southeast-1.byteplusapi.com', region: 'ap-southeast-1',
    consoleUrl: 'https://ai.byteplus.com/ark/region:ap-southeast-1/experience/gen_video?model=dreamina-seedance-2-0-260128' },
] as const

const credential = z.string().trim().min(1).max(512)
export const ReviewSettingsInputSchema = z.object({
  provider: ReviewProviderSchema,
  revision: z.number().int().nonnegative(),
  projectName: z.string().trim().min(1).max(512).optional(),
  accessKeyId: credential.optional(),
  accessKeySecret: credential.optional(),
}).strict().refine((input) => (input.accessKeyId === undefined) === (input.accessKeySecret === undefined), {
  message: 'AK 和 SK 必须同时填写；留空保留原凭据', path: ['accessKeySecret'],
})
export type ReviewSettingsInput = z.infer<typeof ReviewSettingsInputSchema>

export interface PublicReviewProfile {
  id: string
  provider: ReviewProvider
  revision: number
  configured: boolean
  projectNameMask: string
  accessKeyIdMask: string
  accessKeySecretMask: string
}
export interface ReviewSettings { profiles: PublicReviewProfile[] }

export const ReviewGroupTypeSchema = z.enum(['AIGC', 'LivenessFace'])
export type ReviewGroupType = z.infer<typeof ReviewGroupTypeSchema>
export const ReviewGroupIdSchema = z.string().regex(/^group-[A-Za-z0-9-]+$/i).max(256)
export const ReviewAssetIdSchema = z.string().regex(/^asset-[A-Za-z0-9-]+$/i).max(256)
export const ReviewSubmitSchema = z.object({
  requestId: z.string().uuid(),
  assetId: z.string().uuid(),
  provider: ReviewProviderSchema,
  groupType: ReviewGroupTypeSchema.default('AIGC'),
  groupId: ReviewGroupIdSchema.optional(),
}).strict().refine((input) => input.groupType !== 'LivenessFace' || !!input.groupId, {
  message: '真人素材请选择已完成认证的人物组', path: ['groupId'],
}).refine((input) => input.groupType !== 'AIGC' || !input.groupId, {
  message: '虚拟素材使用当前画布的素材组', path: ['groupId'],
})
export type ReviewSubmit = z.infer<typeof ReviewSubmitSchema>

export const ReviewStatusSchema = z.enum(['queued', 'preparing', 'submitting', 'processing', 'active', 'failed', 'unknown', 'abandoned'])
export type ReviewStatus = z.infer<typeof ReviewStatusSchema>
export const REVIEW_BUSY = new Set<ReviewStatus>(['queued', 'preparing', 'submitting', 'processing'])
export const ReviewStatusLabels: Record<ReviewStatus, string> = {
  queued: '审核中', preparing: '审核中', submitting: '审核中', processing: '审核中',
  active: '审核通过', failed: '预审失败', unknown: '待确认', abandoned: '已结束本地等待',
}
export interface PublicReview {
  id: string
  requestId: string
  canvasId: string
  assetId: string
  provider: ReviewProvider
  profileId: string
  groupType: ReviewGroupType
  status: ReviewStatus
  stage: string
  providerAssetId?: string
  groupId?: string
  errorCode?: string
  errorMessage?: string
  createdAt: number
  updatedAt: number
}
export interface ReviewPage { items: PublicReview[]; revision: number; busy: boolean }
export interface PublicReviewGroup {
  id: string
  name: string
  groupType: ReviewGroupType
}
export interface ReviewGroups {
  provider: ReviewProvider
  items: PublicReviewGroup[]
  nextToken?: string
}

/** Source choice is pinned at generation acceptance; a later review cannot change that task. */
export interface PinnedReviewReference {
  assetId: string
  sha256: string
  source: 'url' | 'asset'
  providerAssetId?: string
  reviewId?: string
  profileId?: string
  groupId?: string
}

export const ReviewActionSchema = z.object({
  action: z.enum(['resume', 'reconcile', 'retry', 'abandon']),
  requestId: z.string().uuid().optional(),
}).strict().refine((input) => input.action !== 'retry' || !!input.requestId, {
  message: '重新送审需要新的请求 ID', path: ['requestId'],
})
