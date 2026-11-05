import { afterEach, expect, it, vi } from 'vitest'
import { fishPageUrl, parseFishListing, parseFishVoice, readFishPage } from '../src/host/agent/fishVoices'
import { installVoiceTools, validateVoiceDraft } from '../src/host/agent/voiceTools'
import { MAIN_PROMPT, METHODS } from '../src/host/agent/methods'
import { FISH_VOICE_MANUAL_GUIDANCE, INTERNAL_CANVAS_PRESETS } from '../src/shared/agent'

afterEach(() => vi.unstubAllGlobals())
const id = 'a'.repeat(32), sourceUrl = `https://fish.audio/m/${id}/`
const page = `<meta property="og:title" content="中文旁白 - Fish Audio"><meta property="og:description" content="清晰自然">
<meta property="og:url" content="${sourceUrl}">`
it('reads only official public discovery/details and ignores audio clips and external links', () => {
  expect(fishPageUrl(sourceUrl).href).toBe(sourceUrl)
  for (const url of ['http://fish.audio/m/' + id, 'https://fish.audio.evil/m/' + id, 'https://fish.audio@evil/m/' + id,
    'https://fish.audio:3000/m/' + id, 'https://fish.audio/api/model', 'https://api.fish.audio/model', 'https://fish.audio/m/' + id + '#auth']) {
    expect(() => fishPageUrl(url)).toThrow()
  }
  const list = parseFishListing(`<a href="/m/${id}/"><b>中文旁白</b></a><a href="https://evil/m/${'b'.repeat(32)}">其他</a><a href="/audio/test.mp3">示例</a>`,
    'https://fish.audio/zh-CN/discovery/', '中文')
  expect(list.items).toEqual([{ id, title: '中文旁白', sourceUrl }])
  expect(parseFishListing('', 'https://fish.audio/zh-CN/discovery/').items).toEqual([])
  expect(parseFishVoice(page, sourceUrl)).toMatchObject({ id, sourceUrl, title: '中文旁白 - Fish Audio', description: '清晰自然' })
  expect(() => parseFishVoice('<title>Fish Audio</title>', sourceUrl)).toThrow('详情')
  expect(() => parseFishVoice(page.replace(id, 'b'.repeat(32)), sourceUrl)).toThrow('详情')
})
it('reports unavailable pages and enforces streamed response size without forwarding credentials', async () => {
  const fetch = vi.fn(async () => new Response('denied', { status: 403 })); vi.stubGlobal('fetch', fetch)
  await expect(readFishPage(sourceUrl, new AbortController().signal)).rejects.toMatchObject({
    code: 'FISH_PAGE_UNAVAILABLE', message: expect.stringContaining(FISH_VOICE_MANUAL_GUIDANCE),
  })
  expect(new Headers(fetch.mock.calls[0][1].headers).has('Authorization')).toBe(false)
  expect(fetch.mock.calls[0][1].redirect).toBe('error')
  fetch.mockResolvedValue(new Response('x'.repeat(2 * 1024 * 1024 + 1), { headers: { 'Content-Type': 'text/html' } }))
  await expect(readFishPage(sourceUrl, new AbortController().signal)).rejects.toMatchObject({ code: 'FISH_PAGE_UNAVAILABLE' })
})
it('limits website reads to the voice child, eight requests, and requires real batch receipts for saved candidates', async () => {
  const register = vi.fn(), coordinator = { binding: () => ({ taskId: 'batch' }) }, admission = vi.fn()
  const deps = { coordinator, admission, tool: register } as any
  for (const role of ['main', 'audio', 'executor', 'review']) installVoiceTools({ ...deps, role })
  expect(register).not.toHaveBeenCalled()
  installVoiceTools({ ...deps, role: 'voice' })
  expect(register.mock.calls.map((call) => call[0])).toEqual(['fish_voice_search', 'fish_voice_read'])
  const search = register.mock.calls[0][3], run = register.mock.calls[1][3], exec = { agent: {}, signal: new AbortController().signal }
  const fetch = vi.fn(async () => new Response(page, { headers: { 'Content-Type': 'text/html' } })); vi.stubGlobal('fetch', fetch)
  const empty = await search({ pageUrl: 'https://fish.audio/zh-CN/discovery/', query: '' }, exec)
  expect(empty).toMatchObject({ unavailable: true, verified: false, items: [], guidance: FISH_VOICE_MANUAL_GUIDANCE })
  expect(empty.guidance).toContain('请把音色 ID 发到这段对话里')
  const actual = await run({ sourceUrl }, exec)
  const draft = { kind: 'audio-plan' as const, content: JSON.stringify({ candidates: [{ ...actual.voice, suitability: '公开描述符合旁白需求' }], limitation: '尚未试听，兼容性待核验' }) }
  expect(validateVoiceDraft(coordinator, 'batch', draft).candidates[0].id).toBe(id)
  expect(() => validateVoiceDraft(coordinator, 'other-batch', draft)).toThrow('回执')
  expect(() => validateVoiceDraft(coordinator, 'batch', { ...draft, content: draft.content.replace(id, 'b'.repeat(32)) })).toThrow('回执')
  expect(() => validateVoiceDraft(coordinator, 'batch', { ...draft, content: draft.content.replace('中文旁白', '虚构名称') })).toThrow('回执')
  for (let index = 2; index < 8; index++) await run({ sourceUrl }, exec)
  await expect(run({ sourceUrl }, exec)).rejects.toMatchObject({ code: 'FISH_READ_LIMIT' })
  expect(fetch).toHaveBeenCalledTimes(8)
  expect(actual.listened).toBe(false)
})
it('skips discovery for fixed ID/audio and delegates real auditions through the executor and read-only chat card', () => {
  expect(INTERNAL_CANVAS_PRESETS).toContain('canvas-voice')
  expect(METHODS.voice).toContain('candidates=[]')
  expect(METHODS.voice).toContain(FISH_VOICE_MANUAL_GUIDANCE)
  expect(MAIN_PROMPT).toContain(FISH_VOICE_MANUAL_GUIDANCE)
  expect(MAIN_PROMPT).toContain('不能把安装电脑再次访问官网核验当作前置条件')
  for (const text of ['role="voice"', 'canvas_show_audio', 'allowTts=true', '不重复询问', 'reference_text', '刷新、重连或失败重新合成'])
    expect(MAIN_PROMPT).toContain(text)
})
