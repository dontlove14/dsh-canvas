// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ReactFlowProvider } from '@xyflow/react'
import { afterEach, expect, it, vi } from 'vitest'
import { CanvasWorkspace } from '../src/client/Canvas'
import { CanvasApi } from '../src/client/api'
import { PromptEditorController } from '../src/client/promptEditorController'
import { emptyGraph, capabilitiesFor, defaultTtsParams, FISH_TTS_ENDPOINT, type Asset, type CanvasNode } from '../src/shared/contracts'
import { BUILTIN_MODELS } from '../src/shared/modelCatalog'
import type { CanvasSnapshot, TaskSummary } from '../src/shared/v2'
import { shareCanvasSnapshot } from '../src/client/canvasSharing'
import { File as NativeFile } from 'node:buffer'
import { ResumableUploads, type UploadTransport } from '../src/client/resumableUploads'

// Real workspace, bodies, media and editor; only geometry/network are replaced.
const probe = vi.hoisted(() => ({
  data: new Map<string, unknown>(), changes: new Map<string, number>(), bodies: new Map<string, number>(), measures: new Map<string, number>(),
  onNodesChange: undefined as any, edges: undefined as any,
  increment: (map: Map<string, number>, id: string) => map.set(id, (map.get(id) ?? 0) + 1),
}))
vi.mock('@xyflow/react', async (original) => ({
  ...await original<typeof import('@xyflow/react')>(),
  Background: () => null, Controls: () => null, MiniMap: () => null,
  useUpdateNodeInternals: () => measure,
  ReactFlow: ({ nodes, edges, nodeTypes, onNodesChange, children }: any) => {
    probe.onNodesChange = onNodesChange; probe.edges = edges
    return <div>{nodes.map((node: any) => {
      if (probe.data.get(node.id) !== node.data) probe.increment(probe.changes, node.id)
      probe.data.set(node.id, node.data)
      const Component = nodeTypes[node.type]
      return <div key={node.id}><Component id={node.id} data={node.data} selected={node.selected} /></div>
    })}{children}</div>
  },
}))
function measure(id: string) { probe.increment(probe.measures, id) }
vi.mock('../src/client/NodeTitle', async (original) => {
  const module = await original<typeof import('../src/client/NodeTitle')>()
  return { ...module, NodeTitle: (props: any) => {
    probe.increment(probe.bodies, props.node.id)
    return <module.NodeTitle {...props} />
  } }
})
vi.mock('../src/client/useGpu', () => ({ useGpuCapability: () => ({ enabled: false, reason: 'test' }) }))
let root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined
  document.body.replaceChildren()
  probe.data.clear(); probe.changes.clear(); probe.bodies.clear(); probe.measures.clear()
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

