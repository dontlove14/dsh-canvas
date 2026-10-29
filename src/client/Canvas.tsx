import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ReactFlow, ReactFlowProvider, Background, BackgroundVariant, Controls, MiniMap,
  useReactFlow, useViewport, useStoreApi, ConnectionLineType, SelectionMode, type Node, type NodeProps, type NodeChange, type Connection,
} from '@xyflow/react'
import {
  NodeLabels, defaultParams, isGeneration, nodeMediaKind, nodeResults, latestTask,
  TaskStatusLabels, validateGraph, defaultTtsParams, isTtsParams,
  validateGeneration, ModelRecordSchema,
  type CanvasNode, type CanvasGraph, type NodeKind, type Asset, type PublicModel, type MediaKind, type TaskAction, type GenerationParams,
} from '../shared/contracts'
import { type CanvasChoice, type TaskSummary, type TaskDetail } from '../shared/v2'
import { CanvasApi } from './api'
import { modelConfigured } from '../shared/modelCatalog'
import { useCanvas } from './useCanvas'
import { useGpuCapability } from './useGpu'
import { useViewportCompositing } from './useViewportCompositing'
import { CanvasSettings, type SettingsTab } from './Settings'
import { SignedImage } from './SignedMedia'
import { MediaIcon } from './MediaIcon'
import { ProjectList } from './ProjectList'
import { ResourceNode } from './ResourceNode'
import { UiActionMenu, UiButton, UiInput, UiModal as Modal, UiMediaModal, UiSelect } from './ui'
import { canvasScrollGestures, useCanvasActionBarGestures } from './gestures'
import { VideoPlayer } from './VideoPlayer'
import { mockRecord, validateMockGeneration } from '../shared/mockModels'
import { isMockModel } from '../shared/mockModels'
import { builtinDefinition } from '../shared/modelCatalog'
import { ModelPicker, selectableModels } from './ModelPicker'
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
import { nodeEditorPosition } from './nodeOverlayLayout'
import { RelationshipEdge, relationshipEdges, type RelationshipFlowEdge } from './RelationshipEdge'
import { NodeLoading, NodeLoadingContext, useNodeLoadingEnvironment } from './NodeLoading'
import { createLoadingResolutionStore, LoadingResolutionContext } from './loadingResolution'
import { HistoryNode } from './HistoryNode'
import { generationHistory, hasGenerationHistory, historyFrame, historyEditorAnchor, resultHandle, type GenerationCard } from './generationHistory'
import { useGenerationSubmission } from './useGenerationSubmission'
import { useHistoryInspection, type HistoryInspection } from './useHistoryInspection'
import { GenerationSnapshotEditor } from './GenerationSnapshotEditor'
import { sameFields, sameNodeContent, shareEditorGraph, shareItems } from './canvasSharing'
import { createCanvasProjection, EMPTY_PROJECTION } from './canvasProjection'
import { normalizeSeedanceGraphReferences, seedanceGenerationParams, seedanceFrameParams, seedanceInputCapabilities, validateSeedanceConnections } from '../shared/seedance'
import { SeedanceFrameRole } from './SeedanceFrameRoles'
import { CanvasReviewState, ReviewContext } from './reviewState'
import { SeedanceReviewDialog } from './SeedanceReviewDialog'
import { CanvasTextSelectionProvider } from './canvasTextSelection'
import { useNodeDeleteConfirmation } from './useNodeDeleteConfirmation'

