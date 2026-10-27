// @vitest-environment jsdom
import { act, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UiDateTimeRangePicker } from '../src/client/UiDateTimeRangePicker'
import { UiPagination, paginationPages } from '../src/client/UiPagination'
import { calendarDays, parseLocalDateTime, rangeFromFields, type DateTimeRange } from '../src/client/dateTimeRange'
import { TaskCatalog, TaskDialog } from '../src/client/TaskDialog'
import { CanvasApi } from '../src/client/api'
import type { TaskRow, TaskPage, TaskSearchQuery } from '../src/shared/v2'

const roots: Root[] = []
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1 })
  HTMLDialogElement.prototype.showModal = function () { this.open = true }
  HTMLDialogElement.prototype.close = function () { this.open = false }
})
afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount())); document.body.replaceChildren(); vi.unstubAllGlobals()
  delete (document as unknown as { execCommand?: unknown }).execCommand
})
function mount(element: ReactNode) {
  const box = document.createElement('div'); document.body.append(box)
  const root = createRoot(box); roots.push(root); act(() => root.render(element)); return box
}
async function click(button: HTMLElement) { await act(async () => { button.click() }) }
function button(box: ParentNode, label: string) {
  const value = [...box.querySelectorAll<HTMLButtonElement>('button')].find((element) => element.getAttribute('aria-label') === label || element.textContent?.trim() === label)
  if (!value) throw new Error(`Missing button: ${label}`); return value
}
function change(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  act(() => { input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })) })
}
function key(input: HTMLElement, name: string) { act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })) }) }
function Picker({ initial = {}, onValue }: { initial?: DateTimeRange; onValue: (value: DateTimeRange) => void }) {
  const [value, setValue] = useState(initial)
  return <UiDateTimeRangePicker value={value} onChange={(next) => { setValue(next); onValue(next) }} />
}
const row: TaskRow = { id: 'd0bcd0a4-7fbc-4306-95f0-1d5951767167', canvasId: 'canvas-other', nodeId: 'node', folderName: '素材库', canvasName: '分镜', nodeName: '生图节点',
  type: 'image', status: 'completed', createdAt: 1000, updatedAt: 2000 }
const result = (query: Partial<TaskSearchQuery> = {}): TaskPage => ({ items: [row], total: 23, page: query.page ?? 1, pageSize: query.pageSize ?? 20, upperBound: 23 })

