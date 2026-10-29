// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { act, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ReactFlowProvider } from '@xyflow/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CanvasTextSelectionProvider } from '../src/client/canvasTextSelection'
import { HarnessUiProvider, UiActionMenu, UiInput, UiSelect } from '../src/client/ui'
import { harnessPrimitives } from './support/harnessPrimitives'
import { NodeTitle } from '../src/client/NodeTitle'
import { ModelPicker } from '../src/client/ModelPicker'
import { GenerationParameters } from '../src/client/GenerationParameters'
import { MentionPromptEditor } from '../src/client/MentionPromptEditor'
import { EmotionTextArea } from '../src/client/EmotionTextArea'
import { GenerationSnapshotEditor } from '../src/client/GenerationSnapshotEditor'
import { CanvasApi } from '../src/client/api'
import { capabilitiesFor, defaultParams, type CanvasNode, type PublicModel } from '../src/shared/contracts'
import { BUILTIN_MODELS } from '../src/shared/modelCatalog'
import { assetToken } from '../src/shared/promptMentions'
import { restoreEditorSelection } from '../src/client/promptEditorDom'

const roots: Root[] = []
let style: HTMLStyleElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  style = document.createElement('style')
  style.textContent = readFileSync('src/client/styles.css', 'utf8')
  document.head.append(style)
})
afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()))
  document.body.replaceChildren(); style.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
function mount(element: ReactNode, canvas = true, native = false) {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host); roots.push(root)
  const body = native ? <HarnessUiProvider components={harnessPrimitives}>{element}</HarnessUiProvider> : element
  act(() => root.render(canvas ? <CanvasTextSelectionProvider><div className="dc-canvas-area">{body}</div></CanvasTextSelectionProvider> : body))
  return { host, root }
}
const selection = (element: Element) => getComputedStyle(element).userSelect
const model: PublicModel = (() => {
  const record = BUILTIN_MODELS.find((item) => item.protocol === 'openai-image')!
  return { ...record, capabilities: capabilitiesFor(record), has_api_key: true, api_key_mask: '***', configurable: true }
})()
const node: CanvasNode = {
  id: crypto.randomUUID(), kind: 'image-generation', title: '原节点名称', prompt: '',
  modelId: model.id, params: defaultParams(model), position: { x: 0, y: 0 }, assetId: null, selectedResultId: null,
}

it('blocks all unmarked canvas text, including newly added descendants and native-control labels', () => {
  const { host } = mount(<article className="dc-node selected"><span>节点标题</span>
    <div className="dc-editor"><button data-dc-ui="native"><span>上传素材</span></button>
      <label>提示词标签</label><p>模型摘要</p><div className="future-component"><strong>新组件文字</strong></div>
    </div></article>)
  for (const element of host.querySelectorAll('.dc-canvas-area, .dc-canvas-area *')) expect(selection(element)).toBe('none')
  const added = document.createElement('small'); added.textContent = '稍后动态增加'
  host.querySelector('.future-component')!.append(added)
  expect(selection(added)).toBe('none')
})

it('allows input, textarea, editable descendants and explicit copy areas while keeping nearby labels blocked', () => {
  const { host } = mount(<><UiInput aria-label="音色 ID" /><textarea aria-label="补充输入" />
    <div contentEditable suppressContentEditableWarning><span>可编辑文字</span></div>
    <div contentEditable="plaintext-only" suppressContentEditableWarning><b>纯文本</b></div>
    <div contentEditable={false}><span>普通只读内容</span></div>
    <div data-dc-text-selectable="true"><span><code>明确允许复制</code></span></div><label>旁边的标签</label></>)
  for (const element of host.querySelectorAll('input,textarea,[contenteditable="true"],[contenteditable="true"] *,[contenteditable="plaintext-only"],[contenteditable="plaintext-only"] *,[data-dc-text-selectable="true"],[data-dc-text-selectable="true"] *'))
    expect(selection(element)).toBe('text')
  expect(selection(host.querySelector('[contenteditable="false"] span')!)).toBe('none')
  expect(selection(host.querySelector('label')!)).toBe('none')
})

it.each([false, true])('retains name auto-selection, Enter commit and Escape cancellation with native=%s', (native) => {
  const renamed = vi.fn()
  const { host } = mount(<NodeTitle node={node} onRename={renamed} />, true, native)
  const title = () => host.querySelector('.dc-resource-title span')!
  expect(selection(title())).toBe('none')
  act(() => title().dispatchEvent(new MouseEvent('dblclick', { bubbles: true })))
  let input = host.querySelector<HTMLInputElement>('input')!
  expect(input).toBe(document.activeElement); expect(selection(input)).toBe('text')
  expect([input.selectionStart, input.selectionEnd]).toEqual([0, node.title.length])
  const enter = (value: string) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    act(() => input.dispatchEvent(new Event('input', { bubbles: true })))
  }
  enter(' 新名称 ')
  act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  expect(renamed).toHaveBeenCalledExactlyOnceWith(node.id, '新名称')
  act(() => title().dispatchEvent(new MouseEvent('dblclick', { bubbles: true })))
  input = host.querySelector<HTMLInputElement>('input')!
  enter('取消这个草稿')
  act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(host.querySelector('input')).toBeNull(); expect(renamed).toHaveBeenCalledTimes(1)
})

