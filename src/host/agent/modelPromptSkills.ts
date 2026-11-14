import type { AgentRole } from '../../shared/agent'
import type { ModelPromptFamily } from '../../shared/modelCatalog'
import type { GenerationModelKind, PlanningModel } from './modelSelection'
import { taskSkills, capabilities, IMAGE_PROMPT_SKILLS, VIDEO_PROMPT_SKILLS } from './capabilities'

export const MODEL_PROMPT_SKILLS: Record<ModelPromptFamily, string> = {
  'gpt-image': 'canvas-gpt-image-prompt', banana: 'canvas-banana-image-prompt', seedream: 'canvas-seedream-image-prompt',
  seedance: 'canvas-seedance-video-prompt', minimax: 'canvas-minimax-video-prompt',
  wan: 'canvas-wan-video-prompt', kling: 'canvas-kling-video-prompt',
}
/** Defaults cannot be evaded by omitting skillNames/modelKinds. Concepts stay model independent. */
export function planningKinds(role: AgentRole, chosen?: string[], requested: GenerationModelKind[] = []) {
  const methods = taskSkills(role, chosen)
  return [...new Set<GenerationModelKind>([...requested,
    ...(role === 'shots' ? ['video' as const] : []),
    ...(methods.some((name) => IMAGE_PROMPT_SKILLS.includes(name) || name === 'canvas-asset-generation-spec' ||
      role === 'assets' && name === 'canvas-generation-prompt-craft') ? ['image' as const] : []),
    ...(methods.some((name) => VIDEO_PROMPT_SKILLS.includes(name) || name === 'canvas-video-shot-prompt') ? ['video' as const] : []),
  ])]
}
export function matchingPromptSkills(role: AgentRole, plans: readonly PlanningModel[]) {
  if (!['main', 'assets', 'shots', 'review'].includes(role)) return []
  return [...new Set(plans.flatMap(({ model }) => model.promptFamily ? [MODEL_PROMPT_SKILLS[model.promptFamily]] : []))]
    .filter((name) => capabilities(role).skills.includes(name))
}
