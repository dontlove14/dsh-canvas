// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ReactFlow, ReactFlowProvider } from '@xyflow/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CanvasApi } from '../src/client/api'
import { CanvasSettings } from '../src/client/Settings'
import { CanvasReviewState, ReviewContext } from '../src/client/reviewState'
import { SeedanceReviewDialog } from '../src/client/SeedanceReviewDialog'
import { ReviewBadges, ReviewButton } from '../src/client/ReviewControls'
import { GenerationNode } from '../src/client/GenerationNode'
import { HistoryNode } from '../src/client/HistoryNode'
import { ResourceNode } from '../src/client/ResourceNode'
import { AudioNode } from '../src/client/AudioNode'
import { HarnessUiProvider } from '../src/client/ui'
import { harnessPrimitives } from './support/harnessPrimitives'
import type { Asset, CanvasNode } from '../src/shared/contracts'
import type { PublicReview, ReviewSettings, ReviewProvider } from '../src/shared/seedanceReview'
import type { TaskSummary } from '../src/shared/v2'

const roots: Root[] = [], states: CanvasReviewState[] = []
const noop = () => {}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('IntersectionObserver', class { observe() {}; disconnect() {} })
  Object.assign(HTMLDialogElement.prototype, { showModal: noop, close: noop })
  vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(noop)
  vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(noop)
})
afterEach(() => {
  act(() => { states.splice(0).forEach((state) => state.setActive(false)); roots.splice(0).forEach((root) => root.unmount()) })
  document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers()
})
async function mount(element: ReactNode) {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host); roots.push(root)
  await act(async () => root.render(element))
  return { host, root }
}
function fixtures(kind: 'image' | 'video' | 'audio' = 'image') {
  const api = new CanvasApi(), state = new CanvasReviewState(api, 'w'); states.push(state)
  vi.spyOn(api, 'reviewSettings').mockResolvedValue(settings())
  state.updateSettings(settings())
  const node: CanvasNode = { id: crypto.randomUUID(), kind: kind === 'audio' ? 'tts-generation' : `${kind}-generation`,
    title: '节点', position: { x: 0, y: 0 }, modelId: null, prompt: '', params: null, assetId: null, selectedResultId: null }
  const assets: Asset[] = [0, 1, 2].map((index) => ({ id: crypto.randomUUID(), nodeId: node.id, taskId: null,
    kind, filename: `输出${index}`, mime: kind === 'image' ? 'image/png' : kind === 'video' ? 'video/mp4' : 'audio/wav',
    bytes: 100, width: 320, height: 180, createdAt: 1 }))
  const open = vi.fn(), environment = { state, open }
  return { api, state, node, assets, environment }
}
function job(asset: Asset, status: PublicReview['status'] = 'processing', provider: ReviewProvider = 'bytedance'): PublicReview {
  return { id: crypto.randomUUID(), requestId: crypto.randomUUID(), canvasId: 'w', assetId: asset.id, provider,
    profileId: crypto.randomUUID(), groupType: 'AIGC', status, stage: status === 'active' ? '审核通过' : '官方审核中',
    createdAt: 1, updatedAt: 2, ...(status === 'active' ? { providerAssetId: 'Asset-Approved' } : {}) }
}
const settings = (): ReviewSettings => ({ profiles: (['bytedance', 'byteplus'] as const).map((provider) => ({
  id: provider, provider, revision: 1, configured: true, projectNameMask: 'Pro********ect', accessKeyIdMask: 'AK-********ate', accessKeySecretMask: 'SK-********ate',
})) })
const button = (host: ParentNode, text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === text)!
async function select(host: ParentNode, label: string, value: string) {
  const element = host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!
  await act(async () => { element.value = value; element.dispatchEvent(new Event('change', { bubbles: true })) })
}
function input(host: ParentNode, label: string, value: string) {
  const element = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value)
  act(() => element.dispatchEvent(new Event('input', { bubbles: true })))
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => { resolve = yes })
  return { promise, resolve }
}

