// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ReactFlowProvider } from '@xyflow/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { FloatingEditor } from '../src/client/Canvas'
import { CanvasApi } from '../src/client/api'
import { ModelSettings } from '../src/client/Settings'
import { ModelPicker, selectableModels } from '../src/client/ModelPicker'
import { GenerationSnapshotEditor } from '../src/client/GenerationSnapshotEditor'
import { BUILTIN_MODELS } from '../src/shared/modelCatalog'
import { capabilitiesFor, defaultParams, emptyGraph, type Asset, type CanvasNode, type PublicModel } from '../src/shared/contracts'

const roots: Root[] = []
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
it.each(BUILTIN_MODELS.filter((model) => ['wan-video', 'minimax-video'].includes(model.protocol)))('configures $model_id via $api_base without an EP field', async (definition) => {
  const list = catalog(), api = new CanvasApi(), model = list.find((model) => model.id === definition.id)!
  vi.spyOn(api, 'models').mockResolvedValue(list)
  const save = vi.spyOn(api, 'saveModel').mockResolvedValue(list)
  const host = mount(<ModelSettings api={api} />); await act(async () => {})
  act(() => button(host, '＋ 配置模型').click()); choose(host, '配置模型', `video:${model.model_id}`)
  expect([...host.querySelector<HTMLSelectElement>('select[aria-label="配置供应商"]')!.options].map((option) => option.text))
    .toEqual(model.protocol === 'wan-video' ? ['Model Link', 'Aliyun']
      : model.model_id === 'MiniMax-H3' ? ['Model Link', 'MiniMax'] : ['MiniMax'])
  choose(host, '配置供应商', model.api_base)
  expect(host.querySelector('[aria-label="模型供应商 EP"]')).toBeNull()
  const key = host.querySelector<HTMLInputElement>('[aria-label="模型供应商 API Key"]')!
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(key, 'wan-ui-key')
  act(() => key.dispatchEvent(new Event('input', { bubbles: true })))
  await act(async () => button(host, '保存配置').click())
  const { capabilities, configurable, has_api_key, api_key_mask, ...record } = model
  expect(save).toHaveBeenCalledExactlyOnceWith({ ...record, api_key: 'wan-ui-key' })
})
it('lists only configured Wan models and shows logical identity in the picker', () => {
  const models = catalog().filter((model) => model.protocol === 'wan-video')
  models[1].has_api_key = true
  expect(selectableModels(models).map((model) => model.id)).toEqual([models[1].id])
  const host = mount(<ModelPicker models={models} value={models[1].id} disabled={false} onChange={vi.fn()} />)
  expect(host.textContent).toContain('Wan 3.0 · Aliyun')
})
it('excludes a configured retired Model Link H3 variant from settings candidates and generation pickers', async () => {
  const list = catalog(), official = list.find((model) => model.model_id === 'MiniMax-H3-Lite')!
  const retired = { ...official, id: '00000000-0000-4000-b000-000000000027',
    api_base: 'https://api.modellink.online/hailuo', configurable: false, has_api_key: true }
  list.push(retired)
  official.has_api_key = true
  expect(selectableModels(list).map((model) => model.id)).toEqual([official.id])
  const api = new CanvasApi(); vi.spyOn(api, 'models').mockResolvedValue(list)
  const host = mount(<ModelSettings api={api} />); await act(async () => {})
  expect(host.querySelector('[aria-label="编辑 MiniMax H3 Lite · Model Link"]')).toBeNull()
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="配置 Model Link 模型"]')!.click())
  expect([...host.querySelector<HTMLSelectElement>('[aria-label="配置模型"]')!.options].map((option) => option.value))
    .not.toContain('video:MiniMax-H3-Lite')
})
it.each(['wan3.0-video', 'wan3.0-video-prime', 'MiniMax-H3', 'MiniMax-H3-Highspeed', 'MiniMax-H3-Lite', 'MiniMax-H3-Max'])('uses shared modes, frame swaps and native parameter tiers for %s', (id) => {
  const model = { ...catalog().find((model) => model.model_id === id)!, has_api_key: true }
  const assets: Asset[] = Array.from({ length: 2 }, () => ({ id: crypto.randomUUID(), kind: 'image', mime: 'image/png',
    filename: 'frame.png', bytes: 1000, createdAt: 1, nodeId: crypto.randomUUID(), taskId: null, width: 600, height: 600 }))
  const nodeId = crypto.randomUUID(), report = vi.fn()
  function Editor() {
    const [node, setNode] = useState<CanvasNode>({ id: nodeId, kind: 'video-generation', title: 'Wan', position: { x: 0, y: 0 },
      modelId: model.id, prompt: '镜头平移', params: defaultParams(model), assetId: null, selectedResultId: null })
    const graph = { ...emptyGraph(), nodes: [node], edges: assets.map((asset) => ({ id: asset.id, assetId: asset.id, source: asset.nodeId!, target: nodeId })) }
    return <FloatingEditor api={new CanvasApi()} workspace="w" node={node} graph={graph} assets={assets} tasks={[]} models={[model]}
      ttsConfigured={false} ttsConfigurationError={false} uploading={false} submitting={false} patchNode={(_id, fields) => setNode((node) => ({ ...node, ...fields }))}
      edit={vi.fn()} report={report} generate={vi.fn()} onResult={vi.fn()} askImport={vi.fn()} taskAction={vi.fn()} onOpen={vi.fn()} />
  }
  const host = mount(<ReactFlowProvider><Editor /></ReactFlowProvider>)
  const generate = () => host.querySelector<HTMLButtonElement>('button[aria-label="生成"]')!
  expect(host.querySelector<HTMLSelectElement>('[aria-label="视频生成模式"]')!.value).toBe('reference')
  expect(generate().disabled).toBe(false)
  choose(host, '视频生成模式', 'frames')
  expect(host.querySelector<HTMLSelectElement>('[aria-label="图片 1 的帧用途"]')!.value).toBe('first')
  choose(host, '图片 2 的帧用途', 'first')
  expect(host.querySelector<HTMLSelectElement>('[aria-label="图片 1 的帧用途"]')!.value).toBe('last')
  expect(generate().disabled).toBe(false)
  act(() => host.querySelector<HTMLButtonElement>('.dc-params-trigger')!.click())
  const dialog = document.querySelector('[role="dialog"]')!
  if (model.protocol === 'wan-video') { expect(dialog.textContent).toContain('480P'); expect(dialog.textContent).toContain('1080P') }
  else {
    expect(dialog.textContent).toContain('768P')
    expect(host.querySelector<HTMLSelectElement>('[aria-label="视频生成模式"]')!.value).toBe('frames')
    expect(dialog.querySelectorAll('.dc-ratio-options button')).toHaveLength(1)
    expect(dialog.querySelector('.dc-ratio-options')!.textContent).toContain('自动')
  }
  expect(dialog.querySelector('[aria-label="视频时长"]')).not.toBeNull()
  expect(!!dialog.querySelector('input[type="checkbox"]')).toBe(model.protocol === 'wan-video')
  expect(report).not.toHaveBeenCalled()
})
it('labels first/last references in immutable Wan history', () => {
  const model = BUILTIN_MODELS.find((model) => model.protocol === 'wan-video')!, ids = [crypto.randomUUID(), crypto.randomUUID()]
  const host = mount(<ReactFlowProvider><GenerationSnapshotEditor api={new CanvasApi()} workspace="w"
    snapshot={{ model, prompt: '已提交', params: { ...defaultParams(model), videoMode: 'frames', firstFrameId: ids[1], lastFrameId: ids[0] }, referenceIds: ids }}
    anchor={{ position: { x: 0, y: 0 }, size: { width: 320, height: 180 } }} /></ReactFlowProvider>)
  expect([...host.querySelectorAll('.dc-frame-label')].map((label) => label.textContent)).toEqual(['尾帧', '首帧'])
  expect(host.textContent).toContain('Wan 3.0')
})
