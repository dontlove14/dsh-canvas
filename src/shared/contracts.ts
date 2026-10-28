import { z } from 'zod'
import { resolvePrompt } from './promptMentions'
import { GPT_IMAGE_SIZES, IMAGE_BACKGROUNDS, IMAGE_QUALITIES, isGptImage25, bananaSizePresets, type ImageSizePreset } from './modelCatalog'

export const PLUGIN_ID = 'dsh-canvas'
export const API_ROOT = 'api/canvas'
export const KEY_MASK = '••••••••'

export const IdSchema = z.string().uuid()
export const WorkspaceIdSchema = z.string().min(1).max(512)
export const MediaKindSchema = z.enum(['image', 'video', 'audio'])
export type MediaKind = z.infer<typeof MediaKindSchema>
export const ModelKindSchema = z.enum(['image', 'video'])
export type ModelKind = z.infer<typeof ModelKindSchema>
export const ProtocolSchema = z.enum(['openai-image', 'openai-dalle-3', 'openai-dalle-2', 'openai-video', 'gemini-image'])
export type Protocol = z.infer<typeof ProtocolSchema>

const ApiBaseSchema = z.string().trim().url().max(2048).refine((value) => {
  const url = new URL(value)
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.hash && !url.search
}, 'api_base 必须是没有用户名、密码、查询参数和片段的 HTTP(S) 地址')

export const ModelRecordSchema = z.object({
  id: IdSchema,
  kind: ModelKindSchema,
  name: z.string().trim().min(1).max(120),
  model_id: z.string().trim().min(1).max(200),
  api_base: ApiBaseSchema,
  protocol: ProtocolSchema,
}).strict()
export type ModelRecord = z.infer<typeof ModelRecordSchema>

export const ModelInputSchema = ModelRecordSchema.omit({ id: true }).extend({
  id: IdSchema.optional(),
  api_key: z.string().max(4096).optional(),
}).strict().refine(
  (value) => (value.protocol === 'openai-video') === (value.kind === 'video'),
  '协议与模型类型不一致',
)
export type ModelInput = z.infer<typeof ModelInputSchema>

export interface ModelCapabilities {
  sizes: readonly string[]
  sizePresets?: readonly ImageSizePreset[]
  defaultSize?: string
  backgrounds?: readonly { value: string; label: string }[]
  qualities?: readonly { value: string; label: string }[]
  counts: readonly number[]
  seconds: readonly number[]
  /** Derived model metadata; not a persisted model or graph field. */
  secondsRange?: { min: number; max: number; step: number }
  referenceKinds: readonly MediaKind[]
  maxReferences: number
  supportsAudioToggle: boolean
}
export interface PublicModel extends ModelRecord {
  has_api_key: boolean
  api_key_mask: string
  capabilities: ModelCapabilities
  /** Legacy configuration is retained for historical tasks, not listed for new nodes. */
  configurable?: boolean
}

export const ProtocolLabels: Record<Protocol, string> = {
  'openai-image': 'OpenAI 兼容图片 · GPT Image',
  'openai-dalle-3': 'OpenAI 兼容图片 · DALL-E 3',
  'openai-dalle-2': 'OpenAI 兼容图片 · DALL-E 2',
  'openai-video': 'OpenAI 视频 · Sora',
  'gemini-image': 'Gemini 图片 · Nano Banana',
}

export function capabilitiesFor(model: Pick<ModelRecord, 'protocol' | 'model_id'>): ModelCapabilities {
  const noVideo = { seconds: [], supportsAudioToggle: false } as const
  if (isGptImage25(model)) return {
    ...noVideo, sizes: GPT_IMAGE_SIZES.map((item) => item.size), sizePresets: GPT_IMAGE_SIZES,
    counts: Array.from({ length: 10 }, (_, i) => i + 1), referenceKinds: ['image'], maxReferences: 16,
    backgrounds: IMAGE_BACKGROUNDS, qualities: IMAGE_QUALITIES,
  }
  switch (model.protocol) {
    case 'gemini-image': {
      const sizePresets = bananaSizePresets(model.model_id)
      return { ...noVideo, sizes: sizePresets.map((preset) => preset.size), sizePresets, defaultSize: '1024x1024',
        counts: [1], referenceKinds: ['image'], maxReferences: model.model_id === 'gemini-3.1-flash-lite-image' ? 1 : 14 }
    }
    case 'openai-image':
      return { ...noVideo, sizes: ['1024x1024', '1536x1024', '1024x1536'], counts: [1, 2, 4], referenceKinds: ['image'], maxReferences: 16 }
    case 'openai-dalle-3':
      return { ...noVideo, sizes: ['1024x1024', '1792x1024', '1024x1792'], counts: [1], referenceKinds: [], maxReferences: 0 }
    case 'openai-dalle-2':
      return { ...noVideo, sizes: ['256x256', '512x512', '1024x1024'], counts: [1, 2, 4], referenceKinds: [], maxReferences: 0 }
    case 'openai-video':
      return {
        sizes: model.model_id === 'sora-2-pro'
          ? ['1280x720', '720x1280', '1792x1024', '1024x1792']
          : ['1280x720', '720x1280'],
        counts: [1], seconds: [4, 8, 12], referenceKinds: ['image'], maxReferences: 1, supportsAudioToggle: false,
      }
  }
}

