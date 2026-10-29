import { useEffect, useRef, useState } from 'react'
import { REVIEW_PROVIDERS, type PublicReviewProfile } from '../shared/seedanceReview'
import { CanvasApi } from './api'
import { SecretInput } from './SecretField'
import { UiButton } from './ui'

export function SeedanceReviewSettings({ api, onChanged }: { api: CanvasApi; onChanged?: () => void }) {
  const [profiles, setProfiles] = useState<PublicReviewProfile[]>([])
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)
  const request = useRef<AbortController>()
  const load = () => {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setError('')
    void api.reviewSettings(controller.signal).then((value) => {
      if (!controller.signal.aborted) { setProfiles(value.profiles); setLoaded(true) }
    }).catch(() => { if (!controller.signal.aborted) setError('预审配置读取失败，请重试') })
  }
  useEffect(() => { load(); return () => request.current?.abort() }, [api])
  return <section className="dc-settings dc-review-settings" aria-label="Seedance 预审设置">
    <h3>Seedance 预审</h3>
    <div className="dc-review-settings-grid">
      {loaded && REVIEW_PROVIDERS.map((provider) => {
        const profile = profiles.find((item) => item.provider === provider.id)!
        return <ReviewProfileForm key={`${provider.id}:${profile.revision}`} profile={profile} label={provider.label} api={api}
          onSaved={(next) => { setProfiles(next); onChanged?.() }} />
      })}
    </div>
    {error && <p className="dc-error" role="alert">{error} <UiButton onClick={load}>重新读取</UiButton></p>}
  </section>
}
function ReviewProfileForm({ profile, label, api, onSaved }: {
  profile: PublicReviewProfile; label: string; api: CanvasApi; onSaved: (profiles: PublicReviewProfile[]) => void
}) {
  const [projectName, setProjectName] = useState(profile.configured ? '' : 'default')
  const [accessKeyId, setAccessKeyId] = useState('')
  const [accessKeySecret, setAccessKeySecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const gate = useRef(false)
  const valid = profile.configured ? (!!accessKeyId.trim() === !!accessKeySecret.trim()) : !!projectName.trim() && !!accessKeyId.trim() && !!accessKeySecret.trim()
  const run = async (test: boolean) => {
    if (gate.current || (!test && !valid)) return
    gate.current = true; setBusy(true); setError(''); setMessage('')
    try {
      if (test) { await api.testReviewSettings(profile.provider); setMessage('连接验证通过') }
      else {
        const value = await api.saveReviewSettings({ provider: profile.provider, revision: profile.revision,
          ...(projectName.trim() ? { projectName: projectName.trim() } : {}),
          ...(accessKeyId.trim() ? { accessKeyId: accessKeyId.trim(), accessKeySecret: accessKeySecret.trim() } : {}) })
        setProjectName(''); setAccessKeyId(''); setAccessKeySecret(''); onSaved(value.profiles)
      }
    } catch (error) { setError(error instanceof Error ? error.message : '操作失败，请重试') }
    finally { gate.current = false; setBusy(false) }
  }
  return <form className="dc-provider-card dc-review-profile" aria-label={`${label} 预审配置`} onSubmit={(event) => { event.preventDefault(); void run(false) }}>
    <div className="dc-provider-heading"><span className="dc-provider-mark" aria-hidden="true">{profile.provider === 'bytedance' ? 'BD' : 'B+'}</span>
      <h4>{label}</h4><span className={`dc-provider-status ${profile.configured ? 'configured' : ''}`}>{profile.configured ? '已配置' : '未配置'}</span></div>
    {([
      ['projectName', 'ProjectName', projectName, setProjectName, profile.projectNameMask],
      ['accessKeyId', 'AK', accessKeyId, setAccessKeyId, profile.accessKeyIdMask],
      ['accessKeySecret', 'SK', accessKeySecret, setAccessKeySecret, profile.accessKeySecretMask],
    ] as const).map(([field, fieldLabel, value, change, mask]) =>
      <label key={field}>{fieldLabel}<SecretInput label={`${label} ${fieldLabel}`} value={value} maxLength={512} disabled={busy}
        savedMask={mask} placeholder={profile.configured ? `${mask} · 留空保留` : fieldLabel}
        load={profile.configured ? (signal) => api.settingSecret({ scope: 'seedance-review', provider: profile.provider, field }, signal) : undefined}
        onChange={(event) => change(event.target.value)} /></label>)}
    {error && <p className="dc-error" role="alert">{error}</p>}{message && <p className="dc-success" role="status">{message}</p>}
    <div className="dc-form-actions">
      <UiButton variant="outline" disabled={busy || !profile.configured} onClick={() => void run(true)}>测试连接</UiButton>
      <UiButton variant="primary" type="submit" disabled={busy || !valid}>{busy ? '处理中…' : '保存配置'}</UiButton>
    </div>
  </form>
}
