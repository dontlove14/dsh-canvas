// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { harnessPrimitives } from './support/harnessPrimitives'
import { CanvasApi } from '../src/client/api'
import { ProjectList } from '../src/client/ProjectList'
import { HarnessUiProvider } from '../src/client/ui'

const roots: Root[] = []
beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true))
afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()))
  document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === text)!
function input(value: string) {
  const field = document.querySelector<HTMLInputElement>('.dc-name-dialog input')!
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value)
  act(() => field.dispatchEvent(new Event('input', { bubbles: true })))
}
async function mount(folder = 'all') {
  const api = new CanvasApi()
  const canvas = { id: crypto.randomUUID(), name: '原画布', revision: 7, folderId: null, createdAt: 1, updatedAt: 1 }
  const directory = { id: crypto.randomUUID(), name: '原文件夹', revision: 3, createdAt: 1, updatedAt: 1 }
  vi.spyOn(api, 'catalog').mockResolvedValue({ canvases: [canvas], folders: [directory] })
  vi.spyOn(api, 'storage').mockResolvedValue({ configured: true, revision: 1, activeProviderId: 'oss', providers: [], moving: 0, failed: 0 })
  const command = vi.spyOn(api, 'catalogCommand').mockResolvedValue({} as any)
  const prompt = vi.spyOn(window, 'prompt')
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host); roots.push(root)
  await act(async () => root.render(<HarnessUiProvider components={harnessPrimitives}>
    <ProjectList api={api} folder={folder === 'selected' ? directory.id : folder} onFolder={() => {}} onOpen={() => {}} />
  </HarnessUiProvider>))
  return { api, canvas, directory, command, prompt }
}
async function submit() {
  await act(async () => document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
}
it('creates in the selected folder using native Modal/Input and Enter, without browser prompt', async () => {
  const f = await mount('selected')
  await act(async () => button('＋ 新建画布').click())
  expect(document.querySelector('[role="dialog"][aria-modal="true"]')).toBeTruthy()
  expect(document.querySelector('.dc-name-dialog [data-dc-ui="native"] input')).toBe(document.activeElement)
  input('  Cafe\u0301  ')
  await submit()
  expect(f.command).toHaveBeenCalledExactlyOnceWith({ operation: 'canvas-create', name: 'Café', folderId: f.directory.id })
  expect(document.querySelector('.dc-name-dialog')).toBeNull(); expect(f.prompt).not.toHaveBeenCalled()
})
it.each(['canvas', 'folder'] as const)('prefills %s rename and retains its exact id and revision', async (kind) => {
  const f = await mount(kind === 'folder' ? 'selected' : 'all')
  const item = kind === 'canvas' ? f.canvas : f.directory
  await act(async () => document.querySelector<HTMLButtonElement>(`[aria-label="管理${kind === 'canvas' ? '画布' : '文件夹'}“${item.name}”"]`)!.click())
  await act(async () => button(kind === 'canvas' ? '重命名' : '重命名文件夹').click())
  expect(document.querySelector<HTMLInputElement>('.dc-name-dialog input')!.value).toBe(item.name)
  input('新名称'); await submit()
  expect(f.command).toHaveBeenCalledExactlyOnceWith({ operation: `${kind}-rename`, id: item.id, revision: item.revision, name: '新名称' })
})
it('validates empty/oversized names and cancels without writes', async () => {
  const f = await mount()
  await act(async () => button('＋ 新建画布').click())
  input('  '); await submit()
  expect(document.querySelector('.dc-name-dialog [role="alert"]')!.textContent).toContain('请输入画布名称')
  input('a'.repeat(161)); await submit()
  expect(document.querySelector('.dc-name-dialog [role="alert"]')!.textContent).toContain('160')
  await act(async () => button('取消').click())
  expect(f.command).not.toHaveBeenCalled(); expect(document.querySelector('.dc-name-dialog')).toBeNull()
})
it('creates folders through the same dialog and restores trigger focus on Escape cancellation', async () => {
  const f = await mount()
  const trigger = document.querySelector<HTMLButtonElement>('[aria-label="新建文件夹"]')!
  act(() => trigger.focus())
  await act(async () => trigger.click())
  input('文件夹草稿')
  act(() => document.querySelector('.dc-name-dialog input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(document.querySelector('.dc-name-dialog')).toBeNull()
  expect(document.activeElement).toBe(trigger); expect(f.command).not.toHaveBeenCalled()
  await act(async () => trigger.click())
  input('新文件夹'); await submit()
  expect(f.command).toHaveBeenCalledExactlyOnceWith({ operation: 'folder-create', name: '新文件夹' })
})
it('keeps failed drafts, retries explicitly and gates duplicate submit/close during a pending command', async () => {
  const f = await mount()
  let resolve!: (value: any) => void
  f.command.mockRejectedValueOnce(new Error('名称重复')).mockReturnValueOnce(new Promise((yes) => { resolve = yes }))
  await act(async () => button('＋ 新建画布').click())
  input('保存我的草稿'); await submit()
  expect(document.querySelector<HTMLInputElement>('.dc-name-dialog input')!.value).toBe('保存我的草稿')
  expect(document.querySelector('.dc-name-dialog [role="alert"]')!.textContent).toBe('名称重复')
  act(() => {
    const form = document.querySelector('form')!
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  expect(f.command).toHaveBeenCalledTimes(2)
  await act(async () => document.querySelector<HTMLButtonElement>('.dc-name-dialog [aria-label="关闭"]')!.click())
  expect(document.querySelector('.dc-name-dialog')).toBeTruthy()
  await act(async () => resolve({}))
  expect(document.querySelector('.dc-name-dialog')).toBeNull()
})
