// @vitest-environment jsdom
import { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CanvasApi } from '../src/client/api'
import { CanvasSettings } from '../src/client/Settings'
import { ObjectStorageSettings } from '../src/client/ObjectStorageSettings'
import { ProjectList } from '../src/client/ProjectList'
import { useRefreshingSource } from '../src/client/SignedMedia'
import type { ObjectStorageSettings as Settings } from '../src/shared/objectStorage'
import { STORAGE_REQUIRED } from '../src/shared/objectStorage'

const roots: Root[] = []
afterEach(() => { act(() => roots.splice(0).forEach((root) => root.unmount())); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const empty: Settings = { configured: false, activeProviderId: null, revision: 0, providers: [], moving: 0, failed: 0 }
function mount(element: React.ReactNode) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  HTMLDialogElement.prototype.showModal = function () { this.open = true }
  HTMLDialogElement.prototype.close = function () { this.open = false }
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container); roots.push(root); act(() => root.render(element)); return container
}
function button(host: ParentNode, text: string) {
  return [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === text)!
}
function input(host: ParentNode, label: string, value: string) {
  const field = [...host.querySelectorAll('label')].find((l) => l.textContent?.startsWith(label))!.querySelector('input')!
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value)
  act(() => field.dispatchEvent(new Event('input', { bubbles: true })))
}
describe('unified object storage settings', () => {
  it('guards both create entries before prompting and opens the object storage tab', async () => {
    const api = new CanvasApi()
    vi.spyOn(api, 'catalog').mockResolvedValue({ folders: [], canvases: [] })
    vi.spyOn(api, 'storage').mockResolvedValue(empty)
    const prompt = vi.spyOn(window, 'prompt'), command = vi.spyOn(api, 'catalogCommand')
    const host = mount(<ProjectList api={api} folder="all" onFolder={() => {}} onOpen={() => {}} />)
    await act(async () => { await Promise.resolve() })
    const create = [...host.querySelectorAll<HTMLButtonElement>('button')].filter((b) => b.textContent === '＋ 新建画布')
    expect(create).toHaveLength(2)
    act(() => create.forEach((b) => b.click()))
    expect(prompt).not.toHaveBeenCalled(); expect(command).not.toHaveBeenCalled(); expect(host.textContent).toContain(STORAGE_REQUIRED)
    act(() => button(host, '前往设置').click())
    await act(async () => { await Promise.resolve() })
    expect(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('对象存储')
    const modal = document.querySelector('.dc-settings-modal')!
    expect(modal.querySelectorAll('h2')).toHaveLength(1)
    expect(modal.querySelector('.dc-canvas-settings>h2')).toBeNull()
    const panel = modal.querySelector('.dc-settings-panel')!
    expect(panel.contains(modal.querySelector('[role="tablist"]'))).toBe(false)
  })
  it('keeps failed settings reads distinct from an empty configuration', async () => {
    const api = new CanvasApi()
    vi.spyOn(api, 'catalog').mockResolvedValue({ folders: [], canvases: [] })
    vi.spyOn(api, 'storage').mockRejectedValue(new Error('read failed'))
    const host = mount(<ProjectList api={api} folder="all" onFolder={() => {}} onOpen={() => {}} />)
    await act(async () => { await Promise.resolve() })
    act(() => button(host, '＋ 新建画布').click())
    expect(host.textContent).toContain('对象存储设置读取失败'); expect(host.textContent).not.toContain(STORAGE_REQUIRED)
  })
  it('tests/saves normalized OSS fields and clears credentials after save', async () => {
    const api = new CanvasApi()
    vi.spyOn(api, 'storage').mockResolvedValue(empty)
    const test = vi.spyOn(api, 'testStorage').mockResolvedValue({ ok: true })
    const save = vi.spyOn(api, 'setStorage').mockResolvedValue({ ...empty, configured: true, revision: 1 })
    const changed = vi.fn()
    const host = mount(<ObjectStorageSettings api={api} onChanged={changed} />)
    await act(async () => { await Promise.resolve() })
    input(host, 'Bucket', 'test-bucket'); input(host, 'AccessKey ID', 'sample-ak'); input(host, 'AccessKey Secret', 'sample-sk')
    await act(async () => { button(host, '测试连接').click(); await Promise.resolve() })
    expect(test).toHaveBeenCalledWith(expect.objectContaining({ type: 'aliyun-oss', bucket: 'test-bucket', endpoint: 'https://oss-cn-hangzhou.aliyuncs.com', accessKeyId: 'sample-ak', accessKeySecret: 'sample-sk', revision: 0 }))
    await act(async () => { button(host, '保存并启用').click(); await Promise.resolve() })
    expect(save).toHaveBeenCalledTimes(1); expect(changed).toHaveBeenCalledTimes(1)
    expect([...host.querySelectorAll<HTMLInputElement>('input[type="password"]')].map((i) => i.value)).toEqual(['', ''])
  })
  it('uses four tabs and offers only the implemented object storage vendor', async () => {
    const api = new CanvasApi(); vi.spyOn(api, 'storage').mockResolvedValue(empty)
    const host = mount(<CanvasSettings api={api} />)
    await act(async () => { await Promise.resolve() })
    expect([...host.querySelectorAll('[role="tab"]')].map((t) => t.textContent)).toEqual(['对象存储', '模型设置', 'TTS 设置', 'Seedance 预审'])
    expect([...host.querySelectorAll('select option')].map((o) => o.textContent)).toEqual(['阿里云 OSS'])
    expect(host.textContent).not.toContain('宿主媒体根目录')
    expect(host.querySelector('.dc-canvas-settings>h2')?.textContent).toBe('无限画布')
  })
  it('captures playback before changing a signed source and restores time/playing on metadata', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
    function Media({ url }: { url: string }) { const ref = useRef<HTMLVideoElement>(null); useRefreshingSource(ref, url); return <video ref={ref} /> }
    const host = mount(<Media url="https://oss.invalid/first" />), element = host.querySelector('video')!
    element.currentTime = 42; Object.defineProperty(element, 'paused', { configurable: true, value: false })
    act(() => roots.at(-1)!.render(<Media url="https://oss.invalid/fresh" />))
    element.currentTime = 0; act(() => element.dispatchEvent(new Event('loadedmetadata')))
    expect(element.currentTime).toBe(42); expect(play).toHaveBeenCalledTimes(1)
    expect(element.getAttribute('src')).toBe('https://oss.invalid/fresh')
  })
})
