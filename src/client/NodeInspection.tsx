import { useEffect, useState } from 'react'
import { TaskSnapshotSchema, TtsTaskSnapshotSchema, type CanvasNode, type CanvasGraph, type Asset, type PublicModel, type AnyTaskSnapshot } from '../shared/contracts'
import type { CanvasApi } from './api'
import { SignedImage } from './SignedMedia'
import { MediaIcon } from './MediaIcon'
import { GenerationSnapshotEditor } from './GenerationSnapshotEditor'

/** Current inputs, not a submitted snapshot. This component has no write callbacks. */
export function NodeInspection({ node, graph, assets, models, api, workspace, onOpen }: {
  node: CanvasNode; graph: CanvasGraph; assets: readonly Asset[]; models: readonly PublicModel[]
  api: CanvasApi; workspace: string; onOpen: (asset: Asset) => void
}) {
  const references = graph.edges.filter((edge) => edge.target === node.id)
  const model = models.find((model) => model.id === node.modelId)
  return <div data-dc-current-inspection={node.id} role="region" aria-label="当前节点输入（只读）">
    <div className="dc-snapshot-heading"><strong>{node.title}</strong><small className="dc-muted">当前输入 · 只读</small></div>
    {!!references.length && <div className="dc-reference-row">{references.map((edge, index) => {
      const asset = assets.find((asset) => asset.id === edge.assetId)
      return <button key={edge.id} className="dc-reference" title={asset?.filename ?? '素材不可用'} disabled={!asset}
        aria-label={`查看引用 ${index + 1}`} onClick={() => asset && onOpen(asset)}>
        {asset?.kind === 'image' ? <SignedImage api={api} canvas={workspace} assetId={asset.id} alt={asset.filename} />
          : <span className="dc-reference-placeholder">{asset ? <MediaIcon kind={asset.kind} size={28} /> : '？'}</span>}
        <small>{index + 1}</small>
      </button>
    })}</div>}
    <textarea className="dc-inspection-prompt" readOnly value={node.prompt} aria-label={node.kind === 'tts-generation' ? '文字内容' : '提示词'}
      data-dc-text-selectable="true" />
    <div className="dc-snapshot-model"><strong>{node.kind === 'tts-generation' ? 'FishTTS' : model?.name ?? '未选择模型'}</strong></div>
    <dl className="dc-snapshot-params">{Object.entries(node.params ?? {}).filter(([key]) => key !== 'type').map(([key, value]) =>
      <div key={key}><dt>{{ size: '尺寸', n: '生成数量', seconds: '时长（秒）', background: '背景', quality: '画质',
        videoMode: '生成模式', firstFrameId: '首帧', lastFrameId: '尾帧', generateAudio: '同步音频',
        audio: '音频', reference_id: '音色 ID', speed: '语速', volume: '音量' }[key] ?? key}</dt>
        <dd data-dc-text-selectable="true">{typeof value === 'boolean' ? value ? '开启' : '关闭' : String(value)}</dd></div>)}</dl>
  </div>
}

export function PresentedTaskEditor({ taskId, nodeId, api, workspace, ...props }: Omit<Parameters<typeof GenerationSnapshotEditor>[0], 'snapshot' | 'error'> & { taskId: string; nodeId: string }) {
  const [result, setResult] = useState<{ id: string; snapshot?: AnyTaskSnapshot; error?: string }>({ id: taskId })
  useEffect(() => {
    let live = true
    const controller = new AbortController()
    void api.taskDetail(workspace, taskId, controller.signal).then((detail) => {
      const task = detail.task
      if (!task || task.id !== taskId || task.nodeId !== nodeId || task.workspaceId !== workspace) throw new Error('任务记录归属不一致')
      const snapshot = task.snapshot.model.protocol === 'fish-tts' ? TtsTaskSnapshotSchema.parse(task.snapshot) : TaskSnapshotSchema.parse(task.snapshot)
      if (live) setResult({ id: taskId, snapshot })
    }).catch((error) => { if (live) setResult({ id: taskId, error: String(error) }) })
    return () => { live = false; controller.abort() }
  }, [api, workspace, taskId, nodeId])
  return <div data-dc-task-inspection={result.id === taskId && result.snapshot ? taskId : undefined}>
    <GenerationSnapshotEditor {...props} api={api} workspace={workspace} readOnly snapshot={result.id === taskId ? result.snapshot : undefined} error={result.id === taskId ? result.error : undefined} />
  </div>
}