async function fixture() {
  vi.useFakeTimers()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {}; disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private notify: (entries: Array<{ isIntersecting: boolean }>) => void) {}
    observe() { this.notify([{ isIntersecting: true }]) }; disconnect() {}
  })
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
  const model = { ...BUILTIN_MODELS[0], capabilities: capabilitiesFor(BUILTIN_MODELS[0]), has_api_key: true, api_key_mask: '' }
  const nodes: CanvasNode[] = [], assets: Asset[] = [], tasks: TaskSummary[] = []
  const shapes = [
    ...Array.from({ length: 8 }, (_, index) => ({ kind: 'image-generation' as const, tasks: index < 3 ? 2 : 1 })),
    ...Array.from({ length: 3 }, () => ({ kind: 'tts-generation' as const, tasks: 1 })),
    { kind: 'image-asset' as const, tasks: 1 }, { kind: 'image-asset' as const, tasks: 1 },
    { kind: 'video-asset' as const, tasks: 1 }, { kind: 'audio-asset' as const, tasks: 1 },
  ]
  for (const [index, shape] of shapes.entries()) {
    const generation = shape.kind.includes('generation'), audio = shape.kind.startsWith('audio') || shape.kind.startsWith('tts')
    const kind = audio ? 'audio' : shape.kind.startsWith('video') ? 'video' : 'image'
    const id = crypto.randomUUID()
    const node: CanvasNode = { id, kind: shape.kind, title: `Fixture ${index}`, position: { x: index * 350, y: 0 },
      modelId: generation && !audio ? model.id : null, prompt: '测试提示词',
      params: generation ? audio ? defaultTtsParams() : { size: '1024x1024', n: 1 } : null, assetId: null, selectedResultId: null }
    nodes.push(node)
    for (let attempt = 0; attempt < shape.tasks; attempt++) {
      const taskId = crypto.randomUUID(), assetId = crypto.randomUUID()
      assets.push({ id: assetId, taskId, nodeId: id, kind, mime: kind === 'audio' ? 'audio/wav' : kind === 'video' ? 'video/mp4' : 'image/png',
        filename: `Fixture-${index}-${attempt}`, bytes: 100, width: 320, height: 180, createdAt: attempt + 1 })
      tasks.push({ id: taskId, requestId: crypto.randomUUID(), nodeId: id, workspaceId: 'w', status: 'completed',
        resultIds: [assetId], createdAt: attempt + 1, updatedAt: attempt + 1 })
      if (!generation && !node.assetId) node.assetId = assetId
    }
  }
  // Use the single-submission node so selecting it doesn't restore history inputs.
  const moving = nodes[3], resource = nodes[11]
  let snapshot: CanvasSnapshot = { version: 1, workspaceId: 'w', graphRevision: 1, graph: { ...emptyGraph(), nodes },
    assets, tasks, updatedAt: 1, commitHash: 'a'.repeat(64), hashes: { nodes: {}, edges: {}, viewport: '' } }
  const api = new CanvasApi()
  vi.spyOn(api, 'state').mockImplementation(async () => structuredClone(snapshot))
  vi.spyOn(api, 'models').mockResolvedValue([model])
  vi.spyOn(api, 'ttsSettings').mockResolvedValue({ endpoint: FISH_TTS_ENDPOINT, revision: 1, configured: true, has_api_key: true, api_key_mask: '' })
  vi.spyOn(api, 'waveform').mockResolvedValue({ version: 1, duration: 10, peaks: Array(96).fill(.5) })
  vi.spyOn(api, 'mediaUrls').mockImplementation(async (_canvas, items) => ({ items: items.map((item) => ({
    ...item, url: `https://fixture.invalid/${item.assetId}`, expiresAt: Date.now() + 3600000,
  })) }))
  const save = vi.spyOn(api, 'save').mockImplementation(async (_canvas, mutation) => {
    snapshot = { ...snapshot, graphRevision: snapshot.graphRevision + 1, graph: { ...snapshot.graph,
      nodes: snapshot.graph.nodes.map((node) => mutation.nodes.find((change) => change.value.id === node.id)?.value ?? node),
      edges: [...snapshot.graph.edges, ...mutation.edges.map((change) => change.value)] } }
    return structuredClone(snapshot)
  })
  const submit = vi.spyOn(api, 'generate'), ttsSubmit = vi.spyOn(api, 'ttsGenerate')
  const prompt = vi.spyOn(PromptEditorController.prototype, 'update')
  const host = document.createElement('div'); document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<ReactFlowProvider><CanvasWorkspace api={api} workspace="w" title="Test" onBack={() => {}} /></ReactFlowProvider>))
  await act(async () => vi.advanceTimersByTimeAsync(100))
  await act(async () => probe.onNodesChange([{ type: 'select', id: moving.id, selected: true }]))
  const reset = () => { probe.changes.clear(); probe.bodies.clear(); probe.measures.clear(); prompt.mockClear() }
  reset()
  return { host, moving, resource, api, prompt, save, submit, ttsSubmit, reset,
    getState: () => snapshot, update: (next: CanvasSnapshot) => { snapshot = next },
    poll: () => act(async () => vi.advanceTimersByTimeAsync(2000)),
    drag: async () => {
      for (let index = 0; index < 60; index++) await act(async () => probe.onNodesChange([
        { type: 'position', id: moving.id, position: { x: index + 1, y: 2 }, dragging: true },
      ]))
    } }
}

