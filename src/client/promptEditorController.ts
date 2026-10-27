import { mentionQuery, promptParts, PROMPT_LIMIT, type MentionQuery } from '../shared/promptMentions'
import { editorText, editorSelection, renderEditor, restoreEditorSelection, syncEditorChips, type EditorSelection, type PromptChoice } from './promptEditorDom'
import type { PromptReference } from './promptReferences'

export interface PromptSuggestions<T extends PromptChoice = PromptReference> {
  query: MentionQuery; items: T[]; active: number; left: number; top: number
}
export interface PromptEditorCodec {
  parts: (value: string) => readonly { kind: 'text' | 'mention'; value: string; start: number; end: number }[]
  query: (value: string, caret: number) => MentionQuery | null
  render: (root: HTMLElement, value: string) => void
  sync: (root: HTMLElement) => void
  suffix: string
}
export interface PromptEditorOptions<T extends PromptChoice = PromptReference> {
  value: string; disabled: boolean; references: readonly T[]; candidates: readonly T[]
  preview: (id: string) => string
  onChange: (value: string) => void
  onChoose: (item: T, value: string) => T
  onSuggestions: (value: PromptSuggestions<T> | null) => void
  onError: (error: unknown) => void
  codec?: PromptEditorCodec
}
interface HistoryEntry { value: string; selection: EditorSelection }

