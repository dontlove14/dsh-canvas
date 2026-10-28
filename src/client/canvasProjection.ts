import type { Asset, CanvasEdge } from '../shared/contracts'
import type { TaskSummary } from '../shared/v2'
import type { GenerationCard } from './generationHistory'
import { shareItems } from './canvasSharing'

const EMPTY_ASSETS: Asset[] = []
const EMPTY_CARDS: GenerationCard[] = []
const EMPTY_CONNECTIONS: string[] = []
export const EMPTY_PROJECTION = { results: EMPTY_ASSETS, cards: EMPTY_CARDS, connectedAssets: EMPTY_CONNECTIONS,
  task: undefined as TaskSummary | undefined }
type Projection = typeof EMPTY_PROJECTION

/** Index once per input change; preserve unrelated owners and their result arrays. */
export function createCanvasProjection() {
  let previous = new Map<string, Projection>()
  return (tasks: readonly TaskSummary[], assets: readonly Asset[], edges: readonly CanvasEdge[]) => {
    const assetById = new Map(assets.map((asset) => [asset.id, asset]))
    const groups = new Map<string, TaskSummary[]>()
    const connections = new Map<string, Set<string>>()
    for (const task of tasks) {
      const group = groups.get(task.nodeId) ?? []
      group.push(task); groups.set(task.nodeId, group)
    }
    for (const edge of edges) {
      const group = connections.get(edge.source) ?? new Set<string>()
      group.add(edge.assetId); connections.set(edge.source, group)
    }
    const next = new Map<string, Projection>()
    for (const id of new Set([...groups.keys(), ...connections.keys()])) {
      const old = previous.get(id) ?? EMPTY_PROJECTION
      const group = groups.get(id) ?? []
      const oldCards = new Map(old.cards.map((card) => [card.task.id, card]))
      const cards = shareItems(old.cards, group.map((task, index) => ({ task, index }))
        .sort((a, b) => b.task.createdAt - a.task.createdAt || b.index - a.index).map(({ task }) => {
          const oldCard = oldCards.get(task.id)
          const results = shareItems(oldCard?.results, task.resultIds.flatMap((id) => {
            const asset = assetById.get(id)
            return asset ? [asset] : []
          }))
          return oldCard?.task === task && oldCard.results === results ? oldCard : { task, results }
        }))
      const lastResult = [...group].reverse().find((task) => task.resultIds.length > 0)
      const results = shareItems(old.results, cards.find((card) => card.task === lastResult)?.results ?? [])
      const connectedAssets = shareItems(old.connectedAssets, [...connections.get(id) ?? []])
      const task = group.at(-1)
      next.set(id, old.task === task && old.results === results && old.cards === cards && old.connectedAssets === connectedAssets
        ? old : { task, results, cards, connectedAssets })
    }
    previous = next
    return { byNode: next, assetById }
  }
}
