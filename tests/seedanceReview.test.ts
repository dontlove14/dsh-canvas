import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import sharp from 'sharp'
import { CanvasService } from '../src/host/service'
import { signReviewRequest, ReviewFailure, type ReviewTransport, type ReviewCredentials, type ReviewAction } from '../src/host/review/provider'
import { ReviewSubmitSchema, ReviewSettingsInputSchema, type ReviewProvider } from '../src/shared/seedanceReview'
import { BUILTIN_MODELS, providerFor } from '../src/shared/modelCatalog'
import { defaultParams, emptyGraph, type CanvasNode } from '../src/shared/contracts'
import { initialize, fakeFactory } from './support/objectStorage'
import { inspectReviewMedia } from '../src/host/review/media'
import { Providers } from '../src/host/providers'
import { sql } from '../src/host/persistence/database'

const dispose: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of dispose.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const keys = { projectName: 'Project-Secret-Case', accessKeyId: 'AK-offline-private', accessKeySecret: 'SK-offline-private' }
class FakeReview implements ReviewTransport {
  calls: Array<{ provider: string; action: ReviewAction; payload: Record<string, unknown>; credentials: ReviewCredentials }> = []
  groups = new Map<string, Record<string, any>>()
  assets = new Map<string, Record<string, any>>()
  loseAssetResponse = false
  failGroup = false
  queryError = false
  async call(provider: ReviewProvider, credentials: ReviewCredentials, action: ReviewAction, payload: Record<string, unknown>) {
    this.calls.push({ provider, action, payload, credentials: { ...credentials } })
    if (action === 'CreateAssetGroup') {
      if (this.failGroup) throw new ReviewFailure('无创建权限', 'AccessDenied', true)
      const Id = `group-${randomUUID()}`
      this.groups.set(Id, { ...payload, Id, ProjectName: credentials.projectName })
      return { Id }
    }
    if (action === 'GetAssetGroup') return this.groups.get(String(payload.Id))!
    if (action === 'ListAssetGroups') return { Items: [...this.groups.values()].filter((item) => item.ProjectName === credentials.projectName) }
    if (action === 'CreateAsset') {
      const Id = `Asset-${randomUUID()}`
      this.assets.set(Id, { ...payload, Id, Status: 'Processing', ProjectName: credentials.projectName })
      if (this.loseAssetResponse) throw new Error('回执丢失 https://fake.invalid/?signature=secret')
      return { Id }
    }
    if (action === 'GetAsset') {
      if (this.queryError) throw new ReviewFailure('暂时断网', 'NETWORK')
      return this.assets.get(String(payload.Id))!
    }
    return { Items: [...this.assets.values()].filter((item) => item.ProjectName === credentials.projectName) }
  }
}
async function service(fake = new FakeReview(), root?: string) {
  root ??= await mkdtemp(join(tmpdir(), 'dsh-seedance-review-test-'))
  const directory = root
  dispose.push(() => rm(directory, { recursive: true, force: true }))
  const instance = new CanvasService({ dataDir: root, maxConcurrentTasks: 1, pollIntervalMs: 50, requestTimeoutMs: 1000,
    maxMediaBytes: 1000000, maxReferenceBytes: 500000 }, undefined, fakeFactory(root), fake)
  await initialize(instance); dispose.push(() => instance.close())
  vi.spyOn(instance.runtime, 'wake').mockImplementation(() => {})
  await instance.store.ensureCanvas('w')
  return instance
}
async function addAsset(instance: CanvasService) {
  const node: CanvasNode = { id: randomUUID(), kind: 'image-asset', title: '素材', position: { x: 0, y: 0 },
    assetId: null, selectedResultId: null, modelId: null, prompt: '', params: null }
  const before = instance.store.state('w')
  await instance.store.update('w', (state) => { state.graph.nodes.push(node); state.graphRevision++ })
  const bytes = await sharp({ create: { width: 400, height: 400, channels: 3, background: '#234567' } }).png().toBuffer()
  const asset = await instance.store.saveMedia(Readable.from([bytes]), { id: randomUUID(), kind: 'image', filename: 'reference.png',
    nodeId: node.id, taskId: null, createdAt: Date.now() }, 1000000, 'image')
  await instance.store.update('w', (state) => {
    state.assets.push(asset); state.graph.nodes.find((item) => item.id === node.id)!.assetId = asset.id; state.graphRevision++
  })
  expect(before.graph.nodes).not.toHaveLength(instance.store.state('w').graph.nodes.length)
  return { asset, node, bytes }
}
async function configure(instance: CanvasService, provider: ReviewProvider = 'bytedance', projectName = keys.projectName) {
  await instance.reviews.saveSettings({ provider, revision: 0, ...keys, projectName })
}
function request(path: string, body?: unknown) {
  return new Request(`http://localhost/api/canvas/v2/${path}`, { method: body ? 'POST' : 'GET',
    ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) })
}
async function wait(predicate: () => Promise<boolean>) {
  for (let i = 0; i < 300; i++) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 10)) }
  throw new Error('Review did not reach expected state')
}
async function processed(instance: CanvasService, assetId: string, provider: ReviewProvider = 'bytedance') {
  const submitted = await instance.reviews.submit('w', { requestId: randomUUID(), assetId, provider, groupType: 'AIGC' })
  await instance.reviewRuntime.start()
  await wait(async () => ['processing', 'unknown', 'failed'].includes((await instance.reviews.job('w', submitted.id)).status))
  return instance.reviews.job('w', submitted.id)
}

