import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { Edge, Node, OnBeforeDelete } from '@xyflow/react'
import { TRACKED_STATUSES, type CanvasNode } from '../shared/contracts'
import type { TaskSummary } from '../shared/v2'
import { UiButton, UiModal } from './ui'

interface Environment {
  active: boolean; pageVisible: boolean; workspace: string; submitting: boolean
  tasks: readonly TaskSummary[]; nodes: readonly CanvasNode[]
  container: RefObject<HTMLElement>; report: (error: unknown) => void
}

export function useNodeDeleteConfirmation<NodeType extends Node, EdgeType extends Edge>(environment: Environment) {
  const live = useRef(environment)
  live.current = environment
  const mounted = useRef(true)
  const pending = useRef<{ workspace: string; resolve: (confirmed: boolean) => void } | null>(null)
  const [count, setCount] = useState<number | null>(null)
  const settle = useCallback((confirmed: boolean) => {
    const request = pending.current
    if (!request) return
    pending.current = null
    if (mounted.current) setCount(null)
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
    const allowed = () => {
      const current = live.current
      if (!mounted.current || !current.active || !current.pageVisible || current.workspace !== scope) return false
      if (nodes.some((node) => !current.nodes.some((item) => item.id === node.id))) return false
      if (nodes.length && current.submitting) { current.report(new Error('任务正在提交，请稍后删除')); return false }
      if (nodes.some((node) => current.tasks.some((task) => task.nodeId === node.id && TRACKED_STATUSES.has(task.status)))) {
        current.report(new Error('选中的节点有未结束任务，请先处理任务')); return false
      }
      return true
    }
    if (pending.current || !live.current.container.current?.contains(document.activeElement) || !allowed()) return false
    if (!nodes.length) return { nodes, edges }
    const confirmed = await new Promise<boolean>((resolve) => {
      pending.current = { workspace: scope, resolve }
      setCount(nodes.length)
    })
    // The modal is asynchronous; polling or a submission may have changed the
    // candidate nodes/tasks. Focus belongs to the modal now, not the canvas.
    return confirmed && allowed() ? { nodes, edges } : false
  }, [])

  const modal = count !== null && environment.active && environment.pageVisible
    ? <UiModal label="删除节点" className="dc-confirm-dialog" onClose={() => settle(false)}>
      <p>删除 {count} 个节点，并解除相关连线？</p>
      <p className="dc-muted">本地媒体和下游结果会保留。</p>
      <div className="dc-form-actions">
        <UiButton variant="outline" data-modal-autofocus onClick={() => settle(false)}>取消</UiButton>
        <UiButton variant="primary" onClick={() => settle(true)}>删除</UiButton>
      </div>
    </UiModal> : null
  return { onBeforeDelete, modal }
}
