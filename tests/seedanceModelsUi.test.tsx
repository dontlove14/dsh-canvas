// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ReactFlowProvider } from '@xyflow/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { FloatingEditor } from '../src/client/Canvas'
import { CanvasApi } from '../src/client/api'
import { ModelSettings } from '../src/client/Settings'
import { ModelPicker, selectableModels } from '../src/client/ModelPicker'
import { GenerationParameters } from '../src/client/GenerationParameters'
import { GenerationSnapshotEditor } from '../src/client/GenerationSnapshotEditor'
import { BUILTIN_MODELS, SEEDANCE_MODELS, seedanceRequiresEndpoint } from '../src/shared/modelCatalog'
import { capabilitiesFor, defaultParams, emptyGraph, type Asset, type CanvasNode, type GenerationParams, type PublicModel } from '../src/shared/contracts'

const roots: Root[] = [], ep = 'ep-private-video-routing'
const catalog = (): PublicModel[] => BUILTIN_MODELS.map((model) => ({ ...model, has_api_key: false, api_key_mask: '',
  configurable: true, capabilities: capabilitiesFor(model) }))
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {}; disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {}; disconnect() {} })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1 })
})
afterEach(() => { act(() => roots.splice(0).forEach((root) => root.unmount())); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
function mount(element: React.ReactNode) {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host); roots.push(root); act(() => root.render(element)); return host
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

it.each(SEEDANCE_MODELS)('configures independent $name providers and requires EP only on official channels', async (model) => {
  const list = catalog(), api = new CanvasApi(), standard = model.id.startsWith('doubao')
  vi.spyOn(api, 'models').mockResolvedValue(list)
  const save = vi.spyOn(api, 'saveModel').mockResolvedValue(list)
  const host = mount(<ModelSettings api={api} />)
  await act(async () => {})
  act(() => button(host, '＋ 配置模型').click())
  choose(host, '配置模型', `video:${model.id}`)
  expect([...host.querySelector<HTMLSelectElement>('select[aria-label="配置供应商"]')!.options].map((option) => option.text))
    .toEqual(standard ? ['Model Link', 'ByteDance'] : ['BytePlus'])
  const official = list.find((item) => item.model_id === model.id && seedanceRequiresEndpoint(item))!
  choose(host, '配置供应商', official.api_base)
  input(host, 'input[aria-label="模型供应商 API Key"]', 'video-private-key')
  expect(button(host, '保存配置').disabled).toBe(true)
  input(host, '[aria-label="模型供应商 EP"]', ep)
  expect(button(host, '保存配置').disabled).toBe(false)
  await act(async () => button(host, '保存配置').click())
  expect(save).toHaveBeenCalledWith({ id: official.id, kind: 'video', name: model.name, model_id: model.id,
    api_base: official.api_base, protocol: 'seedance-video', endpoint_id: ep, api_key: 'video-private-key' })
  if (standard) {
    act(() => button(host, '＋ 配置模型').click())
    choose(host, '配置模型', `video:${model.id}`)
    choose(host, '配置供应商', 'https://api.modellink.online/seedance/api/v3')
    expect(host.querySelector('[aria-label="模型供应商 EP"]')).toBeNull()
    input(host, 'input[aria-label="模型供应商 API Key"]', 'link-private-key')
    await act(async () => button(host, '保存配置').click())
    expect(save.mock.calls.at(-1)![0]).not.toHaveProperty('endpoint_id')
  }
})

it('hides incomplete video channels and displays the model name without exposing EP', () => {
  const models = catalog().filter((model) => model.protocol === 'seedance-video').map((model, index) => ({
    ...model, has_api_key: index < 2, ...(index === 1 ? { endpoint_id: ep } : {}),
  }))
  expect(selectableModels(models).map((model) => model.id)).toEqual([models[0].id, models[1].id])
  const host = mount(<ModelPicker models={models} value={models[1].id} disabled={false} onChange={vi.fn()} />)
  expect(host.textContent).toContain('Doubao Seedance 2.0 · ByteDance')
  act(() => host.querySelector('button')!.click())
  expect(document.body.innerHTML).not.toContain(ep)
})

it('keeps 2.5 frame parameters adaptive with an audio toggle and leaves mode selection outside the parameter popup', () => {
  const model = catalog().find((item) => item.model_id === 'doubao-seedance-2-5-260628')!, changed = vi.fn()
  function Parameters() {
    const [params, setParams] = useState<GenerationParams>({ ...defaultParams(model), size: '1080p/adaptive', videoMode: 'frames' })
    return <GenerationParameters model={model} params={params} disabled={false} onChange={(next) => { setParams(next); changed(next) }} />
  }
  const host = mount(<Parameters />)
  act(() => host.querySelector('button')!.click())
  const dialog = document.querySelector('[role="dialog"]')!
  expect(dialog.textContent).not.toMatch(/生成模式|编辑视频|视频修改|样片|延长视频/)
  expect([...dialog.querySelectorAll('.dc-ratio-options button')].map((option) => option.textContent)).toEqual(['自动'])
  act(() => dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
  expect(changed.mock.calls.at(-1)![0].generateAudio).toBe(false)
})

it('places the mode select in the footer, defaults first/last by connection order, permits swaps, and rejects incompatible modes', () => {
  const model = { ...catalog().find((item) => item.model_id === 'doubao-seedance-2-5-260628')!, has_api_key: true }
  const assets: Asset[] = Array.from({ length: 2 }, () => ({ id: crypto.randomUUID(), kind: 'image', mime: 'image/png', filename: 'frame.png',
    bytes: 1000, createdAt: 1, nodeId: crypto.randomUUID(), taskId: null, width: 600, height: 600 }))
  const id = crypto.randomUUID(), api = new CanvasApi(), report = vi.fn()
  function Editor() {
    const [node, setNode] = useState<CanvasNode>({ id, kind: 'video-generation', title: '视频', position: { x: 0, y: 0 },
      modelId: model.id, prompt: '镜头平移', params: { ...defaultParams(model), size: '1080p/1:1', videoMode: 'reference' }, assetId: null, selectedResultId: null })
    const graph = { ...emptyGraph(), nodes: [node], edges: assets.map((asset) => ({ id: asset.id, assetId: asset.id, source: asset.nodeId!, target: id })) }
    return <FloatingEditor api={api} workspace="w" node={node} graph={graph} assets={assets} tasks={[]} models={[model]}
      ttsConfigured={false} ttsConfigurationError={false} uploading={false} submitting={false} patchNode={(_id, fields) => setNode((node) => ({ ...node, ...fields }))}
      edit={vi.fn()} report={report} generate={vi.fn()} onResult={vi.fn()} askImport={vi.fn()} taskAction={vi.fn()} onOpen={vi.fn()} />
  }
  const host = mount(<ReactFlowProvider><Editor /></ReactFlowProvider>)
  const generate = () => host.querySelector<HTMLButtonElement>('button[aria-label="生成"]')!
  expect(host.querySelector('.dc-editor-bottom select[aria-label="视频生成模式"]')).not.toBeNull()
  expect([...host.querySelector<HTMLSelectElement>('select[aria-label="视频生成模式"]')!.options].map((option) => option.value)).toEqual(['reference', 'frames'])
  choose(host, '视频生成模式', 'frames')
  expect(host.querySelector<HTMLSelectElement>('select[aria-label="图片 1 的帧用途"]')!.value).toBe('first')
  expect(host.querySelector<HTMLSelectElement>('select[aria-label="图片 2 的帧用途"]')!.value).toBe('last')
  expect(generate().disabled).toBe(false)
  expect(host.querySelectorAll('.dc-reference .dc-frame-role')).toHaveLength(2)
  expect(host.querySelector('.dc-params-trigger')?.textContent).toContain('自动比例 · 1080p')
  choose(host, '图片 2 的帧用途', 'first')
  expect(host.querySelector<HTMLSelectElement>('select[aria-label="图片 1 的帧用途"]')!.value).toBe('last')
  expect(generate().disabled).toBe(false)
  choose(host, '视频生成模式', 'frames')
  expect(generate().disabled).toBe(false)
  expect(host.querySelector<HTMLSelectElement>('select[aria-label="图片 2 的帧用途"]')!.value).toBe('first')
  choose(host, '图片 1 的帧用途', 'first')
  expect(host.querySelector<HTMLSelectElement>('select[aria-label="图片 2 的帧用途"]')!.value).toBe('last')
  expect(generate().disabled).toBe(false)
  expect(report).not.toHaveBeenCalled()
  choose(host, '视频生成模式', 'reference')
  expect(host.querySelector('.dc-frame-role')).toBeNull()
})

it('shows history as read-only, with audio/video icons and logical model identity', () => {
  const model = { ...BUILTIN_MODELS.find((model) => model.model_id === 'dreamina-seedance-2-5-260628')!, endpoint_id: ep }
  const assets: Asset[] = ['video', 'audio'].map((kind) => ({ id: crypto.randomUUID(), kind: kind as Asset['kind'], mime: `${kind}/mp4`,
    filename: kind, bytes: 1, nodeId: null, taskId: null, createdAt: 1 }))
  const host = mount(<ReactFlowProvider><GenerationSnapshotEditor api={new CanvasApi()} workspace="w" assets={assets}
    snapshot={{ model, prompt: '生成记录', params: { ...defaultParams(model), videoMode: 'reference' }, referenceIds: assets.map((asset) => asset.id) }}
    anchor={{ position: { x: 0, y: 0 }, size: { width: 320, height: 180 } }} /></ReactFlowProvider>)
  expect(host.querySelector('[aria-readonly="true"]')).not.toBeNull()
  expect(host.querySelectorAll('.dc-reference-placeholder')).toHaveLength(2)
  expect(host.querySelector('img[alt^="参考素材"]')).toBeNull(); expect(host.innerHTML).not.toContain(ep)
  expect(host.textContent).toContain('Dreamina Seedance 2.5')
})
