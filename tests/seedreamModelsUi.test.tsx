// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ReactFlowProvider } from '@xyflow/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CanvasApi } from '../src/client/api'
import { CanvasWorkspace } from '../src/client/Canvas'
import { ModelSettings } from '../src/client/Settings'
import { ModelPicker, selectableModels } from '../src/client/ModelPicker'
import { GenerationParameters } from '../src/client/GenerationParameters'
import { GenerationSnapshotEditor } from '../src/client/GenerationSnapshotEditor'
import { TaskDialog } from '../src/client/TaskDialog'
import { BUILTIN_MODELS, SEEDREAM_MODELS, seedreamRequiresEndpoint } from '../src/shared/modelCatalog'
import { capabilitiesFor, defaultParams, emptyGraph, type PublicModel, type Task } from '../src/shared/contracts'
import type { CanvasSnapshot, TaskDetail, TaskRow } from '../src/shared/v2'

vi.mock('@xyflow/react', async (original) => ({
  ...await original<typeof import('@xyflow/react')>(),
  Background: () => null, Controls: () => null, MiniMap: () => null,
  ReactFlow: ({ nodes, nodeTypes, children, onNodesChange, onNodeClick }: any) => <div>{nodes.map((node: any) => {
    const Component = nodeTypes[node.type]
    return <div key={node.id} data-node-id={node.id} onClick={(event) => {
      onNodesChange([{ id: node.id, type: 'select', selected: true }]); onNodeClick(event, node)
    }}><Component id={node.id} data={node.data} selected={node.selected} /></div>
  })}{children}</div>,
}))
vi.mock('../src/client/useGpu', () => ({ useGpuCapability: () => ({ enabled: false, reason: 'test' }) }))
const roots: Root[] = [], endpointId = 'ep-private-routing-123'
const catalog = (): PublicModel[] => BUILTIN_MODELS.map((model) => ({ ...model, has_api_key: false, api_key_mask: '',
  configurable: true, capabilities: capabilitiesFor(model) }))
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {}; disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {}; disconnect() {} })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1 })
  HTMLDialogElement.prototype.showModal = function () { this.open = true }
  HTMLDialogElement.prototype.close = function () { this.open = false }
})
afterEach(() => { act(() => roots.splice(0).forEach((root) => root.unmount())); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
function mount(element: React.ReactNode) {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container); roots.push(root); act(() => root.render(element)); return container
}
const button = (host: ParentNode, text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((element) => element.textContent === text)!
function choose(host: ParentNode, label: string, value: string) {
  const select = host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!
  act(() => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })) })
}
function input(host: ParentNode, selector: string, value: string) {
  const element = host.querySelector<HTMLInputElement>(selector)!
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value)
  act(() => element.dispatchEvent(new Event('input', { bubbles: true })))
}

