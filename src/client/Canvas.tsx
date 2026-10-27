import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ReactFlow, ReactFlowProvider, Background, BackgroundVariant, Controls, MiniMap,
  useReactFlow, useViewport, ConnectionLineType, SelectionMode, type Node, type NodeProps, type NodeChange, type Connection,
} from '@xyflow/react'
import {
  NodeLabels, defaultParams, isGeneration, nodeMediaKind, nodeResults, latestTask,
  TaskStatusLabels, TRACKED_STATUSES, validateGraph, defaultTtsParams, isTtsParams,
  type CanvasNode, type CanvasGraph, type NodeKind, type Asset, type PublicModel, type MediaKind, type TaskAction,
} from '../shared/contracts'
import { type CanvasChoice, type TaskSummary, type TaskDetail, type StorageSettings } from '../shared/v2'
import { CanvasApi } from './api'
import { useCanvas } from './useCanvas'
import { useGpuCapability } from './useGpu'
import { useViewportCompositing } from './useViewportCompositing'
import { ModelSettings } from './Settings'
import { MediaIcon } from './MediaIcon'
import { ProjectList } from './ProjectList'
import { ResourceNode } from './ResourceNode'
import { UiActionMenu, UiButton, UiInput, UiModal as Modal, UiMediaModal, UiSelect } from './ui'
import { canvasScrollGestures } from './gestures'
import { VideoPlayer } from './VideoPlayer'
import { MOCK_MODELS, mockRecord, validateMockGeneration } from '../shared/mockModels'
import { GenerationNode } from './GenerationNode'
import { GenerationParameters } from './GenerationParameters'
import { CanvasHandle } from './CanvasHandle'
import { connectionAsset, generationFrame, nodeEditorVisible } from './generationLayout'
import { mediaFrame } from './mediaLayout'
import { CanvasSelectionContext } from './CanvasSelection'
import { useMarqueeSelection } from './useMarqueeSelection'
import { MentionPromptEditor, type MentionPromptEditorHandle } from './MentionPromptEditor'
import { connectedPromptReferences, promptCandidates, insertPromptReference } from './promptReferences'
import { AudioNode } from './AudioNode'
import { AudioPlayer } from './AudioPlayer'
import { TtsNode } from './TtsNode'
import { TtsEditor } from './TtsEditor'
import { TtsIcon } from './TtsIcon'
import { TaskDialog } from './TaskDialog'
import { RelationshipEdge, relationshipEdges, type RelationshipFlowEdge } from './RelationshipEdge'

export function CanvasApp({ api, active = true }: { api: CanvasApi; active?: boolean }) {
  const [workspace, setWorkspace] = useState<CanvasChoice | null>(null)
  const [folder, setFolder] = useState('all')
  return <div className="dc-app dc-canvas-host">
    {workspace
      ? <ReactFlowProvider key={workspace.id}><CanvasWorkspace api={api} active={active} workspace={workspace.id} title={workspace.name} onBack={() => setWorkspace(null)} /></ReactFlowProvider>
      : <ProjectList api={api} active={active} folder={folder} onFolder={setFolder} onOpen={setWorkspace} />}
  </div>
}

