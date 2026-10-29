import { useContext, useEffect, useRef, useState } from 'react'
import type { Asset } from '../shared/contracts'
import { REVIEW_BUSY, REVIEW_PROVIDERS, type PublicReview, type PublicReviewGroup, type ReviewProvider, type ReviewSettings, type ReviewGroupType } from '../shared/seedanceReview'
import { ReviewContext, useAssetReviews } from './reviewState'
import { UiButton, UiHelp, UiModal, UiSelect } from './ui'

const MATERIAL_PATH_HELP = '虚拟素材 · 本画布组：适用于 AI 虚拟人物、动物、场景等素材，自动使用当前画布的素材组。\n已认证真人素材 · 人物组：适用于已完成官方真人认证的人物素材，需选择对应人物的认证组；选择此项不会自动完成认证。'

export function SeedanceReviewDialog({ asset, onClose, onSettings }: { asset: Asset; onClose: () => void; onSettings: () => void }) {
  const environment = useContext(ReviewContext)!
  const { api, canvas } = environment.state
  const jobs = useAssetReviews(asset.id)
  const [settings, setSettings] = useState<ReviewSettings>()
  const [chosenProvider, setProvider] = useState<ReviewProvider | ''>('')
  const [groupType, setGroupType] = useState<ReviewGroupType>('AIGC')
  const [groupId, setGroupId] = useState('')
  const [groups, setGroups] = useState<PublicReviewGroup[]>([])
  const [nextToken, setNextToken] = useState<string>()
  const [loadingGroups, setLoadingGroups] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const gate = useRef(false), live = useRef(true)
  const requestId = useRef(crypto.randomUUID())
  const groupRequest = useRef<AbortController>()
  const isConfigured = (provider: ReviewProvider) => !!settings?.profiles.find((item) => item.provider === provider)?.configured
  const options = REVIEW_PROVIDERS.map((item) => {
    const submitted = jobs.some((job) => job.provider === item.id)
    const disabledReason = submitted ? '当前素材已送审' : !isConfigured(item.id) ? '当前供应商送审未配置' : undefined
    return { value: item.id, label: item.label, disabled: !!disabledReason, disabledReason }
  })
  const provider = options.find((item) => item.value === chosenProvider && !item.disabled)?.value
    ?? options.find((item) => !item.disabled)?.value ?? ''
  const configured = !!provider && isConfigured(provider)
  const groupProvider = useRef(provider)
  useEffect(() => {
    const controller = new AbortController()
    live.current = true
    void api.reviewSettings(controller.signal).then((value) => {
      if (controller.signal.aborted) return
      setSettings(value)
    }).catch(() => { if (!controller.signal.aborted) setError('预审配置读取失败，请关闭后重试') })
    void environment.state.refresh()
    return () => { live.current = false; controller.abort(); groupRequest.current?.abort() }
  }, [api, environment.state])
  const loadGroups = async (append = false) => {
    if (!provider || !configured) return
    groupRequest.current?.abort()
    const controller = new AbortController(); groupRequest.current = controller
    setLoadingGroups(true); setError('')
    try {
      const value = await api.reviewGroups(canvas, provider, append ? nextToken : undefined, controller.signal)
      if (controller.signal.aborted) return
      setGroups((previous) => [...new Map([...(append ? previous : []), ...value.items].map((item) => [item.id, item])).values()])
      setNextToken(value.nextToken)
    } catch (error) { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : '人物组读取失败') }
    finally { if (!controller.signal.aborted) setLoadingGroups(false) }
  }
  useEffect(() => {
    setGroups([]); setNextToken(undefined); setGroupId(''); requestId.current = crypto.randomUUID()
    const changedProvider = groupProvider.current !== provider
    groupProvider.current = provider
    if (changedProvider && groupType !== 'AIGC') { setGroupType('AIGC'); setLoadingGroups(false) }
    else if (configured && groupType === 'LivenessFace') void loadGroups()
    else setLoadingGroups(false)
    return () => groupRequest.current?.abort()
  }, [provider, groupType, configured])
  const run = async (action?: 'retry' | 'resume' | 'reconcile' | 'abandon', job?: PublicReview) => {
    const target = job?.provider ?? provider
    if (gate.current || !target || (!job && (!configured || jobs.some((item) => item.provider === target)))
      || (job && (action === 'retry' || !action) && !isConfigured(target))) return
    gate.current = true; setBusy(true); setError('')
    try {
      const result = action && job ? await api.reviewAction(canvas, job.id, action, action === 'retry' ? requestId.current : undefined)
        : await api.submitReview(canvas, { requestId: requestId.current, assetId: asset.id, provider: target, groupType: job?.groupType ?? groupType,
          ...((job?.groupType ?? groupType) === 'LivenessFace' ? { groupId: job?.groupId ?? groupId } : {}) })
      environment.state.merge(result)
      if (live.current) requestId.current = crypto.randomUUID()
    } catch (error) {
      if (live.current) setError(error instanceof Error ? error.message : '提交结果未收到，请使用同一请求重试')
      void environment.state.refresh()
    } finally { gate.current = false; if (live.current) setBusy(false) }
  }
  return <UiModal label="Seedance 预审" onClose={onClose} className="dc-review-dialog">
    <section className="dc-review-panel" aria-label="素材预审">
      <label>供应商<UiSelect label="预审供应商" value={provider} disabled={busy || !settings} options={options} placeholder="暂无可送审供应商"
        onChange={(value) => { setProvider(value as ReviewProvider); setGroupType('AIGC'); setError('') }} /></label>
      {settings && !settings.profiles.some((item) => item.configured) && <p><UiButton variant="outline" onClick={onSettings}>前往设置</UiButton></p>}
      {configured && <>
          <div className="dc-review-field"><div className="dc-review-field-label"><span>素材路径</span><UiHelp label="查看素材路径说明" description={MATERIAL_PATH_HELP} /></div>
            <UiSelect label="预审素材路径" value={groupType} disabled={busy} options={[
            { value: 'AIGC', label: '虚拟素材 · 本画布组' }, { value: 'LivenessFace', label: '已认证真人素材 · 人物组' },
          ]} onChange={(value) => { setGroupType(value as ReviewGroupType); setError('') }} /></div>
          {groupType === 'LivenessFace' && <>
            <label>人物组<UiSelect label="预审人物组" value={groupId} disabled={busy || loadingGroups} options={[
              { value: '', label: loadingGroups ? '读取人物组…' : '请选择已认证的人物组' }, ...groups.map((item) => ({ value: item.id, label: item.name })),
            ]} onChange={(value) => { setGroupId(value); requestId.current = crypto.randomUUID() }} /></label>
            {!loadingGroups && !groups.length && <p className="dc-muted">尚未找到已认证人物组，请在官方控制台完成认证。</p>}
            <div className="dc-review-group-actions"><UiButton disabled={busy || loadingGroups} onClick={() => void loadGroups()}>刷新人物组</UiButton>
              {nextToken && <UiButton disabled={busy || loadingGroups} onClick={() => void loadGroups(true)}>加载更多</UiButton>}
              <a href={REVIEW_PROVIDERS.find((item) => item.id === provider)!.consoleUrl} target="_blank" rel="noreferrer">官方控制台 ↗</a></div>
          </>}
        </>}
      {jobs.filter((job) => job.status !== 'active').map((job) => <div key={job.id} className={`dc-review-detail ${job.status}`} aria-label={`${REVIEW_PROVIDERS.find((item) => item.id === job.provider)!.label}预审任务`}>
        <strong>{REVIEW_PROVIDERS.find((item) => item.id === job.provider)!.label}</strong>
        {job.status === 'failed' && <p role="alert" className="dc-error">{job.errorMessage || job.errorCode || '预审未通过，请重新送审'}</p>}
        {job.status === 'unknown' && <p className="dc-muted">先核对原任务。结束本地等待不会取消云端审核。</p>}
        <div className="dc-review-group-actions">
          {job.status === 'failed' && <UiButton variant="primary" disabled={busy || !isConfigured(job.provider)} onClick={() => void run('retry', job)}>重新送审</UiButton>}
          {job.status === 'abandoned' && <UiButton variant="primary" disabled={busy || !isConfigured(job.provider)} onClick={() => void run(undefined, job)}>重新送审</UiButton>}
          {REVIEW_BUSY.has(job.status) && <UiButton disabled>审核中</UiButton>}
          {job.status === 'unknown' && <>
            <UiButton disabled={busy} onClick={() => void run(job.providerAssetId ? 'resume' : 'reconcile', job)}>{job.providerAssetId ? '恢复查询' : '核对提交结果'}</UiButton>
            <UiButton disabled={busy} onClick={() => void run('abandon', job)}>结束本地等待</UiButton>
          </>}
        </div>
      </div>)}
      {error && <p role="alert" className="dc-error">{error}</p>}
      <div className="dc-form-actions"><UiButton variant="outline" onClick={onClose}>关闭</UiButton>
        <UiButton variant="primary" disabled={busy || !configured || (groupType === 'LivenessFace' && !groupId)} onClick={() => void run()}>提交预审</UiButton>
      </div>
    </section>
  </UiModal>
}
