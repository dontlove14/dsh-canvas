import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode, type RefObject } from 'react'
import { BorderBeam } from 'border-beam'
import { ThinkingOrb } from 'thinking-orbs'
import { TRACKED_STATUSES, TaskStatusLabels, type TaskStatus } from '../shared/contracts'
import type { TaskSummary } from '../shared/v2'
import { useLoadingPixelRatio } from './loadingResolution'
import { MediaLoadingEffect } from './MediaLoadingEffect'
import { observeVisibility } from './observeVisibility'

type Environment = { theme: 'dark' | 'light'; ink: string; surface?: string; paused: boolean }
const useDomEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect
export const NodeLoadingContext = createContext<Environment>({ theme: 'dark', ink: '#efedf4', paused: false })
const NodeMediaContext = createContext<{ loading: boolean; report: (id: string, loading: boolean) => void } | null>(null)
export const TaskDetailNavigationContext = createContext<((task: Pick<TaskSummary, 'id' | 'workspaceId'>) => void) | null>(null)

/** Media children contribute readiness without changing graph or task data. */
export function NodeLoadingBoundary({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set())
  const report = useCallback((id: string, loading: boolean) => setPending((old) => {
    if (old.has(id) === loading) return old
    const next = new Set(old)
    if (loading) next.add(id); else next.delete(id)
    return next
  }), [])
  const value = useMemo(() => ({ loading: pending.size > 0, report }), [pending, report])
  return <NodeMediaContext.Provider value={value}>{children}</NodeMediaContext.Provider>
}

/** Returns whether a node already owns the indicator, avoiding nested loaders. */
export function useNodeMediaLoading(loading: boolean): boolean {
  const context = useContext(NodeMediaContext), id = useId()
  const report = context?.report
  useDomEffect(() => {
    report?.(id, loading)
    return () => report?.(id, false)
  }, [id, loading, report])
  return !!context
}

/** One subscription per workspace; the libraries receive the actual Harness theme. */
export function useNodeLoadingEnvironment(root: RefObject<HTMLElement>, active: boolean): Environment {
  const [appearance, setAppearance] = useState({ theme: 'dark' as 'dark' | 'light', ink: '#efedf4', surface: '#202023' })
  const [reduced, setReduced] = useState(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false)
  useDomEffect(() => {
    const element = root.current
    if (!element) return
    const resolve = () => {
      const style = getComputedStyle(element)
      const scheme = style.colorScheme
      const host = style.getPropertyValue('--dsw-alias-bg-base').trim()
      const theme = document.body.hasAttribute('data-ds-dark-theme') ? 'dark'
        : scheme === 'light' ? 'light' : scheme === 'dark' ? 'dark' : host ? 'light' : 'dark'
      // Computed Harness text colors are rgb(); use the library's supported tint.
      const ink = /^(#[\da-f]{3}(?:[\da-f]{3})?|rgba?\()/i.test(style.color)
        ? style.color : theme === 'dark' ? '#efedf4' : '#202023'
      const hostSurface = style.getPropertyValue('--dc-surface').trim()
      const surface = hostSurface && !hostSurface.includes('var(') ? hostSurface : theme === 'dark' ? '#202023' : '#ffffff'
      setAppearance((old) => old.theme === theme && old.ink === ink && old.surface === surface ? old : { theme, ink, surface })
    }
    resolve()
    const observer = new MutationObserver(resolve)
    // Watch the actual ancestor chain, never every node/media change in the DOM.
    for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
      observer.observe(ancestor, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'data-theme', 'class', 'style'] })
    }
    observer.observe(document.head, { childList: true, subtree: true, characterData: true })
    const system = window.matchMedia?.('(prefers-color-scheme: dark)')
    system?.addEventListener('change', resolve)
    return () => { observer.disconnect(); system?.removeEventListener('change', resolve) }
  }, [root])
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (!media) return
    const change = () => setReduced(media.matches)
    change(); media.addEventListener('change', change)
    return () => media.removeEventListener('change', change)
  }, [])
  return useMemo(() => ({ ...appearance, paused: !active || reduced }), [appearance, active, reduced])
}

