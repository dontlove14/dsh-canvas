import { useEffect } from 'react'
import { useUpdateNodeInternals } from '@xyflow/react'
import { type CanvasNode } from '../shared/contracts'
import type { TaskSummary } from '../shared/v2'
import { CanvasHandle } from './CanvasHandle'
import { NodeTitle } from './NodeTitle'
import { TtsIcon } from './TtsIcon'
import { NodeLoading } from './NodeLoading'

export function TtsNode({ node, task, selected, onRename, onSize }: {
  node: CanvasNode; task?: TaskSummary; selected: boolean
  onRename: (id: string, title: string) => void; onSize: (id: string, width: number, height: number) => void
}) {
  const update = useUpdateNodeInternals()
  useEffect(() => { onSize(node.id, 320, 180); update(node.id) }, [node.id, onSize, update])
  return <article className={`dc-node dc-generation-node dc-tts-node ${selected ? 'selected' : ''}`}>
    <NodeTitle node={node} onRename={onRename} />
    <div className="dc-generation-empty"><TtsIcon size={44} /></div>
    <NodeLoading task={task} title={node.title} />
    <CanvasHandle type="source" disabled />
  </article>
}
