import { useEffect } from 'react'
import { useUpdateNodeInternals } from '@xyflow/react'
import { TRACKED_STATUSES, TaskStatusLabels, type CanvasNode } from '../shared/contracts'
import type { TaskSummary } from '../shared/v2'
import { CanvasHandle } from './CanvasHandle'
import { NodeTitle } from './NodeTitle'
import { TtsIcon } from './TtsIcon'

export function TtsNode({ node, task, selected, onRename, onSize }: {
  node: CanvasNode; task?: TaskSummary; selected: boolean
  onRename: (id: string, title: string) => void; onSize: (id: string, width: number, height: number) => void
}) {
  const update = useUpdateNodeInternals()
  useEffect(() => { onSize(node.id, 320, 180); update(node.id) }, [node.id, onSize, update])
  return <article className={`dc-node dc-generation-node dc-tts-node ${selected ? 'selected' : ''}`}>
    <NodeTitle node={node} onRename={onRename} />
    <div className="dc-generation-empty"><TtsIcon size={44} /></div>
    {task && TRACKED_STATUSES.has(task.status) && <div className="dc-task-overlay"><span className="dc-spinner" /><span>{TaskStatusLabels[task.status]}</span></div>}
    <CanvasHandle type="source" disabled />
  </article>
}
