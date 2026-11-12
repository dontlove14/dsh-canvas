import { afterEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { AgentSpaceResources } from '../src/client/agentSpaceResources'
import type { AgentSpaceManifest } from '../src/shared/agentSpace'

const api = { url: (path: string, params: Record<string, string> = {}) => `/api/${path}?${new URLSearchParams(params)}` }
const file = (name: string, body: string, mime = 'image/png') =>
  ({ file: name, bytes: Buffer.byteLength(body), sha256: createHash('sha256').update(body).digest('hex'), mime })
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })
it('waits for complete bytes, verified identity and decoded first frames before 100%; shares concurrent calls', async () => {
  const files = [file('one.png', 'one'), file('two.webm', 'two', 'video/webm')]
  const catalog = { version: 'test', files } as AgentSpaceManifest
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('file=') ? new Response(url.includes('one.png') ? 'one' : 'two') : Response.json(catalog)))
  const release: (() => void)[] = []
  const decode = vi.fn(() => new Promise<void>((resolve) => { release.push(resolve) }))
  const store = new AgentSpaceResources(api as any, decode)
  const first = store.load(), second = store.load()
  expect(first).toBe(second)
  await vi.waitFor(() => expect(decode).toHaveBeenCalledTimes(2))
  expect(store.getSnapshot().percent).toBeLessThan(100)
  release[0]()
  await Promise.resolve()
  expect(store.getSnapshot().percent).toBeLessThan(100)
  release[1](); await first
  expect(store.getSnapshot()).toEqual({ status: 'ready', percent: 100 })
  store.dispose()
})
it('times out stalled image decoding and permits a later retry without downloading the verified bytes again', async () => {
  vi.useFakeTimers()
  const files = [file('one.png', 'one')]
  const decode = vi.fn(() => new Promise<void>(() => {}))
  vi.stubGlobal('Image', class { src = ''; decode = decode; removeAttribute() {} })
  const fetcher = vi.fn(async (url: string) => url.includes('file=') ? new Response('one') : Response.json({ version: 'test', files }))
  vi.stubGlobal('fetch', fetcher)
  const store = new AgentSpaceResources(api as any)
  const failure = expect(store.load()).rejects.toThrow('资源尚未准备完整')
  await vi.waitFor(() => expect(decode).toHaveBeenCalledTimes(1))
  await vi.advanceTimersByTimeAsync(60_000); await failure
  expect(store.getSnapshot().status).toBe('error')
  decode.mockImplementation(() => Promise.resolve())
  await store.load()
  expect(store.getSnapshot().percent).toBe(100)
  expect(fetcher.mock.calls.filter(([url]) => url.includes('file='))).toHaveLength(1)
  store.dispose()
})
it('aborts a stalled first-frame decode on disposal without publishing an error after unmount', async () => {
  const decode = vi.fn(() => new Promise<void>(() => {}))
  vi.stubGlobal('Image', class { src = ''; decode = decode; removeAttribute() {} })
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('file=') ? new Response('one')
    : Response.json({ version: 'test', files: [file('one.png', 'one')] })))
  const store = new AgentSpaceResources(api as any)
  const failure = expect(store.load()).rejects.toThrow()
  await vi.waitFor(() => expect(decode).toHaveBeenCalledTimes(1))
  store.dispose(); await failure
  expect(store.getSnapshot()).toEqual({ status: 'idle', percent: 0 })
})
it('retains successful blobs and retries only missing or undecodable assets after a partial failure', async () => {
  const files = [file('one.png', 'one'), file('two.png', 'two')]
  let fail = true
  const fetcher = vi.fn(async (url: string) => !url.includes('file=') ? Response.json({ version: 'test', files }) :
    new Response(url.includes('one.png') ? 'one' : fail ? 'bad' : 'two'))
  vi.stubGlobal('fetch', fetcher)
  const store = new AgentSpaceResources(api as any, async () => {})
  await expect(store.load()).rejects.toThrow()
  expect(store.getSnapshot().status).toBe('error')
  expect(store.getSnapshot().percent).toBeLessThan(100)
  fail = false; await store.load()
  expect(store.getSnapshot()).toEqual({ status: 'ready', percent: 100 })
  expect(fetcher.mock.calls.filter(([url]) => url.includes('one.png'))).toHaveLength(1)
  expect(fetcher.mock.calls.filter(([url]) => url.includes('two.png'))).toHaveLength(2)
  const count = fetcher.mock.calls.length
  await store.load(); expect(fetcher).toHaveBeenCalledTimes(count)
  store.dispose()
})
