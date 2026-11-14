import { createHash } from 'node:crypto'
import { version } from '../../../../package.json'
import c1 from './common/canvas-creative-source-reading/SKILL.md?raw'
import c2 from './common/canvas-model-aware-references/SKILL.md?raw'
import c3 from './common/canvas-generation-prompt-craft/SKILL.md?raw'
import c4 from './common/canvas-saved-artifact-handoff/SKILL.md?raw'
import m1 from './main/canvas-production-orchestration/SKILL.md?raw'
import m2 from './main/canvas-plan-review-and-handoff/SKILL.md?raw'
import m3 from './main/canvas-execution-manifest-planning/SKILL.md?raw'
import m4 from './main/canvas-voice-choice-and-audition/SKILL.md?raw'
import m5 from './main/canvas-task-failure-diagnosis/SKILL.md?raw'
import s1 from './story/canvas-narrative-structure/SKILL.md?raw'
import s2 from './story/canvas-long-source-adaptation/SKILL.md?raw'
import s3 from './story/canvas-script-writing/SKILL.md?raw'
import a1 from './assets/canvas-visual-asset-design/SKILL.md?raw'
import a2 from './assets/canvas-asset-consistency/SKILL.md?raw'
import a3 from './assets/canvas-asset-generation-spec/SKILL.md?raw'
import d1 from './shots/canvas-director-intent/SKILL.md?raw'
import d2 from './shots/canvas-shot-sequence-design/SKILL.md?raw'
import d3 from './shots/canvas-shot-composition/SKILL.md?raw'
import d4 from './shots/canvas-video-shot-prompt/SKILL.md?raw'
import au1 from './audio/canvas-shot-sound-design/SKILL.md?raw'
import au2 from './audio/canvas-dialogue-and-narration/SKILL.md?raw'
import au3 from './audio/canvas-tts-specification/SKILL.md?raw'
import v1 from './voice/canvas-fish-voice-discovery/SKILL.md?raw'
import v2 from './voice/canvas-fish-voice-evidence/SKILL.md?raw'
import r1 from './review/canvas-production-review/SKILL.md?raw'
import r2 from './review/canvas-reference-continuity-review/SKILL.md?raw'
import r3 from './review/canvas-sound-and-delivery-review/SKILL.md?raw'
import e1 from './executor/canvas-execution-procedure/SKILL.md?raw'
import e2 from './executor/canvas-execution-receipts/SKILL.md?raw'
import sourceReadingWorkbook from './common/canvas-creative-source-reading/references/source-reading-workbook.md?raw'
import referencePlanningWorkbook from './common/canvas-model-aware-references/references/reference-planning-workbook.md?raw'
import promptCraftWorkbook from './common/canvas-generation-prompt-craft/references/prompt-craft-workbook.md?raw'
import artifactHandoffWorkbook from './common/canvas-saved-artifact-handoff/references/artifact-handoff-workbook.md?raw'
import sequenceTemplate from './shots/canvas-shot-sequence-design/references/sequence-template.md?raw'
import directorWorkbook from './shots/canvas-director-intent/references/director-workbook.md?raw'
import blockingAndKeyframes from './shots/canvas-shot-composition/references/blocking-and-keyframes.md?raw'
import motionAndSoundSpec from './shots/canvas-video-shot-prompt/references/motion-and-sound-spec.md?raw'
import narrativeWorkbook from './story/canvas-narrative-structure/references/narrative-workbook.md?raw'
import adaptationWorkbook from './story/canvas-long-source-adaptation/references/adaptation-workbook.md?raw'
import scriptWorkbook from './story/canvas-script-writing/references/script-workbook.md?raw'
import soundCueWorkbook from './audio/canvas-shot-sound-design/references/sound-cue-workbook.md?raw'
import dialogueTiming from './audio/canvas-dialogue-and-narration/references/dialogue-timing.md?raw'
import ttsSpecChecklist from './audio/canvas-tts-specification/references/tts-spec-checklist.md?raw'
import reviewFindings from './review/canvas-production-review/references/review-findings.md?raw'
import continuityAudit from './review/canvas-reference-continuity-review/references/continuity-audit.md?raw'
import deliveryEvidence from './review/canvas-sound-and-delivery-review/references/delivery-evidence.md?raw'
import assetDesignWorkbook from './assets/canvas-visual-asset-design/references/asset-design-workbook.md?raw'
import assetContinuityWorkbook from './assets/canvas-asset-consistency/references/asset-continuity-workbook.md?raw'
import assetImageSpecWorkbook from './assets/canvas-asset-generation-spec/references/asset-image-spec-workbook.md?raw'
import orchestrationWorkbook from './main/canvas-production-orchestration/references/orchestration-workbook.md?raw'
import planAndHandoffWorkbook from './main/canvas-plan-review-and-handoff/references/plan-and-handoff-workbook.md?raw'
import executionManifestWorkbook from './main/canvas-execution-manifest-planning/references/execution-manifest-workbook.md?raw'
import voiceChoiceWorkbook from './main/canvas-voice-choice-and-audition/references/voice-choice-workbook.md?raw'
import taskDiagnosisWorkbook from './main/canvas-task-failure-diagnosis/references/task-diagnosis-workbook.md?raw'
import gpt from './models/canvas-gpt-image-prompt/SKILL.md?raw'
import banana from './models/canvas-banana-image-prompt/SKILL.md?raw'
import seedream from './models/canvas-seedream-image-prompt/SKILL.md?raw'
import seedance from './models/canvas-seedance-video-prompt/SKILL.md?raw'
import minimax from './models/canvas-minimax-video-prompt/SKILL.md?raw'
import wan from './models/canvas-wan-video-prompt/SKILL.md?raw'
import kling from './models/canvas-kling-video-prompt/SKILL.md?raw'
import gptWorkbook from './models/canvas-gpt-image-prompt/references/prompt-workbook.md?raw'
import bananaWorkbook from './models/canvas-banana-image-prompt/references/prompt-workbook.md?raw'
import seedreamWorkbook from './models/canvas-seedream-image-prompt/references/prompt-workbook.md?raw'
import seedanceWorkbook from './models/canvas-seedance-video-prompt/references/prompt-workbook.md?raw'
import minimaxWorkbook from './models/canvas-minimax-video-prompt/references/prompt-workbook.md?raw'
import wanWorkbook from './models/canvas-wan-video-prompt/references/prompt-workbook.md?raw'
import klingWorkbook from './models/canvas-kling-video-prompt/references/prompt-workbook.md?raw'