interface MediaProps { asset: Asset; api: CanvasApi; workspace: string; onOpen?: (asset: Asset) => void; compact?: boolean }
const Media = memo(function Media({ asset, api, workspace, onOpen, compact }: MediaProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  const [missing, setMissing] = useState(false)
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { rootMargin: '160px' })
    if (ref.current) observer.observe(ref.current)
    return () => observer.disconnect()
  }, [])
  useEffect(() => { setMissing(false) }, [asset.id])
  return <div className={`dc-media ${asset.kind} nodrag nopan ${compact ? 'compact' : ''}`} ref={ref}>
    {missing ? <div className="dc-missing">本地文件不可用<br /><small>可重新导入或恢复原结果</small></div>
      : visible ? asset.kind === 'image'
        ? <button className="dc-image-button" aria-label="查看大图" onClick={() => onOpen?.(asset)}><img src={api.media(workspace, asset.id)} alt={asset.filename} loading="lazy" draggable={false} onError={() => setMissing(true)} /></button>
        : asset.kind === 'video'
          ? <VideoPlayer src={api.media(workspace, asset.id)} label={asset.filename} />
          : <AudioPlayer asset={asset} api={api} workspace={workspace} label={asset.filename} />
      : <div className="dc-media-rest"><MediaIcon kind={asset.kind} size={54} /></div>}
  </div>
})
interface NodeData extends Record<string, unknown> {
  node: CanvasNode; asset?: Asset; task?: TaskSummary; results: Asset[]; modelName?: string
  api: CanvasApi; workspace: string; onOpen: (asset: Asset) => void; onResult: (id: string, assetId: string) => void
  rotation: number; playing: boolean; onRename: (id: string, title: string) => void
  onFocus: (id: string) => void
  expanded: boolean; onExpand: (id: string) => void
  onRotate: (id: string, assetId: string) => void; onPlay: (id: string) => void; onStop: (id: string) => void; onSize: (id: string, width: number, height: number) => void
}
type FlowNode = Node<NodeData, 'media'>
const MediaNode = memo(function MediaNode({ data, selected }: NodeProps<FlowNode>) {
  const { node, asset, task, results, api, workspace, onOpen, onResult } = data
  const generation = isGeneration(node.kind)
  const busy = task && TRACKED_STATUSES.has(task.status)
  if (node.kind === 'tts-generation' && !asset) return <TtsNode node={node} task={task} selected={!!selected} onRename={data.onRename} onSize={data.onSize} />
  if (generation && node.kind !== 'tts-generation') return <GenerationNode node={node} asset={asset} results={results} task={task} selected={!!selected} api={api} workspace={workspace}
    expanded={data.expanded} playing={data.playing} onRename={data.onRename} onResult={onResult} onExpand={data.onExpand}
    onPlay={data.onPlay} onStop={data.onStop} onOpen={onOpen} onSize={data.onSize} />
  if (asset?.kind === 'audio') return <AudioNode node={node} asset={asset} selected={!!selected} api={api} workspace={workspace}
    task={node.kind === 'tts-generation' ? task : undefined} playing={data.playing} onPlay={data.onPlay} onStop={data.onStop} onRename={data.onRename} onSize={data.onSize} />
  if (asset) return <ResourceNode node={node} asset={asset} selected={!!selected}
    api={api} workspace={workspace} rotation={data.rotation} playing={data.playing}
    onOpen={onOpen} onRename={data.onRename} onRotate={data.onRotate} onPlay={data.onPlay} onStop={data.onStop} onFocus={data.onFocus} onSize={data.onSize} />
  return <article className={`dc-node ${selected ? 'selected' : ''} ${node.kind}`}>
    <div className="dc-node-heading"><MediaIcon kind={nodeMediaKind(node.kind)} className="dc-node-icon" /><strong>{node.title}</strong><span className="dc-node-kind">资源</span></div>
    <div className="dc-node-empty"><MediaIcon kind={nodeMediaKind(node.kind)} size={64} /><strong>导入本地素材</strong><small>选中节点后上传文件</small></div>
    {busy && <div className="dc-task-overlay"><span className="dc-spinner" /><span>{TaskStatusLabels[task.status]}{typeof task.progress === 'number' ? ` ${Math.round(task.progress)}%` : ''}</span></div>}
    <div className="dc-node-foot"><span>{NodeLabels[node.kind]}</span>
      {task && <span className={`dc-status ${task.status}`}>{TaskStatusLabels[task.status]}</span>}
    </div>
    <CanvasHandle type="source" disabled />
  </article>
})
const nodeTypes = { media: MediaNode }
const edgeTypes = { relationship: RelationshipEdge }
const edgeOptions = { type: 'relationship', style: { stroke: 'var(--dc-edge)', strokeWidth: 1.7 } }
function formatBytes(bytes: number): string { return bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB` }
function downloadJson(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
  const link = document.createElement('a'); link.href = url; link.download = name; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function CanvasWorkspace({ api, workspace, title, onBack, active = true }: { api: CanvasApi; workspace: string; title: string; onBack: () => void; active?: boolean }) {
  const canvas = useCanvas(api, workspace, active)
  const gpu = useGpuCapability()
  const { graph, state, edit, report } = canvas
  const models = MOCK_MODELS
  const [selected, setSelected] = useState<string[]>([])
  const [selectedEdges, setSelectedEdges] = useState<string[]>([])
  const selectMarquee = useCallback((value: { nodes: string[]; edges: string[] }) => {
    setSelected(value.nodes); setSelectedEdges(value.edges)
  }, [])
  const marquee = useMarqueeSelection(selected, selectedEdges, selectMarquee)
  const [pageVisible, setPageVisible] = useState(() => document.visibilityState !== 'hidden')
  useEffect(() => {
    const visibility = () => setPageVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', visibility)
    return () => document.removeEventListener('visibilitychange', visibility)
  }, [])
  const [playingNode, setPlayingNode] = useState<string | null>(null)
  const [rotations, setRotations] = useState<Record<string, { assetId: string; angle: number }>>({})
  const [mediaSizes, setMediaSizes] = useState<Record<string, { width: number; height: number; layoutKey: string }>>({})
  const mediaSizeKeys = useRef<Record<string, string>>({})
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({})
  const [panning, setPanning] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [preview, setPreview] = useState<Asset | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [showTasks, setShowTasks] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const container = useRef<HTMLDivElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const importIntent = useRef<{ kind: MediaKind; target?: string } | null>(null)
  const flow = useReactFlow<FlowNode, RelationshipFlowEdge>()
  useViewportCompositing(container, gpu.enabled && active)
  const loadModels = useCallback(() => {}, [])
  useEffect(() => {
    if (!active) {
      marquee.cancel()
      setPlayingNode(null); setPanning(false); setPreview(null); setShowSettings(false); setShowTasks(false)
      return
    }
    const down = (event: KeyboardEvent) => {
      if (event.code === 'Space' && event.target instanceof globalThis.Node && container.current?.contains(event.target)
        && !(event.target instanceof HTMLElement && event.target.closest('input,textarea,select,button,a,[contenteditable="true"],[role="textbox"]'))) { event.preventDefault(); setPanning(true) }
    }
    const up = (event: KeyboardEvent) => { if (event.code === 'Space') setPanning(false) }
    const blur = () => setPanning(false)
    window.addEventListener('keydown', down); window.addEventListener('keyup', up); window.addEventListener('blur', blur)
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', blur) }
  }, [active, marquee.cancel])
  const activeNode = selected.length === 1 ? graph.nodes.find((node) => node.id === selected[0]) : undefined
  const patchNode = useCallback((id: string, fields: Partial<CanvasNode>) => {
    edit((current) => ({ ...current, nodes: current.nodes.map((node) => node.id === id ? { ...node, ...fields } : node) }))
  }, [edit])
  const onResult = useCallback((id: string, assetId: string) => { setPlayingNode(null); patchNode(id, { selectedResultId: assetId }) }, [patchNode])
  const onExpand = useCallback((id: string) => { setPlayingNode(null); setExpandedGroups((current) => ({ ...current, [id]: !current[id] })) }, [])
  const onRename = useCallback((id: string, title: string) => patchNode(id, { title }), [patchNode])
  const onRotate = useCallback((id: string, assetId: string) => setRotations((current) => ({
    ...current, [id]: { assetId, angle: ((current[id]?.assetId === assetId ? current[id].angle : 0) + 90) % 360 },
  })), [])
  const onPlay = useCallback((id: string) => {
    setSelected([id]); setSelectedEdges([]); setPlayingNode(id)
  }, [])
  const onStop = useCallback((id: string) => setPlayingNode((current) => current === id ? null : current), [])
  const onOpen = useCallback((asset: Asset) => { setPlayingNode(null); setPreview(asset) }, [])
  const onFocus = useCallback((id: string) => {
    setSelected([id]); setSelectedEdges([])
    void flow.fitView({
      nodes: [{ id }], padding: 0.2, minZoom: 0.1, maxZoom: 2.5,
      duration: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 300,
    })
  }, [flow])
  const onSize = useCallback((id: string, width: number, height: number) => setMediaSizes((current) => {
    const layoutKey = mediaSizeKeys.current[id]
    return current[id]?.width === width && current[id]?.height === height && current[id]?.layoutKey === layoutKey
      ? current : { ...current, [id]: { width, height, layoutKey } }
  }), [])
  useEffect(() => { if (playingNode && !selected.includes(playingNode)) setPlayingNode(null) }, [playingNode, selected])
  const assets = state?.assets ?? []
  const tasks = state?.tasks ?? []
  const previewFor = (node: CanvasNode): Asset | undefined => {
    if (!isGeneration(node.kind)) return assets.find((asset) => asset.id === node.assetId)
    const results = nodeResults(node.id, tasks, assets)
    return results.find((item) => item.id === node.selectedResultId) ?? results[0]
  }
  const nodes: FlowNode[] = useMemo(() => graph.nodes.map((node) => {
    const results = nodeResults(node.id, tasks, assets)
    const asset = previewFor(node)
    const rotation = rotations[node.id]?.assetId === asset?.id ? rotations[node.id]?.angle ?? 0 : 0
    const layoutKey = `${asset?.id ?? ''}:${rotation}:${!!expandedGroups[node.id]}:${results.length}`
    mediaSizeKeys.current[node.id] = layoutKey
    const cached = mediaSizes[node.id]
    const size = cached?.layoutKey === layoutKey ? cached : (asset?.kind === 'audio' ? { width: 360, height: 180 }
      : isGeneration(node.kind) ? generationFrame(asset, results.length, !!expandedGroups[node.id])
        : asset ? mediaFrame(asset.width ?? 16, asset.height ?? 9, rotation) : { width: 320, height: 265 })
    return {
      id: node.id, type: 'media', position: node.position, selected: selected.includes(node.id),
      width: size.width, height: size.height,
      data: { node, results, task: latestTask(node.id, tasks), asset, modelName: models.find((model) => model.id === node.modelId)?.name, api, workspace, onOpen, onResult,
        rotation, playing: active && playingNode === node.id, expanded: !!expandedGroups[node.id], onExpand, onRename, onRotate, onPlay, onStop, onFocus, onSize },
    }
  }), [graph.nodes, tasks, assets, models, selected, api, workspace, onOpen, onResult, rotations, playingNode, active, expandedGroups, mediaSizes, onExpand, onRename, onRotate, onPlay, onStop, onFocus, onSize])
  const baseEdges = useMemo<RelationshipFlowEdge[]>(() => graph.edges.map((edge) => ({ ...edge, type: 'relationship',
    selected: selectedEdges.includes(edge.id), label: assets.find((item) => item.id === edge.assetId)?.kind === 'image' ? undefined : '素材' })), [graph.edges, assets, selectedEdges])
  const flowingNodeId = active && pageVisible && !marquee.selecting ? activeNode?.id ?? null : null
  const edges = useMemo(() => relationshipEdges(baseEdges, flowingNodeId), [baseEdges, flowingNodeId])
  const onNodesChange = useCallback((changes: NodeChange<FlowNode>[]) => {
    const selection = changes.filter((change) => change.type === 'select')
    if (selection.length && !marquee.blocksNativeSelection()) setSelected((current) => {
      const next = new Set(current)
      for (const change of selection) if (change.type === 'select') { if (change.selected) next.add(change.id); else next.delete(change.id) }
      return [...next]
    })
    const positions = new Map(changes.filter((change) => change.type === 'position' && change.position).map((change) => change.type === 'position' ? [change.id, change.position!] : ['', { x: 0, y: 0 }]))
    const removed = new Set(changes.filter((change) => change.type === 'remove').map((change) => 'id' in change ? change.id : ''))
    if (positions.size || removed.size) edit((current) => ({
      ...current, nodes: current.nodes.filter((node) => !removed.has(node.id)).map((node) => positions.has(node.id) ? { ...node, position: positions.get(node.id)! } : node),
      edges: current.edges.filter((edge) => !removed.has(edge.source) && !removed.has(edge.target)),
    }))
  }, [edit, marquee.blocksNativeSelection])
  const connect = useCallback((connection: Connection) => {
    const source = graph.nodes.find((node) => node.id === connection.source)
    const target = graph.nodes.find((node) => node.id === connection.target)
    const asset = source && connectionAsset(source, assets, nodeResults(source.id, tasks, assets), connection.sourceHandle)
    if (!source || !target || !asset || !isGeneration(target.kind)) { report(new Error('请从已有素材连接到生成节点')); return }
    if (target.kind === 'tts-generation') { report(new Error('语音生成节点不支持输入连线')); return }
    const model = models.find((item) => item.id === target.modelId)
    if (asset.kind === 'image' && !['image/png', 'image/jpeg', 'image/webp'].includes(asset.mime)) {
      report(new Error('当前协议的参考图仅支持 PNG、JPEG 和 WebP')); return
    }
    if (model && (!model.capabilities.referenceKinds.includes(asset.kind) || graph.edges.filter((edge) => edge.target === target.id).length >= model.capabilities.maxReferences)) {
      report(new Error('当前模型不支持这份素材，或引用数量已达上限')); return
    }
    if (!model && asset.kind !== 'image') { report(new Error('请先选择支持这类素材的模型')); return }
    const next = { ...graph, edges: [...graph.edges, { id: crypto.randomUUID(), source: source.id, target: target.id, assetId: asset.id }] }
    try { validateGraph(next, assets, tasks); edit(next) } catch (error) { report(error) }
  }, [graph, assets, tasks, models, edit, report])
  const addNode = (kind: NodeKind) => {
    const rect = container.current?.getBoundingClientRect()
    const position = flow.screenToFlowPosition({ x: (rect?.left ?? 0) + (rect?.width ?? 900) / 2 - 150, y: (rect?.top ?? 0) + (rect?.height ?? 600) / 2 - 150 })
    const model = models.find((model) => model.kind === nodeMediaKind(kind))
    const node: CanvasNode = {
      id: crypto.randomUUID(), kind, title: `${NodeLabels[kind]} ${graph.nodes.filter((node) => node.kind === kind).length + 1}`,
      position, modelId: isGeneration(kind) ? model?.id ?? null : null,
      params: kind === 'tts-generation' ? defaultTtsParams() : isGeneration(kind) && model ? defaultParams(model) : null, prompt: '', assetId: null, selectedResultId: null,
    }
    edit((current) => ({ ...current, nodes: [...current.nodes, node] })); setSelected([node.id])
  }
  const askImport = (kind: MediaKind, target?: string) => {
    importIntent.current = { kind, target }
    if (fileInput.current) { fileInput.current.accept = `${kind}/*`; fileInput.current.value = ''; fileInput.current.click() }
  }
  const uploadFile = async (file: File, point?: { x: number; y: number }) => {
    const guessed = file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : file.type.startsWith('audio/') ? 'audio' : undefined
    const intent = importIntent.current ?? (guessed ? { kind: guessed } : null)
    if (!intent) { report(new Error('请选择图片、视频或音频文件')); return }
    setUploading(true); setUploadProgress(0)
    try {
      await canvas.flush()
      const target = graph.nodes.find((node) => node.id === intent.target)
      const rect = container.current?.getBoundingClientRect()
      const position = point ?? (target ? { x: target.position.x - 420, y: target.position.y } : flow.screenToFlowPosition({ x: (rect?.left ?? 0) + 200, y: (rect?.top ?? 0) + 170 }))
      const result = await api.upload(workspace, file, intent.kind, position, canvas.refresh, setUploadProgress)
      await canvas.refresh()
      setSelected([result.nodeId])
      if (target) {
        for (let attempt = 0; attempt < 20; attempt++) {
          const response = await api.state(workspace)
          const resource = response.graph.nodes.find((n) => n.id === result.nodeId)
          if (resource?.assetId) {
            await canvas.refresh()
            edit((current) => ({ ...current, edges: [...current.edges, { id: crypto.randomUUID(), source: result.nodeId, target: target.id, assetId: resource.assetId! }] }))
            break
          }
          await new Promise((resolve) => setTimeout(resolve, 500))
        }
      }
    } catch (error) { report(error) }
    finally { setUploading(false); importIntent.current = null }
  }
  const generate = async (node: CanvasNode) => {
    if (submitting) return
    setSubmitting(true)
    try {
      const revision = await canvas.flush()
      if (node.kind === 'tts-generation') await api.ttsGenerate(workspace, node.id, revision)
      else await api.mockGenerate(workspace, node.id, revision)
      await canvas.refresh()
    } catch (error) { report(error) }
    finally { setSubmitting(false) }
  }
  const taskAction = async (task: TaskSummary, action: TaskAction) => {
    if (action === 'abandon' && !window.confirm('结束本地等待不会取消模型服务上的任务。再次生成可能重复计费，是否继续？')) return
    try { await api.taskAction(workspace, task.id, action); await canvas.refresh() } catch (error) { report(error) }
  }
  const returnToProjects = async () => {
    if (uploading || submitting || leaving) return
    setLeaving(true)
    try {
      if (state) await canvas.flush()
      onBack()
    } catch (error) { report(error); setLeaving(false) }
  }
  return <CanvasSelectionContext.Provider value={{ selecting: marquee.selecting, selectedIds: selected }}><div className="dc-root">
    <header className="dc-header"><UiButton className="dc-ui-back" autoFocus={active} disabled={uploading || submitting || leaving} title={uploading ? '请等待文件接收完成' : submitting ? '请等待任务提交完成' : '保存并返回项目列表'} onClick={() => void returnToProjects()}>← <span>{leaving ? '保存中…' : '项目列表'}</span></UiButton>
      <div className="dc-title dc-workspace-title"><div><strong title={title}>{title}</strong><small>无限画布</small></div></div>
      <div className="dc-header-actions"><span className={`dc-save-status ${canvas.conflict ? 'warning' : ''}`}>{canvas.saveStatus}</span><UiButton variant="outline" onClick={() => setShowTasks(true)}>任务</UiButton><UiButton variant="outline" onClick={() => setShowSettings(true)}>⚙ 设置</UiButton></div>
    </header>
    <div className="dc-canvas-area" ref={container} tabIndex={-1} data-gpu-compositing={gpu.enabled ? 'enabled' : 'disabled'} data-gpu-reason={gpu.reason}
      data-marquee-selecting={marquee.selecting}
      onPointerDownCapture={(event) => {
        if (event.target instanceof HTMLElement && event.target.closest('.react-flow__pane')) event.currentTarget.focus({ preventScroll: true })
        marquee.onPointerDownCapture(event)
      }} onPointerUpCapture={marquee.onPointerUpCapture}
      onPointerUp={marquee.onPointerUp} onPointerCancel={marquee.onPointerCancel}
      onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' } }}
      onDrop={(event) => {
        event.preventDefault()
        if (uploading) return
        importIntent.current = null
        const files = [...event.dataTransfer.files]
        const point = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY })
        void (async () => { for (const [i, file] of files.entries()) await uploadFile(file, { x: point.x + i * 350, y: point.y }) })()
      }}>
      {!state ? <div className="dc-loading">载入本地画布…</div> : <ReactFlow<FlowNode, RelationshipFlowEdge>
        nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} defaultEdgeOptions={edgeOptions} connectionLineType={ConnectionLineType.Bezier}
        onNodesChange={onNodesChange} onEdgesChange={(changes) => {
          const selection = changes.filter((change) => change.type === 'select')
          if (selection.length && !marquee.blocksNativeSelection()) setSelectedEdges((current) => {
            const next = new Set(current)
            for (const change of selection) if (change.type === 'select') { if (change.selected) next.add(change.id); else next.delete(change.id) }
            return [...next]
          })
          const removed = new Set(changes.filter((change) => change.type === 'remove').map((change) => 'id' in change ? change.id : ''))
          if (removed.size) edit((current) => ({ ...current, edges: current.edges.filter((edge) => !removed.has(edge.id)) }))
        }}
        onConnect={connect} defaultViewport={graph.viewport} minZoom={0.1} maxZoom={2.5}
        onMoveEnd={(_event, viewport) => edit((current) => ({ ...current, viewport }))}
        onPaneClick={() => { setSelected([]); setPlayingNode(null) }}
        onNodeClick={(_event, node) => { if (node.data.asset?.kind === 'video') setPlayingNode(node.id); else if (node.data.asset?.kind !== 'audio') setPlayingNode(null) }}
        onBeforeDelete={async ({ nodes: removedNodes, edges: removedEdges }) => {
          if (!active || !container.current?.contains(document.activeElement)) return false
          if (submitting && removedNodes.length) { report(new Error('任务正在提交，请稍后删除')); return false }
          const locked = removedNodes.filter((node) => tasks.some((task) => task.nodeId === node.id && TRACKED_STATUSES.has(task.status)))
          if (locked.length) { report(new Error('选中的节点有未结束任务，请先处理任务')); return false }
          if (removedNodes.length && !window.confirm(`删除 ${removedNodes.length} 个节点，并解除相关连线？本地媒体和下游结果会保留。`)) return false
          return { nodes: removedNodes, edges: removedEdges }
        }}
        selectionOnDrag={!panning} selectionMode={SelectionMode.Full} panOnDrag={panning ? true : [1, 2]} selectionKeyCode={active ? 'Shift' : null} deleteKeyCode={active ? ['Backspace', 'Delete'] : null}
        {...canvasScrollGestures}
        onlyRenderVisibleElements proOptions={{ hideAttribution: false }}
        ariaLabelConfig={{ 'controls.zoomIn.ariaLabel': '放大', 'controls.zoomOut.ariaLabel': '缩小', 'controls.fitView.ariaLabel': '适应画布' }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} color="var(--dc-grid)" />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable nodeColor="var(--dc-accent)" maskColor="var(--dc-minimap-mask)" />
        {active && !marquee.selecting && activeNode && nodeEditorVisible(activeNode, previewFor(activeNode), !!expandedGroups[activeNode.id]) && <FloatingEditor node={activeNode} graph={graph} assets={assets} tasks={tasks} models={models} api={api} workspace={workspace} container={container}
          nodeSize={mediaSizes[activeNode.id]} onResult={onResult}
          patchNode={patchNode} edit={edit} generate={generate} report={report} uploading={uploading} submitting={submitting}
          askImport={askImport} taskAction={taskAction} onOpen={onOpen} />}
      </ReactFlow>}
      {state && !graph.nodes.length && <div className="dc-welcome"><span className="dc-welcome-symbol">✦</span><h1>从一个想法开始</h1><p>创建生成节点，或者导入你的素材。<br />连接参考图，让每一步创作都有迹可循。</p><div><UiButton variant="primary" onClick={() => addNode('image-generation')}><MediaIcon kind="image" size={22} />图片生成</UiButton><UiButton variant="outline" onClick={() => addNode('video-generation')}><MediaIcon kind="video" size={22} />视频生成</UiButton></div></div>}
      <div className="dc-tools"><UiActionMenu label="添加节点" variant="primary" disabled={!active || !state} side="top" gap={14}
        items={(['image-generation', 'video-generation', 'tts-generation'] as const).map((kind) => ({ id: kind, label: NodeLabels[kind], icon: kind === 'tts-generation' ? <TtsIcon size={22} /> : <MediaIcon kind={nodeMediaKind(kind)} size={22} />, onSelect: () => addNode(kind) }))}>＋ 添加节点</UiActionMenu><span className="dc-tool-divider" />
        <UiButton disabled={!state || uploading} onClick={() => { importIntent.current = null; if (fileInput.current) { fileInput.current.accept = 'image/*,video/*,audio/*'; fileInput.current.value = ''; fileInput.current.click() } }}>{uploading ? `上传 ${uploadProgress}%` : '上传素材'}</UiButton>
        <UiButton title="适应全部节点" aria-label="适应全部节点" onClick={() => void flow.fitView({ padding: 0.3, duration: 250 })}>⛶</UiButton>
        <UiButton title="保存画布" onClick={() => void canvas.flush().catch(() => {})}>保存</UiButton>
        <span className="dc-node-count">{graph.nodes.length} 节点</span>
      </div>
      <div className="dc-hint">左键拖动框选 · 空格 + 左键拖动平移 · 滚轮 / 双指移动平移 · ⌘ / Ctrl + 滚轮缩放 · Delete 删除</div>
      {canvas.error && <div className="dc-toast" role="alert"><span>{canvas.error}</span><UiButton aria-label="关闭提示" onClick={canvas.clearError}>×</UiButton></div>}
      {canvas.conflict && <div className="dc-conflict"><strong>画布保存冲突，当前草稿仍保留</strong><UiButton variant="outline" onClick={() => downloadJson('canvas-draft.json', graph)}>导出草稿</UiButton><UiButton variant="outline" onClick={() => { if (window.confirm('重新载入将替换当前未保存草稿，请先导出。')) void canvas.reload().catch(report) }}>重新载入</UiButton></div>}
    </div>
    <input ref={fileInput} type="file" multiple hidden onChange={(event) => { const files = [...event.target.files ?? []]; void (async () => { for (const file of files) await uploadFile(file) })() }} />
    {active && showSettings && <Modal label="画布设置" onClose={() => { setShowSettings(false); loadModels() }}><StoragePanel api={api} /><ModelSettings api={api} onChanged={loadModels} /></Modal>}
    {active && showTasks && <TaskDialog api={api} onClose={() => setShowTasks(false)} />}
    {active && preview && (preview.kind === 'audio'
      ? <Modal label={preview.filename} onClose={() => setPreview(null)} wide><Media asset={preview} api={api} workspace={workspace} /></Modal>
      : <UiMediaModal label={preview.filename} onClose={() => setPreview(null)}>
        {preview.kind === 'image' ? <img className="dc-preview-image" src={api.media(workspace, preview.id)} alt={preview.filename} draggable={false} />
          : <VideoPlayer key={preview.id} src={api.media(workspace, preview.id)} poster={api.preview(workspace, preview.id)} autoPlay preview label={preview.filename} />}
      </UiMediaModal>)}
  </div></CanvasSelectionContext.Provider>
}

interface EditorProps {
  node: CanvasNode; graph: CanvasGraph; assets: Asset[]; tasks: TaskSummary[]; models: readonly PublicModel[]; api: CanvasApi; workspace: string
  container: React.RefObject<HTMLDivElement>
  nodeSize?: { width: number; height: number }; onResult: (id: string, assetId: string) => void
  patchNode: (id: string, fields: Partial<CanvasNode>) => void
  edit: (change: CanvasGraph | ((graph: CanvasGraph) => CanvasGraph)) => void
  report: (error: unknown) => void
  generate: (node: CanvasNode) => Promise<void>; uploading: boolean; submitting: boolean
  askImport: (kind: MediaKind, target?: string) => void
  taskAction: (task: TaskSummary, action: TaskAction) => Promise<void>; onOpen: (asset: Asset) => void
}
export function FloatingEditor(props: EditorProps) {
  const { node, graph, assets, tasks, models, api, workspace, patchNode, edit, generate, report, uploading, submitting, askImport, taskAction, onOpen } = props
  const viewport = useViewport()
  const panel = useRef<HTMLDivElement>(null)
  const promptEditor = useRef<MentionPromptEditorHandle>(null)
  const [size, setSize] = useState({ width: 1000, height: 700, panel: 300 })
  useEffect(() => {
    const measure = () => {
      const host = props.container.current
      if (host && (!host.clientWidth || !host.clientHeight)) return
      setSize({ width: host?.clientWidth ?? 1000, height: host?.clientHeight ?? 700, panel: panel.current?.offsetHeight || 300 })
    }
    const observer = new ResizeObserver(measure)
    if (props.container.current) observer.observe(props.container.current)
    if (panel.current) observer.observe(panel.current)
    measure()
    return () => observer.disconnect()
  }, [props.container, node.id])
  const width = Math.min(530, size.width - 32)
  const left = Math.max(16, Math.min(size.width - width - 16, viewport.x + node.position.x * viewport.zoom - (width - (props.nodeSize?.width ?? 320) * viewport.zoom) / 2))
  const top = Math.max(72, Math.min(size.height - size.panel - 76, viewport.y + (node.position.y + (props.nodeSize?.height ?? 285)) * viewport.zoom + 18))
  const generation = isGeneration(node.kind)
  const model = models.find((item) => item.id === node.modelId)
  const references = graph.edges.filter((edge) => edge.target === node.id)
  const promptReferences = useMemo(() => connectedPromptReferences(graph, node.id, assets), [graph, node.id, assets])
  const candidates = useMemo(() => model ? promptCandidates(graph, node.id, assets, tasks, model.capabilities) : [], [graph, node.id, assets, tasks, model])
  const task = latestTask(node.id, tasks)
  const locked = !!task && TRACKED_STATUSES.has(task.status)
  if (node.kind === 'tts-generation') return <div className="dc-editor dc-generation-editor dc-tts-editor nodrag nopan nowheel" ref={panel} style={{ left, top, width }} onKeyDown={(event) => event.stopPropagation()}>
    <TtsEditor node={node} task={task} submitting={submitting} patchNode={patchNode} generate={generate} onError={report} />
  </div>
  let reason = ''
  if (generation) {
    if (!model || !node.params || isTtsParams(node.params)) reason = '请选择模型'
    else try { validateMockGeneration({ model: mockRecord(model.id), prompt: node.prompt, params: node.params, referenceIds: references.map((edge) => edge.assetId) }, assets) } catch (error) { reason = error instanceof Error ? error.message : '输入无效' }
  }
  const asset = !generation ? assets.find((item) => item.id === node.assetId) : nodeResults(node.id, tasks, assets).find((item) => item.id === node.selectedResultId) ?? nodeResults(node.id, tasks, assets)[0]
  return <div className={`dc-editor nodrag nopan nowheel ${generation ? 'dc-generation-editor' : ''}`} ref={panel} style={{ left, top, width }} onKeyDown={(event) => event.stopPropagation()}>
    {!generation && <div className="dc-editor-title"><label><UiInput value={node.title} aria-label="节点名称" maxLength={160} onChange={(event) => patchNode(node.id, { title: event.target.value || NodeLabels[node.kind] })} /></label><span>{NodeLabels[node.kind]}</span></div>}
    {generation ? <>
      <div className="dc-generation-actions">
        <UiButton variant="outline" disabled={uploading || locked || (!!model && !model.capabilities.referenceKinds.includes('image')) || (!!model && references.length >= model.capabilities.maxReferences)} onClick={() => askImport('image', node.id)}>{uploading ? '导入中…' : '＋ 上传'}</UiButton>
      </div>
      <div className="dc-reference-row">
        {references.map((edge, index) => {
          const reference = assets.find((item) => item.id === edge.assetId)
          return <div className="dc-reference" key={edge.id} title={reference?.filename ?? '素材不可用'}>
            {reference?.kind === 'image' ? <img src={api.preview(workspace, reference.id)} alt={`参考图 ${index + 1}`} onClick={() => onOpen(reference)} /> : <span className="dc-reference-placeholder">{reference ? <MediaIcon kind={reference.kind} size={28} /> : '？'}</span>}
            <small>{index + 1}</small><UiButton disabled={locked || submitting} className="dc-ui-remove-reference" aria-label={`移除引用 ${index + 1}`} onClick={() => edit((current) => ({ ...current, edges: current.edges.filter((item) => item.id !== edge.id) }))}>×</UiButton>
          </div>
        })}
        {!references.length && <small className="dc-muted">也可从素材节点拖入连线</small>}
      </div>
      <MentionPromptEditor key={node.id} ref={promptEditor} value={node.prompt} disabled={locked || submitting}
        placeholder={node.kind === 'image-generation' ? '描述你想要生成的画面内容…' : '描述镜头、动作、场景与氛围…'}
        references={promptReferences} candidates={candidates} preview={(id) => api.preview(workspace, id)}
        onChange={(prompt) => patchNode(node.id, { prompt })} onError={report}
        onChoose={(item, prompt) => {
          if (!model || locked || submitting) throw new Error('请先选择可用模型')
          const inserted = insertPromptReference(graph, node.id, item, prompt, assets, tasks, model.capabilities)
          edit(inserted.graph)
          return inserted.reference
        }} />
      {reason && reason !== '请选择模型' && <small className="dc-validation">{reason}</small>}
      <div className="dc-editor-bottom">
        <UiSelect label="生成模型" disabled={locked || submitting} className="dc-ui-model-select" value={node.modelId ?? ''} onChange={(value) => {
          const next = models.find((item) => item.id === value)
          patchNode(node.id, { modelId: next?.id ?? null, params: next ? defaultParams(next) : null })
        }} options={[{ value: '', label: '选择 Mock 模型' }, ...models.filter((item) => item.kind === nodeMediaKind(node.kind)).map((item) => ({ value: item.id, label: item.name }))]} />
        {model && node.params && !isTtsParams(node.params) && <GenerationParameters key={node.id} model={model} params={node.params} disabled={locked || submitting} onChange={(params) => patchNode(node.id, { params })} />}
        <UiButton variant="primary" className="dc-ui-generate dc-generate-arrow" aria-label={locked ? TaskStatusLabels[task!.status] : '生成'} disabled={!!reason || locked || submitting || uploading} title={reason || '生成'} onClick={() => { try { promptEditor.current?.flush(); void generate(node) } catch (error) { report(error) } }}>{submitting || locked ? <span className="dc-spinner" /> : <svg width="20" height="20" viewBox="0 0 24 24" stroke="currentColor" fill="none" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6" /></svg>}</UiButton>
      </div>
    </> : <div className="dc-asset-editor"><p>{asset ? `${asset.filename} · ${formatBytes(asset.bytes)}` : '选择本地文件，素材会复制到插件的本机存储。'}</p><UiButton variant="outline" disabled={uploading} onClick={() => askImport(nodeMediaKind(node.kind))}>{uploading ? '导入中…' : '上传为新资源节点'}</UiButton></div>}
    {!generation && task && <TaskInformation api={api} canvas={workspace} task={task} action={taskAction} />}
    {!generation && asset && <div className="dc-result-actions"><UiButton onClick={() => onOpen(asset)}>{asset.kind === 'image' ? '查看大图' : '打开原文件'}</UiButton><a download href={api.media(workspace, asset.id, true)}>另存文件 ↓</a></div>}
  </div>
}

function TaskInformation({ api, canvas, task, action }: { api: CanvasApi; canvas: string; task: TaskSummary; action?: (task: TaskSummary, action: TaskAction) => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [detail, setDetail] = useState<TaskDetail | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!open) return
    let live = true
    void api.taskDetail(canvas, task.id).then((next) => { if (live) { setDetail(next); setError('') } }).catch((e) => { if (live) setError(String(e)) })
    return () => { live = false }
  }, [api, canvas, task.id, task.updatedAt, open])
  const act = async (value: TaskAction) => {
    try {
      if (action) await action(task, value)
      else {
        if (value === 'abandon' && !window.confirm('结束本地等待不会取消外部任务，是否继续？')) return
        await api.taskAction(canvas, task.id, value)
      }
      setDetail(await api.taskDetail(canvas, task.id))
    } catch (e) { setError(String(e)) }
  }
  return <details className="dc-task-details" onToggle={(e) => setOpen(e.currentTarget.open)}>
    <summary>任务 · {TaskStatusLabels[task.status]} · {new Date(task.createdAt).toLocaleString()}</summary>
    {error && <p role="alert">{error}</p>}
    {open && !detail && <p>载入详情…</p>}
    {detail && <><p>本地任务 ID：{task.id}</p>{detail.task && <><p>{detail.task.snapshot.model.name} · {detail.task.snapshot.prompt}</p><small>输入修改只影响下次生成</small></>}
      {detail.externalTaskId && <p>外部任务 ID：{detail.externalTaskId}</p>}
      {detail.externalCompletedAt && <p>外部完成：{new Date(detail.externalCompletedAt).toLocaleString()}</p>}
      {detail.successAt && <p>本地保存成功：{new Date(detail.successAt).toLocaleString()}</p>}
      {detail.failureMessage && <p className="dc-task-error">{detail.failureStage} · {detail.failureCode}：{detail.failureMessage}</p>}
      {['unknown', 'save_failed'].includes(task.status) && <div className="dc-task-actions">
        {task.status === 'save_failed' && <UiButton onClick={() => void act('retry-save')}>重试保存结果</UiButton>}
        {task.status === 'unknown' && detail.externalTaskId && <UiButton onClick={() => void act('resume-query')}>恢复查询</UiButton>}
        <UiButton onClick={() => void act('abandon')}>结束本地等待</UiButton>
      </div>}
      <small>执行步骤：{detail.attempts.map((a) => `${a.step}(${a.outcome ?? '处理中'})`).join(' → ') || detail.phase}</small>
    </>}
  </details>
}
function StoragePanel({ api }: { api: CanvasApi }) {
  const [settings, setSettings] = useState<StorageSettings | null>(null)
  const [path, setPath] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  useEffect(() => { void api.storage().then((s) => { setSettings(s); setPath(s.path) }).catch((e) => setError(String(e))) }, [api])
  const save = async () => {
    if (!settings) return
    setSaving(true)
    try { const next = await api.setStorage(path, settings.revision); setSettings(next); setError('') } catch (e) { setError(String(e)) } finally { setSaving(false) }
  }
  return <section className="dc-storage"><h2>媒体存储</h2><p>文件存于运行 Harness 的电脑，按“画布名称 / 资源名称”组织。</p>
    <label>宿主媒体根目录<UiInput value={path} onChange={(e) => setPath(e.target.value)} placeholder="/Users/yourname/CanvasMedia" /></label>
    <UiButton variant="outline" disabled={!settings || saving} onClick={() => void save()}>{saving ? '保存中…' : '保存目录设置'}</UiButton>
    {settings && <p>{settings.moving ? `${settings.moving} 个搬移操作处理中` : '目标目录已设置'}{settings.failed ? ` · ${settings.failed} 个搬移失败，原文件仍可读` : ''}</p>}
    {!!settings?.failed && <UiButton onClick={() => void api.retryMoves().then(() => api.storage()).then(setSettings).catch((e) => setError(String(e)))}>重试搬移</UiButton>}
    {error && <p role="alert">{error}</p>}
  </section>
}