const EMPTY_TASKS: TaskSummary[] = []
const EMPTY_ASSETS: Asset[] = []
const EMPTY_CARDS: GenerationCard[] = []

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
    {missing ? <div className="dc-missing">媒体暂不可用<br /><small>可重新导入或恢复原结果</small></div>
      : visible ? asset.kind === 'image'
        ? <button className="dc-image-button" aria-label="查看大图" onClick={() => onOpen?.(asset)}><SignedImage api={api} canvas={workspace} assetId={asset.id} variant="original" alt={asset.filename} loading="lazy" draggable={false} onError={() => setMissing(true)} /></button>
        : asset.kind === 'video'
          ? <VideoPlayer src={api.media(workspace, asset.id)} api={api} canvas={workspace} assetId={asset.id} label={asset.filename} />
          : <AudioPlayer asset={asset} api={api} workspace={workspace} label={asset.filename} />
      : <div className="dc-media-rest"><MediaIcon kind={asset.kind} size={54} /></div>}
  </div>
})
interface NodeData extends Record<string, unknown> {
  node: CanvasNode; asset?: Asset; task?: TaskSummary; results: Asset[]; modelName?: string
  cards: GenerationCard[]; connectedAssets: string[]
  api: CanvasApi; workspace: string; onOpen: (asset: Asset) => void; onResult: (id: string, assetId: string) => void
  rotation: number; playing: boolean; onRename: (id: string, title: string) => void
  onFocus: (id: string) => void
  expanded: boolean; onExpand: (id: string) => void
  onInspect: (value: HistoryInspection) => void; inspection?: HistoryInspection
  onRotate: (id: string, assetId: string) => void; onPlay: (id: string) => void; onStop: (id: string) => void; onSize: (id: string, width: number, height: number) => void
}
type FlowNode = Node<NodeData, 'media'>
const MediaNode = memo(function MediaNode({ data, selected }: NodeProps<FlowNode>) {
  const { node, asset, task, results, api, workspace, onOpen, onResult } = data
  const generation = isGeneration(node.kind)
  if (generation && data.cards.length > 1) return <HistoryNode node={node} cards={data.cards} connectedAssets={data.connectedAssets}
    selected={!!selected} expanded={data.expanded} api={api} workspace={workspace} playing={data.playing}
    onPlay={data.onPlay} onStop={data.onStop} onRename={data.onRename} onExpand={data.onExpand} onOpen={onOpen} onSize={data.onSize}
    onInspect={data.onInspect} inspection={data.inspection} />
  if (node.kind === 'tts-generation' && !asset) return <TtsNode node={node} task={task} selected={!!selected} onRename={data.onRename} onSize={data.onSize} />
  if (generation && node.kind !== 'tts-generation') return <GenerationNode node={node} asset={asset} results={results} task={task} selected={!!selected} api={api} workspace={workspace}
    expanded={data.expanded} playing={data.playing} onRename={data.onRename} onResult={onResult} onExpand={data.onExpand}
    onPlay={data.onPlay} onStop={data.onStop} onOpen={onOpen} onSize={data.onSize} />
  if (asset?.kind === 'audio') return <AudioNode node={node} asset={asset} selected={!!selected} api={api} workspace={workspace}
    task={task} playing={data.playing} onPlay={data.onPlay} onStop={data.onStop} onRename={data.onRename} onSize={data.onSize} />
  if (asset) return <ResourceNode node={node} asset={asset} task={task} selected={!!selected}
    api={api} workspace={workspace} rotation={data.rotation} playing={data.playing}
    onOpen={onOpen} onRename={data.onRename} onRotate={data.onRotate} onPlay={data.onPlay} onStop={data.onStop} onFocus={data.onFocus} onSize={data.onSize} />
  return <article className={`dc-node ${selected ? 'selected' : ''} ${node.kind}`}>
    <div className="dc-node-heading"><MediaIcon kind={nodeMediaKind(node.kind)} className="dc-node-icon" /><strong>{node.title}</strong><span className="dc-node-kind">资源</span></div>
    <div className="dc-node-empty"><MediaIcon kind={nodeMediaKind(node.kind)} size={64} /><strong>导入本地素材</strong><small>选中节点后上传文件</small></div>
    <NodeLoading task={task} title={node.title} />
    <div className="dc-node-foot"><span>{NodeLabels[node.kind]}</span>
    </div>
    <CanvasHandle type="source" disabled />
  </article>
}, (a, b) => a.selected === b.selected && sameNodeContent(a.data.node, b.data.node) && sameFields(a.data, b.data, 'node'))
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
  const { graph, state, edit: editGraph, report } = canvas
  const [configuredModels, setConfiguredModels] = useState<PublicModel[]>([])
  const [ttsConfigured, setTtsConfigured] = useState<boolean | null>(null)
  const [ttsConfigurationError, setTtsConfigurationError] = useState(false)
  const configurationLoad = useRef(0)
  const models = useMemo(() => selectableModels(configuredModels.filter((model) => builtinDefinition(model))), [configuredModels])
  const edit = useCallback((change: CanvasGraph | ((graph: CanvasGraph) => CanvasGraph)) => {
    editGraph((previous) => normalizeSeedanceGraphReferences(previous, typeof change === 'function' ? change(previous) : change, configuredModels))
  }, [editGraph, configuredModels])
  const [selected, setSelected] = useState<string[]>([])
  const [selectedEdges, setSelectedEdges] = useState<string[]>([])
  const selectMarquee = useCallback((value: { nodes: string[]; edges: string[] }) => {
    setSelected(value.nodes); setSelectedEdges(value.edges)
  }, [])
  const marquee = useMarqueeSelection(selected, selectedEdges, selectMarquee)
  const [pageVisible, setPageVisible] = useState(() => document.visibilityState !== 'hidden')
  const reviewState = useMemo(() => new CanvasReviewState(api, workspace), [api, workspace])
  const [reviewAsset, setReviewAsset] = useState<Asset>()
  const reviewEnvironment = useMemo(() => ({ state: reviewState, open: setReviewAsset }), [reviewState])
  useEffect(() => { reviewState.setActive(active && pageVisible); return () => reviewState.setActive(false) }, [reviewState, active, pageVisible])
  const loadingRoot = useRef<HTMLDivElement>(null)
  const loadingEnvironment = useNodeLoadingEnvironment(loadingRoot, active && pageVisible)
  const flowStore = useStoreApi()
  const loadingResolution = useMemo(() => createLoadingResolutionStore({
    getZoom: () => flowStore.getState().transform[2],
    subscribe: (notify) => flowStore.subscribe((state, previous) => {
      if (state.transform[2] !== previous.transform[2]) notify()
    }),
  }), [flowStore])
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
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('storage')
  const [preview, setPreview] = useState<Asset | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [showTasks, setShowTasks] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const container = useRef<HTMLDivElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const importIntent = useRef<{ kind: MediaKind; target?: string } | null>(null)
  const flow = useReactFlow<FlowNode, RelationshipFlowEdge>()
  useViewportCompositing(container, gpu.enabled && active)
  useCanvasActionBarGestures(container, active && pageVisible)
  const loadModels = useCallback(() => {
    const request = ++configurationLoad.current
    const current = () => configurationLoad.current === request
    setTtsConfigured(null); setTtsConfigurationError(false)
    void api.models().then((list) => { if (current()) setConfiguredModels(list) }).catch((error) => { if (current()) report(error) })
    void api.ttsSettings().then((settings) => { if (current()) setTtsConfigured(settings.has_api_key === true) })
      .catch((error) => { if (current()) { setTtsConfigurationError(true); report(error) } })
  }, [api, report])
  useEffect(() => {
    if (active) loadModels()
    return () => { configurationLoad.current++ }
  }, [active, loadModels])
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
  const onRename = useCallback((id: string, title: string) => patchNode(id, { title }), [patchNode])
  const onRotate = useCallback((id: string, assetId: string) => setRotations((current) => ({
    ...current, [id]: { assetId, angle: ((current[id]?.assetId === assetId ? current[id].angle : 0) + 90) % 360 },
  })), [])
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
  const assets = state?.assets ?? EMPTY_ASSETS
  const { tasks, submitting, generate } = useGenerationSubmission({
    api, workspace, tasks: state?.tasks ?? EMPTY_TASKS, flush: canvas.flush, refresh: canvas.refresh, report,
  })
  const nodeDeletion = useNodeDeleteConfirmation<FlowNode, RelationshipFlowEdge>({
    active, pageVisible, workspace, submitting, tasks, nodes: graph.nodes, container, report,
  })
  const history = useHistoryInspection({ api, workspace, active: active && pageVisible, node: activeNode,
    expanded: !!activeNode && !!expandedGroups[activeNode.id], tasks, authoritative: state?.tasks ?? EMPTY_TASKS, patchNode })
  const project = useMemo(createCanvasProjection, [])
  const projection = useMemo(() => project(tasks, assets, graph.edges), [project, tasks, assets, graph.edges])
  const historyState = useRef({ expandedGroups, tasks })
  historyState.current = { expandedGroups, tasks }
  const onExpand = useCallback((id: string) => {
    const { expandedGroups, tasks } = historyState.current
    setPlayingNode(null)
    if (expandedGroups[id] && tasks.filter((task) => task.nodeId === id).length > 1) {
      history.beginEditing(id, true)
      setSelected([]); setSelectedEdges([])
    }
    setExpandedGroups((current) => ({ ...current, [id]: !current[id] }))
  }, [history.beginEditing])
  const onInspect = useCallback((value: HistoryInspection) => {
    setSelected([value.nodeId]); setSelectedEdges([])
    if (historyState.current.expandedGroups[value.nodeId]) history.inspect(value)
    else history.beginEditing(value.nodeId)
  }, [history.inspect, history.beginEditing])
  const onPlay = useCallback((id: string) => {
    const { expandedGroups, tasks } = historyState.current
    setSelected([id]); setSelectedEdges([]); setPlayingNode(id)
    if (!expandedGroups[id] && tasks.filter((task) => task.nodeId === id).length > 1) history.beginEditing(id)
  }, [history.beginEditing])
  const inspectionAnchor = activeNode && history.inspection ? historyEditorAnchor(activeNode,
    generationHistory(activeNode.id, tasks, assets), history.inspection.identity, history.inspection.assetId) : undefined
  const previewFor = (node: CanvasNode): Asset | undefined => {
    if (!isGeneration(node.kind)) return projection.assetById.get(node.assetId ?? '')
    const results = projection.byNode.get(node.id)?.results ?? EMPTY_ASSETS
    return results.find((item) => item.id === node.selectedResultId) ?? results[0]
  }
  const nodeCache = useRef(new Map<string, FlowNode>())
  const nodes: FlowNode[] = useMemo(() => {
    const next = graph.nodes.map((node): FlowNode => {
    const projected = projection.byNode.get(node.id) ?? EMPTY_PROJECTION
    const { results, connectedAssets, task } = projected
    const cards = isGeneration(node.kind) ? projected.cards : EMPTY_CARDS
    const asset = previewFor(node)
    const rotation = rotations[node.id]?.assetId === asset?.id ? rotations[node.id]?.angle ?? 0 : 0
    const layoutKey = `${asset?.id ?? ''}:${rotation}:${!!expandedGroups[node.id]}:${results.length}:${cards.map((card) => `${card.task.id}:${card.results.map((item) => item.id).join(',')}`).join(';')}`
    mediaSizeKeys.current[node.id] = layoutKey
    const cached = mediaSizes[node.id]
    const size = cached?.layoutKey === layoutKey ? cached : (cards.length > 1 ? historyFrame(cards, node.kind === 'tts-generation', !!expandedGroups[node.id])
      : asset?.kind === 'audio' ? { width: 360, height: 180 }
      : isGeneration(node.kind) ? generationFrame(asset, results.length, !!expandedGroups[node.id])
        : asset ? mediaFrame(asset.width ?? 16, asset.height ?? 9, rotation) : { width: 320, height: 265 })
    const data: NodeData = { node, results, cards, connectedAssets, task, asset, modelName: models.find((model) => model.id === node.modelId)?.name, api, workspace, onOpen, onResult,
      rotation, playing: active && playingNode === node.id, expanded: !!expandedGroups[node.id], onExpand, onInspect,
      inspection: history.inspection?.nodeId === node.id ? history.inspection : undefined, onRename, onRotate, onPlay, onStop, onFocus, onSize }
    const old = nodeCache.current.get(node.id)
    const next: FlowNode = {
      id: node.id, type: 'media', position: node.position, selected: selected.includes(node.id),
      width: size.width, height: size.height,
      data: old && sameFields(old.data, data) ? old.data : data,
    }
    return old && sameFields(old, next) ? old : next
    })
    nodeCache.current = new Map(next.map((node) => [node.id, node]))
    return next
  }, [graph.nodes, projection, models, selected, api, workspace, onOpen, onResult, rotations, playingNode, active, expandedGroups, mediaSizes, onExpand, onInspect, history.inspection, onRename, onRotate, onPlay, onStop, onFocus, onSize])
  const edgeCache = useRef<RelationshipFlowEdge[]>([])
  const baseEdges = useMemo<RelationshipFlowEdge[]>(() => {
    const previous = new Map(edgeCache.current.map((edge) => [edge.id, edge]))
    const historySources = new Set(graph.nodes.filter((node) => isGeneration(node.kind) && (projection.byNode.get(node.id)?.cards.length ?? 0) > 1).map((node) => node.id))
    const next = graph.edges.map((edge): RelationshipFlowEdge => {
      const value: RelationshipFlowEdge = { ...edge, type: 'relationship',
        sourceHandle: historySources.has(edge.source) ? resultHandle(edge.assetId) : undefined,
        selected: selectedEdges.includes(edge.id), label: projection.assetById.get(edge.assetId)?.kind === 'image' ? undefined : '素材' }
      const old = previous.get(edge.id)
      return old && sameFields(old, value) ? old : value
    })
    return edgeCache.current = shareItems(edgeCache.current, next)
  }, [graph.edges, graph.nodes, projection, selectedEdges])
  const flowingNodeId = active && pageVisible && !marquee.selecting ? activeNode?.id ?? null : null
  const edges = useMemo(() => relationshipEdges(baseEdges, flowingNodeId), [baseEdges, flowingNodeId])
  const onNodesChange = useCallback((changes: NodeChange<FlowNode>[]) => {
    const selection = changes.filter((change) => change.type === 'select')
    if (selection.length && !marquee.blocksNativeSelection()) setSelected((current) => {
      const next = new Set(current)
      for (const change of selection) if (change.type === 'select') { if (change.selected) next.add(change.id); else next.delete(change.id) }
      return shareItems(current, [...next])
    })
    const positions = new Map(changes.filter((change) => change.type === 'position' && change.position).map((change) => change.type === 'position' ? [change.id, change.position!] : ['', { x: 0, y: 0 }]))
    const removed = new Set(changes.filter((change) => change.type === 'remove').map((change) => 'id' in change ? change.id : ''))
    if (positions.size || removed.size) edit((current) => {
      const nodes = shareItems(current.nodes, current.nodes.filter((node) => !removed.has(node.id)).map((node) => {
        const position = positions.get(node.id)
        return position && (position.x !== node.position.x || position.y !== node.position.y) ? { ...node, position } : node
      }))
      const edges = removed.size ? shareItems(current.edges, current.edges.filter((edge) => !removed.has(edge.source) && !removed.has(edge.target))) : current.edges
      return nodes === current.nodes && edges === current.edges ? current : { ...current, nodes, edges }
    })
  }, [edit, marquee.blocksNativeSelection])
  const connect = useCallback((connection: Connection) => {
    const source = graph.nodes.find((node) => node.id === connection.source)
    const target = graph.nodes.find((node) => node.id === connection.target)
    const history = source && hasGenerationHistory(source, tasks)
    const outputs = source && history ? generationHistory(source.id, tasks, assets).flatMap((card) => card.results) : source ? nodeResults(source.id, tasks, assets) : []
    const asset = source && connectionAsset(source, assets, outputs, connection.sourceHandle, !!history, !!expandedGroups[source.id])
    if (!source || !target || !asset || !isGeneration(target.kind)) { report(new Error('请从已有素材连接到生成节点')); return }
    if (target.kind === 'tts-generation') { report(new Error('语音生成节点不支持输入连线')); return }
    const model = models.find((item) => item.id === target.modelId)
    if (asset.kind === 'image' && !['image/png', 'image/jpeg', 'image/webp'].includes(asset.mime)) {
      report(new Error('当前协议的参考图仅支持 PNG、JPEG 和 WebP')); return
    }
    const previousReferenceIds = graph.edges.filter((edge) => edge.target === target.id).map((edge) => edge.assetId)
    const params = target.params && !isTtsParams(target.params) && model?.protocol === 'seedance-video'
      ? seedanceGenerationParams(target.params, previousReferenceIds) : target.params
    const caps = model && seedanceInputCapabilities(model, !isTtsParams(params) ? params : null)
    if (caps && (!caps.referenceKinds.includes(asset.kind) || graph.edges.filter((edge) => edge.target === target.id).length >= caps.maxReferences)) {
      report(new Error('当前模型不支持这份素材，或引用数量已达上限')); return
    }
    if (!model && asset.kind !== 'image') { report(new Error('请先选择支持这类素材的模型')); return }
    const next = { ...graph, edges: [...graph.edges, { id: crypto.randomUUID(), source: source.id, target: target.id, assetId: asset.id }] }
    try {
      if (model?.protocol === 'seedance-video' && target.params && !isTtsParams(target.params))
        validateSeedanceConnections(seedanceGenerationParams(params as GenerationParams, [...previousReferenceIds, asset.id]),
          next.edges.filter((edge) => edge.target === target.id).map((edge) => assets.find((asset) => asset.id === edge.assetId)!), model.model_id)
      validateGraph(next, assets, tasks); edit(next)
    } catch (error) { report(error) }
  }, [graph, assets, tasks, models, expandedGroups, edit, report])
  const addNode = (kind: NodeKind) => {
    const rect = container.current?.getBoundingClientRect()
    const position = flow.screenToFlowPosition({ x: (rect?.left ?? 0) + (rect?.width ?? 900) / 2 - 150, y: (rect?.top ?? 0) + (rect?.height ?? 600) / 2 - 150 })
    const model = models.find((model) => model.kind === nodeMediaKind(kind) && modelConfigured(model))
    const node: CanvasNode = {
      id: crypto.randomUUID(), kind, title: `${NodeLabels[kind]} ${graph.nodes.filter((node) => node.kind === kind).length + 1}`,
      position, modelId: isGeneration(kind) ? model?.id ?? null : null,
      params: kind === 'tts-generation' ? defaultTtsParams() : isGeneration(kind) && model ? defaultParams(model) : null, prompt: '', assetId: null, selectedResultId: null,
    }
    edit((current) => ({ ...current, nodes: [...current.nodes, node] })); setSelected([node.id])
  }
  const askImport = useCallback((kind: MediaKind, target?: string) => {
    importIntent.current = { kind, target }
    if (fileInput.current) { fileInput.current.accept = `${kind}/*`; fileInput.current.value = ''; fileInput.current.click() }
  }, [])
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
            const currentTarget = response.graph.nodes.find((node) => node.id === target.id), model = models.find((model) => model.id === currentTarget?.modelId)
            if (model?.protocol === 'seedance-video' && currentTarget?.params && !isTtsParams(currentTarget.params)) {
              const references = response.graph.edges.filter((edge) => edge.target === target.id)
              const params = seedanceGenerationParams(currentTarget.params, references.map((edge) => edge.assetId))
              validateSeedanceConnections(seedanceGenerationParams(params, [...references.map((edge) => edge.assetId), resource.assetId]),
                [...references.map((edge) => response.assets.find((asset) => asset.id === edge.assetId)!), response.assets.find((asset) => asset.id === resource.assetId)!], model.model_id)
            }
            edit((current) => ({ ...current, edges: [...current.edges, { id: crypto.randomUUID(), source: result.nodeId, target: target.id, assetId: resource.assetId! }] }))
            break
          }
          await new Promise((resolve) => setTimeout(resolve, 500))
        }
      }
    } catch (error) { report(error) }
    finally { setUploading(false); importIntent.current = null }
  }
  const taskAction = useCallback(async (task: TaskSummary, action: TaskAction) => {
    if (action === 'abandon' && !window.confirm('结束本地等待不会取消模型服务上的任务。再次生成可能重复计费，是否继续？')) return
    try { await api.taskAction(workspace, task.id, action); await canvas.refresh() } catch (error) { report(error) }
  }, [api, workspace, canvas.refresh, report])
  const returnToProjects = async () => {
    if (uploading || submitting || leaving) return
    setLeaving(true)
    try {
      if (state) await canvas.flush()
      onBack()
    } catch (error) { report(error); setLeaving(false) }
  }
  const selectionEnvironment = useMemo(() => ({ selecting: marquee.selecting, selectedIds: selected }), [marquee.selecting, selected])
  return <ReviewContext.Provider value={reviewEnvironment}><LoadingResolutionContext.Provider value={loadingResolution}><NodeLoadingContext.Provider value={loadingEnvironment}><CanvasSelectionContext.Provider value={selectionEnvironment}><div className="dc-root" ref={loadingRoot}>
    <header className="dc-header"><UiButton className="dc-ui-back" autoFocus={active} disabled={uploading || submitting || leaving} title={uploading ? '请等待文件接收完成' : submitting ? '请等待任务提交完成' : '保存并返回项目列表'} onClick={() => void returnToProjects()}>← <span>{leaving ? '保存中…' : '项目列表'}</span></UiButton>
      <div className="dc-title dc-workspace-title"><div><strong title={title}>{title}</strong><small>无限画布</small></div></div>
      <div className="dc-header-actions"><span className={`dc-save-status ${canvas.conflict ? 'warning' : ''}`}>{canvas.saveStatus}</span><UiButton variant="outline" onClick={() => setShowTasks(true)}>任务</UiButton><UiButton variant="outline" onClick={() => { setSettingsTab('storage'); setShowSettings(true) }}>⚙ 设置</UiButton></div>
    </header>
    <CanvasTextSelectionProvider><div className="dc-canvas-area" ref={container} tabIndex={-1} data-gpu-compositing={gpu.enabled ? 'enabled' : 'disabled'} data-gpu-reason={gpu.reason}
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
            return shareItems(current, [...next])
          })
          const removed = new Set(changes.filter((change) => change.type === 'remove').map((change) => 'id' in change ? change.id : ''))
          if (removed.size) edit((current) => ({ ...current, edges: current.edges.filter((edge) => !removed.has(edge.id)) }))
        }}
        onConnect={connect} defaultViewport={graph.viewport} minZoom={0.1} maxZoom={2.5}
        onMoveEnd={(_event, viewport) => edit((current) => ({ ...current, viewport }))}
        onPaneClick={() => { setSelected([]); setPlayingNode(null) }}
        onNodeClick={(_event, node) => {
          if (node.data.asset?.kind === 'video') setPlayingNode(node.id); else if (node.data.asset?.kind !== 'audio') setPlayingNode(null)
          if (!expandedGroups[node.id] && node.data.cards.length > 1) history.beginEditing(node.id)
        }}
        onBeforeDelete={nodeDeletion.onBeforeDelete}
        selectionOnDrag={!panning} selectionMode={SelectionMode.Full} panOnDrag={panning ? true : [1, 2]} selectionKeyCode={active ? 'Shift' : null} deleteKeyCode={active ? ['Backspace', 'Delete'] : null}
        {...canvasScrollGestures}
        onlyRenderVisibleElements proOptions={{ hideAttribution: true }}
        ariaLabelConfig={{ 'controls.zoomIn.ariaLabel': '放大', 'controls.zoomOut.ariaLabel': '缩小', 'controls.fitView.ariaLabel': '适应画布' }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} color="var(--dc-grid)" />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable nodeColor="var(--dc-accent)" maskColor="var(--dc-minimap-mask)" />
        {active && pageVisible && !marquee.selecting && activeNode && (inspectionAnchor || history.restoring) &&
          <GenerationSnapshotEditor api={api} workspace={workspace} snapshot={history.snapshot} assets={assets} error={history.error} restoring={history.restoring}
            anchor={inspectionAnchor ?? { position: activeNode.position, size: mediaSizes[activeNode.id] ?? { width: 320, height: 180 } }} />}
        {active && !marquee.selecting && activeNode && !history.restoring && nodeEditorVisible(activeNode, previewFor(activeNode), !!expandedGroups[activeNode.id]) && <FloatingEditor node={activeNode} graph={graph} assets={assets} tasks={tasks} models={models} api={api} workspace={workspace}
          ttsConfigured={ttsConfigured} ttsConfigurationError={ttsConfigurationError}
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
    </div></CanvasTextSelectionProvider>
    <input ref={fileInput} type="file" multiple hidden onChange={(event) => { const files = [...event.target.files ?? []]; void (async () => { for (const file of files) await uploadFile(file) })() }} />
    {nodeDeletion.modal}
    {active && showSettings && <Modal label="无限画布" onClose={() => { setShowSettings(false); loadModels(); void reviewState.refresh() }}><CanvasSettings api={api} initialTab={settingsTab} onChanged={() => { loadModels(); void reviewState.refresh() }} /></Modal>}
    {active && reviewAsset && <SeedanceReviewDialog key={reviewAsset.id} asset={reviewAsset} onClose={() => setReviewAsset(undefined)}
      onSettings={() => { setReviewAsset(undefined); setSettingsTab('review'); setShowSettings(true) }} />}
    {active && showTasks && <TaskDialog api={api} onClose={() => setShowTasks(false)} />}
    {active && preview && (preview.kind === 'audio'
      ? <Modal label={preview.filename} onClose={() => setPreview(null)} wide><Media asset={preview} api={api} workspace={workspace} /></Modal>
      : <UiMediaModal label={preview.filename} onClose={() => setPreview(null)}>
        {preview.kind === 'image' ? <SignedImage className="dc-preview-image" api={api} canvas={workspace} assetId={preview.id} variant="original" alt={preview.filename} draggable={false} />
          : <VideoPlayer key={preview.id} src={api.media(workspace, preview.id)} api={api} canvas={workspace} assetId={preview.id} autoPlay preview label={preview.filename} />}
      </UiMediaModal>)}
  </div></CanvasSelectionContext.Provider></NodeLoadingContext.Provider></LoadingResolutionContext.Provider></ReviewContext.Provider>
}

