import { useViewport, useStore } from '@xyflow/react'
import { isTtsSnapshot, type AnyTaskSnapshot, type Asset } from '../shared/contracts'
import { providerFor, SEEDANCE_VIDEO_MODES, isMultimodalVideo } from '../shared/modelCatalog'
import type { CanvasApi } from './api'
import { SignedImage } from './SignedMedia'
import { nodeEditorPosition } from './nodeOverlayLayout'
import { MediaIcon } from './MediaIcon'

/** Immutable task inputs: no graph, upload, parameter or submission callbacks. */
export function GenerationSnapshotEditor({ api, workspace, snapshot, assets = [], error, anchor, restoring = false, readOnly = false, onOpen }: {
  api: CanvasApi; workspace: string; snapshot?: AnyTaskSnapshot; error?: string; restoring?: boolean; readOnly?: boolean
  assets?: readonly Asset[]
  onOpen?: (asset: Asset) => void
  anchor: { position: { x: number; y: number }; size: { width: number; height: number } }
}) {
  const viewport = useViewport()
  const canvasWidth = useStore((state) => state.width)
  const canvasHeight = useStore((state) => state.height)
  const position = nodeEditorPosition(anchor.position, viewport, anchor.size)
  if (readOnly) {
    const width = Math.min(530, Math.max(240, (canvasWidth || 562) - 32))
    position.left += (530 - width) / 2; position.width = width
  }
  const tts = snapshot && isTtsSnapshot(snapshot)
  return <div className={`dc-editor dc-generation-editor dc-snapshot-editor nodrag nopan nowheel ${tts ? 'dc-tts-editor' : ''}`}
    style={{ ...position, ...(readOnly ? { maxHeight: Math.max(140, (canvasHeight || 700) - 290), overflow: 'auto' } : {}) }} onKeyDown={(event) => event.stopPropagation()}
    role="region" aria-label={restoring ? '恢复最后一次提交' : '生成记录（只读）'}>
    <div className="dc-snapshot-heading"><strong>{restoring ? '最后一次提交' : '生成记录'}</strong>
      {!restoring && <small className="dc-muted">{readOnly ? '只读 · 本次任务的提交输入' : '只读 · 收起堆叠后可编辑并生成'}</small>}</div>
    {error ? <p role="alert">{error}</p> : !snapshot ? <p role="status">正在读取生成记录…</p> : <>
      {!!snapshot.referenceIds.length && <div className="dc-reference-row">
        {snapshot.referenceIds.map((id, index) => <button className="dc-reference" key={id}
          aria-label={`查看引用 ${index + 1}`} disabled={!onOpen || !assets.some((asset) => asset.id === id)}
          onClick={() => { const asset = assets.find((asset) => asset.id === id); if (asset) onOpen?.(asset) }}>
          {assets.find((asset) => asset.id === id)?.kind && assets.find((asset) => asset.id === id)!.kind !== 'image'
            ? <span className="dc-reference-placeholder"><MediaIcon kind={assets.find((asset) => asset.id === id)!.kind} size={28} /></span>
            : <SignedImage api={api} canvas={workspace} assetId={id} alt={`参考素材 ${index + 1}`} />}
          <small className={isMultimodalVideo(snapshot.model) && !isTtsSnapshot(snapshot) && snapshot.params.videoMode === 'frames' ? 'dc-frame-label' : ''}>{
            isMultimodalVideo(snapshot.model) && !isTtsSnapshot(snapshot) && snapshot.params.videoMode === 'frames'
              ? snapshot.params.firstFrameId === id ? '首帧' : '尾帧' : index + 1}</small>
        </button>)}
      </div>}
      <div className="dc-snapshot-prompt" data-dc-text-selectable="true" role="textbox" aria-label={tts ? '文字内容' : '提示词'} aria-readonly="true" contentEditable={false} tabIndex={0}>{snapshot.prompt}</div>
      <div className="dc-snapshot-model"><strong>{snapshot.model.name}</strong><small>{providerFor(snapshot.model)?.label ?? snapshot.model.model_id}</small></div>
      <dl className="dc-snapshot-params">
        {Object.entries(snapshot.params).filter(([key]) => key !== 'type').map(([key, value]) => <div key={key}>
          <dt>{{ size: '尺寸', n: '生成数量', seconds: '时长（秒）', background: '背景', quality: '画质',
            videoMode: '生成模式', firstFrameId: '首帧', lastFrameId: '尾帧', generateAudio: '同步音频',
            audio: '音频', reference_id: '音色 ID', speed: '语速', volume: '音量' }[key] ?? key}</dt><dd data-dc-text-selectable="true">{
              key === 'videoMode' ? SEEDANCE_VIDEO_MODES.find((mode) => mode.value === value)?.label ?? String(value)
                : key === 'firstFrameId' || key === 'lastFrameId' ? `图片 ${snapshot.referenceIds.indexOf(String(value)) + 1}`
                  : typeof value === 'boolean' ? value ? '开启' : '关闭' : String(value)}</dd>
        </div>)}
      </dl>
    </>}
  </div>
}
