// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ReactFlowProvider } from '@xyflow/react'
import { afterEach, expect, it, vi } from 'vitest'
import { FloatingEditor } from '../src/client/Canvas'
import { CanvasApi } from '../src/client/api'
import { emptyGraph, defaultTtsParams, type CanvasNode, type Asset } from '../src/shared/contracts'
import { MOCK_MODELS } from '../src/shared/mockModels'
import { mockRecord } from '../src/shared/mockModels'
import { GenerationSnapshotEditor } from '../src/client/GenerationSnapshotEditor'
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: () => null, Input: () => null, Checkbox: () => null, SegmentedControl: () => null, Menu: () => null, Modal: () => null, Tooltip: () => null,
}))
let root: Root | undefined
afterEach(() => { act(() => root?.unmount()); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
it.each(['image-generation', 'video-generation', 'tts-generation'] as const)('shows complete current %s inputs in the original card with no mutable controls or write callbacks', async (kind) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const model = MOCK_MODELS.find((model) => model.kind === (kind === 'video-generation' ? 'video' : 'image'))!
  const node: CanvasNode = { id: crypto.randomUUID(), kind, title: '当前节点', position: { x: 900, y: 450 }, prompt: '全部提示词\n第二行 [参考图1]',
    params: kind === 'tts-generation' ? { ...defaultTtsParams(), reference_id: 'voice', speed: 1.25 } : { size: '1024x1024', n: 3, seconds: 8 },
    modelId: kind === 'tts-generation' ? null : model.id, assetId: null, selectedResultId: null }
  const mutate = vi.fn(), onOpen = vi.fn(), api = new CanvasApi()
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => { root!.render(<ReactFlowProvider><FloatingEditor readOnly node={node} graph={{ ...emptyGraph(), nodes: [node] }}
    assets={[]} tasks={[]} models={[model]} api={api} workspace="canvas" ttsConfigured ttsConfigurationError={false}
    onResult={mutate} patchNode={mutate} edit={mutate} generate={mutate} report={mutate} uploading={false} submitting={false}
    askImport={mutate} taskAction={mutate} onOpen={onOpen} /></ReactFlowProvider>) })
  const card = container.querySelector('[data-dc-current-inspection]')!
  const prompt = card.querySelector('textarea')!
  expect(prompt.readOnly).toBe(true); expect(prompt.disabled).toBe(false); expect(prompt.value).toBe(node.prompt)
  expect(prompt.dataset.dcTextSelectable).toBe('true')
  expect(card.textContent).toContain(kind === 'tts-generation' ? 'voice' : model.name)
  expect(card.textContent).toContain(kind === 'tts-generation' ? '1.25' : '1024x1024')
  expect(card.querySelector('button,input,select,[contenteditable="true"]')).toBeNull()
  act(() => { prompt.focus(); prompt.dispatchEvent(new Event('input', { bubbles: true })); prompt.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })) })
  expect(mutate).not.toHaveBeenCalled()
  expect(container.querySelector('.dc-generation-editor')).toBeTruthy()
})
it('opens original image, video and audio references from an immutable submitted snapshot', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('IntersectionObserver', class { observe() {}; disconnect() {} })
  const assets: Asset[] = (['image', 'video', 'audio'] as const).map((kind) => ({ id: crypto.randomUUID(), kind,
    filename: kind, mime: `${kind}/${kind === 'image' ? 'png' : kind === 'video' ? 'mp4' : 'wav'}`, bytes: 100, createdAt: 1, nodeId: null, taskId: null }))
  const api = new CanvasApi(), onOpen = vi.fn()
  vi.spyOn(api, 'mediaUrls').mockResolvedValue({ items: [] })
  const snapshot = { model: mockRecord(MOCK_MODELS[0].id), prompt: '本次提交的提示词', params: { size: '1024x1024', n: 1 },
    referenceIds: [...assets.map((asset) => asset.id), crypto.randomUUID()] }
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => root!.render(<ReactFlowProvider><GenerationSnapshotEditor api={api} workspace="canvas" snapshot={snapshot}
    assets={assets} onOpen={onOpen} readOnly anchor={{ position: { x: 0, y: 0 }, size: { width: 320, height: 180 } }} /></ReactFlowProvider>))
  const references = [...container.querySelectorAll<HTMLButtonElement>('.dc-reference')]
  act(() => references.forEach((reference) => reference.click()))
  expect(onOpen.mock.calls.map(([asset]) => asset)).toEqual(assets)
  expect(references[3].disabled).toBe(true)
  expect(container.textContent).toContain(snapshot.prompt)
  expect(container.querySelector('input,textarea,select,[contenteditable="true"]')).toBeNull()
})
