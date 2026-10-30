import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { Edge, Node, OnBeforeDelete } from '@xyflow/react'
import { TRACKED_STATUSES, type CanvasNode, type CanvasGraph } from '../shared/contracts'
import { promptParts } from '../shared/promptMentions'
import type { TaskSummary } from '../shared/v2'
import { UiButton, UiModal } from './ui'

interface Environment {
  active: boolean; pageVisible: boolean; workspace: string; submitting: boolean
  tasks: readonly TaskSummary[]; nodes: readonly CanvasNode[]; edges: CanvasGraph['edges']
  container: RefObject<HTMLElement>; report: (error: unknown) => void
}

export function useNodeDeleteConfirmation<NodeType extends Node, EdgeType extends Edge>(environment: Environment) {
  const live = useRef(environment)
  live.current = environment
  const mounted = useRef(true)
  const pending = useRef<{ workspace: string; resolve: (confirmed: boolean) => void } | null>(null)
  const [request, setRequest] = useState<{ kind: 'nodes' | 'edges'; count: number } | null>(null)
  const settle = useCallback((confirmed: boolean) => {
    const request = pending.current
    if (!request) return
    pending.current = null
    if (mounted.current) setRequest(null)
    request.resolve(confirmed)
  }, [])
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; settle(false) }
  }, [settle])
  useEffect(() => {
    if (!environment.active || !environment.pageVisible || pending.current?.workspace !== environment.workspace) settle(false)
  }, [environment.active, environment.pageVisible, environment.workspace, settle])

  const onBeforeDelete: OnBeforeDelete<NodeType, EdgeType> = useCallback(async ({ nodes, edges }) => {
    const scope = live.current.workspace
    const edgeCandidates = edges.map((edge) => live.current.edges.find((item) => item.id === edge.id))
    const allowed = () => {
      const current = live.current
      if (!mounted.current || !current.active || !current.pageVisible || current.workspace !== scope) return false
      if (nodes.some((node) => !current.nodes.some((item) => item.id === node.id))) return false
      if (edgeCandidates.some((edge) => !edge || !current.edges.some((item) =>
        item.id === edge.id && item.source === edge.source && item.target === edge.target && item.assetId === edge.assetId))) return false
      if (nodes.length && current.submitting) { current.report(new Error('任务正在提交，请稍后删除')); return false }
      if (nodes.some((node) => current.tasks.some((task) => task.nodeId === node.id && TRACKED_STATUSES.has(task.status)))) {
        current.report(new Error('选中的节点有未结束任务，请先处理任务')); return false
      }
      return true
    }
    if (pending.current || !live.current.container.current?.contains(document.activeElement) || !allowed()) return false
    const mentions = edgeCandidates.filter((edge) => edge && promptParts(live.current.nodes.find((node) => node.id === edge.target)?.prompt ?? '')
      .some((part) => part.kind === 'mention' && part.assetId === edge.assetId))
    if (!nodes.length && !mentions.length) return { nodes, edges }
    const confirmed = await new Promise<boolean>((resolve) => {
      pending.current = { workspace: scope, resolve }
      setRequest({ kind: nodes.length ? 'nodes' : 'edges', count: nodes.length || mentions.length })
    })
    // The modal is asynchronous; polling or a submission may have changed the
    // candidate nodes/tasks. Focus belongs to the modal now, not the canvas.
    return confirmed && allowed() ? { nodes, edges } : false
  }, [])

  const modal = request !== null && environment.active && environment.pageVisible
    ? <UiModal label={request.kind === 'nodes' ? '删除节点' : '删除连线'} className="dc-confirm-dialog" onClose={() => settle(false)}>
      <p>{request.kind === 'nodes' ? `删除 ${request.count} 个节点，并解除相关连线？` : `选中的连线中有 ${request.count} 条被提示词 @ 引用，确认删除？`}</p>
      <p className="dc-muted">{request.kind === 'nodes' ? '本地媒体和下游结果会保留。' : '删除后对应的 @ 引用将失效，提示词文字和素材会保留。'}</p>
      <div className="dc-form-actions">
        <UiButton variant="outline" data-modal-autofocus onClick={() => settle(false)}>取消</UiButton>
        <UiButton variant="primary" onClick={() => settle(true)}>删除</UiButton>
      </div>
    </UiModal> : null
  return { onBeforeDelete, modal }
}
