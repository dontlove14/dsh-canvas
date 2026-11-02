import type { Context } from '@deepseek-ai/cordis'
import { InputTriggerController, type InputTriggerSource, type InputTriggerControllerDeps, type TriggerGuard } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { ChatReferenceChoices } from '../shared/chatReferences'
import { CHAT_REFERENCE_SOURCE, ChatReferenceSchema, referenceText } from '../shared/chatReferences'
import type { CanvasApi } from './api'

/** Only the detection projection changes; editor offsets and native revision guards remain exact. */
export function hashDetectionText(text: string, caret: number): string | undefined {
  const prefix = text.slice(0, caret)
  const match = /(?:^|\s)#(?:"[^"\n]*|[^\s#@"]*)$/.exec(prefix)
  if (!match) return
  const offset = match.index + (match[0].startsWith('#') ? 0 : 1)
  return text.slice(0, offset) + '@' + text.slice(offset + 1)
}
interface Files {
  list(sessionId: string, query: string, signal: AbortSignal): Promise<Array<{ path: string; kind: 'file' | 'directory' }>>
}
export function chatReferenceSource(sessionId: string, api: Pick<CanvasApi, 'referenceChoices' | 'resolveReference'>, files: Files): InputTriggerSource {
  const directory = (path: string) => `#${/\s/.test(path) ? '"' : ''}${path.replace(/\/?$/, '/')}`
  return {
    name: CHAT_REFERENCE_SOURCE, trigger: '@', showGroupTitle: false,
    async candidates(_session, { query, signal }) {
      let choices: ChatReferenceChoices
      try { choices = await api.referenceChoices(sessionId, query, signal) }
      catch (error) { if ((error as { status?: number }).status === 403) return []; throw error }
      if (!choices.preset) return []
      const rows = await files.list(sessionId, query, signal)
      signal.throwIfAborted()
      return [
        ...choices.media.map((item) => ({ name: item.label, description: item.description, icon: 'file' as const,
          section: item.section, value: JSON.stringify(item.ref) })),
        ...rows.filter((item) => choices.cwd && !item.path.startsWith('/') && !item.path.split('/').includes('..') && !item.path.includes('"')).map((item) => {
          const name = item.path.split('/').at(-1) || item.path
          return { name: name + (item.kind === 'directory' ? '/' : ''), description: item.path, section: '工作区', icon: item.kind === 'directory' ? 'folder' as const : 'file' as const,
            drill: item.kind === 'directory', value: item.kind === 'directory'
              ? JSON.stringify({ directory: item.path })
              : JSON.stringify({ version: 1, kind: 'file', sessionId, cwd: choices.cwd, path: item.path, label: name }) }
        }),
      ]
    },
    onPick({ candidate }) {
      if (!candidate.value) return
      const value = JSON.parse(candidate.value)
      if ('directory' in value) return { text: directory(value.directory), continue: true }
      const ref = ChatReferenceSchema.parse(value)
      return { insert: { source: CHAT_REFERENCE_SOURCE, ref: JSON.stringify(ref), label: `#${ref.label}`, appearance: 'file', clipboardText: referenceText(ref) } }
    },
    codec: {
      clipboardText: (ref) => referenceText(ChatReferenceSchema.parse(JSON.parse(ref))),
      serialize: async (ref, signal) => (await api.resolveReference(sessionId, ChatReferenceSchema.parse(JSON.parse(ref)), signal)).text,
    },
  }
}
/** Adapt the public native controller behind the public session resolver, without modifying Harness files. */
export function hashController(original: InputTriggerController, deps: InputTriggerControllerDeps, source: InputTriggerSource) {
  const hash = new InputTriggerController({ ...deps, roster: { all: () => [source], sources: (trigger) => trigger === '@' ? [source] : [] } })
  let current = original, enabled = true
  const watchers = new Set<() => void>()
  const stores = ['menu', 'headers', 'launcher'] as const
  const notify = () => { for (const listener of watchers) listener() }
  const off = stores.flatMap((key) => [original[key].subscribe(notify), hash[key].subscribe(notify)])
  const projected = Object.fromEntries(stores.map((key) => [key, {
    getSnapshot: () => current[key].getSnapshot(),
    subscribe: (listener: () => void) => { watchers.add(listener); return () => { watchers.delete(listener) } },
  }]))
  const switchTo = (controller: InputTriggerController) => { if (current !== controller) { current = controller; notify() } }
  const controller = new Proxy(original, {
    get(target, key) {
      if (key in projected) return projected[key as keyof typeof projected]
      if (key === 'track') return (draft: string, caret: number, guard: TriggerGuard, revision: number) => {
        const detection = enabled && guard.tier !== 'frozen' ? hashDetectionText(draft, caret) : undefined
        if (detection !== undefined) {
          original.track(draft, caret, { tier: 'frozen' }, revision)
          switchTo(hash); hash.track(detection, caret, guard, revision)
        } else {
          hash.track('', 0, { tier: 'frozen' }, revision)
          switchTo(original); original.track(draft, caret, guard, revision)
        }
      }
      if (key === 'serializeReference') return (owner: string, ...args: Parameters<InputTriggerController['serializeReference']> extends [string, ...infer Rest] ? Rest : never) =>
        (owner === CHAT_REFERENCE_SOURCE && enabled ? hash : original).serializeReference(owner, ...args)
      if (key === 'openReference') return (owner: string | undefined, ref: Parameters<InputTriggerController['openReference']>[1]) =>
        (owner === CHAT_REFERENCE_SOURCE && enabled ? hash : original).openReference(owner, ref)
      if (key === 'dismiss') return () => { hash.dismiss(); original.dismiss() }
      if (key === 'toggleSource') return (...args: Parameters<InputTriggerController['toggleSource']>) => {
        hash.dismiss(); switchTo(original); original.toggleSource(...args)
      }
      const active = ['pick', 'pickCrumb', 'hover', 'arbitrate', 'onSpace', 'refreshOpenMenu'].includes(String(key)) ? current : target
      const value = Reflect.get(active, key, active)
      return typeof value === 'function' ? value.bind(active) : value
    },
  })
  return { controller, dispose: () => {
    if (!enabled) return
    enabled = false; hash.dispose(); switchTo(original)
    for (const dispose of off) dispose()
    notify(); watchers.clear()
  } }
}
export function installChatReferenceTrigger(ctx: Context, api: CanvasApi, files: Files) {
  const service = ctx.inputTriggers, original = service.sessionOf, adapters = new Map<object, ReturnType<typeof hashController>>()
  const resolve = (actx: Context) => {
    const native = original.call(service, actx)
    const session = ctx.sessions.sessionOf(actx)
    const binding = session && ctx.sessions.binding(session.sessionId)
    if (!binding || binding.session !== session) return native
    let adapter = adapters.get(binding)
    if (!adapter) {
      adapter = hashController(native, { actx: binding.ctx, sessionId: binding.sessionId, roster: { all: () => [], sources: () => [] } },
        chatReferenceSource(binding.sessionId, api, files))
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
