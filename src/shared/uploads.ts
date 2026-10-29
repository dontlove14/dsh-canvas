import { z } from 'zod'
import { IdSchema } from './contracts'

export const UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024
export const UPLOAD_CONCURRENCY = 5
export const UploadStartSchema = z.object({
  requestId: IdSchema, filename: z.string().min(1).max(255), kind: z.enum(['image', 'video', 'audio']),
  position: z.object({ x: z.number().finite(), y: z.number().finite() }).strict(),
  size: z.number().int().positive().max(1024 * 1024 * 1024).optional(),
}).strict()
export type UploadStart = z.infer<typeof UploadStartSchema>
export const UploadSessionSchema = z.object({ id: IdSchema, nodeId: IdSchema }).strict()
export const UploadResultSchema = z.object({ taskId: IdSchema, nodeId: IdSchema }).strict()
export const UploadStatusSchema = z.object({
  id: IdSchema, nodeId: IdSchema, size: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(), chunkBytes: z.number().int().positive().max(UPLOAD_CHUNK_BYTES),
  state: z.enum(['receiving', 'received', 'failed']), taskId: IdSchema.optional(),
}).strict()
export interface UploadResult { taskId: string; nodeId: string }
export interface UploadStatus {
  id: string; nodeId: string; size: number; offset: number; chunkBytes: number
  state: 'receiving' | 'received' | 'failed'; taskId?: string
}
