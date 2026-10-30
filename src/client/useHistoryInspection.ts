import { useCallback, useEffect, useRef, useState } from 'react'
import { TaskSnapshotSchema, TtsTaskSnapshotSchema, isTtsSnapshot, type AnyTaskSnapshot, type CanvasNode } from '../shared/contracts'
import type { TaskSummary } from '../shared/v2'
import type { CanvasApi } from './api'
import { submissionIdentity } from './generationHistory'
import { assetToken } from '../shared/promptMentions'

export interface HistoryInspection { nodeId: string; identity: string; assetId?: string }
interface SnapshotRead { key: string; snapshot?: AnyTaskSnapshot; error?: string }

/** Viewing history has no write callback. Only an explicit return to editing restores inputs. */
export function useHistoryInspection({ api, workspace, active, node, expanded, tasks, authoritative, patchNode, readOnly = false }: {
  api: CanvasApi; workspace: string; active: boolean; node?: CanvasNode; expanded: boolean
  tasks: readonly TaskSummary[]; authoritative: readonly TaskSummary[]
  patchNode: (id: string, fields: Partial<CanvasNode>) => void
  readOnly?: boolean
}) {
  const [inspection, setInspection] = useState<HistoryInspection>()
  const [restore, setRestore] = useState<string>()
  const initialized = useRef(new Set<string>())
  const cache = useRef(new Map<string, AnyTaskSnapshot>())
  const [read, setRead] = useState<SnapshotRead>()
  const inspect = useCallback((value: HistoryInspection) => setInspection(value), [])
  const beginEditing = useCallback((id: string, force = false) => {
    setInspection(undefined)
    if (readOnly) { setRestore(undefined); return }
    if (force || !initialized.current.has(id)) { initialized.current.delete(id); setRestore(id) }
  }, [readOnly])
  const newest = tasks.filter((task) => task.nodeId === node?.id).reduce<TaskSummary | undefined>((last, task) =>
    !last || task.createdAt >= last.createdAt ? task : last, undefined)
  const inspectedTask = node && expanded && inspection?.nodeId === node.id
    ? tasks.find((task) => task.nodeId === node.id && submissionIdentity(task) === inspection.identity) : undefined
  const target = active ? expanded ? inspectedTask : restore === node?.id ? newest : undefined : undefined
  const key = target ? `${workspace}:${target.id}` : ''
  const acknowledged = !!target && (authoritative.some((task) => task.id === target.id) || target.id !== target.requestId)
  useEffect(() => {
    if (!target || !acknowledged) return
    const cached = cache.current.get(key)
    if (cached) { setRead({ key, snapshot: cached }); return }
    const controller = new AbortController()
    let live = true
    setRead({ key })
    void api.taskDetail(workspace, target.id, controller.signal).then((detail) => {
      if (!live) return
      const task = detail.task
      if (!task || task.id !== target.id || task.nodeId !== target.nodeId || task.workspaceId !== workspace) throw new Error('任务记录归属不一致')
      const snapshot = task.snapshot.model.protocol === 'fish-tts' ? TtsTaskSnapshotSchema.parse(task.snapshot) : TaskSnapshotSchema.parse(task.snapshot)
      if (snapshot.model.kind !== (node?.kind === 'tts-generation' ? 'audio' : node?.kind === 'video-generation' ? 'video' : 'image')) throw new Error('任务记录类型不一致')
      cache.current.set(key, snapshot); setRead({ key, snapshot })
    }).catch(() => { if (live) setRead({ key, error: '生成记录读取失败，请收起后重新打开重试' }) })
    return () => { live = false; controller.abort() }
  }, [api, workspace, key, acknowledged, node?.kind])
  const snapshot = read?.key === key ? read.snapshot : undefined
  useEffect(() => {
    if (readOnly) { if (restore) setRestore(undefined); return }
    if (!active || expanded || !node || restore !== node.id || !snapshot) return
    // Provider prompts contain numbered references. Restore UUID tokens, never edges.
    const prompt = isTtsSnapshot(snapshot) ? snapshot.prompt : snapshot.prompt.replace(/\[参考(图|视频|音频)(\d+)\]/g, (marker, _kind, number) =>
      snapshot.referenceIds[Number(number) - 1] ? assetToken(snapshot.referenceIds[Number(number) - 1]) : marker)
    const fields = { prompt, modelId: isTtsSnapshot(snapshot) ? null : snapshot.model.id, params: snapshot.params }
    if (node.prompt !== prompt || node.modelId !== fields.modelId || JSON.stringify(node.params) !== JSON.stringify(fields.params)) patchNode(node.id, fields)
    initialized.current.add(node.id); setRestore(undefined)
  }, [active, expanded, node, restore, snapshot, patchNode, readOnly])
  return { inspection: inspectedTask ? inspection : undefined, inspect, beginEditing,
    snapshot, error: read?.key === key ? read.error : undefined,
    restoring: !readOnly && !expanded && restore === node?.id }
}
