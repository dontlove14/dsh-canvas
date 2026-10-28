// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ReactFlowProvider } from '@xyflow/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CanvasWorkspace } from '../src/client/Canvas'
import { CanvasApi } from '../src/client/api'
import { defaultTtsParams, emptyGraph, FISH_TTS_ENDPOINT, type AnyTaskSnapshot, type Asset, type CanvasNode } from '../src/shared/contracts'
import { BUILTIN_MODELS } from '../src/shared/modelCatalog'
import { MOCK_MODELS, mockRecord } from '../src/shared/mockModels'
import { historyEditorAnchor, generationHistory } from '../src/client/generationHistory'
import type { CanvasSnapshot, TaskDetail, TaskSummary } from '../src/shared/v2'

// Only canvas geometry is replaced; actual nodes, editor, reads, saves and dispatch stay real.
vi.mock('@xyflow/react', async (original) => ({
  ...await original<typeof import('@xyflow/react')>(),
  Background: () => null, Controls: () => null, MiniMap: () => null,
  ReactFlow: ({ nodes, nodeTypes, children }: any) => <div>{nodes.map((node: any) => {
    const Component = nodeTypes[node.type]
    return <div key={node.id}><Component id={node.id} data={node.data} selected={node.selected} /></div>
  })}{children}</div>,
}))
vi.mock('../src/client/useGpu', () => ({ useGpuCapability: () => ({ enabled: false, reason: 'test' }) }))
// Video eligibility uses a protocol fixture because this installation has no real video preset.
vi.mock('../src/shared/modelCatalog', async (original) => {
  const module = await original<typeof import('../src/shared/modelCatalog')>()
  return { ...module, builtinDefinition: (model: any) => model.api_base === 'http://test.invalid' ? model : module.builtinDefinition(model) }
})
const roots: Root[] = []
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {}; disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private notify: (entries: Array<{ isIntersecting: boolean }>) => void) {}
    observe() { this.notify([{ isIntersecting: true }]) }; disconnect() {}
  })
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
})
afterEach(async () => {
  await act(async () => { roots.splice(0).forEach((root) => root.unmount()) })
  document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => { resolve = yes })
  return { promise, resolve }
}
async function setup(kind: 'image' | 'video' | 'audio' = 'image', missingModel = false) {
  const model = kind === 'video' ? { ...MOCK_MODELS[2], id: crypto.randomUUID(), model_id: 'sora-2', name: 'Video fixture',
    api_base: 'http://test.invalid', has_api_key: true } : { ...MOCK_MODELS[0], ...BUILTIN_MODELS[0], has_api_key: true }
  const node: CanvasNode = { id: crypto.randomUUID(), kind: kind === 'audio' ? 'tts-generation' : `${kind}-generation`,
    title: '历史', position: { x: 700, y: 900 }, prompt: '当前草稿不同', modelId: kind === 'audio' ? null : model.id,
    params: kind === 'audio' ? defaultTtsParams() : { size: '1024x1024', n: 1 }, assetId: null, selectedResultId: null }
  const tasks: TaskSummary[] = [1, 2].map((createdAt) => ({ id: crypto.randomUUID(), requestId: crypto.randomUUID(),
    nodeId: node.id, workspaceId: 'w', status: 'completed', createdAt, updatedAt: 4 - createdAt, resultIds: [] }))
  const assets: Asset[] = tasks.map((task) => ({ id: crypto.randomUUID(), taskId: task.id, nodeId: node.id, kind,
    mime: kind === 'audio' ? 'audio/wav' : kind === 'image' ? 'image/png' : 'video/mp4',
    filename: '结果', bytes: 100, width: 320, height: 180, createdAt: 5 }))
  tasks.forEach((task, index) => { task.resultIds = [assets[index].id] })
  const refs = [crypto.randomUUID(), crypto.randomUUID()]
  const inputs: AnyTaskSnapshot[] = tasks.map((_task, index) => kind === 'audio' ? {
    model: { id: crypto.randomUUID(), kind: 'audio', name: 'FishTTS', model_id: 'fish-tts', protocol: 'fish-tts', api_base: FISH_TTS_ENDPOINT },
    prompt: `(happy) 语音提交${index}`, params: { type: 'tts', reference_id: `voice-${index}`, speed: 1 + index * .2, volume: index }, referenceIds: [],
  } : { model: kind === 'image' ? { ...BUILTIN_MODELS[0], name: index ? '最近模型' : '历史模型' } :
    { id: model.id, kind: 'video', model_id: model.model_id, name: model.name, api_base: model.api_base, protocol: 'openai-video' },
    prompt: `提示词提交${index} [参考图1]`, params: { size: kind === 'image' ? index ? '1280x720' : '1024x1024' : index ? '720x1280' : '1280x720', n: 1,
      ...(kind === 'video' ? { seconds: index ? 8 : 4 } : { quality: index ? 'high' as const : 'low' as const, background: 'transparent' as const }) },
    referenceIds: kind === 'image' ? refs : [],
  })
  const details: TaskDetail[] = tasks.map((task, index) => ({ task: {
    id: task.id, nodeId: node.id, workspaceId: 'w', status: task.status, resultIds: task.resultIds, createdAt: task.createdAt,
    updatedAt: task.updatedAt, snapshot: inputs[index],
  } } as TaskDetail))
  let state: CanvasSnapshot = { version: 1, workspaceId: 'w', graphRevision: 1, graph: { ...emptyGraph(), nodes: [node] },
    assets, tasks, updatedAt: 1, commitHash: 'a'.repeat(64), hashes: { nodes: {}, edges: {}, viewport: '' } }
  const api = new CanvasApi()
  vi.spyOn(api, 'state').mockImplementation(async () => state)
  vi.spyOn(api, 'models').mockResolvedValue(missingModel ? [] : [model])
  vi.spyOn(api, 'ttsSettings').mockResolvedValue({ endpoint: FISH_TTS_ENDPOINT, revision: 1, configured: true, has_api_key: true, api_key_mask: '' })
  vi.spyOn(api, 'waveform').mockResolvedValue({ version: 1, duration: 10, peaks: Array(96).fill(.5) })
  vi.spyOn(api, 'mediaUrls').mockImplementation(async (_canvas, items) => ({ items: items.map((item) => ({
    ...item, url: `https://test.invalid/${item.assetId}`, expiresAt: Date.now() + 3600000,
  })) }))
  vi.spyOn(api, 'taskDetail').mockImplementation(async (_canvas, id) => details.find((detail) => detail.task!.id === id)!)
  const save = vi.spyOn(api, 'save').mockImplementation(async (_canvas, mutation) => {
    state = { ...state, graphRevision: state.graphRevision + 1, graph: { ...state.graph,
      nodes: state.graph.nodes.map((node) => mutation.nodes.find((item) => item.value.id === node.id)?.value ?? node) } }
    return state
  })
  const submit = vi.spyOn(api, kind === 'audio' ? 'ttsGenerate' : 'generate').mockImplementation(async (_canvas, id, _revision, requestId) => {
    const task: TaskSummary = { id: crypto.randomUUID(), requestId, nodeId: id, workspaceId: 'w', status: 'submitted',
      resultIds: [], createdAt: 10, updatedAt: 10 }
    state = { ...state, tasks: [...state.tasks, task] }
    return task
  })
  const upload = vi.spyOn(api, 'upload')
  const action = vi.spyOn(api, 'taskAction')
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container); roots.push(root)
  const show = async (active = true) => act(async () => { root.render(<ReactFlowProvider><CanvasWorkspace api={api} workspace="w" title="测试" active={active} onBack={() => {}} /></ReactFlowProvider>) })
  await show()
  const click = async (element: Element) => act(async () => { (element as HTMLElement).click() })
  const card = (index: number) => container.querySelector(`[data-task-id="${tasks[index].id}"]`)!
  // Select via a real card, then expand via its real toolbar.
  await click(card(1))
  await click(container.querySelector('[title="保存画布"]')!)
  await click(container.querySelector('[title="展开提交记录"]')!)
  return { api, container, tasks, node, assets, inputs, details, refs, card, click, show, save, submit, upload, action, getState: () => state }
}