describe('official pre-review signature and secret boundaries', () => {
  it.each(['bytedance', 'byteplus'] as const)('signs the exact JSON bytes and correct UTC scope for %s', (provider) => {
    const date = new Date('2026-10-29T04:05:06.000Z')
    const actual = signReviewRequest(provider, keys, 'CreateAsset', { Name: '测试😀', URL: 'https://x.invalid/a?x=1&y=2' }, date)
    const url = new URL(actual.url), region = provider === 'bytedance' ? 'cn-beijing' : 'ap-southeast-1'
    const digest = (value: string) => createHash('sha256').update(value).digest('hex')
    const bodyHash = digest(actual.body)
    expect(actual.headers['X-Content-Sha256']).toBe(bodyHash)
    expect(actual.headers['X-Date']).toBe('20261029T040506Z')
    const signedHeaders = 'host;x-content-sha256;x-date'
    const canonical = `POST\n/\nAction=CreateAsset&Version=2024-01-01\nhost:${url.host}\nx-content-sha256:${bodyHash}\nx-date:20261029T040506Z\n\n${signedHeaders}\n${bodyHash}`
    const scope = `20261029/${region}/ark/request`
    let key: string | Buffer = keys.accessKeySecret
    for (const value of ['20261029', region, 'ark', 'request']) key = createHmac('sha256', key).update(value).digest()
    const signature = createHmac('sha256', key).update(`HMAC-SHA256\n20261029T040506Z\n${scope}\n${digest(canonical)}`).digest('hex')
    expect(actual.headers.Authorization).toBe(`HMAC-SHA256 Credential=${keys.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`)
    expect(JSON.parse(actual.body).ProjectName).toBe(keys.projectName)
    expect(url.host).toBe(provider === 'bytedance' ? 'ark.cn-beijing.volcengineapi.com' : 'ark.ap-southeast-1.byteplusapi.com')
  })
  it('masks all three fields, permits strict explicit single-field reads, and leaves main DDL unchanged', async () => {
    const instance = await service()
    const ddl = await instance.store.db.all("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name")
    await configure(instance)
    const publicDto = await (await instance.handle(request('seedance-review-settings'))).text()
    for (const secret of Object.values(keys)) expect(publicDto).not.toContain(secret)
    expect(publicDto).toContain('Pro********ase')
    const result = await instance.handle(request('settings-secret', { scope: 'seedance-review', provider: 'bytedance', field: 'projectName' }))
    expect(result.headers.get('cache-control')).toBe('no-store')
    expect(await result.json()).toEqual({ value: keys.projectName })
    expect((await instance.handle(request('settings-secret', { scope: 'seedance-review', provider: 'bytedance', field: 'accessKeySecret', credentialRef: 'arbitrary' }))).status).toBe(400)
    expect(ReviewSettingsInputSchema.safeParse({ provider: 'bytedance', revision: 0, accessKeyId: 'one-key' }).success).toBe(false)
    expect(await instance.store.db.all("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name")).toEqual(ddl)
    const sqliteBytes = await readFile(join(instance.store.root, 'seedance-review.sqlite'))
    for (const secret of Object.values(keys)) expect(sqliteBytes.includes(Buffer.from(secret))).toBe(false)
    expect((await stat(join(instance.store.root, 'seedance-review.sqlite'))).mode & 0o777).toBe(0o600)
  })
})