it('adds separate masked settings, previews one field without changing the save draft, and preserves the other supplier', async () => {
  const api = new CanvasApi()
  vi.spyOn(api, 'reviewSettings').mockResolvedValue(settings())
  const read = vi.spyOn(api, 'settingSecret').mockResolvedValue('Private-project-value')
  const save = vi.spyOn(api, 'saveReviewSettings').mockResolvedValue(settings())
  const test = vi.spyOn(api, 'testReviewSettings').mockResolvedValue({ ok: true })
  const { host } = await mount(<CanvasSettings api={api} initialTab="review" />)
  expect(host.querySelectorAll('form')).toHaveLength(2)
  expect(host.querySelectorAll('input[type="password"]')).toHaveLength(6)
  expect(read).not.toHaveBeenCalled()
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="显示 Bytedance ProjectName"]')!.click())
  expect(read).toHaveBeenCalledExactlyOnceWith({ scope: 'seedance-review', provider: 'bytedance', field: 'projectName' }, expect.any(AbortSignal))
  const forms = host.querySelectorAll('form')
  await act(async () => button(forms[0], '保存配置').click())
  expect(save).toHaveBeenCalledExactlyOnceWith({ provider: 'bytedance', revision: 1 })
  expect(forms[1].textContent).not.toContain('Private-project-value')
  input(host, 'BytePlus AK', 'new-ak')
  expect(button(forms[1], '保存配置').disabled).toBe(true)
  input(host, 'BytePlus SK', 'new-sk')
  await act(async () => button(forms[1], '保存配置').click())
  expect(save.mock.calls.at(-1)![0]).toEqual({ provider: 'byteplus', revision: 1, accessKeyId: 'new-ak', accessKeySecret: 'new-sk' })
  await act(async () => button(forms[1], '测试连接').click())
  expect(test).toHaveBeenCalledExactlyOnceWith('byteplus')
})

it('cancels a late secret preview when leaving the new settings tab', async () => {
  const api = new CanvasApi(), late = deferred<string>()
  vi.spyOn(api, 'reviewSettings').mockResolvedValue(settings())
  const read = vi.spyOn(api, 'settingSecret').mockReturnValue(late.promise)
  vi.spyOn(api, 'ttsSettings').mockResolvedValue({ endpoint: '', revision: 0, configured: false, has_api_key: false, api_key_mask: '' })
  const { host } = await mount(<CanvasSettings api={api} initialTab="review" />)
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="显示 BytePlus SK"]')!.click())
  await act(async () => button(host, 'TTS 设置').click())
  expect(read.mock.calls[0][1]!.aborted).toBe(true)
  await act(async () => late.resolve('Late-private-sk'))
  expect(host.textContent).not.toContain('Late-private-sk')
})

it.each(['image', 'video'] as const)('reviews only the selected main %s in a single batch, including expansion and main changes', async (kind) => {
  const f = fixtures(kind)
  f.state.merge(job(f.assets[0], 'active'))
  const view = (main: number, expanded: boolean) => <ReviewContext.Provider value={f.environment}><ReactFlowProvider>
    <GenerationNode node={f.node} asset={f.assets[main]} results={f.assets} selected expanded={expanded} api={f.api} workspace="w"
      playing={false} onPlay={noop} onStop={noop} onRename={noop} onResult={noop} onExpand={noop} onOpen={noop} onSize={noop} />
  </ReactFlowProvider></ReviewContext.Provider>
  const { host, root } = await mount(view(0, false))
  expect(host.querySelectorAll('[data-review-asset]')).toHaveLength(1)
  expect(host.querySelector('[aria-label="Bytedance · 审核通过"]')).toBeTruthy()
  await act(async () => root.render(view(1, true)))
  const trigger = host.querySelector<HTMLButtonElement>('[data-review-asset]')!
  expect(host.querySelectorAll('[data-review-asset]')).toHaveLength(1); expect(trigger.dataset.reviewAsset).toBe(f.assets[1].id)
  expect(host.querySelector('[aria-label="Bytedance · 审核通过"]')).toBeNull()
  act(() => trigger.click())
  expect(f.environment.open).toHaveBeenCalledWith(f.assets[1])
})