interface EditorProps {
  node: CanvasNode; graph: CanvasGraph; assets: Asset[]; tasks: TaskSummary[]; models: readonly PublicModel[]; api: CanvasApi; workspace: string
  ttsConfigured: boolean | null; ttsConfigurationError: boolean
  nodeSize?: { width: number; height: number }; onResult: (id: string, assetId: string) => void
  patchNode: (id: string, fields: Partial<CanvasNode>) => void
  edit: (change: CanvasGraph | ((graph: CanvasGraph) => CanvasGraph)) => void
  report: (error: unknown) => void
  generate: (node: CanvasNode) => Promise<void>; uploading: boolean; submitting: boolean
  askImport: (kind: MediaKind, target?: string) => void
  taskAction: (task: TaskSummary, action: TaskAction) => Promise<void>; onOpen: (asset: Asset) => void
}
export function FloatingEditor(props: EditorProps) {
  const viewport = useViewport()
  const { node, graph, nodeSize, ...content } = props
  const liveGraph = useRef(graph)
  liveGraph.current = graph
  const getCurrentGraph = useCallback(() => liveGraph.current, [])
  const contentGraph = useRef<CanvasGraph>()
  contentGraph.current = shareEditorGraph(contentGraph.current, graph)
  const contentNode = useRef(node)
  if (!sameNodeContent(contentNode.current, node)) contentNode.current = node
  const position = nodeEditorPosition(node.position, viewport, nodeSize)
  return <div className={`dc-editor nodrag nopan nowheel ${isGeneration(node.kind) ? 'dc-generation-editor' : ''} ${node.kind === 'tts-generation' ? 'dc-tts-editor' : ''}`}
    style={position} onKeyDown={(event) => event.stopPropagation()}>
    <FloatingEditorContent {...content} node={contentNode.current} graph={contentGraph.current} getCurrentGraph={getCurrentGraph} />
  </div>
}