describe('persistent review acceptance and recovery', () => {
  it('registers both configured supplier groups with local canvas creation before any cloud request', async () => {
    const fake = new FakeReview(), instance = await service(fake)
    await configure(instance); await configure(instance, 'byteplus')
    const response = await instance.handle(request('catalog', { requestId: randomUUID(), operation: 'canvas-create', name: '新画布' }))
    const { id } = await response.json()
    expect(response.status).toBe(200)
    const groups = await instance.reviews.db.all('SELECT provider FROM review_groups WHERE canvas_id=?', [id])
    expect(groups.map((row) => row.provider).sort()).toEqual(['bytedance', 'byteplus'])
    // wake is asynchronous: CreateAsset is never invoked by creating a canvas.
    expect(fake.calls.filter((call) => call.action === 'CreateAsset')).toHaveLength(0)
  })
  it('accepts before cloud work, shares content duplicates, and rejects request ID reuse', async () => {
    const fake = new FakeReview(), instance = await service(fake)
    await configure(instance); const { asset } = await addAsset(instance)
    const input = { requestId: randomUUID(), assetId: asset.id, provider: 'bytedance' as const, groupType: 'AIGC' as const }
    const [first, second] = await Promise.all([instance.reviews.submit('w', input), instance.reviews.submit('w', { ...input, requestId: randomUUID() })])
    expect(first.id).toBe(second.id); expect(fake.calls).toHaveLength(0)
    await expect(instance.reviews.submit('w', { ...input, groupType: 'LivenessFace', groupId: 'group-other' })).rejects.toMatchObject({ code: 'REQUEST_REUSED' })
    expect(ReviewSubmitSchema.safeParse({ ...input, URL: 'https://arbitrary.invalid' }).success).toBe(false)
    expect(ReviewSubmitSchema.safeParse({ ...input, groupType: 'LivenessFace' }).success).toBe(false)
  })
  it('only treats Active as approved, preserves ID case, and does not change source bytes or graph', async () => {
    const fake = new FakeReview(), instance = await service(fake)
    await configure(instance); const { asset, bytes } = await addAsset(instance)
    const graph = structuredClone(instance.store.state('w').graph)
    const job = await processed(instance, asset.id)
    expect(job.status).toBe('processing'); expect(job.providerAssetId).toMatch(/^Asset-/)
    expect((await instance.reviews.page('w')).items[0].status).toBe('processing')
    fake.assets.get(job.providerAssetId!)!.Status = 'Active'
    job.due = 0; await instance.reviews.saveJob(job); instance.reviewRuntime.wake()
    await wait(async () => (await instance.reviews.job('w', job.id)).status === 'active')
    expect(instance.store.state('w').graph).toEqual(graph)
    expect(await instance.store.mediaHash('w', asset.id)).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(fake.calls.filter((call) => call.action === 'CreateAsset')).toHaveLength(1)
    expect(fake.calls.find((call) => call.action === 'CreateAsset')!.payload).not.toHaveProperty('Moderation')
  })
  it('keeps a lost submission unknown across restart and reconciles without another upload', async () => {
    const fake = new FakeReview(); fake.loseAssetResponse = true
    const instance = await service(fake); await configure(instance); const { asset } = await addAsset(instance)
    const job = await processed(instance, asset.id)
    expect(job.status).toBe('unknown'); expect(job.errorMessage).not.toContain('signature')
    await instance.close()
    const restored = await service(fake, instance.store.root)
    await restored.reviewRuntime.start()
    await restored.reviewRuntime.action('w', job.id, { action: 'reconcile' })
    await wait(async () => (await restored.reviews.job('w', job.id)).status === 'processing')
    expect(fake.calls.filter((call) => call.action === 'CreateAsset')).toHaveLength(1)
  })
  it('isolates two suppliers and sends the overseas default strategy', async () => {
    const fake = new FakeReview(), instance = await service(fake)
    await configure(instance); await configure(instance, 'byteplus')
    await instance.reviews.ensureCanvas('w')
    const { asset } = await addAsset(instance)
    const input = { requestId: randomUUID(), assetId: asset.id, provider: 'byteplus' as const, groupType: 'AIGC' as const }
    const job = await instance.reviews.submit('w', input)
    await instance.reviewRuntime.start()
    await wait(async () => (await instance.reviews.job('w', job.id)).status === 'processing')
    expect(fake.calls.find((call) => call.action === 'CreateAsset')!.payload.Moderation).toEqual({ Strategy: 'Default' })
    const groups = await instance.reviews.db.all('SELECT provider,payload FROM review_groups')
    expect(new Set(groups.map((row) => JSON.parse(row.payload).groupId)).size).toBe(2)
    expect((await instance.reviews.page('w')).items.map((item) => item.provider)).toEqual(['byteplus'])
  })
  it('does not issue CreateAsset for a group of the wrong person type or project', async () => {
    const fake = new FakeReview(), instance = await service(fake)
    await configure(instance); const { asset } = await addAsset(instance)
    fake.groups.set('group-person', { Id: 'group-person', GroupType: 'AIGC', ProjectName: keys.projectName })
    const job = await instance.reviews.submit('w', { requestId: randomUUID(), assetId: asset.id, provider: 'bytedance', groupType: 'LivenessFace', groupId: 'group-person' })
    await instance.reviewRuntime.start()
    await wait(async () => (await instance.reviews.job('w', job.id)).status === 'failed')
    expect(fake.calls.filter((call) => call.action === 'CreateAsset')).toHaveLength(0)
  })
  it('shows official Failed as failed, allows one explicit retry, and keeps uncertain query failures distinct', async () => {
    const fake = new FakeReview(), instance = await service(fake)
    await configure(instance); const { asset } = await addAsset(instance)
    const job = await processed(instance, asset.id)
    fake.assets.get(job.providerAssetId!)!.Status = 'Failed'
    fake.assets.get(job.providerAssetId!)!.Error = { Code: 'FaceMismatch', Message: '人物不一致' }
    job.due = 0; await instance.reviews.saveJob(job); instance.reviewRuntime.wake()
    await wait(async () => (await instance.reviews.job('w', job.id)).status === 'failed')
    const failed = await instance.reviews.job('w', job.id)
    expect(failed.errorCode).toBe('FaceMismatch')
    const retry = await instance.reviewRuntime.action('w', job.id, { action: 'retry', requestId: randomUUID() })
    await wait(async () => (await instance.reviews.job('w', retry.id)).status === 'processing')
    expect(fake.calls.filter((call) => call.action === 'CreateAsset')).toHaveLength(2)
    const querying = await instance.reviews.job('w', retry.id)
    fake.queryError = true; querying.errors = 7; querying.due = 0
    await instance.reviews.saveJob(querying); instance.reviewRuntime.wake()
    await wait(async () => (await instance.reviews.job('w', retry.id)).status === 'unknown')
    const unknown = await instance.reviews.job('w', retry.id)
    expect(unknown.providerAssetId).toBe(querying.providerAssetId)
    expect(unknown.errorCode).toBe('NETWORK')
    await expect(instance.reviewRuntime.action('w', retry.id, { action: 'retry', requestId: randomUUID() })).rejects.toThrow('明确失败')
  })
  it('fences review writes when the owning main-store runtime token changes', async () => {
    const instance = await service()
    await instance.store.db.batch([sql('UPDATE owner_settings SET runtime_token=?', ['another-runtime'])])
    await expect(instance.reviews.audit('test', 'test')).rejects.toThrow('WRITER_FENCED')
    await instance.store.db.batch([sql('UPDATE owner_settings SET runtime_token=?', [instance.store.db.token])], true, true)
  })
  it('validates real dimensions independently of model-only restrictions', async () => {
    const tooSmall = await sharp({ create: { width: 300, height: 400, channels: 3, background: 'blue' } }).png().toBuffer()
    const asset = { id: randomUUID(), kind: 'image' as const, mime: 'image/png', bytes: tooSmall.length,
      filename: 'image', nodeId: null, taskId: null, createdAt: 1 }
    await expect(inspectReviewMedia(Readable.from([tooSmall]), asset, createHash('sha256').update(tooSmall).digest('hex'), new AbortController().signal)).rejects.toMatchObject({ code: 'REVIEW_DIMENSIONS' })
  })
})

