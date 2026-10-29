import { useCallback, useEffect, useRef, useState } from 'react'
import { emptyGraph, type CanvasGraph } from '../shared/contracts'
import { browserHash, type CanvasSnapshot, type GraphMutation } from '../shared/v2'
import { ApiError, CanvasApi } from './api'
import { shareCanvasSnapshot } from './canvasSharing'

export function useCanvas(api: CanvasApi, workspace: string, active = true) {
  const [graph, setGraph] = useState<CanvasGraph>(emptyGraph)
  const [state, setState] = useState<CanvasSnapshot | null>(null)
  const [saveStatus, setSaveStatus] = useState('载入中')
  const [error, setError] = useState('')
  const [conflict, setConflict] = useState(false)
  const graphRef = useRef(graph)
  const snapshotRef = useRef<CanvasSnapshot | null>(null)
  const acceptSnapshot = useCallback((response: CanvasSnapshot) => {
    const shared = shareCanvasSnapshot(snapshotRef.current, response)
    snapshotRef.current = shared
    if (mounted.current) setState(shared)
    return shared
  }, [])
  const baseline = useRef(graph)
  const revision = useRef(0)
  const hashes = useRef<CanvasSnapshot['hashes']>({ nodes: {}, edges: {}, viewport: '' })
  const saving = useRef<Promise<void> | null>(null)
  const pending = useRef<{ graph: CanvasGraph; mutation: GraphMutation } | null>(null)
  const ready = useRef(false); const blocked = useRef(false); const mounted = useRef(true)
  const activeRef = useRef(active)
  activeRef.current = active
  const report = useCallback((failure: unknown) => { if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure)) }, [])
  const edit = useCallback((change: CanvasGraph | ((graph: CanvasGraph) => CanvasGraph)) => {
    const next = typeof change === 'function' ? change(graphRef.current) : change
    if (next === graphRef.current) return
    graphRef.current = next; setGraph(next); setSaveStatus(blocked.current ? '保存冲突 · 草稿保留' : '待保存')
  }, [])
  const getGraph = useCallback(() => graphRef.current, [])
  const flush = useCallback(async (): Promise<number> => {
    if (!ready.current) throw new Error('画布尚未载入')
    if (blocked.current) throw new Error('请先处理保存冲突')
    if (saving.current) await saving.current
    while (baseline.current !== graphRef.current || pending.current) {
      if (saving.current) { await saving.current; continue }
      const promise = (async () => {
        if (!pending.current) {
          const snapshot = graphRef.current
          const oldNodes = new Map(baseline.current.nodes.map((n) => [n.id, n]))
          const oldEdges = new Map(baseline.current.edges.map((e) => [e.id, e]))
          const mutation: GraphMutation = {
            mutationId: crypto.randomUUID(), baseRevision: revision.current,
            nodes: await Promise.all(snapshot.nodes.filter((n) => oldNodes.get(n.id) !== n).map(async (value) => ({ value: { ...value, title: value.title.trim().normalize('NFC') }, hash: await browserHash({ ...value, title: value.title.trim().normalize('NFC') }) }))),
            edges: await Promise.all(snapshot.edges.filter((e) => oldEdges.get(e.id) !== e).map(async (value) => ({ value, hash: await browserHash(value) }))),
            deleteNodes: baseline.current.nodes.filter((n) => !snapshot.nodes.some((v) => v.id === n.id)).map((n) => n.id),
            deleteEdges: baseline.current.edges.filter((e) => !snapshot.edges.some((v) => v.id === e.id)).map((e) => e.id),
          }
          mutation.nodes = mutation.nodes.filter((n) => hashes.current.nodes[n.value.id] !== n.hash)
          mutation.edges = mutation.edges.filter((e) => hashes.current.edges[e.value.id] !== e.hash)
          if (snapshot.viewport !== baseline.current.viewport) {
            const hash = await browserHash(snapshot.viewport)
            if (hash !== hashes.current.viewport) mutation.viewport = { value: snapshot.viewport, hash }
          }
          if (!mutation.nodes.length && !mutation.edges.length && !mutation.deleteNodes.length && !mutation.deleteEdges.length && !mutation.viewport) { baseline.current = snapshot; return }
          pending.current = { graph: snapshot, mutation }
        }
        const accepted = pending.current
        if (mounted.current) setSaveStatus('保存中')
        const response = acceptSnapshot(await api.save(workspace, accepted.mutation))
        revision.current = response.graphRevision; hashes.current = response.hashes
        baseline.current = accepted.graph; pending.current = null
        if (graphRef.current === accepted.graph) {
          graphRef.current = response.graph; baseline.current = response.graph
          if (mounted.current) setGraph(response.graph)
        }
        if (mounted.current) setSaveStatus(baseline.current === graphRef.current ? '已保存到本机' : '待保存')
      })()
      saving.current = promise
      try { await promise }
      catch (failure) {
        if (failure instanceof ApiError && failure.code === 'GRAPH_CONFLICT') { blocked.current = true; if (mounted.current) setConflict(true) }
        if (mounted.current) setSaveStatus('保存失败 · 草稿保留')
        report(failure); throw failure
      } finally { if (saving.current === promise) saving.current = null }
    }
    if (mounted.current) setSaveStatus('已保存到本机')
    return revision.current
  }, [api, workspace, report, acceptSnapshot])
  const refresh = useCallback(async () => {
    const received = await api.state(workspace)
    if (!mounted.current) return
    const response = acceptSnapshot(received)
    if (!saving.current && response.graphRevision !== revision.current) {
      if (baseline.current === graphRef.current && !pending.current) {
        revision.current = response.graphRevision; hashes.current = response.hashes
        graphRef.current = response.graph; baseline.current = response.graph; setGraph(response.graph)
      } else {
        blocked.current = true; setConflict(true); setSaveStatus('保存冲突 · 草稿保留')
        report(new Error('画布已更新，请导出当前草稿后重新载入'))
      }
    }
  }, [api, workspace, report, acceptSnapshot])
  const reload = useCallback(async () => {
    const received = await api.state(workspace)
    if (!mounted.current) return
    const response = acceptSnapshot(received)
    graphRef.current = response.graph; baseline.current = response.graph; revision.current = response.graphRevision; hashes.current = response.hashes
    ready.current = true; blocked.current = false; pending.current = null
    setGraph(response.graph); setState(response); setConflict(false); setError(''); setSaveStatus('已保存到本机')
  }, [api, workspace, acceptSnapshot])
  useEffect(() => {
    mounted.current = true
    let polling = false
    void reload().catch(report)
    const timer = setInterval(() => { if (!activeRef.current || !ready.current || polling || document.hidden) return; polling = true; void refresh().catch(report).finally(() => { polling = false }) }, 2000)
    const warn = (event: BeforeUnloadEvent) => { if (ready.current && (baseline.current !== graphRef.current || pending.current)) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', warn)
    return () => { mounted.current = false; clearInterval(timer); window.removeEventListener('beforeunload', warn); if (ready.current && !blocked.current) void flush().catch(() => {}) }
  }, [reload, refresh, report, flush])
  useEffect(() => {
    if (!ready.current || blocked.current || baseline.current === graph) return
    const timer = setTimeout(() => { void flush().catch(() => {}) }, 650)
    return () => clearTimeout(timer)
  }, [graph, flush])
  return { graph, state, saveStatus, error, conflict, edit, getGraph, flush, refresh, reload, report, clearError: () => setError('') }
}
