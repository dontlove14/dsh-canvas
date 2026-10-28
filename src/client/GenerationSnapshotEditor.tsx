import { useViewport } from '@xyflow/react'
import { isTtsSnapshot, type AnyTaskSnapshot } from '../shared/contracts'
import { providerFor } from '../shared/modelCatalog'
import type { CanvasApi } from './api'
import { SignedImage } from './SignedMedia'
import { nodeEditorPosition } from './nodeOverlayLayout'

/** Immutable task inputs: no graph, upload, parameter or submission callbacks. */
export function GenerationSnapshotEditor({ api, workspace, snapshot, error, anchor, restoring = false }: {
  api: CanvasApi; workspace: string; snapshot?: AnyTaskSnapshot; error?: string; restoring?: boolean
  anchor: { position: { x: number; y: number }; size: { width: number; height: number } }
}) {
  const viewport = useViewport()
  const tts = snapshot && isTtsSnapshot(snapshot)
  return <div className={`dc-editor dc-generation-editor dc-snapshot-editor nodrag nopan nowheel ${tts ? 'dc-tts-editor' : ''}`}
    style={nodeEditorPosition(anchor.position, viewport, anchor.size)} onKeyDown={(event) => event.stopPropagation()}
    role="region" aria-label={restoring ? '恢复最后一次提交' : '生成记录（只读）'}>
    <div className="dc-snapshot-heading"><strong>{restoring ? '最后一次提交' : '生成记录'}</strong>
      {!restoring && <small className="dc-muted">只读 · 收起堆叠后可编辑并生成</small>}</div>
    {error ? <p role="alert">{error}</p> : !snapshot ? <p role="status">正在读取生成记录…</p> : <>
      {!!snapshot.referenceIds.length && <div className="dc-reference-row">
        {snapshot.referenceIds.map((id, index) => <div className="dc-reference" key={id}>
          <SignedImage api={api} canvas={workspace} assetId={id} alt={`参考素材 ${index + 1}`} /><small>{index + 1}</small>
        </div>)}
      </div>}
      <div className="dc-snapshot-prompt" role="textbox" aria-label={tts ? '文字内容' : '提示词'} aria-readonly="true" contentEditable={false} tabIndex={0}>{snapshot.prompt}</div>
      <div className="dc-snapshot-model"><strong>{snapshot.model.name}</strong><small>{providerFor(snapshot.model)?.label ?? snapshot.model.model_id}</small></div>
      <dl className="dc-snapshot-params">
        {Object.entries(snapshot.params).filter(([key]) => key !== 'type').map(([key, value]) => <div key={key}>
          <dt>{{ size: '尺寸', n: '生成数量', seconds: '时长（秒）', background: '背景', quality: '画质',
            audio: '音频', reference_id: '音色 ID', speed: '语速', volume: '音量' }[key] ?? key}</dt><dd>{String(value)}</dd>
        </div>)}
      </dl>
    </>}
  </div>
}