it.each([true, false])('scopes public Menu portals only when their caller belongs to canvas=%s', (canvas) => {
  const selected = vi.fn()
  const { host } = mount(<><UiSelect value="one" label="模式" options={[{ value: 'one', label: '模式一' }]} onChange={selected} />
    <UiActionMenu label="添加节点" items={[{ id: 'add', label: '图片生成', onSelect: selected }]} /></>, canvas, true)
  for (const label of ['模式：模式一', '添加节点']) {
    act(() => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click())
    const menu = document.querySelector('[role="menu"]')!
    expect(host.contains(menu)).toBe(false)
    expect(menu.classList.contains('dc-canvas-text-scope')).toBe(canvas)
    expect(selection(menu.querySelector('button')!)).toBe(canvas ? 'none' : '')
    act(() => menu.querySelector<HTMLButtonElement>('button')!.click())
    expect(document.querySelector('[role="menu"]')).toBeNull()
  }
  expect(selected).toHaveBeenCalledTimes(2)
})

it.each([true, false])('scopes model and parameter portals only for canvas=%s without changing their actions', (canvas) => {
  const change = vi.fn()
  const { host } = mount(<><ModelPicker models={[model]} value={model.id} disabled={false} onChange={change} />
    <GenerationParameters model={model} params={defaultParams(model)} disabled={false} onChange={change} /></>, canvas)
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="生成模型"]')!.click())
  const picker = document.querySelector('.dc-model-picker')!
  expect(host.contains(picker)).toBe(false); expect(picker.classList.contains('dc-canvas-text-scope')).toBe(canvas)
  expect(selection(picker.querySelector('legend')!)).toBe(canvas ? 'none' : '')
  act(() => picker.querySelector<HTMLButtonElement>('button')!.click())
  expect(change).toHaveBeenCalledWith(model)
  act(() => host.querySelector<HTMLButtonElement>('.dc-params-trigger')!.click())
  const params = document.querySelector('.dc-generation-params')!
  expect(host.contains(params)).toBe(false); expect(params.classList.contains('dc-canvas-text-scope')).toBe(canvas)
  expect(selection(params.querySelector('legend')!)).toBe(canvas ? 'none' : '')
  act(() => params.querySelector<HTMLButtonElement>('button')!.click())
  expect(change).toHaveBeenCalledTimes(2)
})

it.each(['prompt', 'tts'] as const)('keeps %s text copyable when busy, atomic tokens selectable, and body suggestions blocked', (kind) => {
  const item = { assetId: crypto.randomUUID(), sourceId: crypto.randomUUID(), token: '', name: '湖面', label: '参考图1', connected: true, kind: 'image' as const }
  item.token = assetToken(item.assetId)
  const component = (value: string, disabled: boolean, onChange = (_value: string) => {}) => kind === 'tts'
    ? <EmotionTextArea value={value} disabled={disabled} onChange={onChange} />
    : <MentionPromptEditor value={value} disabled={disabled} placeholder="输入提示词" references={[item]} candidates={[item]}
      preview={() => '/offline-preview'} onChange={onChange} onChoose={(chosen) => chosen} onError={(error) => { throw error }} />
  const { host, root } = mount(component(kind === 'tts' ? '(happy) 你好' : item.token + ' 湖面', true))
  let editor = host.querySelector<HTMLElement>('[role="textbox"]')!
  expect(editor.getAttribute('contenteditable')).toBe('false')
  expect(selection(editor)).toBe('text')
  expect(selection(editor.querySelector('.dc-prompt-token')!)).toBe('all')
  function Editable() {
    const [value, setValue] = useState('')
    return component(value, false, setValue)
  }
  act(() => root.render(<CanvasTextSelectionProvider><div className="dc-canvas-area"><Editable /></div></CanvasTextSelectionProvider>))
  editor = host.querySelector<HTMLElement>('[role="textbox"]')!
  act(() => {
    editor.focus(); editor.textContent = '@'
    restoreEditorSelection(editor, { start: 1, end: 1 })
    editor.dispatchEvent(new InputEvent('input', { bubbles: true }))
  })
  const menu = document.querySelector('[data-prompt-suggestions]')!
  expect(host.contains(menu)).toBe(false); expect(menu.classList.contains('dc-canvas-text-scope')).toBe(true)
  expect(selection(menu.querySelector('strong')!)).toBe('none')
  expect(selection(editor)).toBe('text')
})

it('retains explicit copy access to readonly historical prompts and values, with headings blocked', () => {
  const snapshot = {
    model, prompt: '历史提示词', params: defaultParams(model), referenceIds: [],
  }
  const { host } = mount(<ReactFlowProvider><GenerationSnapshotEditor api={new CanvasApi()} workspace={crypto.randomUUID()}
    snapshot={snapshot} anchor={{ position: { x: 0, y: 0 }, size: { width: 320, height: 180 } }} /></ReactFlowProvider>)
  expect(selection(host.querySelector('.dc-snapshot-prompt')!)).toBe('text')
  for (const value of host.querySelectorAll('dd')) expect(selection(value)).toBe('text')
  for (const label of host.querySelectorAll('dt,.dc-snapshot-heading strong,.dc-snapshot-model strong')) expect(selection(label)).toBe('none')
  expect(host.querySelector('.dc-snapshot-prompt')!.getAttribute('contenteditable')).toBe('false')
})
