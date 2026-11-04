import type { Context } from '@deepseek-ai/cordis'
import { InputTriggerController, type InputTriggerSource, type InputTriggerControllerDeps, type TriggerGuard } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { ChatReferenceChoices, ChatReferenceBrowse, ReferenceFolder } from '../shared/chatReferences'
import { CHAT_REFERENCE_SOURCE, ChatReferenceSchema, referenceText } from '../shared/chatReferences'
import { CANVAS_PRESET } from '../shared/agent'
import type { CanvasApi } from './api'
import type { CanvasPresentationClient } from './presentation'

/** Only the detection projection changes; editor offsets and native revision guards remain exact. */
export function hashDetectionText(text: string, caret: number): string | undefined {
  const prefix = text.slice(0, caret)
  const match = /#(?:"[^"\n]*|[^\s#@"]*)$/u.exec(prefix)
  if (!match) return
  const offset = match.index
  // Native @ grammar needs whitespace. Mask only the preceding code point in
  // this detection copy, keeping UTF16 lengths and the editor's original span.
  const before = text.slice(0, offset).replace(/\S$/u, (character) => ' '.repeat(character.length))
  return before + '@' + text.slice(offset + 1)
}
export function chatReferenceSource(sessionId: string, api: Pick<CanvasApi, 'referenceChoices' | 'resolveReference'>, available = () => true, currentCanvas?: () => string | null,
  prepareReference?: (canvasId: string, signal: AbortSignal) => Promise<void>): InputTriggerSource {
  type Step = { label: string; path: string; folderId?: string | null; browseCanvasId?: string; nodeId?: string; taskId?: string }
  let steps: Step[] = [], context = currentCanvas?.(), issued = new Set<string>(), discardedPath = ''
  let page: { cursor?: string; search: string; path: string } | undefined, pageSequence = 0
  const pathName = (name: string) => name.replace(/[/"#@\n\r]/g, (c) => ({ '/': '／', '"': '＂', '#': '＃', '@': '＠' }[c] ?? ' '))
  const browseValue = (next: Step[]) => JSON.stringify({ browse: next, context })
  const folderStep = (folder: ReferenceFolder): Step => ({ label: folder.name, path: `画布/${pathName(folder.name)}/`, folderId: folder.id })
  const canvasStep = (folder: ReferenceFolder, canvas: ReferenceFolder['canvases'][number]): Step =>
    ({ label: canvas.name, path: `${folderStep(folder).path}${pathName(canvas.name)}/`, folderId: folder.id, browseCanvasId: canvas.id })
  const sync = (query: string) => {
    const next = currentCanvas?.()
    if (next !== context) { discardedPath = steps.at(-1)?.path ?? ''; steps = []; page = undefined; issued.clear(); context = next }
    if (discardedPath && !query.startsWith(discardedPath)) discardedPath = ''
    if (steps.length && !query.startsWith(steps.at(-1)!.path)) { steps = []; page = undefined; issued.clear() }
    if (page && !query.startsWith(page.path)) page = undefined
  }
  return {
    name: CHAT_REFERENCE_SOURCE, trigger: '@', showGroupTitle: false,
    header(_session, { query }) {
      sync(query)
      if (!steps.length && !page) return
      return [{ label: '画布', value: browseValue([]) }, ...steps.map((step, index) => ({
        label: step.label, value: browseValue(steps.slice(0, index + 1)), current: index === steps.length - 1,
      }))]
    },
    async candidates(_session, { query, signal }) {
      if (!available()) return []
      sync(query)
      const captured = context, scope = steps.at(-1), search = query.slice(page?.path.length ?? scope?.path.length ?? discardedPath.length)
      if (page && page.search !== search) { page.search = search; page.cursor = undefined }
      const browse: ChatReferenceBrowse = { ...(currentCanvas ? { currentCanvasId: captured } : {}),
        view: 'node-media',
        ...(scope ? { folderId: scope.folderId, browseCanvasId: scope.browseCanvasId, nodeId: scope.nodeId, taskId: scope.taskId } : {}),
        ...(page?.cursor ? { cursor: page.cursor } : {}) }
      signal.throwIfAborted()
      let choices: ChatReferenceChoices
      try {
        const canvasId = scope?.browseCanvasId ?? captured
        if (canvasId) await prepareReference?.(canvasId, signal)
        signal.throwIfAborted()
        choices = await api.referenceChoices(sessionId, search, signal, browse)
      } catch (error) {
        if ((error as { status?: number }).status === 403) return []
        if (page?.cursor && (error as { code?: string }).code === 'REFERENCE_STALE') {
          page.cursor = undefined
          const { cursor: _cursor, ...restart } = browse
          choices = await api.referenceChoices(sessionId, search, signal, restart)
        } else throw error
      }
      signal.throwIfAborted()
      if (!available() || !choices.preset || captured !== currentCanvas?.()) return []
      const media = choices.media.map((item) => ({ name: item.label, description: item.description, icon: 'file' as const,
        section: item.section, value: JSON.stringify(item.ref) }))
      const matches = (name: string) => !search || name.toLocaleLowerCase().includes(search.toLocaleLowerCase())
      const canvasRow = (folder: ReferenceFolder, canvas: ReferenceFolder['canvases'][number], expanded = false) => ({
        name: `${canvas.name}/`, description: expanded ? canvas.id === choices.currentCanvasId ? '当前画布' : '最近编辑的画布' : '点击选择资源',
        icon: 'folder' as const, drill: true, section: `画布 · ${folder.name}${expanded ? ` · ${canvas.name}` : ''}`,
        value: browseValue([folderStep(folder), canvasStep(folder, canvas)]),
      })
      const directories = choices.folders ?? []
      const top = directories.find((folder) => folder.canvases.some((canvas) => canvas.id === choices.expandedCanvasId))
      const expanded = top?.canvases.find((canvas) => canvas.id === choices.expandedCanvasId)
      const nodeSteps = (nodeId: string, label: string): Step[] => {
        if (!top || !expanded) return []
        const base = [folderStep(top), canvasStep(top, expanded)]
        return [...base, { ...base[1], nodeId, label, path: `${base[1].path}${pathName(label)}/` }]
      }
      const entries = choices.items?.map((item) => {
        if (item.type === 'media') return { name: item.label, description: item.description, icon: 'file' as const, section: item.section, value: JSON.stringify(item.ref) }
        if (item.type === 'directory') {
          const base = steps.slice(0, 3), parent = base.at(-1)!
          return { name: `${item.label}/`, description: item.description, icon: 'folder' as const, section: item.section, drill: true,
            value: browseValue([...base, { ...parent, taskId: item.taskId, label: item.label, path: `${parent.path}${pathName(item.label)}/` }]) }
        }
        return { name: item.label, description: item.description, icon: 'session' as const, section: item.section, drill: item.hasMedia,
          hint: item.hasMedia ? '素材' : undefined,
          value: JSON.stringify({ ref: item.ref, browse: nodeSteps(item.ref.nodeId, item.label), context }) }
      }) ?? media
      const results = [
        ...(!scope && top && expanded ? [canvasRow(top, expanded, true)] : []),
        ...entries,
        ...(choices.nextCursor ? [{ name: '继续浏览…', description: '更多节点与素材', icon: 'folder' as const, drill: true,
          value: JSON.stringify({ page: choices.nextCursor, search, context }) }] : []),
        ...(scope?.browseCanvasId ? [] : scope ? directories.filter((folder) => folder.id === scope.folderId)
          .flatMap((folder) => folder.canvases.filter((canvas) => matches(canvas.name)).map((canvas) => canvasRow(folder, canvas)))
          : [
            ...(top?.canvases.filter((canvas) => canvas.id !== expanded?.id && matches(canvas.name)).map((canvas) => canvasRow(top, canvas)) ?? []),
            ...directories.filter((folder) => folder !== top && (matches(folder.name) || folder.canvases.some((canvas) => matches(canvas.name))))
              .map((folder) => ({ name: `${folder.name}/`, description: `${folder.canvases.length} 个画布`, section: '画布', icon: 'folder' as const,
                drill: true, value: browseValue([folderStep(folder)]) })),
          ]),
      ]
      issued = new Set(results.flatMap((item) => item.value ? [item.value] : []))
      return results
    },
    onPick({ candidate, action }) {
      if (!available() || !candidate.value) return
      const value = JSON.parse(candidate.value)
      if ('page' in value) {
        if (!issued.has(candidate.value) || value.context !== currentCanvas?.()) return
        page = { cursor: value.page, search: value.search, path: `${steps.at(-1)?.path ?? ''}更多${++pageSequence}/` }
        return { text: `#"${page.path}${value.search}`, continue: true }
      }
      if ('browse' in value && (!('ref' in value) || action === 'drill')) {
        if (value.context !== currentCanvas?.()) return
        if ('ref' in value && !issued.has(candidate.value)) return
        steps = value.browse; discardedPath = ''; page = undefined
        return { text: steps.length ? `#"${steps.at(-1)!.path}` : '#', continue: true }
      }
      if (!issued.has(candidate.value) || context !== currentCanvas?.()) return
      const ref = ChatReferenceSchema.parse(value.ref ?? value)
      return { insert: { source: CHAT_REFERENCE_SOURCE, ref: JSON.stringify(ref), label: `#${ref.label}`, appearance: 'file', clipboardText: referenceText(ref) } }
    },
    codec: {
      clipboardText: (ref) => referenceText(ChatReferenceSchema.parse(JSON.parse(ref))),
      serialize: async (ref, signal) => {
        const check = () => {
          signal.throwIfAborted()
          if (!available()) throw new Error('请切换到「无限画布」预设后发送 # 引用')
        }
        check()
        const parsed = ChatReferenceSchema.parse(JSON.parse(ref))
        if (parsed.kind === 'node') await prepareReference?.(parsed.canvasId, signal)
        check()
        const result = await api.resolveReference(sessionId, parsed, signal)
        check()
        return result.text
      },
    },
  }
}
/** Adapt the public native controller behind the public session resolver, without modifying Harness files. */
export function hashController(original: InputTriggerController, deps: InputTriggerControllerDeps, source: InputTriggerSource, available = () => true) {
  const hash = new InputTriggerController({ ...deps, roster: { all: () => [source], sources: (trigger) => trigger === '@' ? [source] : [] } })
  let current = original, enabled = true
  let availability = available(), lastTrack: Parameters<InputTriggerController['track']> | undefined
  const watchers = new Set<() => void>()
  const stores = ['menu', 'headers', 'launcher'] as const
  const notify = () => { for (const listener of watchers) listener() }
  const off = stores.flatMap((key) => [original[key].subscribe(notify), hash[key].subscribe(notify)])
  const projected = Object.fromEntries(stores.map((key) => [key, {
    getSnapshot: () => current[key].getSnapshot(),
    subscribe: (listener: () => void) => { watchers.add(listener); return () => { watchers.delete(listener) } },
  }]))
  const switchTo = (controller: InputTriggerController) => { if (current !== controller) { current = controller; notify() } }
  const track = (draft: string, caret: number, guard: TriggerGuard, revision: number) => {
    lastTrack = [draft, caret, guard, revision]
    availability = enabled && available()
    const detection = availability && guard.tier !== 'frozen' ? hashDetectionText(draft, caret) : undefined
    if (detection !== undefined) {
      original.track(draft, caret, { tier: 'frozen' }, revision)
      switchTo(hash); hash.track(detection, caret, guard, revision)
    } else {
      hash.track('', 0, { tier: 'frozen' }, revision)
      switchTo(original); original.track(draft, caret, guard, revision)
    }
  }
  const refreshAvailability = () => {
    if (!enabled || availability === available()) return
    if (lastTrack) track(...lastTrack)
    else availability = available()
  }
  const controller = new Proxy(original, {
    get(target, key) {
      if (key in projected) return projected[key as keyof typeof projected]
      if (key === 'track') return track
      if (key === 'serializeReference') return (owner: string, ...args: Parameters<InputTriggerController['serializeReference']> extends [string, ...infer Rest] ? Rest : never) =>
        (owner === CHAT_REFERENCE_SOURCE && enabled ? hash : original).serializeReference(owner, ...args)
      if (key === 'openReference') return (owner: string | undefined, ref: Parameters<InputTriggerController['openReference']>[1]) =>
        owner === CHAT_REFERENCE_SOURCE && !available() ? false : (owner === CHAT_REFERENCE_SOURCE && enabled ? hash : original).openReference(owner, ref)
      if (key === 'dismiss') return () => { hash.dismiss(); original.dismiss() }
      if (key === 'toggleSource') return (...args: Parameters<InputTriggerController['toggleSource']>) => {
        hash.dismiss(); switchTo(original); original.toggleSource(...args)
      }
      const interactive = ['pick', 'pickCrumb', 'hover', 'arbitrate', 'onSpace', 'refreshOpenMenu'].includes(String(key))
      if (interactive) refreshAvailability()
      const active = interactive ? current : target
      const value = Reflect.get(active, key, active)
      return typeof value === 'function' ? value.bind(active) : value
    },
  })
  const refreshContext = () => {
    if (!enabled || !lastTrack || current !== hash || !hash.menu.getSnapshot().open) return
    // Native refresh retains old rows. Freeze first to abort and clear them;
    // dismissal would incorrectly mark the unchanged # token as ignored.
    hash.track('', 0, { tier: 'frozen' }, lastTrack[3])
    track(...lastTrack)
  }
  return { controller, refreshAvailability, refreshContext, dispose: () => {
    if (!enabled) return
    enabled = false; hash.dispose(); switchTo(original)
    for (const dispose of off) dispose()
    notify(); watchers.clear()
  } }
}
export function installChatReferenceTrigger(ctx: Context, api: CanvasApi, presentation?: CanvasPresentationClient) {
  const service = ctx.inputTriggers, original = service.sessionOf, adapters = new Map<object, ReturnType<typeof hashController>>()
  const resolve = (actx: Context) => {
    const native = original.call(service, actx)
    const session = ctx.sessions.sessionOf(actx)
    const binding = session && ctx.sessions.binding(session.sessionId)
    if (!binding || binding.session !== session) return native
    let adapter = adapters.get(binding)
    if (!adapter) {
      const preset = binding.session.projections.faceOf('agentPreset')
      const available = () => ctx.sessions.binding(binding.sessionId) === binding && preset.getSnapshot() === CANVAS_PRESET
      const created = hashController(native, { actx: binding.ctx, sessionId: binding.sessionId, roster: { all: () => [], sources: () => [] } },
        chatReferenceSource(binding.sessionId, api, available, presentation ? () => presentation.currentCanvas(binding.sessionId) : undefined,
          presentation ? (canvasId, signal) => presentation.prepareReference(canvasId, signal) : undefined), available)
      const off = preset.subscribe(created.refreshAvailability)
      let canvas = presentation?.currentCanvas(binding.sessionId)
      const offViews = presentation?.subscribeViews(() => {
        const next = presentation.currentCanvas(binding.sessionId)
        if (canvas === next) return
        canvas = next; created.refreshContext()
      })
      let disposed = false
      adapter = { ...created, dispose: () => {
        if (disposed) return
        disposed = true; off(); offViews?.(); created.dispose()
      } }
      adapters.set(binding, adapter)
      const owned = adapter
      binding.ctx.effect(() => () => { owned.dispose(); adapters.delete(binding) })
    }
    return adapter.controller
  }
  service.sessionOf = resolve
  return () => {
    if (service.sessionOf === resolve) service.sessionOf = original
    for (const adapter of adapters.values()) adapter.dispose()
    adapters.clear()
  }
}