it.each(['image', 'video', 'audio'] as const)('offers a review per actual historical %s output without triggering history inspection', async (kind) => {
  const f = fixtures(kind), inspect = vi.fn()
  const tasks: TaskSummary[] = [0, 1].map((index) => ({ id: crypto.randomUUID(), requestId: crypto.randomUUID(), nodeId: f.node.id,
    workspaceId: 'w', status: 'completed', resultIds: f.assets.slice(index, index === 0 ? 1 : 3).map((asset) => asset.id), createdAt: index, updatedAt: 1 }))
  const cards = tasks.map((task, index) => ({ task, results: index === 0 ? [f.assets[0]] : f.assets.slice(1) }))
  const view = (expanded: boolean) => <ReviewContext.Provider value={f.environment}><ReactFlowProvider>
    <HistoryNode node={f.node} cards={cards} connectedAssets={[]} selected expanded={expanded} api={f.api} workspace="w"
      playing={false} onPlay={noop} onStop={noop} onRename={noop} onExpand={noop} onOpen={noop} onSize={noop} onInspect={inspect} />
  </ReactFlowProvider></ReviewContext.Provider>
  const { host, root } = await mount(view(true))
  expect([...host.querySelectorAll<HTMLElement>('[data-review-asset]')].map((item) => item.dataset.reviewAsset)).toEqual(f.assets.map((asset) => asset.id))
  await act(async () => host.querySelector<HTMLButtonElement>(`[data-review-asset="${f.assets[2].id}"]`)!.click())
  expect(f.environment.open).toHaveBeenCalledExactlyOnceWith(f.assets[2]); expect(inspect).not.toHaveBeenCalled()
  await act(async () => root.render(view(false)))
  expect(host.querySelectorAll('[data-review-asset]')).toHaveLength(1)
  const review = host.querySelector('[data-review-asset]')!
  expect(review.parentElement).toBe(host.querySelector('[title="展开提交记录"]')!.parentElement)
  expect(host.querySelectorAll('.dc-group-actions')).toHaveLength(1)
  cards[0] = { ...cards[0], results: [] }; await act(async () => root.render(view(false)))
  expect(host.querySelector('[data-review-asset]')).toBeNull()
  expect(host.querySelector('.dc-resource-title [data-review-badges]')).toBeNull()
})

it('changes only the relevant badges, keeps media DOM and node geometry, and distinguishes suppliers and unknown from failure', async () => {
  const f = fixtures()
  const size = vi.fn()
  const { host } = await mount(<ReviewContext.Provider value={f.environment}><ReactFlowProvider>
    <ResourceNode node={f.node} asset={f.assets[0]} selected api={f.api} workspace="w" rotation={0} playing={false}
      onRename={noop} onRotate={noop} onPlay={noop} onStop={noop} onOpen={noop} onFocus={noop} onSize={size} />
    <ReviewBadges assetId={f.assets[1].id} />
  </ReactFlowProvider></ReviewContext.Provider>)
  const media = host.querySelector('.dc-resource-frame'), count = size.mock.calls.length
  const other = vi.fn(); f.state.subscribe(f.assets[1].id, other)
  await act(async () => { f.state.merge(job(f.assets[0])); f.state.merge(job(f.assets[0], 'active', 'byteplus')) })
  expect(host.querySelector('[aria-label="Bytedance · 审核中"]')!.textContent).toContain('审核中')
  expect(host.querySelector('[aria-label="BytePlus · 审核通过"]')!.textContent).not.toContain('审核通过')
  await act(async () => f.state.merge(job(f.assets[0], 'unknown')))
  expect(host.querySelector('[aria-label="Bytedance · 待确认"]')).toBeTruthy()
  expect(host.querySelector('.dc-review-badge.failed')).toBeNull()
  expect(host.querySelector('.dc-resource-frame')).toBe(media); expect(size.mock.calls.length).toBe(count); expect(other).not.toHaveBeenCalled()
})

