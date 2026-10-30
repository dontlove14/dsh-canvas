import { useContext, useRef, useState } from 'react'
import type { CanvasNode } from '../shared/contracts'
import { UiInput } from './ui'
import { ReviewBadges } from './ReviewControls'
import { CanvasSelectionContext } from './CanvasSelection'

export function NodeTitle({ node, onRename, assetId }: { node: CanvasNode; onRename: (id: string, title: string) => void; assetId?: string }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(node.title)
  const cancelled = useRef(false)
  const { readOnly } = useContext(CanvasSelectionContext)
  const start = () => { if (readOnly) return; cancelled.current = false; setDraft(node.title); setEditing(true) }
  const commit = () => { if (!readOnly && !cancelled.current && draft.trim()) onRename(node.id, draft.trim()); setEditing(false) }
  return <div className="dc-resource-title nodrag nopan" onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => { event.stopPropagation(); start() }}>
    {editing && !readOnly ? <UiInput value={draft} aria-label="节点名称" autoFocus maxLength={160}
      onFocus={(event) => event.target.select()} onChange={(event) => setDraft(event.target.value)} onBlur={commit}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() }
        if (event.key === 'Escape') { event.preventDefault(); cancelled.current = true; setEditing(false) }
      }} />
      : <span title={readOnly ? node.title : `${node.title}（双击修改）`} tabIndex={0} onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === 'F2') { event.preventDefault(); event.stopPropagation(); start() }
      }}>{node.title}</span>}
    {assetId && <ReviewBadges assetId={assetId} />}
  </div>
}
