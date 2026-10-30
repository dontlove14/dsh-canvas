import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ReactFlow, ReactFlowProvider, Background, BackgroundVariant, Controls, MiniMap,
  useReactFlow, useViewport, useStoreApi, ViewportPortal, getBezierPath, Position, ConnectionLineType, SelectionMode, type Node, type NodeProps, type NodeChange,
} from '@xyflow/react'
import {
  NodeLabels, defaultParams, isGeneration, nodeMediaKind, nodeResults, latestTask,
  TaskStatusLabels, isTtsParams,
  validateGeneration, ModelRecordSchema,
  type CanvasNode, type CanvasGraph, type Asset, type PublicModel, type MediaKind, type TaskAction, type GenerationParams,
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
import { UiActionMenu, UiButton, UiInput, UiModal as Modal, UiMediaModal, UiSelect, UiPointMenu } from './ui'
import { canvasScrollGestures, useCanvasActionBarGestures } from './gestures'
import { VideoPlayer } from './VideoPlayer'
import { mockRecord, validateMockGeneration } from '../shared/mockModels'
import { isMockModel } from '../shared/mockModels'
import { builtinDefinition } from '../shared/modelCatalog'
import { ModelPicker, selectableModels } from './ModelPicker'
import { GenerationNode } from './GenerationNode'
import { GenerationParameters } from './GenerationParameters'
import { CanvasHandle } from './CanvasHandle'
import { generationFrame, nodeEditorVisible } from './generationLayout'
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
import { generationHistory, historyFrame, historyEditorAnchor, resultHandle, type GenerationCard } from './generationHistory'
import { useGenerationSubmission } from './useGenerationSubmission'
import { useHistoryInspection, type HistoryInspection } from './useHistoryInspection'
import { GenerationSnapshotEditor } from './GenerationSnapshotEditor'
import { sameFields, sameNodeContent, shareEditorGraph, shareItems } from './canvasSharing'
import { createCanvasProjection, EMPTY_PROJECTION } from './canvasProjection'
import { seedanceFrameParams } from '../shared/seedance'
import { isMultimodalVideo } from '../shared/modelCatalog'
import { normalizeVideoGraphReferences, videoGenerationParams, videoInputCapabilities, validateVideoConnections } from '../shared/video'
import { SeedanceFrameRole } from './SeedanceFrameRoles'
import { CanvasReviewState, ReviewContext } from './reviewState'
import { SeedanceReviewDialog } from './SeedanceReviewDialog'
import { CanvasTextSelectionProvider } from './canvasTextSelection'
import { useNodeDeleteConfirmation } from './useNodeDeleteConfirmation'
import type { UploadActivity } from './resumableUploads'
import { UploadCapsules } from './UploadCapsules'
import { NotificationCapsules } from './NotificationCapsules'
import { useCanvasFileDrop } from './canvasFileDrop'
import { CREATABLE_NODES, createCanvasNode, type CreatableNodeKind } from './nodeCreation'
import { useNodeCreationMenu } from './useNodeCreationMenu'
import { selectionDownloads, selectionOutputs } from './selectionOutputs'
import { SelectionNode, selectionFrame, type SelectionFlowNode } from './SelectionNode'
import { useCanvasConnections } from './useCanvasConnections'
import { KeyboardGuide, Modifier, isMacPlatform } from './KeyboardGuide'
import { useCanvasNodeClipboard, nativeClipboardTarget } from './useCanvasNodeClipboard'
import { blankCanvasPoint } from './useNodeCreationMenu'

const EMPTY_TASKS: TaskSummary[] = []
const EMPTY_ASSETS: Asset[] = []
const EMPTY_CARDS: GenerationCard[] = []

export function CanvasApp({ api, active = true }: { api: CanvasApi; active?: boolean }) {
  const [workspace, setWorkspace] = useState<CanvasChoice | null>(null)
  const [folder, setFolder] = useState('all')
  useEffect(() => { void api.resumeUploads().catch(() => {}) }, [api])
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
type CanvasFlowNode = FlowNode | SelectionFlowNode
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
const nodeTypes = { media: MediaNode, selection: SelectionNode }
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
    editGraph((previous) => normalizeVideoGraphReferences(previous, typeof change === 'function' ? change(previous) : change, configuredModels))
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
  const [preparingUploads, setPreparingUploads] = useState(0)
  const [uploadActivity, setUploadActivity] = useState<UploadActivity[]>([])
  useEffect(() => {
    const update = () => setUploadActivity(api.uploads.activities(workspace))
    update()
    return api.uploads.subscribe(update)
  }, [api, workspace])
  const uploading = preparingUploads > 0 || uploadActivity.length > 0
  const [showTasks, setShowTasks] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const container = useRef<HTMLDivElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const importIntent = useRef<{ kind: MediaKind; target?: string } | null>(null)
  const flow = useReactFlow<CanvasFlowNode, RelationshipFlowEdge>()
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
  const nodeDeletion = useNodeDeleteConfirmation<CanvasFlowNode, RelationshipFlowEdge>({
    active, pageVisible, workspace, submitting, tasks, nodes: graph.nodes, edges: graph.edges, container, report,
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
  const flowEnabled = active && pageVisible && !marquee.selecting
  const flowingNodeId = flowEnabled ? activeNode?.id ?? null : null
  const flowingSelectedEdges = flowEnabled && selected.length === 0
  const edges = useMemo(() => relationshipEdges(baseEdges, flowingNodeId, flowingSelectedEdges), [baseEdges, flowingNodeId, flowingSelectedEdges])
  const selectionId = `selection:${workspace}`
  const onNodesChange = useCallback((allChanges: NodeChange<CanvasFlowNode>[]) => {
    const changes = allChanges.filter((change) => !('id' in change) || change.id !== selectionId)
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
  }, [edit, marquee.blocksNativeSelection, selectionId])
  const creationEnvironment = useMemo(() => ({ assets, tasks, models, expandedGroups }), [assets, tasks, models, expandedGroups])
  const selectCreated = useCallback((id: string) => { setSelected([id]); setSelectedEdges([]); setPlayingNode(null) }, [])
  const interactionEnabled = active && pageVisible && !!state && !showSettings && !showTasks && !preview && !reviewAsset && !nodeDeletion.modal && !leaving
  const creation = useNodeCreationMenu({
    container, enabled: interactionEnabled,
    workspace, graph, getGraph: canvas.getGraph, environment: creationEnvironment, screenToFlowPosition: flow.screenToFlowPosition,
    edit, onCreated: selectCreated, report,
  })
  const connections = useCanvasConnections({ container, enabled: interactionEnabled, workspace, selectionId, selected,
    environment: creationEnvironment, getGraph: canvas.getGraph, edit, report, creation })
  const downloads = useMemo(() => selectionDownloads(graph, selected, creationEnvironment), [graph, selected, creationEnvironment])
  const downloadSelected = useCallback(() => {
    for (const asset of downloads) {
      const link = document.createElement('a'); link.href = api.media(workspace, asset.id, true); link.download = asset.filename; link.click()
    }
  }, [downloads, api, workspace])
  const group = useMemo(() => interactionEnabled && !marquee.selecting ? selectionFrame(nodes, selectionId, {
    ids: selected, connectable: selectionOutputs(graph, selected, creationEnvironment).length > 0,
    downloadable: downloads.length > 0, onDownload: downloadSelected,
  }) : undefined, [interactionEnabled, marquee.selecting, nodes, selectionId, selected, graph, creationEnvironment, downloads.length, downloadSelected])
  const selectPasted = useCallback((ids: string[]) => { setSelected(ids); setSelectedEdges([]); setPlayingNode(null) }, [])
  const clipboard = useCanvasNodeClipboard({
    container, enabled: interactionEnabled, workspace, selected, environment: creationEnvironment,
    getGraph: canvas.getGraph, getSizes: () => nodes, screenToFlowPosition: flow.screenToFlowPosition,
    // Clipboard inputs were validated as a whole; do not infer modes through empty old references.
    edit: editGraph, select: selectPasted, report, notifySuccess: canvas.notifySuccess, closeCreation: creation.close,
  })
  const copyAt = (event: React.MouseEvent | MouseEvent, ids: string[]) => {
    if (!interactionEnabled || nativeClipboardTarget(event.target)) return
    event.preventDefault(); event.stopPropagation()
    clipboard.showCopy({ x: event.clientX, y: event.clientY }, ids)
  }
  const paneContextMenu = (event: React.MouseEvent | MouseEvent) => {
    const screen = blankCanvasPoint(container.current, event)
    if (!screen || !interactionEnabled) return
    const position = flow.screenToFlowPosition(screen)
    if (group && position.x >= group.position.x && position.x <= group.position.x + group.width!
      && position.y >= group.position.y && position.y <= group.position.y + group.height!) {
      copyAt(event, selected); return
    }
    creation.onPaneContextMenu(event); clipboard.probePaste(screen)
  }
  const shortcut = (key: string) => <><Modifier mac={isMacPlatform()} /><span>{key}</span></>
  const clipboardIcon = (paste: boolean) => <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {paste ? <><path d="M9 5H6a2 2 0 0 0-2 2v13h16V7a2 2 0 0 0-2-2h-3" /><rect x="9" y="3" width="6" height="4" rx="1" /></>
      : <><rect x="8" y="8" width="12" height="13" rx="2" /><path d="M16 8V3H3v13h5" /></>}
  </svg>
  const flowNodes = useMemo<CanvasFlowNode[]>(() => group ? [...nodes, group] : nodes, [nodes, group])
  const addNode = (kind: CreatableNodeKind) => {
    creation.close(); clipboard.close()
    const rect = container.current?.getBoundingClientRect()
    const position = flow.screenToFlowPosition({ x: (rect?.left ?? 0) + (rect?.width ?? 900) / 2 - 150, y: (rect?.top ?? 0) + (rect?.height ?? 600) / 2 - 150 })
    edit((current) => {
      const result = createCanvasNode(current, kind, position, creationEnvironment)
      selectCreated(result.node.id)
      return result.graph
    })
  }
  const askImport = useCallback((kind: MediaKind, target?: string) => {
    importIntent.current = { kind, target }
    if (fileInput.current) { fileInput.current.accept = `${kind}/*`; fileInput.current.value = ''; fileInput.current.click() }
  }, [])
  const uploadFile = async (file: File, point?: { x: number; y: number }) => {
    const guessed = file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : file.type.startsWith('audio/') ? 'audio' : undefined
    const intent = importIntent.current ?? (guessed ? { kind: guessed } : null)
    if (!intent) { report(new Error('请选择图片、视频或音频文件')); return }
    setPreparingUploads((count) => count + 1)
    try {
      await canvas.flush()
      const target = graph.nodes.find((node) => node.id === intent.target)
      const rect = container.current?.getBoundingClientRect()
      const position = point ?? (target ? { x: target.position.x - 420, y: target.position.y } : flow.screenToFlowPosition({ x: (rect?.left ?? 0) + 200, y: (rect?.top ?? 0) + 170 }))
      const result = await api.upload(workspace, file, intent.kind, position, canvas.refresh, undefined, target?.id)
      await canvas.refresh()
      setSelected([result.nodeId])
    } catch (error) { report(error) }
    finally { setPreparingUploads((count) => count - 1) }
  }
  useCanvasFileDrop(container, active && pageVisible, (files, screenPoint) => {
    importIntent.current = null
    const point = flow.screenToFlowPosition(screenPoint)
    for (const [i, file] of files.entries()) void uploadFile(file, { x: point.x + i * 350, y: point.y })
  })
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
      data-selection-group={!!group}
      onPointerDownCapture={(event) => {
        // Portal events still traverse this React ancestor before the menu row.
        if (event.target instanceof Element && event.target.closest('.dc-node-creation-menu')) return
        creation.close(); clipboard.close()
        if (event.target instanceof HTMLElement && event.target.closest('.react-flow__pane')) event.currentTarget.focus({ preventScroll: true })
        marquee.onPointerDownCapture(event)
      }} onPointerUpCapture={marquee.onPointerUpCapture}
      onPointerUp={marquee.onPointerUp} onPointerCancel={() => { connections.clear(); creation.close(); clipboard.close(); marquee.onPointerCancel() }}
    >
      {!state ? <div className="dc-loading">载入本地画布…</div> : <ReactFlow<CanvasFlowNode, RelationshipFlowEdge>
        nodes={flowNodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} defaultEdgeOptions={edgeOptions} connectionLineType={ConnectionLineType.Bezier}
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
        onConnect={connections.onConnect} onConnectStart={connections.onConnectStart} onConnectEnd={connections.onConnectEnd}
        onPaneContextMenu={paneContextMenu} onMoveStart={() => { creation.close(); clipboard.close() }}
        onNodeContextMenu={(event, node) => {
          if (node.type === 'media') copyAt(event, selected.includes(node.id) ? selected : [node.id])
        }}
        onSelectionContextMenu={(event) => copyAt(event, selected)}
        defaultViewport={graph.viewport} minZoom={0.1} maxZoom={2.5}
        onMoveEnd={(_event, viewport) => edit((current) => ({ ...current, viewport }))}
        onPaneClick={() => { setSelected([]); setSelectedEdges([]); setPlayingNode(null) }}
        onEdgeClick={() => { container.current?.focus({ preventScroll: true }); setSelected([]); setPlayingNode(null) }}
        onNodeClick={(_event, node) => {
          if (node.type !== 'media') return
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
        <Controls showInteractive={false} fitViewOptions={{ nodes: nodes.map((node) => ({ id: node.id })) }} />
        <MiniMap pannable zoomable nodeColor={(node) => node.type === 'selection' ? 'transparent' : 'var(--dc-accent)'} maskColor="var(--dc-minimap-mask)" />
        {creation.menu?.reference && creation.menu.from && <ViewportPortal><svg className="dc-pending-connection" width="1" height="1" aria-hidden="true">
          <path d={getBezierPath({ sourceX: creation.menu.from.x, sourceY: creation.menu.from.y, sourcePosition: Position.Right,
            targetX: creation.menu.position.x, targetY: creation.menu.position.y, targetPosition: Position.Left })[0]}
            fill="none" stroke="var(--dc-accent)" strokeWidth="1.7" strokeDasharray="5 4" />
        </svg></ViewportPortal>}
        {active && pageVisible && !marquee.selecting && activeNode && (inspectionAnchor || history.restoring) &&
          <GenerationSnapshotEditor api={api} workspace={workspace} snapshot={history.snapshot} assets={assets} error={history.error} restoring={history.restoring}
            anchor={inspectionAnchor ?? { position: activeNode.position, size: mediaSizes[activeNode.id] ?? { width: 320, height: 180 } }} />}
        {active && !marquee.selecting && activeNode && !history.restoring && nodeEditorVisible(activeNode, previewFor(activeNode), !!expandedGroups[activeNode.id]) && <FloatingEditor node={activeNode} graph={graph} assets={assets} tasks={tasks} models={models} api={api} workspace={workspace}
          ttsConfigured={ttsConfigured} ttsConfigurationError={ttsConfigurationError}
          nodeSize={mediaSizes[activeNode.id]} onResult={onResult}
          patchNode={patchNode} edit={edit} generate={generate} report={report} uploading={false} submitting={submitting}
          askImport={askImport} taskAction={taskAction} onOpen={onOpen} />}
      </ReactFlow>}
      <div className="dc-canvas-capsules">
        <NotificationCapsules notifications={canvas.notifications} active={active && pageVisible} onDismiss={canvas.dismissNotification} />
        <UploadCapsules uploads={uploadActivity} />
      </div>
      {creation.menu && <UiPointMenu label={creation.menu.reference ? '引用该节点生成' : '添加节点'} point={creation.menu.screen}
        bounds={() => container.current?.getBoundingClientRect()} onClose={() => { creation.close(true); clipboard.close() }}
        onSelect={(kind) => {
          if (kind === 'paste') void clipboard.paste()
          else { clipboard.close(); creation.choose(kind as CreatableNodeKind) }
        }}
        items={[...creation.choices.map((entry) => ({ id: entry.kind, label: NodeLabels[entry.kind],
          icon: entry.icon === 'tts' ? <TtsIcon size={20} /> : <MediaIcon kind={entry.icon} size={20} />,
          disabled: entry.disabled, disabledReason: entry.disabledReason, onSelect: () => creation.choose(entry.kind) })),
          ...(!creation.menu.reference ? [{ id: 'paste', label: '粘贴', icon: clipboardIcon(true), shortcut: shortcut('V'),
            disabled: !!clipboard.pasteStatus, disabledReason: clipboard.pasteStatus, onSelect: () => void clipboard.paste() }] : [])]} />}
      {clipboard.menu && <UiPointMenu label="节点操作" point={clipboard.menu.screen}
        bounds={() => container.current?.getBoundingClientRect()} onClose={() => clipboard.close(true)}
        onSelect={() => void clipboard.copy()}
        items={[{ id: 'copy', label: '复制', icon: clipboardIcon(false), shortcut: shortcut('C'), onSelect: () => void clipboard.copy() }]} />}
      {state && !graph.nodes.length && <div className="dc-welcome"><span className="dc-welcome-symbol">✦</span><h1>从一个想法开始</h1><p>创建生成节点，或者导入你的素材。<br />连接参考图，让每一步创作都有迹可循。</p><div><UiButton variant="primary" onClick={() => addNode('image-generation')}><MediaIcon kind="image" size={22} />图片生成</UiButton><UiButton variant="outline" onClick={() => addNode('video-generation')}><MediaIcon kind="video" size={22} />视频生成</UiButton></div></div>}
      <div className="dc-tools"><UiActionMenu label="添加节点" variant="primary" disabled={!active || !state} side="top" gap={14}
        items={CREATABLE_NODES.map(({ kind, icon }) => ({ id: kind, label: NodeLabels[kind], icon: icon === 'tts' ? <TtsIcon size={22} /> : <MediaIcon kind={icon} size={22} />, onSelect: () => addNode(kind) }))}>＋ 添加节点</UiActionMenu><span className="dc-tool-divider" />
        <UiButton disabled={!state} onClick={() => { importIntent.current = null; if (fileInput.current) { fileInput.current.accept = 'image/*,video/*,audio/*'; fileInput.current.value = ''; fileInput.current.click() } }}>上传素材</UiButton>
        <UiButton title="保存画布" onClick={() => void canvas.flush().catch(() => {})}>保存</UiButton>
        <span className="dc-node-count">{graph.nodes.length} 节点</span>
        <span className="dc-tool-divider" /><KeyboardGuide enabled={interactionEnabled} container={container} />
      </div>
      {canvas.conflict && <div className="dc-conflict"><strong>画布保存冲突，当前草稿仍保留</strong><UiButton variant="outline" onClick={() => downloadJson('canvas-draft.json', graph)}>导出草稿</UiButton><UiButton variant="outline" onClick={() => { if (window.confirm('重新载入将替换当前未保存草稿，请先导出。')) void canvas.reload().catch(report) }}>重新载入</UiButton></div>}
    </div></CanvasTextSelectionProvider>
    <input ref={fileInput} type="file" multiple hidden onChange={(event) => { const files = [...event.target.files ?? []]; for (const file of files) void uploadFile(file); importIntent.current = null }} />
    {nodeDeletion.modal}
    {active && showSettings && <Modal label="无限画布" className="dc-settings-modal" onClose={() => { setShowSettings(false); loadModels(); void reviewState.refresh() }}><CanvasSettings api={api} showTitle={false} initialTab={settingsTab} onChanged={() => { loadModels(); void reviewState.refresh() }} /></Modal>}
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
  const params = node.params && !isTtsParams(node.params) && model && isMultimodalVideo(model) ? videoGenerationParams(node.params, referenceIds, model) : node.params
  const inputCaps = model && videoInputCapabilities(model, !isTtsParams(params) ? params : null)
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
      {references.length > 0 && <div className="dc-reference-row">
        {references.map((edge, index) => {
          const reference = assets.find((item) => item.id === edge.assetId)
          return <div className="dc-reference" key={edge.id} title={reference?.filename ?? '素材不可用'}>
            {reference?.kind === 'image' ? <SignedImage api={api} canvas={workspace} assetId={reference.id} alt={`参考图 ${index + 1}`} onClick={() => onOpen(reference)} /> : <span className="dc-reference-placeholder">{reference ? <MediaIcon kind={reference.kind} size={28} /> : '？'}</span>}
            {model && isMultimodalVideo(model) && params && !isTtsParams(params) && params.videoMode === 'frames'
              ? <SeedanceFrameRole assetId={edge.assetId} index={index} referenceIds={referenceIds} params={params} disabled={submitting}
                onChange={(params) => patchNode(node.id, { params })} /> : <small>{index + 1}</small>}
            <UiButton disabled={submitting} className="dc-ui-remove-reference" aria-label={`移除引用 ${index + 1}`} onClick={() => edit((current) => ({ ...current, edges: current.edges.filter((item) => item.id !== edge.id) }))}>×</UiButton>
          </div>
        })}
      </div>}
      <MentionPromptEditor key={node.id} ref={promptEditor} value={node.prompt} disabled={submitting}
        placeholder={node.kind === 'image-generation' ? '描述你想要生成的画面内容…' : '描述镜头、动作、场景与氛围…'}
        references={promptReferences} candidates={candidates} preview={(id) => api.preview(workspace, id)}
        onChange={(prompt) => patchNode(node.id, { prompt })} onError={report}
        onChoose={(item, prompt) => {
          if (!model || submitting) throw new Error('请先选择可用模型')
          const inserted = insertPromptReference(props.getCurrentGraph(), node.id, item, prompt, assets, tasks, inputCaps!)
          if (isMultimodalVideo(model) && params && !isTtsParams(params))
            validateVideoConnections(videoGenerationParams(params, inserted.graph.edges.filter((edge) => edge.target === node.id).map((edge) => edge.assetId), model),
              inserted.graph.edges.filter((edge) => edge.target === node.id).map((edge) => assets.find((asset) => asset.id === edge.assetId)!), model)
          edit(inserted.graph)
          return inserted.reference
        }} />
      {reason && reason !== '请选择模型' && <small className="dc-validation">{reason}</small>}
      <div className="dc-editor-bottom">
        <ModelPicker disabled={submitting} value={node.modelId} models={models.filter((item) => item.kind === nodeMediaKind(node.kind))}
          onChange={(next) => patchNode(node.id, { modelId: next.id, params: next.model_id === model?.model_id ? node.params
            : { ...defaultParams(next), ...(isMultimodalVideo(next) && references.length ? { videoMode: 'reference' as const } : {}) } })} />
        {model?.capabilities.videoModes && params && !isTtsParams(params) && (references.length ? <UiSelect className="dc-video-mode" label="视频生成模式"
          value={params.videoMode ?? 'reference'} options={model.capabilities.videoModes.filter((mode) => mode.value !== 'text')} disabled={submitting} side="top"
          onChange={(mode) => {
            if (mode !== 'reference' && mode !== 'frames') return
            if ((params.videoMode ?? 'text') === mode) return
            const { firstFrameId: _first, lastFrameId: _last, ...rest } = params
            const next = videoGenerationParams({ ...rest, videoMode: mode as GenerationParams['videoMode'],
              ...(mode === 'frames' && model.protocol === 'seedance-video' && model.model_id.includes('-2-5-') ? { size: `${params.size.split('/')[0]}/adaptive` } : {}) }, referenceIds, model)
            try { validateVideoConnections(next, referenceAssets, model); patchNode(node.id, { params: next }) }
            catch (error) { report(error) }
          }} /> : <span className="dc-video-mode-auto" aria-label="视频生成模式：文生视频">文生视频</span>)}
        {model && params && !isTtsParams(params) && <GenerationParameters key={node.id} model={model} params={params} disabled={submitting} onChange={(params) => {
          try {
            if (isMultimodalVideo(model)) validateVideoConnections(params, referenceAssets, model)
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
