import { forwardRef, memo, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { PromptEditorController, type PromptSuggestions } from './promptEditorController'
import type { PromptReference } from './promptReferences'
import { useCanvasTextSelectionScope } from './canvasTextSelection'

export interface MentionPromptEditorHandle { flush: () => string }
interface Props {
  value: string; placeholder: string; disabled: boolean
  references: readonly PromptReference[]; candidates: readonly PromptReference[]
  preview: (id: string) => string
  onChange: (value: string) => void
  onChoose: (item: PromptReference, value: string) => PromptReference
  onError: (error: unknown) => void
}
export const MentionPromptEditor = memo(forwardRef<MentionPromptEditorHandle, Props>(function MentionPromptEditor(props, ref) {
  const textScope = useCanvasTextSelectionScope()
  const root = useRef<HTMLDivElement>(null)
  const controller = useRef<PromptEditorController | null>(null)
  const [suggestions, setSuggestions] = useState<PromptSuggestions | null>(null)
  const menu = useRef<HTMLDivElement>(null)
  useImperativeHandle(ref, () => ({ flush: () => controller.current?.flush() ?? props.value }), [props.value])
  useLayoutEffect(() => {
    const instance = new PromptEditorController(root.current!, { ...props, onSuggestions: setSuggestions })
    controller.current = instance
    return () => { instance.destroy(); controller.current = null }
  }, [])
  useLayoutEffect(() => { controller.current?.update({ ...props, onSuggestions: setSuggestions }) })
  useLayoutEffect(() => { menu.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' }) }, [suggestions?.active])
  const listId = 'dc-prompt-suggestions'
  return <div className="dc-prompt-wrap nodrag nopan nowheel">
    <div ref={root} className="dc-prompt-editor" data-dc-text-selectable="true" role="textbox" aria-label="提示词" aria-multiline="true" aria-disabled={props.disabled}
      aria-autocomplete="list" aria-controls={suggestions ? listId : undefined} aria-expanded={!!suggestions}
      aria-activedescendant={suggestions?.items.length ? `${listId}-${suggestions.active}` : undefined}
      data-placeholder={`${props.placeholder} 输入 @ 引用参考图`} data-empty={!props.value} tabIndex={props.disabled ? -1 : 0}
      suppressContentEditableWarning />
    {suggestions && createPortal(<div className={`dc-app dc-prompt-suggestions nodrag nopan nowheel ${textScope}`} data-prompt-suggestions ref={menu}
      style={{ left: suggestions.left, top: suggestions.top }} onPointerDown={(event) => event.preventDefault()} onKeyDown={(event) => event.stopPropagation()}>
      <div className="dc-prompt-suggestions-heading">引用参考素材 <small>↑↓ 选择 · Enter 确认</small></div>
      <div id={listId} role="listbox" aria-label="参考素材">
        {suggestions.items.map((item, index) => <button type="button" role="option" id={`${listId}-${index}`} aria-selected={index === suggestions.active}
          key={item.assetId} onClick={() => controller.current?.choose(item)}>
          <span className="dc-prompt-suggestion-preview"><img src={props.preview(item.assetId)} alt="" draggable={false} onError={(event) => { event.currentTarget.hidden = true }} /></span>
          <span><strong>{item.name}</strong><small>{item.connected ? `已连接 · ${item.label}` : '当前画布 · 选择后连接'}</small></span>
          {item.connected && <span className="dc-prompt-connected">✓</span>}
        </button>)}
        {!suggestions.items.length && <p className="dc-prompt-no-results">没有可用素材，可先上传或调整搜索词</p>}
      </div>
    </div>, document.body)}
  </div>
}))
