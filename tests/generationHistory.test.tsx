// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ReactFlowProvider } from '@xyflow/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HistoryNode } from '../src/client/HistoryNode'
import { generationHistory, historyFrame, resultHandle } from '../src/client/generationHistory'
import { connectionAsset } from '../src/client/generationLayout'
import { promptCandidates } from '../src/client/promptReferences'
import { useGenerationSubmission } from '../src/client/useGenerationSubmission'
import { ApiError, CanvasApi } from '../src/client/api'
import { defaultTtsParams, emptyGraph, type Asset, type CanvasNode } from '../src/shared/contracts'
import { MOCK_MODELS } from '../src/shared/mockModels'
import type { TaskSummary } from '../src/shared/v2'

const roots: Root[] = []
const noop = () => {}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private notify: (entries: Array<{ isIntersecting: boolean }>) => void) {}
    observe() { this.notify([{ isIntersecting: true }]) }; disconnect() {}
  })
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(noop)
})
afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()))
  document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
function fixture(kind: 'image' | 'video' | 'audio' = 'image') {
  const node: CanvasNode = { id: crypto.randomUUID(), kind: kind === 'audio' ? 'tts-generation' : `${kind}-generation`, title: '历史节点',
    position: { x: 0, y: 0 }, modelId: null, prompt: 'hello', params: kind === 'audio' ? defaultTtsParams() : null, assetId: null, selectedResultId: null }
  const tasks: TaskSummary[] = [1, 2, 3].map((createdAt) => ({ id: crypto.randomUUID(), requestId: crypto.randomUUID(), nodeId: node.id,
    workspaceId: 'w', status: createdAt === 3 ? 'generating' : 'completed', createdAt, updatedAt: 20 - createdAt, resultIds: [] }))
  const assets: Asset[] = [tasks[0], tasks[1], tasks[1]].map((task, index) => ({ id: crypto.randomUUID(), nodeId: node.id, taskId: task.id,
    kind, mime: kind === 'image' ? 'image/png' : kind === 'video' ? 'video/mp4' : 'audio/wav', filename: `media-${index}`, bytes: 100, width: 320, height: 180, createdAt: 10 }))
  tasks[0].resultIds = [assets[0].id]; tasks[1].resultIds = assets.slice(1).map((asset) => asset.id)
  return { node, tasks, assets }
}
function props(kind: 'image' | 'video' | 'audio' = 'image') {
  const values = fixture(kind)
  return { ...values, cards: generationHistory(values.node.id, values.tasks, values.assets), connectedAssets: [values.assets[0].id],
    api: new CanvasApi(), workspace: 'w', playing: false, selected: true, expanded: false,
    onPlay: noop, onStop: noop, onRename: noop, onExpand: noop, onOpen: noop, onSize: noop }
}
function mount(element: React.ReactNode) {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container); roots.push(root)
  act(() => root.render(element))
  return { container, root }
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('submission cards and asset ports', () => {
  it('orders equal timestamps by acceptance, ignores completion order and preserves failed/empty submissions', () => {
    const { node, tasks, assets } = fixture()
    tasks[2].status = 'failed'; tasks[2].createdAt = tasks[1].createdAt
    expect(generationHistory(node.id, tasks, assets).map((card) => card.task.id)).toEqual([tasks[2].id, tasks[1].id, tasks[0].id])
    tasks[0].updatedAt = 100
    expect(generationHistory(node.id, tasks, assets)[0].task.id).toBe(tasks[2].id)
    const cards = generationHistory(node.id, tasks, assets)
    expect(cards[0].results).toEqual([])
    expect(cards[1].results).toHaveLength(2)
    expect(historyFrame(cards, false, true).height).toBe(572)
  })
  it.each(['image', 'video', 'audio'] as const)('keeps one card per %s submission, no main choice and one expanded port per actual result', async (kind) => {
    const values = props(kind)
    vi.spyOn(values.api, 'waveform').mockResolvedValue({ version: 1, duration: 10, peaks: Array(96).fill(.5) })
    vi.spyOn(values.api, 'mediaUrls').mockImplementation(async (_canvas, items) => ({ items: items.map((item) => ({
      ...item, url: `https://test.invalid/${item.assetId}`, expiresAt: Date.now() + 3600000,
    })) }))
    if (kind === 'audio') { values.tasks[1].resultIds = [values.assets[1].id]; values.cards = generationHistory(values.node.id, values.tasks, values.assets) }
    const collapsed = mount(<ReactFlowProvider><HistoryNode {...values} /></ReactFlowProvider>).container.innerHTML
    expect(collapsed.match(/class="dc-history-card"/g)).toHaveLength(1)
    expect(collapsed).toContain('展开 3 次提交')
    expect(collapsed).toContain('data-task-status="generating"')
    expect(collapsed).not.toContain('设为主图'); expect(collapsed).not.toContain('· 主图')
    expect(collapsed.match(/aria-hidden="true"[^>]*aria-label="生成后连接输出"/g)).toHaveLength(1)
    const expanded = mount(<ReactFlowProvider><HistoryNode {...values} expanded /></ReactFlowProvider>).container.innerHTML
    expect(expanded.match(/class="dc-history-card"/g)).toHaveLength(3)
    expect(expanded.match(/react-flow__handle-right/g)).toHaveLength(kind === 'audio' ? 2 : 3)
    expect(expanded.match(/data-task-status="generating"/g)).toHaveLength(1)
    expect(expanded).not.toContain('设为主图'); expect(expanded).not.toContain('· 主图')
    expect(expanded.includes('react-flow__handle-left')).toBe(kind !== 'audio')
    await act(async () => { await Promise.resolve() })
  })
  it('rejects collapsed and forged output connections while preserving connected @ references', () => {
    const { node, tasks, assets } = fixture()
    const results = generationHistory(node.id, tasks, assets).flatMap((card) => card.results)
    for (const asset of results) {
      expect(connectionAsset(node, assets, results, resultHandle(asset.id), true, false)).toBeUndefined()
      expect(connectionAsset(node, assets, results, resultHandle(asset.id), true, true)).toBe(asset)
    }
    expect(connectionAsset(node, assets, results, null, true, true)).toBeUndefined()
    expect(connectionAsset(node, assets, results, resultHandle(crypto.randomUUID()), true, true)).toBeUndefined()
    const target = { ...node, id: crypto.randomUUID() }
    const graph = { ...emptyGraph(), nodes: [node, target] }
    expect(promptCandidates(graph, target.id, assets, tasks, MOCK_MODELS[0].capabilities)).toEqual([])
    graph.edges.push({ id: crypto.randomUUID(), source: node.id, target: target.id, assetId: assets[0].id })
    expect(promptCandidates(graph, target.id, assets, tasks, MOCK_MODELS[0].capabilities).map((item) => item.assetId)).toEqual([assets[0].id])
    expect(graph.edges[0].assetId).toBe(assets[0].id)
  })
  it('keeps Loading within its own card while completed images decode and media errors settle independently', async () => {
    const values = props()
    vi.spyOn(values.api, 'mediaUrls').mockImplementation(async (_canvas, items) => ({ items: items.map((item) => ({
      ...item, url: `https://test.invalid/${item.assetId}`, expiresAt: Date.now() + 3600000,
    })) }))
    const { container, root } = mount(<ReactFlowProvider><HistoryNode {...values} expanded /></ReactFlowProvider>)
    await act(async () => { await Promise.resolve() })
    const cards = [...container.querySelectorAll('.dc-history-card')]
    expect(cards).toHaveLength(3)
    expect(cards[0].querySelector('[data-task-status="generating"]')).toBeTruthy()
    const images = [...cards[1].querySelectorAll('img')]
    act(() => { for (const image of images) image.dispatchEvent(new Event('load')) })
    await act(async () => { await Promise.resolve() })
    expect(cards[1].querySelector('.dc-node-loading')).toBeNull()
    expect(cards[0].querySelector('[data-task-status="generating"]')).toBeTruthy()
    await act(async () => { cards[2].querySelector('img')!.dispatchEvent(new Event('error')); await Promise.resolve() })
    act(() => cards[2].querySelector('img')!.dispatchEvent(new Event('error')))
    expect(cards[2].querySelector('.dc-node-loading')).toBeNull()
    expect(cards[0].querySelector('[data-task-status="generating"]')).toBeTruthy()
    values.tasks[2].status = 'completed'; values.tasks[2].resultIds = [values.assets[0].id]
    await act(async () => { root.render(<ReactFlowProvider><HistoryNode {...values} cards={generationHistory(values.node.id, values.tasks, values.assets)} expanded /></ReactFlowProvider>) })
    expect(container.querySelector('.dc-history-card')).toBe(cards[0])
    expect(cards[0].querySelector('[data-task-status="generating"]')).toBeNull()
    expect(cards[0].querySelector('[data-task-status="media-loading"]')).toBeTruthy()
  })
})

