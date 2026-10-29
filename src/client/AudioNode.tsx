import { memo, useEffect, useRef, useState } from 'react'
import { NodeToolbar, Position, useUpdateNodeInternals } from '@xyflow/react'
import { type Asset, type CanvasNode } from '../shared/contracts'
import type { TaskSummary } from '../shared/v2'
import { TtsIcon } from './TtsIcon'
import { CanvasApi } from './api'
import { AudioPlayer } from './AudioPlayer'
import { CanvasHandle } from './CanvasHandle'
import { NodeTitle } from './NodeTitle'
import { UiButton } from './ui'
import { useNodeActions } from './CanvasSelection'
import { NODE_OVERLAY_STYLE } from './nodeOverlayLayout'
import { NodeLoading, NodeLoadingBoundary, useNodeMediaLoading } from './NodeLoading'
import { ReviewButton } from './ReviewControls'

export const AudioNode = memo((props: Parameters<typeof AudioNodeBody>[0]) =>
  <NodeLoadingBoundary><AudioNodeBody {...props} /></NodeLoadingBoundary>)
function AudioNodeBody({ node, asset, api, workspace, selected, playing, task, onPlay, onStop, onRename, onSize }: {
  node: CanvasNode; asset: Asset; api: CanvasApi; workspace: string; selected: boolean; playing: boolean
  onPlay: (id: string) => void; onStop: (id: string) => void
  onRename: (id: string, title: string) => void; onSize: (id: string, width: number, height: number) => void
  task?: TaskSummary
}) {
  const frame = useRef<HTMLElement>(null)
  const actionsVisible = useNodeActions(node.id, selected)
  const [visible, setVisible] = useState(false)
  useNodeMediaLoading(!visible)
  const updateInternals = useUpdateNodeInternals()
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { rootMargin: '160px' })
    if (frame.current) observer.observe(frame.current)
    return () => observer.disconnect()
  }, [])
  useEffect(() => { onSize(node.id, 360, 180); updateInternals(node.id) }, [node.id, onSize, updateInternals])
  useEffect(() => { if (!visible && playing) onStop(node.id) }, [visible, playing, node.id, onStop])
  useEffect(() => {
    const hide = () => { if (document.hidden) onStop(node.id) }
    document.addEventListener('visibilitychange', hide)
    return () => { document.removeEventListener('visibilitychange', hide); onStop(node.id) }
  }, [node.id, onStop])
  return <article ref={frame} className={`dc-node dc-audio-node ${node.kind === 'tts-generation' ? 'dc-tts-audio-node' : ''} ${selected ? 'selected' : ''}`}>
    <NodeTitle node={node} onRename={onRename} assetId={asset.id} />
    {node.kind === 'tts-generation' && <span className="dc-tts-audio-badge" title="FishTTS"><TtsIcon size={20} /></span>}
    <NodeToolbar position={Position.Top} align="end" offset={42} isVisible={actionsVisible} style={NODE_OVERLAY_STYLE}>
      <div className="dc-resource-toolbar nodrag nopan nowheel" role="toolbar" aria-label="音频操作">
        <ReviewButton asset={asset} />
        <UiButton title="下载原音频" aria-label="下载原音频" onClick={() => {
          const link = document.createElement('a'); link.href = api.media(workspace, asset.id, true); link.download = asset.filename; link.click()
        }}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4" /></svg></UiButton>
      </div>
    </NodeToolbar>
    {visible ? <AudioPlayer asset={asset} api={api} workspace={workspace} label={node.title} active={playing}
      onPlay={() => onPlay(node.id)} onStop={() => onStop(node.id)} /> : <div className="dc-audio-wave-message">音频</div>}
    <NodeLoading task={task} title={node.title} />
    <CanvasHandle type="source" />
  </article>
}
