import { collaborationRole, type CollaborationTask, type CollaborationPage } from '../shared/collaboration'

export const COLLABORATION_GRAPH_LIMIT = 8
export const RETURN_FLOW_MS = 8000
export const workingTask = (task: CollaborationTask) => task.state === 'running' || task.state === 'dispatched'
const roleName = (task: CollaborationTask) => collaborationRole[task.role] ?? '子智能体'

export function collaborationMessage(page: CollaborationPage) {
  const latest = [...page.tasks].sort((a, b) => b.updatedAt - a.updatedAt || b.revision - a.revision)[0]
  if (!latest) return page.active > 0 ? '协作执行中，正在读取任务记录' : '暂无协作记录'
  const name = roleName(latest), activity = latest.activity
  if (activity?.actor === 'main' && activity.kind === 'dispatch') return `主智能体 → ${name}：${latest.title}`
  if (activity?.actor === 'main' && latest.main === 'responded') return `主智能体已接续 · ${latest.title}${activity.kind === 'message' ? `：${activity.text}` : ''}`
  if (latest.state === 'blocked') return `${name}受阻 · ${latest.title}${activity?.kind === 'returned' ? `：${activity.text}` : ''}`
  if (latest.state === 'interrupted') return `${name}已中断 · ${latest.title}`
  if (latest.state === 'completed') return `${name}已回传 · ${latest.title} · ${latest.main === 'pending' ? '待主智能体接续' : '主智能体已接续'}`
  if (activity?.kind === 'tool-call') return `${name}正在${toolAction(activity.tool)} · ${latest.title}`
  if (activity?.kind === 'receipt') return `宿主已确认${name}的实际操作回执 · ${latest.title}`
  if (activity?.kind === 'tool-result') return `${name} · ${activity.text} · ${latest.title}`
  if (activity?.actor === 'child' && activity.kind === 'message') return `${name}报告：${activity.text}`
  if (latest.progress) return `${name}报告：${latest.progress}`
  return latest.state === 'dispatched' ? `主智能体 → ${name}：${latest.title}` : `${name}正在处理 · ${latest.title}`
}
function toolAction(tool?: string) {
  if (tool === 'creative_source_read') return '阅读资料'
  if (tool === 'creative_artifact_save') return '保存成果'
  if (tool === 'fish_voice_read') return '核验音色'
  if (tool === 'fish_voice_search') return '查找音色'
  if (tool?.startsWith('canvas_')) return '处理画布操作'
  return '处理工具调用'
}
export interface CollaborationDot {
  id: string; label: string; x: number; y: number; working: boolean; status: string; taskId?: string
}
export interface CollaborationLink {
  taskId: string; source: string; target: string; path: string; direction: 'dispatch' | 'return'; flowing: boolean
}
/** A bounded hub of real session identities. Role names are labels, never graph keys. */
export function collaborationGraph(page: CollaborationPage, rootId: string, mainRunning?: boolean, selectedTask?: string, now = Date.now()) {
  const current = page.tasks.filter((task) => task.rootId === rootId && task.childId && task.childId !== rootId)
  const priority = [...current].sort((a, b) => Number(workingTask(b)) - Number(workingTask(a)) ||
    Number(b.id === selectedTask) - Number(a.id === selectedTask) || b.createdAt - a.createdAt)
  const children = new Map<string, CollaborationTask>()
  for (const task of priority) if (!children.has(task.childId)) children.set(task.childId, task)
  const visible = [...children.values()].slice(0, COLLABORATION_GRAPH_LIMIT)
    .sort((a, b) => a.createdAt - b.createdAt || a.childId.localeCompare(b.childId))
  const root: CollaborationDot = { id: rootId, label: '主智能体', x: 240, y: 165, working: mainRunning === true,
    status: mainRunning === true ? '处理中' : mainRunning === false ? '空闲' : '状态未知' }
  const dots: CollaborationDot[] = [root, ...visible.map((task, index) => {
    const angle = -Math.PI / 2 + (index / visible.length) * Math.PI * 2
    return { id: task.childId, label: roleName(task), x: root.x + Math.cos(angle) * 184, y: root.y + Math.sin(angle) * 112,
      working: workingTask(task), taskId: task.id,
      status: ({ dispatched: '已派发', running: '处理中', completed: '已回传', blocked: '受阻', interrupted: '已中断' })[task.state] }
  })]
  const links: CollaborationLink[] = visible.map((task, index) => {
    const child = dots[index + 1]
    const returning = !workingTask(task) && task.activity?.kind === 'returned' && task.activity.actor === 'host' &&
      task.main === 'pending' && now >= task.activity.time && now - task.activity.time < RETURN_FLOW_MS
    const [source, target] = returning ? [child, root] : [root, child]
    const dx = target.x - source.x, dy = target.y - source.y, length = Math.hypot(dx, dy)
    const sx = source.x + dx / length * 13, sy = source.y + dy / length * 13
    const tx = target.x - dx / length * 13, ty = target.y - dy / length * 13
    const bend = 24, cx = (sx + tx) / 2 - dy / length * bend, cy = (sy + ty) / 2 + dx / length * bend
    return { taskId: task.id, source: source.id, target: target.id, path: `M ${sx} ${sy} Q ${cx} ${cy} ${tx} ${ty}`,
      direction: returning ? 'return' : 'dispatch', flowing: workingTask(task) || returning }
  })
  const knownActive = current.filter(workingTask).length
  return { dots, links, omitted: children.size - visible.length, missingActive: Math.max(0, page.active - knownActive) }
}
