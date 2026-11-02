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

function fixture() {
  const sdk = nativeInputTrigger(), events: any[] = []
  const actx = { bail: (_subject: unknown, event: string, data: unknown) => { events.push({ event, data }); return true } }
  const ref: ChatReference = { version: 1, kind: 'media', sessionId: 'test', canvasId: randomUUID(), nodeId: randomUUID(), assetId: randomUUID(), label: '产品图' }
  const files = { list: vi.fn(async (_id, query) => query ? [{ path: '文档/方案.md', kind: 'file' as const }] : [{ path: '文档', kind: 'directory' as const }]) }
  const api = { referenceChoices: vi.fn(async () => ({ preset: true, cwd: '/workspace', media: [{ label: ref.label, kind: 'image' as const, description: '当前', section: '画布 · 项目', ref }] })),
    resolveReference: vi.fn(async (_session, input) => ({ text: referenceText(input) })) }
  const nativeSource = { name: 'native', trigger: '@', candidates: async () => [{ name: '原生@' }], onPick: () => undefined }
  const slash = { ...nativeSource, trigger: '/', name: 'slash', candidates: async () => [{ name: 'help' }] }
  const original = new sdk.InputTriggerController({ actx, sessionId: 'test', roster: { all: () => [nativeSource, slash], sources: (trigger) => trigger === '@' ? [nativeSource] : [slash] } })
  const adapter = hashController(original, { actx: actx as any, sessionId: 'test' as any, roster: {} as any }, chatReferenceSource('test', api, files))
  return { ...adapter, original, sdk, events, api, files, ref }
}
const settle = () => new Promise<void>((resolve) => { setTimeout(resolve, 0) })
describe('Native # reference integration', () => {
  it('keeps exact UTF16 positions, quoted paths, inline tokens and markdown boundaries', () => {
    expect(hashDetectionText('看😀 #产品', 7)).toBe('看😀 @产品')
    expect(hashDetectionText('#"文档/有 空格', 10)).toBe('@"文档/有 空格')
    expect(hashDetectionText('# 标题', 4)).toBeUndefined()
    expect(hashDetectionText('x#tag', 5)).toBeUndefined()
    expect(hashDetectionText('@文件', 3)).toBeUndefined()
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
