import { TtsParamsSchema, validateTtsText, TRACKED_STATUSES, TaskStatusLabels, type CanvasNode, type TtsParams } from '../shared/contracts'
import type { TaskSummary } from '../shared/v2'
import { useRef } from 'react'
import { EmotionTextArea, type EmotionEditorHandle } from './EmotionTextArea'
import { UiNumberCounter } from './UiNumberCounter'
import { UiButton, UiInput } from './ui'
import { TtsIcon } from './TtsIcon'

export function TtsEditor({ node, task, submitting, patchNode, generate, onError }: {
  node: CanvasNode; task?: TaskSummary; submitting: boolean
  patchNode: (id: string, fields: Partial<CanvasNode>) => void; generate: (node: CanvasNode) => Promise<void>
  onError?: (error: unknown) => void
}) {
  const editor = useRef<EmotionEditorHandle>(null)
  const params = TtsParamsSchema.parse(node.params)
  const locked = !!task && TRACKED_STATUSES.has(task.status)
  const disabled = locked || submitting
  const patch = (fields: Partial<TtsParams>) => patchNode(node.id, { params: { ...params, ...fields } })
  let reason = ''
  try { validateTtsText(node.prompt) } catch (error) { reason = (error as Error).message }
  return <>
    <div className="dc-tts-editor-heading"><TtsIcon size={22} /><strong>FishTTS</strong><span>文字转语音</span></div>
    <label className="dc-tts-voice">音色 ID <small>reference_id</small><UiInput aria-label="音色 ID" value={params.reference_id}
      maxLength={512} placeholder="输入音色 ID（可选）" disabled={disabled} autoComplete="off" onChange={(event) => patch({ reference_id: event.target.value })} /></label>
    <div className="dc-tts-prosody">
      <label>语速 <small>speed</small><UiNumberCounter label="语速" value={params.speed} step={0.1} precision={2} min={0.1} disabled={disabled} onChange={(speed) => patch({ speed })} /></label>
      <label>音量 <small>volume</small><UiNumberCounter label="音量" value={params.volume} step={1} precision={2} disabled={disabled} onChange={(volume) => patch({ volume })} /></label>
    </div>
    <EmotionTextArea key={node.id} ref={editor} value={node.prompt} disabled={disabled} onError={onError} onChange={(prompt) => patchNode(node.id, { prompt })} />
    <div className="dc-tts-editor-bottom"><span className="dc-muted">{node.prompt.length.toLocaleString()} / 32,000</span>
      <UiButton variant="primary" className="dc-ui-generate" disabled={!!reason || disabled} title={reason || '生成语音'} aria-label={locked ? TaskStatusLabels[task!.status] : '生成语音'}
        onClick={() => { try { editor.current?.flush(); void generate(node) } catch (error) { onError?.(error) } }}>{disabled ? <span className="dc-spinner" /> : <TtsIcon size={18} />}{locked ? TaskStatusLabels[task!.status] : '生成语音'}</UiButton>
    </div>
  </>
}
