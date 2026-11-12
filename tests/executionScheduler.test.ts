import { describe, it, expect } from 'vitest'
import { ExecutionScheduler, executionGroup, executionResources, independentCreateBatches } from '../src/host/agent/executionScheduler'
import { emptyGraph } from '../src/shared/contracts'
import { ExecutionBatchSchema } from '../src/shared/execution'
import { randomUUID } from 'node:crypto'

const signal = () => new AbortController().signal
const gate = () => { let open!: () => void; const promise = new Promise<void>((resolve) => { open = resolve }); return { promise, open } }
describe('executor scheduling', () => {
  it('splits only fresh prepared creates, allows shared existing references and keeps dependencies or mixed work ordered', () => {
    const batch = ExecutionBatchSchema.parse({ operationId: randomUUID(), task: '新建', commands: [0, 1, 2].map(() => ({
      tool: 'canvas_create_node', input: { operationId: randomUUID(), revision: 0, kind: 'image-generation', title: '图', prompt: '',
        references: [{ source: randomUUID(), assetId: randomUUID() }] },
    })) })
    const first = batch.commands[0]
    if (first.tool !== 'canvas_create_node') throw new Error('fixture')
    for (const command of batch.commands) if (command.tool === 'canvas_create_node') command.input.references = first.input.references
    expect(independentCreateBatches(batch, emptyGraph(), 2).map((task) => task.commands.length)).toEqual([2, 1])
    expect(independentCreateBatches(batch, emptyGraph(), 2)).toEqual(independentCreateBatches(batch, emptyGraph(), 2))
    expect(independentCreateBatches(batch, emptyGraph(), 1)).toEqual([])
    expect(independentCreateBatches({ ...batch, executionMode: 'serial' }, emptyGraph(), 4)).toEqual([])
    expect(independentCreateBatches({ ...batch, commands: [first] }, emptyGraph(), 4)).toEqual([])
    const dependent = structuredClone(batch), next = dependent.commands[1]
    if (next.tool !== 'canvas_create_node') throw new Error('fixture')
    next.input.references![0].source = first.input.operationId
    expect(independentCreateBatches(dependent, emptyGraph(), 4)).toEqual([])
    next.input.references = []; next.input.placement = { anchorNodeId: first.input.operationId, group: 'assets' }
    expect(independentCreateBatches(dependent, emptyGraph(), 4)).toEqual([])
    next.input.placement = undefined; next.input.revision = 1
    expect(independentCreateBatches(dependent, emptyGraph(), 4)).toEqual([])
    expect(independentCreateBatches({ ...batch, commands: [first, first] }, emptyGraph(), 4)).toEqual([])
    expect(independentCreateBatches(batch, { ...emptyGraph(), nodes: [{ id: first.input.operationId } as any] }, 4)).toEqual([])
    expect(independentCreateBatches({ ...batch, commands: [first, { tool: 'canvas_generate', input: { operationId: randomUUID(), revision: 0, nodeId: first.input.operationId } }] }, emptyGraph(), 4)).toEqual([])
  })
  it('overlaps independent model work while conflicting nodes wait without consuming a slot', async () => {
    const pool = new ExecutionScheduler(2), first = await pool.acquire('root', { read: [], write: ['node:A'] }, signal(), () => {})
    let conflict = false
    const waiting = pool.acquire('root', { read: [], write: ['node:A'] }, signal(), () => {}).then((release) => { conflict = true; return release })
    const independent = await pool.acquire('root', { read: [], write: ['node:B'] }, signal(), () => {})
    expect(conflict).toBe(false)
    independent(); expect(conflict).toBe(false)
    first(); (await waiting)()
    expect(conflict).toBe(true)
  })
  it('cancels queued work and rejects late admissions after revocation', async () => {
    const pool = new ExecutionScheduler(1), release = await pool.acquire('root', { read: [], write: [] }, signal(), () => {})
    const abort = new AbortController()
    const pending = pool.acquire('root', { read: [], write: [] }, abort.signal, () => {})
    abort.abort()
    await expect(pending).rejects.toBeDefined()
    let valid = true
    const late = pool.acquire('root', { read: [], write: [] }, signal(), () => { if (!valid) throw new Error('revoked') })
    valid = false; pool.changed()
    await expect(late).rejects.toThrow('revoked')
    release()
  })
  it('shares reads and serializes upstream writes and whole-graph generation', async () => {
    const graph = { ...emptyGraph(), edges: [{ id: 'edge', source: 'A', target: 'B', assetId: 'asset' }] }
    const resources = executionResources([{ tool: 'canvas_update_node', input: { operationId: 'op', revision: 0, nodeId: 'B', patch: { title: 'edit' } } }], graph)
    expect(resources.read).toEqual(expect.arrayContaining(['node:A', 'asset:asset']))
    const pool = new ExecutionScheduler(2)
    const release = await pool.acquire('root', resources, signal(), () => {})
    const shared = await pool.acquire('root', { read: ['node:A', 'asset:asset'], write: ['node:C'] }, signal(), () => {})
    shared()
    let began = false
    const global = pool.acquire('root', { read: [], write: ['*'] }, signal(), () => {}).then((done) => { began = true; return done })
    expect(began).toBe(false); release(); (await global)(); expect(began).toBe(true)
  })
  it('starts independent branches together, blocks failed dependencies and retains successful receipts', async () => {
    const both = gate(), names: string[] = []
    const tasks = [{ operationId: 'A', dependsOn: [] }, { operationId: 'B', dependsOn: [] }, { operationId: 'C', dependsOn: ['A'] }]
    const result = executionGroup(tasks, signal(), () => {}, async (task) => {
      names.push(task.operationId)
      if (names.length === 2) both.open()
      await both.promise
      if (task.operationId === 'A') throw new Error('failure')
      return { completed: true, receipt: 'real' }
    })
    expect((await result).tasks).toMatchObject([{ status: 'blocked' }, { status: 'completed', value: { receipt: 'real' } }, { status: 'blocked' }])
    expect(names).toEqual(['A', 'B'])
    await expect(executionGroup([{ operationId: 'A', dependsOn: ['B'] }, { operationId: 'B', dependsOn: ['A'] }], signal(), () => {}, async () => {})).rejects.toThrow('循环')
  })
})
