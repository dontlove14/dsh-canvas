import { describe, expect, it, vi } from 'vitest'
import { MediaUrlCache } from '../src/client/mediaUrlCache'
import type { MediaVariant } from '../src/shared/objectStorage'

describe('shared client media links', () => {
  it('coalesces duplicate resources, batches at 100 and retains links across graph polls', async () => {
    let now = 1000000
    const mediaUrls = vi.fn(async (_canvas: string, items: Array<{ assetId: string; variant: MediaVariant }>) => ({
      items: items.map((item) => ({ ...item, url: `https://oss.invalid/${item.assetId}?at=${now}`, expiresAt: now + 3600000 })),
    }))
    const cache = new MediaUrlCache({ mediaUrls }, () => now)
    const results = await Promise.all(Array.from({ length: 120 }, (_, i) => cache.resolve('canvas', String(i), 'original')))
    expect(mediaUrls).toHaveBeenCalledTimes(2)
    expect(mediaUrls.mock.calls.map(([, items]) => items.length)).toEqual([100, 20])
    expect(await cache.resolve('canvas', '0', 'original')).toEqual(results[0]); expect(mediaUrls).toHaveBeenCalledTimes(2)
    now += 56 * 60000
    const [a, b] = await Promise.all([cache.resolve('canvas', '0', 'original'), cache.resolve('canvas', '0', 'original')])
    expect(a).toEqual(b); expect(a.url).not.toBe(results[0].url); expect(mediaUrls).toHaveBeenCalledTimes(3)
  })
  it('isolates canvas and variant identity and forwards forced refresh without leaking it into normal batches', async () => {
    const mediaUrls = vi.fn(async (canvas: string, items: Array<{ assetId: string; variant: MediaVariant }>, force?: boolean) => ({
      items: items.map((item) => ({ ...item, url: `${canvas}/${item.variant}/${force}`, expiresAt: Date.now() + 3600000 })),
    }))
    const cache = new MediaUrlCache({ mediaUrls })
    await Promise.all([cache.resolve('a', 'id', 'original'), cache.resolve('a', 'id', 'preview', true), cache.resolve('b', 'id', 'original')])
    expect(mediaUrls).toHaveBeenCalledTimes(3)
    expect(mediaUrls.mock.calls.map((call) => call[2])).toEqual([false, true, false])
  })
  it('rejects per-resource errors and allows one explicitly requested retry', async () => {
    const mediaUrls = vi.fn().mockResolvedValueOnce({ items: [{ assetId: 'id', variant: 'original', error: 'Forbidden' }] })
      .mockResolvedValueOnce({ items: [{ assetId: 'id', variant: 'original', url: 'https://oss.invalid/new', expiresAt: Date.now() + 3600000 }] })
    const cache = new MediaUrlCache({ mediaUrls })
    await expect(cache.resolve('a', 'id', 'original')).rejects.toThrow('Forbidden')
    expect((await cache.resolve('a', 'id', 'original', true)).url).toContain('/new')
    expect(mediaUrls).toHaveBeenCalledTimes(2)
  })
  it('re-signs an in-flight response if configuration changed before it returned', async () => {
    let finish!: (value: unknown) => void
    const mediaUrls = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
      .mockResolvedValueOnce({ items: [{ assetId: 'id', variant: 'original', url: 'https://oss.invalid/fresh', expiresAt: Date.now() + 3600000 }] })
    const cache = new MediaUrlCache({ mediaUrls })
    const request = cache.resolve('a', 'id', 'original')
    await Promise.resolve()
    cache.invalidate()
    finish({ items: [{ assetId: 'id', variant: 'original', url: 'https://oss.invalid/stale', expiresAt: Date.now() + 3600000 }] })
    expect((await request).url).toContain('/fresh')
    expect(mediaUrls).toHaveBeenCalledTimes(2); expect(mediaUrls.mock.calls[1][2]).toBe(true)
  })
})
