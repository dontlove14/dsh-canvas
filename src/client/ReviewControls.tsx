import { useContext } from 'react'
import type { Asset } from '../shared/contracts'
import { REVIEW_BUSY, REVIEW_PROVIDERS, ReviewStatusLabels } from '../shared/seedanceReview'
import { ReviewContext, useAssetReviews, useReviewAvailability } from './reviewState'
import { UiButton } from './ui'

export function ReviewIcon({ result }: { result?: 'active' | 'failed' | 'unknown' }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" />
    {result === 'active' ? <path d="m8 12 3 3 5-6" /> : result === 'failed' ? <path d="m9 9 6 6m0-6-6 6" />
      : result === 'unknown' ? <path d="M12 8v5m0 3h.01" /> : <path d="M12 8v8m-4-4h8" />}
  </svg>
}
export function ReviewButton({ asset }: { asset: Asset }) {
  const environment = useContext(ReviewContext)
  const configured = useReviewAvailability()
  const jobs = useAssetReviews(asset.id)
  if (!environment || !configured || REVIEW_PROVIDERS.every((provider) => jobs.some((job) => job.provider === provider.id && job.status === 'active'))) return null
  return <UiButton title="Seedance 预审" aria-label={`Seedance 预审：${asset.filename}`} data-review-asset={asset.id}
    onDoubleClick={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); environment.open(asset) }}><ReviewIcon /></UiButton>
}
export function ReviewBadges({ assetId }: { assetId?: string }) {
  const jobs = useAssetReviews(assetId)
  return <span className="dc-review-badges" data-review-badges={assetId} onDoubleClick={(event) => event.stopPropagation()}>
    {jobs.map((job) => {
      const label = `${job.provider === 'bytedance' ? 'Bytedance' : 'BytePlus'} · ${ReviewStatusLabels[job.status]}`
      const busy = REVIEW_BUSY.has(job.status)
      return <span key={job.provider} className={`dc-review-badge ${job.status}`} role="status" aria-label={label} title={`${label}${job.errorMessage ? `：${job.errorMessage}` : ''}`}>
        <small>{job.provider === 'bytedance' ? 'BD' : 'B+'}</small>
        {busy ? <span>审核中</span> : job.status === 'active' || job.status === 'failed' ? <ReviewIcon result={job.status} />
          : <><ReviewIcon result="unknown" /><span>{job.status === 'unknown' ? '待确认' : '已结束'}</span></>}
      </span>
    })}
  </span>
}
