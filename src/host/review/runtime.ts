import { sql } from '../persistence/database'
import { CanvasError } from '../store'
import { REVIEW_BUSY, type ReviewGroups, type ReviewProvider } from '../../shared/seedanceReview'
import { ReviewStore, publicReview, type ReviewGroup, type ReviewJob, type ReviewProfile } from './store'
import { ReviewFailure, assertGroup, officialId, type ReviewCredentials } from './provider'
import { inspectReviewMedia } from './media'

function listItems(result: Record<string, any>, kind: 'Assets' | 'AssetGroups'): Record<string, any>[] {
  const items = result.Items ?? result[kind]
  if (!Array.isArray(items) || items.length > 100) throw new ReviewFailure('预审列表格式无效', 'LIST_INVALID')
  return items
}
/** Independent host queue: at most two network steps per provider, no per-node timers. */
export class ReviewRuntime {
  private controller = new AbortController()
  private active = new Map<string, { provider: ReviewProvider; work: Promise<void> }>()
  private timer?: ReturnType<typeof setInterval>
  private scanning?: Promise<void>
  private repairAt = 0
  constructor(readonly store: ReviewStore) {}
  async start(): Promise<void> {
    // Persisted issued gates are authoritative. Restart never performs a replacement POST.
    for (const row of await this.store.db.all("SELECT payload FROM review_jobs WHERE status IN ('preparing','submitting')")) {
      const job: ReviewJob = JSON.parse(row.payload)
      job.status = job.providerAssetId ? 'processing' : job.issued ? 'unknown' : 'queued'
      job.stage = job.status === 'unknown' ? '提交结果待确认' : '恢复预审'; job.due = 0
      await this.store.saveJob(job)
    }
    this.timer = setInterval(() => this.wake(), 500); this.timer.unref(); this.wake()
  }
  wake(): void {
    if (!this.controller.signal.aborted && !this.scanning)
      this.scanning = this.scan().catch(() => {}).finally(() => { this.scanning = undefined })
  }
  private async scan(): Promise<void> {
    if (Date.now() >= this.repairAt) {
      await this.store.repairCanvases(); this.repairAt = Date.now() + 30000
    }
    const groups = await this.store.db.all("SELECT payload FROM review_groups WHERE status='queued' AND due<=? ORDER BY due LIMIT 50", [Date.now()])
    for (const row of groups) {
      const group: ReviewGroup = JSON.parse(row.payload)
      this.launch(`group:${group.id}`, group.profile.provider, () => this.createGroup(group))
    }
    const jobs = await this.store.db.all("SELECT payload FROM review_jobs WHERE status IN ('queued','preparing','submitting','processing') AND due<=? ORDER BY due,updated_at LIMIT 100", [Date.now()])
    for (const row of jobs) {
      const job: ReviewJob = JSON.parse(row.payload)
      this.launch(job.id, job.provider, () => this.execute(job))
    }
  }
  private launch(id: string, provider: ReviewProvider, execute: () => Promise<void>): void {
    if (this.active.has(id) || [...this.active.values()].filter((item) => item.provider === provider).length >= 2
      || this.controller.signal.aborted) return
    const work = execute().catch(() => {}).finally(() => { this.active.delete(id) })
    this.active.set(id, { provider, work })
  }
  private async call(profile: ReviewProfile, action: Parameters<ReviewStore['transport']['call']>[2], payload: Record<string, unknown>) {
    this.controller.signal.throwIfAborted()
    const credentials = await this.store.credentials(profile)
    return this.store.transport.call(profile.provider, credentials, action, payload, this.controller.signal)
  }
  private async alive(canvasId: string): Promise<boolean> {
    return !this.controller.signal.aborted && await this.store.canvasExists(canvasId)
  }
  private async createGroup(group: ReviewGroup): Promise<void> {
    let credentials: ReviewCredentials | undefined
    try {
      if (!await this.alive(group.canvasId)) {
        if (!this.controller.signal.aborted) { group.status = 'abandoned'; await this.store.saveGroup(group) }
        return
      }
      credentials = await this.store.credentials(group.profile)
      if (group.issued) {
        group.status = 'unknown'; group.errorMessage = '素材组创建结果待确认，不会自动重建'
        await this.store.saveGroup(group); return
      }
      group.issued = true
      await this.store.saveGroup(group)
      const result = await this.call(group.profile, 'CreateAssetGroup', { Name: group.name, GroupType: 'AIGC' })
      group.groupId = officialId(result.Id, 'group')
      group.status = await this.alive(group.canvasId) ? 'ready' : 'abandoned'
      await this.store.saveGroup(group)
    } catch (error) {
      group.status = error instanceof ReviewFailure && error.definitive ? 'failed' : group.issued ? 'unknown' : 'failed'
      group.errorCode = error instanceof ReviewFailure ? error.code : 'GROUP_ERROR'
      group.errorMessage = this.store.redact(error, credentials)
      await this.store.saveGroup(group)
    }
  }
  private async execute(job: ReviewJob): Promise<void> {
    let credentials: ReviewCredentials | undefined
    try {
      if (!await this.alive(job.canvasId)) {
        if (!this.controller.signal.aborted) { job.status = 'abandoned'; job.stage = '画布已删除'; await this.store.saveJob(job) }
        return
      }
      if (await this.store.main.mediaHash(job.canvasId, job.assetId) !== job.locator.sha256)
        throw new CanvasError('送审原文件身份已改变', 409, 'MEDIA_CHANGED')
      credentials = await this.store.credentials(job.profile)
      if (job.providerAssetId) {
        const result = await this.call(job.profile, 'GetAsset', { Id: job.providerAssetId })
        if (!await this.alive(job.canvasId)) { job.status = 'abandoned'; await this.store.saveJob(job); return }
        if (officialId(result.Id, 'asset') !== job.providerAssetId || result.GroupId !== job.groupId
          || result.ProjectName !== credentials.projectName || result.AssetType !== this.assetType(job))
          throw new ReviewFailure('审核结果素材、组或项目不匹配', 'ASSET_MISMATCH')
        if (!['Processing', 'Active', 'Failed'].includes(result.Status))
          throw new ReviewFailure('预审服务返回未知状态', 'STATUS_UNKNOWN')
        job.status = result.Status === 'Active' ? 'active' : result.Status === 'Failed' ? 'failed' : 'processing'
        job.stage = job.status === 'active' ? '审核通过' : job.status === 'failed' ? '预处理或审核失败' : '官方审核中'
        job.errorCode = result.Status === 'Failed' ? this.store.redact(result.Error?.Code ?? 'REVIEW_FAILED', credentials) : undefined
        job.errorMessage = result.Status === 'Failed' ? this.store.redact(result.Error?.Message ?? '预处理或审核失败', credentials) : undefined
        job.errors = 0; job.polls++; job.due = Date.now() + this.delay(job)
        await this.store.saveJob(job); return
      }
      if (job.issued) { job.status = 'unknown'; job.stage = '提交结果待确认'; await this.store.saveJob(job); return }
      if (job.groupType === 'AIGC') {
        const row = await this.store.db.get('SELECT payload FROM review_groups WHERE id=?', [job.groupKey])
        if (!row) throw new CanvasError('画布素材组记录缺失', 409)
        const group: ReviewGroup = JSON.parse(row.payload)
        if (group.status !== 'ready') {
          job.status = group.status === 'unknown' ? 'unknown' : group.status === 'failed' || group.status === 'abandoned' ? 'failed' : 'queued'
          job.stage = '等待画布素材组'; job.errorCode = group.errorCode; job.errorMessage = group.errorMessage; job.due = Date.now() + 1000
          await this.store.saveJob(job); return
        }
        job.groupId = group.groupId
      }
      job.status = 'preparing'; job.stage = '校验素材组和原文件'
      await this.store.saveJob(job)
      const group = await this.call(job.profile, 'GetAssetGroup', { Id: job.groupId })
      assertGroup(group, job.groupId!, credentials.projectName, job.groupType)
      const source = await (await this.store.main.objects.adapter(job.locator.providerId, job.locator.credentialRef)).openRead(job.locator)
      await inspectReviewMedia(source, job.asset, job.locator.sha256, this.controller.signal)
      await this.store.main.objects.verify(job.locator)
      const signed = await this.store.main.objects.sign(job.locator, { method: 'GET', ttl: 86400 }, true)
      const url = new URL(signed.url)
      if (url.protocol !== 'https:' || url.username || url.password) throw new CanvasError('送审地址必须为 HTTPS')
      if (!await this.alive(job.canvasId)) return
      job.issued = true; job.status = 'submitting'; job.stage = '提交官方预审'
      await this.store.saveJob(job)
      const result = await this.call(job.profile, 'CreateAsset', { GroupId: job.groupId, URL: signed.url,
        Name: job.name, AssetType: this.assetType(job), ...(job.provider === 'byteplus' ? { Moderation: { Strategy: 'Default' } } : {}) })
      job.providerAssetId = officialId(result.Id, 'asset')
      job.status = await this.alive(job.canvasId) ? 'processing' : 'abandoned'
      job.stage = '官方审核中'; job.due = Date.now() + 5000
      await this.store.saveJob(job)
    } catch (error) {
      if (this.controller.signal.aborted && !job.issued) {
        job.status = 'queued'; job.due = 0
      } else if (job.providerAssetId && !(error instanceof CanvasError)) {
        job.errors++; job.status = error instanceof ReviewFailure && error.definitive || job.errors >= 8 ? 'unknown' : 'processing'
        job.stage = job.status === 'unknown' ? '查询结果待确认' : '等待恢复查询'; job.due = Date.now() + this.delay(job)
      } else {
        job.status = job.issued && !(error instanceof ReviewFailure && error.definitive) ? 'unknown' : 'failed'
        job.stage = job.status === 'unknown' ? '提交结果待确认' : '送审失败'
      }
      job.errorCode = error instanceof ReviewFailure ? this.store.redact(error.code, credentials) : error instanceof CanvasError ? error.code : 'REVIEW_ERROR'
      job.errorMessage = this.store.redact(error, credentials)
      await this.store.saveJob(job)
    }
  }
  private assetType(job: ReviewJob): string { return { image: 'Image', video: 'Video', audio: 'Audio' }[job.asset.kind] }
  private delay(job: ReviewJob): number {
    return Math.min(30000, 5000 * 2 ** Math.min(job.errors || Math.floor(job.polls / 6), 3)) + Math.floor(Math.random() * 1000)
  }
  async groups(canvasId: string, provider: ReviewProvider, nextToken?: string): Promise<ReviewGroups> {
    const profile = await this.store.profile(provider)
    if (!profile) throw new CanvasError('请先配置该供应商预审服务', 409, 'REVIEW_NOT_CONFIGURED')
    await this.store.ensureGroup(canvasId, profile); this.wake()
    const credentials = await this.store.credentials(profile)
    const result = await this.call(profile, 'ListAssetGroups', { Filter: { GroupType: 'LivenessFace' }, MaxResults: 100,
      ...(nextToken ? { NextToken: nextToken } : {}) })
    const items = listItems(result, 'AssetGroups')
      .filter((group) => group.GroupType === 'LivenessFace' && group.ProjectName === credentials.projectName)
      .map((group) => ({ id: officialId(group.Id, 'group'), name: String(group.Name ?? group.Id).slice(0, 64), groupType: 'LivenessFace' as const }))
    return { provider, items, ...(typeof result.NextToken === 'string' && result.NextToken ? { nextToken: result.NextToken } : {}) }
  }
  async test(provider: ReviewProvider): Promise<void> {
    const profile = await this.store.profile(provider)
    if (!profile) throw new CanvasError('请先保存预审配置', 409)
    await this.call(profile, 'ListAssetGroups', { Filter: { GroupType: 'AIGC' }, MaxResults: 1 })
    await this.store.audit('connection-test', provider)
  }
  private async findExact(profile: ReviewProfile, action: 'ListAssets' | 'ListAssetGroups', filter: Record<string, unknown>,
    predicate: (item: Record<string, any>) => boolean): Promise<Record<string, any> | null> {
    let nextToken: string | undefined; const found: Record<string, any>[] = [], tokens = new Set<string>()
    for (let page = 0; page < 100; page++) {
      const result = await this.call(profile, action, { Filter: filter, MaxResults: 100, ...(nextToken ? { NextToken: nextToken } : {}) })
      found.push(...listItems(result, action === 'ListAssets' ? 'Assets' : 'AssetGroups').filter(predicate))
      if (found.length > 1) return null
      nextToken = typeof result.NextToken === 'string' ? result.NextToken : undefined
      if (!nextToken) return found.length === 1 ? found[0] : null
      if (tokens.has(nextToken)) return null
      tokens.add(nextToken)
    }
    return null
  }
  async action(canvasId: string, id: string, input: { action: 'resume' | 'reconcile' | 'retry' | 'abandon'; requestId?: string }) {
    if (this.active.has(id)) throw new CanvasError('预审任务正在处理，请稍后重试', 409)
    const job = await this.store.job(canvasId, id)
    if (input.action === 'retry') {
      if (job.status !== 'failed') throw new CanvasError('只有明确失败的素材可重新送审', 409)
      if (job.groupType === 'AIGC') {
        const row = await this.store.db.get('SELECT payload FROM review_groups WHERE id=?', [job.groupKey])
        const group: ReviewGroup | null = row ? JSON.parse(row.payload) : null
        if (group?.status === 'failed') {
          group.status = 'queued'; group.issued = false; group.due = 0; await this.store.saveGroup(group)
        }
      }
      const result = await this.store.submit(canvasId, { requestId: input.requestId!, assetId: job.assetId,
        provider: job.provider, groupType: job.groupType, ...(job.groupType === 'LivenessFace' ? { groupId: job.groupId } : {}) })
      this.wake(); return result
    }
    if (job.status !== 'unknown') throw new CanvasError('当前预审任务无需恢复', 409)
    if (input.action === 'abandon') {
      job.status = 'abandoned'; job.stage = '已结束本地等待'
    } else if (input.action === 'resume') {
      if (!job.providerAssetId) throw new CanvasError('没有可恢复查询的 Asset ID', 409)
      job.status = 'processing'; job.errors = 0; job.due = 0
    } else {
      const credentials = await this.store.credentials(job.profile)
      if (!job.groupId && job.groupType === 'AIGC') {
        const row = await this.store.db.get('SELECT payload FROM review_groups WHERE id=?', [job.groupKey])
        const group: ReviewGroup = JSON.parse(row.payload)
        if (this.active.has(`group:${group.id}`)) throw new CanvasError('素材组正在处理', 409)
        const match = await this.findExact(group.profile, 'ListAssetGroups', { Name: group.name, GroupType: 'AIGC' },
          (item) => item.Name === group.name && item.GroupType === 'AIGC' && item.ProjectName === credentials.projectName)
        if (!match) throw new CanvasError('未找到唯一可信素材组；保留待确认，不会重建', 409, 'RECONCILE_UNKNOWN')
        group.groupId = officialId(match.Id, 'group'); group.status = 'ready'; await this.store.saveGroup(group)
        job.groupId = group.groupId; job.status = 'queued'; job.due = 0
      } else if (job.providerAssetId) { job.status = 'processing'; job.errors = 0; job.due = 0 }
      else {
        const match = await this.findExact(job.profile, 'ListAssets', { Name: job.name, GroupIds: [job.groupId], GroupType: job.groupType },
          (item) => item.Name === job.name && item.GroupId === job.groupId
            && item.ProjectName === credentials.projectName && item.AssetType === this.assetType(job))
        if (!match) throw new CanvasError('未找到唯一可信送审结果；保留待确认，不会重传', 409, 'RECONCILE_UNKNOWN')
        job.providerAssetId = officialId(match.Id, 'asset'); job.status = 'processing'; job.errors = 0; job.due = 0
      }
    }
    await this.store.saveJob(job); await this.store.audit(`review-${input.action}`, job.id); this.wake()
    return publicReview(job)
  }
  isBusy(): boolean { return this.active.size > 0 }
  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.controller.abort()
    await this.scanning; await Promise.allSettled([...this.active.values()].map((item) => item.work))
  }
}
