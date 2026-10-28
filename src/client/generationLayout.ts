import { isGeneration, type CanvasNode, type Asset } from '../shared/contracts'
import { mediaFrame } from './mediaLayout'

export function generationFrame(asset: Asset | undefined, count: number, expanded: boolean) {
  const cell = asset ? mediaFrame(asset.width ?? 16, asset.height ?? 9) : { width: 320, height: 180 }
  const columns = expanded ? Math.min(2, Math.max(1, count)) : 1
  const rows = expanded ? Math.ceil(Math.max(1, count) / columns) : 1
  return { cell, columns, collapseIndex: (rows - 1) * columns, width: cell.width * columns + (columns - 1) * 10, height: cell.height * rows + (rows - 1) * 10 }
}
export function nodeEditorVisible(node: CanvasNode, asset: Asset | undefined, expanded: boolean): boolean {
  return isGeneration(node.kind) ? !expanded : !asset
}
/** History requires an expanded, explicit asset port; persisted edges stay fixed. */
export function connectionAsset(node: CanvasNode, assets: readonly Asset[], results: readonly Asset[], handle: string | null, history = false, expanded = false): Asset | undefined {
  if (history) return expanded && handle?.startsWith('result:') ? results.find((asset) => `result:${asset.id}` === handle) : undefined
  if (handle) return undefined
  return isGeneration(node.kind) ? results.find((asset) => asset.id === node.selectedResultId) ?? results[0] : assets.find((asset) => asset.id === node.assetId)
}
