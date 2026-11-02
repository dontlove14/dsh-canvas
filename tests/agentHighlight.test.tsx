// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ReactFlowProvider } from '@xyflow/react'
import { afterEach, expect, it, vi } from 'vitest'
import { CanvasWorkspace } from '../src/client/Canvas'
import { CanvasApi } from '../src/client/api'
import { CanvasPresentationClient } from '../src/client/presentation'
import { AgentNodeHighlight } from '../src/client/AgentNodeHighlight'
import { NodeLoadingContext } from '../src/client/NodeLoading'
import { defaultTtsParams, emptyGraph, FISH_TTS_ENDPOINT, type CanvasNode, type NodeKind } from '../src/shared/contracts'
import type { CanvasSnapshot } from '../src/shared/v2'
import type { PresentationIntent } from '../src/shared/presentation'

vi.mock('@xyflow/react', async (original) => {
  const actual = await original<typeof import('@xyflow/react')>()
  return { ...actual, Background: () => null, Controls: () => null, MiniMap: () => null,
    ReactFlow: ({ nodes, nodeTypes, children }: any) => <div>{nodes.map((node: any) => {
      const Component = nodeTypes[node.type]
      return <div key={node.id} data-id={node.id}><Component id={node.id} data={node.data} selected={node.selected} /></div>
    })}{children}</div> }
})
vi.mock('../src/client/useGpu', () => ({ useGpuCapability: () => ({ enabled: false, reason: 'test' }) }))
let root: Root | undefined
afterEach(() => {
  act(() => root?.unmount()); root = undefined; document.body.replaceChildren()
  sessionStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
function setup() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {}; disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {}; disconnect() {} })
  vi.stubGlobal('matchMedia', () => Object.assign(new EventTarget(), { matches: false }))
  // Geometry is covered separately; no real browser or frame loop is required.
  vi.stubGlobal('requestAnimationFrame', () => 1); vi.stubGlobal('cancelAnimationFrame', () => {})
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  return host
}

it('highlights every node kind through the shared shell, switches only the real target and clears on native idle, hide or takeover', async () => {
  const host = setup(), api = new CanvasApi(), client = new CanvasPresentationClient()
  const kinds: NodeKind[] = ['image-generation', 'video-generation', 'tts-generation', 'image-asset', 'video-asset', 'audio-asset']
  const nodes: CanvasNode[] = kinds.map((kind, index) => ({ id: `node-${index}`, kind, title: kind, position: { x: index * 500, y: 0 },
    prompt: '原提示词', params: kind === 'tts-generation' ? defaultTtsParams() : null, modelId: null, assetId: null, selectedResultId: null }))
  const snapshot: CanvasSnapshot = { version: 1, workspaceId: 'canvas', graphRevision: 1, graph: { ...emptyGraph(), nodes }, assets: [], tasks: [],
    updatedAt: 1, commitHash: 'a'.repeat(64), hashes: { nodes: {}, edges: {}, viewport: '' },
    agentControl: { canvasId: 'canvas', sessionId: 'session', epoch: 1, mode: 'agent', updatedAt: 1 } }
  vi.spyOn(api, 'state').mockResolvedValue(snapshot); vi.spyOn(api, 'models').mockResolvedValue([])
  vi.spyOn(api, 'ttsSettings').mockResolvedValue({ endpoint: FISH_TTS_ENDPOINT, revision: 0, configured: false, has_api_key: false, api_key_mask: '' })
  vi.spyOn(api, 'reportView').mockResolvedValue({ ok: true }); vi.spyOn(api, 'acknowledgePresentation').mockResolvedValue({ ok: true })
  const view = (active = true) => <ReactFlowProvider><CanvasWorkspace api={api} workspace="canvas" title="画布" onBack={() => {}}
    sessionId="session" active={active} presentation={client} /></ReactFlowProvider>
  await act(async () => { root!.render(view()); await Promise.resolve() })
  const articles = [...host.querySelectorAll('article')]
  const before = JSON.stringify(nodes)
  const intent = (nodeId: string, createdAt: number, fields = {}): PresentationIntent => ({
    id: `step-${createdAt}`, action: 'update', sessionId: 'session', canvasId: 'canvas', epoch: 1,
    graphRevision: 1, nodeIds: [nodeId], createdAt, ...fields,
  })
  for (const [index, node] of nodes.entries()) {
    await act(async () => { client.receive({ intent: intent(node.id, index + 1), running: true }); await Promise.resolve() })
    expect([...host.querySelectorAll('[data-dc-agent-highlight]')].map((item) => item.getAttribute('data-dc-agent-highlight'))).toEqual([node.id])
    expect(host.querySelectorAll('[data-beam]')).toHaveLength(1)
    expect([...host.querySelectorAll('article')]).toEqual(articles)
  }
  await act(async () => { client.pause(); await Promise.resolve() })
  expect(host.querySelector('[data-dc-agent-highlight]')).not.toBeNull()
  await act(async () => { client.receive({ intent: client.getSnapshot(), running: false }); await Promise.resolve() })
  expect(host.querySelector('[data-dc-agent-highlight]')).toBeNull()
  await act(async () => { client.receive({ intent: intent('node-0', 10), running: true }); await Promise.resolve() })
  await act(async () => { root!.render(view(false)); await Promise.resolve() })
  expect(host.querySelector('[data-dc-agent-highlight]')).toBeNull()
  await act(async () => { root!.render(view()); await Promise.resolve() })
  expect(host.querySelector('[data-dc-agent-highlight]')).not.toBeNull()
  await act(async () => { client.receive({ intent: intent('node-1', 11, { sessionId: 'other' }), running: true }); await Promise.resolve() })
  expect(host.querySelector('[data-dc-agent-highlight]')).toBeNull()
  await act(async () => { client.receive({ intent: intent('node-1', 12, { epoch: 2 }), running: true }); await Promise.resolve() })
  expect(host.querySelector('[data-dc-agent-highlight]')).toBeNull()
  await act(async () => { client.receive({ intent: intent('node-1', 13, { graphRevision: 2 }), running: true }); await Promise.resolve() })
  expect(host.querySelector('[data-dc-agent-highlight]')).toBeNull()
  await act(async () => { client.receive({ intent: null }); await Promise.resolve() })
  expect(host.querySelector('[data-dc-agent-highlight]')).toBeNull()
  expect(JSON.stringify(nodes)).toBe(before)
})

it('uses the actual Beam border without a content cover or loader, follows Harness theme and retains a static border for reduced motion', () => {
  const host = setup()
  const view = (theme: 'dark' | 'light', paused: boolean) => <NodeLoadingContext.Provider value={{ theme, ink: '#fff', paused }}>
    <article>原始媒体与提示词<AgentNodeHighlight nodeId="node" /></article>
  </NodeLoadingContext.Provider>
  act(() => root!.render(view('dark', false)))
  const beam = host.querySelector<HTMLElement>('[data-beam]')!
  expect(beam.dataset.dcAgentHighlight).toBe('node')
  expect(beam.style.pointerEvents).toBe('none')
  expect(beam.style.position).toBe('absolute')
  expect(beam.textContent).toBe('')
  expect(host.querySelector('canvas,.dc-node-loading')).toBeNull()
  expect(host.textContent).toContain('原始媒体与提示词')
  act(() => root!.render(view('light', true)))
  expect(host.querySelector('[data-beam]')).toBe(beam)
  expect(beam.hasAttribute('data-loading-paused')).toBe(true)
  expect([...host.querySelectorAll('style')].map((item) => item.textContent).join('')).toContain('animation-play-state: paused')
})
