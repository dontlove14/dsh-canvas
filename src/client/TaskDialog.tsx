import { useEffect, useRef, useState } from 'react'
import { CanvasApi } from './api'
import { TaskStatusLabels, type TaskAction } from '../shared/contracts'
import { TaskSearchQuerySchema, type TaskPage, type TaskRow, type TaskSearchQuery, type TaskDetail } from '../shared/v2'
import { UiButton, UiInput, UiModal, UiSelect } from './ui'
import { UiDateTimeRangePicker } from './UiDateTimeRangePicker'
import { UiPagination } from './UiPagination'
import { dateText, timeText, type DateTimeRange } from './dateTimeRange'
import { copyText } from './clipboard'

const types = [{ value: '', label: '全部类型' }, { value: 'image', label: '图片生成' }, { value: 'video', label: '视频生成' }, { value: 'tts', label: '语音生成' }, { value: 'import', label: '素材导入' }]
const formatTime = (stamp: number) => `${dateText(new Date(stamp))} ${timeText(new Date(stamp))}`
const initialDraft = { taskId: '', folderName: '', canvasName: '', type: '' }
const initialQuery: TaskSearchQuery = { page: 1, pageSize: 20 }

export function TaskDialog({ api, onClose }: { api: CanvasApi; onClose: () => void }) {
  const [selected, setSelected] = useState<TaskRow | null>(null)
  const [revision, setRevision] = useState(0)
  const list = useRef<HTMLDivElement>(null)
  const back = () => {
    const id = selected?.id
    setSelected(null)
    requestAnimationFrame(() => list.current?.querySelector<HTMLButtonElement>(`button[data-task-id="${id}"]`)?.focus())
  }
  return <UiModal label={selected ? '任务详情' : '任务'} onClose={onClose} wide className="dc-tasks-modal">
    <div ref={list} hidden={!!selected}><TaskCatalog api={api} onDetail={setSelected} revision={revision} /></div>
    {selected && <TaskDetails key={selected.id} api={api} row={selected} onBack={back} onChanged={() => setRevision((old) => old + 1)} />}
  </UiModal>
}
export function TaskCatalog({ api, onDetail, revision = 0 }: { api: CanvasApi; onDetail: (row: TaskRow) => void; revision?: number }) {
  const [draft, setDraft] = useState(initialDraft)
  const [range, setRange] = useState<DateTimeRange>({})
  const [query, setQuery] = useState<TaskSearchQuery>(initialQuery)
  const [result, setResult] = useState<TaskPage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [validation, setValidation] = useState('')
  const [copyFeedback, setCopyFeedback] = useState<{ id: string; message: string; failed: boolean } | null>(null)
  const bound = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (!copyFeedback) return
    const timer = setTimeout(() => setCopyFeedback(null), 2500)
    return () => clearTimeout(timer)
  }, [copyFeedback])
  useEffect(() => {
    const controller = new AbortController(); let live = true
    setLoading(true); setError('')
    void api.searchTasks(query, controller.signal).then((next) => {
      if (!live) return
      bound.current = next.upperBound; setResult(next)
    }).catch((reason) => { if (live && !controller.signal.aborted) setError(reason instanceof Error ? reason.message : '任务查询失败') })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false; controller.abort() }
  }, [api, query, revision])
  const apply = (reset = false) => {
    const next = reset ? { page: 1, pageSize: query.pageSize } : {
      ...Object.fromEntries(Object.entries(draft).map(([key, value]) => [key, value.trim()]).filter(([, value]) => value)),
      startTime: range.start, endTime: range.end, page: 1, pageSize: query.pageSize,
    }
    const parsed = TaskSearchQuerySchema.safeParse(next)
    if (!parsed.success) { setValidation(draft.taskId && !/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(draft.taskId.trim()) ? '请输入完整的任务 ID' : parsed.error.issues[0]?.message ?? '查询条件无效'); return }
    if (reset) { setDraft(initialDraft); setRange({}) }
    setValidation(''); bound.current = undefined; setQuery(parsed.data)
  }
  const move = (page: number, size: number = query.pageSize) => {
    setQuery({ ...query, page, pageSize: size as TaskSearchQuery['pageSize'], upperBound: bound.current })
  }
  const copyId = async (id: string) => {
    try { await copyText(id); setCopyFeedback({ id, message: '任务 ID 已复制', failed: false }) }
    catch { setCopyFeedback({ id, message: '复制失败，请重试', failed: true }) }
  }
  const page = result?.page ?? query.page
  return <section className="dc-task-catalog">
    <h2>任务</h2>
    <form className="dc-task-search" onSubmit={(event) => { event.preventDefault(); apply() }}>
      <div className="dc-task-search-fields">
        <label className="dc-task-id-filter">任务 ID<UiInput value={draft.taskId} maxLength={36} placeholder="输入完整任务 ID" onChange={(event) => setDraft({ ...draft, taskId: event.target.value })} /></label>
        <label>文件夹名称<UiInput value={draft.folderName} maxLength={160} placeholder="输入文件夹名称" onChange={(event) => setDraft({ ...draft, folderName: event.target.value })} /></label>
        <label>画布名称<UiInput value={draft.canvasName} maxLength={160} placeholder="输入画布名称" onChange={(event) => setDraft({ ...draft, canvasName: event.target.value })} /></label>
        <label className="dc-task-type-filter">任务类型<UiSelect label="任务类型" options={types} value={draft.type} onChange={(type) => setDraft({ ...draft, type })} /></label>
        <label className="dc-task-time-filter">提交时间<UiDateTimeRangePicker label="提交时间范围" value={range} onChange={setRange} /></label>
      </div>
      <div className="dc-task-search-actions">{validation && <span role="alert">{validation}</span>}
        <UiButton variant="outline" onClick={() => apply(true)}>重置</UiButton><UiButton variant="primary" type="submit" className="dc-task-query">查询</UiButton>
      </div>
    </form>
    {error && <div className="dc-task-query-error" role="alert">{error}<UiButton onClick={() => setQuery({ ...query })}>重新查询</UiButton></div>}
    <div className="dc-task-table-scroll" aria-busy={loading}>
      <table className="dc-task-table"><caption className="dc-sr-only">任务目录</caption>
        <colgroup><col className="task-id" /><col className="task-folder" /><col className="task-canvas" /><col className="task-node" /><col className="task-status" /><col className="task-time" /><col className="task-time" /><col className="task-action" /></colgroup>
        <thead><tr>{['任务 ID', '文件夹名称', '画布名称', '生成节点名称', '任务状态', '更新时间', '提交时间', '操作'].map((title) => <th key={title} scope="col">{title}</th>)}</tr></thead>
        <tbody>{loading || error ? <tr><td colSpan={8} className="dc-task-table-empty" role="status">{loading ? '正在查询任务…' : '任务查询失败，请重试'}</td></tr>
          : !result?.items.length ? <tr><td colSpan={8} className="dc-task-table-empty">暂无符合条件的任务</td></tr>
          : result.items.map((row) => <tr key={row.id}>
            <td><div className="dc-task-id-cell">
              <UiButton className="dc-task-copy-button" aria-label={`复制任务 ID ${row.id}`}
                title={copyFeedback?.id === row.id && !copyFeedback.failed ? '已复制' : '复制任务 ID'} onClick={() => void copyId(row.id)}>
                {copyFeedback?.id === row.id && !copyFeedback.failed
                  ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg>
                  : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></svg>}
              </UiButton><span className="dc-task-id" title={row.id} aria-label={row.id}>{row.id.slice(0, 16)}...</span>
            </div></td>
            <td title={row.folderName}>{row.folderName}</td><td title={row.canvasName}>{row.canvasName}</td><td title={row.nodeName}>{row.nodeName}</td>
            <td><span className={`dc-task-status-pill ${row.status}`}>{TaskStatusLabels[row.status]}</span></td>
            <td><time dateTime={new Date(row.updatedAt).toISOString()}>{formatTime(row.updatedAt)}</time></td>
            <td><time dateTime={new Date(row.createdAt).toISOString()}>{formatTime(row.createdAt)}</time></td>
            <td><UiButton className="dc-link-button" data-task-id={row.id} onClick={() => onDetail(row)}>查看详情</UiButton></td>
          </tr>)}</tbody>
      </table>
    </div>
    <div className="dc-task-footer">
      {copyFeedback && <span className={`dc-task-copy-feedback ${copyFeedback.failed ? 'failed' : ''}`} role={copyFeedback.failed ? 'alert' : 'status'}>{copyFeedback.message}</span>}
      <UiPagination total={result?.total ?? 0} page={page} pageSize={query.pageSize} disabled={loading || !!error}
        onPage={(next) => move(next)} onPageSize={(size) => move(1, size)} />
    </div>
  </section>
}
function TaskDetails({ api, row, onBack, onChanged }: { api: CanvasApi; row: TaskRow; onBack: () => void; onChanged: () => void }) {
  const [detail, setDetail] = useState<TaskDetail | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [acting, setActing] = useState(false)
  const [retry, setRetry] = useState(0)
  const back = useRef<HTMLButtonElement>(null)
  useEffect(() => { back.current?.focus() }, [])
  useEffect(() => {
    const controller = new AbortController(); let live = true
    setLoading(true); setError('')
    void api.taskDetail(row.canvasId, row.id, controller.signal).then((next) => { if (live) setDetail(next) })
      .catch((reason) => { if (live && !controller.signal.aborted) setError(reason instanceof Error ? reason.message : '详情加载失败') })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false; controller.abort() }
  }, [api, row.id, row.canvasId, retry])
  const act = async (action: TaskAction) => {
    if (action === 'abandon' && !window.confirm('结束本地等待不会取消外部任务，是否继续？')) return
    setActing(true); setError('')
    try { await api.taskAction(row.canvasId, row.id, action); onChanged(); setRetry((old) => old + 1) }
    catch (reason) { setError(reason instanceof Error ? reason.message : '任务操作失败') }
    finally { setActing(false) }
  }
  const task = detail?.task; const status = task?.status ?? row.status
  return <section className="dc-task-detail-view">
    <header><UiButton ref={back} variant="outline" onClick={onBack}>‹ 返回列表</UiButton><h2>任务详情</h2></header>
    {error && <p role="alert">{error}<UiButton onClick={() => setRetry((old) => old + 1)}>重试</UiButton></p>}
    <dl className="dc-task-detail-meta">
      <div><dt>任务 ID</dt><dd className="dc-task-id">{row.id}</dd></div>
      <div><dt>任务状态</dt><dd><span className={`dc-task-status-pill ${status}`}>{TaskStatusLabels[status]}</span></dd></div>
      <div><dt>文件夹名称</dt><dd>{row.folderName}</dd></div><div><dt>画布名称</dt><dd>{row.canvasName}</dd></div>
      <div><dt>生成节点名称</dt><dd>{row.nodeName}</dd></div><div><dt>任务类型</dt><dd>{types.find((type) => type.value === row.type)?.label}</dd></div>
      <div><dt>更新时间</dt><dd>{formatTime(task?.updatedAt ?? row.updatedAt)}</dd></div><div><dt>提交时间</dt><dd>{formatTime(row.createdAt)}</dd></div>
    </dl>
    {loading ? <p role="status">载入详情…</p> : detail && <>
      {task && <div className="dc-task-detail-block"><h3>提交内容</h3><p>模型：{task.snapshot.model.name}</p>
        <p className="dc-task-detail-prompt">{task.snapshot.prompt}</p><pre>{JSON.stringify(task.snapshot.params, null, 2)}</pre></div>}
      <div className="dc-task-detail-block"><h3>执行结果</h3>
        {detail.externalTaskId && <p>外部任务 ID：<span className="dc-task-id">{detail.externalTaskId}</span></p>}
        {detail.externalCompletedAt !== null && <p>外部完成时间：{formatTime(detail.externalCompletedAt)}</p>}
        {detail.successAt !== null && <p>本地保存成功：{formatTime(detail.successAt)}</p>}
        {detail.failureMessage && <p className="dc-task-error">{detail.failureStage} · {detail.failureCode}：{detail.failureMessage}</p>}
        <p>执行步骤：{detail.attempts.map((attempt) => `${attempt.step}（${attempt.outcome ?? '处理中'}）`).join(' → ') || detail.phase}</p>
      </div>
      {['unknown', 'save_failed'].includes(status) && <div className="dc-task-actions">
        {status === 'save_failed' && <UiButton disabled={acting} variant="outline" onClick={() => void act('retry-save')}>重试保存结果</UiButton>}
        {status === 'unknown' && detail.externalTaskId && <UiButton disabled={acting} variant="outline" onClick={() => void act('resume-query')}>恢复查询</UiButton>}
        <UiButton disabled={acting} variant="outline" onClick={() => void act('abandon')}>结束本地等待</UiButton>
      </div>}
    </>}
  </section>
}
