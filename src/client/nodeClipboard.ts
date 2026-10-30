import { z } from 'zod'
import {
  CanvasNodeSchema, CanvasEdgeSchema, IdSchema, WorkspaceIdSchema, isGeneration, isTtsParams,
  nodeMediaKind, validateGraph, type CanvasGraph, type CanvasNode,
} from '../shared/contracts'
import { isMultimodalVideo } from '../shared/modelCatalog'
import { validateVideoConnections, videoInputCapabilities } from '../shared/video'
import type { CanvasPoint, NodeCreationEnvironment } from './nodeCreation'

const PointSchema = z.object({ x: z.number().finite(), y: z.number().finite() }).strict()
const PacketSchema = z.object({
  type: z.literal('dsh-canvas/nodes'), version: z.literal(1), id: IdSchema,
  origin: z.string().min(1).max(2048), workspace: WorkspaceIdSchema,
  bounds: PointSchema.extend({ width: z.number().finite().nonnegative(), height: z.number().finite().nonnegative() }),
  nodes: z.array(CanvasNodeSchema).min(1).max(10000),
  edges: z.array(CanvasEdgeSchema).max(20000),
}).strict()
export type NodeClipboardPacket = z.infer<typeof PacketSchema>
const MAX_TEXT = 8 * 1024 * 1024
const withinLimit = (text: string) => text.length <= MAX_TEXT && new TextEncoder().encode(text).byteLength <= MAX_TEXT

/** The OS clipboard contains only graph inputs; tasks and rendered data never enter it. */
export function copyCanvasNodes(graph: CanvasGraph, ids: readonly string[], workspace: string, origin: string,
  sizes: readonly { id: string; width?: number; height?: number }[] = []): string {
  const selected = new Set(ids), dimensions = new Map(sizes.map((node) => [node.id, node]))
  const nodes = graph.nodes.filter((node) => selected.has(node.id)).map((node): CanvasNode => ({
    id: node.id, kind: node.kind, title: node.title, position: { ...node.position },
    modelId: node.modelId, prompt: node.prompt, params: node.params,
    assetId: isGeneration(node.kind) ? null : node.assetId, selectedResultId: null,
  }))
  if (!nodes.length) throw new Error('请先选中要复制的节点')
  const copied = new Set(nodes.map((node) => node.id))
  const x = Math.min(...nodes.map((node) => node.position.x)), y = Math.min(...nodes.map((node) => node.position.y))
  const right = Math.max(...nodes.map((node) => node.position.x + (dimensions.get(node.id)?.width ?? 320)))
  const bottom = Math.max(...nodes.map((node) => node.position.y + (dimensions.get(node.id)?.height ?? 265)))
  const packet = PacketSchema.parse({
    type: 'dsh-canvas/nodes', version: 1, id: crypto.randomUUID(), origin, workspace,
    bounds: { x, y, width: right - x, height: bottom - y }, nodes,
    edges: graph.edges.filter((edge) => copied.has(edge.target)).map((edge) => ({
      id: edge.id, source: edge.source, target: edge.target, assetId: edge.assetId,
    })),
  })
  const text = JSON.stringify(packet)
  if (!withinLimit(text)) throw new Error('选中内容过大，请分批复制')
  return text
}

export function readCanvasNodes(text: string, workspace: string, origin: string): NodeClipboardPacket {
  if (!text || !withinLimit(text)) throw new Error('剪贴板中没有可粘贴的画布节点')
  let packet: NodeClipboardPacket
  try { packet = PacketSchema.parse(JSON.parse(text)) }
  catch { throw new Error('剪贴板中没有可粘贴的画布节点') }
  if (packet.workspace !== workspace || packet.origin !== origin) throw new Error('节点只能粘贴到原画布')
  const ids = new Set(packet.nodes.map((node) => node.id))
  if (ids.size !== packet.nodes.length || new Set(packet.edges.map((edge) => edge.id)).size !== packet.edges.length
    || packet.edges.some((edge) => !ids.has(edge.target))) throw new Error('复制内容中的节点或连线无效')
  return packet
}

/** Only targets are remapped, including when the original source was also copied. */
export function pasteCanvasNodes(graph: CanvasGraph, packet: NodeClipboardPacket, position: CanvasPoint, env: NodeCreationEnvironment) {
  const ids = new Map(packet.nodes.map((node) => [node.id, crypto.randomUUID()]))
  const nodes = packet.nodes.map((node): CanvasNode => ({
    ...node, id: ids.get(node.id)!, title: `${node.title.slice(0, 157)} 副本`,
    position: { x: position.x + node.position.x - packet.bounds.x, y: position.y + node.position.y - packet.bounds.y },
    params: node.params ? { ...node.params } : null, selectedResultId: null,
    assetId: isGeneration(node.kind) ? null : node.assetId,
  }))
  for (const node of nodes) {
    CanvasNodeSchema.parse(node)
    if (node.assetId && !env.assets.some((asset) => asset.id === node.assetId && asset.kind === nodeMediaKind(node.kind)))
      throw new Error('复制的素材已不可用，请重新复制')
  }
  const edges = packet.edges.map((edge) => ({ ...edge, id: crypto.randomUUID(), target: ids.get(edge.target)! }))
  const next = { ...graph, nodes: [...graph.nodes, ...nodes], edges: [...graph.edges, ...edges] }
  // Ownership, missing inputs, duplicate assets and cycles are checked before the sole edit.
  validateGraph(next, env.assets, env.tasks)
  const inputs = new Map<string, typeof env.assets[number][]>()
  const byAsset = new Map(env.assets.map((asset) => [asset.id, asset]))
  for (const edge of edges) inputs.set(edge.target, [...inputs.get(edge.target) ?? [], byAsset.get(edge.assetId)!])
  for (const node of nodes) {
    const assets = inputs.get(node.id) ?? [], model = env.models.find((model) => model.id === node.modelId)
    const params = !isTtsParams(node.params) ? node.params : null
    const caps = model && videoInputCapabilities(model, params)
    if (assets.some((asset) => asset.kind === 'image' && !['image/png', 'image/jpeg', 'image/webp'].includes(asset.mime))
      || (caps && (assets.length > caps.maxReferences || assets.some((asset) => !caps.referenceKinds.includes(asset.kind))))
      || (!model && assets.some((asset) => asset.kind !== 'image')))
      throw new Error('复制的输入不符合当前模型要求，请重新复制')
    if (params) {
      for (const id of [params.firstFrameId, params.lastFrameId]) {
        if (id && !assets.some((asset) => asset.id === id)) throw new Error('复制的首尾帧已不可用，请重新复制')
      }
      if (model && isMultimodalVideo(model)) validateVideoConnections(params, assets, model)
    }
  }
  return { graph: next, ids: nodes.map((node) => node.id) }
}
