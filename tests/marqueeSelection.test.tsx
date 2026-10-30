// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ReactFlowProvider, useStoreApi } from '@xyflow/react'
import { getNodesInside } from '@xyflow/system'
import { readFileSync } from 'node:fs'
import postcss from 'postcss'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CanvasWorkspace } from '../src/client/Canvas'
import { CanvasApi } from '../src/client/api'
import { fullyContainedNodeIds } from '../src/client/marqueeSelection'
import { emptyGraph, type Asset, type CanvasNode } from '../src/shared/contracts'
import type { CanvasSnapshot } from '../src/shared/v2'

// ReactFlow, Pane, store, selection algorithm and all node/editor UI stay real.
// Only unavailable browser layout/media facilities are substituted.
vi.mock('../src/client/useGpu', () => ({ useGpuCapability: () => ({ enabled: false, reason: 'test' }) }))
const roots: Root[] = []
afterEach(() => {
  act(() => { for (const root of roots.splice(0)) root.unmount() })
  document.body.replaceChildren(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals()
})
async function setup() {
  vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('PointerEvent', class extends MouseEvent {
    pointerId = 1; pointerType = 'mouse'; isPrimary = true
  })
  vi.stubGlobal('requestAnimationFrame', () => 1); vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.stubGlobal('ResizeObserver', class { observe() {}; unobserve() {}; disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {}; disconnect() {} })
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  for (const prop of ['offsetWidth', 'clientWidth']) vi.spyOn(HTMLElement.prototype, prop, 'get').mockImplementation(function () {
    return Number.parseFloat(this.style.width) || 1500
  })
  for (const prop of ['offsetHeight', 'clientHeight']) vi.spyOn(HTMLElement.prototype, prop, 'get').mockImplementation(function () {
    return Number.parseFloat(this.style.height) || 800
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({
    x: 30, y: 40, left: 30, top: 40, right: 1530, bottom: 840, width: 1500, height: 800, toJSON() {},
  }))
  const nodes: CanvasNode[] = [
    { kind: 'image-asset', position: { x: 80, y: 90 } },
    { kind: 'audio-asset', position: { x: 450, y: 90 } },
    { kind: 'image-generation', position: { x: 850, y: 90 } },
    { kind: 'image-generation', position: { x: 1300, y: 90 } },
    { kind: 'image-generation', position: { x: 10000, y: -10000 } },
  ].map((node, i) => ({ id: `node-${i}`, title: `节点 ${i}`, modelId: null, prompt: '', params: null,
    assetId: i < 2 ? `asset-${i}` : null, selectedResultId: null, ...node } as CanvasNode))
  const assets: Asset[] = nodes.slice(0, 3).map((node, i) => ({
    id: `asset-${i}`, kind: i === 1 ? 'audio' : 'image', mime: i === 1 ? 'audio/wav' : 'image/png',
    width: 1600, height: 900, filename: `file-${i}`, bytes: 100, createdAt: 1, nodeId: node.id, taskId: i === 2 ? 'task-2' : null,
  }))
  const snapshot: CanvasSnapshot = {
    version: 1, workspaceId: 'w', graphRevision: 1, graph: { ...emptyGraph(), nodes, edges: [
      { id: 'edge-in', source: nodes[0].id, target: nodes[2].id, assetId: assets[0].id },
      { id: 'edge-out', source: nodes[1].id, target: nodes[3].id, assetId: assets[1].id },
    ] }, assets, tasks: [{ id: 'task-2', nodeId: nodes[2].id, workspaceId: 'w', status: 'completed', resultIds: [assets[2].id], createdAt: 1, updatedAt: 1 }],
    updatedAt: 1, commitHash: 'a'.repeat(64), hashes: { nodes: {}, edges: {}, viewport: '' },
  }
  const api = new CanvasApi()
  vi.spyOn(api, 'state').mockResolvedValue(snapshot)
  const save = vi.spyOn(api, 'save').mockResolvedValue(snapshot)
  let store!: ReturnType<typeof useStoreApi>
  function Probe() { store = useStoreApi(); return null }
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container); roots.push(root)
  await act(async () => {
    root.render(<ReactFlowProvider><Probe /><CanvasWorkspace api={api} workspace="w" title="框选测试" onBack={() => {}} /></ReactFlowProvider>)
    await Promise.resolve()
  })
  const pane = container.querySelector<HTMLElement>('.react-flow__pane')!
  expect(pane).toBeTruthy()
  const event = (type: string, x: number, y: number, shiftKey = false) => act(() => {
    pane.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x + 30, clientY: y + 40, shiftKey }))
  })
  const ids = () => [...store.getState().nodeLookup.values()].filter((node) => node.selected).map((node) => node.id)
  const edgeIds = () => store.getState().edges.filter((edge) => edge.selected).map((edge) => edge.id)
  return { container, pane, store, nodes, event, ids, edgeIds, save }
}
describe('strict native canvas marquee selection', () => {
  it('rejects native unmeasured/offscreen candidates and updates a shrinking rectangle without accumulation', async () => {
    const { store, event, ids, edgeIds, save } = await setup()
    expect(store.getState().nodeLookup.get('node-4')?.internals.handleBounds).toBeUndefined()
    const emptyRect = { x: 10, y: 10, width: 20, height: 20 }
    expect(getNodesInside(store.getState().nodeLookup, emptyRect, [0, 0, 1], false, true).map((node) => node.id)).toContain('node-4')
    expect(fullyContainedNodeIds(emptyRect, [0, 0, 1], store.getState().nodeLookup.values())).toEqual([])
    event('pointerdown', 50, 60); event('pointermove', 1200, 300)
    expect(ids()).toEqual(['node-0', 'node-1', 'node-2'])
    event('pointermove', 420, 300)
    expect(ids()).toEqual(['node-0']); expect(edgeIds()).toEqual(['edge-in'])
    event('pointermove', 70, 80); event('pointerup', 70, 80)
    expect(ids()).toEqual([]); expect(edgeIds()).toEqual([])
    expect(store.getState().nodesSelectionActive).toBe(false)
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(save).not.toHaveBeenCalled()
  })
  it('uses the release position and fully contained bodies rather than partial overlap', async () => {
    const { event, ids } = await setup()
    event('pointerdown', 50, 60); event('pointermove', 820, 300)
    expect(ids()).toEqual(['node-0', 'node-1'])
    // The last pointermove and pointerup can have different coordinates.
    event('pointerup', 400, 270)
    expect(ids()).toEqual(['node-0'])
    event('pointerdown', 50, 60); event('pointermove', 399, 269); event('pointerup', 399, 269)
    expect(ids()).toEqual([])
  })
  it('handles reverse dragging after fractional zoom and translation with a nonzero canvas offset', async () => {
    const { store, event, ids } = await setup()
    act(() => store.setState({ transform: [120.5, -30.25, 1.5] }))
    event('pointerdown', 750.5, 419.75); event('pointermove', 195.5, 59.75)
    expect(ids()).toEqual(['node-0'])
    event('pointerup', 195.5, 59.75); expect(ids()).toEqual(['node-0'])
  })
  it('replaces previous selection normally and preserves the gesture-start selection for Shift extension', async () => {
    const { store, event, ids } = await setup()
    act(() => store.getState().addSelectedNodes(['node-3']))
    event('pointerdown', 50, 60); event('pointermove', 420, 300); event('pointerup', 420, 300)
    expect(ids()).toEqual(['node-0'])
    event('pointerdown', 430, 60, true); event('pointermove', 820, 300, true)
    expect(ids()).toEqual(['node-0', 'node-1'])
    event('pointermove', 440, 80, true); expect(ids()).toEqual(['node-0'])
    event('pointermove', 820, 300, true); event('pointerup', 820, 300, true)
    expect(ids()).toEqual(['node-0', 'node-1'])
  })
  it.each(['pointercancel', 'blur'])('restores the original selection and clears the gesture after %s', async (type) => {
    const { store, event, ids, container } = await setup()
    act(() => store.getState().addSelectedNodes(['node-3']))
    event('pointerdown', 50, 60); event('pointermove', 420, 300)
    expect(ids()).toEqual(['node-0'])
    if (type === 'blur') act(() => window.dispatchEvent(new Event('blur')))
    else event('pointercancel', 420, 300)
    expect(ids()).toEqual(['node-3'])
    expect(store.getState().userSelectionRect).toBeNull(); expect(store.getState().userSelectionActive).toBe(false)
    expect(container.querySelector<HTMLElement>('.dc-canvas-area')?.dataset.marqueeSelecting).toBe('false')
    event('pointerdown', 10, 10); event('pointermove', 30, 30); event('pointerup', 30, 30)
    expect(ids()).toEqual([])
  })
  it('removes single-node UI during marquee, shows only group download on release, and restores single-node UI', async () => {
    const { container, store, event } = await setup()
    act(() => store.getState().addSelectedNodes(['node-0']))
    expect(container.querySelector('[aria-label="图片操作"]')).toBeTruthy()
    event('pointerdown', 50, 60)
    expect(container.querySelector('[role="toolbar"]')).toBeNull()
    expect(container.querySelector('.dc-group-actions')).toBeNull()
    event('pointermove', 1200, 300)
    expect(container.querySelector('.dc-editor')).toBeNull()
    expect(container.querySelector('[role="toolbar"]')).toBeNull()
    event('pointerup', 1200, 300)
    expect(container.querySelector('[aria-label="框选操作"]')).toBeTruthy()
    expect(container.querySelector('[aria-label="框选操作"]')?.querySelectorAll('button')).toHaveLength(1)
    expect(container.querySelector('.dc-selection-handle')).toBeTruthy()
    const group = store.getState().nodes.find((node) => node.type === 'selection')!
    expect(group.position.y).toBeLessThan(90 - 40)
    expect(container.querySelector('[aria-label="框选操作"]')?.getAttribute('data-id')).toBe(group.id)
    expect(container.querySelector('.dc-edge-flow')).toBeNull()
    expect(container.querySelector('.dc-group-actions')).toBeNull()
    event('pointerdown', 50, 60); event('pointermove', 420, 300); event('pointerup', 420, 300)
    expect(container.querySelector('[aria-label="图片操作"]')).toBeTruthy()
    event('pointerdown', 830, 60); event('pointermove', 1200, 300)
    expect(container.querySelector('.dc-editor')).toBeNull(); expect(container.querySelector('.dc-group-actions')).toBeNull()
    event('pointerup', 1200, 300)
    expect(container.querySelector('.dc-editor')).toBeTruthy(); expect(container.querySelector('.dc-group-actions')).toBeTruthy()
    event('pointerdown', 430, 60); event('pointermove', 820, 300); event('pointerup', 820, 300)
    expect(container.querySelector('[aria-label="音频操作"]')).toBeTruthy()
  })
  it('keeps both marquee and completed group rectangles transparent with a visible theme border', () => {
    const css = postcss.parse(readFileSync('src/client/styles.css', 'utf8'))
    const declarations: Record<string, string> = {}
    css.walkRules((rule) => {
      if (rule.selector === '.dc-canvas-area .react-flow' || rule.selector.includes('.react-flow__nodesselection-rect'))
        rule.walkDecls((decl) => { declarations[decl.prop] = decl.value })
    })
    expect(declarations['--xy-selection-background-color']).toBe('transparent')
    expect(declarations.background).toBe('transparent'); expect(declarations.border).toBe('1px dashed var(--dc-accent)')
  })
})
