import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { CanvasService } from '../src/host/service'
import { fakeFactory, initialize } from './support/objectStorage'
import { Providers } from '../src/host/providers'
import { CanvasNodeSchema, defaultTtsParams, emptyGraph, FISH_TTS_ENDPOINT, TtsParamsSchema, type CanvasNode, type TaskStatus } from '../src/shared/contracts'
import { hash } from '../src/host/persistence/database'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); vi.unstubAllGlobals() })
async function instance(root?: string) {
  if (!root) { root = await mkdtemp(join(tmpdir(), 'canvas-tts-')); const dir = root; cleanups.push(() => rm(dir, { recursive: true, force: true })) }
  const service = new CanvasService({ dataDir: root, maxConcurrentTasks: 1, pollIntervalMs: 25, requestTimeoutMs: 2000, maxMediaBytes: 100_000, maxReferenceBytes: 1000 }, undefined, fakeFactory(root))
  await initialize(service, true); cleanups.push(() => service.close())
  return service
}
function node(): CanvasNode {
  return { id: randomUUID(), kind: 'tts-generation', title: '语音生成 1', position: { x: 12, y: 24 }, modelId: null,
    prompt: '(happy)(soft tone) 你好！', params: { ...defaultTtsParams(), reference_id: 'voice-123', speed: 1.2, volume: -2 }, assetId: null, selectedResultId: null }
}
function wav() {
  const bytes = Buffer.alloc(44 + 16000)
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(8000, 24)
  bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36); bytes.writeUInt32LE(16000, 40)
  for (let i = 0; i < 8000; i++) bytes.writeInt16LE(Math.round(Math.sin(i * .3) * 3000), 44 + i * 2)
  return bytes
}
async function wait(service: CanvasService, id: string, status: TaskStatus) {
  const deadline = Date.now() + 5000
  for (;;) {
    const task = service.store.state('w').tasks.find((task) => task.id === id)!
    if (task.status === status && !service.runtime.isActive(id)) return task
    if (Date.now() > deadline) throw new Error(`Wanted ${status}, received ${task.status}: ${task.error}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
const url = (suffix: string) => `http://localhost/api/canvas/v2/${suffix}`
function post(suffix: string, body: unknown) { return new Request(url(suffix), { method: 'POST', body: JSON.stringify(body) }) }
describe('FishTTS durable generation', () => {
  it('queues multiple voice submissions on one node with distinct inputs and keys and recovers them without changing DDL', async () => {
    const fetch = vi.fn(async () => new Response(wav())); vi.stubGlobal('fetch', fetch)
    const service = await instance(); await service.runtime.close()
    const ddl = await service.store.db.all("SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name")
    await service.store.saveTtsSettings({ endpoint: FISH_TTS_ENDPOINT, revision: 0, api_key: 'first-voice-key' })
    const tts = node(); await service.saveGraph('w', { ...emptyGraph(), nodes: [tts] }, 0)
    const first = await service.generate('w', tts.id, 1, randomUUID(), false, true)
    await service.store.saveTtsSettings({ endpoint: FISH_TTS_ENDPOINT, revision: 1, api_key: 'second-voice-key' })
    const current = service.store.state('w')
    const changed = { ...tts, prompt: '第二次朗读', params: { ...defaultTtsParams(), reference_id: 'other-voice', speed: .8, volume: 3 } }
    const saved = await service.saveGraph('w', { ...current.graph, nodes: [changed] }, current.graphRevision)
    const requestId = randomUUID()
    const second = await service.generate('w', tts.id, saved.graphRevision, requestId, false, true)
    expect((await service.generate('w', tts.id, saved.graphRevision, requestId, false, true)).id).toBe(second.id)
    expect((await service.store.taskPrivate(first.id)).key).toBe('first-voice-key')
    expect((await service.store.taskPrivate(second.id)).key).toBe('second-voice-key')
    expect(first.snapshot.prompt).toBe(tts.prompt)
    expect(second.snapshot).toMatchObject({ prompt: changed.prompt, params: changed.params })
    await service.close()
    const reopened = await instance(service.config.dataDir)
    await wait(reopened, first.id, 'completed'); await wait(reopened, second.id, 'completed')
    expect(fetch.mock.calls.map((call) => JSON.parse(call[1].body as string).text)).toEqual([tts.prompt, changed.prompt])
    expect(fetch.mock.calls.map((call) => new Headers(call[1].headers).get('Authorization'))).toEqual(['Bearer first-voice-key', 'Bearer second-voice-key'])
    const snapshot = await reopened.store.snapshot('w')
    expect(snapshot.tasks.map((task) => task.id)).toEqual([first.id, second.id])
    expect(snapshot.tasks[1].requestId).toBe(requestId)
    expect(snapshot.assets).toHaveLength(2)
    expect(await reopened.store.db.all("SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name")).toEqual(ddl)
  })
  it('accepts hashed TTS graph mutations without normalizing voice drafts and trims the submitted voice ID', async () => {
    const fetch = vi.fn(async () => new Response(wav())); vi.stubGlobal('fetch', fetch)
    const service = await instance()
    await service.store.ensureCanvas('w')
    const tts = { ...node(), params: { ...defaultTtsParams(), reference_id: '  voice-123  ' } }
    const mutationId = randomUUID()
    const input = { mutationId, baseRevision: 0, nodes: [{ value: tts, hash: hash(tts) }], edges: [], deleteNodes: [], deleteEdges: [] }
    const response = await service.handle(post('graph?canvas=w', input))
    expect(response.status).toBe(200)
    expect((await response.json()).graph.nodes[0]).toEqual(tts)
    expect((await service.handle(post('graph?canvas=w', input))).status).toBe(200)
    await service.store.saveTtsSettings({ endpoint: FISH_TTS_ENDPOINT, revision: 0, api_key: 'tts-fixture-key' })
    const task = await service.generate('w', tts.id, 1, randomUUID(), false, true)
    await wait(service, task.id, 'completed')
    expect(JSON.parse(fetch.mock.calls[0][1].body as string).reference_id).toBe('voice-123')
    expect(service.store.state('w').graph.nodes[0]).toEqual(tts)
  })
  it('streams the exact documented payload, preserves settings credentials and reopens a TTS graph without DDL changes', async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response(wav(), { headers: { 'Content-Type': 'audio/mpeg' } }))
    vi.stubGlobal('fetch', fetch)
    const service = await instance()
    const ddl = await service.store.db.all("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name")
    const publicSettings = await service.store.saveTtsSettings({ endpoint: FISH_TTS_ENDPOINT, revision: 0, api_key: 'tts-test-secret' })
    expect(publicSettings).toMatchObject({ configured: true, has_api_key: true, api_key_mask: '••••••••' })
    expect(JSON.stringify(publicSettings)).not.toContain('tts-test-secret')
    expect(await readFile(join(service.config.dataDir, 'tts-settings.json'), 'utf8')).not.toContain('tts-test-secret')
    const tts = node(); const saved = await service.saveGraph('w', { ...emptyGraph(), nodes: [tts] }, 0)
    const requestId = randomUUID()
    const response = await service.handle(post('tts-generate?canvas=w', { nodeId: tts.id, revision: saved.graphRevision, requestId }))
    expect(response.status).toBe(202)
    const summary = await response.json(); expect(summary).not.toHaveProperty('snapshot')
    const task = await wait(service, summary.id, 'completed')
    const [address, init] = fetch.mock.calls[0]
    expect(address).toBe(FISH_TTS_ENDPOINT)
    expect(init.headers).toEqual({ Authorization: 'Bearer tts-test-secret', 'Content-Type': 'application/json', model: 's1' })
    expect(JSON.parse(init.body as string)).toEqual({ text: tts.prompt, reference_id: 'voice-123', prosody: { speed: 1.2, volume: -2 }, format: 'mp3' })
    expect(task.snapshot.referenceIds).toEqual([])
    const asset = service.store.state('w').assets[0]
    expect(asset).toMatchObject({ kind: 'audio', mime: 'audio/wav', nodeId: tts.id, taskId: task.id })
    expect(await service.store.readMedia(asset.id, 100000)).toEqual(wav())
    const waveform = await service.handle(new Request(url(`media?canvas=w&id=${asset.id}&variant=waveform&v=1`)))
    expect(waveform.status).toBe(200); expect((await waveform.json()).peaks).toHaveLength(96)
    expect(waveform.headers.get('location')).toBeNull()
    expect((await service.generate('w', tts.id, saved.graphRevision, requestId, false, true)).id).toBe(task.id)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(await service.store.db.get('SELECT kind,params_json,content_hash FROM canvas_nodes WHERE canvas_id=? AND id=?', ['w', tts.id])).toMatchObject({ kind: 'audio-asset', content_hash: hash(tts) })
    expect(await service.store.db.all("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name")).toEqual(ddl)
    const before = await service.store.snapshot('w')
    await service.close()
    const reopened = await instance(service.config.dataDir)
    expect(await reopened.store.snapshot('w')).toEqual(before)
    expect(reopened.store.ttsSettings()).toEqual(publicSettings)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('refuses missing service, wrong routes, empty text and inbound edges before any request', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    const service = await instance(); const tts = node()
    await service.saveGraph('w', { ...emptyGraph(), nodes: [tts] }, 0)
    await expect(service.generate('w', tts.id, 1, randomUUID(), false, true)).rejects.toMatchObject({ code: 'TTS_NOT_CONFIGURED' })
    await expect(service.generate('w', tts.id, 0, randomUUID(), false, true)).rejects.toMatchObject({ code: 'GRAPH_CONFLICT' })
    await expect(service.generate('w', tts.id, 1, randomUUID(), true)).rejects.toThrow('语音生成接口')
    const source = { ...tts, id: randomUUID(), kind: 'audio-asset' as const, params: null, prompt: '', assetId: null as string | null }
    await service.store.update('w', (state) => { state.graph.nodes.push(source) })
    const asset = await service.store.saveMedia(Readable.from([wav()]), { id: randomUUID(), kind: 'audio', filename: 'audio.wav', createdAt: 1, nodeId: source.id, taskId: null }, 100_000, 'audio')
    source.assetId = asset.id
    await service.store.update('w', (state) => { state.assets.push(asset); state.graph.nodes.find((n) => n.id === source.id)!.assetId = asset.id })
    const state = service.store.state('w')
    await expect(service.saveGraph('w', { ...state.graph, edges: [{ id: randomUUID(), source: source.id, target: tts.id, assetId: source.assetId! }] }, state.graphRevision)).rejects.toThrow('不支持输入连线')
    await service.saveGraph('w', { ...state.graph, nodes: state.graph.nodes.map((n) => n.id === tts.id ? { ...n, prompt: '(happy)' } : n) }, state.graphRevision)
    await expect(service.generate('w', tts.id, service.store.state('w').graphRevision, randomUUID(), false, true)).rejects.toThrow('朗读的文字')
    expect(service.store.state('w').tasks).toHaveLength(0); expect(fetch).not.toHaveBeenCalled()
    for (const speed of [0, -1, NaN, Infinity]) expect(TtsParamsSchema.safeParse({ ...defaultTtsParams(), speed }).success).toBe(false)
    expect(CanvasNodeSchema.safeParse({ ...tts, modelId: randomUUID() }).success).toBe(false)
  })
  it('pins accepted credentials and endpoint across settings rotation and host restart', async () => {
    const fetch = vi.fn(async () => new Response(wav())); vi.stubGlobal('fetch', fetch)
    const service = await instance(); await service.runtime.close()
    await service.store.saveTtsSettings({ endpoint: FISH_TTS_ENDPOINT, revision: 0, api_key: 'old-test-key' })
    const tts = node(); await service.saveGraph('w', { ...emptyGraph(), nodes: [tts] }, 0)
    const accepted = await service.generate('w', tts.id, 1, randomUUID(), false, true)
    await expect(service.store.saveTtsSettings({ endpoint: 'http://localhost:9902/tts', revision: 1, api_key: 'new-test-key' })).rejects.toMatchObject({ code: 'MODEL_NOT_SUPPORTED' })
    await service.store.saveTtsSettings({ endpoint: FISH_TTS_ENDPOINT, revision: 1, api_key: 'new-test-key' })
    await expect(service.store.saveTtsSettings({ endpoint: FISH_TTS_ENDPOINT, revision: 1 })).rejects.toMatchObject({ code: 'SETTINGS_CONFLICT' })
    expect((await service.store.taskPrivate(accepted.id)).key).toBe('old-test-key')
    await service.close()
    const reopened = await instance(service.config.dataDir); await wait(reopened, accepted.id, 'completed')
    expect(fetch).toHaveBeenCalledWith(FISH_TTS_ENDPOINT, expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer old-test-key' }) }))
    expect(reopened.store.ttsSettings().endpoint).toBe(FISH_TTS_ENDPOINT)
    const before = reopened.store.ttsService().credentialRef
    await reopened.store.saveTtsSettings({ endpoint: FISH_TTS_ENDPOINT, revision: 2 })
    expect(reopened.store.ttsService().credentialRef).toBe(before)
  })
  it('rejects empty or cleared credentials before accepting a new task while accepted tasks retain their original key', async () => {
    const fetch = vi.fn(async () => new Response(wav())); vi.stubGlobal('fetch', fetch)
    const service = await instance()
    await service.runtime.close()
    const first = node(), second = node()
    await service.saveGraph('w', { ...emptyGraph(), nodes: [first, second] }, 0)
    const empty = await service.store.saveTtsSettings({ endpoint: FISH_TTS_ENDPOINT, revision: 0, api_key: '' })
    expect(empty).toMatchObject({ configured: true, has_api_key: false })
    await expect(service.generate('w', first.id, 1, randomUUID(), false, true)).rejects.toMatchObject({ code: 'TTS_NOT_CONFIGURED' })
    expect(service.store.state('w').tasks).toEqual([])
    await service.store.saveTtsSettings({ endpoint: FISH_TTS_ENDPOINT, revision: 1, api_key: 'accepted-tts-key' })
    const requestId = randomUUID()
    const accepted = await service.generate('w', first.id, 1, requestId, false, true)
    await service.store.saveTtsSettings({ endpoint: FISH_TTS_ENDPOINT, revision: 2, api_key: '' })
    const rejected = await service.handle(post('tts-generate?canvas=w', { nodeId: second.id, revision: 1, requestId: randomUUID() }))
    expect(rejected.status).toBe(400); expect(await rejected.json()).toMatchObject({ code: 'TTS_NOT_CONFIGURED' })
    expect(service.store.state('w').tasks).toHaveLength(1)
    expect((await service.store.taskPrivate(accepted.id)).key).toBe('accepted-tts-key')
    expect((await service.generate('w', first.id, 1, requestId, false, true)).id).toBe(accepted.id)
    expect(fetch).not.toHaveBeenCalled()
    await service.close()
    const reopened = await instance(service.config.dataDir)
    await wait(reopened, accepted.id, 'completed')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(new Headers(fetch.mock.calls[0][1].headers).get('Authorization')).toBe('Bearer accepted-tts-key')
    expect(reopened.store.ttsSettings().has_api_key).toBe(false)
  })
  it.each([[401, 'failed'], [503, 'unknown']] as const)('classifies HTTP %s and does not silently repeat submission', async (status, expected) => {
    const fetch = vi.fn(async () => Response.json({ message: 'tts-key-test 请求失败' }, { status })); vi.stubGlobal('fetch', fetch)
    const service = await instance()
    await service.store.saveTtsSettings({ endpoint: FISH_TTS_ENDPOINT, revision: 0, api_key: 'tts-key-test' })
    const tts = node(); await service.saveGraph('w', { ...emptyGraph(), nodes: [tts] }, 0)
    const task = await service.generate('w', tts.id, 1, randomUUID(), false, true)
    const finished = await wait(service, task.id, expected)
    expect(finished.error).toContain('[已脱敏]'); expect(finished.error).not.toContain('tts-key-test')
    for (let i = 0; i < 4; i++) { service.runtime.wake(); await new Promise((r) => setTimeout(r, 20)) }
    expect(fetch).toHaveBeenCalledTimes(1)
    await service.close(); const reopened = await instance(service.config.dataDir)
    expect(reopened.store.state('w').tasks[0].status).toBe(expected); expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('retries a failed publication using the same audio without another API call', async () => {
    const fetch = vi.fn(async () => new Response(wav())); vi.stubGlobal('fetch', fetch)
    const service = await instance()
    await service.store.saveTtsSettings({ endpoint: FISH_TTS_ENDPOINT, revision: 0, api_key: 'tts-retry-fixture-key' })
    const save = service.store.saveMedia.bind(service.store)
    service.store.saveMedia = async (source) => { source.destroy(); throw new Error('disk test failure') }
    const tts = node(); await service.saveGraph('w', { ...emptyGraph(), nodes: [tts] }, 0)
    const accepted = await service.generate('w', tts.id, 1, randomUUID(), false, true)
    await wait(service, accepted.id, 'save_failed')
    const id = (await service.store.taskPrivate(accepted.id)).outputs![0].id
    service.store.saveMedia = save
    await service.taskAction('w', accepted.id, 'retry-save')
    expect((await wait(service, accepted.id, 'completed')).resultIds).toEqual([id]); expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('rejects oversized or non-audio successful streams and removes partial staging bytes', async () => {
    const service = await instance()
    await service.store.saveTtsSettings({ endpoint: FISH_TTS_ENDPOINT, revision: 0, api_key: 'tts-media-fixture-key' })
    const snapshot = { model: service.store.ttsService().model, params: defaultTtsParams(), prompt: 'hello', referenceIds: [] }
    const provider = new Providers(service.store, { requestTimeoutMs: 2000, maxMediaBytes: 1000, maxReferenceBytes: 1000 }, new AbortController().signal)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(wav())))
    await expect(provider.submit(snapshot, '')).rejects.toMatchObject({ code: 'MEDIA_TOO_LARGE' })
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ status: 200, message: 'not audio' })))
    await expect(provider.submit(snapshot, '')).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA' })
    const { readdir } = await import('node:fs/promises')
    expect(await readdir(join(service.config.dataDir, 'staging'))).toEqual([])
  })
})
