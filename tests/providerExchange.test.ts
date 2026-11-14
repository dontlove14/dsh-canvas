import { afterEach, describe, expect, it, vi } from 'vitest'
import { encode } from '@msgpack/msgpack'
import { fetchWithExchange } from '../src/host/providerExchange'
import { diagnosticHeaders, maskDiagnosticSecret, type ProviderExchange } from '../src/shared/taskDiagnostics'

afterEach(() => vi.unstubAllGlobals())
describe('provider HTTP exchange recording', () => {
  it('records the exact multipart boundary and binary bytes actually sent, with partial header masking', async () => {
    const entries: ProviderExchange[] = []
    const recordProviderExchange = vi.fn(async (_id: string, value: ProviderExchange) => { entries.push(structuredClone(value)) })
    const file = new Uint8Array([0, 255, 128, 1, 7])
    const form = new FormData(); form.set('prompt', '保留中文与换行\nexact')
    form.append('image[]', new Blob([file], { type: 'image/png' }), 'reference.png')
    const fetch = vi.fn(async (url: string | URL, init: RequestInit) => {
      const parsed = await new Request(url, init).formData()
      expect(parsed.get('prompt')).toBe('保留中文与换行\r\nexact')
      expect(Buffer.from(await (parsed.get('image[]') as File).arrayBuffer())).toEqual(Buffer.from(file))
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer abcdefghijklmnop')
      const recorded = entries.at(-1)!.request
      expect(Buffer.from(recorded.body!, 'base64')).toEqual(Buffer.from(init.body as Uint8Array))
      expect(recorded.headers['content-type']).toBe(new Headers(init.headers).get('content-type'))
      return new Response('invalid reference', { status: 400, headers: { 'Content-Type': 'text/plain', 'X-Request-ID': 'ticket' } })
    })
    vi.stubGlobal('fetch', fetch)
    const response = await fetchWithExchange({ recordProviderExchange }, { taskId: 'task-A', step: 'submit' },
      'https://provider.test/images/edits', { method: 'POST', headers: { Authorization: 'Bearer abcdefghijklmnop' }, body: form }, ['abcdefghijklmnop'], 4096)
    expect(await response.text()).toBe('invalid reference')
    expect(entries.at(-1)?.response?.body).toBe('invalid reference')
    expect(entries.at(-1)?.response?.headers['x-request-id']).toBe('ticket')
    expect(JSON.stringify(entries)).not.toContain('abcdefghijklmnop')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('keeps concurrent task records separate and preserves msgpack and streamed binary responses', async () => {
    const records = new Map<string, ProviderExchange>()
    const recordProviderExchange = async (id: string, value: ProviderExchange) => { records.set(id, structuredClone(value)) }
    const encoded = new Uint8Array(encode({ text: 'clone', references: [{ audio: new Uint8Array([0, 255]), text: '原文' }] }))
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(url.endsWith('A') ? new Uint8Array([1, 255, 0]) : '{"error":"task B failed"}',
      { status: url.endsWith('A') ? 200 : 400, headers: { 'Content-Type': url.endsWith('A') ? 'audio/mpeg' : 'application/json' } })))
    const [a, b] = await Promise.all([
      fetchWithExchange({ recordProviderExchange }, { taskId: 'A', step: 'submit' }, 'https://provider.test/A',
        { method: 'POST', headers: { 'Content-Type': 'application/msgpack' }, body: encoded }, [], 4096),
      fetchWithExchange({ recordProviderExchange }, { taskId: 'B', step: 'poll' }, 'https://provider.test/B', {}, [], 4096),
    ])
    expect(new Uint8Array(await a.arrayBuffer())).toEqual(new Uint8Array([1, 255, 0]))
    expect(await b.text()).toBe('{"error":"task B failed"}')
    expect(Buffer.from(records.get('A')!.request.body!, 'base64')).toEqual(Buffer.from(encoded))
    expect(records.get('A')!.response!.body).toBe('Af8A')
    expect(records.get('B')!.request.body).toBeNull()
    expect(records.get('B')!.response!.body).toContain('task B failed')
  })
  it('retains transport errors and does not turn a diagnostic write failure into another submission', async () => {
    let latest!: ProviderExchange
    const transport = new Error('connection reset')
    const fetch = vi.fn(async () => { throw transport }); vi.stubGlobal('fetch', fetch)
    await expect(fetchWithExchange({ recordProviderExchange: async (_id, value) => { latest = structuredClone(value) } },
      { taskId: 'A', step: 'submit' }, 'https://provider.test/A', {}, [], 4096)).rejects.toBe(transport)
    expect(latest.error).toBe('connection reset'); expect(latest.response).toBeUndefined()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok')))
    const response = await fetchWithExchange({ recordProviderExchange: async () => { throw new Error('disk full') } },
      { taskId: 'B', step: 'submit' }, 'https://provider.test/B', {}, [], 4096)
    expect(await response.text()).toBe('ok')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('masks authentication header names case-insensitively without exposing short credentials', () => {
    const headers = diagnosticHeaders(new Headers({ 'X-API-Key': 'abcdefghijk', Cookie: 'session=private', Authorization: 'Bearer xy' }), [])
    expect(headers['x-api-key']).toBe(maskDiagnosticSecret('abcdefghijk'))
    expect(headers.cookie).not.toContain('private')
    expect(headers.authorization).toBe('Bearer [已脱敏]')
  })
})
