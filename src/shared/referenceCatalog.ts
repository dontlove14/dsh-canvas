import { isGeneration, NodeLabels, type Asset, type CanvasNode, type CanvasGraph } from './contracts'
import type { TaskSummary } from './v2'
import type { ReferenceItem } from './chatReferences'

/** One saved snapshot supplies result ownership and direct relations; preview follows nodeResults. */
export class ReferenceCatalog {
  readonly nodes: Map<string, CanvasNode>
  readonly assets: Map<string, Asset>
  readonly tasks = new Map<string, TaskSummary[]>()
  readonly incoming = new Map<string, CanvasGraph['edges']>()
  readonly outgoing = new Map<string, CanvasGraph['edges']>()
  private readonly batchCache = new Map<string, Array<{ task: TaskSummary; results: Asset[] }>>()
  private readonly mediaCache = new Map<string, Asset[]>()
  private readonly latestResults = new Map<string, TaskSummary>()
  private readonly currentCache = new Map<string, Asset | undefined>()
  private readonly groupedCache = new Map<string, Map<string, Asset[]>>()
  constructor(readonly snapshot: { workspaceId: string; graphRevision: number; graph: CanvasGraph; assets: Asset[]; tasks: TaskSummary[] }) {
    this.nodes = new Map(snapshot.graph.nodes.map((node) => [node.id, node]))
    this.assets = new Map(snapshot.assets.map((asset) => [asset.id, asset]))
    for (const task of snapshot.tasks) {
      const group = this.tasks.get(task.nodeId) ?? []
      group.push(task); this.tasks.set(task.nodeId, group)
      if (task.resultIds.length) this.latestResults.set(task.nodeId, task)
    }
    for (const edge of snapshot.graph.edges) {
      const incoming = this.incoming.get(edge.target) ?? [], outgoing = this.outgoing.get(edge.source) ?? []
      incoming.push(edge); outgoing.push(edge)
      this.incoming.set(edge.target, incoming); this.outgoing.set(edge.source, outgoing)
    }
  }
  owns(node: CanvasNode, asset: Asset) { return node.assetId === asset.id || asset.nodeId === node.id }
  results(node: CanvasNode, task: TaskSummary) {
    return [...new Set(task.resultIds)].flatMap((id) => {
      const asset = this.assets.get(id)
      return asset && this.owns(node, asset) ? [asset] : []
    })
  }
  batches(node: CanvasNode) {
    const cached = this.batchCache.get(node.id)
    if (cached) return cached
    const batches = (this.tasks.get(node.id) ?? []).map((task, index) => ({ task, index }))
      .sort((a, b) => b.task.createdAt - a.task.createdAt || b.index - a.index)
      .map(({ task }) => ({ task, results: this.results(node, task) }))
    this.batchCache.set(node.id, batches)
    return batches
  }
  currentBatch(node: CanvasNode) {
    return this.latestResults.get(node.id)
  }
  current(node: CanvasNode): Asset | undefined {
    if (this.currentCache.has(node.id)) return this.currentCache.get(node.id)
    if (!isGeneration(node.kind)) {
      const asset = node.assetId ? this.assets.get(node.assetId) : undefined
      this.currentCache.set(node.id, asset); return asset
    }
    const task = this.currentBatch(node), results = task ? this.results(node, task) : []
    const asset = results.find((asset) => asset.id === node.selectedResultId) ?? results[0]
    this.currentCache.set(node.id, asset); return asset
  }
  media(node: CanvasNode) {
    const cached = this.mediaCache.get(node.id)
    if (cached) return cached
    if (!isGeneration(node.kind)) return this.current(node) ? [this.current(node)!] : []
    const media = [...this.grouped(node).values()].flat()
    this.mediaCache.set(node.id, media)
    return media
  }
  private grouped(node: CanvasNode) {
    const cached = this.groupedCache.get(node.id)
    if (cached) return cached
    const groups = new Map<string, Asset[]>(), seen = new Set<string>(), current = this.currentBatch(node)
    const batches = this.batches(node)
    for (const batch of [...batches.filter((batch) => batch.task.id === current?.id), ...batches.filter((batch) => batch.task.id !== current?.id)]) {
      groups.set(batch.task.id, batch.results.filter((asset) => {
        if (seen.has(asset.id)) return false
        seen.add(asset.id); return true
      }))
    }
    this.groupedCache.set(node.id, groups)
    return groups
  }
  items(sessionId: string, section: string, query: string, nodeId?: string, taskId?: string): ReferenceItem[] {
    const items: ReferenceItem[] = [], needle = query.toLocaleLowerCase()
    const match = (text: string) => !needle || text.toLocaleLowerCase().includes(needle)
    const positions = new Map<string, Map<string, number>>(), taskByAsset = new Map<string, TaskSummary>()
    for (const task of this.snapshot.tasks) for (const id of task.resultIds) taskByAsset.set(id, task)
    const mediaRow = (node: CanvasNode, asset: Asset): ReferenceItem => {
      const all = this.media(node), current = asset.id === this.current(node)?.id
      if (!positions.has(node.id)) positions.set(node.id, new Map(all.map((item, index) => [item.id, index + 1])))
      const label = `${node.title} · ${{ image: '图片', video: '视频', audio: '音频' }[asset.kind]}${all.length > 1 ? ` ${positions.get(node.id)!.get(asset.id)}` : ''}`
      const task = taskByAsset.get(asset.id)
      const batch = task && task.id === this.currentBatch(node)?.id ? '本次结果' : '历史结果'
      return { type: 'media', label, kind: asset.kind, current, description: `${current ? '当前展示' : isGeneration(node.kind) ? batch : '原素材'} · ${asset.filename}`,
        section, ref: { version: 1, kind: 'media', sessionId, canvasId: this.snapshot.workspaceId, nodeId: node.id, assetId: asset.id, label } }
    }
    for (const node of this.snapshot.graph.nodes) {
      if (nodeId && node.id !== nodeId) continue
      const assets = this.media(node), batches = this.batches(node)
      if (!nodeId) {
        if (match(node.title)) items.push({ type: 'node', label: node.title, description: `${NodeLabels[node.kind]} · ${assets.length ? '引用节点' : '尚无结果'}`,
          section, ref: { version: 2, kind: 'node', sessionId, canvasId: this.snapshot.workspaceId, nodeId: node.id, label: node.title }, hasMedia: assets.length > 0 })
        const current = this.current(node)
        for (const asset of needle ? assets : current ? [current] : []) {
          const row = mediaRow(node, asset)
          if (row.type === 'media' && match(`${row.label} ${asset.filename}`)) items.push(row)
        }
      } else if (needle) {
        for (const asset of assets) {
          const row = mediaRow(node, asset)
          if ((!taskId || this.grouped(node).get(taskId)?.some((item) => item.id === asset.id)) &&
            match(`${row.label} ${asset.filename}`)) items.push(row)
        }
      } else {
        const seen = new Set<string>(), add = (list: Asset[]) => {
          for (const asset of list) if (!seen.has(asset.id)) { seen.add(asset.id); items.push(mediaRow(node, asset)) }
        }
        if (!isGeneration(node.kind)) add(assets)
        else if (taskId) add(this.grouped(node).get(taskId) ?? [])
        else {
          const current = this.currentBatch(node)
          add(current ? this.results(node, current) : [])
          for (const batch of batches) if (batch.task.id !== current?.id && this.grouped(node).get(batch.task.id)?.length) {
            const results = this.grouped(node).get(batch.task.id)!
            results.forEach((asset) => seen.add(asset.id))
            items.push({ type: 'directory', label: `历史批次 · ${new Date(batch.task.createdAt).toISOString()}`,
              description: `${results.length} 份素材`, section, nodeId: node.id, taskId: batch.task.id })
          }
        }
      }
    }
    return items
  }
  context(node: CanvasNode) {
    const summary = (id: string) => {
      const other = this.nodes.get(id)
      return other ? { nodeId: other.id, title: other.title, kind: other.kind } : { nodeId: id, unavailable: true }
    }
    return { canvasId: this.snapshot.workspaceId, nodeId: node.id, graphRevision: this.snapshot.graphRevision, node,
      currentOutput: this.current(node) ?? null,
      outputs: { currentBatch: this.currentBatch(node)?.id ?? null, currentResultIds: this.currentBatch(node) ? this.results(node, this.currentBatch(node)!).map((asset) => asset.id) : this.media(node).map((asset) => asset.id),
        mediaCount: this.media(node).length, historyBatchCount: this.batches(node).filter((batch) => batch.task.id !== this.currentBatch(node)?.id && batch.results.length).length },
      tasks: this.batches(node).map(({ task, results }) => ({ id: task.id, status: task.status, createdAt: task.createdAt, resultIds: results.map((asset) => asset.id) })),
      upstream: (this.incoming.get(node.id) ?? []).map((edge) => ({ edgeId: edge.id, source: summary(edge.source), assetId: edge.assetId,
        asset: this.assets.get(edge.assetId) ?? null, available: !!this.assets.get(edge.assetId) })),
      downstream: (this.outgoing.get(node.id) ?? []).map((edge) => ({ edgeId: edge.id, target: summary(edge.target), assetId: edge.assetId })),
    }
  }
  related(node: CanvasNode, assetId: string) {
    const asset = this.assets.get(assetId)
    return asset && (this.media(node).some((item) => item.id === assetId) ||
      this.incoming.get(node.id)?.some((edge) => edge.assetId === assetId && this.nodes.has(edge.source))) ? asset : undefined
  }
}
