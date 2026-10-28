import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CanvasNode } from '../shared/contracts'
import { TaskSummarySchema, type TaskSummary } from '../shared/v2'
import { ApiError, type CanvasApi } from './api'
import { mergeSubmissions } from './generationHistory'

export function useGenerationSubmission({ api, workspace, tasks, flush, refresh, report }: {
  api: CanvasApi; workspace: string; tasks: readonly TaskSummary[]
  flush: () => Promise<number>; refresh: () => Promise<void>; report: (error: unknown) => void
}) {
  const dispatching = useRef(false)
  const mounted = useRef(true)
  const [submitting, setSubmitting] = useState(false)
  const [pending, setPending] = useState<TaskSummary[]>([])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    setPending((old) => {
      const remaining = mergeSubmissions(tasks, old).filter((task) => old.includes(task))
      return remaining.length === old.length ? old : remaining
    })
  }, [tasks])
  const merged = useMemo(() => mergeSubmissions(tasks, pending), [tasks, pending])
  const generate = useCallback(async (node: CanvasNode) => {
    if (dispatching.current) return
    dispatching.current = true; setSubmitting(true)
    const requestId = crypto.randomUUID()
    const now = tasks.reduce((latest, task) => Math.max(latest, task.createdAt + 1), Date.now())
    const intent: TaskSummary = { id: requestId, requestId, nodeId: node.id, workspaceId: workspace,
      status: 'submitted', resultIds: [], createdAt: now, updatedAt: now }
    setPending((old) => [...old, intent])
    let sent = false, accepted = false
    try {
      const revision = await flush()
      sent = true
      const task = TaskSummarySchema.parse(node.kind === 'tts-generation' ? await api.ttsGenerate(workspace, node.id, revision, requestId)
        : await api.generate(workspace, node.id, revision, requestId))
      if (task.nodeId !== node.id || task.workspaceId !== workspace || (task.requestId && task.requestId !== requestId)) throw new Error('任务回执归属不一致，请刷新核对')
      accepted = true
      if (mounted.current) setPending((old) => old.map((item) => item.requestId === requestId ? { ...task, requestId } : item))
      await refresh()
    } catch (error) {
      if (mounted.current && !accepted) {
        const rejected = !sent || (error instanceof ApiError && error.status >= 400 && error.status < 500)
        setPending((old) => rejected ? old.filter((item) => item.requestId !== requestId)
          : old.map((item) => item.requestId === requestId ? { ...item, status: 'unknown' } : item))
      }
      report(error)
    } finally {
      dispatching.current = false
      if (mounted.current) setSubmitting(false)
    }
  }, [api, workspace, tasks, flush, refresh, report])
  return { tasks: merged, submitting, generate }
}