it.each(SEEDREAM_MODELS)('offers only the authorized providers for $name and requires EP only for official channels', async (model) => {
  const api = new CanvasApi(), list = catalog(), standard = !model.id.startsWith('dola')
  vi.spyOn(api, 'models').mockResolvedValue(list)
  const definition = list.find((item) => item.model_id === model.id && seedreamRequiresEndpoint(item))!
  const save = vi.spyOn(api, 'saveModel').mockResolvedValue(list)
  const container = mount(<ModelSettings api={api} />)
  await act(async () => {})
  act(() => button(container, '＋ 配置模型').click())
  choose(container, '配置模型', `image:${model.id}`)
  expect([...container.querySelector<HTMLSelectElement>('select[aria-label="配置供应商"]')!.options].map((option) => option.text))
    .toEqual(standard ? ['Model Link', 'ByteDance'] : ['BytePlus'])
  if (standard) {
    expect(container.querySelector('[aria-label="模型供应商 EP"]')).toBeNull()
    input(container, 'input[aria-label="模型供应商 API Key"]', 'unsaved-link')
    choose(container, '配置供应商', definition.api_base)
    expect(container.querySelector<HTMLInputElement>('input[aria-label="模型供应商 API Key"]')!.value).toBe('')
  }
  input(container, 'input[aria-label="模型供应商 API Key"]', 'official-key')
  expect(button(container, '保存配置').disabled).toBe(true)
  input(container, '[aria-label="模型供应商 EP"]', endpointId)
  expect(button(container, '保存配置').disabled).toBe(false)
  if (standard) {
    choose(container, '配置供应商', 'https://api.modellink.online/v1')
    expect(container.querySelector('[aria-label="模型供应商 EP"]')).toBeNull()
    choose(container, '配置供应商', definition.api_base)
    expect(container.querySelector<HTMLInputElement>('[aria-label="模型供应商 EP"]')!.value).toBe('')
    input(container, '[aria-label="模型供应商 EP"]', endpointId)
    input(container, 'input[aria-label="模型供应商 API Key"]', 'official-key')
  }
  await act(async () => button(container, '保存配置').click())
  const { capabilities: _c, has_api_key: _k, api_key_mask: _m, configurable: _f, ...record } = definition
  expect(save).toHaveBeenCalledWith({ ...record, endpoint_id: endpointId, api_key: 'official-key' })
})

it('retains saved official EP while leaving the existing key unchanged and removes EP from Model Link inputs', async () => {
  const api = new CanvasApi(), list = catalog().map((model) => model.id === BUILTIN_MODELS[13].id
    ? { ...model, has_api_key: true, endpoint_id: endpointId } : model)
  vi.spyOn(api, 'models').mockResolvedValue(list)
  const save = vi.spyOn(api, 'saveModel').mockResolvedValue(list)
  const host = mount(<ModelSettings api={api} />)
  await act(async () => {})
  act(() => button(host, '＋ 配置模型').click())
  choose(host, '配置模型', `image:${list[13].model_id}`)
  choose(host, '配置供应商', list[13].api_base)
  expect(host.querySelector<HTMLInputElement>('[aria-label="模型供应商 EP"]')!.value).toBe(endpointId)
  await act(async () => button(host, '保存配置').click())
  expect(save.mock.calls[0][0]).toMatchObject({ endpoint_id: endpointId, api_key: undefined, model_id: list[13].model_id })
  act(() => button(host, '＋ 配置模型').click())
  choose(host, '配置模型', `image:${list[12].model_id}`)
  input(host, 'input[aria-label="模型供应商 API Key"]', 'link-key')
  await act(async () => button(host, '保存配置').click())
  expect(save.mock.calls[1][0]).not.toHaveProperty('endpoint_id')
})

it.each(SEEDREAM_MODELS)('renders supported $name tiers, ordered ratios and one output', (model) => {
  const selected = catalog().find((item) => item.model_id === model.id)!, pro = model.id.includes('-pro-'), changed = vi.fn()
  function Parameters() {
    const [params, setParams] = useState(defaultParams(selected))
    return <GenerationParameters model={selected} params={params} disabled={false} onChange={(next) => { setParams(next); changed(next) }} />
  }
  const host = mount(<Parameters />)
  act(() => host.querySelector('button')!.click())
  const dialog = document.querySelector('[role="dialog"]')!
  expect(dialog.textContent).not.toMatch(/背景|画质/)
  expect([...dialog.querySelectorAll('.dc-ratio-options button')].map((option) => option.textContent))
    .toEqual(['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9', '21:9'])
  expect(button(dialog, '2K').getAttribute('aria-pressed')).toBe('true')
  expect([...dialog.querySelectorAll('.dc-param-options button')].map((option) => option.textContent)).toEqual(pro ? ['1K', '1.5K', '2K'] : ['2K', '3K', '4K'])
  act(() => button(dialog, '21:9').click())
  act(() => button(dialog, pro ? '1K' : '4K').click())
  expect(changed).toHaveBeenLastCalledWith({ size: pro ? '1568x672' : '6240x2656', n: 1 })
})

