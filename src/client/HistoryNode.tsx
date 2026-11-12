import { memo, useEffect, useRef, useState } from 'react'
import { useUpdateNodeInternals } from '@xyflow/react'
import { TRACKED_STATUSES, TaskStatusLabels, isTtsParams, type Asset, type CanvasNode } from '../shared/contracts'
import { type CanvasApi } from './api'
import { type GenerationCard, type HistoryDimensions, historyFrame, resultHandle, submissionIdentity, EMPTY_HISTORY_DIMENSIONS } from './generationHistory'
import type { HistoryInspection } from './useHistoryInspection'
import { CanvasHandle } from './CanvasHandle'
import { NodeTitle } from './NodeTitle'
import { ExpandGlyph, GenerationGlyph, ResultMedia } from './GenerationNode'
import { AudioPlayer } from './AudioPlayer'
import { MediaIcon } from './MediaIcon'
import { SignedImage } from './SignedMedia'
import { NodeLoading, NodeLoadingBoundary, useNodeMediaLoading } from './NodeLoading'
import { useNodeActions } from './CanvasSelection'
import { UiButton } from './ui'
import { ReviewBadges, ReviewButton } from './ReviewControls'
import { observeVisibility } from './observeVisibility'

export const HistoryNode = memo(function HistoryNode({ node, cards, connectedAssets, selected, expanded, api, workspace, playing,
  onPlay, onStop, onRename, onExpand, onOpen, onSize, onInspect, inspection, dimensions, onDimensions }: {
  node: CanvasNode; cards: GenerationCard[]; connectedAssets: string[]; selected: boolean; expanded: boolean
  api: CanvasApi; workspace: string; playing: boolean; onPlay: (id: string) => void; onStop: (id: string) => void
  onRename: (id: string, title: string) => void; onExpand: (id: string) => void; onOpen: (asset: Asset) => void
  onSize: (id: string, width: number, height: number) => void
  onInspect?: (value: HistoryInspection) => void; inspection?: HistoryInspection
  dimensions?: HistoryDimensions
  onDimensions?: (nodeId: string, assetId: string, width: number, height: number) => void
}) {
  const audio = node.kind === 'tts-generation'
  const acceptsInput = !audio || isTtsParams(node.params) && !node.params.reference_id.trim()
  const [measured, setMeasured] = useState<HistoryDimensions>(EMPTY_HISTORY_DIMENSIONS)
  const displayDimensions = dimensions ?? measured
  const size = historyFrame(cards, audio, expanded, displayDimensions)
  const measure = (assetId: string, width: number, height: number) => {
    if (!(width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height))) return
    if (displayDimensions[assetId]?.width === width && displayDimensions[assetId]?.height === height) return
    if (onDimensions) onDimensions(node.id, assetId, width, height)
    else setMeasured((current) => ({ ...current, [assetId]: { width, height } }))
  }
  const shown = expanded ? cards : cards.slice(0, 1)
  const actionsVisible = useNodeActions(node.id, selected, true)
  const [playingAsset, setPlayingAsset] = useState<string | null>(null)
  const internals = useUpdateNodeInternals()
  const geometry = JSON.stringify([expanded, size, acceptsInput, expanded ? cards.map((card) => card.results.map((asset) => asset.id)) : connectedAssets])
  useEffect(() => { onSize(node.id, size.width, size.height); internals(node.id) },
    [node.id, size.width, size.height, geometry, onSize, internals])
  useEffect(() => { setPlayingAsset(null); onStop(node.id) }, [expanded, node.id, onStop])
  useEffect(() => {
    const hide = () => { if (document.hidden) onStop(node.id) }
    document.addEventListener('visibilitychange', hide)
    return () => { document.removeEventListener('visibilitychange', hide); onStop(node.id) }
  }, [node.id, onStop])
  return <article className={`dc-node dc-generation-node dc-history-node has-result ${selected ? 'selected' : ''} ${expanded ? 'expanded' : 'stacked'}`}
    style={{ width: size.width, height: size.height }}>
    <NodeTitle node={node} onRename={onRename} assetId={!expanded ? cards[0]?.results[0]?.id : undefined} />
    {acceptsInput && <CanvasHandle type="target" />}
    {!expanded && connectedAssets.map((id) => <CanvasHandle key={id} type="source" id={resultHandle(id)} disabled hidden />)}
    {!expanded && cards.slice(1, 3).reverse().map((card, index, layers) =>
      <div key={card.task.id} className={`dc-result-layer ${layers.length > 1 && index === 0 ? 'second' : 'first'}`}>
        {card.results[0] && !audio ? <SignedImage api={api} canvas={workspace} assetId={card.results[0].id} trackLoading={false} alt="" draggable={false} loading="lazy" decoding="async" />
          : <div className="dc-history-layer-rest"><MediaIcon kind={audio ? 'audio' : node.kind === 'video-generation' ? 'video' : 'image'} size={44} /></div>}
      </div>)}
    <div className="dc-history-list">
      {shown.map((card, index) => <NodeLoadingBoundary key={card.task.requestId ?? card.task.id}>
        <section className="dc-history-card" data-task-id={card.task.id} aria-label={`第 ${cards.length - index} 次提交`}
          style={{ width: size.frames[index].width, height: size.frames[index].height }}
          onClick={(event) => {
            if (event.shiftKey || event.metaKey || event.ctrlKey || !(event.target instanceof Element)
              || event.target.closest('button,a,input,[role="slider"],.react-flow__handle,.dc-group-actions')) return
            const assetId = event.target.closest<HTMLElement>('[data-asset-id]')?.dataset.assetId
            onInspect?.({ nodeId: node.id, identity: submissionIdentity(card.task), assetId })
          }}>
          <div className="dc-generation-grid" style={{ gridTemplateColumns: `repeat(${size.frames[index].columns}, ${size.frames[index].cell.width}px)` }}>
            {(expanded ? card.results : card.results.slice(0, 1)).map((asset, resultIndex) =>
              <div key={asset.id} className={`dc-generation-cell ${audio ? 'dc-history-audio' : ''}`} data-asset-id={asset.id}
                data-inspected={expanded && inspection?.identity === submissionIdentity(card.task) && (inspection.assetId === asset.id || (!inspection.assetId && resultIndex === 0)) ? 'true' : undefined}
                style={{ width: size.frames[index].cell.width, height: size.frames[index].cell.height }}>
                {audio ? <HistoryAudio asset={asset} api={api} workspace={workspace}
                  playing={playing && selected && playingAsset === asset.id} onPlay={() => { setPlayingAsset(asset.id); onPlay(node.id) }} onStop={() => onStop(node.id)} />
                  : <ResultMedia asset={asset} api={api} workspace={workspace} playing={playing && selected && playingAsset === asset.id}
                    onPlay={() => { setPlayingAsset(asset.id); onPlay(node.id) }} onStop={() => onStop(node.id)} onOpen={() => onOpen(asset)}
                    onDimensions={(width, height) => { if (asset.id === card.results[0]?.id) measure(asset.id, width, height) }} />}
                {expanded && <div className="dc-history-review-label nodrag nopan" onClick={(event) => event.stopPropagation()}>
                  <span title={asset.filename}>{asset.filename}</span><ReviewBadges assetId={asset.id} />
                </div>}
                {expanded && <CanvasHandle type="source" id={resultHandle(asset.id)} />}
                {actionsVisible && <div className="dc-group-actions nodrag nopan nowheel" onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
                  <ReviewButton asset={asset} />
                  <UiButton title="下载原文件" aria-label="下载原文件" onClick={() => {
                    const link = document.createElement('a'); link.href = api.media(workspace, asset.id, true); link.download = asset.filename; link.click()
                  }}>↓</UiButton>
                  {!expanded && <UiButton title="展开提交记录" aria-label={`展开 ${cards.length} 次提交`} onClick={() => onExpand(node.id)}><ExpandGlyph /><span>{cards.length}</span></UiButton>}
                  {expanded && index === shown.length - 1 && resultIndex === 0 && <UiButton onClick={() => onExpand(node.id)}><ExpandGlyph collapse />收起</UiButton>}
                </div>}
              </div>)}
          </div>
          {!card.results.length && <div className="dc-generation-empty dc-history-empty">
            {TRACKED_STATUSES.has(card.task.status) ? audio ? <MediaIcon kind="audio" size={44} /> : <GenerationGlyph video={node.kind === 'video-generation'} />
              : <><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v6m0 3h.01" /></svg>
                <span className="dc-sr-only" role="status">{TaskStatusLabels[card.task.status]}</span></>}
          </div>}
          <NodeLoading task={card.task} title={node.title} />
          {actionsVisible && !expanded && !card.results.length && <div className="dc-group-actions dc-history-toggle nodrag nopan nowheel">
            <UiButton title="展开提交记录" aria-label={`展开 ${cards.length} 次提交`} onClick={() => onExpand(node.id)}><ExpandGlyph /><span>{cards.length}</span></UiButton>
          </div>}
          {actionsVisible && expanded && !card.results.length && index === shown.length - 1 && <div className="dc-group-actions nodrag nopan nowheel">
            <UiButton onClick={() => onExpand(node.id)}><ExpandGlyph collapse />收起</UiButton>
          </div>}
        </section>
      </NodeLoadingBoundary>)}
    </div>
  </article>
})

function HistoryAudio({ asset, api, workspace, playing, onPlay, onStop }: {
  asset: Asset; api: CanvasApi; workspace: string; playing: boolean; onPlay: () => void; onStop: () => void
}) {
  const frame = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  useNodeMediaLoading(!visible)
  useEffect(() => observeVisibility(frame.current, setVisible, { rootMargin: '160px' }), [])
  useEffect(() => { if (!visible && playing) onStop() }, [visible, playing, onStop])
  return <div className="dc-history-audio-player" ref={frame}>
    {visible && <AudioPlayer asset={asset} api={api} workspace={workspace} label={asset.filename} active={playing} onPlay={onPlay} onStop={onStop} />}
  </div>
}
