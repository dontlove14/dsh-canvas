// @vitest-environment jsdom
import { act, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SecretInput, SecretValue } from '../src/client/SecretField'
import { ModelSettings } from '../src/client/Settings'
import { TtsSettings } from '../src/client/TtsSettings'
import { ObjectStorageSettings } from '../src/client/ObjectStorageSettings'
import { CanvasApi } from '../src/client/api'
import { BUILTIN_MODELS } from '../src/shared/modelCatalog'
import { capabilitiesFor, FISH_TTS_ENDPOINT } from '../src/shared/contracts'

const roots: Root[] = []
beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true))
afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()))
  document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
async function mount(element: ReactNode) {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host); roots.push(root)
  await act(async () => root.render(element))
  return { host, root }
}
const button = (host: ParentNode, label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
function input(host: ParentNode, label: string, value: string) {
  const field = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value)
  act(() => field.dispatchEvent(new Event('input', { bubbles: true })))
}

it('keeps saved card keys and EP masked, reveals fields independently and makes no write', async () => {
  const api = new CanvasApi(), model = BUILTIN_MODELS[13], label = `${model.name} · ByteDance`
  vi.spyOn(api, 'models').mockResolvedValue([{ ...model, endpoint_id: 'ep-private-original',
    has_api_key: true, api_key_mask: '370********117', capabilities: capabilitiesFor(model) }])
  const read = vi.spyOn(api, 'settingSecret').mockResolvedValue('370-private-original-117')
  const save = vi.spyOn(api, 'saveModel')
  const { host } = await mount(<ModelSettings api={api} />)
  expect(host.textContent).toContain('370********117'); expect(host.textContent).toContain('ep-********nal')
  expect(host.querySelector('.dc-settings-footnote')).toBeNull()
  expect(host.textContent).not.toContain('private-original'); expect(read).not.toHaveBeenCalled()
  await act(async () => button(host, `显示 ${label} API Key`).click())
  expect(read).toHaveBeenCalledExactlyOnceWith({ scope: 'model', id: model.id, field: 'api_key' }, expect.any(AbortSignal))
  expect(host.textContent).toContain('370-private-original-117'); expect(host.textContent).not.toContain('ep-private-original')
  await act(async () => button(host, `显示 ${label} EP`).click())
  expect(host.textContent).toContain('ep-private-original')
  await act(async () => button(host, `隐藏 ${label} API Key`).click())
  expect(host.textContent).not.toContain('370-private-original-117')
  expect(save).not.toHaveBeenCalled()
})

it('previews a saved key without copying it into the save draft, remasks EP and clears previews on reopen', async () => {
  const api = new CanvasApi(), model = BUILTIN_MODELS[13]
  const list = [{ ...model, endpoint_id: 'ep-original-value', has_api_key: true, api_key_mask: 'mod********key', capabilities: capabilitiesFor(model) }]
  vi.spyOn(api, 'models').mockResolvedValue(list)
  vi.spyOn(api, 'settingSecret').mockResolvedValue('model-original-key')
  const save = vi.spyOn(api, 'saveModel').mockResolvedValue(list)
  const { host } = await mount(<ModelSettings api={api} />)
  act(() => button(host, `编辑 ${model.name} · ByteDance`).click())
  const ep = host.querySelector<HTMLInputElement>('input[aria-label="模型供应商 EP"]')!
  expect(ep.type).toBe('password')
  await act(async () => button(host, '显示 模型供应商 EP').click())
  expect(ep.type).toBe('text'); expect(ep.value).toBe('ep-original-value')
  await act(async () => button(host, '隐藏 模型供应商 EP').click())
  await act(async () => button(host, '显示 模型供应商 API Key').click())
  expect(host.querySelector<HTMLInputElement>('input[aria-label="模型供应商 API Key"]')!.value).toBe('model-original-key')
  input(host, '模型供应商 EP', 'ep-updated-value')
  await act(async () => [...host.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === '保存配置')!.click())
  expect(save).toHaveBeenCalledExactlyOnceWith({ ...model, endpoint_id: 'ep-updated-value', api_key: undefined })
  act(() => button(host, `编辑 ${model.name} · ByteDance`).click())
  expect(host.querySelector<HTMLInputElement>('input[aria-label="模型供应商 API Key"]')!.value).toBe('')
  expect(host.querySelector<HTMLInputElement>('input[aria-label="模型供应商 EP"]')!.type).toBe('password')
})

it('ignores a cancelled or unmounted late credential response', async () => {
  let finish!: (value: string) => void
  const load = vi.fn(() => new Promise<string>((resolve) => { finish = resolve }))
  const { host, root } = await mount(<SecretValue label="Key" mask="abc********xyz" load={load} />)
  act(() => button(host, '显示 Key').click())
  expect(button(host, '取消显示 Key').getAttribute('aria-busy')).toBe('true')
  act(() => button(host, '取消显示 Key').click())
  expect(load.mock.calls[0][0].aborted).toBe(true)
  await act(async () => finish('late-secret'))
  expect(host.textContent).not.toContain('late-secret')
  act(() => button(host, '显示 Key').click())
  act(() => root.unmount()); roots.splice(roots.indexOf(root), 1)
  expect(load.mock.calls[1][0].aborted).toBe(true)
  await act(async () => finish('unmounted-secret'))
  expect(document.body.textContent).not.toContain('unmounted-secret')
})