// Only pause/visibility overrides. Geometry and all keyframes come from Beam.
export const beamPauseCss = `
[data-beam="{id}"][data-loading-paused] { --beam-opacity-{id}: 1 !important; }
[data-beam="{id}"][data-loading-paused],
[data-beam="{id}"][data-loading-paused]::before,
[data-beam="{id}"][data-loading-paused]::after,
[data-beam="{id}"][data-loading-paused] [data-beam-bloom] { animation-play-state: paused !important; }
@media (prefers-reduced-motion: reduce) {
  [data-beam="{id}"] { --beam-opacity-{id}: 1 !important; }
  [data-beam="{id}"], [data-beam="{id}"]::before, [data-beam="{id}"]::after,
  [data-beam="{id}"] [data-beam-bloom] { animation-play-state: paused !important; }
}`

export function NodeLoading({ task, title, mediaLoading = false, compact = false }: {
  task?: Pick<TaskSummary, 'status' | 'progress'> & Partial<Pick<TaskSummary, 'id' | 'workspaceId'>>; title: string; mediaLoading?: boolean; compact?: boolean
}) {
  const media = useContext(NodeMediaContext)
  const openTask = useContext(TaskDetailNavigationContext)
  if (task && (task.status === 'failed' || task.status === 'unknown' || task.status === 'save_failed')) {
    const icon = <svg className="dc-node-failure-icon" viewBox="0 0 1024 1024" aria-hidden="true">
      <path d="M932.829867 441.258667A432.7424 432.7424 0 0 1 938.666667 512c0 235.639467-191.0272 426.666667-426.666667 426.666667S85.333333 747.639467 85.333333 512 276.360533 85.333333 512 85.333333a424.9088 424.9088 0 0 1 270.848 96.9728" fill="#FFFFFF" />
      <path d="M512 955.733333C267.332267 955.733333 68.266667 756.6848 68.266667 512 68.266667 267.332267 267.332267 68.266667 512 68.266667a444.501333 444.501333 0 0 1 281.7024 100.864 17.066667 17.066667 0 0 1-21.691733 26.368A410.197333 410.197333 0 0 0 512 102.4C286.1568 102.4 102.4 286.1568 102.4 512s183.7568 409.6 409.6 409.6 409.6-183.7568 409.6-409.6a414.037333 414.037333 0 0 0-5.597867-67.9424 17.066667 17.066667 0 1 1 33.655467-5.614933A445.0304 445.0304 0 0 1 955.733333 512c0 244.6848-199.048533 443.733333-443.733333 443.733333z" fill="#F35B5B" />
      <path d="M343.057067 732.142933a51.165867 51.165867 0 0 1-36.1984-87.3984l337.902933-337.902933a51.165867 51.165867 0 0 1 72.3968 0 51.165867 51.165867 0 0 1 0 72.3968l-337.902933 337.92a51.0976 51.0976 0 0 1-36.1984 14.984533z" fill="#F35B5B" />
      <path d="M680.942933 732.142933a51.029333 51.029333 0 0 1-36.1984-15.0016L306.8416 379.255467a51.165867 51.165867 0 0 1 0-72.3968 51.165867 51.165867 0 0 1 72.3968 0L717.141333 644.7616a51.165867 51.165867 0 0 1-36.1984 87.381333z" fill="#F35B5B" />
    </svg>
    return <div className="dc-node-failure" data-task-status={task.status} data-compact={compact ? '' : undefined}>
      {openTask && task.id && task.workspaceId
        ? <button type="button" className="dc-node-failure-button nodrag nopan" title="查看失败原因" aria-label={`${title}：查看任务详情`}
          onPointerDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}
          onClick={(event) => { event.stopPropagation(); openTask({ id: task.id!, workspaceId: task.workspaceId! }) }}>{icon}</button>
        : icon}
      <span className="dc-sr-only" role="status" aria-live="polite" aria-atomic="true" aria-label={`${title}状态`}>{TaskStatusLabels[task.status]}</span>
    </div>
  }
  const phase = task && TRACKED_STATUSES.has(task.status) ? task.status : (mediaLoading || media?.loading) ? 'media-loading' : null
  return phase ? <TrackedNodeLoading phase={phase} task={task} title={title} compact={compact} /> : null
}

