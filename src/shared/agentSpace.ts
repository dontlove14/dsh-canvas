/** Build-owned assets, independent of canvas media and task identities. */
export interface AgentSpaceFile { file: string; sha256: string; bytes: number; mime: string }
export interface AgentSpaceAction {
  code: string; role: string; action: string; video: string; poster: string
  loop: boolean; duration: number; size: number[]; foot: number[]; bodyHeight: number
  hand?: { samples: number[][]; contactAt: number }
}
export interface AgentSpaceRole { id: string; name: string; color: string; heightScale: number; idleActionCode: string }
export interface AgentSpaceManifest {
  version: string; files: AgentSpaceFile[]; actions: AgentSpaceAction[]; roles: AgentSpaceRole[]
  playbackPolicy: { idleRate: number; defaultRate: number; actionOverrides: Record<string, number> }
}
export const AGENT_SPACE_PRESET = 'canvas-creator'
export const agentSpaceRole: Record<string, string> = {
  main: 'main', story: 'writer', assets: 'visual', shots: 'storyboard', audio: 'audio',
  review: 'review', voice: 'voice', executor: 'executor',
}
export function agentSpaceRate(manifest: AgentSpaceManifest, action: AgentSpaceAction) {
  return manifest.playbackPolicy.actionOverrides[action.code] ??
    (action.action.startsWith('idle') ? manifest.playbackPolicy.idleRate : manifest.playbackPolicy.defaultRate)
}
/** Prefer the delivered frontal clip; temporary substitutions never claim to be frontal. */
export function agentSpaceAction(manifest: AgentSpaceManifest, role: string, action: string) {
  return manifest.actions.find((entry) => entry.role === role && entry.action === action) ??
    manifest.actions.find((entry) => entry.role === role && entry.action === action.replace('-front', ''))!
}
