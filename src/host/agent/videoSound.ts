import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CanvasControl } from '../../shared/agent'
import { capabilitiesFor, defaultParams, isTtsParams, type CanvasNode, type PublicModel } from '../../shared/contracts'
import { referenceSpans } from '../../shared/chatReferences'
import type { ExecutionCommand } from '../../shared/execution'
import { CanvasError } from '../store'

/** Live root/epoch/target grants; assistant prose, source files and historic messages cannot authorize mute. */
export class AgentVideoSound {
  private grants = new WeakMap<Agent, { canvasId: string; epoch: number; messageId?: string; targets: Set<string> }>()
  latestUserMessageId(agent: Agent) {
    const event = agent.session.snapshotEvents().filter((event) => event.type === 'user/message' && event.data.source.kind === 'user').at(-1)
    return event?.type === 'user/message' ? event.data.id : undefined
  }
  clear(agent: Agent) { this.grants.delete(agent) }
  revoke(agent: Agent, targets: string[]) { targets.forEach((target) => this.grants.get(agent)?.targets.delete(target)) }
  confirm(agent: Agent, control: CanvasControl, targets: string[]) {
    let grant = this.grants.get(agent)
    const messageId = this.latestUserMessageId(agent)
    if (!grant || grant.canvasId !== control.canvasId || grant.epoch !== control.epoch || grant.messageId !== messageId) {
      grant = { canvasId: control.canvasId, epoch: control.epoch, messageId, targets: new Set() }; this.grants.set(agent, grant)
    }
    targets.forEach((target) => grant.targets.add(target))
  }
  /** Only an unambiguous whole latest user request is reusable without asking again. */
  fromUser(agent: Agent, control: CanvasControl, targets: string[], messageId: string) {
    const event = agent.session.snapshotEvents().filter((event) => event.type === 'user/message' && event.data.source.kind === 'user').at(-1)
    if (!event || event.type !== 'user/message' || event.data.id !== messageId) return false
    const text = event.data.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n')
    const refs = referenceSpans(text)
    let plain = text
    for (const span of [...refs].reverse()) plain = plain.slice(0, span.start) + plain.slice(span.end)
    plain = plain.replace(/\s+/g, '').replace(/[。.!！]$/, '')
    const global = /^(?:请)?(?:所有|全部)(?:视频|镜头)(?:都)?(?:生成|改成|设为|保持)?(?:无声|静音|不要声音|关闭声音)$/.test(plain)
    const specific = /^(?:请)?(?:这个|这些)?(?:视频|镜头)?(?:生成|改成|设为|保持)?(?:无声|静音|不要声音|关闭声音)$/.test(plain)
    const nodes = refs.filter((span) => span.ref.sessionId === agent.id && span.ref.kind === 'node' && span.ref.canvasId === control.canvasId)
      .map((span) => span.ref.kind === 'node' ? span.ref.nodeId : '')
    if (!global && !(specific && targets.every((target) => nodes.includes(target)))) return false
    this.confirm(agent, control, targets); return true
  }
  require(agent: Agent, control: CanvasControl, target: string) {
    const grant = this.grants.get(agent)
    if (!grant || grant.canvasId !== control.canvasId || grant.epoch !== control.epoch ||
      grant.messageId !== this.latestUserMessageId(agent) || !grant.targets.has(target))
      throw new CanvasError('视频默认有声；关闭前须由主 Agent 绑定用户明确无声要求与精确目标', 403, 'AGENT_VIDEO_MUTE_REQUIRED')
  }
  node(agent: Agent, control: CanvasControl, node: CanvasNode, model?: PublicModel, explicit = false) {
    if (node.kind !== 'video-generation' || !model || !capabilitiesFor(model).supportsAudioToggle || isTtsParams(node.params)) return node
    const params = node.params ?? defaultParams(model)
    if (params.generateAudio === false && explicit) this.require(agent, control, node.id)
    return { ...node, params: { ...params, generateAudio: params.generateAudio ?? true } }
  }
  batch(agent: Agent, control: CanvasControl, commands: ExecutionCommand[]) {
    for (const command of commands) {
      if (command.tool === 'canvas_create_node' && command.input.kind === 'video-generation' &&
        command.input.params && !isTtsParams(command.input.params) && command.input.params.generateAudio === false)
        this.require(agent, control, command.input.operationId)
      if (command.tool === 'canvas_update_node' && command.input.patch.params && !isTtsParams(command.input.patch.params) &&
        command.input.patch.params.generateAudio === false) this.require(agent, control, command.input.nodeId)
    }
  }
}
