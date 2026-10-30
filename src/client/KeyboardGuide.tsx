import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { UiButton } from './ui'
import { useCanvasTextSelectionScope } from './canvasTextSelection'
import commandSvg from './icons/command.svg?raw'
import ctrlSvg from './icons/ctrl.svg?raw'

const commandPath = commandSvg.match(/\bd="([^"]+)"/)![1]
const ctrlPath = ctrlSvg.match(/\bd="([^"]+)"/)![1]

export function isMacPlatform(): boolean {
  return /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent)
}
function Key({ children }: { children: ReactNode }) { return <kbd>{children}</kbd> }
export function Modifier({ mac }: { mac: boolean }) {
  // Keep the supplied paths; trim Ctrl's square-export whitespace for a readable keycap.
  return <Key><svg width={mac ? 15 : 28} height="15" viewBox={mac ? '0 0 1024 1024' : '64 288 896 448'}
    fill="currentColor" aria-label={mac ? 'Command' : 'Ctrl'} role="img">
    <path d={mac ? commandPath : ctrlPath} />
  </svg></Key>
}
export function KeyboardGuide({ enabled, container }: { enabled: boolean; container: RefObject<HTMLElement> }) {
  const [open, setOpen] = useState(false), [position, setPosition] = useState({ left: 12, top: 12, width: 760, maxHeight: 500 })
  const anchor = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null)
  const scope = useCanvasTextSelectionScope(), id = useId(), mac = isMacPlatform()
  const close = (focus = false) => { setOpen(false); if (focus) anchor.current?.focus({ preventScroll: true }) }
  useEffect(() => { if (!enabled) setOpen(false) }, [enabled])
  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const rect = container.current?.getBoundingClientRect(), button = anchor.current?.getBoundingClientRect()
      if (!rect || !button) return
      const left = Math.max(12, rect.left + 12), right = Math.min(window.innerWidth - 12, rect.right - 12)
      const top = Math.max(12, rect.top + 12), bottom = Math.min(window.innerHeight - 12, button.top - 14)
      const width = Math.max(1, Math.min(760, right - left)), maxHeight = Math.max(1, bottom - top)
      const height = Math.min(panel.current?.scrollHeight || 340, maxHeight)
      setPosition({ left: Math.max(left, Math.min(button.right - width, right - width)), top: Math.max(top, bottom - height), width, maxHeight })
    }
    place()
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(place) : undefined
    if (container.current) observer?.observe(container.current)
    if (panel.current) observer?.observe(panel.current)
    window.addEventListener('resize', place)
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true })
    return () => { observer?.disconnect(); window.removeEventListener('resize', place) }
  }, [open, container])
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node) && !anchor.current?.contains(event.target as Node)) close()
    }
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true) } }
    const blur = () => close()
    document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', key, true); window.addEventListener('blur', blur)
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', key, true); window.removeEventListener('blur', blur) }
  }, [open])
  const rows: { title: string; entries: [string, ReactNode][] }[] = [
    { title: '选择与连接', entries: [
      ['框选节点', <Key>左键拖动</Key>], ['追加框选', <><Key>Shift</Key><span>+</span><Key>左键拖动</Key></>],
      ['追加 / 取消选择', <><Modifier mac={mac} /><span>+</span><Key>单击</Key></>],
      ['复制节点', <><Modifier mac={mac} /><span>+</span><Key>C</Key></>],
      ['粘贴节点', <><Modifier mac={mac} /><span>+</span><Key>V</Key></>],
      ['连接引用', <Key>输出端点拖到节点</Key>], ['批量连接', <Key>框选输出端点拖动</Key>],
    ] },
    { title: '移动画布', entries: [
      ['平移', <><Key>Space</Key><span>+</span><Key>左键拖动</Key></>], ['平移', <Key>中键 / 右键拖动</Key>],
      ['平移', <Key>滚轮 / 双指移动</Key>], ['移动选中节点', <Key>方向键</Key>], ['大步移动', <><Key>Shift</Key><span>+</span><Key>方向键</Key></>],
    ] },
    { title: '缩放与删除', entries: [
      ['缩放', <><Modifier mac={mac} /><span>+</span><Key>滚轮</Key></>], ['缩放', <Key>双指捏合</Key>],
      ['放大画布', <Key>双击空白</Key>], ['删除节点 / 连线', <Key>Delete / Backspace</Key>], ['关闭菜单 / 弹窗', <Key>Esc</Key>],
    ] },
    { title: '提示词编辑', entries: [
      ['撤销', <><Modifier mac={mac} /><span>+</span><Key>Z</Key></>],
      ['重做', <><Modifier mac={mac} /><span>+</span><Key>Shift</Key><span>+</span><Key>Z</Key></>],
      ...(!mac ? [['重做', <><Modifier mac={false} /><span>+</span><Key>Y</Key></>] as [string, ReactNode]] : []),
      ['引用素材', <Key>@</Key>], ['选择候选', <Key>↑ / ↓</Key>], ['确认候选', <Key>Enter / Tab</Key>],
    ] },
  ]
  return <>
    <UiButton ref={anchor} disabled={!enabled} className="dc-keyboard-trigger" title="快捷键" aria-label="快捷键"
      aria-haspopup="dialog" aria-expanded={open && enabled} aria-controls={open ? id : undefined} onClick={() => setOpen((value) => !value)}>
      <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
        <rect x="2.5" y="5" width="19" height="14" rx="3" /><path d="M6 9h.1M10 9h.1M14 9h.1M18 9h.1M6 12h.1M10 12h.1M14 12h.1M18 12h.1M7 15h10" />
      </svg>
    </UiButton>
    {open && enabled && createPortal(<div ref={panel} id={id} role="dialog" aria-label="快捷键指引"
      className={`dc-overlay-scope dc-keyboard-guide nodrag nopan nowheel ${scope}`} data-columns={position.width < 340 ? 1 : position.width < 660 ? 2 : 4}
      style={position} onKeyDown={(event) => event.stopPropagation()}>
      <div className="dc-keyboard-heading"><strong>快捷键</strong><UiButton aria-label="关闭快捷键指引" onClick={() => close(true)}>×</UiButton></div>
      <div className="dc-keyboard-columns">{rows.map((group) => <section key={group.title}><h3>{group.title}</h3>
        <dl>{group.entries.map(([label, keys], index) => <div key={index}><dt>{label}</dt><dd>{keys}</dd></div>)}</dl>
      </section>)}</div>
      <p>方向键移动需先聚焦节点；提示词快捷键仅在输入区生效。删除被 @ 引用的连线需要确认。</p>
    </div>, document.body)}
  </>
}