it('keeps typed replacements when an old reveal response arrives and handles failures with a retry', async () => {
  let finish!: (value: string) => void
  const load = vi.fn((_signal: AbortSignal) => new Promise<string>((resolve) => { finish = resolve }))
  function Field() {
    const [value, setValue] = useState('')
    return <SecretInput label="Key" value={value} savedMask="abc********xyz" load={load} onChange={(event) => setValue(event.target.value)} />
  }
  const { host } = await mount(<Field />)
  act(() => button(host, '显示 Key').click())
  input(host, 'Key', 'replacement-secret')
  await act(async () => finish('old-secret'))
  const field = host.querySelector('input')!
  expect(field.value).toBe('replacement-secret'); expect(field.type).toBe('password')
  await act(async () => button(host, '显示 Key').click())
  expect(field.type).toBe('text'); expect(field.value).toBe('replacement-secret')
  const errorLoad = vi.fn().mockRejectedValueOnce(new Error('server-private-key')).mockResolvedValue('retry-secret')
  const next = await mount(<SecretValue label="Retry" mask="********" load={errorLoad} />)
  await act(async () => button(next.host, '显示 Retry').click())
  expect(next.host.querySelector('[role="alert"]')!.textContent).toBe('读取失败，请重试')
  expect(next.host.textContent).not.toContain('server-private-key')
  await act(async () => button(next.host, '显示 Retry').click())
  expect(next.host.textContent).toContain('retry-secret')
})

it('removes revealed saved values when the page hides or the field is disabled', async () => {
  const load = vi.fn().mockResolvedValue('private-preview')
  const { host, root } = await mount(<SecretValue label="Key" load={load} mask="********" />)
  await act(async () => button(host, '显示 Key').click())
  act(() => window.dispatchEvent(new Event('pagehide')))
  expect(host.textContent).not.toContain('private-preview')
  await act(async () => button(host, '显示 Key').click())
  await act(async () => root.render(<SecretValue label="Key" load={load} mask="********" disabled />))
  expect(host.textContent).not.toContain('private-preview'); expect(button(host, '显示 Key').disabled).toBe(true)
})

it('uses the same explicit reveal for TTS and both saved OSS credential fields', async () => {
  const api = new CanvasApi(), providerId = BUILTIN_MODELS[0].id
  vi.spyOn(api, 'ttsSettings').mockResolvedValue({ endpoint: FISH_TTS_ENDPOINT, revision: 1, configured: true, has_api_key: true, api_key_mask: 'fis********key' })
  vi.spyOn(api, 'storage').mockResolvedValue({ configured: true, activeProviderId: providerId, revision: 1, moving: 0, failed: 0,
    providers: [{ id: providerId, type: 'aliyun-oss', name: 'OSS', region: 'oss-cn-hangzhou', bucket: 'test-bucket',
      endpoint: 'https://oss-cn-hangzhou.aliyuncs.com', prefix: 'canvas', active: true, hasCredentials: true,
      accessKeyIdMask: '370********117', accessKeySecretMask: 'oss********key', verifiedAt: 1, revision: 1 }] })
  const read = vi.spyOn(api, 'settingSecret').mockResolvedValue('revealed-credential')
  const tts = await mount(<TtsSettings api={api} />)
  const oss = await mount(<ObjectStorageSettings api={api} />)
  expect(read).not.toHaveBeenCalled()
  act(() => [...oss.host.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === '配置')!.click())
  await act(async () => button(tts.host, '显示 FishTTS API Key').click())
  await act(async () => button(oss.host, '显示 AccessKey ID').click())
  await act(async () => button(oss.host, '显示 AccessKey Secret').click())
  expect(read.mock.calls.map(([request]) => request)).toEqual([
    { scope: 'tts', field: 'api_key' },
    { scope: 'storage', id: providerId, field: 'accessKeyId' },
    { scope: 'storage', id: providerId, field: 'accessKeySecret' },
  ])
})

it('sends an abortable no-store POST for one setting field without putting the identity in a URL query', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ value: 'only-field' }), { headers: { 'Content-Type': 'application/json' } }))
  vi.stubGlobal('fetch', fetch)
  const api = new CanvasApi(), controller = new AbortController(), request = { scope: 'model' as const, id: BUILTIN_MODELS[0].id, field: 'api_key' as const }
  expect(await api.settingSecret(request, controller.signal)).toBe('only-field')
  expect(fetch).toHaveBeenCalledWith('/api/canvas/v2/settings-secret', expect.objectContaining({
    credentials: 'same-origin', method: 'POST', cache: 'no-store', signal: controller.signal, body: JSON.stringify(request),
  }))
})