describe('generation sources are frozen at acceptance', () => {
  it('refuses a missing new-task binding and a changed pinned file rather than silently using URL', async () => {
    const instance = await service(); const first = await addAsset(instance)
    const model = BUILTIN_MODELS.find((model) => model.protocol === 'seedance-video' && providerFor(model)?.id === 'bytedance')!
    await instance.store.saveModel({ ...model, endpoint_id: 'ep-binding', api_key: 'offline-key' })
    const node: CanvasNode = { id: randomUUID(), kind: 'video-generation', title: '视频', position: { x: 700, y: 0 },
      assetId: null, selectedResultId: null, modelId: model.id, prompt: '生成视频', params: defaultParams(model) }
    await instance.store.update('w', (state) => {
      state.graph.nodes.push(node); state.graph.edges.push({ id: randomUUID(), source: first.node.id, target: node.id, assetId: first.asset.id }); state.graphRevision++
    })
    const task = await instance.generate('w', node.id, instance.store.state('w').graphRevision, randomUUID())
    const row = await instance.reviews.db.get('SELECT * FROM generation_review_bindings WHERE task_id IS NULL')
    await instance.reviews.db.batch([sql('DELETE FROM generation_review_bindings WHERE request_id=?', [row.request_id])])
    await expect(instance.reviews.referenceUris(task.id, task.snapshot as any)).rejects.toMatchObject({ code: 'REVIEW_BINDING_MISSING' })
    await instance.reviews.db.batch([sql('INSERT INTO generation_review_bindings VALUES(?,?,?,?,?,?)',
      [row.request_id, row.request_hash, row.canvas_id, row.task_id, row.created_at, row.payload])])
    const reference = await instance.store.db.get('SELECT locator_json FROM task_references WHERE task_id=?', [task.id])
    const locator = JSON.parse(reference.locator_json)
    await instance.store.db.batch([sql('UPDATE task_references SET locator_json=? WHERE task_id=?', [JSON.stringify({ ...locator, sha256: '0'.repeat(64) }), task.id])])
    await expect(instance.reviews.referenceUris(task.id, task.snapshot as any)).rejects.toMatchObject({ code: 'MEDIA_CHANGED' })
  })
  it('preserves reference roles/order and posts asset:// only for trusted official prepared sources', async () => {
    const model = BUILTIN_MODELS.find((model) => model.protocol === 'seedance-video' && providerFor(model)?.id === 'bytedance')!
    const ids = [randomUUID(), randomUUID()]
    const assets = ids.map((id) => ({ id, kind: 'image' as const, filename: 'image.png', mime: 'image/png', bytes: 1000,
      width: 400, height: 400, nodeId: null, taskId: null, createdAt: 1 }))
    const reader = { readMedia: vi.fn(), stagePath: () => '', inspectReference: vi.fn(async (_task: string, id: string) => assets.find((asset) => asset.id === id)!),
      modelReferenceUrl: vi.fn(async () => 'https://source.invalid/original?signature=temporary') }
    const payloads: any[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      payloads.push(JSON.parse(String(init.body))); return Response.json({ id: 'generation-original' })
    }))
    const providers = new Providers(reader, { requestTimeoutMs: 1000, maxMediaBytes: 1000000, maxReferenceBytes: 500000 },
      new AbortController().signal, async () => new Map([[ids[1], 'asset://Asset-Case']]))
    const snapshot = { model: { ...model, endpoint_id: 'ep-original' }, prompt: '生成视频', referenceIds: ids,
      params: { ...defaultParams(model), videoMode: 'frames' as const, firstFrameId: ids[1], lastFrameId: ids[0] } }
    await providers.submit(snapshot, 'offline-key', await providers.prepare(snapshot, randomUUID()))
    expect(payloads[0].content.slice(1)).toEqual([
      { type: 'image_url', image_url: { url: 'https://source.invalid/original?signature=temporary' }, role: 'last_frame' },
      { type: 'image_url', image_url: { url: 'asset://Asset-Case' }, role: 'first_frame' },
    ])
    expect(reader.modelReferenceUrl).toHaveBeenCalledTimes(1)
  })
  it('uses mixed Asset URI and URL, retains a prior URL choice, and isolates later project changes', async () => {
    const fake = new FakeReview(), instance = await service(fake)
    await configure(instance)
    const first = await addAsset(instance), second = await addAsset(instance)
    const review = await instance.reviews.submit('w', { requestId: randomUUID(), assetId: first.asset.id, provider: 'bytedance', groupType: 'AIGC' })
    const model = BUILTIN_MODELS.find((model) => model.protocol === 'seedance-video' && providerFor(model)?.id === 'bytedance')!
    await instance.store.saveModel({ ...model, endpoint_id: 'ep-generation', api_key: 'generation-key' })
    const generator: CanvasNode = { id: randomUUID(), kind: 'video-generation', title: '视频', position: { x: 700, y: 0 },
      assetId: null, selectedResultId: null, modelId: model.id, prompt: '让图片动起来', params: defaultParams(model) }
    await instance.store.update('w', (state) => {
      state.graph.nodes.push(generator); state.graph.edges.push(...[first, second].map(({ asset, node }) =>
        ({ id: randomUUID(), source: node.id, target: generator.id, assetId: asset.id }))); state.graphRevision++
    })
    const revision = instance.store.state('w').graphRevision
    const urlTask = await instance.generate('w', generator.id, revision, randomUUID())
    const job = await instance.reviews.job('w', review.id)
    job.status = 'active'; job.providerAssetId = 'Asset-CasePreserved'; job.groupId = 'group-reviewed'; await instance.reviews.saveJob(job)
    const assetTask = await instance.generate('w', generator.id, revision, randomUUID())
    const urlBinding = await instance.reviews.generationBinding(urlTask.id)
    expect(urlBinding!.references.map((item) => item.source)).toEqual(['url', 'url'])
    const approved = await instance.reviews.referenceUris(assetTask.id, assetTask.snapshot as any)
    expect([...approved]).toEqual([[first.asset.id, 'asset://Asset-CasePreserved']])
    await instance.reviews.saveSettings({ provider: 'bytedance', revision: 1, projectName: 'Another-project' })
    const next = await instance.generate('w', generator.id, revision, randomUUID())
    expect((await instance.reviews.generationBinding(next.id))!.references.map((item) => item.source)).toEqual(['url', 'url'])
    expect([...await instance.reviews.referenceUris(assetTask.id, assetTask.snapshot as any)]).toEqual([...approved])
    await instance.close()
    const restored = await service(fake, instance.store.root)
    expect([...await restored.reviews.referenceUris(assetTask.id, assetTask.snapshot as any)]).toEqual([...approved])
    expect([...await restored.reviews.referenceUris(urlTask.id, urlTask.snapshot as any)]).toEqual([])
  })
})

