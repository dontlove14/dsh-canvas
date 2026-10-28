import { z } from 'zod'
import { CanvasNodeSchema, CanvasEdgeSchema, CanvasGraphSchema, TaskSchema, type WorkspaceState, type Task, type TaskStatus } from './contracts'

export const V2_ROOT = 'api/canvas/v2'
export const NameSchema = z.string().transform((v) => v.trim().normalize('NFC')).pipe(z.string().min(1).max(160))
export const HashSchema = z.string().regex(/^[a-f0-9]{64}$/)
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
}
export async function browserHash(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)))
  return [...new Uint8Array(digest)].map((v) => v.toString(16).padStart(2, '0')).join('')
}
export const MutationSchema = z.object({
  mutationId: z.string().uuid(), baseRevision: z.number().int().nonnegative(),
  nodes: z.array(z.object({ value: CanvasNodeSchema, hash: HashSchema }).strict()).max(10000),
  edges: z.array(z.object({ value: CanvasEdgeSchema, hash: HashSchema }).strict()).max(20000),
  deleteNodes: z.array(z.string().uuid()), deleteEdges: z.array(z.string().uuid()),
  viewport: z.object({ value: CanvasGraphSchema.shape.viewport, hash: HashSchema }).strict().optional(),
}).strict()
export type GraphMutation = z.infer<typeof MutationSchema>
export const TaskSummarySchema = TaskSchema.omit({ snapshot: true, error: true, providerTaskId: true }).extend({ requestId: z.string().uuid().optional() })
export type TaskSummary = z.infer<typeof TaskSummarySchema>
export interface CanvasSnapshot extends Omit<WorkspaceState, 'tasks'> {
  tasks: TaskSummary[]
  commitHash: string
  hashes: { nodes: Record<string, string>; edges: Record<string, string>; viewport: string }
}
export interface Folder { id: string; name: string; revision: number; hash: string }
export interface CanvasChoice { id: string; name: string; folderId: string | null; revision: number; hash: string; moving: boolean; moveError?: string }
export interface Catalog { folders: Folder[]; canvases: CanvasChoice[] }
export const TaskSearchQuerySchema = z.object({
  taskId: z.string().uuid().transform((value) => value.toLowerCase()).optional(),
  folderName: z.string().trim().normalize('NFC').min(1).max(160).optional(),
  canvasName: z.string().trim().normalize('NFC').min(1).max(160).optional(),
  type: z.enum(['image', 'video', 'tts', 'import']).optional(),
  startTime: z.number().int().min(0).max(8640000000000000).optional(),
  endTime: z.number().int().min(0).max(8640000000000000).optional(),
  page: z.number().int().min(1).max(100000000).default(1),
  pageSize: z.union([z.literal(10), z.literal(20), z.literal(50), z.literal(100)]).default(20),
  upperBound: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
}).strict().refine((value) => value.startTime === undefined || value.endTime === undefined || value.startTime <= value.endTime, {
  message: '开始时间不能晚于结束时间', path: ['endTime'],
})
export type TaskSearchQuery = z.infer<typeof TaskSearchQuerySchema>
export function parseTaskSearchParams(params: URLSearchParams): TaskSearchQuery {
  const values: Record<string, string | number> = Object.create(null)
  const numeric = new Set(['page', 'pageSize', 'startTime', 'endTime', 'upperBound'])
  for (const [key, value] of params) {
    if (key in values) throw new Error('查询条件不能重复')
    if (numeric.has(key)) {
      if (!/^\d+$/.test(value)) throw new Error('页码、数量和时间必须是非负整数')
      values[key] = Number(value)
    } else values[key] = value
  }
  return TaskSearchQuerySchema.parse(values)
}
export interface TaskRow {
  id: string; canvasId: string; nodeId: string; folderName: string; canvasName: string; nodeName: string
  type: NonNullable<TaskSearchQuery['type']>; status: TaskStatus; createdAt: number; updatedAt: number
}
export interface TaskPage { items: TaskRow[]; total: number; page: number; pageSize: number; upperBound: number }
export interface TaskDetail {
  task: Task | null
  kind: 'generation' | 'import'
  phase: string
  externalTaskId: string | null
  externalCompletedAt: number | null
  successAt: number | null
  failureStage: string | null
  failureCode: string | null
  failureMessage: string | null
  attempts: Array<{ step: string; issued_at: number; finished_at: number | null; outcome: string | null; error: string | null }>
}
