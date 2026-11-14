import { z } from 'zod'
import { CreativeDraftSchema, SpecialistRoleSchema } from './agent'

export const SourceRangeSchema = z.object({
  sourceId: z.string().uuid(), start: z.number().int().nonnegative(), end: z.number().int().positive(),
}).strict().refine((range) => range.end > range.start, '原文范围必须非空')
export const CreativeTaskSchema = z.object({
  operationId: z.string().uuid(), role: SpecialistRoleSchema, task: z.string().min(1).max(24000),
  sourceIds: z.array(z.string().uuid()).max(100).default([]),
  artifactIds: z.array(z.string().uuid()).max(100).default([]),
  nodeIds: z.array(z.string().uuid()).max(100).default([]),
  assetIds: z.array(z.string().uuid()).max(100).default([]),
  skillNames: z.array(z.string().regex(/^canvas-[a-z0-9-]+$/)).max(12).optional(),
  modelKinds: z.array(z.enum(['image', 'video'])).max(2).optional(),
}).strict()
export const ArtifactInputSchema = z.object({
  draft: CreativeDraftSchema, sources: z.array(SourceRangeSchema).max(100).default([]),
}).strict()
export const SavedArtifactResultSchema = z.object({
  artifactId: z.string().uuid(), summary: z.string().max(2000).optional(),
}).strict()
// Native structured output requires an object root; older activations returned a flat draft.
export const SpecialistResultSchema = z.union([
  z.object({ result: z.union([SavedArtifactResultSchema, CreativeDraftSchema]) }).strict(),
  CreativeDraftSchema,
])
export const CreativeSourceSchema = z.object({
  id: z.string().uuid(), projectId: z.string(), origin: z.string(), name: z.string(),
  version: z.number().int().positive(), sha256: z.string(), bytes: z.number(), length: z.number(),
  encoding: z.string(), createdAt: z.number(),
  sections: z.array(z.object({ title: z.string(), start: z.number(), end: z.number() })),
})
export const CreativeArtifactSchema = ArtifactInputSchema.extend({
  id: z.string().uuid(), projectId: z.string(), taskId: z.string().uuid(), version: z.number(),
  author: z.string(), createdAt: z.number(), status: z.enum(['draft', 'approved', 'rejected']),
  decision: z.string().optional(),
  file: z.object({ path: z.string(), relativePath: z.string(), bytes: z.number(), sha256: z.string() }),
})
export const CreativeRunSchema = z.object({
  id: z.string().uuid(), projectId: z.string(), role: z.union([SpecialistRoleSchema, z.literal('executor')]),
  inputHash: z.string(), task: z.string(), sourceIds: z.array(z.string()), artifactIds: z.array(z.string()),
  state: z.enum(['running', 'completed', 'blocked', 'interrupted']),
  createdAt: z.number(), updatedAt: z.number(), artifactOutputIds: z.array(z.string()),
  progress: z.string(), result: z.unknown().optional(),
  readRanges: z.array(SourceRangeSchema).default([]),
})
export type CreativeSource = z.infer<typeof CreativeSourceSchema>
export type CreativeArtifact = z.infer<typeof CreativeArtifactSchema>
export type CreativeRun = z.infer<typeof CreativeRunSchema>