function TrackedNodeLoading({ phase, task, title, compact }: {
  phase: TaskStatus | 'media-loading'; task?: Pick<TaskSummary, 'status' | 'progress'>; title: string; compact: boolean
}) {
  const { theme, ink, surface, paused: environmentPaused } = useContext(NodeLoadingContext)
  const frame = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  const [radius, setRadius] = useState(10)
  const [inNode, setInNode] = useState(false)
  useDomEffect(() => { setInNode(!!frame.current?.closest('.dc-node')) }, [])
  useEffect(() => {
    const element = frame.current
    if (element) {
      const value = parseFloat(getComputedStyle(element.closest('.dc-node') ?? element).borderTopLeftRadius)
      if (Number.isFinite(value)) setRadius(value)
    }
    return observeVisibility(element, setVisible)
  }, [])
  const paused = environmentPaused || !visible
  const preset = phase === 'generating' ? 'md' : phase === 'saving' ? 'pulse-outside' : 'pulse-inner'
  const orb = phase === 'generating' ? 'working' : phase === 'saving' ? 'weaving' : 'connecting'
  const progress = phase !== 'media-loading' && typeof task?.progress === 'number' && Number.isFinite(task.progress)
    ? ` ${Math.round(Math.max(0, Math.min(100, task.progress)))}%` : ''
  const status = <span className="dc-node-loading-label dc-sr-only" role="status" aria-live="polite" aria-atomic="true" aria-label={`${title}状态`}>
    {phase === 'media-loading' ? '正在加载媒体' : TaskStatusLabels[phase]}{progress}
  </span>
  if (phase === 'media-loading') return <div ref={frame} className="dc-node-loading dc-node-media-loading" data-task-status={phase}
    data-loading-preset="pixels-organic" data-loading-theme={theme} data-loading-paused={paused ? '' : undefined}>
    <MediaLoadingEffect theme={theme} surface={surface ?? (theme === 'dark' ? '#202023' : '#ffffff')} paused={paused} radius={radius} />
    {status}
  </div>
  return <div ref={frame} className="dc-node-loading" data-task-status={phase} data-loading-preset={preset}>
    {typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? <BorderBeam
      // Pulse presets use the dependency's JS oscillator. Switching to static md
      // tears it down while hidden/reduced; pausing CSS alone would leave JS running.
      size={paused ? 'md' : preset} colorVariant="mono" theme={theme} strength={.75} borderRadius={radius}
      className="dc-node-loading-beam" data-loading-paused={paused ? '' : undefined} data-loading-theme={theme} css={beamPauseCss}>
      <div className="dc-node-loading-content">
        <TaskLoadingOrb compact={compact} inNode={inNode} state={orb} theme={theme} ink={ink} paused={paused} />
        {status}
      </div>
    </BorderBeam> : <div className="dc-node-loading-content">{status}</div>}
  </div>
}

function TaskLoadingOrb({ compact, inNode, state, theme, ink, paused }: {
  compact: boolean; inNode: boolean; state: ComponentProps<typeof ThinkingOrb>['state']
  theme: 'light' | 'dark'; ink: string; paused: boolean
}) {
  const pixelRatio = useLoadingPixelRatio(inNode)
  return <ThinkingOrb size={compact ? 20 : 64} pixelRatio={pixelRatio} state={state} theme={theme} color={ink} paused={paused} aria-hidden="true" />
}