const FloatingEditorContent = memo(function FloatingEditorContent(props: Omit<EditorProps, 'nodeSize'> & { getCurrentGraph: () => CanvasGraph }) {
  const { node, graph, assets, tasks, models, api, workspace, patchNode, edit, generate, report, uploading, submitting, askImport, taskAction, onOpen } = props
  const promptEditor = useRef<MentionPromptEditorHandle>(null)
  const generation = isGeneration(node.kind)
  const model = models.find((item) => item.id === node.modelId)
  const references = graph.edges.filter((edge) => edge.target === node.id)
  const referenceAssets = references.map((edge) => assets.find((asset) => asset.id === edge.assetId)).filter((asset): asset is Asset => !!asset)
  const referenceIds = references.map((edge) => edge.assetId)
  const params = node.params && !isTtsParams(node.params) && model?.protocol === 'seedance-video' ? seedanceGenerationParams(node.params, referenceIds) : node.params
  const inputCaps = model && seedanceInputCapabilities(model, !isTtsParams(params) ? params : null)
  const promptReferences = useMemo(() => connectedPromptReferences(graph, node.id, assets), [graph, node.id, assets])
  const candidates = useMemo(() => inputCaps ? promptCandidates(graph, node.id, assets, tasks, inputCaps) : [], [graph, node.id, assets, tasks, model, node.params])
  const task = latestTask(node.id, tasks)
  if (node.kind === 'tts-generation') return <TtsEditor node={node} task={task} submitting={submitting} configured={props.ttsConfigured} configurationError={props.ttsConfigurationError}
      patchNode={patchNode} generate={generate} onError={report} />
  let reason = ''
  if (generation) {
    if (!model || !node.params || isTtsParams(node.params)) reason = '请选择模型'
    else if (!isMockModel(model) && !modelConfigured(model)) reason = '请前往设置页面配置模型'
    else try {
      const snapshot = { model: isMockModel(model) ? mockRecord(model.id) : ModelRecordSchema.parse({
        id: model.id, kind: model.kind, name: model.name, model_id: model.model_id, api_base: model.api_base, protocol: model.protocol,
        ...(model.endpoint_id ? { endpoint_id: model.endpoint_id } : {}),
      }), prompt: node.prompt, params: params as GenerationParams, referenceIds }
      if (isMockModel(model)) validateMockGeneration(snapshot, assets)
      else validateGeneration(snapshot, assets)
    } catch (error) { reason = error instanceof Error ? error.message : '输入无效' }
  }
  const asset = !generation ? assets.find((item) => item.id === node.assetId) : nodeResults(node.id, tasks, assets).find((item) => item.id === node.selectedResultId) ?? nodeResults(node.id, tasks, assets)[0]
  return <>
    {!generation && <div className="dc-editor-title"><label><UiInput value={node.title} aria-label="节点名称" maxLength={160} onChange={(event) => patchNode(node.id, { title: event.target.value || NodeLabels[node.kind] })} /></label><span>{NodeLabels[node.kind]}</span></div>}
    {generation ? <>
      <div className="dc-generation-actions">
        <UiButton variant="outline" disabled={uploading || submitting || (!!inputCaps && !inputCaps.referenceKinds.includes('image')) || (!!inputCaps && references.length >= inputCaps.maxReferences)} onClick={() => askImport('image', node.id)}>{uploading ? '导入中…' : '＋ 上传'}</UiButton>
      </div>
      <div className="dc-reference-row">
        {references.map((edge, index) => {
          const reference = assets.find((item) => item.id === edge.assetId)
          return <div className="dc-reference" key={edge.id} title={reference?.filename ?? '素材不可用'}>
            {reference?.kind === 'image' ? <SignedImage api={api} canvas={workspace} assetId={reference.id} alt={`参考图 ${index + 1}`} onClick={() => onOpen(reference)} /> : <span className="dc-reference-placeholder">{reference ? <MediaIcon kind={reference.kind} size={28} /> : '？'}</span>}
            {model?.protocol === 'seedance-video' && params && !isTtsParams(params) && params.videoMode === 'frames'
              ? <SeedanceFrameRole assetId={edge.assetId} index={index} referenceIds={referenceIds} params={params} disabled={submitting}
                onChange={(params) => patchNode(node.id, { params })} /> : <small>{index + 1}</small>}
            <UiButton disabled={submitting} className="dc-ui-remove-reference" aria-label={`移除引用 ${index + 1}`} onClick={() => edit((current) => ({ ...current, edges: current.edges.filter((item) => item.id !== edge.id) }))}>×</UiButton>
          </div>
        })}
        {!references.length && <small className="dc-muted">也可从素材节点拖入连线</small>}
      </div>
      <MentionPromptEditor key={node.id} ref={promptEditor} value={node.prompt} disabled={submitting}
        placeholder={node.kind === 'image-generation' ? '描述你想要生成的画面内容…' : '描述镜头、动作、场景与氛围…'}
        references={promptReferences} candidates={candidates} preview={(id) => api.preview(workspace, id)}
        onChange={(prompt) => patchNode(node.id, { prompt })} onError={report}
        onChoose={(item, prompt) => {
          if (!model || submitting) throw new Error('请先选择可用模型')
          const inserted = insertPromptReference(props.getCurrentGraph(), node.id, item, prompt, assets, tasks, inputCaps!)
          if (model.protocol === 'seedance-video' && params && !isTtsParams(params))
            validateSeedanceConnections(seedanceGenerationParams(params, inserted.graph.edges.filter((edge) => edge.target === node.id).map((edge) => edge.assetId)),
              inserted.graph.edges.filter((edge) => edge.target === node.id).map((edge) => assets.find((asset) => asset.id === edge.assetId)!), model.model_id)
          edit(inserted.graph)
          return inserted.reference
        }} />
      {reason && reason !== '请选择模型' && <small className="dc-validation">{reason}</small>}
      <div className="dc-editor-bottom">
        <ModelPicker disabled={submitting} value={node.modelId} models={models.filter((item) => item.kind === nodeMediaKind(node.kind))}
          onChange={(next) => patchNode(node.id, { modelId: next.id, params: next.model_id === model?.model_id ? node.params
            : { ...defaultParams(next), ...(next.protocol === 'seedance-video' && references.length ? { videoMode: 'reference' as const } : {}) } })} />
        {model?.capabilities.videoModes && params && !isTtsParams(params) && (references.length ? <UiSelect className="dc-video-mode" label="视频生成模式"
          value={params.videoMode ?? 'reference'} options={model.capabilities.videoModes.filter((mode) => mode.value !== 'text')} disabled={submitting} side="top"
          onChange={(mode) => {
            if (mode !== 'reference' && mode !== 'frames') return
            if ((params.videoMode ?? 'text') === mode) return
            const { firstFrameId: _first, lastFrameId: _last, ...rest } = params
            const next = seedanceFrameParams({ ...rest, videoMode: mode as GenerationParams['videoMode'],
              ...(mode === 'frames' && model.model_id.includes('-2-5-') ? { size: `${params.size.split('/')[0]}/adaptive` } : {}) }, referenceIds)
            try { validateSeedanceConnections(next, referenceAssets, model.model_id); patchNode(node.id, { params: next }) }
            catch (error) { report(error) }
          }} /> : <span className="dc-video-mode-auto" aria-label="视频生成模式：文生视频">文生视频</span>)}
        {model && params && !isTtsParams(params) && <GenerationParameters key={node.id} model={model} params={params} disabled={submitting} onChange={(params) => {
          try {
            if (model.protocol === 'seedance-video') validateSeedanceConnections(params, referenceAssets, model.model_id)
            patchNode(node.id, { params })
          } catch (error) { report(error) }
        }} />}
        <UiButton variant="primary" className="dc-ui-generate dc-generate-arrow" aria-label="生成" disabled={!!reason || submitting || uploading} title={reason || '生成'} onClick={() => { try { promptEditor.current?.flush(); void generate(node) } catch (error) { report(error) } }}>{submitting ? <span className="dc-spinner" /> : <svg width="20" height="20" viewBox="0 0 24 24" stroke="currentColor" fill="none" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6" /></svg>}</UiButton>
      </div>
    </> : <div className="dc-asset-editor"><p>{asset ? `${asset.filename} · ${formatBytes(asset.bytes)}` : '选择本地文件，素材会复制到插件的本机存储。'}</p><UiButton variant="outline" disabled={uploading} onClick={() => askImport(nodeMediaKind(node.kind))}>{uploading ? '导入中…' : '上传为新资源节点'}</UiButton></div>}
    {!generation && task && <TaskInformation api={api} canvas={workspace} task={task} action={taskAction} />}
    {!generation && asset && <div className="dc-result-actions"><UiButton onClick={() => onOpen(asset)}>{asset.kind === 'image' ? '查看大图' : '打开原文件'}</UiButton><a download href={api.media(workspace, asset.id, true)}>另存文件 ↓</a></div>}
  </>
})

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