it('moves one of 15 media nodes 60 times without refreshing bodies, geometry or prompt DOM, and saves the final position', async () => {
  const f = await fixture()
  await f.poll()
  expect(probe.changes.size).toBe(0); expect(probe.bodies.size).toBe(0); expect(probe.measures.size).toBe(0)
  expect(f.prompt).not.toHaveBeenCalled()
  const edges = probe.edges
  await f.drag()
  expect([...probe.changes.entries()]).toEqual([[f.moving.id, 60]])
  expect(probe.bodies.size).toBe(0); expect(probe.measures.size).toBe(0); expect(f.prompt).not.toHaveBeenCalled()
  expect(probe.edges).toBe(edges)
  expect(f.save).not.toHaveBeenCalled()
  await act(async () => (f.host.querySelector('[title="保存画布"]') as HTMLElement).click())
  await act(async () => vi.waitFor(() => expect(f.save).toHaveBeenCalledTimes(1)))
  expect(f.save).toHaveBeenCalledTimes(1)
  expect(f.save.mock.calls[0][1].nodes).toHaveLength(1)
  expect(f.getState().graph.nodes.find((node) => node.id === f.moving.id)!.position).toEqual({ x: 60, y: 2 })
  expect(f.submit).not.toHaveBeenCalled(); expect(f.ttsSubmit).not.toHaveBeenCalled()
})

it('updates only the owner for old-task progress and new outputs; remeasures changed dimensions and ports', async () => {
  const f = await fixture()
  const state = f.getState(), task = state.tasks[0], owner = task.nodeId
  f.update({ ...state, tasks: state.tasks.map((item) => item === task ? { ...item, status: 'generating', progress: 27, updatedAt: 42 } : item) })
  await f.poll()
  expect([...probe.changes.keys()]).toEqual([owner]); expect([...probe.bodies.keys()]).toEqual([owner])
  expect(probe.measures.size).toBe(0)
  f.reset()
  const before = f.getState(), asset = { ...before.assets[0], id: crypto.randomUUID(), width: 180, height: 320 }
  f.update({ ...before, assets: [...before.assets, asset], tasks: before.tasks.map((item) =>
    item.id === task.id ? { ...item, status: 'completed', resultIds: [...item.resultIds, asset.id], updatedAt: 43 } : item) })
  await f.poll()
  expect([...probe.changes.keys()]).toEqual([owner])
  // Expand: new result gets its own port and dimensions change on that owner.
  await act(async () => probe.onNodesChange([
    { type: 'select', id: f.moving.id, selected: false }, { type: 'select', id: owner, selected: true },
  ]))
  await act(async () => (f.host.querySelector('.dc-history-node [title="展开提交记录"]') as HTMLElement).click())
  expect(probe.measures.has(owner)).toBe(true)
  expect(f.host.querySelectorAll(`[data-asset-id="${asset.id}"] .react-flow__handle.source`)).toHaveLength(1)
  f.reset()
  const enlarged = f.getState()
  f.update({ ...enlarged, assets: enlarged.assets.map((item) => item.id === task.resultIds[0] ? { ...item, width: 900, height: 180 } : item) })
  await f.poll()
  expect([...probe.changes.keys()]).toEqual([owner])
  expect(probe.measures.has(owner)).toBe(true)
})