describe('shared date/time range and pagination', () => {
  it('uses local timestamps, rejects invalid dates and inverted intervals, and permits either bound', () => {
    expect(new Date(parseLocalDateTime('2024-02-29', '14:15:16')!).getHours()).toBe(14)
    expect(() => parseLocalDateTime('2023-02-29', '00:00:00')).toThrow()
    expect(() => parseLocalDateTime('2024-02-29', '24:00:00')).toThrow()
    expect(rangeFromFields('', '00:00:00', '2024-02-29', '23:59:59')).toEqual({ start: undefined, end: parseLocalDateTime('2024-02-29', '23:59:59')! + 999 })
    expect(rangeFromFields('2024-02-29', '00:00:00', '', '23:59:59')).toEqual({ start: parseLocalDateTime('2024-02-29', '00:00:00'), end: undefined })
    expect(() => rangeFromFields('2024-03-01', '00:00:00', '2024-02-29', '23:59:59')).toThrow('开始时间')
    const days = calendarDays(new Date(2024, 1, 1))
    expect(days).toHaveLength(42); expect(days[0].getDay()).toBe(0)
    expect(days.filter((date) => date.getMonth() === 1)).toHaveLength(29)
  })
  it('renders two months in the enclosing modal, selects calendar dates and keeps drafts until confirm', async () => {
    const value = vi.fn()
    const box = mount(<dialog open><Picker initial={{ start: parseLocalDateTime('2024-02-10', '10:00:00') }} onValue={value} /></dialog>)
    await click(button(box, '时间范围'))
    const popup = box.querySelector('.dc-datetime-popup')!
    expect(popup.closest('dialog')).toBe(box.querySelector('dialog'))
    expect(popup.querySelectorAll('.dc-datetime-calendar')).toHaveLength(2)
    await click(button(popup, '2024-02-11')); await click(button(popup, '2024-02-12'))
    expect(value).not.toHaveBeenCalled()
    await click(button(popup, '确定'))
    expect(value).toHaveBeenLastCalledWith({ start: parseLocalDateTime('2024-02-11', '10:00:00'), end: parseLocalDateTime('2024-02-12', '23:59:59')! + 999 })
    expect(document.querySelector('.dc-datetime-popup')).toBeNull(); expect(document.activeElement).toBe(button(box, '时间范围'))
  })
  it('edits single end dates, validates inversion, clears values and closes only the picker on Escape', async () => {
    const value = vi.fn(); const modalEscape = vi.fn()
    const box = mount(<div onKeyDown={modalEscape}><Picker onValue={value} /></div>)
    await click(button(box, '时间范围'))
    let popup = document.querySelector('.dc-datetime-popup')!
    change(popup.querySelector('[aria-label="结束日期"]')!, '2024-02-29')
    await click(button(popup, '确定'))
    expect(value).toHaveBeenLastCalledWith({ start: undefined, end: parseLocalDateTime('2024-02-29', '23:59:59')! + 999 })
    await click(button(box, '时间范围')); popup = document.querySelector('.dc-datetime-popup')!
    change(popup.querySelector('[aria-label="开始日期"]')!, '2024-03-01')
    await click(button(popup, '确定')); expect(popup.querySelector('[role="alert"]')?.textContent).toContain('开始时间')
    key(popup.querySelector('input')!, 'Escape')
    expect(document.querySelector('.dc-datetime-popup')).toBeNull(); expect(modalEscape).not.toHaveBeenCalled()
    expect(value).toHaveBeenCalledTimes(1)
    await click(button(box, '时间范围')); await click(button(document, '清空')); expect(value).toHaveBeenLastCalledWith({})
  })
  it('supports calendar keyboard focus and compact pagination with clamped jump and size changes', async () => {
    const box = mount(<Picker initial={{ start: parseLocalDateTime('2024-02-10', '00:00:00') }} onValue={vi.fn()} />)
    await click(button(box, '时间范围'))
    const day = button(document, '2024-02-10'); act(() => day.focus()); key(day, 'ArrowRight')
    expect(document.activeElement?.getAttribute('data-date')).toBe('2024-02-11')
    expect(paginationPages(50, 100)).toEqual([1, 'ellipsis-left', 49, 50, 51, 'ellipsis-right', 100])
    const page = vi.fn(); const size = vi.fn()
    const pages = mount(<UiPagination total={95} page={1} pageSize={20} onPage={page} onPageSize={size} />)
    expect(button(pages, '上一页').disabled).toBe(true); await click(button(pages, '下一页')); expect(page).toHaveBeenLastCalledWith(2)
    const jump = pages.querySelector<HTMLInputElement>('[aria-label="跳转页码"]')!
    change(jump, '500'); key(jump, 'Enter'); expect(page).toHaveBeenLastCalledWith(5)
    change(jump, 'bad'); key(jump, 'Enter'); expect(jump.value).toBe('1')
    const select = pages.querySelector('select')!
    act(() => { select.value = '50'; select.dispatchEvent(new Event('change', { bubbles: true })) }); expect(size).toHaveBeenLastCalledWith(50)
  })
})
describe('task table search, request lifecycle and detail navigation', () => {
  it('shows a shortened ID, copies the full value, and reports success without opening detail or querying again', async () => {
    const api = new CanvasApi(); api.searchTasks = vi.fn(async () => result())
    const writeText = vi.fn(async () => {}); vi.stubGlobal('navigator', { clipboard: { writeText } })
    const detail = vi.fn(); const box = mount(<TaskCatalog api={api} onDetail={detail} />); await act(async () => {})
    const displayed = box.querySelector('.dc-task-id-cell .dc-task-id')!
    expect(displayed.textContent).toBe(`${row.id.slice(0, 16)}...`); expect(displayed.getAttribute('title')).toBe(row.id)
    await click(button(box, `复制任务 ID ${row.id}`))
    expect(writeText).toHaveBeenCalledWith(row.id); expect(box.querySelector('[role="status"]')?.textContent).toBe('任务 ID 已复制')
    expect(detail).not.toHaveBeenCalled(); expect(api.searchTasks).toHaveBeenCalledTimes(1)
  })
  it('falls back to a modal-local selection when clipboard access fails, restoring focus and keeping the draft', async () => {
    const api = new CanvasApi(); api.searchTasks = vi.fn(async () => result())
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('Clipboard blocked')) } })
    let selected = ''
    document.execCommand = vi.fn(() => {
      const field = document.activeElement as HTMLTextAreaElement
      selected = field.value
      expect(field.closest('dialog')).not.toBeNull()
      return true
    })
    const box = mount(<TaskDialog api={api} onClose={vi.fn()} />); await act(async () => {})
    const input = box.querySelector<HTMLInputElement>('[placeholder="输入文件夹名称"]')!
    change(input, '未提交查询草稿')
    const copy = button(box, `复制任务 ID ${row.id}`); act(() => copy.focus())
    await click(copy)
    expect(document.execCommand).toHaveBeenCalledWith('copy'); expect(selected).toBe(row.id)
    expect(document.activeElement).toBe(copy); expect(box.querySelector('textarea')).toBeNull()
    expect(input.value).toBe('未提交查询草稿'); expect(api.searchTasks).toHaveBeenCalledTimes(1)
  })
  it('reports copy failure instead of claiming success when both clipboard paths are unavailable', async () => {
    const api = new CanvasApi(); api.searchTasks = vi.fn(async () => result())
    vi.stubGlobal('navigator', {}); document.execCommand = vi.fn(() => false)
    const box = mount(<TaskCatalog api={api} onDetail={vi.fn()} />); await act(async () => {})
    await click(button(box, `复制任务 ID ${row.id}`))
    expect(box.querySelector('[role="alert"]')?.textContent).toBe('复制失败，请重试')
    expect(button(box, `复制任务 ID ${row.id}`).title).toBe('复制任务 ID')
    expect(box.querySelector('textarea')).toBeNull()
  })
  it('searches explicitly, uses all directory columns and retains filters/page when returning from cross-canvas detail', async () => {
    const api = new CanvasApi(); api.searchTasks = vi.fn(async (query) => result(query))
    api.taskDetail = vi.fn(async () => ({ task: null, kind: 'import', phase: 'completed', externalTaskId: null, externalCompletedAt: null, successAt: 2000, failureStage: null, failureCode: null, failureMessage: null, attempts: [] }))
    const box = mount(<TaskDialog api={api} onClose={vi.fn()} />)
    await act(async () => {})
    expect([...box.querySelectorAll('th')].map((cell) => cell.textContent)).toEqual(['任务 ID', '文件夹名称', '画布名称', '生成节点名称', '任务状态', '更新时间', '提交时间', '操作'])
    const folder = box.querySelector<HTMLInputElement>('input[placeholder="输入文件夹名称"]')!
    change(folder, ' 素材 '); expect(api.searchTasks).toHaveBeenCalledTimes(1)
    await click(button(box, '查询')); expect(api.searchTasks).toHaveBeenLastCalledWith({ folderName: '素材', page: 1, pageSize: 20, startTime: undefined, endTime: undefined }, expect.any(AbortSignal))
    await click(button(box, '下一页')); expect(api.searchTasks).toHaveBeenLastCalledWith({ folderName: '素材', page: 2, pageSize: 20, startTime: undefined, endTime: undefined, upperBound: 23 }, expect.any(AbortSignal))
    await click(button(box, '查看详情')); expect(api.taskDetail).toHaveBeenCalledWith('canvas-other', row.id, expect.any(AbortSignal))
    expect(box.querySelector('.dc-task-detail-view')).not.toBeNull()
    await click(button(box, '‹ 返回列表'))
    expect(box.querySelector('.dc-task-detail-view')).toBeNull(); expect(folder.value).toBe(' 素材 ')
    expect(box.querySelector('[aria-current="page"]')?.textContent).toBe('2'); expect(api.searchTasks).toHaveBeenCalledTimes(3)
    await click(button(box, '重置')); expect(folder.value).toBe(''); expect(api.searchTasks).toHaveBeenLastCalledWith({ page: 1, pageSize: 20 }, expect.any(AbortSignal))
  })
  it('aborts old searches, ignores late results, and shows errors and empty states without stale rows', async () => {
    const api = new CanvasApi()
    let resolveOld!: (value: TaskPage) => void
    api.searchTasks = vi.fn().mockImplementationOnce(() => new Promise<TaskPage>((resolve) => { resolveOld = resolve }))
      .mockResolvedValueOnce({ ...result(), items: [{ ...row, nodeName: '最新查询' }] })
      .mockRejectedValueOnce(new Error('连接中断')).mockResolvedValue({ ...result(), items: [], total: 0 })
    const box = mount(<TaskCatalog api={api} onDetail={vi.fn()} />)
    await click(button(box, '查询'))
    expect((vi.mocked(api.searchTasks).mock.calls[0][1] as AbortSignal).aborted).toBe(true)
    expect(box.textContent).toContain('最新查询')
    await act(async () => { resolveOld({ ...result(), items: [{ ...row, nodeName: '过期查询' }] }) })
    expect(box.textContent).not.toContain('过期查询')
    await click(button(box, '查询')); expect(box.textContent).toContain('连接中断'); expect(box.querySelector('[data-task-id]')).toBeNull()
    await click(button(box, '重新查询')); expect(box.textContent).toContain('暂无符合条件的任务')
  })
  it('validates exact IDs and passes only entered type and submitted-time conditions', async () => {
    const api = new CanvasApi(); api.searchTasks = vi.fn(async () => result())
    const box = mount(<TaskCatalog api={api} onDetail={vi.fn()} />); await act(async () => {})
    const id = box.querySelector<HTMLInputElement>('[placeholder="输入完整任务 ID"]')!
    change(id, 'partial'); await click(button(box, '查询')); expect(api.searchTasks).toHaveBeenCalledTimes(1); expect(box.textContent).toContain('完整的任务 ID')
    change(id, row.id)
    const select = box.querySelector<HTMLSelectElement>('[aria-label="任务类型"]')!
    act(() => { select.value = 'tts'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    await click(button(box, '提交时间范围'))
    const popup = document.querySelector('.dc-datetime-popup')!
    change(popup.querySelector('[aria-label="开始日期"]')!, '2024-02-29'); await click(button(popup, '确定'))
    await click(button(box, '查询'))
    expect(api.searchTasks).toHaveBeenLastCalledWith({ taskId: row.id, type: 'tts', startTime: parseLocalDateTime('2024-02-29', '00:00:00'), endTime: undefined, page: 1, pageSize: 20 }, expect.any(AbortSignal))
  })
})
