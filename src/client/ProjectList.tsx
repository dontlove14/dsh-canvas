import { useEffect, useMemo, useRef, useState } from 'react'
import { type CanvasChoice, type Catalog, type Folder } from '../shared/v2'
import { CanvasApi } from './api'
import { UiActionMenu, UiButton, UiModal, UiSelect } from './ui'

type CatalogCommand = Parameters<CanvasApi['catalogCommand']>[0]
interface ProjectListProps {
  api: CanvasApi
  active?: boolean
  folder: string
  onFolder: (id: string) => void
  onOpen: (canvas: CanvasChoice) => void
}

export function ProjectList({ api, folder, onFolder, onOpen, active = true }: ProjectListProps) {
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [loadError, setLoadError] = useState('')
  const [commandError, setCommandError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [busy, setBusy] = useState(false)
  const [moveTarget, setMoveTarget] = useState<CanvasChoice | null>(null)
  const commandPending = useRef(false)
  const mounted = useRef(true)
  const activeRef = useRef(active)
  activeRef.current = active
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    mounted.current = true
    if (activeRef.current) heading.current?.focus()
    return () => { mounted.current = false }
  }, [])
  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout>
    const schedule = () => { if (live) timer = setTimeout(() => void load(), 4000) }
    const load = async () => {
      if (!activeRef.current || document.hidden || commandPending.current) { schedule(); return }
      try {
        const next = await api.catalog()
        if (live) { setCatalog(next); setLoadError('') }
      } catch (failure) {
        if (live) setLoadError(failure instanceof Error ? failure.message : String(failure))
      } finally { schedule() }
    }
    void load()
    return () => { live = false; clearTimeout(timer) }
  }, [api, refresh])

  const selectedFolder = catalog?.folders.find((item) => item.id === folder)
  const activeFolder = selectedFolder ? folder : folder === 'root' ? 'root' : 'all'
  const folderName = selectedFolder?.name ?? (activeFolder === 'root' ? '未归档' : '全部画布')
  const projects = catalog?.canvases.filter((item) => activeFolder === 'all' || (activeFolder === 'root' ? !item.folderId : item.folderId === activeFolder)) ?? []
  const folderNames = useMemo(() => new Map(catalog?.folders.map((item) => [item.id, item.name])), [catalog])
  const counts = useMemo(() => {
    const result = new Map<string, number>()
    for (const item of catalog?.canvases ?? []) {
      const key = item.folderId ?? 'root'
      result.set(key, (result.get(key) ?? 0) + 1)
    }
    return result
  }, [catalog])

  const command = async (input: CatalogCommand): Promise<boolean> => {
    if (commandPending.current) return false
    commandPending.current = true; setBusy(true); setCommandError('')
    try {
      await api.catalogCommand(input)
      if (mounted.current) {
        if (input.operation === 'folder-delete' && input.id === activeFolder) onFolder('all')
        setRefresh((value) => value + 1)
      }
      return true
    } catch (failure) {
      if (mounted.current) {
        setCommandError(failure instanceof Error ? failure.message : String(failure))
        setRefresh((value) => value + 1)
      }
      return false
    } finally {
      commandPending.current = false
      if (mounted.current) setBusy(false)
    }
  }
  const nameCommand = (kind: 'canvas' | 'folder', item?: CanvasChoice | Folder) => {
    const label = kind === 'canvas' ? '画布' : '文件夹'
    const name = window.prompt(`${item ? '重命名' : '新建'}${label}`, item?.name ?? '')
    if (name === null) return
    if (!name.trim()) { setCommandError(`请输入${label}名称`); return }
    void command({
      operation: `${kind}-${item ? 'rename' : 'create'}`, name,
      ...(item ? { id: item.id, revision: item.revision } : kind === 'canvas' ? { folderId: selectedFolder?.id ?? null } : {}),
    })
  }
  const deleteItem = (kind: 'canvas' | 'folder', item: CanvasChoice | Folder) => {
    const detail = kind === 'canvas' ? '本地媒体文件将保留。' : '仅可删除空文件夹。'
    if (window.confirm(`删除“${item.name}”？${detail}`)) void command({ operation: `${kind}-delete`, id: item.id, revision: item.revision })
  }
  const folderButton = (id: string, name: string, count: number, icon: 'all' | 'folder') => <button key={id} className={`dc-folder-item ${activeFolder === id ? 'active' : ''}`} aria-current={activeFolder === id ? 'page' : undefined} disabled={busy} onClick={() => onFolder(id)}>
    <ProjectIcon kind={icon} /><span>{name}</span><small>{count}</small>
  </button>

  return <div className="dc-root dc-projects">
    <header className="dc-projects-header">
      <div className="dc-title"><span className="dc-brand-mark" aria-hidden="true">✦</span><div><h1 ref={heading} tabIndex={-1}>画布项目</h1><small>无限画布</small></div></div>
      <UiButton variant="primary" size="md" disabled={!catalog || busy} onClick={() => nameCommand('canvas')}>＋ 新建画布</UiButton>
    </header>
    <div className="dc-projects-layout">
      <aside className="dc-projects-sidebar">
        <nav aria-label="画布文件夹">
          {folderButton('all', '全部画布', catalog?.canvases.length ?? 0, 'all')}
          {folderButton('root', '未归档', counts.get('root') ?? 0, 'folder')}
          <div className="dc-folders-heading"><span>文件夹</span><UiButton aria-label="新建文件夹" disabled={!catalog || busy} onClick={() => nameCommand('folder')}>＋</UiButton></div>
          {catalog?.folders.map((item) => folderButton(item.id, item.name, counts.get(item.id) ?? 0, 'folder'))}
          {catalog && !catalog.folders.length && <p className="dc-folders-empty">暂无文件夹</p>}
        </nav>
      </aside>
      <main className="dc-projects-main" aria-busy={busy || (!catalog && !loadError)}>
        <div className="dc-projects-section-heading"><div><h2>{folderName}</h2>{catalog && <span>{projects.length} 张画布</span>}</div>
          {selectedFolder && <UiActionMenu label={`管理文件夹“${selectedFolder.name}”`} disabled={!active || busy} items={[
            { id: 'rename', label: '重命名文件夹', disabled: busy, onSelect: () => nameCommand('folder', selectedFolder) },
            { id: 'delete', label: '删除空文件夹', danger: true, disabled: busy, onSelect: () => deleteItem('folder', selectedFolder) },
          ]} />}
        </div>
        {(commandError || loadError) && <div className="dc-projects-error" role="alert"><span>{commandError || loadError}</span><UiButton disabled={busy} onClick={() => { setCommandError(''); setRefresh((value) => value + 1) }}>刷新列表</UiButton></div>}
        {!catalog ? <div className="dc-projects-empty"><p role="status">{loadError ? '画布列表暂时不可用' : '正在加载画布项目…'}</p></div>
          : !projects.length ? <div className="dc-projects-empty"><ProjectIcon kind="canvas" /><h3>{activeFolder === 'all' ? '还没有画布项目' : '这里还没有画布'}</h3><p>新建一张画布，开始连接你的创作灵感。</p><UiButton variant="primary" disabled={busy} onClick={() => nameCommand('canvas')}>＋ 新建画布</UiButton></div>
            : <ul className="dc-project-list" aria-label={`${folderName}项目`}>{projects.map((item) => <li key={item.id} className="dc-project-card">
              <button type="button" className="dc-project-open" disabled={busy} onClick={() => onOpen(item)} aria-label={`打开画布“${item.name}”`}>
                <span className="dc-project-card-heading">
                  <span className="dc-project-symbol"><ProjectIcon kind="canvas" /></span>
                  <span className="dc-project-info"><strong title={item.name}>{item.name}</strong><small>{item.folderId ? folderNames.get(item.folderId) ?? '文件夹' : '未归档'}</small></span>
                </span>
                {item.moving ? <span className="dc-project-state">文件搬移中</span> : item.moveError ? <span className="dc-project-state warning" title={item.moveError}>文件搬移失败</span> : null}
                <span className="dc-project-enter" aria-hidden="true">进入画布 <span>→</span></span>
              </button>
              <div className="dc-project-card-actions"><UiActionMenu label={`管理画布“${item.name}”`} disabled={!active || busy} items={[
                { id: 'rename', label: '重命名', disabled: busy, onSelect: () => nameCommand('canvas', item) },
                { id: 'move', label: '移动到文件夹', disabled: busy, onSelect: () => { setCommandError(''); setMoveTarget(item) } },
                { id: 'delete', label: '删除画布', danger: true, disabled: busy, onSelect: () => deleteItem('canvas', item) },
              ]} /></div>
            </li>)}</ul>}
      </main>
    </div>
    {active && moveTarget && <MoveDialog canvas={moveTarget} folders={catalog?.folders ?? []} busy={busy} error={commandError} onClose={() => setMoveTarget(null)} onMove={async (folderId) => {
      if (await command({ operation: 'canvas-move', id: moveTarget.id, revision: moveTarget.revision, folderId })) setMoveTarget(null)
    }} />}
  </div>
}

