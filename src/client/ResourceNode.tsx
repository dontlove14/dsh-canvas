import { memo, useEffect, useRef, useState } from 'react'
import { Position, NodeToolbar, useUpdateNodeInternals } from '@xyflow/react'
import type { Asset, CanvasNode } from '../shared/contracts'
import type { TaskSummary } from '../shared/v2'
import { CanvasApi } from './api'
import { UiButton } from './ui'
import { mediaFrame } from './mediaLayout'
import { VideoPlayer } from './VideoPlayer'
import { CanvasHandle } from './CanvasHandle'
import { NodeTitle } from './NodeTitle'
import { useNodeActions } from './CanvasSelection'
import { NODE_OVERLAY_STYLE } from './nodeOverlayLayout'
import { SignedImage } from './SignedMedia'
import { NodeLoading, NodeLoadingBoundary, useNodeMediaLoading } from './NodeLoading'
import { ReviewButton } from './ReviewControls'

function ActionIcon({ action }: { action: 'rotate' | 'download' | 'expand' }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {action === 'rotate' ? <><path d="M20 9a8 8 0 1 0 0 6M20 4v5h-5" /><path d="m8 10 5-2 2 5-5 2z" /></>
      : action === 'download' ? <><path d="M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4" /></>
        : <><path d="M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5" /><path d="m4 4 6 6m10-6-6 6M4 20l6-6m10 6-6-6" /></>}
  </svg>
}
export const ResourceNode = memo((props: Parameters<typeof ResourceNodeBody>[0]) =>
  <NodeLoadingBoundary><ResourceNodeBody {...props} /></NodeLoadingBoundary>)
function ResourceNodeBody({ node, asset, task, selected, api, workspace, rotation, playing, onRename, onRotate, onPlay, onStop, onOpen, onFocus, onSize }: {
  node: CanvasNode; asset: Asset; task?: TaskSummary; selected: boolean; api: CanvasApi; workspace: string
  rotation: number; playing: boolean
  onRename: (id: string, title: string) => void; onRotate: (id: string, assetId: string) => void
  onPlay: (id: string) => void; onStop: (id: string) => void; onOpen: (asset: Asset) => void; onSize: (id: string, width: number, height: number) => void
  onFocus: (id: string) => void
}) {
  const frameRef = useRef<HTMLDivElement>(null)
  const actionsVisible = useNodeActions(node.id, selected)
  const [visible, setVisible] = useState(false)
  const [missing, setMissing] = useState(false)
  useNodeMediaLoading(!visible && !missing)
  const [dimensions, setDimensions] = useState({ id: asset.id, width: asset.width ?? 16, height: asset.height ?? 9 })
  const updateInternals = useUpdateNodeInternals()
  const currentDimensions = dimensions.id === asset.id ? dimensions : { width: asset.width ?? 16, height: asset.height ?? 9 }
  const size = mediaFrame(currentDimensions.width, currentDimensions.height, rotation)
  const play = asset.kind === 'video' && playing && selected && visible
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting))
    if (frameRef.current) observer.observe(frameRef.current)
    return () => observer.disconnect()
  }, [])
  useEffect(() => { setMissing(false) }, [asset.id])
  useEffect(() => { if (!visible && playing) onStop(node.id) }, [visible, playing, node.id, onStop])
  useEffect(() => {
    const hide = () => { if (document.hidden) onStop(node.id) }
    document.addEventListener('visibilitychange', hide)
    return () => { document.removeEventListener('visibilitychange', hide); onStop(node.id) }
  }, [node.id, onStop])
  useEffect(() => {
    onSize(node.id, size.width, size.height)
    updateInternals(node.id)
  }, [node.id, size.width, size.height, onSize, updateInternals])
  return <article className={`dc-node dc-resource-node ${selected ? 'selected' : ''} ${node.kind}`} style={{ width: size.width, height: size.height }}>
    <NodeTitle node={node} onRename={onRename} assetId={asset.id} />
    <NodeToolbar position={Position.Top} align="end" offset={42} isVisible={actionsVisible} style={NODE_OVERLAY_STYLE}>
      <div className="dc-resource-toolbar nodrag nopan nowheel" role="toolbar" aria-label={asset.kind === 'image' ? '图片操作' : '视频操作'}>
        <ReviewButton asset={asset} />
        {asset.kind === 'image' && <UiButton title="顺时针旋转 90°" aria-label="顺时针旋转 90°" onClick={() => onRotate(node.id, asset.id)}><ActionIcon action="rotate" /></UiButton>}
        <UiButton title="下载原文件" aria-label="下载原文件" onClick={() => {
          const link = document.createElement('a'); link.href = api.media(workspace, asset.id, true); link.download = asset.filename; link.click()
        }}><ActionIcon action="download" /></UiButton>
        <UiButton title={asset.kind === 'image' ? '放大查看原图' : '放大查看原视频'} aria-label={asset.kind === 'image' ? '放大查看原图' : '放大查看原视频'} onClick={() => onOpen(asset)}><ActionIcon action="expand" /></UiButton>
      </div>
    </NodeToolbar>
    <div ref={frameRef} className="dc-resource-frame" onClick={() => { if (asset.kind === 'video') onPlay(node.id) }}
      onDoubleClickCapture={(event) => {
        // Handle resources before React Flow's native double-click zoom listener.
        if (event.target instanceof Element && event.target.closest('.dc-video-controls')) return
        event.preventDefault(); event.stopPropagation()
        onFocus(node.id)
      }}>
      {missing ? <div className="dc-missing">封面暂不可用<small>可通过顶部操作栏查看原文件</small></div>
        : visible && <SignedImage api={api} canvas={workspace} assetId={asset.id} alt={node.title} draggable={false} decoding="async"
          style={{ width: size.imageWidth, height: size.imageHeight, transform: `translate(-50%, -50%) rotate(${rotation}deg)` }}
          onLoad={(event) => setDimensions({ id: asset.id, width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
          onError={() => setMissing(true)} />}
      {play && <VideoPlayer key={asset.id} src={api.media(workspace, asset.id)} api={api} canvas={workspace} assetId={asset.id} autoPlay label={`循环播放 ${node.title}`} />}
    </div>
    <NodeLoading task={task} title={node.title} />
    <CanvasHandle type="source" />
  </article>
}
