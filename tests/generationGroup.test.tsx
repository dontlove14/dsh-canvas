import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ReactFlowProvider } from '@xyflow/react'
import { randomUUID } from 'node:crypto'
import type { Asset, CanvasNode } from '../src/shared/contracts'
import { GenerationNode } from '../src/client/GenerationNode'
import { CanvasHandle } from '../src/client/CanvasHandle'
import { generationFrame, nodeEditorVisible } from '../src/client/generationLayout'
import { CanvasApi } from '../src/client/api'

const noop = () => {}
function fixtures(kind: 'image' | 'video', count: number) {
  const node: CanvasNode = { id: randomUUID(), kind: `${kind}-generation`, title: '测试生成', position: { x: 0, y: 0 },
    modelId: null, prompt: 'test', params: null, assetId: null, selectedResultId: null }
  const results: Asset[] = Array.from({ length: count }, () => ({ id: randomUUID(), kind, filename: `result.${kind === 'image' ? 'png' : 'mp4'}`,
    mime: kind === 'image' ? 'image/png' : 'video/mp4', bytes: 10, createdAt: 0, nodeId: node.id, taskId: null, width: 1024, height: 1024 }))
  return { node, results }
}
function render(node: CanvasNode, results: Asset[], main: number, expanded: boolean) {
  return renderToStaticMarkup(<ReactFlowProvider><GenerationNode node={node} results={results} asset={results[main]}
    selected expanded={expanded} api={new CanvasApi()} workspace="test" playing={false}
    onPlay={noop} onStop={noop} onRename={noop} onResult={noop} onExpand={noop} onOpen={noop} onSize={noop} /></ReactFlowProvider>)
}

describe('generation result group', () => {
  it.each(['image', 'video'] as const)('shows handles only on the main %s and keeps collapse on the bottom-left result', (kind) => {
    // Three results also occurs when a batch is only partially saved.
    for (const count of [2, 3, 4, 10]) {
      const { node, results } = fixtures(kind, count)
      const collapseIndex = (Math.ceil(count / 2) - 1) * 2
      for (let main = 0; main < count; main++) {
        const markup = render(node, results, main, true)
        const cells = markup.split('<div class="dc-generation-cell ').slice(1)
        expect(cells).toHaveLength(count)
        expect(markup.match(/react-flow__handle-left/g)).toHaveLength(1)
        expect(markup.match(/react-flow__handle-right/g)).toHaveLength(1)
        for (const [index, cell] of cells.entries()) {
          expect(cell.includes('react-flow__handle')).toBe(index === main)
          expect(cell.includes('收起')).toBe(index === collapseIndex)
          expect(cell.includes('设为主图')).toBe(index !== main)
        }
        expect(generationFrame(results[main], count, true).collapseIndex).toBe(collapseIndex)
        expect(markup).not.toContain('result:')
        const collapsed = render(node, results, main, false)
        expect(collapsed).toContain('has-result')
        expect(collapsed.match(/dc-generation-cell/g)).toHaveLength(1)
        expect(collapsed.match(/react-flow__handle-left/g)).toHaveLength(1)
        expect(collapsed.match(/react-flow__handle-right/g)).toHaveLength(1)
      }
    }
  })

  it('hides the editor for any selected expanded result and restores it after collapse', () => {
    for (const kind of ['image', 'video'] as const) {
      const { node, results } = fixtures(kind, 4)
      for (const asset of results) {
        expect(nodeEditorVisible({ ...node, selectedResultId: asset.id }, asset, true)).toBe(false)
        expect(nodeEditorVisible({ ...node, selectedResultId: asset.id }, asset, false)).toBe(true)
      }
    }
    const { node, results } = fixtures('image', 1)
    expect(nodeEditorVisible({ ...node, kind: 'image-asset' }, results[0], false)).toBe(false)
    expect(nodeEditorVisible({ ...node, kind: 'audio-asset' }, undefined, false)).toBe(true)
  })

  it('renders a circle and a centered vector plus instead of a font glyph', () => {
    const markup = renderToStaticMarkup(<ReactFlowProvider><CanvasHandle type="source" /></ReactFlowProvider>)
    const svg = markup.match(/<svg[^>]*viewBox="([^"]+)"[^>]*>/)?.[1].split(' ').map(Number)
    const circle = markup.match(/<circle cx="([^"]+)" cy="([^"]+)" r="([^"]+)"/)
    expect(svg).toBeDefined(); expect(circle).not.toBeNull()
    expect(Number(circle![1])).toBe(svg![2] / 2)
    expect(Number(circle![2])).toBe(svg![3] / 2)
    expect(svg![2]).toBe(svg![3])
    expect(markup).toContain('stroke-linecap="round"')
    expect(markup).not.toMatch(/<span[^>]*>\+/)
  })
})
