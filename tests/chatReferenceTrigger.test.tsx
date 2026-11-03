// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { nativeInputTrigger } from './support/nativeInputTrigger'
vi.mock('@deepseek-ai/dsh-client-ui-input-trigger/client', async () => (await import('./support/nativeInputTrigger')).nativeInputTrigger())
import { chatReferenceSource, hashController, hashDetectionText } from '../src/client/chatReferenceTrigger'
import { referenceText, referenceSpans, type ChatReference } from '../src/shared/chatReferences'
import { chatReferenceTextRule } from '../src/client/chatReferenceText'
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

function fixture(...initial: [unknown?]) {
  const sdk = nativeInputTrigger(), events: any[] = []
  let preset = initial.length ? initial[0] : 'canvas-creator'
  const available = () => preset === 'canvas-creator'
  const actx = { bail: (_subject: unknown, event: string, data: unknown) => { events.push({ event, data }); return true } }
  const ref: ChatReference = { version: 1, kind: 'media', sessionId: 'test', canvasId: randomUUID(), nodeId: randomUUID(), assetId: randomUUID(), label: '产品图' }
  const files = { list: vi.fn(async (_id, query) => query ? [{ path: '文档/方案.md', kind: 'file' as const }] : [{ path: '文档', kind: 'directory' as const }]) }
  const api = { referenceChoices: vi.fn(async () => ({ preset: true, cwd: '/workspace', media: [{ label: ref.label, kind: 'image' as const, description: '当前', section: '画布 · 项目', ref }] })),
    resolveReference: vi.fn(async (_session, input) => ({ text: referenceText(input) })) }
  const nativeSource = { name: 'native', trigger: '@', candidates: async () => [{ name: '原生@' }], onPick: () => undefined }
  const slash = { ...nativeSource, trigger: '/', name: 'slash', candidates: async () => [{ name: 'help' }] }
  const original = new sdk.InputTriggerController({ actx, sessionId: 'test', roster: { all: () => [nativeSource, slash], sources: (trigger) => trigger === '@' ? [nativeSource] : [slash] } })
  const source = chatReferenceSource('test', api, files, available)
  const adapter = hashController(original, { actx: actx as any, sessionId: 'test' as any, roster: {} as any }, source, available)
  return { ...adapter, original, sdk, events, api, files, ref, source,
    setPreset: (value: unknown) => { preset = value; adapter.refreshAvailability() } }
}
const settle = () => new Promise<void>((resolve) => { setTimeout(resolve, 0) })
describe('Native # reference integration', () => {
  it.each([undefined, null, 'standard', 'canvas-image'])('treats # as literal text without candidate or file requests for preset %s', async (preset) => {
    const f = fixture(preset), c = f.controller
    c.track('#', 1, { tier: 'plain' }, 1); await settle()
    expect(c.menu.getSnapshot().open).toBe(false)
    expect(f.api.referenceChoices).not.toHaveBeenCalled()
    expect(f.files.list).not.toHaveBeenCalled()
    c.track('阿诗丹顿#', 5, { tier: 'plain' }, 2); await settle()
    expect(c.menu.getSnapshot().open).toBe(false)
    expect(f.api.referenceChoices).not.toHaveBeenCalled()
    expect(await f.source.candidates({} as any, { query: '', signal: new AbortController().signal } as any)).toEqual([])
    await expect(c.serializeReference('canvas-hash', JSON.stringify(f.ref), new AbortController().signal)).rejects.toThrow('无限画布')
    expect(f.api.resolveReference).not.toHaveBeenCalled()
    c.track('@', 1, { tier: 'plain' }, 2); await settle()
    expect(c.menu.getSnapshot().groups[0].source).toBe('native')
    c.track('/', 1, { tier: 'plain' }, 3); await settle()
    expect(c.menu.getSnapshot().groups[0].source).toBe('slash')
    f.dispose()
  })
  it('enables an existing # draft when its preset arrives and immediately closes it when switching away', async () => {
    const f = fixture(null), c = f.controller, changed = vi.fn(), off = c.menu.subscribe(changed)
    c.track('反馈 #', 4, { tier: 'plain' }, 7)
    f.setPreset('canvas-creator'); await settle()
    expect(c.menu.getSnapshot().open).toBe(true)
    f.setPreset('standard')
    expect(c.menu.getSnapshot().open).toBe(false)
    expect(f.api.referenceChoices.mock.calls[0][2].aborted).toBe(true)
    c.pick('canvas-hash', 0)
    expect(f.events).toEqual([])
    expect(changed).toHaveBeenCalled()
    f.setPreset('canvas-creator'); await settle()
    c.pick('canvas-hash', 0)
    expect(f.events[0].data.span).toEqual({ start: 3, end: 4, draftRev: 7 })
    off(); f.dispose()
  })
  it('rejects late candidate results after switching away and back before the request completes', async () => {
    const f = fixture(), c = f.controller
    const choices = await f.api.referenceChoices()
    let complete!: (value: typeof choices) => void
    f.api.referenceChoices.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve }))
    c.track('#', 1, { tier: 'plain' }, 1)
    const signal = f.api.referenceChoices.mock.calls.at(-1)![2]
    f.setPreset('standard'); expect(signal.aborted).toBe(true)
    f.setPreset('canvas-creator'); await settle()
    expect(f.files.list).toHaveBeenCalledTimes(1)
    complete(choices); await settle()
    expect(f.files.list).toHaveBeenCalledTimes(1)
    expect(c.menu.getSnapshot().groups[0].items[0].name).toBe('产品图')
    f.dispose()
  })
  it('blocks a late file result, stale picks and serialization when the preset changes', async () => {
    const f = fixture(), c = f.controller
    let complete!: (value: Awaited<ReturnType<typeof f.files.list>>) => void
    f.files.list.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve }))
    c.track('#', 1, { tier: 'plain' }, 1); await settle()
    f.setPreset('standard'); complete([]); await settle()
    expect(c.menu.getSnapshot().open).toBe(false)
    expect(f.source.onPick!({ candidate: { value: JSON.stringify(f.ref) } } as any)).toBeUndefined()
    f.setPreset('canvas-creator')
    let resolved!: (value: { text: string }) => void
    f.api.resolveReference.mockImplementationOnce(() => new Promise((resolve) => { resolved = resolve }))
    const serialized = c.serializeReference('canvas-hash', JSON.stringify(f.ref), new AbortController().signal)
    f.setPreset('standard'); resolved({ text: 'stale' })
    await expect(serialized).rejects.toThrow('无限画布')
    expect(f.events).toEqual([])
    f.dispose()
  })
  it('keeps exact UTF16 positions, quoted paths, inline tokens and markdown boundaries', () => {
    expect(hashDetectionText('看😀 #产品', 7)).toBe('看😀 @产品')
    expect(hashDetectionText('#"文档/有 空格', 10)).toBe('@"文档/有 空格')
    expect(hashDetectionText('# 标题', 4)).toBeUndefined()
    expect(hashDetectionText('x#tag', 5)).toBe(' @tag')
    expect(hashDetectionText('@文件', 3)).toBeUndefined()
  })
  it.each([
    { prefix: '阿诗丹顿', token: '#', suffix: '' },
    { prefix: '反馈', token: '#产品', suffix: '后面的文字' },
    { prefix: 'look😀', token: '#产品', suffix: '尾巴' },
    { prefix: '请参考', token: '#"文档/有 空格', suffix: '' },
    { prefix: '前#一个，再', token: '#第二', suffix: '' },
    { prefix: 'x', token: '#tag', suffix: '' },
  ])('opens # directly after $prefix and replaces only the exact token span', async ({ prefix, token, suffix }) => {
    const f = fixture(), c = f.controller, draft = prefix + token + suffix, caret = prefix.length + token.length
    c.track(draft, caret, { tier: 'plain' }, 17); await settle()
    expect(c.menu.getSnapshot().open).toBe(true)
    expect(f.api.referenceChoices).toHaveBeenLastCalledWith('test', token.slice(token.startsWith('#"') ? 2 : 1), expect.any(AbortSignal))
    c.pick('canvas-hash', 0)
    const { span } = f.events[0].data
    expect(span).toEqual({ start: prefix.length, end: caret, draftRev: 17 })
    expect(draft.slice(0, span.start) + '[引用]' + draft.slice(span.end)).toBe(prefix + '[引用]' + suffix)
    f.dispose()
  })
  it('drills a directory after adjacent prose without inserting a separator or replacing the prose', async () => {
    const f = fixture(), c = f.controller, prefix = '请参考'
    c.track(prefix + '#', prefix.length + 1, { tier: 'plain' }, 1); await settle()
    c.arbitrate('down', false); c.arbitrate('tab', false)
    expect(f.events[0]).toMatchObject({ event: 'slash/input-insert-text', data: { text: '#文档/', continue: true,
      span: { start: prefix.length, end: prefix.length + 1, draftRev: 1 } } })
    const draft = prefix + f.events[0].data.text
    c.track(draft, draft.length, { tier: 'plain' }, 2); await settle()
    expect(f.files.list).toHaveBeenLastCalledWith('test', '文档/', expect.any(AbortSignal))
    c.pick('canvas-hash', 1)
    expect(f.events.at(-1).data.span).toEqual({ start: prefix.length, end: draft.length, draftRev: 2 })
    f.dispose()
  })
  it('renders native sections in canvas-first order and sends native reference events with original span/revision', async () => {
    const f = fixture(), c = f.controller
    c.track('反馈 #', 4, { tier: 'plain' }, 7); await settle()
    expect(c.menu.getSnapshot().groups[0].items.map((item) => item.section)).toEqual(['画布 · 项目', '工作区'])
    const container = document.createElement('div'), root = createRoot(container)
    Object.assign(window.HTMLElement.prototype, { scrollIntoView() {} })
    await act(async () => root.render(<f.sdk.MenuView menu={c.menu} headers={c.headers} onPick={() => {}} onCrumb={() => {}} onHover={() => {}} onDismiss={() => {}} t={(key: string) => key} />))
    expect(container.textContent).toContain('画布 · 项目')
    expect(container.textContent!.indexOf('画布 · 项目')).toBeLessThan(container.textContent!.indexOf('工作区'))
    expect(c.arbitrate('enter', true)).toBe('pass')
    act(() => { expect(c.arbitrate('enter', false)).toBe('pick-highlighted') })
    expect(f.events[0]).toMatchObject({ event: 'slash/input-insert-reference', data: { span: { start: 3, end: 4, draftRev: 7 },
      reference: { source: 'canvas-hash', label: '#产品图' } } })
    expect(await c.serializeReference('canvas-hash', JSON.stringify(f.ref), new AbortController().signal)).toBe(referenceText(f.ref))
    await act(async () => root.unmount()); f.dispose()
  })
  it('drills workspace directories through native Tab/text events, keeping # and quote semantics', async () => {
    const f = fixture(), c = f.controller
    c.track('#', 1, { tier: 'plain' }, 1); await settle()
    c.arbitrate('down', false); c.arbitrate('tab', false)
    expect(f.events[0]).toMatchObject({ event: 'slash/input-insert-text', data: { text: '#文档/', continue: true } })
    c.track('#文档/', 4, { tier: 'plain' }, 2); await settle()
    expect(f.files.list).toHaveBeenLastCalledWith('test', '文档/', expect.any(AbortSignal))
    c.arbitrate('down', false); c.arbitrate('enter', false)
    expect(JSON.parse(f.events.at(-1).data.reference.ref)).toMatchObject({ kind: 'file', path: '文档/方案.md' })
    f.dispose()
  })
  it('keeps @, frozen drafts, Escape dismissal, subscriptions and disposal on native paths', async () => {
    const f = fixture(), c = f.controller, changed = vi.fn(), off = c.menu.subscribe(changed)
    c.track('#', 1, { tier: 'plain' }, 1); await settle(); expect(changed).toHaveBeenCalled()
    expect(c.arbitrate('escape', false)).toBe('consumed')
    c.track('#', 1, { tier: 'plain' }, 1); expect(c.menu.getSnapshot().open).toBe(false)
    c.track('@', 1, { tier: 'plain' }, 2); await settle()
    expect(c.menu.getSnapshot().groups[0].source).toBe('native')
    c.track('/', 1, { tier: 'plain' }, 2); await settle()
    expect(c.menu.getSnapshot().groups[0].source).toBe('slash')
    c.track('#', 1, { tier: 'frozen' }, 3); expect(c.menu.getSnapshot().open).toBe(false)
    c.track('#', 1, { tier: 'plain' }, 4); await settle()
    f.dispose()
    c.track('@', 1, { tier: 'plain' }, 5); await settle()
    expect(c.menu.getSnapshot().groups[0].source).toBe('native')
    off()
  })
  it('cancels superseded candidates and blocks failed reference serialization', async () => {
    const f = fixture(), c = f.controller
    c.track('#', 1, { tier: 'plain' }, 1); await settle()
    const signal = f.api.referenceChoices.mock.calls[0][2]
    c.track('#新', 2, { tier: 'plain' }, 2)
    expect(signal.aborted).toBe(true)
    f.api.resolveReference.mockRejectedValueOnce(new Error('素材已删除'))
    await expect(c.serializeReference('canvas-hash', JSON.stringify(f.ref), new AbortController().signal)).rejects.toThrow('素材已删除')
    f.dispose()
  })
  it('round trips escaped identity through clipboard/history and renders compact labels', () => {
    const f = fixture(), ref = { ...f.ref, label: '<标签>&" </canvas-reference>' }, text = `反馈 ${referenceText(ref)} 不符合预期`
    expect(referenceSpans(text)[0].ref).toEqual(ref)
    expect(chatReferenceTextRule.match(text, 0, {} as any)).toMatchObject({ id: 'canvas-hash', data: { label: ref.label } })
    expect(referenceSpans('<canvas-reference>{}</canvas-reference>')).toEqual([])
    f.dispose()
  })
})
