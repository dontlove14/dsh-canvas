import { UPLOAD_CONCURRENCY } from '../shared/uploads'
import { CapsuleBeam, CapsuleStack } from './CapsuleStack'
import type { UploadActivity } from './resumableUploads'

export function UploadCapsules({ uploads }: { uploads: readonly UploadActivity[] }) {
  const visible = uploads.slice(0, UPLOAD_CONCURRENCY)
  const overflow = uploads.length - visible.length
  return <CapsuleStack ids={visible.map((item) => item.id)} overflow={overflow} scope={uploads[0]?.canvas}
    className="dc-upload-capsules" label="文件上传进度">
    {visible.map((upload) => {
      const progress = Math.max(0, Math.min(100, upload.progress))
      const label = `${upload.filename}：${progress}%${upload.waiting ? '，等待自动恢复' : ''}`
      const body = <div className="dc-upload-capsule-body">
        <svg className="dc-upload-ring" viewBox="0 0 24 24" aria-hidden="true">
          <circle className="dc-upload-ring-track" cx="12" cy="12" r="9" />
          <circle className="dc-upload-ring-value" cx="12" cy="12" r="9" pathLength="100"
            strokeDasharray={`${progress} 100`} transform="rotate(-90 12 12)" />
        </svg>
        <span className="dc-upload-percentage">{progress}%</span>
      </div>
      return <div key={upload.id} className="dc-upload-capsule" role="progressbar"
        data-upload-motion-id={upload.id} data-capsule-motion-id={upload.id}
        aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}
        title={upload.error ?? label} data-waiting={upload.waiting || undefined}>
        <CapsuleBeam upload>{body}</CapsuleBeam>
      </div>
    })}
    {overflow > 0 && <div className="dc-capsule-more dc-upload-more" data-upload-motion-id="overflow" data-capsule-motion-id="overflow"
      aria-label={`还有 ${overflow} 个文件等待上传`} title={`还有 ${overflow} 个文件等待上传`}>+{overflow}</div>}
  </CapsuleStack>
}
