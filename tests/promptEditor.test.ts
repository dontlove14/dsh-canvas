// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { assetToken } from '../src/shared/promptMentions'
import { editorSelection, editorText, renderEditor, restoreEditorSelection } from '../src/client/promptEditorDom'
import { PromptEditorController, type PromptEditorOptions, type PromptSuggestions } from '../src/client/promptEditorController'
import type { PromptReference } from '../src/client/promptReferences'

const item: PromptReference = { assetId: '00000000-0000-4000-a000-000000000010', sourceId: '00000000-0000-4000-a000-000000000011', token: assetToken('00000000-0000-4000-a000-000000000010'), label: '参考图1', name: '山湖', kind: 'image', connected: true }
const cleanup: Array<() => void> = []
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose(); document.body.replaceChildren() })
function setup(value = '', references: PromptReference[] = [item]) {
  const root = document.createElement('div')
  root.tabIndex = 0; document.body.append(root)
  let suggestion: PromptSuggestions | null = null
  const options: PromptEditorOptions = { value, disabled: false, references, candidates: [item], preview: (id) => '/media/' + id,
    onChange: vi.fn(), onChoose: vi.fn(() => item), onSuggestions: (next) => { suggestion = next }, onError: vi.fn() }
  const controller = new PromptEditorController(root, options)
  cleanup.push(() => controller.destroy())
  root.focus(); restoreEditorSelection(root, { start: value.length, end: value.length })
  const input = (text: string, caret = text.length) => {
    root.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', bubbles: true }))
    root.textContent = text; restoreEditorSelection(root, { start: caret, end: caret })
    root.dispatchEvent(new InputEvent('input', { inputType: 'insertText', bubbles: true }))
  }
  const key = (key: string, extra: KeyboardEventInit = {}) => root.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }))
  return { root, controller, options, input, key, suggestion: () => suggestion }
}
function clipboard(root: HTMLElement, type: string, text = '', html = '') {
  const data: Record<string, string> = { 'text/plain': text, 'text/html': html }
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: { getData: (kind: string) => data[kind] ?? '', setData: (kind: string, value: string) => { data[kind] = value } } })
  root.dispatchEvent(event)
  return data
}
describe('prompt editing and native event isolation', () => {
  it('round trips multiline text, emoji and noneditable chips with caret on either side', () => {
    const { root } = setup()
    const value = '中文😀\n' + item.token + '末尾\n'
    renderEditor(root, value, [item], () => '/cover')
    expect(editorText(root)).toBe(value)
    expect(root.querySelector('[data-prompt-token]')?.getAttribute('contenteditable')).toBe('false')
    for (const offset of [0, 2, 4, 5, 5 + item.token.length, value.length]) {
      restoreEditorSelection(root, { start: offset, end: offset })
      expect(editorSelection(root)).toEqual({ start: offset, end: offset })
    }
  })
  it('inserts at the query position and preserves the suffix; arrows choose, Escape dismisses', () => {
    const { root, input, key, options, suggestion } = setup()
    input('画面 @山 后文', 5)
    expect(suggestion()?.items).toEqual([item])
    key('ArrowDown'); key('Enter')
    expect(editorText(root)).toBe('画面 ' + item.token + '  后文')
    expect(editorSelection(root)?.start).toBe(3 + item.token.length + 1)
    expect(options.onChoose).toHaveBeenCalledWith(item, editorText(root))
    input('@'); key('Escape')
    expect(suggestion()).toBeNull()
    expect(editorText(root)).toBe('@')
  })
  it('defers Chinese composition and never treats IME Enter as selecting a reference', () => {
    const { root, key, options, suggestion } = setup('@')
    root.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    root.textContent = '@山'
    restoreEditorSelection(root, { start: 2, end: 2 })
    root.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }))
    key('Enter', { isComposing: true })
    expect(options.onChange).not.toHaveBeenCalled()
    expect(options.onChoose).not.toHaveBeenCalled()
    expect(suggestion()).toBeNull()
    root.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
    expect(options.onChange).toHaveBeenCalledWith('@山')
    expect(suggestion()?.items).toEqual([item])
  })
  it('deletes an adjacent reference atomically and restores it with undo/redo', () => {
    const { root, key, options } = setup('前' + item.token + '后')
    restoreEditorSelection(root, { start: 1 + item.token.length, end: 1 + item.token.length })
    key('Backspace')
    expect(editorText(root)).toBe('前后')
    key('z', { metaKey: true })
    expect(editorText(root)).toBe('前' + item.token + '后')
    expect(editorSelection(root)?.start).toBe(1 + item.token.length)
    key('z', { metaKey: true, shiftKey: true })
    expect(editorText(root)).toBe('前后')
    expect(options.onChange).toHaveBeenLastCalledWith('前后')
  })
  it('copies/cuts stable IDs and pastes plain text only; unconnected IDs remain invalid', () => {
    const { root, key } = setup(item.token + '\n尾部')
    restoreEditorSelection(root, { start: 0, end: item.token.length })
    expect(clipboard(root, 'copy')['text/plain']).toBe(item.token)
    expect(clipboard(root, 'cut')['text/plain']).toBe(item.token)
    expect(editorText(root)).toBe('\n尾部')
    key('z', { ctrlKey: true })
    restoreEditorSelection(root, { start: 0, end: editorText(root).length })
    const missing = assetToken('00000000-0000-4000-a000-000000000020')
    clipboard(root, 'paste', '<img onerror=alert(1)>' + missing, '<img src=x onerror=alert(1)>')
    expect(root.querySelector('img[onerror]')).toBeNull()
    expect(editorText(root)).toBe('<img onerror=alert(1)>' + missing)
    expect(root.querySelector('.invalid')?.textContent).toBe('@引用失效')
  })
  it('updates labels and invalid state without resetting the caret or current text', () => {
    const { root, controller, options } = setup('使用' + item.token + '参考')
    restoreEditorSelection(root, { start: 1, end: 1 })
    const chip = root.querySelector('[data-prompt-token]')
    controller.update({ ...options, references: [{ ...item, name: '<script>name</script>', label: '参考图2' }] })
    expect(root.querySelector('[data-prompt-token]')).toBe(chip)
    expect(chip?.textContent).toBe('@参考图2')
    expect(editorSelection(root)).toEqual({ start: 1, end: 1 })
    controller.update({ ...options, references: [] })
    expect(chip?.classList.contains('invalid')).toBe(true)
    expect(editorText(root)).toBe(options.value)
  })
  it('preserves external changes, multiline Enter and selection replacement', () => {
    const { root, controller, options } = setup('旧文字')
    restoreEditorSelection(root, { start: 1, end: 2 })
    controller.update({ ...options, value: '新的文字' })
    root.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertParagraph', bubbles: true, cancelable: true }))
    expect(editorText(root)).toBe('新\n文字')
    restoreEditorSelection(root, { start: 0, end: editorText(root).length })
    clipboard(root, 'paste', '两行\r\n文字\n')
    expect(controller.flush()).toBe('两行\n文字\n')
  })
  it('enforces the raw length limit, disabled editing and removes event listeners', () => {
    const { root, controller, options, input, key } = setup('内容')
    clipboard(root, 'paste', 'x'.repeat(32001))
    expect(editorText(root)).toBe('内容')
    expect(options.onError).toHaveBeenCalled()
    controller.update({ ...options, disabled: true })
    clipboard(root, 'paste', '不能修改'); key('Backspace')
    expect(editorText(root)).toBe('内容')
    controller.update(options); controller.destroy()
    input('卸载后')
    expect(options.onChange).not.toHaveBeenCalled()
  })
  it('typing Space and Delete never reaches canvas keyboard listeners', () => {
    const { root, key } = setup('正常输入')
    const canvas = vi.fn()
    window.addEventListener('keydown', canvas)
    cleanup.push(() => window.removeEventListener('keydown', canvas))
    key(' '); key('Delete')
    expect(canvas).not.toHaveBeenCalled()
    expect(root.getAttribute('contenteditable')).toBe('true')
  })
  it('keeps candidates open while their list scrolls and closes when the page moves', () => {
    const { input, suggestion } = setup()
    input('@')
    const menu = document.createElement('div'); menu.dataset.promptSuggestions = ''
    const list = document.createElement('div'); menu.append(list); document.body.append(menu)
    list.dispatchEvent(new Event('scroll'))
    expect(suggestion()?.items).toEqual([item])
    window.dispatchEvent(new Event('scroll'))
    expect(suggestion()).toBeNull()
  })
})
