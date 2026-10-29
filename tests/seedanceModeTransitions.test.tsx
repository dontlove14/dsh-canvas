// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ReactFlowProvider } from '@xyflow/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CanvasWorkspace } from '../src/client/Canvas'
import { CanvasApi } from '../src/client/api'
import { capabilitiesFor, defaultParams, emptyGraph, FISH_TTS_ENDPOINT, type Asset, type CanvasNode } from '../src/shared/contracts'
import { BUILTIN_MODELS } from '../src/shared/modelCatalog'
import type { CanvasSnapshot } from '../src/shared/v2'

// Exercise the real workspace connection/removal handlers, editor and save flow;
// replace only canvas geometry and external I/O.
const probe = vi.hoisted(() => ({ connect: undefined as any, remove: undefined as any, select: undefined as any,
  nodes: [] as any[], edges: [] as any[] }))
vi.mock('@xyflow/react', async (original) => ({
  ...await original<typeof import('@xyflow/react')>(),
  Background: () => null, Controls: () => null, MiniMap: () => null,
  ReactFlow: ({ nodes, edges, onConnect, onEdgesChange, onNodesChange, children }: any) => {
    probe.connect = onConnect; probe.remove = onEdgesChange; probe.select = onNodesChange; probe.nodes = nodes; probe.edges = edges
    return <div>{children}</div>
  },
}))
vi.mock('../src/client/useGpu', () => ({ useGpuCapability: () => ({ enabled: false, reason: 'test' }) }))
const roots: Root[] = []
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {}; disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {}; disconnect() {} })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1 })
})
afterEach(async () => {
  await act(async () => roots.splice(0).forEach((root) => root.unmount()))
  document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
async function fixture(kind: Asset['kind'] = 'image') {
  const definition = BUILTIN_MODELS.find((model) => model.model_id === 'doubao-seedance-2-5-260628')!
  const model = { ...definition, capabilities: capabilitiesFor(definition), has_api_key: true, api_key_mask: '' }
  const generator: CanvasNode = { id: crypto.randomUUID(), kind: 'video-generation', title: 'Video', position: { x: 0, y: 0 },
    modelId: model.id, params: defaultParams(model), prompt: '镜头平移', assetId: null, selectedResultId: null }
  const assets: Asset[] = [0, 1].map(() => ({ id: crypto.randomUUID(), kind, nodeId: crypto.randomUUID(), taskId: null,
    mime: { image: 'image/png', video: 'video/mp4', audio: 'audio/wav' }[kind], filename: 'reference', bytes: 1000,
    width: 640, height: 720, duration: 2, createdAt: 1 }))
  const sources: CanvasNode[] = assets.map((asset, index) => ({ ...generator, id: asset.nodeId!, title: `Reference ${index + 1}`,
    kind: `${kind}-asset`, modelId: null, params: null, prompt: '', assetId: asset.id }))
  let snapshot: CanvasSnapshot = { version: 1, workspaceId: 'w', graphRevision: 1, graph: { ...emptyGraph(), nodes: [generator, ...sources] },
    assets, tasks: [], updatedAt: 1, commitHash: 'a'.repeat(64), hashes: { nodes: {}, edges: {}, viewport: '' } }
  const api = new CanvasApi()
  vi.spyOn(api, 'state').mockImplementation(async () => structuredClone(snapshot))
  vi.spyOn(api, 'models').mockResolvedValue([model])
  vi.spyOn(api, 'ttsSettings').mockResolvedValue({ endpoint: FISH_TTS_ENDPOINT, revision: 0, configured: false, has_api_key: false, api_key_mask: '' })
  vi.spyOn(api, 'mediaUrls').mockImplementation(async (_canvas, items) => ({ items: items.map((item) => ({
    ...item, url: `https://fixture.invalid/${item.assetId}`, expiresAt: Date.now() + 3600000,
  })) }))
  const save = vi.spyOn(api, 'save').mockImplementation(async (_canvas, mutation) => {
    snapshot = { ...snapshot, graphRevision: snapshot.graphRevision + 1, graph: { ...snapshot.graph,
      nodes: snapshot.graph.nodes.map((node) => mutation.nodes.find((change) => change.value.id === node.id)?.value ?? node),
      edges: snapshot.graph.edges.filter((edge) => !mutation.deleteEdges.includes(edge.id)).concat(mutation.edges.map((change) => change.value)) } }
    return structuredClone(snapshot)
  })
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host); roots.push(root)
  await act(async () => root.render(<ReactFlowProvider><CanvasWorkspace api={api} workspace="w" title="Video" onBack={vi.fn()} /></ReactFlowProvider>))
  await act(async () => probe.select([{ type: 'select', id: generator.id, selected: true }]))
  const mode = () => host.querySelector<HTMLSelectElement>('select[aria-label="视频生成模式"]')
  const connect = (index = 0) => act(() => probe.connect({ source: sources[index].id, target: generator.id, sourceHandle: null, targetHandle: null }))
  const remove = (id: string) => act(() => probe.remove([{ type: 'remove', id }]))
  return { host, mode, connect, remove, save, assets, sources, generator,
    params: () => probe.nodes.find((node) => node.id === generator.id).data.node.params }
}

it.each(['image', 'video', 'audio'] as const)('automatically changes text to reference on the first %s connection and resets after removal', async (kind) => {
  const f = await fixture(kind)
  expect(f.mode()).toBeNull(); expect(f.host.querySelector('.dc-video-mode-auto')?.textContent).toBe('文生视频')
  expect([...f.host.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '＋ 上传')!.disabled).toBe(false)
  f.connect()
  expect(f.mode()!.value).toBe('reference')
  expect([...f.mode()!.options].map((option) => option.value)).toEqual(['reference', 'frames'])
  expect(f.params().videoMode).toBe('reference')
  f.remove(probe.edges[0].id)
  expect(f.mode()).toBeNull(); expect(f.params().videoMode).toBe('text')
  expect(f.host.querySelector<HTMLButtonElement>('[aria-label="生成"]')!.disabled).toBe(false)
  f.connect()
  expect(f.mode()!.value).toBe('reference')
  await act(async () => f.host.querySelector<HTMLButtonElement>('[title="保存画布"]')!.click())
  await act(async () => vi.waitFor(() => expect(f.save).toHaveBeenCalled()))
  expect(f.save.mock.calls.at(-1)![1].nodes.find((node) => node.value.id === f.generator.id)?.value.params).toMatchObject({ videoMode: 'reference' })
})

it('keeps manually selected frames on partial removal, resets after clearing, and never automatically restores frames', async () => {
  const f = await fixture()
  f.connect(0); f.connect(1)
  act(() => { f.mode()!.value = 'frames'; f.mode()!.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(f.params()).toMatchObject({ videoMode: 'frames', firstFrameId: f.assets[0].id, lastFrameId: f.assets[1].id })
  f.remove(probe.edges[0].id)
  expect(f.params()).toMatchObject({ videoMode: 'frames', firstFrameId: f.assets[1].id })
  expect(f.params()).not.toHaveProperty('lastFrameId')
  f.remove(probe.edges[0].id)
  expect(f.params().videoMode).toBe('text'); expect(f.params()).not.toHaveProperty('firstFrameId')
  f.connect(0)
  expect(f.mode()!.value).toBe('reference'); expect(f.host.querySelector('.dc-frame-role')).toBeNull()
})

it('inserts an unconnected prompt reference into an empty video node without requiring a mode switch', async () => {
  const f = await fixture()
  const textbox = f.host.querySelector<HTMLElement>('[contenteditable="true"]')!
  await act(async () => {
    textbox.focus(); textbox.textContent = '@'
    const range = document.createRange(); range.selectNodeContents(textbox); range.collapse(false)
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
    textbox.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '@' }))
  })
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((item) => item.textContent?.includes(f.sources[0].title))!
  expect(option).toBeTruthy()
  await act(async () => { option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); option.click() })
  expect(f.mode()!.value).toBe('reference')
  expect(probe.edges).toHaveLength(1)
  expect(probe.edges[0].assetId).toBe(f.assets[0].id)
})