describe('historical generation inspection', () => {
  it.each(['image', 'video', 'audio'] as const)('shows exact %s inputs readonly with no save, upload, action or submission when inspected', async (kind) => {
    const f = await setup(kind, true)
    const before = f.save.mock.calls.length
    for (const index of [0, 1, 0]) {
      await f.click(f.card(index).querySelector('[data-asset-id]')!)
      const panel = f.container.querySelector('[aria-label="生成记录（只读）"]')!
      const text = panel.querySelector('[role="textbox"]')!
      expect(text.textContent).toBe(f.inputs[index].prompt)
      expect(text.getAttribute('aria-readonly')).toBe('true')
      expect(text.getAttribute('contenteditable')).toBe('false')
      expect(panel.querySelector('button,input,[role="combobox"],[contenteditable="true"]')).toBeNull()
      expect(panel.textContent).toContain(kind === 'audio' ? `voice-${index}` : f.inputs[index].params.size)
      expect(panel.textContent).not.toContain('当前草稿不同')
      if (kind === 'image') {
        expect(panel.textContent).toContain(index ? '最近模型' : '历史模型')
        expect([...panel.querySelectorAll('img')].map((img) => img.getAttribute('src'))).toEqual(f.refs.map((id) => `https://test.invalid/${id}`))
      }
      await act(async () => {
        text.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: 'insertText', data: '改动' }))
        text.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', ctrlKey: true }))
      })
      expect(f.save.mock.calls.length).toBe(before)
      expect(f.submit).not.toHaveBeenCalled(); expect(f.upload).not.toHaveBeenCalled(); expect(f.action).not.toHaveBeenCalled()
    }
    expect(f.api.taskDetail).toHaveBeenCalledTimes(2)
    expect(f.container.querySelectorAll('.react-flow__handle.source')).toHaveLength(2)
  })
  it('ignores a late response after another card is selected and after the canvas is hidden', async () => {
    const f = await setup()
    const slow = deferred<TaskDetail>()
    vi.mocked(f.api.taskDetail).mockImplementation(async (_canvas, id) => id === f.tasks[0].id ? slow.promise : f.details[1])
    await f.click(f.card(0))
    const signal = vi.mocked(f.api.taskDetail).mock.calls.at(-1)![2]!
    await f.click(f.card(1))
    expect(signal.aborted).toBe(true)
    await act(async () => slow.resolve(f.details[0]))
    expect(f.container.querySelector('.dc-snapshot-prompt')!.textContent).toBe(f.inputs[1].prompt)
    await f.show(false)
    expect(f.container.querySelector('.dc-snapshot-editor')).toBeNull()
  })
  it.each(['image', 'video', 'audio'] as const)('restores the latest %s submission on collapse, preserves subsequent edits and submits them', async (kind) => {
    const f = await setup(kind)
    await f.click(f.card(0))
    await f.click([...f.container.querySelectorAll('.dc-group-actions button')].find((button) => button.textContent === '收起')!)
    expect(f.container.querySelector('.dc-editor')).toBeNull()
    await f.click(f.card(1))
    const prompt = f.container.querySelector('[role="textbox"]')!
    expect(prompt.getAttribute('contenteditable')).toBe('true')
    expect(f.getState().graph.nodes[0].prompt).not.toBe(f.inputs[0].prompt)
    const expected = kind === 'image' ? f.inputs[1].prompt.replace('[参考图1]', `{{asset:${f.refs[0]}}}`) : f.inputs[1].prompt
    expect(prompt.textContent).toContain(kind === 'audio' ? '语音提交1' : '提示词提交1')
    // Actual editor input writes only the new draft; another node click must retain it.
    await act(async () => {
      prompt.textContent = '修改后的新提示词'
      prompt.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }))
    })
    await f.click(f.card(1))
    expect(f.container.querySelector('[role="textbox"]')!.textContent).toBe('修改后的新提示词')
    await f.click(f.container.querySelector(kind === 'audio' ? '[aria-label="生成语音"]' : '[aria-label="生成"]')!)
    expect(f.submit).toHaveBeenCalledTimes(1)
    const saved = f.getState().graph.nodes[0]
    expect(saved.prompt).toBe('修改后的新提示词')
    expect(saved.params).toEqual(f.inputs[1].params)
    expect(f.getState().graph.edges).toEqual([])
    expect(f.save.mock.calls[0][1].nodes[0].value.prompt).toBe(expected)
    await f.click(f.container.querySelector('[title="展开提交记录"]')!)
    expect(f.container.querySelectorAll('.dc-history-card')).toHaveLength(3)
  })
  it.each(['failure', 'wrong-task', 'wrong-workspace', 'wrong-kind'] as const)('blocks editing when latest snapshot has %s', async (mode) => {
    const f = await setup()
    await f.click(f.card(0))
    vi.mocked(f.api.taskDetail).mockImplementation(async () => {
      if (mode === 'failure') throw new Error('unavailable')
      return { ...f.details[1], task: { ...f.details[1].task!,
        ...(mode === 'wrong-task' ? { id: f.tasks[0].id } : mode === 'wrong-workspace' ? { workspaceId: 'other' } :
          { snapshot: { ...f.inputs[1], model: mockRecord(MOCK_MODELS[2].id) } }),
      } } as TaskDetail
    })
    // Latest was cached by initial collapsed selection: use another acknowledged identity.
    f.tasks[1].id = crypto.randomUUID()
    await f.click([...f.container.querySelectorAll('.dc-group-actions button')].find((button) => button.textContent === '收起')!)
    await f.click(f.card(1))
    expect(f.container.querySelector('[contenteditable="true"],[aria-label="生成"]')).toBeNull()
    expect(f.container.querySelector('[role="alert"]')!.textContent).toContain('生成记录读取失败')
    expect(f.submit).not.toHaveBeenCalled()
  })
  it('anchors a clicked cell in a later task and second grid row without changing canvas coordinates', async () => {
    const f = await setup()
    const extra = [1, 2].map(() => ({ ...f.assets[0], id: crypto.randomUUID() }))
    const cards = generationHistory(f.node.id, f.tasks, [...f.assets, ...extra])
    cards[1].results.push(...extra)
    const anchor = historyEditorAnchor(f.node, cards, f.tasks[0].requestId!, extra[1].id)!
    expect(anchor).toMatchObject({ position: { x: 700, y: 1286 }, size: { width: 320, height: 180 } })
  })
  it('waits for the latest pending acceptance on collapse and never restores or submits an older card', async () => {
    const f = await setup('audio')
    await f.click([...f.container.querySelectorAll('.dc-group-actions button')].find((button) => button.textContent === '收起')!)
    await f.click(f.card(1))
    const accepted = deferred<TaskSummary>()
    vi.mocked(f.api.ttsGenerate).mockReturnValueOnce(accepted.promise)
    await f.click(f.container.querySelector('[aria-label="生成语音"]')!)
    const requestId = vi.mocked(f.api.ttsGenerate).mock.calls.at(-1)![3]!
    await f.click(f.container.querySelector('[title="展开提交记录"]')!)
    await f.click(f.card(0))
    await f.click([...f.container.querySelectorAll('.dc-group-actions button')].find((button) => button.textContent === '收起')!)
    await f.click(f.container.querySelector('.dc-history-card')!)
    expect(f.container.querySelector('[aria-label="生成语音"],[contenteditable="true"]')).toBeNull()
    expect(vi.mocked(f.api.taskDetail).mock.calls.some((call) => call[1] === requestId)).toBe(false)
    const task: TaskSummary = { id: crypto.randomUUID(), requestId, nodeId: f.node.id, workspaceId: 'w',
      status: 'generating', resultIds: [], createdAt: Date.now(), updatedAt: Date.now() }
    const snapshot = { ...f.inputs[1], prompt: '最新接受的文本' }
    vi.mocked(f.api.taskDetail).mockResolvedValue({ task: { ...f.details[1].task!, id: task.id, snapshot } } as TaskDetail)
    await act(async () => { accepted.resolve(task) })
    expect(f.container.querySelector('[contenteditable="true"]')!.textContent).toBe('最新接受的文本')
    expect(f.api.ttsGenerate).toHaveBeenCalledTimes(1)
  })
})
