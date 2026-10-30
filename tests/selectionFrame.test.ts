import { describe, expect, it } from 'vitest'
import type { Node } from '@xyflow/react'
import { selectionFrame } from '../src/client/SelectionNode'

const data = { ids: ['a', 'b'], connectable: true, downloadable: true, onDownload: () => {} }
const nodes: Node[] = [
  { id: 'a', data: {}, position: { x: 100, y: 100 }, width: 320, height: 180, selected: true },
  { id: 'b', data: {}, position: { x: 500, y: 100 }, width: 320, height: 180, selected: true },
  { id: 'outside', data: {}, position: { x: -10000, y: -10000 }, width: 320, height: 180 },
]
describe('selection frame display bounds', () => {
  it('contains external names and individual handles, with a separate group output at the same height', () => {
    const frame = selectionFrame(nodes, 'selection:w', data)!
    expect(frame.position.x).toBeLessThan(100 - 27)
    expect(frame.position.y).toBeLessThan(100 - 40) // A title's taller rename input.
    const outputCenter = frame.position.x + frame.width!
    const lastNodeOutputRight = 500 + 320 + 17 + 10
    expect(outputCenter - 12 - lastNodeOutputRight).toBeGreaterThanOrEqual(12)
    expect(frame.position.y + frame.height!).toBeGreaterThan(100 + 180)
    expect(frame).toMatchObject({ selected: false, selectable: false, draggable: false, deletable: false, focusable: false })
  })
  it('tracks measured resizing and moving without mutating real node positions or data', () => {
    const resized = nodes.map((node) => node.id === 'b'
      ? { ...node, position: { x: 600, y: -100 }, measured: { width: 530, height: 360 } } : node)
    const original = structuredClone(resized)
    const frame = selectionFrame(resized, 'selection:w', data)!
    expect(frame.position.y).toBeLessThan(-100 - 40)
    expect(frame.position.x + frame.width! - 12).toBeGreaterThan(600 + 530 + 27)
    expect(frame.position.y + frame.height!).toBeGreaterThanOrEqual(100 + 180 + 12)
    expect(resized).toEqual(original)
  })
  it('removes the transient frame for fewer than two selected nodes', () => {
    expect(selectionFrame(nodes.map((node) => ({ ...node, selected: node.id === 'a' })), 'selection:w', data)).toBeUndefined()
    expect(selectionFrame([], 'selection:w', data)).toBeUndefined()
  })
})