it('provides the audio toolbar entry and leaves the audio node mounted on review changes', async () => {
  const f = fixtures('audio')
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private notify: (entries: Array<{ isIntersecting: boolean }>) => void) {}
    observe() { this.notify([{ isIntersecting: true }]) }; disconnect() {}
  })
  vi.spyOn(f.api, 'waveform').mockResolvedValue({ version: 1, duration: 10, peaks: Array(96).fill(.5) })
  vi.spyOn(f.api, 'mediaUrls').mockImplementation(async (_canvas, items) => ({ items: items.map((item) => ({
    ...item, url: `https://test.invalid/${item.assetId}`, expiresAt: Date.now() + 3600000,
  })) }))
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
  const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(noop)
  const { host } = await mount(<ReviewContext.Provider value={f.environment}><ReactFlowProvider>
    <AudioNode node={f.node} asset={f.assets[0]} selected api={f.api} workspace="w" playing={false}
      onRename={noop} onPlay={noop} onStop={noop} onSize={noop} />
  </ReactFlowProvider></ReviewContext.Provider>)
  const media = host.querySelector('audio'), paused = pause.mock.calls.length
  expect(media).toBeTruthy()
  act(() => f.state.merge(job(f.assets[0], 'failed')))
  expect(host.querySelector('audio')).toBe(media); expect(pause.mock.calls.length).toBe(paused)
  expect(host.querySelector('[aria-label="Bytedance · 预审失败"]')).toBeTruthy()
})

it.each(['image', 'video', 'audio'] as const)('renders the real XYFlow top toolbar for a %s resource with its exact review target', async (kind) => {
  const f = fixtures(kind)
  vi.stubGlobal('ResizeObserver', class { observe() {}; unobserve() {}; disconnect() {} })
  vi.stubGlobal('DOMMatrixReadOnly', class { m22 = 1 })
  const node = { ...f.node, kind: `${kind}-asset` as CanvasNode['kind'] }
  function Component() {
    const common = { node, asset: f.assets[0], selected: true, api: f.api, workspace: 'w', playing: false, onPlay: noop, onStop: noop, onRename: noop, onSize: noop }
    return kind === 'audio' ? <AudioNode {...common} /> : <ResourceNode {...common} rotation={0} onRotate={noop} onOpen={noop} onFocus={noop} />
  }
  const { host } = await mount(<ReviewContext.Provider value={f.environment}><ReactFlowProvider>
    <ReactFlow nodes={[{ id: node.id, type: 'media', data: {}, position: { x: 100, y: 100 }, width: 360, height: 180 }]}
      edges={[]} nodeTypes={{ media: Component }} style={{ width: 1000, height: 800 }} />
  </ReactFlowProvider></ReviewContext.Provider>)
  const toolbar = host.querySelector('.react-flow__node-toolbar')!
  expect(toolbar).toBeTruthy()
  expect(toolbar.getAttribute('data-id')).toBe(node.id)
  act(() => toolbar.querySelector<HTMLButtonElement>('[data-review-asset]')!.click())
  expect(f.environment.open).toHaveBeenCalledExactlyOnceWith(f.assets[0])
})

it('coalesces busy polling, stops when inactive, rejects late pages and accepts a fresh result on resume', async () => {
  vi.useFakeTimers()
  const f = fixtures(), late = deferred<any>(), accepted = job(f.assets[0])
  const read = vi.spyOn(f.api, 'reviews').mockReturnValueOnce(late.promise).mockResolvedValue({ items: [accepted], busy: true, revision: 2 })
  f.state.setActive(true)
  await Promise.resolve(); await Promise.resolve()
  f.state.setActive(false)
  await late.resolve({ items: [job(f.assets[0], 'active')], busy: false, revision: 3 }); await Promise.resolve()
  expect(f.state.snapshot(f.assets[0].id)).toHaveLength(0)
  f.state.setActive(true); await Promise.resolve(); await Promise.resolve()
  expect(f.state.snapshot(f.assets[0].id)[0].status).toBe('processing')
  expect(read).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(3000)
  expect(read).toHaveBeenCalledTimes(3)
  f.state.setActive(false); await vi.advanceTimersByTimeAsync(10000)
  expect(read).toHaveBeenCalledTimes(3)
})