/** Native events keep composition, clipboard and beforeinput identical in both nodes. */
export class PromptEditorController<T extends PromptChoice = PromptReference> {
  private options: PromptEditorOptions<T>
  private value: string
  private composing = false
  private history: HistoryEntry[]
  private historyIndex = 0
  private suggestion: PromptSuggestions<T> | null = null
  private disposed = false
  private listeners: Array<() => void> = []
  constructor(readonly root: HTMLDivElement, options: PromptEditorOptions<T>) {
    this.options = options; this.value = options.value
    this.history = [{ value: options.value, selection: { start: options.value.length, end: options.value.length } }]
    this.render(this.value)
    this.listen(root, 'beforeinput', this.beforeInput)
    this.listen(root, 'input', this.input)
    this.listen(root, 'keydown', this.keydown)
    this.listen(root, 'paste', this.paste)
    this.listen(root, 'drop', (event) => { event.preventDefault(); event.stopPropagation() })
    this.listen(root, 'copy', (event) => this.copy(event, false))
    this.listen(root, 'cut', (event) => this.copy(event, true))
    this.listen(root, 'compositionstart', () => { this.rememberCaret(); this.composing = true; this.close() })
    this.listen(root, 'compositionend', () => { this.composing = false; this.input() })
    this.listen(root, 'focus', () => this.refreshSuggestions())
    this.listen(root, 'blur', () => { if (!this.composing) this.flush(); this.close() })
    this.listen(root.ownerDocument, 'selectionchange', () => { if (root.ownerDocument.activeElement === root) this.refreshSuggestions() })
    this.listen(root.ownerDocument, 'pointerdown', (event) => {
      const el = event.target as Element | null
      if (!root.contains(el) && !el?.closest?.('[data-prompt-suggestions]')) this.close()
    })
    this.listen(root.ownerDocument.defaultView!, 'resize', () => this.close())
    this.listen(root.ownerDocument.defaultView!, 'scroll', (event) => {
      if (!(event.target as Element | null)?.closest?.('[data-prompt-suggestions]')) this.close()
    }, true)
    this.update(options)
  }
  private listen(target: EventTarget, name: string, handler: (event: any) => void, capture = false) {
    target.addEventListener(name, handler, capture)
    this.listeners.push(() => target.removeEventListener(name, handler, capture))
  }
  private parts(value: string) { return this.options.codec?.parts(value) ?? promptParts(value) }
  private render(value: string, references = this.options.references): void {
    if (this.options.codec) this.options.codec.render(this.root, value)
    else renderEditor(this.root, value, references, this.options.preview)
  }
  update(options: PromptEditorOptions<T>): void {
    this.options = options
    this.root.contentEditable = String(!options.disabled)
    this.root.setAttribute('contenteditable', String(!options.disabled))
    if (this.composing) return
    if (options.value !== this.value) {
      const selection = editorSelection(this.root)
      this.value = options.value
      this.render(this.value)
      if (selection) restoreEditorSelection(this.root, selection)
      this.history = [{ value: this.value, selection: selection ?? { start: this.value.length, end: this.value.length } }]
      this.historyIndex = 0; this.close()
    } else if (options.codec) options.codec.sync(this.root)
    else syncEditorChips(this.root, options.references, options.preview)
    if (options.disabled) this.close()
  }
  flush(): string {
    if (this.composing) throw new Error('请先完成正在输入的文字')
    this.input(); return this.value
  }
  close = (): void => { this.suggestion = null; if (!this.disposed) this.options.onSuggestions(null) }
  destroy(): void { this.disposed = true; for (const remove of this.listeners) remove(); this.listeners = [] }
  private rememberCaret() {
    const selection = editorSelection(this.root)
    if (selection) this.history[this.historyIndex].selection = selection
  }
  private commit(value: string, selection: EditorSelection, notify = true): void {
    if (value === this.value) return
    this.value = value
    this.history = this.history.slice(0, this.historyIndex + 1)
    this.history.push({ value, selection })
    if (this.history.length > 100) this.history.shift()
    this.historyIndex = this.history.length - 1
    if (notify) this.options.onChange(value)
  }
  private replace(text: string, range = editorSelection(this.root), notify = true, references = this.options.references): void {
    if (!range || this.options.disabled) return
    const raw = editorText(this.root)
    const parts = this.parts(raw)
    // Any selected portion of a chip is treated as the entire reference.
    for (const part of parts) if (part.kind === 'mention') {
      if (range.start > part.start && range.start < part.end) range = { ...range, start: part.start }
      if (range.end > part.start && range.end < part.end) range = { ...range, end: part.end }
    }
    const value = raw.slice(0, range.start) + text + raw.slice(range.end)
    if (value.length > PROMPT_LIMIT) { this.options.onError(new Error('提示词最多支持 32000 个字符')); return }
    this.rememberCaret()
    const selection = { start: range.start + text.length, end: range.start + text.length }
    this.render(value, references)
    restoreEditorSelection(this.root, selection)
    this.commit(value, selection, notify); this.refreshSuggestions()
  }
  choose = (item: T): void => {
    const suggestion = this.suggestion
    if (!suggestion || this.options.disabled || this.composing) return
    const value = editorText(this.root)
    const suffix = this.options.codec?.suffix ?? ' '
    const next = value.slice(0, suggestion.query.start) + item.token + suffix + value.slice(suggestion.query.end)
    if (next.length > PROMPT_LIMIT) { this.options.onError(new Error('提示词最多支持 32000 个字符')); return }
    try {
      const reference = this.options.onChoose(item, next)
      this.root.focus()
      this.replace(item.token + suffix, suggestion.query, false, [...this.options.references, reference])
      this.close()
    } catch (error) { this.options.onError(error) }
  }
  private input = (): void => {
    if (this.composing || this.options.disabled) return
    const value = editorText(this.root)
    if (value.length > PROMPT_LIMIT) {
      this.render(this.value)
      restoreEditorSelection(this.root, this.history[this.historyIndex].selection)
      this.options.onError(new Error('提示词最多支持 32000 个字符')); return
    }
    const selection = editorSelection(this.root) ?? { start: value.length, end: value.length }
    this.commit(value, selection)
    // Typed or pasted serialized references become atomic chips.
    if (this.parts(value).filter((part) => part.kind === 'mention').length !== this.root.querySelectorAll('[data-prompt-token]').length) {
      this.render(value)
      restoreEditorSelection(this.root, selection)
    }
    this.root.dataset.empty = String(value.length === 0)
    this.refreshSuggestions()
  }
  private beforeInput = (event: InputEvent): void => {
    if (this.composing || event.isComposing) return
    this.rememberCaret()
    if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') {
      event.preventDefault(); this.undo(event.inputType === 'historyRedo'); return
    }
    if (this.options.disabled) { event.preventDefault(); return }
    if (['insertParagraph', 'insertLineBreak'].includes(event.inputType)) { event.preventDefault(); this.replace('\n'); return }
    if (event.inputType === 'insertText' && editorText(this.root).length + (event.data?.length ?? 0) - ((editorSelection(this.root)?.end ?? 0) - (editorSelection(this.root)?.start ?? 0)) > PROMPT_LIMIT) {
      event.preventDefault(); this.options.onError(new Error('提示词最多支持 32000 个字符'))
    }
  }
  private undo(redo: boolean): void {
    const next = this.historyIndex + (redo ? 1 : -1)
    if (next < 0 || next >= this.history.length || this.options.disabled) return
    this.historyIndex = next
    const entry = this.history[next]; this.value = entry.value
    this.render(entry.value)
    restoreEditorSelection(this.root, entry.selection)
    this.options.onChange(entry.value); this.close()
  }
  private keydown = (event: KeyboardEvent): void => {
    event.stopPropagation()
    if (this.composing || event.isComposing || event.keyCode === 229 || this.options.disabled) return
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); this.undo(event.shiftKey); return }
    if (event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 'y') { event.preventDefault(); this.undo(true); return }
    const suggestion = this.suggestion
    if (suggestion) {
      if (event.key === 'Escape') { event.preventDefault(); this.close(); return }
      if (suggestion.items.length && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
        event.preventDefault()
        suggestion.active = (suggestion.active + (event.key === 'ArrowDown' ? 1 : -1) + suggestion.items.length) % suggestion.items.length
        this.options.onSuggestions({ ...suggestion }); return
      }
      if (suggestion.items.length && ['Enter', 'Tab'].includes(event.key)) { event.preventDefault(); this.choose(suggestion.items[suggestion.active]); return }
    }
    const selection = editorSelection(this.root)
    if (selection?.start === selection?.end && selection && ['Backspace', 'Delete'].includes(event.key)) {
      const part = this.parts(editorText(this.root)).find((part) => part.kind === 'mention' && (event.key === 'Backspace' ? part.end === selection.start : part.start === selection.end))
      if (part) { event.preventDefault(); this.replace('', { start: part.start, end: part.end }); return }
    }
  }
  private paste = (event: ClipboardEvent): void => {
    event.preventDefault(); event.stopPropagation()
    if (!this.composing) this.replace((event.clipboardData?.getData('text/plain') ?? '').replace(/\r\n?/g, '\n'))
  }
  private copy(event: ClipboardEvent, cut: boolean): void {
    const selection = editorSelection(this.root)
    if (!selection || !event.clipboardData || this.composing) return
    event.preventDefault(); event.stopPropagation()
    event.clipboardData.setData('text/plain', editorText(this.root).slice(selection.start, selection.end))
    if (cut) this.replace('')
  }
  private refreshSuggestions(): void {
    if (this.composing || this.options.disabled || this.root.ownerDocument.activeElement !== this.root) return
    const selection = editorSelection(this.root)
    const queryFor = this.options.codec?.query ?? mentionQuery
    const query = selection && selection.start === selection.end ? queryFor(editorText(this.root), selection.end) : null
    if (!query) { this.close(); return }
    const needle = query.query.toLocaleLowerCase()
    const items = this.options.candidates.filter((item) => `${item.name} ${item.label}`.toLocaleLowerCase().includes(needle))
    const range = this.root.ownerDocument.getSelection()?.getRangeAt(0)
    const caret = range && typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect() : null
    const box = caret?.width || caret?.height ? caret : this.root.getBoundingClientRect()
    const win = this.root.ownerDocument.defaultView!
    this.suggestion = { query, items, active: this.suggestion?.query.query === query.query && this.suggestion.query.start === query.start ? Math.min(this.suggestion.active, Math.max(0, items.length - 1)) : 0,
      left: Math.max(8, Math.min(win.innerWidth - 316, box?.left ?? 8)), top: Math.max(8, Math.min(win.innerHeight - 270, (box?.bottom ?? 8) + 6)) }
    this.options.onSuggestions(this.suggestion)
  }
}
