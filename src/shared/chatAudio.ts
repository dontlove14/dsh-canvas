import { z } from 'zod'
import { AssetSchema, IdSchema, WorkspaceIdSchema, TaskStatusSchema } from './contracts'

export const ChatAudioHandleSchema = z.object({
  canvasId: WorkspaceIdSchema, taskId: IdSchema.optional(), assetId: IdSchema.optional(),
  title: z.string().min(1).max(160),
}).strict().refine((value) => !!value.taskId || !!value.assetId, '需要实际任务或音频素材 ID')
export type ChatAudioHandle = z.infer<typeof ChatAudioHandleSchema>
export const ChatAudioResultSchema = z.object({
  status: TaskStatusSchema, assets: z.array(AssetSchema).max(10), error: z.string().max(1000).optional(),
  text: z.string().max(32000).optional(), voiceId: z.string().max(512).optional(),
}).strict()
export type ChatAudioResult = z.infer<typeof ChatAudioResultSchema>
