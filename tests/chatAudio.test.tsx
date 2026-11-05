// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ChatAudioCard, canvasAudioDefinition } from '../src/client/chatAudio'
import { CanvasApi } from '../src/client/api'
import type { Asset } from '../src/shared/contracts'

const roots: Root[] = []
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const paused = new WeakMap<HTMLMediaElement, boolean>()
  vi.spyOn(HTMLMediaElement.prototype, 'paused', 'get').mockImplementation(function () { return paused.get(this) ?? true })
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function () { paused.set(this, false); this.dispatchEvent(new Event('play')); return Promise.resolve() })
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function () { paused.set(this, true); this.dispatchEvent(new Event('pause')) })
})
afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()))
  document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers()
})
const canvasId = crypto.randomUUID(), taskId = crypto.randomUUID()
const asset: Asset = { id: crypto.randomUUID(), kind: 'audio', mime: 'audio/wav', filename: '试听.wav', bytes: 100,
  createdAt: 1, taskId, nodeId: crypto.randomUUID(), duration: 10 }
function fixture() {
  const api = new CanvasApi()
  vi.spyOn(api, 'waveform').mockResolvedValue({ version: 1, duration: 10, peaks: Array(96).fill(.5) })
  vi.spyOn(api, 'mediaUrls').mockImplementation(async (_canvas, items) => ({ items: items.map((item) =>
    ({ ...item, url: `https://example.test/${item.assetId}.wav`, expiresAt: Date.now() + 3600000 })) }))
  const audio = vi.spyOn(api, 'audioResult').mockResolvedValue({ status: 'completed', assets: [asset], text: '这是试听短句。', voiceId: 'chosen-voice' })
  const generate = vi.spyOn(api, 'ttsGenerate'), state = vi.spyOn(api, 'state')
  const node = { data: { canvasId, taskId, title: '中文旁白' } } as any
  return { api, audio, generate, state, node }
}
async function mount(view: React.ReactNode) {
  const container = document.body.appendChild(document.createElement('div')), root = createRoot(container); roots.push(root)
  await act(async () => { root.render(view); await Promise.resolve() })
  return { root, container }
}
it('plays, pauses, seeks and switches between cards, and never autoplays on restore', async () => {
  const f = fixture()
  const { root, container } = await mount(<><ChatAudioCard node={f.node} api={f.api} /><ChatAudioCard node={f.node} api={f.api} /></>)
  const audios = [...container.querySelectorAll('audio')]
  expect(audios).toHaveLength(2)
  for (const audio of audios) {
    Object.defineProperty(audio, 'duration', { value: 10 })
    act(() => audio.dispatchEvent(new Event('loadedmetadata')))
    expect(audio.hasAttribute('autoplay')).toBe(false)
  }
  expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled()
  expect(container.textContent).toContain('这是试听短句。')
  let buttons = [...container.querySelectorAll<HTMLButtonElement>('[aria-label="播放音频"]')]
  await act(async () => buttons[0].click())
  expect(audios[0].paused).toBe(false)
  expect(container.querySelector('[aria-label="暂停音频"]')).toBeTruthy()
  act(() => container.querySelector<HTMLButtonElement>('[aria-label="暂停音频"]')!.click())
  expect(audios[0].paused).toBe(true)
  buttons = [...container.querySelectorAll<HTMLButtonElement>('[aria-label="播放音频"]')]
  await act(async () => buttons[0].click())
  await act(async () => buttons[1].click())
  expect(audios[0].paused).toBe(true); expect(audios[1].paused).toBe(false)
  const slider = container.querySelectorAll('[role="slider"]')[1]
  act(() => slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
  expect(audios[1].currentTime).toBe(5)
  Object.defineProperty(document, 'hidden', { value: true, configurable: true })
  act(() => document.dispatchEvent(new Event('visibilitychange')))
  expect(audios[1].paused).toBe(true)
  const plays = vi.mocked(HTMLMediaElement.prototype.play).mock.calls.length
  act(() => root.unmount()); roots.pop()
  Object.defineProperty(document, 'hidden', { value: false, configurable: true })
  await mount(<ChatAudioCard node={f.node} api={f.api} />)
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(plays)
  expect(f.generate).not.toHaveBeenCalled(); expect(f.state).not.toHaveBeenCalled()
})
it('only watches the original pending task and stops on failure without submitting a replacement', async () => {
  vi.useFakeTimers()
  const f = fixture()
  f.audio.mockResolvedValueOnce({ status: 'generating', assets: [] }).mockResolvedValue({ status: 'failed', assets: [], error: '音色未被服务接受' })
  const { container } = await mount(<ChatAudioCard node={f.node} api={f.api} />)
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
  expect(container.querySelector('audio')).toBeNull()
  expect(container.textContent).toContain('音色未被服务接受')
  await act(async () => { await vi.advanceTimersByTimeAsync(10000) })
  expect(f.audio).toHaveBeenCalledTimes(2)
  expect(f.audio.mock.calls.every(([handle]) => handle.taskId === taskId)).toBe(true)
  expect(f.generate).not.toHaveBeenCalled()
})
it('publishes a card only from a successful exact tool receipt and rejects malformed or external audio handles', () => {
  expect(canvasAudioDefinition.match({ type: 'tool/call', data: { name: 'canvas_show_audio', callId: 'show' } } as any)).toEqual({ id: 'show', role: 'start' })
  const ctx = { state: undefined } as any
  const result = (value: any, isError = false) => ({ event: { type: 'tool/result', data: { message: { isError, content: [{ type: 'text', text: JSON.stringify(value) }] } } } }) as any
  expect(canvasAudioDefinition.update(ctx, result({ audio: { canvasId, taskId, title: '试听' } }))).toEqual({ canvasId, taskId, title: '试听' })
  expect(canvasAudioDefinition.update(ctx, result({ audio: { canvasId, title: '试听', url: 'https://fish.audio/sample.mp3' } }))).toBeUndefined()
  expect(canvasAudioDefinition.update(ctx, result({ audio: { canvasId, taskId, title: '试听' } }, true))).toBeUndefined()
})