it('submits a stable request once despite rapid clicks, switches provider and pages exact human groups', async () => {
  const f = fixtures(), pending = deferred<PublicReview>()
  vi.spyOn(f.api, 'reviewSettings').mockResolvedValue(settings())
  const submit = vi.spyOn(f.api, 'submitReview').mockReturnValue(pending.promise)
  const groups = vi.spyOn(f.api, 'reviewGroups').mockResolvedValueOnce({ provider: 'byteplus', items: [{ id: 'group-person-1', name: '人物一', groupType: 'LivenessFace' }], nextToken: 'page2' })
    .mockResolvedValue({ provider: 'byteplus', items: [{ id: 'group-person-2', name: '人物二', groupType: 'LivenessFace' }] })
  const { host } = await mount(<ReviewContext.Provider value={f.environment}><SeedanceReviewDialog asset={f.assets[0]} onClose={noop} onSettings={noop} /></ReviewContext.Provider>)
  await select(host, '预审供应商', 'byteplus'); await select(host, '预审素材路径', 'LivenessFace')
  expect(button(host, '提交预审').disabled).toBe(true)
  await act(async () => button(host, '加载更多').click())
  expect(groups.mock.calls[1].slice(0, 3)).toEqual(['w', 'byteplus', 'page2'])
  expect(host.querySelectorAll('select[aria-label="预审人物组"] option')).toHaveLength(3)
  await select(host, '预审人物组', 'group-person-2')
  act(() => { button(host, '提交预审').click(); button(host, '提交预审').click() })
  expect(submit).toHaveBeenCalledTimes(1)
  expect(submit.mock.calls[0][1]).toEqual({ requestId: expect.any(String), assetId: f.assets[0].id, provider: 'byteplus', groupType: 'LivenessFace', groupId: 'group-person-2' })
  await act(async () => pending.resolve({ ...job(f.assets[0], 'processing', 'byteplus'), groupType: 'LivenessFace', groupId: 'group-person-2' }))
  expect(button(host, '审核中').disabled).toBe(true)
  expect(host.querySelector<HTMLSelectElement>('select[aria-label="预审供应商"]')!.value).toBe('bytedance')
  expect(host.querySelector<HTMLSelectElement>('select[aria-label="预审素材路径"]')!.value).toBe('AIGC')
})

it('omits approved details and duplicate headings, selects the next supplier and keeps unknown recovery on its original job', async () => {
  const f = fixtures(), approved = job(f.assets[0], 'active')
  vi.spyOn(f.api, 'reviewSettings').mockResolvedValue(settings())
  const submit = vi.spyOn(f.api, 'submitReview')
  const action = vi.spyOn(f.api, 'reviewAction').mockResolvedValue({ ...approved, status: 'processing' })
  f.state.merge(approved)
  const { host } = await mount(<ReviewContext.Provider value={f.environment}><SeedanceReviewDialog asset={f.assets[0]} onClose={noop} onSettings={noop} /></ReviewContext.Provider>)
  expect(host.querySelector<HTMLSelectElement>('[aria-label="预审供应商"]')!.value).toBe('byteplus')
  for (const value of ['Asset-Approved', 'Asset ID', 'Group ID', '更新时间', '审核通过', '下一次视频生成', '原 URL', f.assets[0].filename])
    expect(host.textContent).not.toContain(value)
  expect(host.querySelector('h3')).toBeNull()
  expect(submit).not.toHaveBeenCalled()
  act(() => f.state.merge({ ...approved, status: 'unknown' }))
  expect(button(host, '重新送审')).toBeUndefined()
  await act(async () => button(host, '恢复查询').click())
  expect(action).toHaveBeenCalledExactlyOnceWith('w', approved.id, 'resume', undefined)
  expect(submit).not.toHaveBeenCalled()
})

it('hides only assets active on both suppliers and restores the button if the actual main asset changes', async () => {
  const f = fixtures()
  const { host } = await mount(<ReviewContext.Provider value={f.environment}>{f.assets.map((asset) =>
    <div key={asset.id}><ReviewButton asset={asset} /><ReviewBadges assetId={asset.id} /></div>)}</ReviewContext.Provider>)
  act(() => { f.state.merge(job(f.assets[0], 'active')); f.state.merge(job(f.assets[0], 'failed', 'byteplus')) })
  expect(host.querySelector(`[data-review-asset="${f.assets[0].id}"]`)).toBeTruthy()
  act(() => f.state.merge(job(f.assets[0], 'active', 'byteplus')))
  expect(host.querySelector(`[data-review-asset="${f.assets[0].id}"]`)).toBeNull()
  expect(host.querySelectorAll('.dc-review-badge.active')).toHaveLength(2)
  expect(host.querySelectorAll('[data-review-asset]')).toHaveLength(2)
  act(() => f.state.merge(job(f.assets[0], 'unknown', 'byteplus')))
  expect(host.querySelector(`[data-review-asset="${f.assets[0].id}"]`)).toBeTruthy()
})

