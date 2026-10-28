import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, readdir, writeFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { execFileSync } from 'node:child_process'
import sharp from 'sharp'
import ffmpeg from '@ffmpeg-installer/ffmpeg'
import { CanvasService } from '../src/host/service'
import { PreviewCache } from '../src/host/media/previews'
import { mediaFrame } from '../src/client/mediaLayout'
import type { CanvasNode } from '../src/shared/contracts'
import { fakeFactory, initialize, remoteBody } from './support/objectStorage'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })
async function service() {
  const root = await mkdtemp(join(tmpdir(), 'canvas-previews-'))
  cleanup.push(() => rm(root, { force: true, recursive: true }))
  const instance = new CanvasService({ dataDir: root, maxConcurrentTasks: 2, pollIntervalMs: 50, requestTimeoutMs: 1000, maxMediaBytes: 10 * 1024 * 1024, maxReferenceBytes: 1024 * 1024 }, undefined, fakeFactory(root))
  await initialize(instance); cleanup.push(() => instance.close()); await instance.store.ensureCanvas('w')
  return instance
}
async function asset(instance: CanvasService, bytes: Buffer, kind: 'image' | 'video') {
  const node: CanvasNode = { id: randomUUID(), kind: `${kind}-asset`, title: '资源', position: { x: 0, y: 0 }, prompt: '', params: null, modelId: null, assetId: null, selectedResultId: null }
  await instance.store.update('w', (state) => state.graph.nodes.push(node))
  const result = await instance.store.saveMedia(Readable.from([bytes]), { id: randomUUID(), kind, filename: 'original', nodeId: node.id, taskId: null, createdAt: 1 }, 10 * 1024 * 1024, kind)
  await instance.store.update('w', (state) => { state.assets.push(result); state.graph.nodes.find((n) => n.id === node.id)!.assetId = result.id })
  return result
}
function request(instance: CanvasService, id: string, query = '&variant=preview&v=1', method = 'GET') {
  return instance.handle(new Request(`http://localhost/api/canvas/v2/media?canvas=w&id=${id}${query}`, { method }))
}
describe('OSS derived media previews', () => {
  it('deduplicates EXIF-aware decoding, persists one derivative and leaves no local preview library', async () => {
    const instance = await service()
    const input = await sharp({ create: { width: 1800, height: 900, channels: 3, background: '#dc3623' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer()
    const result = await asset(instance, input, 'image'), before = await instance.store.snapshot('w')
    const responses = await Promise.all(Array.from({ length: 8 }, () => request(instance, result.id)))
    const buffers = await Promise.all(responses.map((r) => remoteBody(instance.store, r)))
    for (const bytes of buffers) expect(bytes).toEqual(buffers[0])
    expect(await sharp(buffers[0]).metadata()).toMatchObject({ width: 480, height: 960, format: 'webp' })
    expect(await instance.store.db.get('SELECT COUNT(*) AS count FROM asset_variants')).toMatchObject({ count: 1 })
    expect(await readdir(instance.config.dataDir)).not.toContain('previews')
    expect(await instance.store.readMedia(result.id, 10000000)).toEqual(input)
    expect(await instance.store.snapshot('w')).toEqual(before)
    const head = await request(instance, result.id, '&variant=preview&v=1', 'HEAD')
    expect(head.headers.get('location')).toContain('method=HEAD'); expect(await head.text()).toBe('')
    const download = await request(instance, result.id, '&download=1')
    expect(download.headers.get('location')).toContain('download=1')
  })
  it('uses the first video frame while original bytes remain in OSS', async () => {
    const instance = await service(), fixture = join(instance.config.dataDir, 'two-colors.mp4')
    execFileSync(ffmpeg.path, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=640x360:r=10:d=0.5', '-f', 'lavfi', '-i', 'color=c=blue:s=640x360:r=10:d=0.5', '-filter_complex_threads', '1', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', fixture])
    const input = await readFile(fixture), result = await asset(instance, input, 'video')
    const output = await remoteBody(instance.store, await request(instance, result.id))
    const pixel = await sharp(output).resize(1, 1).removeAlpha().raw().toBuffer()
    expect(pixel[0]).toBeGreaterThan(230); expect(pixel[2]).toBeLessThan(20)
    expect(await instance.store.readMedia(result.id, 10000000)).toEqual(input)
  })
  it('rejects foreign ownership and isolates corrupt decoding from original access', async () => {
    const instance = await service()
    const input = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom0000isommp42'), Buffer.alloc(80)])
    const result = await asset(instance, input, 'video')
    await instance.store.ensureCanvas('other')
    expect((await instance.handle(new Request(`http://localhost/api/canvas/v2/media?canvas=other&id=${result.id}&variant=preview`))).status).toBe(404)
    expect((await request(instance, result.id)).status).toBe(422)
    expect((await request(instance, result.id)).status).toBe(422)
    expect(await remoteBody(instance.store, await request(instance, result.id, ''))).toEqual(input)
    expect((await request(instance, result.id, '&variant=preview&v=999')).status).toBe(400)
  })
  it('stops native image conversion without an unhandled error or published output', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'canvas-preview-stop-')))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const cache = new PreviewCache(root); cleanup.push(() => cache.close())
    const source = join(root, 'large.jpg')
    await writeFile(source, await sharp({ create: { width: 10000, height: 7000, channels: 3, background: 'orange' } }).jpeg().toBuffer())
    const job = cache.get('w', randomUUID(), source, 'hash', 'image').catch((error) => error.code)
    await new Promise((resolve) => setTimeout(resolve, 30)); await cache.close()
    expect(await job).toBe('PREVIEW_UNAVAILABLE'); expect(await readdir(join(root, 'previews'))).toHaveLength(0)
  })
})
it('fits portraits, wide images and quarter turns without changing aspect', () => {
  expect(mediaFrame(1920, 1080)).toMatchObject({ width: 320, height: 180 })
  expect(mediaFrame(1080, 1920)).toMatchObject({ width: 270, height: 480 })
  expect(mediaFrame(1920, 1080, 90)).toEqual({ width: 270, height: 480, imageWidth: 480, imageHeight: 270 })
  expect(mediaFrame(0, NaN)).toMatchObject({ width: 320, height: 180 })
})
