// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MentionPromptEditor } from '../src/client/MentionPromptEditor'
import { assetToken } from '../src/shared/promptMentions'
import { editorText, restoreEditorSelection } from '../src/client/promptEditorDom'
import type { PromptReference } from '../src/client/promptReferences'

const roots: Root[] = []
afterEach(() => {
  act(() => { for (const root of roots.splice(0)) root.unmount() })
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})
describe('shared prompt component', () => {
  it('renders a body portal and preserves insertion/undo through controlled parent echoes in both nodes', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    for (const placeholder of ['描述你想要生成的画面内容…', '描述镜头、动作、场景与氛围…']) {
      const container = document.createElement('div'); document.body.append(container)
      const root = createRoot(container); roots.push(root)
      const item: PromptReference = { assetId: crypto.randomUUID(), sourceId: crypto.randomUUID(), token: '', name: '湖面', label: '湖面', connected: false, kind: 'image' }
      item.token = assetToken(item.assetId)
      function Harness() {
        const [value, setValue] = useState('')
        const [references, setReferences] = useState<PromptReference[]>([])
        return <MentionPromptEditor value={value} placeholder={placeholder} disabled={false} references={references} candidates={[item]}
          preview={(id) => '/preview/' + id} onChange={setValue} onError={(e) => { throw e }}
          onChoose={(chosen, prompt) => {
            const linked = { ...chosen, connected: true, label: '参考图1' }
            setValue(prompt); setReferences([linked]); return linked
          }} />
      }
      act(() => root.render(<Harness />))
      const editor = container.querySelector<HTMLDivElement>('[role="textbox"]')!
      expect(editor.dataset.placeholder).toContain(placeholder)
      act(() => {
        editor.focus(); editor.textContent = '@湖'
        restoreEditorSelection(editor, { start: 2, end: 2 })
        editor.dispatchEvent(new InputEvent('input', { bubbles: true }))
      })
      const menu = document.body.querySelector('[data-prompt-suggestions]')!
      expect(menu).toBeTruthy(); expect(container.contains(menu)).toBe(false)
      act(() => { menu.querySelector<HTMLButtonElement>('[role="option"]')!.click() })
      expect(editorText(editor)).toBe(item.token + ' ')
      expect(editor.querySelector('.dc-prompt-token')?.textContent).toBe('@参考图1')
      expect(document.body.querySelector('[data-prompt-suggestions]')).toBeNull()
      act(() => { editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true })) })
      expect(editorText(editor)).toBe('@湖')
      act(() => root.unmount()); roots.pop(); container.remove()
    }
  })
})
