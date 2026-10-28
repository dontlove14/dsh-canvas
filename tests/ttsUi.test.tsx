// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EmotionTextArea } from '../src/client/EmotionTextArea'
import { UiNumberCounter } from '../src/client/UiNumberCounter'
import { TtsEditor } from '../src/client/TtsEditor'
import { TtsSettings } from '../src/client/TtsSettings'
import { CanvasApi } from '../src/client/api'
import { defaultTtsParams, FISH_TTS_ENDPOINT, type CanvasNode } from '../src/shared/contracts'
import { emotionQuery, insertEmotion } from '../src/shared/ttsEmotions'
import { editorText, editorSelection, restoreEditorSelection } from '../src/client/promptEditorDom'
import { TtsNode } from '../src/client/TtsNode'
import { ReactFlowProvider } from '@xyflow/react'
const roots: Root[] = []
afterEach(() => { act(() => roots.splice(0).forEach((root) => root.unmount())); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
function mount(element: React.ReactNode) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container); roots.push(root); act(() => root.render(element)); return container
}
function text(input: HTMLInputElement | HTMLDivElement, value: string, caret = value.length) {
  act(() => {
    if (input instanceof HTMLInputElement) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
      input.setSelectionRange(caret, caret)
    } else {
      input.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', bubbles: true }))
      input.textContent = value
      restoreEditorSelection(input, { start: caret, end: caret })
    }
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
function key(input: HTMLElement, value: string) { act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })) }) }
function clipboard(root: HTMLElement, type: string, text = '', html = '') {
  const data: Record<string, string> = { 'text/plain': text, 'text/html': html }
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: { getData: (kind: string) => data[kind] ?? '', setData: (kind: string, value: string) => { data[kind] = value } } })
  act(() => { root.dispatchEvent(event) })
  return data
}
describe('TTS editing controls', () => {
  it('renders existing tags as atomic badges, retains ordinary parentheses and supports deletion/undo/redo', () => {
    const raw = '(calm)(confident)你好（备注）(not-a-tag)(calm)'
    const changed = vi.fn()
    function Editor() { const [value, setValue] = useState(raw); return <EmotionTextArea value={value} onChange={(text) => { setValue(text); changed(text) }} /> }
    const container = mount(<Editor />); const editor = container.querySelector<HTMLDivElement>('[role="textbox"]')!
    expect([...editor.querySelectorAll('.dc-emotion-token')].map((chip) => chip.textContent)).toEqual(['@平静', '@自信', '@平静'])
    expect(editorText(editor)).toBe(raw); expect(changed).not.toHaveBeenCalled()
    act(() => { editor.focus(); restoreEditorSelection(editor, { start: 6, end: 6 }) })
    key(editor, 'Backspace'); expect(editorText(editor)).toBe(raw.slice(6))
    act(() => editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true })))
    expect(editorText(editor)).toBe(raw)
    expect(editor.querySelector('.dc-emotion-token')?.getAttribute('contenteditable')).toBe('false')
    act(() => editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, shiftKey: true, bubbles: true, cancelable: true })))
    expect(editorText(editor)).toBe(raw.slice(6)); expect(changed).toHaveBeenLastCalledWith(raw.slice(6))
  })
  it('copies the provider syntax, pastes safe text as badges and inserts from the portal without losing the suffix', () => {
    function Editor() { const [value, setValue] = useState('(calm)你好'); return <EmotionTextArea value={value} onChange={setValue} /> }
    const container = mount(<Editor />); const editor = container.querySelector<HTMLDivElement>('[role="textbox"]')!
    act(() => { editor.focus(); restoreEditorSelection(editor, { start: 0, end: 6 }) })
    expect(clipboard(editor, 'copy')['text/plain']).toBe('(calm)')
    expect(clipboard(editor, 'cut')['text/plain']).toBe('(calm)'); expect(editorText(editor)).toBe('你好')
    clipboard(editor, 'paste', '(sad)<img onerror=alert(1)>', '<img onerror=alert(1)>')
    expect(editor.querySelector('.dc-emotion-token')?.textContent).toBe('@悲伤')
    expect(editorText(editor)).toBe('(sad)<img onerror=alert(1)>你好'); expect(editor.querySelector('img')).toBeNull()
    text(editor, '前@平静后', 4)
    const menu = document.querySelector<HTMLElement>('.dc-tts-emotions')!
    expect(menu).toBeTruthy(); expect(container.contains(menu)).toBe(false)
    act(() => menu.querySelector<HTMLButtonElement>('[role="option"]')!.click())
    expect(editorText(editor)).toBe('前(calm)后'); expect(editorSelection(editor)).toEqual({ start: 7, end: 7 })
    expect(editor.querySelector('.dc-emotion-token')?.textContent).toBe('@平静')
  })
  it('matches the generation empty frame with one monochrome icon and only an output handle', () => {
    const node: CanvasNode = { id: crypto.randomUUID(), kind: 'tts-generation', title: '语音生成1', position: { x: 0, y: 0 }, modelId: null, assetId: null, selectedResultId: null, params: defaultTtsParams(), prompt: '(calm)不显示这段文字' }
    const size = vi.fn()
    const container = mount(<ReactFlowProvider><TtsNode node={node} selected={false} onRename={vi.fn()} onSize={size} /></ReactFlowProvider>)
    expect(container.querySelector('.dc-generation-node')).toBeTruthy()
    const frame = container.querySelector('.dc-generation-empty')!
    expect(frame.textContent).toBe('')
    expect(frame.querySelectorAll('.dc-tts-icon')).toHaveLength(1); expect(frame.querySelector('img')).toBeNull()
    expect(frame.querySelector('.dc-tts-icon svg')?.getAttribute('viewBox')).toBe('0 0 1024 1024')
    expect([...frame.querySelectorAll('.dc-tts-icon path')].every((path) => path.getAttribute('fill') === 'currentColor')).toBe(true)
    expect(size).toHaveBeenCalledWith(node.id, 320, 180)
    expect(container.querySelector('.react-flow__handle.source')).toBeTruthy(); expect(container.querySelector('.react-flow__handle.target')).toBeNull()
  })
  it('shows Chinese badges while preserving the exact FishTTS tokens and caret through parent echoes', () => {
    const changed = vi.fn()
    function Editor() { const [value, setValue] = useState('hello '); return <EmotionTextArea value={value} onChange={(next) => { setValue(next); changed(next) }} /> }
    const container = mount(<Editor />); const editor = container.querySelector<HTMLDivElement>('[role="textbox"]')!
    act(() => editor.focus()); text(editor, 'hello @开心')
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(1)
    key(editor, 'Enter'); expect(editorText(editor)).toBe('hello (happy)')
    expect(editor.querySelector('.dc-emotion-token')?.textContent).toBe('@开心')
    expect(editorSelection(editor)?.start).toBe(editorText(editor).length)
    text(editor, '@whis'); key(editor, 'Enter'); expect(editorText(editor)).toBe('(whispering)')
    expect(editor.querySelector('.dc-emotion-token')?.textContent).toBe('@低声耳语')
    text(editor, '(sad)@soft'); key(editor, 'Enter'); expect(editorText(editor)).toBe('(sad)(soft tone)')
    expect([...editor.querySelectorAll('.dc-emotion-token')].map((chip) => chip.textContent)).toEqual(['@悲伤', '@柔和语气'])
    expect(insertEmotion('A@开心B', { start: 1, end: 4 }, 'happy')).toEqual({ text: 'A(happy)B', caret: 8 })
    expect(emotionQuery('@happy', 3)).toMatchObject({ query: 'ha', start: 0, end: 3 })
    expect(container.querySelector('.dc-reference')).toBeNull(); expect(editor.querySelector('img')).toBeNull()
    expect(changed).toHaveBeenLastCalledWith('(sad)(soft tone)')
  })
  it('supports keyboard selection, Escape, IME composition and native text editing', () => {
    function Editor() { const [value, setValue] = useState(''); return <EmotionTextArea value={value} onChange={setValue} /> }
    const container = mount(<Editor />); const editor = container.querySelector<HTMLDivElement>('[role="textbox"]')!
    act(() => editor.focus()); text(editor, '@')
    key(editor, 'ArrowDown'); key(editor, 'Enter'); expect(editorText(editor)).toBe('(sad)')
    text(editor, '@'); key(editor, 'Escape'); expect(document.querySelector('[role="listbox"]')).toBeNull()
    act(() => editor.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })))
    text(editor, '@悲')
    key(editor, 'Enter'); expect(editorText(editor)).toBe('@悲'); expect(document.querySelector('[role="listbox"]')).toBeNull()
    act(() => editor.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '悲' })))
    expect(document.querySelector('[role="option"]')?.textContent).toContain('悲伤')
    const canvasKey = vi.fn(); window.addEventListener('keydown', canvasKey); key(editor, 'Delete'); window.removeEventListener('keydown', canvasKey)
    expect(canvasKey).not.toHaveBeenCalled()
    text(editor, '(happy) 复制的文字\n第二行'); expect(editorText(editor)).toContain('\n')
  })
  it('changes speed and signed volume precisely with buttons, typing and arrows', () => {
    const changed = vi.fn()
    function Counter() { const [value, setValue] = useState(1); return <UiNumberCounter label="语速" value={value} min={.1} step={.1} onChange={(next) => { setValue(next); changed(next) }} /> }
    const container = mount(<Counter />); const input = container.querySelector('input')!
    for (let i = 0; i < 3; i++) act(() => container.querySelector<HTMLButtonElement>('button[aria-label="增加语速"]')!.click())
    expect(input.value).toBe('1.30'); key(input, 'ArrowDown'); expect(input.value).toBe('1.20')
    act(() => input.focus()); text(input, '2.5'); key(input, 'Enter'); expect(input.value).toBe('2.50'); expect(changed).toHaveBeenLastCalledWith(2.5)
    act(() => input.focus()); text(input, '-3'); key(input, 'Enter'); expect(input.value).toBe('0.10')
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="减少语速"]')!.disabled).toBe(true)
    const volume = mount(<UiNumberCounter label="音量" value={0} onChange={changed} />)
    act(() => volume.querySelector<HTMLButtonElement>('button[aria-label="减少音量"]')!.click()); expect(changed).toHaveBeenLastCalledWith(-1)
  })
  it('uses only requested TTS fields, defaults and a generation action without a model selector', () => {
    const node: CanvasNode = { id: crypto.randomUUID(), kind: 'tts-generation', title: 'TTS', position: { x: 0, y: 0 }, modelId: null, assetId: null, selectedResultId: null, params: defaultTtsParams(), prompt: 'hello' }
    const generate = vi.fn().mockResolvedValue(undefined)
    const container = mount(<TtsEditor node={node} submitting={false} configured={true} patchNode={vi.fn()} generate={generate} />)
    expect(container.querySelector<HTMLInputElement>('input[aria-label="语速"]')!.value).toBe('1.00')
    expect(container.querySelector<HTMLInputElement>('input[aria-label="音量"]')!.value).toBe('0.00')
    expect(container.querySelector('input[aria-label="音色 ID"]')).toBeTruthy()
    expect(container.querySelector('[role="combobox"]')).toBeNull(); expect(container.querySelector('input[type="file"]')).toBeNull()
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="生成语音"]')!.click()); expect(generate).toHaveBeenCalledWith(node)
  })
  it('keeps TTS inputs and generate available during earlier tasks and disables them only while dispatching', () => {
    const node: CanvasNode = { id: crypto.randomUUID(), kind: 'tts-generation', title: 'TTS', position: { x: 0, y: 0 }, modelId: null, assetId: null,
      selectedResultId: null, params: defaultTtsParams(), prompt: 'hello' }
    const task = { id: crypto.randomUUID(), nodeId: node.id, workspaceId: 'w', status: 'generating' as const, createdAt: 1, updatedAt: 1, resultIds: [] }
    const props = { node, task, configured: true, patchNode: vi.fn(), generate: vi.fn() }
    const container = mount(<TtsEditor {...props} submitting={false} />)
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="生成语音"]')!.disabled).toBe(false)
    expect(container.querySelector<HTMLInputElement>('input[aria-label="音色 ID"]')!.disabled).toBe(false)
    act(() => roots.at(-1)!.render(<TtsEditor {...props} submitting />))
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="生成语音"]')!.disabled).toBe(true)
    expect(container.querySelector<HTMLInputElement>('input[aria-label="音色 ID"]')!.disabled).toBe(true)
  })
  it.each([false, null] as const)('shows configuration status and blocks generation even with valid text when readiness is %s', (configured) => {
    const node: CanvasNode = { id: crypto.randomUUID(), kind: 'tts-generation', title: 'TTS', position: { x: 0, y: 0 }, modelId: null, assetId: null,
      selectedResultId: null, params: defaultTtsParams(), prompt: '(happy) 你好' }
    const generate = vi.fn()
    const container = mount(<TtsEditor node={node} submitting={false} configured={configured} patchNode={vi.fn()} generate={generate} />)
    expect(container.querySelector('[role="status"]')!.textContent).toBe(configured === false ? '请前往设置页面配置模型' : '正在读取 FishTTS 配置…')
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="生成语音"]')!
    expect(button.disabled).toBe(true); act(() => button.click()); expect(generate).not.toHaveBeenCalled()
    expect(container.querySelector<HTMLInputElement>('input[aria-label="音色 ID"]')!.disabled).toBe(false)
    expect(editorText(container.querySelector<HTMLElement>('[role="textbox"]')!)).toBe(node.prompt)
  })
  it('updates the configuration prompt without changing drafts and fails closed on a read error', () => {
    const node: CanvasNode = { id: crypto.randomUUID(), kind: 'tts-generation', title: 'TTS', position: { x: 0, y: 0 }, modelId: null, assetId: null,
      selectedResultId: null, params: defaultTtsParams(), prompt: '(happy) 原有文字' }
    const patch = vi.fn(), generate = vi.fn()
    const view = (configured: boolean, configurationError = false) => <TtsEditor node={node} submitting={false} configured={configured}
      configurationError={configurationError} patchNode={patch} generate={generate} />
    const container = mount(view(false)), root = roots.at(-1)!
    act(() => root.render(view(true)))
    expect(container.querySelector('.dc-tts-configuration')).toBeNull()
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="生成语音"]')!.disabled).toBe(false)
    act(() => root.render(view(false)))
    expect(container.querySelector('[role="status"]')!.textContent).toBe('请前往设置页面配置模型')
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="生成语音"]')!.disabled).toBe(true)
    act(() => root.render(view(true, true)))
    expect(container.querySelector('[role="alert"]')!.textContent).toContain('配置读取失败')
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="生成语音"]')!.disabled).toBe(true)
    expect(editorText(container.querySelector<HTMLElement>('[role="textbox"]')!)).toBe(node.prompt)
    expect(patch).not.toHaveBeenCalled(); expect(generate).not.toHaveBeenCalled()
  })
  it('saves global endpoint/credentials and leaves an existing key untouched when the field stays empty', async () => {
    const api = new CanvasApi()
    vi.spyOn(api, 'ttsSettings').mockResolvedValue({ endpoint: FISH_TTS_ENDPOINT, revision: 2, configured: true, has_api_key: true, api_key_mask: '••••••••' })
    const save = vi.spyOn(api, 'saveTtsSettings').mockResolvedValue({ endpoint: FISH_TTS_ENDPOINT, revision: 3, configured: true, has_api_key: true, api_key_mask: '••••••••' })
    const container = mount(<TtsSettings api={api} />)
    await act(async () => { await Promise.resolve() })
    expect(container.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe('')
    await act(async () => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await Promise.resolve() })
    expect(save).toHaveBeenCalledWith({ endpoint: FISH_TTS_ENDPOINT, revision: 2, api_key: undefined })
  })
})
