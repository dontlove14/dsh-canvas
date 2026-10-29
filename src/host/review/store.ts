import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { Database, hash, sql } from '../persistence/database'
import { CanvasError, type Store } from '../store'
import { maskSecret } from '../../shared/settingSecrets'
import { REVIEW_BUSY, REVIEW_PROVIDERS, ReviewAssetIdSchema, type PublicReview, type ReviewPage, type ReviewProvider,
  type ReviewSettings, type ReviewSettingsInput, type ReviewSubmit, type PinnedReviewReference } from '../../shared/seedanceReview'
import type { Asset, TaskSnapshot } from '../../shared/contracts'
import { providerFor } from '../../shared/modelCatalog'
import type { ObjectLocator } from '../../shared/objectStorage'
import { cleanReviewError, type ReviewCredentials, type ReviewTransport, assertGroup } from './provider'
import { validateReviewFile } from './media'

const CredentialsSchema = z.object({ projectName: z.string().min(1), accessKeyId: z.string().min(1), accessKeySecret: z.string().min(1) }).strict()
export interface ReviewProfile {
  id: string; provider: ReviewProvider; revision: number; scope: string; credentialRef: string; activatedAt: number
  projectNameMask: string; accessKeyIdMask: string; accessKeySecretMask: string
}
export interface ReviewGroup {
  id: string; canvasId: string; profile: ReviewProfile; name: string; status: 'queued' | 'ready' | 'failed' | 'unknown' | 'abandoned'
  issued: boolean; due: number; groupId?: string; errorCode?: string; errorMessage?: string
}
export interface ReviewJob extends PublicReview {
  profile: ReviewProfile; locator: ObjectLocator; asset: Asset; name: string; groupKey: string
  issued: boolean; due: number; polls: number; errors: number
}
export interface GenerationBinding { snapshotHash: string; provider?: ReviewProvider; profile?: ReviewProfile; references: PinnedReviewReference[] }
export function publicReview(job: ReviewJob): PublicReview {
  const { id, requestId, canvasId, assetId, provider, profileId, groupType, status, stage,
    providerAssetId, groupId, errorCode, errorMessage, createdAt, updatedAt } = job
  return { id, requestId, canvasId, assetId, provider, profileId, groupType, status, stage,
    providerAssetId, groupId, errorCode, errorMessage, createdAt, updatedAt }
}
export class ReviewStore {
  readonly db: Database
  private queue: Promise<unknown> = Promise.resolve()
  startedAt = 0
  constructor(readonly main: Store, readonly transport: ReviewTransport) {
    this.db = new Database(new URL('./review-worker.mjs', import.meta.url), {
      mainPath: join(main.root, 'canvas.sqlite'), mainToken: main.db.token,
    }, () => main.assertWriter())
  }
  async init(): Promise<void> {
    await this.db.open(join(this.main.root, 'seedance-review.sqlite'))
    await this.db.batch([sql("INSERT OR IGNORE INTO review_meta VALUES('startedAt',?)", [String(Date.now())])])
    this.startedAt = Number((await this.db.get("SELECT value FROM review_meta WHERE key='startedAt'")).value)
  }
  serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation); this.queue = result.catch(() => {}); return result
  }
  async audit(event: string, subject: string): Promise<void> {
    await this.db.batch([sql('INSERT INTO review_audit VALUES(?,?,?,?)', [randomUUID(), event, subject, Date.now()])])
  }
  async profile(provider: ReviewProvider): Promise<ReviewProfile | null> {
    const row = await this.db.get('SELECT payload FROM review_profiles WHERE provider=?', [provider])
    return row ? JSON.parse(row.payload) : null
  }
  async credentials(profile: ReviewProfile): Promise<ReviewCredentials> {
    return CredentialsSchema.parse(JSON.parse(await this.main.vault.read(profile.credentialRef)))
  }
  async settings(): Promise<ReviewSettings> {
    const profiles = []
    for (const { id: provider } of REVIEW_PROVIDERS) {
      const p = await this.profile(provider)
      profiles.push({ id: p?.id ?? provider, provider, revision: p?.revision ?? 0, configured: !!p,
        projectNameMask: p?.projectNameMask ?? '', accessKeyIdMask: p?.accessKeyIdMask ?? '', accessKeySecretMask: p?.accessKeySecretMask ?? '' })
    }
    return { profiles }
  }
  async secret(provider: ReviewProvider, field: keyof ReviewCredentials): Promise<string> {
    const profile = await this.profile(provider)
    if (!profile) throw new CanvasError('尚未配置预审服务', 404, 'REVIEW_NOT_CONFIGURED')
    await this.audit('secret-view', `${provider}:${field}`)
    return (await this.credentials(profile))[field]
  }
  async saveSettings(input: ReviewSettingsInput): Promise<ReviewSettings> {
    await this.serial(async () => {
      const previous = await this.profile(input.provider)
      if ((previous?.revision ?? 0) !== input.revision) throw new CanvasError('预审配置已更新，请重新载入', 409, 'SETTINGS_CONFLICT')
      const old = previous ? await this.credentials(previous) : null
      const credentials = CredentialsSchema.safeParse({
        projectName: input.projectName ?? old?.projectName ?? 'default',
        accessKeyId: input.accessKeyId ?? old?.accessKeyId,
        accessKeySecret: input.accessKeySecret ?? old?.accessKeySecret,
      })
      if (!credentials.success) throw new CanvasError('请填写 ProjectName、AK 和 SK', 400, 'REVIEW_NOT_CONFIGURED')
      for (const value of Object.values(credentials.data)) if (/\*{4}/.test(value))
        throw new CanvasError('脱敏值不能作为新配置保存')
      const changed = !old || Object.keys(credentials.data).some((key) => credentials.data[key as keyof ReviewCredentials] !== old[key as keyof ReviewCredentials])
      let scope = previous?.scope ?? randomUUID()
      if (old && changed) {
        // A replacement key never inherits resources based solely on the AK text.
        // Keep the domain only after the new credentials can read its exact group.
        const group = await this.db.get("SELECT payload FROM review_groups WHERE provider=? AND scope=? AND status='ready' LIMIT 1", [input.provider, scope])
        const pinned: ReviewGroup | null = group ? JSON.parse(group.payload) : null
        let verified = false
        if (pinned?.groupId && old.projectName === credentials.data.projectName) {
          try {
            const result = await this.transport.call(input.provider, credentials.data, 'GetAssetGroup', { Id: pinned.groupId }, AbortSignal.timeout(15000))
            assertGroup(result, pinned.groupId, credentials.data.projectName, 'AIGC'); verified = true
          } catch { /* Isolate unverified replacements; never reinterpret a permission error as deletion. */ }
        }
        if (!verified) scope = randomUUID()
      }
      const next: ReviewProfile = { id: previous?.id ?? randomUUID(), provider: input.provider, revision: input.revision + 1,
        scope, credentialRef: changed ? await this.main.vault.put(JSON.stringify(credentials.data)) : previous!.credentialRef,
        activatedAt: previous?.activatedAt ?? Date.now(), projectNameMask: maskSecret(credentials.data.projectName),
        accessKeyIdMask: maskSecret(credentials.data.accessKeyId), accessKeySecretMask: maskSecret(credentials.data.accessKeySecret) }
      await this.db.batch([sql('INSERT INTO review_profiles VALUES(?,?,?,?) ON CONFLICT(provider) DO UPDATE SET revision=excluded.revision,activated_at=excluded.activated_at,payload=excluded.payload',
        [next.provider, next.revision, next.activatedAt, JSON.stringify(next)])])
      await this.audit('settings-save', `${next.provider}:${next.revision}`)
    })
    return this.settings()
  }
  async ensureGroup(canvasId: string, profile: ReviewProfile): Promise<ReviewGroup> {
    return this.serial(async () => {
      const row = await this.db.get('SELECT payload FROM review_groups WHERE canvas_id=? AND provider=? AND scope=?', [canvasId, profile.provider, profile.scope])
      if (row) return JSON.parse(row.payload)
      const id = randomUUID()
      const group: ReviewGroup = { id, canvasId, profile, name: `canvas-${id}`, status: 'queued', issued: false, due: 0 }
      await this.saveGroup(group)
      return group
    })
  }
  async ensureCanvas(canvasId: string): Promise<void> {
    for (const { id } of REVIEW_PROVIDERS) { const profile = await this.profile(id); if (profile) await this.ensureGroup(canvasId, profile) }
  }
  async canvasExists(id: string): Promise<boolean> {
    return !!await this.main.db.get('SELECT id FROM canvases WHERE id=? AND owner_id=? AND deleted_at IS NULL', [id, this.main.owner])
  }
  async repairCanvases(): Promise<void> {
    for (const { id } of REVIEW_PROVIDERS) {
      const profile = await this.profile(id)
      if (!profile) continue
      const rows = await this.main.db.all('SELECT id FROM canvases WHERE owner_id=? AND deleted_at IS NULL AND created_at>=?', [this.main.owner, profile.activatedAt])
      for (const row of rows) await this.ensureGroup(row.id, profile)
    }
  }
  async saveGroup(group: ReviewGroup): Promise<void> {
    await this.db.batch([sql('INSERT INTO review_groups VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,issued=excluded.issued,due=excluded.due,payload=excluded.payload',
      [group.id, group.canvasId, group.profile.provider, group.profile.scope, group.status, Number(group.issued), group.due, JSON.stringify(group)])])
  }
  async saveJob(job: ReviewJob): Promise<void> {
    job.updatedAt = Date.now()
    await this.db.batch([sql('INSERT INTO review_jobs VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,issued=excluded.issued,due=excluded.due,updated_at=excluded.updated_at,payload=excluded.payload',
      [job.id, job.canvasId, job.assetId, job.provider, job.profile.scope, job.locator.sha256, job.groupKey,
        job.status, Number(job.issued), job.due, job.updatedAt, JSON.stringify(job)])])
  }
  async job(canvasId: string, id: string): Promise<ReviewJob> {
    const row = await this.db.get('SELECT payload FROM review_jobs WHERE canvas_id=? AND id=?', [canvasId, id])
    if (!row) throw new CanvasError('预审任务不存在', 404)
    return JSON.parse(row.payload)
  }
  async submit(canvasId: string, input: ReviewSubmit): Promise<PublicReview> {
    const profile = await this.profile(input.provider)
    if (!profile) throw new CanvasError('请先在设置中配置 Seedance 预审', 409, 'REVIEW_NOT_CONFIGURED')
    const asset = this.main.state(canvasId).assets.find((asset) => asset.id === input.assetId)
    if (!asset) throw new CanvasError('送审素材不存在', 404)
    const locator = await this.main.locator(canvasId, asset.id)
    locator.credentialRef = (await this.main.storageRecord(locator.providerId)).readCredentialRef
      ?? (await this.main.storageRecord(locator.providerId)).credentialRef
    validateReviewFile(asset)
    const requestHash = hash({ canvasId, ...input })
    const previous = await this.db.get('SELECT request_hash,job_id FROM review_requests WHERE request_id=?', [input.requestId])
    if (previous) {
      if (previous.request_hash !== requestHash) throw new CanvasError('预审请求 ID 已用于其他内容', 409, 'REQUEST_REUSED')
      return publicReview(await this.job(canvasId, previous.job_id))
    }
    let groupKey: string, groupId: string | undefined
    if (input.groupType === 'LivenessFace') {
      groupId = input.groupId; groupKey = `human:${profile.scope}:${groupId}`
    } else groupKey = (await this.ensureGroup(canvasId, profile)).id
    return this.serial(async () => {
      const replay = await this.db.get('SELECT request_hash,job_id FROM review_requests WHERE request_id=?', [input.requestId])
      if (replay) {
        if (replay.request_hash !== requestHash) throw new CanvasError('预审请求 ID 已用于其他内容', 409, 'REQUEST_REUSED')
        return publicReview(await this.job(canvasId, replay.job_id))
      }
      if (!await this.canvasExists(canvasId)) throw new CanvasError('画布不存在', 404)
      const existing = await this.db.get("SELECT payload FROM review_jobs WHERE canvas_id=? AND asset_id=? AND provider=? AND scope=? AND file_hash=? AND group_key=? AND status IN ('queued','preparing','submitting','processing','active','unknown') ORDER BY updated_at DESC LIMIT 1",
        [canvasId, asset.id, profile.provider, profile.scope, locator.sha256, groupKey])
      let job: ReviewJob
      if (existing) job = JSON.parse(existing.payload)
      else {
        const count = await this.db.get("SELECT count(*) AS n FROM review_jobs WHERE status IN ('queued','preparing','submitting','processing')")
        if (count.n >= 1000) throw new CanvasError('预审队列已满', 429, 'QUEUE_FULL')
        const id = randomUUID(), now = Date.now()
        job = { id, requestId: input.requestId, canvasId, assetId: asset.id, provider: input.provider, profileId: profile.id,
          groupType: input.groupType, groupId, status: 'queued', stage: '等待送审', createdAt: now, updatedAt: now,
          profile, locator, asset: structuredClone(asset), name: `review-${id}`, groupKey, issued: false, due: 0, polls: 0, errors: 0 }
        await this.saveJob(job)
      }
      await this.db.batch([sql('INSERT INTO review_requests VALUES(?,?,?)', [input.requestId, requestHash, job.id])])
      await this.audit('review-accept', job.id)
      return publicReview(job)
    })
  }
  async page(canvasId: string, assetIds?: string[]): Promise<ReviewPage> {
    // Only current resource domains and exact original bytes can project a badge.
    const items: PublicReview[] = []; let revision = 0, busy = false
    const hashes = new Map((await this.main.db.all("SELECT id,file_hash FROM canvas_assets WHERE canvas_id=? AND file_state='ready'", [canvasId]))
      .map((row) => [row.id, row.file_hash]))
    for (const { id } of REVIEW_PROVIDERS) {
      const profile = await this.profile(id)
      if (!profile) continue
      const filter = assetIds?.length ? ` AND asset_id IN (${assetIds.map(() => '?').join(',')})` : ''
      const rows = await this.db.all(`SELECT payload,updated_at FROM review_jobs WHERE canvas_id=? AND provider=? AND scope=?${filter} ORDER BY updated_at DESC`,
        [canvasId, id, profile.scope, ...(assetIds ?? [])])
      const seen = new Set<string>()
      for (const row of rows) {
        const job: ReviewJob = JSON.parse(row.payload)
        revision = Math.max(revision, row.updated_at)
        if (assetIds && !assetIds.includes(job.assetId) || seen.has(job.assetId)) continue
        if (hashes.get(job.assetId) !== job.locator.sha256) continue
        seen.add(job.assetId); items.push(publicReview(job)); busy ||= REVIEW_BUSY.has(job.status)
      }
    }
    return { items, revision, busy }
  }
  async pin(canvasId: string, requestId: string, requestHash: string, snapshot: TaskSnapshot): Promise<void> {
    await this.serial(async () => {
      const row = await this.db.get('SELECT request_hash,payload FROM generation_review_bindings WHERE request_id=?', [requestId])
      if (row) {
        if (row.request_hash !== requestHash || JSON.parse(row.payload).snapshotHash !== hash(snapshot))
          throw new CanvasError('生成请求 ID 已用于其他内容或模型配置', 409, 'REQUEST_REUSED')
        return
      }
      const providerId = providerFor(snapshot.model)?.id
      const provider: ReviewProvider | undefined = providerId === 'bytedance' || providerId === 'byteplus' ? providerId : undefined
      const profile = provider ? await this.profile(provider) : null
      const references: PinnedReviewReference[] = []
      for (const assetId of snapshot.referenceIds) {
        const sha256 = await this.main.mediaHash(canvasId, assetId)
        const approved = profile && await this.db.get("SELECT payload FROM review_jobs WHERE canvas_id=? AND asset_id=? AND provider=? AND scope=? AND file_hash=? AND status='active' ORDER BY updated_at DESC LIMIT 1",
          [canvasId, assetId, provider!, profile.scope, sha256])
        const job: ReviewJob | null = approved ? JSON.parse(approved.payload) : null
        references.push(job?.providerAssetId ? { assetId, sha256, source: 'asset', providerAssetId: job.providerAssetId,
          reviewId: job.id, profileId: profile!.id, groupId: job.groupId } : { assetId, sha256, source: 'url' })
      }
      const binding: GenerationBinding = { snapshotHash: hash(snapshot), provider, ...(profile ? { profile } : {}), references }
      await this.db.batch([sql('INSERT INTO generation_review_bindings VALUES(?,?,?,NULL,?,?)',
        [requestId, requestHash, canvasId, Date.now(), JSON.stringify(binding)])])
    })
  }
  async generationBinding(taskId: string): Promise<GenerationBinding | null> {
    const detail = await this.main.db.get('SELECT d.request_id,c.canvas_id,c.created_at FROM task_details d JOIN task_catalog c ON c.id=d.task_id WHERE d.task_id=?', [taskId])
    if (!detail) throw new CanvasError('生成任务不存在', 404)
    const row = await this.db.get('SELECT payload,canvas_id FROM generation_review_bindings WHERE request_id=?', [detail.request_id])
    if (!row) {
      if (detail.created_at >= this.startedAt) throw new CanvasError('任务固定预审引用缺失，请恢复完整备份', 409, 'REVIEW_BINDING_MISSING')
      return null
    }
    if (row.canvas_id !== detail.canvas_id) throw new CanvasError('固定引用归属不一致', 409)
    await this.db.batch([sql('UPDATE generation_review_bindings SET task_id=? WHERE request_id=? AND (task_id IS NULL OR task_id=?)',
      [taskId, detail.request_id, taskId], 'run', 1)])
    return JSON.parse(row.payload)
  }
  async referenceUris(taskId: string, snapshot: TaskSnapshot): Promise<Map<string, string>> {
    const binding = await this.generationBinding(taskId)
    const uris = new Map<string, string>()
    if (!binding) return uris
    if (binding.snapshotHash !== hash(snapshot) || binding.references.length !== snapshot.referenceIds.length
      || binding.references.some((reference, index) => reference.assetId !== snapshot.referenceIds[index])
      || binding.provider !== (['bytedance', 'byteplus'].includes(providerFor(snapshot.model)?.id ?? '') ? providerFor(snapshot.model)?.id : undefined))
      throw new CanvasError('固定预审引用与任务快照不匹配', 409, 'REVIEW_BINDING_MISMATCH')
    for (const reference of binding.references) {
      const row = await this.main.db.get('SELECT locator_json FROM task_references WHERE task_id=? AND asset_id=?', [taskId, reference.assetId])
      if (!row || JSON.parse(row.locator_json).sha256 !== reference.sha256) throw new CanvasError('固定引用原文件身份不匹配', 409, 'MEDIA_CHANGED')
      if (reference.source === 'asset') {
        if (!binding.profile || !binding.provider || reference.profileId !== binding.profile.id || !reference.groupId || !reference.reviewId)
          throw new CanvasError('固定 Asset ID 上下文缺失', 409, 'REVIEW_BINDING_MISMATCH')
        uris.set(reference.assetId, `asset://${ReviewAssetIdSchema.parse(reference.providerAssetId)}`)
      } else if (reference.source !== 'url') throw new CanvasError('固定引用来源无效', 409)
    }
    return uris
  }
  async redactPublic(message: string): Promise<string> {
    let clean = message
    for (const { id } of REVIEW_PROVIDERS) {
      const profile = await this.profile(id).catch(() => null)
      if (profile) {
        const credentials = await this.credentials(profile).catch(() => null)
        if (credentials) clean = cleanReviewError(clean, Object.values(credentials))
      }
    }
    return this.main.redact(clean)
  }
  redact(error: unknown, credentials?: ReviewCredentials): string {
    return this.main.redact(cleanReviewError(error instanceof Error ? error.message : error, credentials ? Object.values(credentials) : []))
  }
  async close(): Promise<void> { await this.queue; await this.db.close() }
}
