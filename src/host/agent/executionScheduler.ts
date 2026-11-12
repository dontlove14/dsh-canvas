import type { CanvasGraph, Asset } from '../../shared/contracts'
import type { ExecutionBatch, ExecutionCommand } from '../../shared/execution'
import { CanvasError } from '../store'
import { hash } from '../persistence/database'

export interface Resources { read: string[]; write: string[] }
/** Only prepared, fresh creates are independent by construction; keep mixed work ordered. */
export function independentCreateBatches(batch: ExecutionBatch, graph: CanvasGraph, capacity: number): ExecutionBatch[] {
  const count = Math.min(capacity, batch.commands.length)
  if (batch.executionMode === 'serial' || count < 2 || batch.commands.some((command) => command.tool !== 'canvas_create_node')) return []
  const ids = new Set(batch.commands.map((command) => command.input.operationId))
  if (ids.size !== batch.commands.length || graph.nodes.some((node) => ids.has(node.id))) return []
  const revision = batch.commands[0].input.revision
  for (const command of batch.commands) {
    if (command.tool !== 'canvas_create_node') return []
    if (command.input.revision !== revision || command.input.references?.some((ref) => ids.has(ref.source)) ||
      (command.input.placement?.anchorNodeId && ids.has(command.input.placement.anchorNodeId))) return []
  }
  return Array.from({ length: count }, (_, index) => {
    // Stable task IDs keep the parent batch and exact command identities separate.
    const digest = hash({ batchId: batch.operationId, independentCreates: index })
    const operationId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`
    return { ...batch, operationId, commands: batch.commands.filter((_, at) => at % count === index) }
  })
}
export function executionResources(commands: ExecutionCommand[], graph: CanvasGraph): Resources {
  const read = new Set<string>(), write = new Set<string>()
  const upstream = (id: string) => {
    const key = `node:${id}`
    if (read.has(key)) return
    read.add(key)
    for (const edge of graph.edges.filter((edge) => edge.target === id)) {
      read.add(`asset:${edge.assetId}`); upstream(edge.source)
    }
  }
  for (const command of commands) {
    const input = command.input
    if (command.tool === 'canvas_import_attachment' || command.tool === 'canvas_generate') write.add('*')
    if ('nodeId' in input) { write.add(`node:${input.nodeId}`); upstream(input.nodeId) }
    if ('target' in input) { write.add(`node:${input.target}`); upstream(input.target); upstream(input.source); read.add(`asset:${input.assetId}`) }
    if (command.tool === 'canvas_create_node') {
      write.add(`node:${input.operationId}`)
      if (command.input.placement?.anchorNodeId) upstream(command.input.placement.anchorNodeId)
    }
    if ('references' in input) for (const ref of input.references ?? []) { upstream(ref.source); read.add(`asset:${ref.assetId}`) }
  }
  return { read: [...read], write: [...write] }
}
export function resourceFingerprint(key: string, graph: CanvasGraph, assets: Asset[]): string {
  if (key === '*') return hash(graph)
  const id = key.slice(key.indexOf(':') + 1)
  return key.startsWith('asset:')
    ? hash(assets.find((asset) => asset.id === id) ?? null)
    : hash({ node: graph.nodes.find((node) => node.id === id) ?? null,
      edges: graph.edges.filter((edge) => edge.target === id).sort((a, b) => a.id.localeCompare(b.id)) })
}
function conflicts(a: Resources, b: Resources) {
  if (a.write.includes('*') || b.write.includes('*')) return true
  return a.write.some((key) => b.write.includes(key) || b.read.includes(key)) || b.write.some((key) => a.read.includes(key))
}
/** Waiting owns no model slot. Independent tasks can pass a resource waiter. */
export class ExecutionScheduler {
  private active = new Map<string, Set<Resources>>()
  private waiting = new Set<() => void>()
  constructor(readonly capacity: number) {}
  changed() { for (const wake of [...this.waiting]) wake() }
  async acquire(scope: string, resources: Resources, signal: AbortSignal, validate: () => void) {
    for (;;) {
      signal.throwIfAborted(); validate()
      const active = this.active.get(scope) ?? new Set<Resources>()
      if (active.size < this.capacity && ![...active].some((entry) => conflicts(entry, resources))) {
        active.add(resources); this.active.set(scope, active)
        let released = false
        return () => {
          if (released) return
          released = true; active.delete(resources)
          if (!active.size) this.active.delete(scope)
          this.changed()
        }
      }
      await new Promise<void>((resolve) => {
        const wake = () => { this.waiting.delete(wake); signal.removeEventListener('abort', wake); resolve() }
        this.waiting.add(wake); signal.addEventListener('abort', wake, { once: true })
      })
    }
  }
}
export async function executionGroup<T extends { operationId: string; dependsOn: string[] }>(
  tasks: T[], signal: AbortSignal, validate: () => void, run: (task: T) => Promise<unknown>,
) {
  const ids = new Set(tasks.map((task) => task.operationId))
  if (ids.size !== tasks.length || tasks.some((task) => task.dependsOn.some((id) => !ids.has(id))))
    throw new CanvasError('并行任务 ID 重复或前置任务不存在')
  const visiting = new Set<string>(), visited = new Set<string>()
  const visit = (id: string) => {
    if (visiting.has(id)) throw new CanvasError('并行任务存在循环依赖')
    if (visited.has(id)) return
    visiting.add(id); tasks.find((task) => task.operationId === id)!.dependsOn.forEach(visit)
    visiting.delete(id); visited.add(id)
  }
  tasks.forEach((task) => visit(task.operationId))
  const results = new Map<string, { taskId: string; status: 'completed' | 'blocked' | 'interrupted'; value?: unknown; reason?: string }>()
  const pending = new Map<string, Promise<void>>()
  const start = (task: T): Promise<void> => {
    const existing = pending.get(task.operationId)
    if (existing) return existing
    const work = (async () => {
      for (const id of task.dependsOn) await start(tasks.find((entry) => entry.operationId === id)!)
      try {
        signal.throwIfAborted(); validate()
        if (task.dependsOn.some((id) => results.get(id)?.status !== 'completed'))
          throw new CanvasError('前置任务未完成；本任务未启动', 409, 'EXECUTION_DEPENDENCY')
        const value = await run(task)
        results.set(task.operationId, { taskId: task.operationId, status: (value as { completed?: boolean })?.completed === false ? 'blocked' : 'completed', value })
      } catch (error) {
        results.set(task.operationId, { taskId: task.operationId, status: signal.aborted ? 'interrupted' : 'blocked',
          reason: error instanceof CanvasError ? error.message : signal.aborted ? '执行已取消' : '执行未完成，请核对已保存回执' })
      }
    })()
    pending.set(task.operationId, work); return work
  }
  // Internal fan-out: Harness's exclusive parent tool never serializes child runs.
  await Promise.all(tasks.map(start))
  return { completed: [...results.values()].every((entry) => entry.status === 'completed'), tasks: tasks.map((task) => results.get(task.operationId)!) }
}
