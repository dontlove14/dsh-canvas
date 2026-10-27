import { memo } from 'react'
import { BaseEdge, EdgeText, getBezierPath, type Edge, type EdgeProps } from '@xyflow/react'

export type RelationshipFlowEdge = Edge<{ flowing?: boolean }, 'relationship'>

/** Selection is a view projection; stored edges and unrelated objects stay untouched. */
export function relationshipEdges(edges: RelationshipFlowEdge[], nodeId: string | null): RelationshipFlowEdge[] {
  if (!nodeId) return edges
  return edges.map((edge) => edge.source === nodeId || edge.target === nodeId
    ? { ...edge, data: { ...edge.data, flowing: true } } : edge)
}

export const RelationshipEdge = memo(function RelationshipEdge({
  id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, pathOptions,
  style, markerStart, markerEnd, interactionWidth, label, labelStyle, labelShowBg,
  labelBgStyle, labelBgPadding, labelBgBorderRadius, data,
}: EdgeProps<RelationshipFlowEdge>) {
  // Always start at the source handle, even when the destination is to its left.
  const [path, labelX, labelY] = getBezierPath({
    sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, curvature: pathOptions?.curvature,
  })
  return <>
    <BaseEdge id={id} path={path} style={style} markerStart={markerStart} markerEnd={markerEnd}
      interactionWidth={interactionWidth} />
    {data?.flowing && <g className="dc-edge-flow" aria-hidden="true" pointerEvents="none">
      <path className="dc-edge-flow-glow" d={path} pathLength={100} />
      <path className="dc-edge-flow-trail" d={path} pathLength={100} />
      <path className="dc-edge-flow-core" d={path} pathLength={100} />
    </g>}
    <EdgeText x={labelX} y={labelY} label={label} labelStyle={labelStyle} labelShowBg={labelShowBg}
      labelBgStyle={labelBgStyle} labelBgPadding={labelBgPadding} labelBgBorderRadius={labelBgBorderRadius} />
  </>
})
