import { memo, useEffect } from 'react'
import { NodeToolbar, Position, useUpdateNodeInternals, type Node, type NodeProps } from '@xyflow/react'
import { CanvasHandle } from './CanvasHandle'
import { UiButton } from './ui'
import { useCanvasTextSelectionScope } from './canvasTextSelection'

export type SelectionFlowNode = Node<{
  ids: string[]; connectable: boolean; downloadable: boolean; onDownload: () => void
}, 'selection'>

export const SelectionNode = memo(function SelectionNode({ id, data, width, height }: NodeProps<SelectionFlowNode>) {
  const scope = useCanvasTextSelectionScope()
  const updateInternals = useUpdateNodeInternals()
  useEffect(() => { updateInternals(id) }, [id, width, height, data.connectable, updateInternals])
  return <div className="dc-selection-frame">
    <NodeToolbar nodeId={id} isVisible position={Position.Top} offset={12}
      className={`dc-selection-toolbar nodrag nopan ${scope}`} role="toolbar" aria-label="框选操作">
      <UiButton disabled={!data.downloadable} aria-label="下载选中素材" title="下载选中素材" onClick={data.onDownload}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 3v12m-4-4 4 4 4-4M5 16v4h14v-4" />
        </svg>
        下载
      </UiButton>
    </NodeToolbar>
    <CanvasHandle type="source" disabled={!data.connectable} className="dc-selection-handle" />
  </div>
})

/** A view-only node gives the native Handle its own coordinate/auto-pan context. */
export function selectionFrame<NodeType extends Node>(nodes: readonly NodeType[], id: string, data: SelectionFlowNode['data']): SelectionFlowNode | undefined {
  const chosen = nodes.filter((node) => node.selected)
  if (chosen.length < 2) return
  // Titles (including rename inputs / TTS badges) sit above the measured body.
  // Individual handles extend 27px sideways; keep a 13px gap before the
  // group's 12px-radius output, even when both outputs share the same height.
  const left = Math.min(...chosen.map((node) => node.position.x)) - 40
  const top = Math.min(...chosen.map((node) => node.position.y)) - 52
  const right = Math.max(...chosen.map((node) => node.position.x + (node.measured?.width ?? node.width ?? 0))) + 52
  const bottom = Math.max(...chosen.map((node) => node.position.y + (node.measured?.height ?? node.height ?? 0))) + 12
  return { id, type: 'selection', position: { x: left, y: top }, width: right - left, height: bottom - top,
    selected: false, selectable: false, draggable: false, deletable: false, focusable: false, zIndex: 1001,
    style: { pointerEvents: 'none' }, data }
}
