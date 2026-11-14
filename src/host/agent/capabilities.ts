import type { AgentRole } from '../../shared/agent'
import { CanvasError } from '../store'

const C1 = 'canvas-creative-source-reading', C2 = 'canvas-model-aware-references'
const C3 = 'canvas-generation-prompt-craft', C4 = 'canvas-saved-artifact-handoff'
export const IMAGE_PROMPT_SKILLS = ['canvas-gpt-image-prompt', 'canvas-banana-image-prompt', 'canvas-seedream-image-prompt']
export const VIDEO_PROMPT_SKILLS = ['canvas-seedance-video-prompt', 'canvas-minimax-video-prompt', 'canvas-wan-video-prompt', 'canvas-kling-video-prompt']
const sharedTools = ['canvas_inspect', 'canvas_method', 'canvas_skill', 'canvas_skill_resource', 'canvas_view_image', 'canvas_task',
  'creative_project', 'creative_source_index', 'creative_source_read', 'creative_artifact_read', 'creative_progress']
const specialistTools = [...sharedTools, 'creative_artifact_save']
/** ADR-0104: additions must declare role, methods and real tool authority together. */
export const AGENT_CAPABILITIES: Record<AgentRole, { skills: string[]; required: string[]; tools: string[] }> = {
  main: {
    skills: [C1, C2, C3, C4, ...IMAGE_PROMPT_SKILLS, ...VIDEO_PROMPT_SKILLS, 'canvas-production-orchestration', 'canvas-plan-review-and-handoff', 'canvas-execution-manifest-planning', 'canvas-voice-choice-and-audition', 'canvas-task-failure-diagnosis'],
    required: [],
    tools: [...sharedTools, 'canvas_open', 'canvas_read_reference', 'canvas_select_model', 'canvas_review_plan', 'canvas_specialist',
      'canvas_execute', 'canvas_execute_parallel', 'creative_artifact_decide', 'canvas_handoff_generation', 'canvas_show_audio',
      'canvas_confirm_video_mute', 'canvas_draft', 'canvas_document', 'canvas_export_media', 'creative_source_import', 'ask_user_question', 'canvas_task_diagnose'],
  },
  story: { skills: [C1, C2, C4, 'canvas-narrative-structure', 'canvas-long-source-adaptation', 'canvas-script-writing'],
    required: ['canvas-narrative-structure', C4], tools: [...specialistTools, 'structured_output'] },
  assets: { skills: [C1, C2, C3, C4, ...IMAGE_PROMPT_SKILLS, 'canvas-visual-asset-design', 'canvas-asset-consistency', 'canvas-asset-generation-spec'],
    required: ['canvas-visual-asset-design', C4], tools: [...specialistTools, 'structured_output'] },
  shots: { skills: [C1, C2, C3, C4, ...VIDEO_PROMPT_SKILLS, 'canvas-director-intent', 'canvas-shot-sequence-design', 'canvas-shot-composition', 'canvas-video-shot-prompt'],
    required: ['canvas-shot-composition', C4], tools: [...specialistTools, 'structured_output'] },
  audio: { skills: [C1, C2, C4, 'canvas-shot-sound-design', 'canvas-dialogue-and-narration', 'canvas-tts-specification'],
    required: ['canvas-shot-sound-design', C4], tools: [...specialistTools, 'structured_output'] },
  voice: { skills: [C1, C4, 'canvas-fish-voice-discovery', 'canvas-fish-voice-evidence'],
    required: ['canvas-fish-voice-discovery', 'canvas-fish-voice-evidence', C4], tools: [...specialistTools, 'fish_voice_search', 'fish_voice_read', 'structured_output'] },
  review: { skills: [C1, C2, C4, ...IMAGE_PROMPT_SKILLS, ...VIDEO_PROMPT_SKILLS, 'canvas-production-review', 'canvas-reference-continuity-review', 'canvas-sound-and-delivery-review'],
    required: ['canvas-production-review', C4], tools: [...specialistTools, 'structured_output'] },
  executor: { skills: [C4, 'canvas-execution-procedure', 'canvas-execution-receipts'],
    required: ['canvas-execution-procedure', 'canvas-execution-receipts', C4],
    tools: ['canvas_inspect', 'canvas_method', 'canvas_skill', 'canvas_skill_resource', 'canvas_view_image', 'canvas_task',
      'creative_artifact_read', 'canvas_create_node', 'canvas_update_node', 'canvas_connect', 'canvas_import_attachment', 'canvas_generate', 'structured_output'] },
}
export function capabilities(role: AgentRole) {
  const policy = AGENT_CAPABILITIES[role]
  if (!policy) throw new CanvasError('Agent 未声明角色、Skill 与权限策略', 403, 'AGENT_CAPABILITY_MISSING')
  return policy
}
export function taskSkills(role: AgentRole, chosen?: string[]) {
  const policy = capabilities(role)
  if (chosen?.some((name) => !policy.skills.includes(name)))
    throw new CanvasError('Skill 超出该角色的方法范围', 403, 'AGENT_SKILL_FORBIDDEN')
  return [...new Set([...policy.required, ...chosen ?? []])]
}
