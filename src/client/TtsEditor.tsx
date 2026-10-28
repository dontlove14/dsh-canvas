import { TtsParamsSchema, validateTtsText, type CanvasNode, type TtsParams } from '../shared/contracts'
import type { TaskSummary } from '../shared/v2'
import { useRef } from 'react'
import { EmotionTextArea, type EmotionEditorHandle } from './EmotionTextArea'
import { UiNumberCounter } from './UiNumberCounter'
import { UiButton, UiInput } from './ui'
import { TtsIcon } from './TtsIcon'

export function TtsEditor({ node, submitting, configured, configurationError = false, patchNode, generate, onError }: {
  node: CanvasNode; task?: TaskSummary; submitting: boolean
  configured: boolean | null; configurationError?: boolean
  patchNode: (id: string, fields: Partial<CanvasNode>) => void; generate: (node: CanvasNode) => Promise<void>
  onError?: (error: unknown) => void
}) {
  const editor = useRef<EmotionEditorHandle>(null)
  const params = TtsParamsSchema.parse(node.params)
  const disabled = submitting
  const patch = (fields: Partial<TtsParams>) => patchNode(node.id, { params: { ...params, ...fields } })
  const configurationReason = configurationError ? 'FishTTS 配置读取失败，请刷新页面重试'
    : configured === null ? '正在读取 FishTTS 配置…'
      : !configured ? '请前往设置页面配置模型' : ''
  let reason = configurationReason
  if (!reason) try { validateTtsText(node.prompt) } catch (error) { reason = (error as Error).message }
  return <>
    <div className="dc-tts-editor-heading"><TtsIcon size={22} /><strong>FishTTS</strong><span>文字转语音</span></div>
    {configurationReason && <p className="dc-tts-configuration dc-muted" role={configurationError ? 'alert' : 'status'}>{configurationReason}</p>}
    <label className="dc-tts-voice">音色 ID <small>reference_id</small><UiInput aria-label="音色 ID" value={params.reference_id}
      maxLength={512} placeholder="输入音色 ID（可选）" disabled={disabled} autoComplete="off" onChange={(event) => patch({ reference_id: event.target.value })} /></label>
    <div className="dc-tts-prosody">
      <label>语速 <small>speed</small><UiNumberCounter label="语速" value={params.speed} step={0.1} precision={2} min={0.1} disabled={disabled} onChange={(speed) => patch({ speed })} /></label>
      <label>音量 <small>volume</small><UiNumberCounter label="音量" value={params.volume} step={1} precision={2} disabled={disabled} onChange={(volume) => patch({ volume })} /></label>
    </div>
    <EmotionTextArea key={node.id} ref={editor} value={node.prompt} disabled={disabled} onError={onError} onChange={(prompt) => patchNode(node.id, { prompt })} />
    <div className="dc-tts-editor-bottom"><span className="dc-muted">{node.prompt.length.toLocaleString()} / 32,000</span>
      <UiButton variant="primary" className="dc-ui-generate" disabled={!!reason || disabled} title={reason || '生成语音'} aria-label="生成语音"
        onClick={() => { if (configured !== true || configurationError || disabled || reason) return; try { editor.current?.flush(); void generate(node) } catch (error) { onError?.(error) } }}>{disabled ? <span className="dc-spinner" /> : <TtsIcon size={18} />}生成语音</UiButton>
    </div>
  </>
}