it('hides incomplete official configurations and displays logical names without EP in the picker', () => {
  const list = catalog().filter((model) => model.protocol === 'seedream-image').map((model, index) => ({
    ...model, has_api_key: index < 4, ...(index === 3 ? { endpoint_id: endpointId } : {}),
  }))
  expect(selectableModels(list).map((model) => model.id)).toEqual([list[0].id, list[2].id, list[3].id])
  const host = mount(<ModelPicker models={list} value={list[3].id} disabled={false} onChange={vi.fn()} />)
  expect(host.textContent).toContain('Seedream 5.0 Pro · ByteDance')
  act(() => host.querySelector('button')!.click())
  expect(document.body.textContent).not.toContain(endpointId)
  expect(document.body.innerHTML).not.toContain(endpointId)
})

it('shows the logical model name in canvas editing, immutable history and task center while keeping EP in the snapshot', async () => {
  const model = { ...BUILTIN_MODELS[13], endpoint_id: endpointId }, api = new CanvasApi()
  const node = { id: crypto.randomUUID(), kind: 'image-generation' as const, title: model.name, position: { x: 0, y: 0 },
    modelId: model.id, prompt: '树木', params: defaultParams(model), assetId: null, selectedResultId: null }
  const task: Task = { id: crypto.randomUUID(), workspaceId: 'w', nodeId: node.id, status: 'completed', createdAt: 1, updatedAt: 2,
    resultIds: [], snapshot: { model, prompt: node.prompt, params: node.params, referenceIds: [] } }
  const detail: TaskDetail = { task, kind: 'generation', phase: 'completed', externalTaskId: null, externalCompletedAt: 2,
    successAt: 2, failureStage: null, failureCode: null, failureMessage: null, attempts: [] }
  const state: CanvasSnapshot = { version: 1, workspaceId: 'w', graphRevision: 1, graph: { ...emptyGraph(), nodes: [node] },
    assets: [], tasks: [], updatedAt: 1, commitHash: 'a'.repeat(64), hashes: { nodes: {}, edges: {}, viewport: '' } }
  vi.spyOn(api, 'state').mockResolvedValue(state)
  vi.spyOn(api, 'models').mockResolvedValue([{ ...model, has_api_key: true, api_key_mask: '', capabilities: capabilitiesFor(model) }])
  vi.spyOn(api, 'ttsSettings').mockResolvedValue({ endpoint: 'https://api.modellink.online/fish/v1/tts', revision: 0, configured: false, has_api_key: false, api_key_mask: '' })
  vi.spyOn(api, 'taskDetail').mockResolvedValue(detail)
  const host = mount(<ReactFlowProvider><CanvasWorkspace api={api} workspace="w" active title="测试" onBack={vi.fn()} /></ReactFlowProvider>)
  await act(async () => {})
  await act(async () => host.querySelector<HTMLElement>('[data-node-id]')!.click())
  expect(host.textContent).toContain(model.name)
  expect(host.innerHTML).not.toContain(endpointId)
  mount(<ReactFlowProvider><GenerationSnapshotEditor api={api} workspace="w" snapshot={task.snapshot} anchor={{ position: node.position, size: { width: 320, height: 200 } }} /></ReactFlowProvider>)
  expect(document.body.textContent).toContain('生成记录')
  const row: TaskRow = { id: task.id, canvasId: 'w', nodeId: node.id, folderName: '', canvasName: '测试', nodeName: node.title,
    type: 'image', status: task.status, createdAt: 1, updatedAt: 2 }
  vi.spyOn(api, 'searchTasks').mockResolvedValue({ items: [row], total: 1, page: 1, pageSize: 20, upperBound: 1 })
  mount(<TaskDialog api={api} onClose={vi.fn()} />)
  await act(async () => {})
  await act(async () => button(document, '查看详情').click())
  expect(document.body.textContent).toContain(`模型：${model.name}`)
  expect(document.body.innerHTML).not.toContain(endpointId)
  expect(task.snapshot.model.endpoint_id).toBe(endpointId)
})