it('inserts a prompt reference using live positions after dragging, and ignores duplicate coordinates', async () => {
  const f = await fixture()
  await f.drag()
  f.reset()
  await act(async () => probe.onNodesChange([{ type: 'position', id: f.moving.id, position: { x: 60, y: 2 }, dragging: false }]))
  expect(probe.changes.size).toBe(0); expect(f.prompt).not.toHaveBeenCalled()
  const textbox = f.host.querySelector('[contenteditable="true"]') as HTMLElement
  await act(async () => {
    textbox.focus(); textbox.textContent = '@'
    const range = document.createRange(); range.selectNodeContents(textbox); range.collapse(false)
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
    textbox.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '@' }))
  })
  const option = [...document.querySelectorAll('[role="option"]')].find((item) => item.textContent?.includes(f.resource.title))!
  expect(option).toBeTruthy()
  await act(async () => {
    option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    ;(option as HTMLElement).click()
  })
  expect((probe.data.get(f.moving.id) as any).node.position).toEqual({ x: 60, y: 2 })
  await act(async () => (f.host.querySelector('[title="保存画布"]') as HTMLElement).click())
  await act(async () => vi.waitFor(() => expect(f.save).toHaveBeenCalledTimes(1)))
  expect(f.getState().graph.nodes.find((node) => node.id === f.moving.id)!.position).toEqual({ x: 60, y: 2 })
  expect(f.getState().graph.edges.some((edge) => edge.source === f.resource.id && edge.target === f.moving.id && edge.assetId === f.resource.assetId)).toBe(true)
})

it('shares exact snapshots while detecting order, metadata, field removal, revisions and workspace changes', () => {
  const node: CanvasNode = { id: 'node', kind: 'image-generation', title: 'Title', position: { x: 0, y: 0 },
    modelId: null, prompt: '', params: null, assetId: null, selectedResultId: null }
  const state: CanvasSnapshot = { version: 1, workspaceId: 'w', graphRevision: 1, graph: { ...emptyGraph(), nodes: [node, { ...node, id: 'other' }] },
    assets: [], tasks: [{ id: 'task', nodeId: node.id, workspaceId: 'w', status: 'generating', resultIds: [], progress: 1, createdAt: 1, updatedAt: 1 }],
    updatedAt: 1, commitHash: 'a', hashes: { nodes: {}, edges: {}, viewport: '' } }
  expect(shareCanvasSnapshot(state, structuredClone(state))).toBe(state)
  const changed = shareCanvasSnapshot(state, { ...structuredClone(state), tasks: [{ ...state.tasks[0], progress: 2, updatedAt: 3 }] })
  expect(changed.graph).toBe(state.graph); expect(changed.tasks[0]).not.toBe(state.tasks[0])
  const { progress, ...withoutProgress } = changed.tasks[0]
  expect(shareCanvasSnapshot(changed, { ...changed, tasks: [withoutProgress] }).tasks[0]).not.toHaveProperty('progress')
  const reordered = shareCanvasSnapshot(state, { ...structuredClone(state), graph: { ...state.graph, nodes: [...state.graph.nodes].reverse() } })
  expect(reordered.graph.nodes[0]).toBe(state.graph.nodes[1])
  expect(shareCanvasSnapshot(state, { ...state, graphRevision: 2 })).not.toBe(state)
  expect(shareCanvasSnapshot(state, { ...state, workspaceId: 'elsewhere' }).graph).toBe(state.graph)
})

it('retains dirty positions and exposes a conflict when a remote revision arrives during drag', async () => {
  const f = await fixture()
  const before = f.getState()
  f.update({ ...before, graphRevision: 2, graph: { ...before.graph,
    nodes: before.graph.nodes.map((node) => node.id === f.moving.id ? { ...node, title: 'Remote title' } : node) } })
  // Settle the offline save before the remote poll; crypto hashes use a real worker.
  vi.mocked(f.api.save).mockImplementation(async () => { throw new Error('offline') })
  await f.drag()
  await act(async () => vi.advanceTimersByTimeAsync(650))
  await act(async () => vi.waitFor(() => expect(f.host.querySelector('.dc-toast')?.textContent).toContain('offline')))
  await f.poll()
  expect(f.host.querySelector('.dc-conflict')).toBeTruthy()
  expect((probe.data.get(f.moving.id) as any).node.position).toEqual({ x: 60, y: 2 })
  expect((probe.data.get(f.moving.id) as any).node.title).toBe(f.moving.title)
  expect(f.submit).not.toHaveBeenCalled()
})

