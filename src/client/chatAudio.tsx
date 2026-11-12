import { useEffect, useRef, useState, type ComponentType } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatNodeViewProps, ChatConversationViewNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import { ChatAudioHandleSchema, type ChatAudioHandle, type ChatAudioResult } from '../shared/chatAudio'
import { BUSY_STATUSES } from '../shared/contracts'
import { CanvasApi } from './api'
import { AudioPlayer } from './AudioPlayer'
import { NodeLoading, NodeLoadingContext, useNodeLoadingEnvironment } from './NodeLoading'
import { UiButton } from './ui'
import { observeVisibility } from './observeVisibility'

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap { 'canvas-audio': ChatAudioHandle }
}
/** Only a successful tool receipt publishes a card. Replaying it is read-only. */
export const canvasAudioDefinition: ConversationNodeDefinition<ChatAudioHandle | null> = {
  kind: 'canvas-audio', target: 'chat',
  match: (event) => {
    if (event.type === 'tool/call' && event.data.name === 'canvas_show_audio') return { id: event.data.callId, role: 'start' }
    if (event.type === 'tool/result') return { id: event.data.message.toolCallId, role: 'update' }
    return null
  },
  start: () => null,
  update: (ctx, match) => {
    if (match.event.type !== 'tool/result' || match.event.data.message.isError) return ctx.state
    for (const part of match.event.data.message.content) if (part.type === 'text') {
      try {
        const parsed = ChatAudioHandleSchema.safeParse(JSON.parse(part.text).audio)
        if (parsed.success) return parsed.data
      } catch {}
    }
    return ctx.state
  },
  publication: () => 'immediate',
  buildViewNode: (ctx) => !ctx.state || !ctx.start ? null : ({
    key: ctx.key, id: ctx.id, kind: 'canvas-audio', target: 'chat', data: ctx.state,
    anchorSeq: ctx.start.event.seq, location: ctx.start.location, visibility: 'visible', groupTree: 'turn',
  } satisfies ChatConversationViewNode),
}
const PLAY_EVENT = 'dc-chat-audio-play'
export function ChatAudioCard({ node, api }: Pick<ChatNodeViewProps<'canvas-audio'>, 'node'> & { api: CanvasApi }) {
  const handle = node.data, frame = useRef<HTMLElement>(null), playerId = useRef(crypto.randomUUID()).current
  const identity = JSON.stringify([handle.canvasId, handle.taskId, handle.assetId])
  const [visible, setVisible] = useState(!document.hidden)
  const [playing, setPlaying] = useState<string | null>(null)
  const [loaded, setLoaded] = useState<{ key: string; value: ChatAudioResult } | null>(null)
  const result = loaded?.key === identity ? loaded.value : null
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const environment = useNodeLoadingEnvironment(frame, visible)
  useEffect(() => { setPlaying(null); setError('') }, [identity])
  useEffect(() => {
    let intersecting = true
    const update = () => { setVisible(intersecting && !document.hidden); if (!intersecting || document.hidden) setPlaying(null) }
    const stopVisibility = observeVisibility(frame.current, (visible) => { intersecting = visible; update() })
    document.addEventListener('visibilitychange', update)
    const otherPlayed = (event: Event) => { if ((event as CustomEvent).detail !== playerId) setPlaying(null) }
    document.addEventListener(PLAY_EVENT, otherPlayed)
    return () => { stopVisibility(); document.removeEventListener('visibilitychange', update); document.removeEventListener(PLAY_EVENT, otherPlayed) }
  }, [playerId])
  useEffect(() => {
    if (!visible) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined, failures = 0
    setError('')
    const update = async () => {
      try {
        const value = await api.audioResult(handle, AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]))
        if (controller.signal.aborted) return
        setLoaded({ key: identity, value }); setError(''); failures = 0
        if (handle.taskId && BUSY_STATUSES.has(value.status)) timer = setTimeout(update, 2000)
      } catch (cause) {
        if (controller.signal.aborted) return
        setError(cause instanceof Error ? cause.message : '音频读取失败')
        if (++failures < 3) timer = setTimeout(update, 3000)
      }
    }
    void update()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [api, handle.canvasId, handle.taskId, handle.assetId, visible, retry])
  const busy = !result || BUSY_STATUSES.has(result.status)
  return <article ref={frame} className="dc-chat-audio" aria-label={handle.title}>
    <header><span>音频试听</span><strong>{handle.title}</strong></header>
    {result?.voiceId && <small data-dc-text-selectable="true">音色 ID：{result.voiceId}</small>}
    {result?.text && <p data-dc-text-selectable="true">{result.text}</p>}
    <NodeLoadingContext.Provider value={environment}>
      {result?.assets.map((asset) => <AudioPlayer key={asset.id} asset={asset} api={api} workspace={handle.canvasId} label={handle.title}
        active={visible && playing === asset.id} onPlay={() => {
          document.dispatchEvent(new CustomEvent(PLAY_EVENT, { detail: playerId })); setPlaying(asset.id)
        }} onStop={() => setPlaying(null)} />)}
      {busy && !error && !result?.assets.length && <div className="dc-chat-audio-pending">
        <NodeLoading task={{ status: result?.status ?? 'submitted' }} title={handle.title} />
      </div>}
    </NodeLoadingContext.Provider>
    {!busy && !result?.assets.length && <p role="alert">{result?.error ?? (result?.status === 'completed' ? '音频成果已不可用'
      : result?.status === 'unknown' ? '提交结果待确认，请查看原任务。'
        : result?.status === 'save_failed' ? '音频保存失败，请在原任务中重试保存。' : '试听未生成成功，请查看原任务。')}</p>}
    {error && <div role="alert">{error}<UiButton onClick={() => setRetry((value) => value + 1)}>重新读取</UiButton></div>}
  </article>
}
export function installChatAudio(ctx: Context, api: CanvasApi, View: ComponentType<Pick<ChatNodeViewProps<'canvas-audio'>, 'node'> & { api: CanvasApi }> = ChatAudioCard) {
  ctx.inject(['uiConversation'], (scope) => {
    scope.effect(() => scope.uiConversation.events.register(canvasAudioDefinition))
    scope.slots.inject('conversation.chat.node', () => scope.slots.register({ name: 'conversation.chat.node', key: 'canvas-audio' },
      (props) => <View {...props} api={api} />))
  })
}
