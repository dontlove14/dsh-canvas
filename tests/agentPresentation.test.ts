import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentPresentation } from '../src/host/agent/presentation'
import { emptyGraph, type CanvasNode } from '../src/shared/contracts'
import type { CanvasControl } from '../src/shared/agent'
import { placeAgentNode, initialNodeSize } from '../src/shared/agentLayout'

const dirs: string[] = []
afterEach(async () => { vi.useRealTimers(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'canvas-presentation-test-')); dirs.push(dir)
  let control: CanvasControl = { canvasId: 'canvas', sessionId: 'session', mode: 'agent', epoch: 1, updatedAt: Date.now() }
  const service = new AgentPresentation(dir, () => control); await service.init()
  const report = (fields = {}) => service.report({ sessionId: 'session', canvasId: 'canvas', epoch: 1, viewId: 'view', sequence: 1,
    visible: true, following: true, center: { x: 1234, y: -456 }, width: 800, height: 700, zoom: .5, ...fields })
  const publish = (id = 'step', revision = 1) => service.publish(control, id, 'create', revision, ['node'])
  const ack = (id: string, fields = {}) => service.ack({ sessionId: 'session', canvasId: 'canvas', epoch: 1, viewId: 'view',
    presentationId: id, graphRevision: 1, status: 'presented', ...fields })
  return { dir, service, report, publish, ack, control: () => control, revoke: () => { control = { ...control, epoch: 2, mode: 'manual' }; service.changed() } }
}
describe('Agent presentation identity, visibility and recovery', () => {
  it('does not interpret navigation or publishing as a rendered receipt', async () => {
    const f = await fixture(), intent = await f.publish()
    expect(await f.service.wait(intent, new AbortController().signal)).toMatchObject({ status: 'deferred' })
    expect(() => f.ack(intent.id)).toThrow()
    f.report(); f.ack(intent.id)
    expect(await f.service.wait(intent, new AbortController().signal)).toMatchObject({ status: 'presented' })
  })
  it('deduplicates presentation IDs, retains the latest intent and rejects old or wrong-session acks', async () => {
    const f = await fixture(), first = await f.publish()
    expect(await f.publish()).toEqual(first)
    const next = await f.publish('next', 2)
    expect(next.createdAt).toBeGreaterThan(first.createdAt)
    f.report()
    expect(() => f.ack(first.id)).toThrow()
    expect(() => f.ack(next.id, { graphRevision: 1 })).toThrow()
    expect(() => f.ack(next.id, { sessionId: 'other', graphRevision: 2 })).toThrow()
    f.ack(next.id, { graphRevision: 2 })
    expect(f.service.state('other').intent).toBeNull()
  })
  it('waits for a late render, then cancels cleanly on takeover without a commit lock', async () => {
    vi.useFakeTimers()
    const f = await fixture(), intent = await f.publish()
    f.service.reportPresence('root', 'session', true)
    let settled = false
    const waiting = f.service.wait(intent, new AbortController().signal).then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    f.report(); f.ack(intent.id)
    await waiting
    const next = await f.publish('next')
    const revoked = expect(f.service.wait(next, new AbortController().signal)).rejects.toMatchObject({ code: 'AGENT_CONTROL_REVOKED' })
    f.revoke(); await revoked
    expect(f.service.state('session').intent).toBeNull()
    expect(() => f.report({ sequence: 2 })).toThrow()
  })
  it('expires view and presence reports and ignores reordered view sequences', async () => {
    vi.useFakeTimers()
    const f = await fixture(), intent = await f.publish()
    f.report({ sequence: 4, following: false })
    f.report({ sequence: 3, following: true })
    expect(await f.service.wait(intent, new AbortController().signal)).toMatchObject({ status: 'paused' })
    await vi.advanceTimersByTimeAsync(5001)
    expect(f.service.view(f.control())).toBeUndefined()
    expect(await f.service.wait(intent, new AbortController().signal)).toMatchObject({ status: 'deferred' })
  })
  it('retains only layout metadata in a separate file and does not revive a revoked epoch after restart', async () => {
    const f = await fixture(); await f.publish(); f.report()
    const position = await f.service.position(f.control(), emptyGraph(), 'video-generation', { group: 'shots' }, new AbortController().signal)
    expect(position).toEqual({ position: { x: 1074, y: -546 }, source: 'visible-viewport' })
    const saved = JSON.parse(await readFile(join(f.dir, 'agent-presentation.json'), 'utf8'))
    expect(saved.canvases.canvas.origin).toEqual(position.position)
    expect(saved.views).toBeUndefined()
    f.revoke()
    const restored = new AgentPresentation(f.dir, () => f.control()); await restored.init()
    expect(restored.state('session').intent).toBeNull()
  })
  it('times out the UI wait as deferred while retaining the actual intent', async () => {
    vi.useFakeTimers()
    const f = await fixture(), intent = await f.publish()
    const waiting = f.service.wait(intent, new AbortController().signal)
    for (let second = 0; second < 8; second++) {
      f.service.reportPresence('root', 'session', true)
      await vi.advanceTimersByTimeAsync(1000)
    }
    expect(await waiting).toMatchObject({ status: 'deferred' })
    expect(f.service.current('canvas')?.id).toBe(intent.id)
  })
  it('releases a pending UI wait immediately on host shutdown', async () => {
    const f = await fixture(), intent = await f.publish()
    f.service.reportPresence('root', 'session', true)
    const waiting = f.service.wait(intent, new AbortController().signal)
    f.service.close()
    expect(await waiting).toMatchObject({ status: 'deferred', reason: '宿主正在关闭，稍后重新委托' })
  })
})
describe('Agent automatic layout', () => {
  it('starts every empty node kind at the viewport origin and keeps the origin after panning', async () => {
    const f = await fixture(); await f.publish(); f.report()
    const first = await f.service.position(f.control(), emptyGraph(), 'tts-generation', { group: 'audio' }, new AbortController().signal)
    const node: CanvasNode = { id: 'node', kind: 'tts-generation', position: first.position, title: '声音', prompt: '', params: null, modelId: null, assetId: null, selectedResultId: null }
    f.report({ sequence: 2, center: { x: 9000, y: 9000 } })
    const next = await f.service.position(f.control(), { ...emptyGraph(), nodes: [node] }, 'image-generation', { group: 'assets' }, new AbortController().signal)
    expect(first.position).toEqual({ x: 1074, y: -546 })
    expect(next.source).toBe('fixed-origin')
    expect(next.position.x).toBeLessThan(4000)
    expect(node.position).toEqual(first.position)
  })
  it('avoids existing expanded media and prompt regions across a seeded 128-node layout', () => {
    let seed = 89
    const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32 }
    const nodes: CanvasNode[] = [], sizes: Record<string, { width: number; height: number }> = {}
    for (let index = 0; index < 128; index++) {
      const size = { width: 320 + Math.floor(random() * 350), height: 180 + Math.floor(random() * 300) }
      const position = placeAgentNode(nodes, size, { x: 0, y: 0 }, { group: 'assets' }, sizes)
      for (const node of nodes) {
        const other = sizes[node.id]
        const blocks = (point: { x: number; y: number }, frame: { width: number; height: number }) => [
          { left: point.x - 40, right: point.x + frame.width + 40, top: point.y - 55, bottom: point.y + frame.height + 40 },
          { left: point.x + frame.width / 2 - 265, right: point.x + frame.width / 2 + 265,
            top: point.y + frame.height, bottom: point.y + frame.height + 550 },
        ]
        for (const a of blocks(position, size)) for (const b of blocks(node.position, other)) {
          expect(a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top).toBe(false)
        }
      }
      const id = String(index); sizes[id] = size
      nodes.push({ id, kind: 'image-generation', position, title: id, prompt: '', params: null, modelId: null, assetId: null, selectedResultId: null })
    }
    expect(() => placeAgentNode(nodes, initialNodeSize('image-generation'), { x: 0, y: 0 }, { group: 'assets', anchorNodeId: 'missing' })).toThrow()
  })
})