it('keeps upload entry enabled while receiving, adds new files from button and drop, and tracks separate capsules without refreshing existing media bodies', async () => {
  const f = await fixture(), records = new Map<string, any>()
  const release = new Map<string, () => void>()
  const reportProgress = new Map<string, (bytes: number) => void>()
  const transport: UploadTransport = {
    start: async (_canvas, input) => { records.set(input.requestId, input) },
    status: async (_canvas, id) => ({ id, nodeId: id, state: 'receiving', size: records.get(id).size, offset: 0, chunkBytes: 4 }),
    chunk: async (job, _offset, blob, _sha, progress) => {
      reportProgress.set(job.filename, progress)
      await new Promise<void>((resolve) => release.set(job.filename, resolve))
      progress(blob.size)
      return { id: job.requestId, nodeId: job.requestId, state: 'received', taskId: job.requestId, size: blob.size, offset: blob.size, chunkBytes: 4 }
    },
    complete: async (_canvas, id) => ({ nodeId: id, taskId: id }), cancel: async () => ({}), link: async () => {},
  }
  // Retain acknowledged state for the manager's follow-up GET.
  const originalChunk = transport.chunk, originalStatus = transport.status
  transport.chunk = async (...args) => {
    const accepted = await originalChunk(...args)
    records.get(args[0].requestId).accepted = accepted
    return accepted
  }
  transport.status = async (...args) => records.get(args[1]).accepted ?? originalStatus(...args)
  const uploads = new ResumableUploads(transport, { list: async () => [], put: async () => {}, remove: async () => {} }, 1)
  vi.spyOn(f.api, 'uploads', 'get').mockReturnValue(uploads)
  // Re-render the workspace effect to subscribe to the same shared API manager.
  await act(async () => root!.unmount()); root = undefined
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root!.render(<ReactFlowProvider><CanvasWorkspace api={f.api} workspace="w" title="Test" onBack={() => {}} /></ReactFlowProvider>))
  const input = host.querySelector('input[type="file"]')!
  await act(async () => {
    Object.defineProperty(input, 'files', { configurable: true, value: [new NativeFile(['ab'], 'first.png', { type: 'image/png' })] })
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await act(async () => vi.waitFor(() => expect(release.has('first.png')).toBe(true)))
  const button = [...host.querySelectorAll('button')].find((item) => item.textContent === '上传素材')!
  expect(button.disabled).toBe(false)
  await act(async () => {
    const area = host.querySelector('.dc-canvas-area')!
    vi.spyOn(area, 'getBoundingClientRect').mockReturnValue({ x: 400, y: 0, left: 400, top: 0, right: 900, bottom: 600, width: 500, height: 600, toJSON: () => ({}) })
    const drop = new MouseEvent('drop', { bubbles: true, cancelable: true, clientX: 450, clientY: 100 })
    Object.defineProperty(drop, 'dataTransfer', { value: { types: ['Files'], files: [new NativeFile(['cd'], 'second.png', { type: 'image/png' })], dropEffect: 'none' } })
    area.dispatchEvent(drop)
  })
  await act(async () => vi.waitFor(() => expect(release.has('second.png')).toBe(true)))
  expect(host.querySelectorAll('.dc-upload-capsule')).toHaveLength(2)
  probe.bodies.clear()
  await act(async () => reportProgress.get('second.png')!(1))
  expect(probe.bodies.size).toBe(0)
  expect(host.querySelectorAll('.dc-upload-capsule')[1].getAttribute('aria-valuenow')).toBe('50')
  await act(async () => { release.get('second.png')!(); await vi.waitFor(() => expect(uploads.activities('w')).toHaveLength(1)) })
  expect(host.querySelectorAll('.dc-upload-capsule')).toHaveLength(1)
  expect(host.querySelector('.dc-upload-capsule')?.getAttribute('aria-label')).toContain('first.png')
  await act(async () => { release.get('first.png')!(); await vi.waitFor(() => expect(uploads.activities('w')).toHaveLength(0)) })
  expect(host.querySelector('.dc-upload-capsules')).toBeNull()
})
