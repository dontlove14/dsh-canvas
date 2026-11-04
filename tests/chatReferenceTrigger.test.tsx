// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { nativeInputTrigger } from './support/nativeInputTrigger'
vi.mock('@deepseek-ai/dsh-client-ui-input-trigger/client', async () => (await import('./support/nativeInputTrigger')).nativeInputTrigger())
import { chatReferenceSource, hashController, hashDetectionText } from '../src/client/chatReferenceTrigger'
import { referenceText, referenceSpans, type ChatReference, type ChatReferenceChoices } from '../src/shared/chatReferences'
import { chatReferenceTextRule } from '../src/client/chatReferenceText'
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

function fixture(...initial: [unknown?]) {
  const sdk = nativeInputTrigger(), events: any[] = []
  let preset = initial.length ? initial[0] : 'canvas-creator'
  const available = () => preset === 'canvas-creator'
  const actx = { bail: (_subject: unknown, event: string, data: unknown) => { events.push({ event, data }); return true } }
  const ref: ChatReference = { version: 1, kind: 'media', sessionId: 'test', canvasId: randomUUID(), nodeId: randomUUID(), assetId: randomUUID(), label: '产品图' }
  const api = { referenceChoices: vi.fn(async (..._args: any[]): Promise<ChatReferenceChoices> => ({ preset: true, cwd: '/workspace', media: [{ label: ref.label, kind: 'image' as const, description: '当前', section: '画布 · 项目', ref }] })),
    resolveReference: vi.fn(async (_session, input) => ({ text: referenceText(input) })) }
  const nativeSource = { name: 'native', trigger: '@', candidates: async () => [{ name: '方案.md' }], onPick: () => undefined }
  const slash = { ...nativeSource, trigger: '/', name: 'slash', candidates: async () => [{ name: 'help' }] }
  const original = new sdk.InputTriggerController({ actx, sessionId: 'test', roster: { all: () => [nativeSource, slash], sources: (trigger) => trigger === '@' ? [nativeSource] : [slash] } })
  const source = chatReferenceSource('test', api, available)
  const adapter = hashController(original, { actx: actx as any, sessionId: 'test' as any, roster: {} as any }, source, available)
  return { ...adapter, original, sdk, events, api, ref, source,
    setPreset: (value: unknown) => { preset = value; adapter.refreshAvailability() } }
}
const settle = () => new Promise<void>((resolve) => { setTimeout(resolve, 0) })
describe('Native # reference integration', () => {
  const hierarchy = () => {
    const f = fixture()
    f.dispose()
    let current: string | null = f.ref.canvasId
    const other = randomUUID(), folder = randomUUID(), second = randomUUID()
    const choices: ChatReferenceChoices = { preset: true, cwd: '/workspace', expandedCanvasId: f.ref.canvasId, currentCanvasId: current,
      folders: [{ id: folder, name: '当前 分类', canvases: [{ id: f.ref.canvasId, name: '正在编辑', updatedAt: 1 }] },
        { id: second, name: '其他/分类#', canvases: [{ id: other, name: '另一个 @ 画布', updatedAt: 2 }] }],
      media: [{ label: f.ref.label, kind: 'image', description: '当前', section: '画布 · 当前 分类 · 正在编辑', ref: f.ref }] }
    f.api.referenceChoices.mockImplementation(async (_session, _query, _signal, browse) =>
      browse?.browseCanvasId ? { ...choices, media: [{ ...choices.media[0], ref: { ...f.ref, canvasId: other } }] }
        : browse?.folderId ? { ...choices, media: [], expandedCanvasId: undefined } : choices)
    const source = chatReferenceSource('test', f.api, () => true, () => current)
    const adapter = hashController(f.original, { actx: { bail: (_subject, event, data) => { f.events.push({ event, data }); return true } } as any,
      sessionId: 'test' as any, roster: {} as any }, source)
    return { ...f, ...adapter, source, choices, folder, second, other,
      changeCanvas: (id: string | null) => { current = id; adapter.refreshContext() } }
  }
  it('shows the current section expanded, other folders collapsed and drills folder/canvas with native breadcrumbs', async () => {
    const f = hierarchy(), c = f.controller
    c.track('前#尾', 2, { tier: 'plain' }, 1); await settle()
    const rows = c.menu.getSnapshot().groups[0].items
    expect(rows.slice(0, 2).map((row) => row.section)).toEqual(['画布 · 当前 分类 · 正在编辑', '画布 · 当前 分类 · 正在编辑'])
    expect(rows.map((row) => row.name)).toEqual(['正在编辑/', '产品图', '其他/分类#/'])
    c.pick('canvas-hash', 2)
    expect(f.events.at(-1)).toMatchObject({ event: 'slash/input-insert-text', data: { text: '#"画布/其他／分类＃/', continue: true, span: { start: 1, end: 2, draftRev: 1 } } })
    let token = f.events.at(-1).data.text
    c.track('前' + token + '尾', token.length + 1, { tier: 'plain' }, 2); await settle()
    expect(f.api.referenceChoices).toHaveBeenLastCalledWith('test', '', expect.any(AbortSignal), expect.objectContaining({ view: 'node-media', currentCanvasId: f.ref.canvasId, folderId: f.second }))
    expect(c.headers.getSnapshot().get('canvas-hash')!.map((crumb) => crumb.label)).toEqual(['画布', '其他/分类#'])
    c.arbitrate('tab', false)
    token = f.events.at(-1).data.text
    c.track('前' + token + '尾', token.length + 1, { tier: 'plain' }, 3); await settle()
    expect(f.api.referenceChoices).toHaveBeenLastCalledWith('test', '', expect.any(AbortSignal), expect.objectContaining({ browseCanvasId: f.other }))
    c.pick('canvas-hash', 0)
    expect(JSON.parse(f.events.at(-1).data.reference.ref)).toMatchObject({ canvasId: f.other })
    expect(f.events.at(-1).data.span).toEqual({ start: 1, end: token.length + 1, draftRev: 3 })
    // Remove the selected token just as the editor does, then revisit a folder.
    c.track('前', 1, { tier: 'plain' }, 4)
    c.track('前#尾', 2, { tier: 'plain' }, 5); await settle()
    c.pick('canvas-hash', 2)
    token = f.events.at(-1).data.text
    c.track('前' + token + '尾', token.length + 1, { tier: 'plain' }, 6); await settle()
    c.pickCrumb('canvas-hash', 0)
    expect(f.events.at(-1).data.text).toBe('#')
    c.track('前#尾', 2, { tier: 'plain' }, 7); await settle()
    expect(c.menu.getSnapshot().groups[0].items[0].name).toBe('正在编辑/')
    f.dispose()
  })
  it('immediately clears old rows, aborts old work and blocks stale picks when the actual editor changes', async () => {
    const f = hierarchy(), c = f.controller
    c.track('前#尾', 2, { tier: 'plain' }, 10); await settle()
    const old = c.menu.getSnapshot().groups[0].items[1]
    let finish!: (value: ChatReferenceChoices) => void
    f.api.referenceChoices.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    c.refreshOpenMenu()
    const signal = f.api.referenceChoices.mock.calls.at(-1)![2]
    f.changeCanvas(f.other)
    expect(signal.aborted).toBe(true)
    expect(c.menu.getSnapshot().groups.flatMap((group) => group.items)).toEqual([])
    expect(f.source.onPick({ candidate: old } as any)).toBeUndefined()
    await settle()
    finish(f.choices); await settle()
    expect(c.menu.getSnapshot().groups[0].items[0].name).toBe('正在编辑/')
    f.changeCanvas(null); await settle()
    expect(f.api.referenceChoices).toHaveBeenLastCalledWith('test', '', expect.any(AbortSignal), { view: 'node-media', currentCanvasId: null })
    c.pick('canvas-hash', 1)
    expect(f.events.at(-1).data.span).toEqual({ start: 1, end: 2, draftRev: 10 })
    f.dispose()
  })
  it.each([undefined, null, 'standard', 'canvas-image'])('treats # as literal text without candidate requests for preset %s', async (preset) => {
    const f = fixture(preset), c = f.controller
    c.track('#', 1, { tier: 'plain' }, 1); await settle()
    expect(c.menu.getSnapshot().open).toBe(false)
    expect(f.api.referenceChoices).not.toHaveBeenCalled()
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
    const currentRequestCount = f.api.referenceChoices.mock.calls.length
    complete(choices); await settle()
    expect(f.api.referenceChoices).toHaveBeenCalledTimes(currentRequestCount)
    expect(c.menu.getSnapshot().groups[0].items[0].name).toBe('产品图')
    f.dispose()
  })
  it('blocks a late canvas result, stale picks and serialization when the preset changes', async () => {
    const f = fixture(), c = f.controller
    let complete!: (value: ChatReferenceChoices) => void
    const choices = await f.api.referenceChoices()
    f.api.referenceChoices.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve }))
    c.track('#', 1, { tier: 'plain' }, 1); await settle()
    f.setPreset('standard'); complete(choices); await settle()
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
    expect(f.api.referenceChoices).toHaveBeenLastCalledWith('test', token.slice(token.startsWith('#"') ? 2 : 1), expect.any(AbortSignal), { view: 'node-media' })
    c.pick('canvas-hash', 0)
    const { span } = f.events[0].data
    expect(span).toEqual({ start: prefix.length, end: caret, draftRev: 17 })
    expect(draft.slice(0, span.start) + '[引用]' + draft.slice(span.end)).toBe(prefix + '[引用]' + suffix)
    f.dispose()
  })
  it('drills a canvas folder after adjacent prose without inserting a separator or replacing the prose', async () => {
    const f = hierarchy(), c = f.controller, prefix = '请参考'
    c.track(prefix + '#', prefix.length + 1, { tier: 'plain' }, 1); await settle()
    c.pick('canvas-hash', 2)
    expect(f.events[0]).toMatchObject({ event: 'slash/input-insert-text', data: { text: '#"画布/其他／分类＃/', continue: true,
      span: { start: prefix.length, end: prefix.length + 1, draftRev: 1 } } })
    const draft = prefix + f.events[0].data.text
    c.track(draft, draft.length, { tier: 'plain' }, 2); await settle()
    expect(f.api.referenceChoices).toHaveBeenLastCalledWith('test', '', expect.any(AbortSignal), expect.objectContaining({ folderId: f.second }))
    c.pick('canvas-hash', 0)
    expect(f.events.at(-1).data.span).toEqual({ start: prefix.length, end: draft.length, draftRev: 2 })
    f.dispose()
  })
  it('renders only canvas sections and sends native reference events with original span/revision', async () => {
    const f = fixture(), c = f.controller
    c.track('反馈 #', 4, { tier: 'plain' }, 7); await settle()
    expect(c.menu.getSnapshot().groups[0].items.map((item) => item.section)).toEqual(['画布 · 项目'])
    const container = document.createElement('div'), root = createRoot(container)
    Object.assign(window.HTMLElement.prototype, { scrollIntoView() {} })
    await act(async () => root.render(<f.sdk.MenuView menu={c.menu} headers={c.headers} onPick={() => {}} onCrumb={() => {}} onHover={() => {}} onDismiss={() => {}} t={(key: string) => key} />))
    expect(container.textContent).toContain('画布 · 项目')
    expect(container.textContent).not.toContain('工作区')
    expect(c.arbitrate('enter', true)).toBe('pass')
    act(() => { expect(c.arbitrate('enter', false)).toBe('pick-highlighted') })
    expect(f.events[0]).toMatchObject({ event: 'slash/input-insert-reference', data: { span: { start: 3, end: 4, draftRev: 7 },
      reference: { source: 'canvas-hash', label: '#产品图' } } })
    expect(await c.serializeReference('canvas-hash', JSON.stringify(f.ref), new AbortController().signal)).toBe(referenceText(f.ref))
    await act(async () => root.unmount()); f.dispose()
  })
  const unified = (prepare = vi.fn(async () => {})) => {
    const f = hierarchy()
    const nodeRef: ChatReference = { version: 2, kind: 'node', sessionId: 'test', canvasId: f.ref.canvasId, nodeId: f.ref.nodeId, label: '镜头02' }
    const history = randomUUID()
    f.api.referenceChoices.mockImplementation(async (_session, _query, _signal, browse) => ({ ...f.choices,
      items: browse?.nodeId ? browse.taskId ? [{ type: 'media', label: '旧结果', description: '历史', section: '画布', current: false, kind: 'image', ref: f.ref }]
        : [{ type: 'media', label: '当前结果', description: '当前展示', section: '画布', current: true, kind: 'image', ref: f.ref },
          { type: 'directory', label: '历史批次', description: '1份', section: '画布', nodeId: nodeRef.nodeId, taskId: history }]
        : [{ type: 'node', label: nodeRef.label, description: '视频生成 · 引用节点', section: '画布', ref: nodeRef, hasMedia: true },
          { type: 'media', label: '当前结果', description: '当前展示', section: '画布', current: true, kind: 'image', ref: f.ref }],
    }))
    f.dispose()
    const source = chatReferenceSource('test', f.api, () => true, () => f.ref.canvasId, prepare)
    const adapter = hashController(f.original, { actx: { bail: (_subject, event, data) => { f.events.push({ event, data }); return true } } as any,
      sessionId: 'test' as any, roster: {} as any }, source)
    return { ...f, ...adapter, source, nodeRef, prepare }
  }
  it.each(['pointer', 'enter'])('inserts only the node name and stable identity through native %s pick', async (mode) => {
    const f = unified(), c = f.controller
    c.track('前😀#后', 4, { tier: 'plain' }, 9); await settle()
    c.hover('canvas-hash', 1)
    const container = document.createElement('div'), root = createRoot(container)
    if (mode === 'pointer') {
      await act(async () => root.render(<f.sdk.MenuView menu={c.menu} headers={c.headers} onPick={(...args: any[]) => c.pick(...args)} onCrumb={() => {}} onHover={() => {}} onDismiss={() => {}} t={(key: string) => key} />))
      act(() => container.querySelectorAll('[role="option"]')[1].dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
    } else c.arbitrate('enter', false)
    const data = f.events.at(-1).data
    expect(data).toMatchObject({ reference: { label: '#镜头02' }, span: { start: 3, end: 4, draftRev: 9 } })
    expect(JSON.parse(data.reference.ref)).toEqual(f.nodeRef)
    expect(data.reference.clipboardText).not.toContain('prompt')
    await act(async () => root.unmount()); f.dispose()
  })
  it.each(['pointer', 'tab'])('opens current and history assets through native %s drill with breadcrumbs', async (mode) => {
    const f = unified(), c = f.controller, container = document.createElement('div'), root = createRoot(container)
    c.track('#', 1, { tier: 'plain' }, 1); await settle()
    c.hover('canvas-hash', 1)
    if (mode === 'pointer') {
      await act(async () => root.render(<f.sdk.MenuView menu={c.menu} headers={c.headers} onPick={(...args: any[]) => c.pick(...args)} onCrumb={() => {}} onHover={() => {}} onDismiss={() => {}} t={(key: string) => key} />))
      act(() => container.querySelectorAll('[role="option"]')[1].querySelector('[role="button"]')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
    } else c.arbitrate('tab', false)
    await act(async () => root.unmount())
    let token = f.events.at(-1).data.text
    c.track(token, token.length, { tier: 'plain' }, 2); await settle()
    expect(c.menu.getSnapshot().groups[0].items.map((item) => item.name)).toEqual(['当前结果', '历史批次/'])
    expect(c.headers.getSnapshot().get('canvas-hash')!.map((item) => item.label)).toEqual(['画布', '当前 分类', '正在编辑', '镜头02'])
    c.pick('canvas-hash', 1); token = f.events.at(-1).data.text
    c.track(token, token.length, { tier: 'plain' }, 3); await settle()
    expect(f.api.referenceChoices).toHaveBeenLastCalledWith('test', '', expect.any(AbortSignal), expect.objectContaining({ nodeId: f.nodeRef.nodeId, taskId: expect.any(String) }))
    c.pick('canvas-hash', 0)
    expect(JSON.parse(f.events.at(-1).data.reference.ref)).toEqual(f.ref)
    f.dispose()
  })
  it('waits for node autosave before serialization and retains the draft when saving fails', async () => {
    let finish!: () => void
    const prepare = vi.fn(() => new Promise<void>((resolve) => { finish = resolve })), f = unified(prepare), signal = new AbortController().signal
    const pending = f.controller.serializeReference('canvas-hash', JSON.stringify(f.nodeRef), signal)
    expect(f.api.resolveReference).not.toHaveBeenCalled()
    finish()
    expect(await pending).toBe(referenceText(f.nodeRef))
    prepare.mockRejectedValueOnce(new Error('保存冲突，草稿保留'))
    await expect(f.controller.serializeReference('canvas-hash', JSON.stringify(f.nodeRef), signal)).rejects.toThrow('保存冲突')
    expect(f.api.resolveReference).toHaveBeenCalledTimes(1); expect(f.events).toEqual([])
    f.dispose()
  })
  it('continues through native pagination and resets an expired cursor without losing the query', async () => {
    const f = unified(), c = f.controller
    f.api.referenceChoices.mockResolvedValueOnce({ ...f.choices, items: [], nextCursor: 'first-page', truncated: true })
    c.track('#历史', 3, { tier: 'plain' }, 1); await settle()
    c.pick('canvas-hash', 1)
    const token = f.events.at(-1).data.text
    f.api.referenceChoices.mockRejectedValueOnce({ code: 'REFERENCE_STALE', status: 409 })
    c.track(token, token.length, { tier: 'plain' }, 2); await settle()
    expect(f.api.referenceChoices.mock.calls.at(-2)![3]).toMatchObject({ cursor: 'first-page' })
    expect(f.api.referenceChoices.mock.calls.at(-1)![1]).toBe('历史')
    expect(f.api.referenceChoices.mock.calls.at(-1)![3]).not.toHaveProperty('cursor')
    f.dispose()
  })
  it('uses native @ for workspace files while # remains canvas-only, including empty results', async () => {
    const f = fixture(), c = f.controller
    c.track('#', 1, { tier: 'plain' }, 1); await settle()
    expect(c.menu.getSnapshot().groups[0].items.map((row) => row.name)).toEqual(['产品图'])
    const requests = f.api.referenceChoices.mock.calls.length
    c.track('@', 1, { tier: 'plain' }, 2); await settle()
    expect(c.menu.getSnapshot().groups[0]).toMatchObject({ source: 'native', items: [{ name: '方案.md' }] })
    expect(f.api.referenceChoices).toHaveBeenCalledTimes(requests)
    f.api.referenceChoices.mockResolvedValueOnce({ preset: true, cwd: '/workspace', media: [] })
    c.track('#', 1, { tier: 'plain' }, 3); await settle()
    expect(c.menu.getSnapshot().groups.flatMap((group) => group.items)).toEqual([])
    expect(f.events).toEqual([])
    const legacy: ChatReference = { version: 1, kind: 'file', sessionId: 'test', cwd: '/workspace', path: '方案.md', label: '方案.md' }
    expect(await c.serializeReference('canvas-hash', JSON.stringify(legacy), new AbortController().signal)).toBe(referenceText(legacy))
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
