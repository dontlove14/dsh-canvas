import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { CanvasService } from '../src/host/service'
import { fakeFactory, initialize, cloudPath } from './support/objectStorage'
import { sql } from '../src/host/persistence/database'
import { decodeWaveform, WaveformAccumulator } from '../src/host/media/waveforms'
import { fileHash } from '../src/host/media/files'
import { WAVEFORM_BARS } from '../src/shared/audioWaveform'
import type { CanvasNode } from '../src/shared/contracts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); for (const dispose of cleanup.splice(0).reverse()) await dispose() })
async function service() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'canvas-waveforms-')))
  cleanup.push(() => rm(root, { force: true, recursive: true }))
  const instance = new CanvasService({ dataDir: root, maxConcurrentTasks: 1, pollIntervalMs: 50, requestTimeoutMs: 1000, maxMediaBytes: 10_000_000, maxReferenceBytes: 1_000_000 }, undefined, fakeFactory(root))
  await initialize(instance); cleanup.push(() => instance.close())
  await instance.store.ensureCanvas('w')
  return instance
}
function wav() {
  const rate = 22050, frames = rate * 3
  const buffer = Buffer.alloc(44 + frames * 4)
  buffer.write('RIFF', 0); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8)
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(2, 22)
  buffer.writeUInt32LE(rate, 24); buffer.writeUInt32LE(rate * 4, 28); buffer.writeUInt16LE(4, 32); buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36); buffer.writeUInt32LE(frames * 4, 40)
  for (let i = 0; i < frames; i++) {
    const level = i < rate ? .15 : i < rate * 2 ? .75 : 0
    const sample = Math.round(Math.sin(i / rate * Math.PI * 2 * 220) * level * 32767)
    buffer.writeInt16LE(sample, 44 + i * 4); buffer.writeInt16LE(-sample, 46 + i * 4)
  }
  return buffer
}
async function audio(instance: CanvasService, buffer = wav()) {
  const node: CanvasNode = { id: randomUUID(), kind: 'audio-asset', title: '音乐', position: { x: 0, y: 0 }, prompt: '', params: null, modelId: null, assetId: null, selectedResultId: null }
  await instance.store.update('w', (state) => { state.graph.nodes.push(node) })
  const asset = await instance.store.saveMedia(Readable.from([buffer]), { id: randomUUID(), kind: 'audio', filename: 'music.wav', nodeId: node.id, taskId: null, createdAt: 1 }, 10_000_000, 'audio')
  await instance.store.update('w', (state) => { state.assets.push(asset); state.graph.nodes[0].assetId = asset.id })
  return asset
}
const request = (instance: CanvasService, id: string, query = '&variant=waveform&v=1', method = 'GET') =>
  instance.handle(new Request(`http://localhost/api/canvas/v2/media?canvas=w&id=${id}${query}`, { method }))
