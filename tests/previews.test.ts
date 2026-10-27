import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, readdir, stat, symlink, writeFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { execFileSync } from 'node:child_process'
import sharp from 'sharp'
import ffmpeg from '@ffmpeg-installer/ffmpeg'
import { CanvasService } from '../src/host/service'
import { fileHash } from '../src/host/media/files'
import { PreviewCache } from '../src/host/media/previews'
import { mediaFrame } from '../src/client/mediaLayout'
import type { CanvasNode } from '../src/shared/contracts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })
async function service() {
  const root = await mkdtemp(join(tmpdir(), 'canvas-previews-'))
  cleanup.push(() => rm(root, { force: true, recursive: true }))
  const instance = new CanvasService({ dataDir: root, maxConcurrentTasks: 2, pollIntervalMs: 50, requestTimeoutMs: 1000, maxMediaBytes: 10 * 1024 * 1024, maxReferenceBytes: 1024 * 1024 })
  await instance.store.init(); cleanup.push(() => instance.close())
  await instance.store.ensureCanvas('w')
  return instance
}
async function asset(instance: CanvasService, bytes: Buffer, kind: 'image' | 'video') {
  const node: CanvasNode = { id: randomUUID(), kind: `${kind}-asset`, title: '资源', position: { x: 0, y: 0 }, prompt: '', params: null, modelId: null, assetId: null, selectedResultId: null }
  await instance.store.update('w', (state) => state.graph.nodes.push(node))
  const result = await instance.store.saveMedia(Readable.from([bytes]), { id: randomUUID(), kind, filename: kind === 'image' ? 'original.jpg' : 'original.mp4', nodeId: node.id, taskId: null, createdAt: 1 }, 10 * 1024 * 1024, kind)
  await instance.store.update('w', (state) => { state.assets.push(result); state.graph.nodes.find((n) => n.id === node.id)!.assetId = result.id })
  return result
}
function request(instance: CanvasService, id: string, variant = '&variant=preview&v=1', init?: RequestInit) {
  return instance.handle(new Request(`http://localhost/api/canvas/v2/media?canvas=w&id=${id}${variant}`, init))
}