function MoveDialog({ canvas, folders, busy, error, onMove, onClose }: { canvas: CanvasChoice; folders: Folder[]; busy: boolean; error: string; onMove: (folder: string | null) => Promise<void>; onClose: () => void }) {
  const [folder, setFolder] = useState(canvas.folderId ?? '')
  return <UiModal label="移动画布" className="dc-move-dialog" onClose={() => { if (!busy) onClose() }}>
    <form onSubmit={(event) => { event.preventDefault(); if (!busy) void onMove(folder || null) }}>
      <p>为“{canvas.name}”选择目标文件夹。</p>
      <label>目标文件夹<UiSelect label="目标文件夹" value={folder} disabled={busy} onChange={setFolder} options={[{ value: '', label: '未归档' }, ...folders.map((item) => ({ value: item.id, label: item.name }))]} /></label>
      {error && <p className="dc-error" role="alert">{error}</p>}
      <div className="dc-form-actions"><UiButton variant="outline" disabled={busy} onClick={onClose}>取消</UiButton><UiButton type="submit" variant="primary" disabled={busy || folder === (canvas.folderId ?? '')}>{busy ? '移动中…' : '移动画布'}</UiButton></div>
    </form>
  </UiModal>
}

function ProjectIcon({ kind }: { kind: 'all' | 'folder' | 'canvas' }) {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === 'folder' ? <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3Z" />
      : kind === 'all' ? <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>
        : <><rect x="2.5" y="3" width="7" height="6" rx="1.5" /><rect x="14.5" y="15" width="7" height="6" rx="1.5" /><path d="M6 9v7h8.5M14.5 16l-2-2m2 2-2 2" /></>}
  </svg>
}
