import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { CanvasService } from '../src/host/service'
import { decodeWaveform, WaveformAccumulator } from '../src/host/media/waveforms'
import { fileHash } from '../src/host/media/files'
import { WAVEFORM_BARS } from '../src/shared/audioWaveform'
import type { CanvasNode } from '../src/shared/contracts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })
async function service() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'canvas-waveforms-')))
  cleanup.push(() => rm(root, { force: true, recursive: true }))
  const instance = new CanvasService({ dataDir: root, maxConcurrentTasks: 1, pollIntervalMs: 50, requestTimeoutMs: 1000, maxMediaBytes: 10_000_000, maxReferenceBytes: 1_000_000 })
  await instance.store.init(); cleanup.push(() => instance.close())
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
describe('derived audio waveforms', () => {
  it('extracts real loudness, silence and duration, retaining opposite-phase stereo energy', async () => {
    const instance = await service(); const asset = await audio(instance)
    const data = await decodeWaveform(instance.store.mediaPath(asset.id), new AbortController().signal)
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
    const original = await fileHash(instance.store.mediaPath(asset.id))
    const responses = await Promise.all(Array.from({ length: 8 }, () => request(instance, asset.id)))
    const results = await Promise.all(responses.map((response) => {
      expect(response.status).toBe(200); expect(response.headers.get('content-type')).toBe('application/json')
      return response.json()
    }))
    for (const result of results) expect(result).toEqual(results[0])
    const head = await request(instance, asset.id, '&variant=waveform&v=1', 'HEAD')
    expect(head.status).toBe(200); expect(await head.text()).toBe('')
    expect(head.headers.get('content-length')).toBe(String(Buffer.byteLength(JSON.stringify(results[0]))))
    const cache = join(instance.config.dataDir, 'previews/waveforms')
    const files = await readdir(cache)
    expect(files).toHaveLength(1)
    expect((await stat(join(cache, files[0]))).mode & 0o777).toBe(0o600)
    expect(await fileHash(instance.store.mediaPath(asset.id))).toBe(original)
    expect(await instance.store.snapshot('w')).toEqual(before)
    expect((await instance.store.db.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"))).toHaveLength(21)
    expect((await request(instance, asset.id, '')).status).toBe(200)
  })
  it('rejects ownership/version errors and unsafe cache paths; raw audio stays available', async () => {
    const instance = await service(); const asset = await audio(instance)
    expect((await request(instance, asset.id, '&variant=waveform&v=2')).status).toBe(400)
    expect((await request(instance, asset.id, '&variant=preview&v=1')).status).toBe(415)
    const missing = await instance.handle(new Request(`http://localhost/api/canvas/v2/media?canvas=other&id=${asset.id}&variant=waveform`))
    expect(missing.status).toBe(404)
    await request(instance, asset.id)
    const directory = join(instance.config.dataDir, 'previews/waveforms')
    const [name] = await readdir(directory)
    await rm(join(directory, name))
    await symlink(instance.store.mediaPath(asset.id), join(directory, name))
    const response = await request(instance, asset.id)
    expect(response.status).toBe(409); expect((await response.json()).code).toBe('UNSAFE_PATH')
    expect((await request(instance, asset.id, '')).status).toBe(200)
  })
  it('isolates corrupt audio from playback/download and bounds failed decoding retries', async () => {
    const instance = await service()
    const broken = Buffer.alloc(64); broken.write('RIFF', 0); broken.write('WAVE', 8)
    const asset = await audio(instance, broken)
    const first = await request(instance, asset.id)
    expect(first.status).toBe(422); expect((await first.json()).code).toBe('WAVEFORM_UNAVAILABLE')
    expect((await request(instance, asset.id)).status).toBe(422)
    expect((await request(instance, asset.id, '')).status).toBe(200)
    expect(await readdir(join(instance.config.dataDir, 'previews/waveforms'))).toEqual([])
  })
  it('rejects aborted decoding and waits for queued work on close without publishing a cache', async () => {
    const instance = await service(); const asset = await audio(instance)
    const controller = new AbortController(); controller.abort()
    await expect(decodeWaveform(instance.store.mediaPath(asset.id), controller.signal)).rejects.toThrow()
    const path = join(instance.config.dataDir, 'long.wav')
    await writeFile(path, wav())
    const pending = instance.waveforms.get('w', randomUUID(), path, await fileHash(path))
    const outcome = pending.catch(() => null)
    await instance.waveforms.close()
    expect(await outcome).toBeNull()
    expect(await readFile(instance.store.mediaPath(asset.id))).toEqual(wav())
  })
})
