import { z } from 'zod'

export const CANVAS_PRESET = 'canvas-creator'
export const AGENT_FOLDER = 'Agent 创作'
export const StepNote = { note: z.string().trim().min(1).max(180).optional() }
export const DocumentSchema = z.object({
  title: z.string().trim().min(1).max(160), content: z.string().min(1).max(32000),
  category: z.enum(['方案', '简报', '资产', '分镜', '镜头', '音频', '审查', '其他']).default('其他'),
}).strict()
export const SpecialistRoleSchema = z.enum(['story', 'assets', 'shots', 'audio', 'review'])
/** Registered for native spawn resolution, omitted from the user's preset chooser. */
export const INTERNAL_CANVAS_PRESETS: readonly string[] = SpecialistRoleSchema.options.map((role) => `canvas-${role}`)
export type SpecialistRole = z.infer<typeof SpecialistRoleSchema>
export interface CanvasControl {
  canvasId: string; sessionId: string | null; mode: 'manual' | 'agent'; epoch: number
  updatedAt: number; reason?: string
}
export const CreativeDraftSchema = z.object({
  kind: z.enum(['brief', 'asset-spec', 'storyboard', 'shot-plan', 'audio-plan', 'review']),
  title: z.string().min(1).max(160),
  content: z.string().min(1).max(32000),
  dependencies: z.array(z.string().uuid()).max(100).default([]),
  assetIds: z.array(z.string().uuid()).max(100).default([]),
}).strict()
export type CreativeDraft = z.infer<typeof CreativeDraftSchema> & {
  id: string; canvasId: string; version: number; author: string; createdAt: number
  baseRevision: number; epoch: number
}
export const AgentControlCommandSchema = z.object({
  action: z.enum(['delegate', 'takeover']),
  sessionId: z.string().min(1).max(200).optional(),
  revision: z.number().int().nonnegative().optional(),
}).strict()
export interface AgentSessionState {
  preset: boolean; canvas: CanvasControl | null
}