export const GenerationParamsSchema = z.object({
  size: z.string().max(32),
  n: z.number().int().min(1).max(10),
  seconds: z.number().int().optional(),
  background: z.enum(['auto', 'opaque', 'transparent']).optional(),
  quality: z.enum(['auto', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
}).strict()
export type GenerationParams = z.infer<typeof GenerationParamsSchema>
export const TtsParamsSchema = z.object({
  type: z.literal('tts'),
  reference_id: z.string().max(512).default(''),
  speed: z.number().finite().positive().default(1),
  volume: z.number().finite().default(0),
}).strict()
export type TtsParams = z.infer<typeof TtsParamsSchema>
export function defaultTtsParams(): TtsParams { return { type: 'tts', reference_id: '', speed: 1, volume: 0 } }
export function isTtsParams(params: GenerationParams | TtsParams | null): params is TtsParams { return !!params && 'type' in params && params.type === 'tts' }
export const FISH_TTS_ENDPOINT = 'https://api.modellink.online/fish/v1/tts'
export const FISH_TTS_MODEL = 's1'
export const TtsSettingsInputSchema = z.object({
  endpoint: ApiBaseSchema,
  revision: z.number().int().nonnegative(),
  api_key: z.string().max(4096).optional(),
}).strict()
export type TtsSettingsInput = z.infer<typeof TtsSettingsInputSchema>
export interface PublicTtsSettings { endpoint: string; revision: number; configured: boolean; has_api_key: boolean; api_key_mask: string }
export function defaultParams(model: Pick<ModelRecord, 'protocol' | 'model_id'> & { capabilities?: ModelCapabilities }): GenerationParams {
  const caps = model.capabilities ?? capabilitiesFor(model)
  const range = caps.secondsRange
  const seconds = range ? range.min > 0 ? range.min : range.min + (Math.floor(-range.min / range.step) + 1) * range.step : caps.seconds[0]
  return { size: caps.defaultSize ?? caps.sizes[0], n: caps.counts[0], ...(seconds !== undefined ? { seconds } : {}),
    ...(caps.backgrounds ? { background: 'auto' as const } : {}), ...(caps.qualities ? { quality: 'auto' as const } : {}) }
}

export function supportsVideoDuration(caps: ModelCapabilities, seconds: number | undefined): boolean {
  if (seconds === undefined || !Number.isFinite(seconds)) return false
  const range = caps.secondsRange
  if (!range) return caps.seconds.includes(seconds)
  const position = (seconds - range.min) / range.step
  return range.step > 0 && seconds >= range.min && seconds <= range.max && Math.abs(position - Math.round(position)) < 1e-9
}

export const NodeKindSchema = z.enum([
  'image-generation', 'video-generation', 'image-asset', 'video-asset', 'audio-asset', 'tts-generation',
])
export type NodeKind = z.infer<typeof NodeKindSchema>
export const NodeLabels: Record<NodeKind, string> = {
  'image-generation': '图片生成',
  'video-generation': '视频生成',
  'image-asset': '图片资源',
  'video-asset': '视频资源',
  'audio-asset': '音频资源',
  'tts-generation': '语音生成',
}
export function nodeMediaKind(kind: NodeKind): MediaKind {
  return kind === 'tts-generation' ? 'audio' : kind.split('-')[0] as MediaKind
}
export function isGeneration(kind: NodeKind): boolean {
  return kind.endsWith('-generation')
}

export const CanvasNodeSchema = z.object({
  id: IdSchema,
  kind: NodeKindSchema,
  title: z.string().trim().min(1).max(160),
  position: z.object({ x: z.number().finite(), y: z.number().finite() }).strict(),
  modelId: IdSchema.nullable().default(null),
  prompt: z.string().max(32000).default(''),
  params: z.union([GenerationParamsSchema, TtsParamsSchema]).nullable().default(null),
  assetId: IdSchema.nullable().default(null),
  selectedResultId: IdSchema.nullable().default(null),
}).strict().superRefine((node, ctx) => {
  if (node.kind === 'tts-generation') {
    if (!isTtsParams(node.params) || node.modelId || node.assetId) ctx.addIssue({ code: 'custom', message: '语音节点使用独立参数，不能选择模型或绑定输入素材' })
  } else if (isTtsParams(node.params)) ctx.addIssue({ code: 'custom', message: '语音参数只能用于语音节点' })
})
export type CanvasNode = z.infer<typeof CanvasNodeSchema>
export const CanvasEdgeSchema = z.object({
  id: IdSchema,
  source: IdSchema,
  target: IdSchema,
  assetId: IdSchema,
}).strict()
export type CanvasEdge = z.infer<typeof CanvasEdgeSchema>
export const CanvasGraphSchema = z.object({
  version: z.literal(1),
  nodes: z.array(CanvasNodeSchema),
  edges: z.array(CanvasEdgeSchema),
  viewport: z.object({ x: z.number().finite(), y: z.number().finite(), zoom: z.number().min(0.05).max(4) }).strict(),
}).strict()
export type CanvasGraph = z.infer<typeof CanvasGraphSchema>
export function emptyGraph(): CanvasGraph {
  return { version: 1, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }
}

export const AssetSchema = z.object({
  id: IdSchema,
  kind: MediaKindSchema,
  mime: z.string().max(100),
  filename: z.string().max(255),
  bytes: z.number().int().min(0),
  createdAt: z.number(),
  nodeId: IdSchema.nullable(),
  taskId: IdSchema.nullable(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  duration: z.number().nonnegative().optional(),
}).strict()
export type Asset = z.infer<typeof AssetSchema>

export const TaskStatusSchema = z.enum([
  'submitted', 'queued', 'generating', 'saving', 'completed',
  'failed', 'unknown', 'save_failed', 'abandoned',
])
export type TaskStatus = z.infer<typeof TaskStatusSchema>
export type TaskAction = 'retry-save' | 'resume-query' | 'abandon'
export const TaskStatusLabels: Record<TaskStatus, string> = {
  submitted: '已提交', queued: '排队中', generating: '生成中', saving: '结果保存中',
  completed: '成功', failed: '失败', unknown: '提交结果待确认', save_failed: '结果保存失败', abandoned: '本地等待已结束',
}
export const BUSY_STATUSES = new Set<TaskStatus>(['submitted', 'queued', 'generating', 'saving'])
export const TRACKED_STATUSES = new Set<TaskStatus>([...BUSY_STATUSES, 'unknown', 'save_failed'])

export const TaskSnapshotSchema = z.object({
  model: ModelRecordSchema,
  prompt: z.string().max(32000),
  params: GenerationParamsSchema,
  referenceIds: z.array(IdSchema),
}).strict()
export type TaskSnapshot = z.infer<typeof TaskSnapshotSchema>
export const TtsTaskSnapshotSchema = z.object({
  model: z.object({
    id: IdSchema, kind: z.literal('audio'), name: z.literal('FishTTS'),
    model_id: z.literal('fish-tts'), protocol: z.literal('fish-tts'), api_base: ApiBaseSchema,
  }).strict(),
  prompt: z.string().max(32000),
  params: TtsParamsSchema,
  referenceIds: z.array(IdSchema).length(0),
}).strict()
export type TtsTaskSnapshot = z.infer<typeof TtsTaskSnapshotSchema>
export type AnyTaskSnapshot = TaskSnapshot | TtsTaskSnapshot
export function isTtsSnapshot(snapshot: AnyTaskSnapshot): snapshot is TtsTaskSnapshot { return snapshot.model.protocol === 'fish-tts' }
export function validateTtsText(text: string): void { if (!text.trim() || !text.replace(/\([^)]*\)/g, '').trim()) throw new Error('请输入要朗读的文字') }
export const TaskSchema = z.object({
  id: IdSchema,
  nodeId: IdSchema,
  workspaceId: WorkspaceIdSchema,
  status: TaskStatusSchema,
  snapshot: z.union([TaskSnapshotSchema, TtsTaskSnapshotSchema]),
  providerTaskId: z.string().max(512).optional(),
  progress: z.number().min(0).max(100).optional(),
  resultIds: z.array(IdSchema),
  error: z.string().max(1000).optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
}).strict()
export type Task = z.infer<typeof TaskSchema>

export const WorkspaceStateSchema = z.object({
  version: z.literal(1),
  workspaceId: WorkspaceIdSchema,
  graphRevision: z.number().int().nonnegative(),
  graph: CanvasGraphSchema,
  assets: z.array(AssetSchema),
  tasks: z.array(TaskSchema),
  updatedAt: z.number(),
}).strict()
export type WorkspaceState = z.infer<typeof WorkspaceStateSchema>
export interface ModelsResponse { models: PublicModel[] }
export interface ErrorResponse { error: string; code: string }

/** Result selection changes the preview; edges bind a concrete immutable asset. */
export function nodeResults(nodeId: string, tasks: readonly Pick<Task, 'nodeId' | 'resultIds'>[], assets: readonly Asset[]): Asset[] {
  const latest = [...tasks].reverse().find((task) => task.nodeId === nodeId && task.resultIds.length > 0)
  if (!latest) return []
  const byId = new Map(assets.map((asset) => [asset.id, asset]))
  return latest.resultIds.map((id) => byId.get(id)).filter((asset): asset is Asset => asset !== undefined)
}
export function latestTask<T extends Pick<Task, 'nodeId'>>(nodeId: string, tasks: readonly T[]): T | undefined {
  return [...tasks].reverse().find((task) => task.nodeId === nodeId)
}

export function validateGeneration(snapshot: TaskSnapshot, assets: readonly Asset[]): void {
  validateWithCapabilities(snapshot, assets, capabilitiesFor(snapshot.model))
}
export function validateWithCapabilities(snapshot: TaskSnapshot, assets: readonly Asset[], caps: ModelCapabilities): void {
  if (!snapshot.prompt.trim()) throw new Error('请输入提示词')
  resolvePrompt(snapshot.prompt, snapshot.referenceIds, assets)
  if (!caps.sizes.includes(snapshot.params.size)) throw new Error('请选择当前模型支持的尺寸')
  if (!caps.counts.includes(snapshot.params.n)) throw new Error('当前模型不支持这个生成数量')
  if (snapshot.params.background && !caps.backgrounds?.some((item) => item.value === snapshot.params.background)) throw new Error('当前模型不支持这个背景')
  if (snapshot.params.quality && !caps.qualities?.some((item) => item.value === snapshot.params.quality)) throw new Error('当前模型不支持这个画质')
  if (snapshot.model.kind === 'video') {
    if (!supportsVideoDuration(caps, snapshot.params.seconds)) throw new Error('请选择当前模型支持的视频时长')
    if (snapshot.params.seconds! <= 0) throw new Error('视频时长需大于 0 秒')
  }
  if (snapshot.referenceIds.length > caps.maxReferences) throw new Error(`当前模型最多接受 ${caps.maxReferences} 份参考素材`)
  if (new Set(snapshot.referenceIds).size !== snapshot.referenceIds.length) throw new Error('不能重复引用同一素材')
  const byId = new Map(assets.map((asset) => [asset.id, asset]))
  for (const id of snapshot.referenceIds) {
    const asset = byId.get(id)
    if (!asset) throw new Error('参考素材已丢失，请重新导入')
    if (!caps.referenceKinds.includes(asset.kind)) throw new Error('当前模型不支持此类型的参考素材')
    if (asset.kind === 'image' && !['image/png', 'image/jpeg', 'image/webp'].includes(asset.mime))
      throw new Error('当前协议的参考图仅支持 PNG、JPEG 和 WebP')
  }
}

export function validateGraph(graph: CanvasGraph, assets: readonly Asset[], tasks: readonly Pick<Task, 'nodeId' | 'resultIds'>[]): void {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]))
  if (nodes.size !== graph.nodes.length) throw new Error('画布包含重复节点')
  if (new Set(graph.edges.map((edge) => edge.id)).size !== graph.edges.length) throw new Error('画布包含重复连线')
  const byId = new Map(assets.map((asset) => [asset.id, asset]))
  const seen = new Set<string>()
  const adjacency = new Map<string, string[]>()
  for (const edge of graph.edges) {
    const source = nodes.get(edge.source)
    const target = nodes.get(edge.target)
    const asset = byId.get(edge.assetId)
    if (!source || !target || !asset) throw new Error('连线引用的节点或素材不可用')
    if (target.kind === 'tts-generation') throw new Error('语音生成节点不支持输入连线')
    if (!isGeneration(target.kind) || source.id === target.id) throw new Error('连线只能连接到其他生成节点')
    const fromSource = isGeneration(source.kind)
      ? tasks.some((task) => task.nodeId === source.id && task.resultIds.includes(asset.id))
      : source.assetId === asset.id
    if (!fromSource) throw new Error('引用的素材不属于上游节点')
    const key = `${target.id}:${asset.id}`
    if (seen.has(key)) throw new Error('不能重复引用同一素材')
    seen.add(key)
    adjacency.set(source.id, [...adjacency.get(source.id) ?? [], target.id])
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error('连线不能形成循环')
    if (visited.has(id)) return
    visiting.add(id)
    for (const target of adjacency.get(id) ?? []) visit(target)
    visiting.delete(id)
    visited.add(id)
  }
  for (const id of nodes.keys()) visit(id)
}