it('disables submitted and unconfigured suppliers with hover reasons and never auto-submits when every supplier is blocked', async () => {
  const f = fixtures()
  vi.mocked(f.api.reviewSettings).mockResolvedValue({ profiles: settings().profiles.map((profile) => ({ ...profile, configured: profile.provider === 'bytedance' })) })
  f.state.merge(job(f.assets[0], 'active'))
  const submit = vi.spyOn(f.api, 'submitReview'), groups = vi.spyOn(f.api, 'reviewGroups')
  const { host } = await mount(<HarnessUiProvider components={harnessPrimitives}>
    <ReviewContext.Provider value={f.environment}><SeedanceReviewDialog asset={f.assets[0]} onClose={noop} onSettings={noop} /></ReviewContext.Provider>
  </HarnessUiProvider>)
  const trigger = document.querySelector<HTMLButtonElement>('[aria-label="预审供应商：暂无可送审供应商"]')!
  expect(trigger.disabled).toBe(false)
  await act(async () => trigger.click())
  const rows = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
  expect(rows).toHaveLength(2); expect(rows.every((row) => row.disabled)).toBe(true)
  expect(rows[0].querySelector('[title]')!.getAttribute('title')).toBe('当前素材已送审')
  expect(rows[1].querySelector('[title]')!.getAttribute('title')).toBe('当前供应商送审未配置')
  act(() => rows.forEach((row) => row.click()))
  expect(button(document, '提交预审').disabled).toBe(true)
  expect(document.querySelector('.dc-review-detail')).toBeNull()
  expect(host.querySelector('dialog')).toBeNull()
  expect(submit).not.toHaveBeenCalled(); expect(groups).not.toHaveBeenCalled()
})

it('guards disabled choices even on a synthetic change and explicitly retries the failed supplier while another is selected', async () => {
  const f = fixtures(), failed = { ...job(f.assets[0], 'failed'), errorMessage: '素材不符合审核要求', errorCode: 'Rejected' }
  f.state.merge(failed)
  const action = vi.spyOn(f.api, 'reviewAction').mockResolvedValue({ ...failed, status: 'processing' })
  const { host } = await mount(<ReviewContext.Provider value={f.environment}><SeedanceReviewDialog asset={f.assets[0]} onClose={noop} onSettings={noop} /></ReviewContext.Provider>)
  expect(host.querySelector('[role="alert"]')!.textContent).toBe(failed.errorMessage)
  await select(host, '预审供应商', 'bytedance')
  expect(host.querySelector<HTMLSelectElement>('[aria-label="预审供应商"]')!.value).toBe('byteplus')
  await act(async () => button(host, '重新送审').click())
  expect(action).toHaveBeenCalledExactlyOnceWith('w', failed.id, 'retry', expect.any(String))
})

it('fails closed on unreadable or late settings without enabling groups or submission', async () => {
  const f = fixtures(), pending = deferred<ReviewSettings>()
  vi.mocked(f.api.reviewSettings).mockReturnValueOnce(pending.promise)
  const submit = vi.spyOn(f.api, 'submitReview')
  const { host, root } = await mount(<ReviewContext.Provider value={f.environment}><SeedanceReviewDialog asset={f.assets[0]} onClose={noop} onSettings={noop} /></ReviewContext.Provider>)
  expect(button(host, '提交预审').disabled).toBe(true)
  const signal = vi.mocked(f.api.reviewSettings).mock.calls[0][0]!
  act(() => root.render(null))
  await act(async () => pending.resolve(settings()))
  expect(signal.aborted).toBe(true); expect(submit).not.toHaveBeenCalled()
})