describe('instant submission and acknowledgement reconciliation', () => {
  function setup(kind: 'image' | 'audio' = 'image') {
    const values = fixture(kind)
    let tasks = values.tasks.slice(0, 1), submission!: ReturnType<typeof useGenerationSubmission>
    const saving = deferred<number>(), response = deferred<TaskSummary>(), refreshed = deferred<void>()
    const api = new CanvasApi()
    const method = kind === 'audio' ? 'ttsGenerate' : 'generate'
    const send = vi.spyOn(api, method).mockReturnValue(response.promise)
    const flush = vi.fn(() => saving.promise), refresh = vi.fn(() => refreshed.promise), report = vi.fn()
    function Harness() {
      submission = useGenerationSubmission({ api, workspace: 'w', tasks, flush, refresh, report })
      return <div data-submitting={submission.submitting}>{submission.tasks.map((task) => <div key={task.requestId ?? task.id} data-id={task.id} data-status={task.status} />)}</div>
    }
    const mounted = mount(<Harness />)
    const authoritative = async (next: TaskSummary[]) => {
      tasks = next
      await act(async () => { mounted.root.render(<Harness />) })
    }
    return { ...mounted, values, saving, response, refreshed, send, flush, refresh, report, authoritative, read: () => submission }
  }
  it.each(['image', 'audio'] as const)('adds a %s Loading card before saving or POST and replaces it by exact request identity without duplicates', async (kind) => {
    const test = setup(kind)
    let promise!: Promise<void>
    act(() => { promise = test.read().generate(test.values.node); void test.read().generate(test.values.node) })
    expect(test.read().tasks).toHaveLength(2); expect(test.flush).toHaveBeenCalledTimes(1)
    expect(test.send).not.toHaveBeenCalled()
    const pending = test.read().tasks[1], element = test.container.querySelector(`[data-id="${pending.id}"]`)
    await act(async () => { test.saving.resolve(5); await Promise.resolve() })
    expect(test.send).toHaveBeenCalledWith('w', test.values.node.id, 5, pending.requestId)
    const accepted = { ...pending, id: crypto.randomUUID(), status: 'generating' as const, createdAt: pending.createdAt - 1 }
    await act(async () => { test.response.resolve(accepted); await Promise.resolve() })
    expect(test.read().tasks).toHaveLength(2)
    expect(test.container.querySelector(`[data-id="${accepted.id}"]`)).toBe(element)
    await test.authoritative([test.values.tasks[0], { ...accepted, status: 'completed' }])
    expect(test.read().tasks).toHaveLength(2); expect(test.read().tasks[1].status).toBe('completed')
    await act(async () => { test.refreshed.resolve(); await promise })
    expect(test.read().submitting).toBe(false)
  })
  it.each(['flush', 'rejected'] as const)('removes only an unaccepted card on a %s failure and keeps earlier results', async (failure) => {
    const test = setup()
    let promise!: Promise<void>
    act(() => { promise = test.read().generate(test.values.node) })
    await act(async () => {
      if (failure === 'flush') test.saving.reject(new Error('save conflict'))
      else { test.saving.resolve(5); await Promise.resolve(); test.response.reject(new ApiError('invalid request', 'INVALID', 400)) }
      await promise
    })
    expect(test.read().tasks).toEqual([test.values.tasks[0]])
    expect(test.read().submitting).toBe(false); expect(test.report).toHaveBeenCalledTimes(1)
  })
  it('retains an ambiguous submission until GET returns the exact requestId, without matching another task or sending again', async () => {
    const test = setup()
    let promise!: Promise<void>
    act(() => { promise = test.read().generate(test.values.node) })
    const pending = test.read().tasks[1]
    await act(async () => { test.saving.resolve(5); await Promise.resolve(); test.response.reject(new TypeError('response lost')); await promise })
    expect(test.read().tasks[1].status).toBe('unknown')
    const other = { ...pending, id: crypto.randomUUID(), requestId: crypto.randomUUID() }
    await test.authoritative([test.values.tasks[0], other])
    expect(test.read().tasks).toHaveLength(3)
    const accepted = { ...pending, id: crypto.randomUUID(), status: 'completed' as const }
    await test.authoritative([test.values.tasks[0], other, accepted])
    expect(test.read().tasks).toHaveLength(3)
    expect(test.read().tasks.some((task) => task.id === pending.id)).toBe(false)
    expect(test.send).toHaveBeenCalledTimes(1)
  })
  it('keeps an accepted card when the following refresh fails', async () => {
    const test = setup()
    let promise!: Promise<void>
    act(() => { promise = test.read().generate(test.values.node) })
    const pending = test.read().tasks[1], accepted = { ...pending, id: crypto.randomUUID() }
    await act(async () => {
      test.saving.resolve(5); await Promise.resolve(); test.response.resolve(accepted); await Promise.resolve()
      test.refreshed.reject(new Error('GET failed')); await promise
    })
    expect(test.read().tasks[1]).toEqual(accepted)
    expect(test.send).toHaveBeenCalledTimes(1)
  })
  it('treats an incomplete success response as uncertain instead of replacing the card with invalid task data', async () => {
    const test = setup()
    let promise!: Promise<void>
    act(() => { promise = test.read().generate(test.values.node) })
    await act(async () => { test.saving.resolve(5); await Promise.resolve(); test.response.resolve({} as TaskSummary); await promise })
    expect(test.read().tasks).toHaveLength(2)
    expect(test.read().tasks[1].status).toBe('unknown')
    expect(test.refresh).not.toHaveBeenCalled(); expect(test.send).toHaveBeenCalledTimes(1)
  })
})
