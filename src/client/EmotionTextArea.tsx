import { forwardRef, useId, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { PromptEditorController, type PromptSuggestions } from './promptEditorController'
import { emotionEditorCodec, EMOTION_CHOICES, type EmotionChoice } from './emotionEditorCodec'

export interface EmotionEditorHandle { flush: () => string }
interface Props { value: string; onChange: (text: string) => void; disabled?: boolean; onError?: (error: unknown) => void }
export const EmotionTextArea = forwardRef<EmotionEditorHandle, Props>(function EmotionTextArea({ value, onChange, disabled = false, onError }, ref) {
  const root = useRef<HTMLDivElement>(null)
  const controller = useRef<PromptEditorController<EmotionChoice> | null>(null)
  const menu = useRef<HTMLDivElement>(null)
  const [suggestions, setSuggestions] = useState<PromptSuggestions<EmotionChoice> | null>(null)
  const [error, setError] = useState('')
  const id = useId()
  const options = {
    value, disabled, references: EMOTION_CHOICES, candidates: EMOTION_CHOICES, preview: () => '',
    codec: emotionEditorCodec, onSuggestions: setSuggestions,
    onChange: (text: string) => { setError(''); onChange(text) },
    onChoose: (item: EmotionChoice, text: string) => { setError(''); onChange(text); return item },
    onError: (error: unknown) => { setError(error instanceof Error ? error.message : '输入无效'); onError?.(error) },
  }
  useImperativeHandle(ref, () => ({ flush: () => controller.current?.flush() ?? value }), [value])
  useLayoutEffect(() => {
    const instance = new PromptEditorController(root.current!, options)
    controller.current = instance
    return () => { instance.destroy(); controller.current = null }
  }, [])
  useLayoutEffect(() => { controller.current?.update(options) })
  useLayoutEffect(() => { menu.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' }) }, [suggestions?.active])
  return <div className="dc-tts-text dc-prompt-wrap nodrag nopan nowheel">
    <div ref={root} className="dc-prompt-editor dc-tts-textarea" role="textbox" aria-label="文字内容" aria-multiline="true"
      aria-disabled={disabled} aria-autocomplete="list" aria-controls={suggestions ? `${id}-list` : undefined}
      aria-expanded={!!suggestions} aria-activedescendant={suggestions?.items.length ? `${id}-${suggestions.active}` : undefined}
      data-placeholder="输入要朗读的文字，输入 @ 选择情绪…" data-empty={!value} tabIndex={disabled ? -1 : 0} suppressContentEditableWarning />
    {suggestions && createPortal(<div className="dc-app dc-prompt-suggestions dc-tts-emotions nodrag nopan nowheel" data-prompt-suggestions ref={menu}
      style={{ left: suggestions.left, top: suggestions.top }} onPointerDown={(event) => event.preventDefault()} onKeyDown={(event) => event.stopPropagation()}>
      <div className="dc-prompt-suggestions-heading">选择情绪 <small>↑↓ 选择 · Enter 确认</small></div>
      <div id={`${id}-list`} role="listbox" aria-label="FishTTS 情绪">
        {suggestions.items.map((item, index) => <button type="button" id={`${id}-${index}`} role="option" aria-selected={suggestions.active === index}
          key={item.tag} onClick={() => controller.current?.choose(item)}>
          <span><small>{item.group}</small><strong>{item.label}</strong></span><code>{item.token}</code>
        </button>)}
        {!suggestions.items.length && <p className="dc-prompt-no-results">没有匹配的情绪</p>}
      </div>
    </div>, document.body)}
    {error && <small className="dc-validation" role="alert">{error}</small>}
    <small className="dc-muted dc-tts-help">情绪标签放在句首，可叠加；笑声、停顿可放在文字中。</small>
  </div>
})
