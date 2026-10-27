import { memo, useEffect, useRef, useState } from 'react'
import { useUpdateNodeInternals } from '@xyflow/react'
import { TaskStatusLabels, TRACKED_STATUSES, type Asset, type CanvasNode } from '../shared/contracts'
import type { TaskSummary } from '../shared/v2'
import { CanvasApi } from './api'
import { CanvasHandle } from './CanvasHandle'
import { NodeTitle } from './NodeTitle'
import { generationFrame } from './generationLayout'
import { UiButton } from './ui'
import { VideoPlayer } from './VideoPlayer'
import { useNodeActions } from './CanvasSelection'

export function GenerationGlyph({ video = false }: { video?: boolean }) {
  return <svg width="44" height="44" viewBox="0 0 48 48" fill="currentColor" aria-hidden="true">
    {video ? <path d="M8 10h23a3 3 0 0 1 3 3v5l10-6v24l-10-6v5a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V13a3 3 0 0 1 3-3z" />
      : <><circle cx="34" cy="12" r="4" /><path d="m3 39 15-24a2 2 0 0 1 3 0l9 15 5-7a2 2 0 0 1 3 0l8 16z" /></>}
  </svg>
}
export function ExpandGlyph({ collapse = false }: { collapse?: boolean }) {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {collapse ? <path d="M4 10h6V4m10 10h-6v6M10 10 3 3m11 11 7 7" /> : <path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" />}
  </svg>
}
export const GenerationNode = memo(function GenerationNode({ node, asset, results, task, selected, expanded, api, workspace, playing, onPlay, onStop, onRename, onResult, onExpand, onOpen, onSize }: {
  node: CanvasNode; asset?: Asset; results: Asset[]; task?: TaskSummary; selected: boolean; expanded: boolean; api: CanvasApi; workspace: string; playing: boolean
  onPlay: (id: string) => void; onStop: (id: string) => void; onRename: (id: string, title: string) => void
  onResult: (id: string, assetId: string) => void; onExpand: (id: string) => void; onOpen: (asset: Asset) => void
  onSize: (id: string, width: number, height: number) => void
}) {
  const [dimensions, setDimensions] = useState<{ id: string; width: number; height: number } | null>(null)
  const actionsVisible = useNodeActions(node.id, selected, true)
  const displayAsset = asset && dimensions?.id === asset.id ? { ...asset, width: dimensions.width, height: dimensions.height } : asset
  const size = generationFrame(displayAsset, results.length, expanded)
  const internals = useUpdateNodeInternals()
  const [playingAsset, setPlayingAsset] = useState<string | null>(null)
  useEffect(() => {
    onSize(node.id, size.width, size.height); internals(node.id)
  }, [node.id, size.width, size.height, expanded, asset?.id, results, onSize, internals])
  useEffect(() => { setPlayingAsset(null); onStop(node.id) }, [expanded, asset?.id, node.id, onStop])
  const busy = task && TRACKED_STATUSES.has(task.status)
  const shown = expanded ? results : asset ? [asset] : []
  return <article className={`dc-node dc-generation-node ${asset ? 'has-result' : ''} ${selected ? 'selected' : ''} ${expanded ? 'expanded' : ''} ${results.length > 1 && !expanded ? 'stacked' : ''}`}
    style={{ width: size.width, height: size.height }}>
    <NodeTitle node={node} onRename={onRename} />
    {(!expanded || !asset) && <><CanvasHandle type="target" /><CanvasHandle type="source" disabled={!asset} /></>}
    {results.length > 1 && !expanded && results.filter((item) => item.id !== asset?.id).slice(0, 2).reverse().map((item, index) =>
      <div key={item.id} className={`dc-result-layer ${index === 0 && results.length > 2 ? 'second' : 'first'}`}>
        <img src={api.preview(workspace, item.id)} alt="" draggable={false} loading="lazy" decoding="async" />
      </div>)}
    {!asset ? <div className="dc-generation-empty"><GenerationGlyph video={node.kind === 'video-generation'} /></div>
      : <div className="dc-generation-grid" style={{ gridTemplateColumns: `repeat(${size.columns}, ${size.cell.width}px)` }}>
        {shown.map((item, index) => <div key={item.id} className={`dc-generation-cell ${item.id === asset.id ? 'main' : ''}`} style={{ width: size.cell.width, height: size.cell.height }}>
          <ResultMedia asset={item} api={api} workspace={workspace} playing={playing && selected && (expanded ? playingAsset === item.id : true)}
            onPlay={() => { setPlayingAsset(item.id); onPlay(node.id) }} onStop={() => onStop(node.id)} onOpen={() => onOpen(item)}
            onDimensions={(width, height) => { if (item.id === asset.id) setDimensions((current) => current?.id === item.id && current.width === width && current.height === height ? current : { id: item.id, width, height }) }} />
          {expanded ? <>
            <span className="dc-result-index">{index + 1}{item.id === asset.id ? ' · 主图' : ''}</span>
            {actionsVisible && <div className="dc-group-actions nodrag nopan nowheel" onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
              <UiButton onClick={() => download(api, workspace, item)}>↓ 下载</UiButton>
              {item.id !== asset.id && <UiButton onClick={() => onResult(node.id, item.id)}>设为主图</UiButton>}
              {index === size.collapseIndex && <UiButton onClick={() => onExpand(node.id)}><ExpandGlyph collapse />收起</UiButton>}
            </div>}
            {item.id === asset.id && <><CanvasHandle type="target" /><CanvasHandle type="source" /></>}
          </> : actionsVisible && <div className="dc-group-actions nodrag nopan nowheel" onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
            {results.length === 1 && <UiButton title="下载原文件" aria-label="下载原文件" onClick={() => download(api, workspace, item)}>↓</UiButton>}
            {results.length === 1 && <UiButton title="查看原文件" aria-label="查看原文件" onClick={() => onOpen(item)}><ExpandGlyph /></UiButton>}
            {results.length > 1 && <UiButton title="展开生成结果" aria-label={`展开 ${results.length} 个生成结果`} onClick={() => onExpand(node.id)}>
              <ExpandGlyph /><span>{results.length}</span>
            </UiButton>}
          </div>}
        </div>)}
      </div>}
    {busy && <div className="dc-task-overlay" role="status"><span className="dc-spinner" />{TaskStatusLabels[task.status]}{task.progress !== undefined ? ` ${Math.round(task.progress)}%` : ''}</div>}
  </article>
})
function download(api: CanvasApi, workspace: string, asset: Asset) {
  const link = document.createElement('a'); link.href = api.media(workspace, asset.id, true); link.download = asset.filename; link.click()
}
function ResultMedia({ asset, api, workspace, playing, onPlay, onStop, onOpen, onDimensions }: { asset: Asset; api: CanvasApi; workspace: string; playing: boolean; onPlay: () => void; onStop: () => void; onOpen: () => void; onDimensions: (width: number, height: number) => void }) {
  const frame = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  const [missing, setMissing] = useState(false)
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { rootMargin: '160px' })
    if (frame.current) observer.observe(frame.current)
    return () => observer.disconnect()
  }, [])
  useEffect(() => { if (!visible && playing) onStop() }, [visible, playing, onStop])
  useEffect(() => {
    const hide = () => { if (document.hidden) onStop() }
    document.addEventListener('visibilitychange', hide)
    return () => document.removeEventListener('visibilitychange', hide)
  }, [onStop])
  return <div ref={frame} className="dc-generation-media" onClick={() => { if (asset.kind === 'video') onPlay() }}
    onDoubleClick={(event) => { if ((event.target as Element).closest('.dc-video-controls')) return; event.preventDefault(); event.stopPropagation(); onOpen() }}>
    {visible && (missing ? <div className="dc-missing">封面暂不可用</div> : <img src={api.preview(workspace, asset.id)} alt={asset.filename} draggable={false} loading="lazy" decoding="async" onError={() => setMissing(true)}
      onLoad={(event) => onDimensions(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight)} />)}
    {visible && playing && asset.kind === 'video' && <VideoPlayer key={asset.id} src={api.media(workspace, asset.id)} poster={api.preview(workspace, asset.id)} autoPlay label={`播放 ${asset.filename}`} />}
  </div>
}