export const SKILL_VERSION = version
export const skillDigest = (text: string) => createHash('sha256').update(text).digest('hex')
export interface PackagedSkill {
  name: string; description: string; content: string; sha256: string
  resources: Record<string, { content: string; sha256: string }>
}
const RESOURCE_TEXTS: Record<string, Record<string, string>> = {
  'canvas-gpt-image-prompt': { 'references/prompt-workbook.md': gptWorkbook },
  'canvas-banana-image-prompt': { 'references/prompt-workbook.md': bananaWorkbook },
  'canvas-seedream-image-prompt': { 'references/prompt-workbook.md': seedreamWorkbook },
  'canvas-seedance-video-prompt': { 'references/prompt-workbook.md': seedanceWorkbook },
  'canvas-minimax-video-prompt': { 'references/prompt-workbook.md': minimaxWorkbook },
  'canvas-wan-video-prompt': { 'references/prompt-workbook.md': wanWorkbook },
  'canvas-kling-video-prompt': { 'references/prompt-workbook.md': klingWorkbook },
  'canvas-creative-source-reading': { 'references/source-reading-workbook.md': sourceReadingWorkbook },
  'canvas-model-aware-references': { 'references/reference-planning-workbook.md': referencePlanningWorkbook },
  'canvas-generation-prompt-craft': { 'references/prompt-craft-workbook.md': promptCraftWorkbook },
  'canvas-saved-artifact-handoff': { 'references/artifact-handoff-workbook.md': artifactHandoffWorkbook },
  'canvas-production-orchestration': { 'references/orchestration-workbook.md': orchestrationWorkbook },
  'canvas-plan-review-and-handoff': { 'references/plan-and-handoff-workbook.md': planAndHandoffWorkbook },
  'canvas-execution-manifest-planning': { 'references/execution-manifest-workbook.md': executionManifestWorkbook },
  'canvas-voice-choice-and-audition': { 'references/voice-choice-workbook.md': voiceChoiceWorkbook },
  'canvas-task-failure-diagnosis': { 'references/task-diagnosis-workbook.md': taskDiagnosisWorkbook },
  'canvas-director-intent': { 'references/director-workbook.md': directorWorkbook },
  'canvas-shot-sequence-design': { 'references/sequence-template.md': sequenceTemplate },
  'canvas-shot-composition': { 'references/blocking-and-keyframes.md': blockingAndKeyframes },
  'canvas-video-shot-prompt': { 'references/motion-and-sound-spec.md': motionAndSoundSpec },
  'canvas-narrative-structure': { 'references/narrative-workbook.md': narrativeWorkbook },
  'canvas-long-source-adaptation': { 'references/adaptation-workbook.md': adaptationWorkbook },
  'canvas-script-writing': { 'references/script-workbook.md': scriptWorkbook },
  'canvas-shot-sound-design': { 'references/sound-cue-workbook.md': soundCueWorkbook },
  'canvas-dialogue-and-narration': { 'references/dialogue-timing.md': dialogueTiming },
  'canvas-tts-specification': { 'references/tts-spec-checklist.md': ttsSpecChecklist },
  'canvas-production-review': { 'references/review-findings.md': reviewFindings },
  'canvas-reference-continuity-review': { 'references/continuity-audit.md': continuityAudit },
  'canvas-sound-and-delivery-review': { 'references/delivery-evidence.md': deliveryEvidence },
  'canvas-visual-asset-design': { 'references/asset-design-workbook.md': assetDesignWorkbook },
  'canvas-asset-consistency': { 'references/asset-continuity-workbook.md': assetContinuityWorkbook },
  'canvas-asset-generation-spec': { 'references/asset-image-spec-workbook.md': assetImageSpecWorkbook },
}
export const PACKAGED_SKILLS: ReadonlyMap<string, PackagedSkill> = new Map(
  [c1, c2, c3, c4, m1, m2, m3, m4, m5, s1, s2, s3, a1, a2, a3, d1, d2, d3, d4, au1, au2, au3, v1, v2, r1, r2, r3, e1, e2, gpt, banana, seedream, seedance, minimax, wan, kling].map((raw) => {
    const parsed = /^---\nname: ([a-z0-9-]+)\ndescription: ([^\n]+)\n---\n([\s\S]+)$/.exec(raw)
    if (!parsed) throw new Error('Invalid packaged Skill frontmatter')
    const [, name, description, content] = parsed
    const resources = Object.fromEntries(Object.entries(RESOURCE_TEXTS[name] ?? {}).map(([path, content]) =>
      [path, { content, sha256: skillDigest(content) }]))
    return [name, Object.freeze({ name, description, content, sha256: skillDigest(content), resources })]
  }),
)
