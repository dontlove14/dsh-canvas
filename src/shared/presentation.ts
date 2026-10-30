import { z } from 'zod'

const Point = z.object({ x: z.number().finite(), y: z.number().finite() }).strict()
export const PresentationIdentitySchema = z.object({
  sessionId: z.string().min(1).max(200), canvasId: z.string().min(1).max(200),
  epoch: z.number().int().nonnegative(),
})
export const PresentationIntentSchema = PresentationIdentitySchema.extend({
  id: z.string().min(1).max(240), action: z.enum(['open', 'create', 'update', 'connect', 'generate', 'import']),
  graphRevision: z.number().int().nonnegative(), nodeIds: z.array(z.string()).max(100),
  taskId: z.string().optional(), createdAt: z.number(),
}).strict()
export type PresentationIntent = z.infer<typeof PresentationIntentSchema>
export const ViewReportSchema = PresentationIdentitySchema.extend({
  viewId: z.string().min(1).max(200), sequence: z.number().int().nonnegative(),
  visible: z.boolean(), following: z.boolean(),
  center: Point.optional(), width: z.number().positive().max(20000).optional(),
  height: z.number().positive().max(20000).optional(), zoom: z.number().positive().max(10).optional(),
  sizes: z.record(z.string(), z.object({ width: z.number().positive().max(10000), height: z.number().positive().max(10000) }).strict()).optional(),
}).strict()
export type ViewReport = z.infer<typeof ViewReportSchema>
export const PresentationAckSchema = PresentationIdentitySchema.extend({
  viewId: z.string().min(1).max(200), presentationId: z.string().min(1).max(240),
  status: z.enum(['presented', 'paused', 'deferred', 'failed']),
  graphRevision: z.number().int().nonnegative(), reason: z.string().max(300).optional(),
}).strict()
export type PresentationAck = z.infer<typeof PresentationAckSchema>
export const PresenceSchema = z.object({
  sessionId: z.string().min(1).max(200), viewId: z.string().min(1).max(200),
  visible: z.boolean(),
}).strict()
export interface PresentationState {
  intent: PresentationIntent | null
}
export interface PresentationResult { id: string; status: PresentationAck['status']; reason?: string }
export const AutoPlacementSchema = z.object({
  anchorNodeId: z.string().optional(), group: z.enum(['assets', 'shots', 'audio']).default('assets'),
}).strict()
export type AutoPlacement = z.infer<typeof AutoPlacementSchema>
