export interface CollaborationReference { id: string; title: string; version?: number }
export interface CollaborationArtifact extends CollaborationReference {
  kind: string; status: 'draft' | 'approved' | 'rejected'; needsReview: boolean; relativePath: string
}
export interface CollaborationEvent {
  seq: number; time: number; actor: 'host' | 'child' | 'main'
  kind: 'dispatch' | 'started' | 'message' | 'tool-call' | 'tool-result' | 'receipt' | 'returned' | 'next' | 'interrupted'
  text: string; callId?: string; tool?: string; data?: unknown
}
/** Ephemeral public summary for the live view; never persisted into the journal task. */
export type CollaborationActivity = Pick<CollaborationEvent, 'seq' | 'time' | 'actor' | 'kind' | 'text' | 'tool'>
export interface CollaborationTask {
  id: string; rootId: string; projectId: string; canvasId?: string; parentCallId: string; childId: string
  nativeRunId?: string; role: string; title: string; task: string
  createdAt: number; updatedAt: number; revision: number
  state: 'dispatched' | 'running' | 'completed' | 'blocked' | 'interrupted'
  main: 'pending' | 'responded'
  sourceRefs: CollaborationReference[]; inputRefs: CollaborationReference[]
  nodeIds: string[]; artifactRefs: CollaborationArtifact[]
  commandCount: number; receiptIds: string[]; progress?: string
  eventCount: number; droppedEvents: number
  activity?: CollaborationActivity
}
export interface CollaborationPage {
  revision: number; tasks: CollaborationTask[]; next: number | null; total: number; active: number; error?: string
  /** Bounded current activity outside the newest history page. */
  activeTasks?: CollaborationTask[]
}
export interface CollaborationDetail { task: CollaborationTask; events: CollaborationEvent[]; next: number | null }
export const collaborationRole: Record<string, string> = {
  story: '编剧', assets: '视觉资产', shots: '分镜', audio: '音频', review: '审查', voice: '音色查找', executor: '画布执行',
}
export function agentDisplayName(name: string): string {
  if (name === 'lead' || name === 'main') return '主智能体'
  return Object.hasOwn(collaborationRole, name) ? collaborationRole[name] : name
}
export function collaborationStatus(task: CollaborationTask) {
  return ({ dispatched: '已派发', running: '执行中', completed: '已回传', blocked: '受阻', interrupted: '已中断' })[task.state]
}
