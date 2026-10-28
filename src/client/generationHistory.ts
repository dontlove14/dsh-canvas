import { isGeneration, type Asset, type CanvasNode } from '../shared/contracts'
import type { TaskSummary } from '../shared/v2'
import { generationFrame } from './generationLayout'

export interface GenerationCard { task: TaskSummary; results: Asset[] }

/** Acceptance order breaks equal timestamps; completion never changes position. */
export function generationHistory(nodeId: string, tasks: readonly TaskSummary[], assets: readonly Asset[]): GenerationCard[] {
  const byId = new Map(assets.map((asset) => [asset.id, asset]))
  return tasks.map((task, index) => ({ task, index })).filter(({ task }) => task.nodeId === nodeId)
    .sort((a, b) => b.task.createdAt - a.task.createdAt || b.index - a.index)
    .map(({ task }) => ({ task, results: task.resultIds.flatMap((id) => {
      const asset = byId.get(id)
      return asset ? [asset] : []
    }) }))
}

export function hasGenerationHistory(node: CanvasNode, tasks: readonly Pick<TaskSummary, 'nodeId'>[]): boolean {
  return isGeneration(node.kind) && tasks.filter((task) => task.nodeId === node.id).length > 1
}
export const resultHandle = (assetId: string) => `result:${assetId}`
export const submissionIdentity = (task: TaskSummary) => task.requestId ?? task.id

/** The inspected output, including its row, keeps the editor in canvas coordinates. */
export function historyEditorAnchor(node: CanvasNode, cards: readonly GenerationCard[], identity: string, assetId?: string) {
  const index = cards.findIndex((card) => submissionIdentity(card.task) === identity)
  if (index < 0) return undefined
  const { frames } = historyFrame(cards, node.kind === 'tts-generation', true)
  const frame = frames[index]
  const result = Math.max(0, cards[index].results.findIndex((asset) => asset.id === assetId))
  const offsetY = frames.slice(0, index).reduce((sum, item) => sum + item.height + 16, 0)
  return {
    position: { x: node.position.x + (result % frame.columns) * (frame.cell.width + 10),
      y: node.position.y + offsetY + Math.floor(result / frame.columns) * (frame.cell.height + 10) },
    size: frame.cell,
  }
}

export function historyFrame(cards: readonly GenerationCard[], audio: boolean, expanded: boolean) {
  const frames = (expanded ? cards : cards.slice(0, 1)).map((card) => {
    if (audio) return { cell: { width: 360, height: 180 }, columns: 1, width: 360, height: 180 }
    return generationFrame(card.results[0], card.results.length, expanded)
  })
  return { frames, width: Math.max(320, ...frames.map((frame) => frame.width)),
    height: frames.reduce((sum, frame) => sum + frame.height, 0) + Math.max(0, frames.length - 1) * 16 }
}

/** Exact request identity also covers a lost POST response, without another POST. */
export function mergeSubmissions(authoritative: readonly TaskSummary[], pending: readonly TaskSummary[]): TaskSummary[] {
  const ids = new Set(authoritative.map((task) => task.id))
  const requests = new Set(authoritative.flatMap((task) => task.requestId ? [task.requestId] : []))
  return [...authoritative, ...pending.filter((task) => !ids.has(task.id) && (!task.requestId || !requests.has(task.requestId)))]
    .sort((a, b) => a.createdAt - b.createdAt)
}
