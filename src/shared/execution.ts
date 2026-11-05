import { z } from 'zod'
import { CanvasNodeSchema, IdSchema } from './contracts'
import { AutoPlacementSchema } from './presentation'
import { StepNote } from './agent'

const operation = {
  operationId: IdSchema, revision: z.number().int().nonnegative(),
  canvasId: z.string().uuid().optional(), referenceId: z.string().regex(/^[a-f0-9]{64}$/).optional(), ...StepNote,
}
const references = z.array(z.object({ source: IdSchema, assetId: IdSchema }).strict()).max(100).optional()
export const ReferenceExclusionsSchema = z.array(z.object({
  assetId: IdSchema, reason: z.string().trim().min(1).max(500),
}).strict()).max(100)
/** One schema owns both the callable tools and the root's exact delegation manifest. */
export const EXECUTION_SCHEMAS = {
  canvas_create_node: z.object({
    ...operation, kind: z.enum(['image-generation', 'video-generation', 'tts-generation']),
    title: z.string().min(1).max(160), prompt: z.string().max(32000), modelId: IdSchema.optional(),
    position: z.object({ x: z.number().finite(), y: z.number().finite() }).strict().optional(),
    placement: AutoPlacementSchema.optional(), params: CanvasNodeSchema.shape.params.removeDefault().optional(), references,
    referenceExclusions: ReferenceExclusionsSchema.optional(),
  }).strict(),
  canvas_update_node: z.object({
    ...operation, nodeId: IdSchema, patch: z.object({
      title: CanvasNodeSchema.shape.title.optional(), prompt: CanvasNodeSchema.shape.prompt.removeDefault().optional(),
      params: CanvasNodeSchema.shape.params.removeDefault().optional(), modelId: CanvasNodeSchema.shape.modelId.removeDefault().optional(),
      position: CanvasNodeSchema.shape.position.optional(), selectedResultId: CanvasNodeSchema.shape.selectedResultId.removeDefault().optional(),
    }).strict(), references, referenceExclusions: ReferenceExclusionsSchema.optional(),
  }).strict(),
  canvas_connect: z.object({ ...operation, source: IdSchema, target: IdSchema, assetId: IdSchema }).strict(),
  canvas_import_attachment: z.object({
    ...operation, attachmentId: z.string().min(1).max(200), kind: z.enum(['image', 'video', 'audio']),
    purpose: z.string().trim().min(1).max(500),
  }).strict(),
  canvas_generate: z.object({ ...operation, nodeId: IdSchema }).strict(),
}
export const ExecutionCommandSchema = z.discriminatedUnion('tool', [
  z.object({ tool: z.literal('canvas_create_node'), input: EXECUTION_SCHEMAS.canvas_create_node }).strict(),
  z.object({ tool: z.literal('canvas_update_node'), input: EXECUTION_SCHEMAS.canvas_update_node }).strict(),
  z.object({ tool: z.literal('canvas_connect'), input: EXECUTION_SCHEMAS.canvas_connect }).strict(),
  z.object({ tool: z.literal('canvas_import_attachment'), input: EXECUTION_SCHEMAS.canvas_import_attachment }).strict(),
  z.object({ tool: z.literal('canvas_generate'), input: EXECUTION_SCHEMAS.canvas_generate }).strict(),
])
export type ExecutionCommand = z.infer<typeof ExecutionCommandSchema>
/** Narration and the sequential CAS revision may change; creative intent may not. */
export function executionIntent(input: unknown) {
  const value = structuredClone(input) as Record<string, unknown>
  delete value.note; delete value.revision
  return value
}