describe('derived media previews', () => {
  it('compresses large EXIF-oriented images, deduplicates concurrent requests and leaves original/state/schema intact', async () => {
    const instance = await service()
    const input = await sharp({ create: { width: 1800, height: 900, channels: 3, background: '#dc3623' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer()
    const result = await asset(instance, input, 'image')
    const before = await instance.store.snapshot('w')
    const originalHash = await fileHash(instance.store.mediaPath(result.id))
    const responses = await Promise.all(Array.from({ length: 8 }, () => request(instance, result.id)))
    const buffers = await Promise.all(responses.map(async (response) => {
      expect(response.status).toBe(200); expect(response.headers.get('content-type')).toBe('image/webp')
      return Buffer.from(await response.arrayBuffer())
    }))
    for (const output of buffers) expect(output).toEqual(buffers[0])
    expect(await sharp(buffers[0]).metadata()).toMatchObject({ width: 480, height: 960, format: 'webp' })
    expect(buffers[0].length).toBeLessThan(input.length)
    const files = await readdir(join(instance.config.dataDir, 'previews'))
    expect(files).toHaveLength(1)
    expect((await stat(join(instance.config.dataDir, 'previews', files[0]))).mode & 0o777).toBe(0o600)
    expect(await fileHash(instance.store.mediaPath(result.id))).toBe(originalHash)
    expect(await instance.store.snapshot('w')).toEqual(before)
    expect((await request(instance, result.id, '&variant=waveform&v=1')).status).toBe(415)
    expect(await instance.store.db.get("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")).toMatchObject({ count: 21 })
    const original = await request(instance, result.id, '&download=1')
    expect(original.headers.get('content-disposition')).toContain('attachment')
    expect(Buffer.from(await original.arrayBuffer())).toEqual(input)
    const head = await request(instance, result.id, undefined, { method: 'HEAD' })
    expect(head.headers.get('content-length')).toBe(String(buffers[0].length)); expect(await head.text()).toBe('')
    const partial = await request(instance, result.id, undefined, { headers: { range: 'bytes=2-9' } })
    expect(partial.status).toBe(206); expect(Buffer.from(await partial.arrayBuffer())).toEqual(buffers[0].subarray(2, 10))
    const invalid = await request(instance, result.id, undefined, { headers: { range: 'bytes=999999-' } })
    expect(invalid.status).toBe(416)
  })
  it('uses the actual first video frame instead of a later frame and preserves full video transport', async () => {
    const instance = await service()
    const fixture = join(instance.config.dataDir, 'two-colors.mp4')
    execFileSync(ffmpeg.path, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=640x360:r=10:d=0.5', '-f', 'lavfi', '-i', 'color=c=blue:s=640x360:r=10:d=0.5', '-filter_complex_threads', '1', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', fixture])
    const input = await readFile(fixture)
    const result = await asset(instance, input, 'video')
    const response = await request(instance, result.id)
    expect(response.status).toBe(200)
    const output = Buffer.from(await response.arrayBuffer())
    expect(await sharp(output).metadata()).toMatchObject({ width: 640, height: 360, format: 'webp' })
    const pixel = await sharp(output).resize(1, 1).removeAlpha().raw().toBuffer()
    expect(pixel[0]).toBeGreaterThan(230); expect(pixel[2]).toBeLessThan(20)
    const original = await request(instance, result.id, '', { headers: { range: 'bytes=4-19' } })
    expect(original.status).toBe(206); expect(Buffer.from(await original.arrayBuffer())).toEqual(input.subarray(4, 20))
    expect(await readFile(instance.store.mediaPath(result.id))).toEqual(input)
  })
  it('isolates ownership and rejects source/cache symlinks before serving', async () => {
    const instance = await service()
    const result = await asset(instance, await sharp({ create: { width: 32, height: 16, channels: 3, background: 'green' } }).png().toBuffer(), 'image')
    await instance.store.ensureCanvas('other')
    const foreign = await instance.handle(new Request(`http://localhost/api/canvas/v2/media?canvas=other&id=${result.id}&variant=preview`))
    expect(foreign.status).toBe(404)
    expect(await readdir(instance.config.dataDir)).not.toContain('previews')
    const preview = await request(instance, result.id); await preview.arrayBuffer()
    const cached = join(instance.config.dataDir, 'previews', (await readdir(join(instance.config.dataDir, 'previews')))[0])
    await rm(cached); await symlink(instance.store.mediaPath(result.id), cached)
    expect((await request(instance, result.id)).status).toBe(409)
    const source = instance.store.mediaPath(result.id)
    const substitute = join(instance.config.dataDir, 'outside.png')
    await writeFile(substitute, await readFile(source)); await rm(source); await symlink(substitute, source)
    expect((await request(instance, result.id)).status).toBe(409)
  })
  it('keeps corrupt preview failures separate from original access and rejects retired versions', async () => {
    const instance = await service()
    const input = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom0000isommp42'), Buffer.alloc(80)])
    const result = await asset(instance, input, 'video')
    const failure = await request(instance, result.id)
    expect(failure.status).toBe(422); expect(await failure.json()).toMatchObject({ code: 'PREVIEW_UNAVAILABLE' })
    expect((await request(instance, result.id)).status).toBe(422)
    expect(Buffer.from(await (await request(instance, result.id, '')).arrayBuffer())).toEqual(input)
    expect((await request(instance, result.id, '&variant=preview&v=999')).status).toBe(400)
    await instance.previews.close()
    await expect(instance.previews.get('w', result.id, instance.store.mediaPath(result.id), 'hash', 'video')).rejects.toThrow()
  })
  it('stops an active native image conversion without emitting an unhandled stream error or publishing output', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'canvas-preview-stop-')))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const cache = new PreviewCache(root); cleanup.push(() => cache.close())
    const source = join(root, 'large.jpg')
    await writeFile(source, await sharp({ create: { width: 10000, height: 7000, channels: 3, background: 'orange' } }).jpeg().toBuffer())
    const job = cache.get('w', randomUUID(), source, 'hash', 'image').catch((error) => error.code)
    await new Promise((resolve) => setTimeout(resolve, 30))
    await cache.close()
    expect(await job).toBe('PREVIEW_UNAVAILABLE')
    expect(await readdir(join(root, 'previews'))).toHaveLength(0)
  })
})

it('fits portraits, wide images and quarter turns without changing their aspect', () => {
  expect(mediaFrame(1920, 1080)).toMatchObject({ width: 320, height: 180 })
  expect(mediaFrame(1080, 1920)).toMatchObject({ width: 270, height: 480 })
  expect(mediaFrame(1920, 1080, 90)).toEqual({ width: 270, height: 480, imageWidth: 480, imageHeight: 270 })
  expect(mediaFrame(0, NaN)).toMatchObject({ width: 320, height: 180 })
})
