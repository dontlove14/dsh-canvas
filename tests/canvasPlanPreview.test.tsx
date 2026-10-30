// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { nativeHarnessPlan } from './support/nativeHarnessPlan'
import { installCanvasPlanPreview } from '../src/client/canvasPlanPreview'

let root: Root | undefined
afterEach(() => { act(() => root?.unmount()); document.body.replaceChildren(); vi.unstubAllGlobals() })
it.each([true, false])('uses native full detail preview for canvas plans, including existing cards (legacy=%s)', async (legacy) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const native = nativeHarnessPlan(), slots = new SlotCore()
  slots.register({ name: 'root', children: {
    'conversation.plan-review.actions': { kind: 'list' }, 'conversation.chat.turnTail': { kind: 'list' },
    'sidebar.right.pane.tab': { kind: 'keyed' }, 'sidebar.right.pane.tab.title': { kind: 'keyed' },
    'conversation.input.plan': { kind: 'single' },
  } }, () => null)
  const navigation = vi.fn(), decide = vi.fn()
  const dispose = installCanvasPlanPreview(slots)
  native.apply({
    effect: (install: () => unknown) => install(),
    locale: { register: () => () => {}, bind: () => (key: string) => key },
    uiConversation: { events: { register: () => () => {} } }, resources: { register: () => () => {} },
    remote: { session: {} },
    sidebarRightTabs: { register: () => () => {} },
    sidebarRight: { openResource: navigation, mounted: { getSnapshot: () => 'session', subscribe: () => () => {} } },
    sessions: { subagentAddress: () => undefined },
    slots: { inject: (_key: string, install: () => unknown) => install(), register: slots.register.bind(slots) },
  })
  const entry = slots.entries('conversation.plan-review.actions')[0], Original = entry.component as any
  const injected = (entry.inject as any)('session')
  const plan = '# 保温杯发布会\n\n| 镜头 | 秒数 |\n| 开场 | 5 |\n\n完整结尾与生成计划。'
  const review = { id: 'canvas-plan', plan, question: '审阅', approve: { label: '确认方案' }, decline: { label: '需要修改' },
    ...(legacy ? { callId: 'canvas-tool-call' } : {}) }
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => root!.render(<Original {...injected} review={review} requestKey="pending" useSidebarMounted={() => true}
    useStore={() => false} actions={{ markOpened: vi.fn() }} t={(key: string) => key} answer={decide} />))
  expect(navigation).toHaveBeenCalledTimes(1)
  const [address, options] = navigation.mock.calls[0]
  expect(address).toMatch(/^dsh-resource:\/\/plan-review\/session\//)
  expect(options.params.planReview.markdown).toBe(plan)
  expect(review.callId).toBe(legacy ? 'canvas-tool-call' : undefined)
  const Preview = native.PlanPreview
  await act(async () => root!.render(<Preview useTabInfo={() => ({ tab: { navigation: { address, params: options.params } } })}
    useResource={() => ({ status: 'none' })} t={(key: string) => key} />))
  expect(container.querySelector('[data-plan-preview]')?.textContent).toBe(plan)
  expect(container.querySelector('[role="status"]')).toBeNull()
  expect(decide).not.toHaveBeenCalled()
  await act(() => dispose())
  expect(entry.component).toBe(native.PlanReviewOpen)
})
it('preserves native logged-plan IDs and restores mounted wrappers on unload', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const slots = new SlotCore()
  slots.register({ name: 'root', children: { 'conversation.plan-review.actions': { kind: 'list' } } }, () => null)
  const Native = vi.fn(() => <span>原生入口</span>)
  slots.register({ name: 'conversation.plan-review.actions', id: '@deepseek-ai/dsh-client-ui-plan' }, Native)
  const dispose = installCanvasPlanPreview(slots), entry = slots.entries('conversation.plan-review.actions')[0], Wrapped = entry.component as any
  const review = { id: 'native-plan', callId: 'exit-plan-call', plan: '# 原生计划', approve: { label: '继续' } }
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => root!.render(<Wrapped review={review} />))
  expect(Native.mock.calls.at(-1)![0].review).toBe(review)
  await act(() => dispose())
  expect(entry.component).toBe(Native)
  expect(Native.mock.calls.at(-1)![0].review).toBe(review)
})
it('demonstrates why custom review call IDs are not native logged plans', () => {
  const native = nativeHarnessPlan(), data = { callId: 'call', arguments: JSON.stringify({ plan: '# 完整计划' }) }
  expect(native.submittedPlan({ type: 'tool/call', data: { ...data, name: 'canvas_review_plan' } })).toBeUndefined()
  expect(native.submittedPlan({ type: 'tool/call', data: { ...data, name: 'exit_plan_mode' } })).toMatchObject({ callId: 'call', markdown: '# 完整计划' })
})
