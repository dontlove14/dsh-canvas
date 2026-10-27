import { useEffect, useState } from 'react'
import { UiButton, UiInput, UiSelect } from './ui'

export function paginationPages(page: number, count: number): Array<number | 'ellipsis-left' | 'ellipsis-right'> {
  if (count <= 7) return Array.from({ length: count }, (_, index) => index + 1)
  const start = Math.max(2, Math.min(page - 1, count - 4))
  const end = Math.min(count - 1, Math.max(page + 1, 5))
  return [1, ...(start > 2 ? ['ellipsis-left' as const] : []),
    ...Array.from({ length: end - start + 1 }, (_, index) => start + index),
    ...(end < count - 1 ? ['ellipsis-right' as const] : []), count]
}
export interface UiPaginationProps {
  total: number; page: number; pageSize: number; onPage: (page: number) => void; onPageSize: (size: number) => void; disabled?: boolean
}
export function UiPagination({ total, page, pageSize, onPage, onPageSize, disabled }: UiPaginationProps) {
  const count = Math.max(1, Math.ceil(total / pageSize))
  const [jump, setJump] = useState(String(page))
  useEffect(() => { setJump(String(page)) }, [page])
  const commit = () => {
    if (!/^\d+$/.test(jump)) { setJump(String(page)); return }
    const next = Math.min(count, Math.max(1, Number(jump)))
    setJump(String(next)); if (next !== page) onPage(next)
  }
  return <nav className="dc-pagination" aria-label="任务分页">
    <span className="dc-pagination-total">共 {total} 条</span>
    <UiSelect label="每页条数" value={pageSize} disabled={disabled}
      options={[10, 20, 50, 100].map((size) => ({ value: String(size), label: `${size}条/页` }))} onChange={(size) => onPageSize(Number(size))} />
    <UiButton aria-label="上一页" disabled={disabled || page <= 1} onClick={() => onPage(page - 1)}>‹</UiButton>
    {paginationPages(page, count).map((item) => typeof item === 'number'
      ? <UiButton key={item} aria-label={`第${item}页`} aria-current={item === page ? 'page' : undefined}
        className={item === page ? 'current' : ''} disabled={disabled} onClick={() => { if (item !== page) onPage(item) }}>{item}</UiButton>
      : <span key={item} aria-hidden="true" className="dc-pagination-ellipsis">…</span>)}
    <UiButton aria-label="下一页" disabled={disabled || page >= count} onClick={() => onPage(page + 1)}>›</UiButton>
    <label className="dc-pagination-jump">前往<UiInput aria-label="跳转页码" inputMode="numeric" value={jump} disabled={disabled}
      onChange={(event) => setJump(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commit() } }} />页</label>
  </nav>
}