const envelope = (level = .5) => Buffer.from(JSON.stringify({ version: 1, duration: 3, peaks: Array(WAVEFORM_BARS).fill(level) }))
async function savedWaveform(instance: CanvasService, id: string, bytes: Buffer) {
  const original = await instance.store.locator('w', id)
  const locator = { ...original, objectKey: `${original.objectKey}/_test/${randomUUID()}.json`,
    bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), mime: 'application/json', etag: undefined }
  const receipt = await instance.store.objects.publish(locator, bytes); locator.etag = receipt.etag
  await instance.store.db.batch([sql('INSERT OR REPLACE INTO asset_variants VALUES(?,?,?,?)', ['w', id, 'waveform', JSON.stringify(locator)])])
  return locator
}
describe('derived audio waveforms', () => {
  it('extracts real loudness, silence and duration, retaining opposite-phase stereo energy', async () => {
    const instance = await service(); const asset = await audio(instance)
    const data = await decodeWaveform(await cloudPath(instance.store, asset.id), new AbortController().signal)
    expect(data.duration).toBeCloseTo(3, 3); expect(data.peaks).toHaveLength(WAVEFORM_BARS)
    expect(data.peaks[10]).toBeCloseTo(.2, 1)
    expect(data.peaks[45]).toBeGreaterThan(.95)
    expect(data.peaks[90]).toBe(0)
  })
  it('handles fragmented PCM and compacts a long envelope without losing its duration or energy', () => {
    const buffer = Buffer.alloc(16384 * 8)
    for (let i = 0; i < buffer.length; i += 8) { buffer.writeFloatLE(.5, i); buffer.writeFloatLE(-.5, i + 4) }
    const full = new WaveformAccumulator(), fragments = new WaveformAccumulator()
    for (let i = 0; i < 140; i++) {
      full.push(buffer)
      fragments.push(buffer.subarray(0, 3)); fragments.push(buffer.subarray(3, 100001)); fragments.push(buffer.subarray(100001))
    }
    const result = full.finish()
    expect(result.duration).toBeCloseTo(16384 * 140 / 22050)
    expect(result.peaks.every((peak) => peak === 1)).toBe(true)
    expect(fragments.finish()).toEqual(result)
    expect(() => new WaveformAccumulator().finish()).toThrow('no complete')
  })
  it('caches concurrent requests and HEAD privately, keeping original media, graph and DDL unchanged', async () => {
    const instance = await service(); const asset = await audio(instance)
    const before = await instance.store.snapshot('w')
    const original = await fileHash(await cloudPath(instance.store, asset.id))
    const responses = await Promise.all(Array.from({ length: 8 }, () => request(instance, asset.id)))
    const results = await Promise.all(responses.map(async (response) => {
      expect(response.status).toBe(200)
      expect(response.headers.get('location')).toBeNull()
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
      return response.json()
    }))
    for (const result of results) expect(result).toEqual(results[0])
    const head = await request(instance, asset.id, '&variant=waveform&v=1', 'HEAD')
    expect(head.status).toBe(200); expect(await head.text()).toBe('')
    expect(head.headers.get('location')).toBeNull()
    expect(head.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(head.headers.get('content-length')).toBe(responses[0].headers.get('content-length'))
    expect(await instance.store.db.get('SELECT COUNT(*) AS count FROM asset_variants')).toMatchObject({ count: 1 })
    expect(await readdir(instance.config.dataDir)).not.toContain('previews')
    expect(await fileHash(await cloudPath(instance.store, asset.id))).toBe(original)
    expect(await instance.store.snapshot('w')).toEqual(before)
    expect((await instance.store.db.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"))).toHaveLength(23)
    expect((await request(instance, asset.id, '')).status).toBe(307)
  })
  it('coalesces OSS reads, caches GET/HEAD and refreshes after expiry or a locator change', async () => {
    const instance = await service(), asset = await audio(instance), bytes = envelope()
    const locator = await savedWaveform(instance, asset.id, bytes)
    const adapter = await instance.store.objects.adapter(locator.providerId)
    const read = vi.spyOn(adapter, 'openRead'), sign = vi.spyOn(adapter, 'signRead')
    const responses = await Promise.all(Array.from({ length: 8 }, () => request(instance, asset.id)))
    for (const response of responses) expect(await response.text()).toBe(bytes.toString())
    expect(read).toHaveBeenCalledTimes(1); expect(sign).not.toHaveBeenCalled()
    expect((await request(instance, asset.id, '&variant=waveform&v=1', 'HEAD')).status).toBe(200)
    expect(read).toHaveBeenCalledTimes(1)
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 3600001)
    expect((await request(instance, asset.id)).status).toBe(200); expect(read).toHaveBeenCalledTimes(2)
    const replacement = envelope(.8); await savedWaveform(instance, asset.id, replacement)
    expect(await (await request(instance, asset.id)).text()).toBe(replacement.toString())
    expect(read).toHaveBeenCalledTimes(3)
  })
  it.each([
    Buffer.from('{invalid'),
    Buffer.from(JSON.stringify({ version: 2, duration: 3, peaks: Array(WAVEFORM_BARS).fill(.5) })),
    Buffer.from(JSON.stringify({ version: 1, duration: 3, peaks: [.5] })),
  ])('isolates invalid saved waveforms and cools failed reads without blocking playback', async (bytes) => {
    const instance = await service(), asset = await audio(instance)
    const locator = await savedWaveform(instance, asset.id, bytes)
    const read = vi.spyOn(await instance.store.objects.adapter(locator.providerId), 'openRead')
    const failed = await request(instance, asset.id)
    expect(failed.status).toBe(422); expect((await failed.json()).code).toBe('WAVEFORM_UNAVAILABLE')
    expect((await request(instance, asset.id)).status).toBe(422); expect(read).toHaveBeenCalledTimes(1)
    expect((await request(instance, asset.id, '')).status).toBe(307)
    await savedWaveform(instance, asset.id, envelope())
    expect((await request(instance, asset.id)).status).toBe(200)
  })
  it('limits both declared and streamed bytes and rejects changed object content', async () => {
    const instance = await service(), asset = await audio(instance)
    const large = Buffer.concat([envelope(), Buffer.alloc(8192, 32)])
    let locator = await savedWaveform(instance, asset.id, large)
    const read = vi.spyOn(await instance.store.objects.adapter(locator.providerId), 'openRead')
    expect((await request(instance, asset.id)).status).toBe(422); expect(read).not.toHaveBeenCalled()
    locator = await savedWaveform(instance, asset.id, envelope())
    read.mockResolvedValueOnce(Readable.from([large.subarray(0, 8000), large.subarray(8000)]))
    expect((await request(instance, asset.id)).status).toBe(422)
    await savedWaveform(instance, asset.id, envelope(.6))
    read.mockResolvedValueOnce(Readable.from([envelope(.7)]))
    const changed = await request(instance, asset.id)
    expect(changed.status).toBe(409); expect((await changed.json()).code).toBe('OBJECT_CHANGED')
    expect((await request(instance, asset.id, '')).status).toBe(307)
  })
  it('bounds distinct concurrent reads and aborts active streams when closed', async () => {
    const instance = await service(), asset = await audio(instance)
    const locator = await savedWaveform(instance, asset.id, envelope())
    vi.spyOn(instance.derived, 'get').mockImplementation(async (_canvas, id) => ({ ...locator, objectKey: `${locator.objectKey}/${id}` }))
    const streams: Readable[] = []
    const read = vi.spyOn(await instance.store.objects.adapter(locator.providerId), 'openRead').mockImplementation(async () => {
      const stream = new Readable({ read() {} }); streams.push(stream); return stream
    })
    const pending = Array.from({ length: 32 }, (_, i) => instance.derived.waveform('w', String(i)).catch(() => null))
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(32))
    await expect(instance.derived.waveform('w', 'overflow')).rejects.toMatchObject({ status: 503 })
    await instance.derived.close()
    expect(await Promise.all(pending)).toEqual(Array(32).fill(null))
    expect(streams.every((stream) => stream.destroyed)).toBe(true)
    await expect(instance.derived.waveform('w', 'closed')).rejects.toThrow()
  })
  it('rejects ownership/version errors; raw audio stays available', async () => {
    const instance = await service(); const asset = await audio(instance)
    expect((await request(instance, asset.id, '&variant=waveform&v=2')).status).toBe(400)
    expect((await request(instance, asset.id, '&variant=preview&v=1')).status).toBe(415)
    const missing = await instance.handle(new Request(`http://localhost/api/canvas/v2/media?canvas=other&id=${asset.id}&variant=waveform`))
    expect(missing.status).toBe(404)
    await request(instance, asset.id)
    expect(await readdir(instance.config.dataDir)).not.toContain('previews')
    expect((await request(instance, asset.id, '')).status).toBe(307)
  })
  it('isolates corrupt audio from playback/download and bounds failed decoding retries', async () => {
    const instance = await service()
    const broken = Buffer.alloc(64); broken.write('RIFF', 0); broken.write('WAVE', 8)
    const asset = await audio(instance, broken)
    const first = await request(instance, asset.id)
    expect(first.status).toBe(422); expect((await first.json()).code).toBe('WAVEFORM_UNAVAILABLE')
    expect((await request(instance, asset.id)).status).toBe(422)
    expect((await request(instance, asset.id, '')).status).toBe(307)
    expect(await readdir(instance.config.dataDir)).not.toContain('previews')
  })
  it('rejects aborted decoding and waits for queued work on close without publishing a cache', async () => {
    const instance = await service(); const asset = await audio(instance)
    const controller = new AbortController(); controller.abort()
    await expect(decodeWaveform(await cloudPath(instance.store, asset.id), controller.signal)).rejects.toThrow()
    const path = join(instance.config.dataDir, 'long.wav')
    await writeFile(path, wav())
    const pending = instance.waveforms.get('w', randomUUID(), path, await fileHash(path))
    const outcome = pending.catch(() => null)
    await instance.waveforms.close()
    expect(await outcome).toBeNull()
    expect(await instance.store.readMedia(asset.id, 10000000)).toEqual(wav())
  })
})