it('reconciles across official list pages with exact names and rejects fuzzy or ambiguous matches without another upload', async () => {
  const fake = new FakeReview(), instance = await service(fake)
  await configure(instance); const { asset } = await addAsset(instance)
  fake.loseAssetResponse = true
  const original = await processed(instance, asset.id)
  expect(original.status).toBe('unknown')
  const actual = fake.assets.get([...fake.assets.keys()][0])!
  const rawCall = fake.call.bind(fake)
  let ambiguous = false
  const read = vi.spyOn(fake, 'call').mockImplementation(async (provider, credentials, action, payload) => {
    if (action !== 'ListAssets') return rawCall(provider, credentials, action, payload)
    fake.calls.push({ provider, action, payload, credentials })
    expect(payload.Filter).toMatchObject({ GroupType: 'AIGC', GroupIds: [actual.GroupId] })
    return !payload.NextToken ? { Items: [{ ...actual, Name: `${actual.Name}-fuzzy` }], NextToken: 'next-page' }
      : { Items: ambiguous ? [actual, { ...actual, Id: 'Asset-Ambiguous' }] : [actual] }
  })
  ambiguous = true
  await expect(instance.reviewRuntime.action('w', original.id, { action: 'reconcile' })).rejects.toMatchObject({ code: 'RECONCILE_UNKNOWN' })
  expect((await instance.reviews.job('w', original.id)).status).toBe('unknown')
  ambiguous = false
  await instance.reviewRuntime.action('w', original.id, { action: 'reconcile' })
  expect((await instance.reviews.job('w', original.id)).providerAssetId).toBe(actual.Id)
  expect(read.mock.calls.filter((call) => call[2] === 'ListAssets').map((call) => call[3].NextToken)).toEqual([undefined, 'next-page', undefined, 'next-page'])
  expect(fake.calls.filter((call) => call.action === 'CreateAsset')).toHaveLength(1)
})