it('reuses the same local request after a lost submit response instead of creating another attempt', async () => {
  const f = fixtures()
  vi.spyOn(f.api, 'reviewSettings').mockResolvedValue(settings())
  const submit = vi.spyOn(f.api, 'submitReview').mockRejectedValueOnce(new Error('回执连接中断')).mockResolvedValue(job(f.assets[0]))
  const { host } = await mount(<ReviewContext.Provider value={f.environment}><SeedanceReviewDialog asset={f.assets[0]} onClose={noop} onSettings={noop} /></ReviewContext.Provider>)
  await act(async () => button(host, '提交预审').click())
  expect(host.querySelector('[role="alert"]')!.textContent).toContain('回执连接中断')
  await act(async () => button(host, '提交预审').click())
  expect(submit).toHaveBeenCalledTimes(2)
  expect(submit.mock.calls[0][1]).toEqual(submit.mock.calls[1][1])
})

it('hides review entries before configuration loads and when neither supplier is configured, with no group or task calls', async () => {
  const f = fixtures(), pending = deferred<ReviewSettings>()
  f.state.updateSettings({ profiles: [] })
  vi.mocked(f.api.reviewSettings).mockReturnValueOnce(pending.promise)
  const reads = vi.spyOn(f.api, 'reviews'), groups = vi.spyOn(f.api, 'reviewGroups'), submit = vi.spyOn(f.api, 'submitReview')
  const { host } = await mount(<ReviewContext.Provider value={f.environment}>{f.assets.map((asset) => <ReviewButton key={asset.id} asset={asset} />)}</ReviewContext.Provider>)
  act(() => f.state.setActive(true))
  expect(host.querySelector('[data-review-asset]')).toBeNull()
  await act(async () => pending.resolve({ profiles: settings().profiles.map((profile) => ({ ...profile, configured: false })) }))
  expect(host.querySelector('[data-review-asset]')).toBeNull()
  expect(reads).not.toHaveBeenCalled(); expect(groups).not.toHaveBeenCalled(); expect(submit).not.toHaveBeenCalled()
})

it('enables an existing canvas after either supplier is configured without waiting for a Group ID or remounting media', async () => {
  const f = fixtures()
  f.state.updateSettings({ profiles: [] })
  vi.mocked(f.api.reviewSettings).mockResolvedValue({ profiles: [] })
  vi.spyOn(f.api, 'reviews').mockResolvedValue({ items: [], revision: 0, busy: false })
  const groups = vi.spyOn(f.api, 'reviewGroups'), submit = vi.spyOn(f.api, 'submitReview')
  const { host } = await mount(<ReviewContext.Provider value={f.environment}><ReactFlowProvider>
    <GenerationNode node={f.node} asset={f.assets[0]} results={f.assets} selected expanded={false} api={f.api} workspace="w"
      playing={false} onPlay={noop} onStop={noop} onRename={noop} onResult={noop} onExpand={noop} onOpen={noop} onSize={noop} />
  </ReactFlowProvider></ReviewContext.Provider>)
  act(() => f.state.setActive(true))
  const media = host.querySelector('.dc-generation-media')
  for (const provider of ['bytedance', 'byteplus'] as const) {
    vi.mocked(f.api.reviewSettings).mockResolvedValue({ profiles: settings().profiles.map((profile) => ({ ...profile, configured: profile.provider === provider })) })
    await act(async () => f.state.refresh())
    expect(host.querySelectorAll('[data-review-asset]')).toHaveLength(1)
    expect(host.querySelector('.dc-generation-media')).toBe(media)
  }
  expect(groups).not.toHaveBeenCalled(); expect(submit).not.toHaveBeenCalled()
  vi.mocked(f.api.reviewSettings).mockRejectedValue(new Error('配置暂时不可读'))
  await act(async () => f.state.refresh())
  expect(host.querySelector('[data-review-asset]')).toBeNull()
})

it('ignores a late configuration response after the canvas is hidden', async () => {
  const f = fixtures(), pending = deferred<ReviewSettings>()
  f.state.updateSettings({ profiles: [] })
  vi.mocked(f.api.reviewSettings).mockReturnValueOnce(pending.promise)
  act(() => f.state.setActive(true))
  const signal = vi.mocked(f.api.reviewSettings).mock.calls[0][0]!
  act(() => f.state.setActive(false))
  expect(signal.aborted).toBe(true)
  await pending.resolve(settings()); await Promise.resolve()
  expect(f.state.availability()).toBe(false)
})
