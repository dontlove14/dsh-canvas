import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PublicModel } from '../../shared/contracts'
import { builtinDefinition, modelConfigured, providerFor } from '../../shared/modelCatalog'
import { CanvasError } from '../store'
import { hash } from '../persistence/database'

export type GenerationModelKind = 'image' | 'video'
export interface GenerationModelChoice {
  modelId: string
  kind: GenerationModelKind
  name: string
  model: string
  provider: string
  providerName: string
}
const identity = (model: PublicModel) => hash({
  id: model.id, kind: model.kind, name: model.name, model: model.model_id,
  protocol: model.protocol, apiBase: model.api_base, endpoint: model.endpoint_id ?? null,
})
export const choiceFor = (model: Pick<PublicModel, 'id' | 'kind' | 'name' | 'model_id' | 'api_base'>): GenerationModelChoice => ({
  modelId: model.id, kind: model.kind as GenerationModelKind, name: model.name, model: model.model_id,
  provider: providerFor(model)!.id, providerName: providerFor(model)!.label,
})

/** Only native user answers can populate this live, main-Agent-owned registry. */
export class AgentModelSelection {
  private approved = new WeakMap<Agent, Map<GenerationModelKind, { model: GenerationModelChoice; identity: string }>>()
  private pending = new WeakMap<Agent, Map<GenerationModelKind, symbol>>()
  constructor(private readonly listModels: () => PublicModel[]) {}
  models(kind?: GenerationModelKind) {
    return this.listModels().filter((model) => (!kind || model.kind === kind) &&
      !!builtinDefinition(model) && model.configurable !== false && !!providerFor(model) && modelConfigured(model))
  }
  catalog() {
    return this.models().map(({ api_key_mask: _mask, ...model }) => ({ ...model, ...choiceFor(model) }))
  }
  current(agent: Agent, kind: GenerationModelKind) {
    const selected = this.approved.get(agent)?.get(kind)
    if (!selected) return null
    const model = this.models(kind).find((model) => model.id === selected.model.modelId)
    if (!model || identity(model) !== selected.identity) {
      this.approved.get(agent)?.delete(kind)
      return null
    }
    return selected.model
  }
  selections(agent: Agent) { return { image: this.current(agent, 'image'), video: this.current(agent, 'video') } }
  clear(agent: Agent) { this.approved.delete(agent); this.pending.delete(agent) }
  begin(agent: Agent, kind: GenerationModelKind) {
    // Requesting a replacement revokes the old choice until the user answers.
    this.approved.get(agent)?.delete(kind)
    const token = Symbol(kind), pending = this.pending.get(agent) ?? new Map()
    pending.set(kind, token); this.pending.set(agent, pending)
    return token
  }
  confirm(agent: Agent, kind: GenerationModelKind, token: symbol, offered: PublicModel) {
    const model = this.models(kind).find((model) => model.id === offered.id)
    if (this.pending.get(agent)?.get(kind) !== token || !model || identity(model) !== identity(offered))
      throw new CanvasError('选择期间模型配置或控制状态已变化，请重新询问用户', 409, 'AGENT_MODEL_SELECTION_STALE')
    const selected = { model: choiceFor(model), identity: identity(model) }
    const approved = this.approved.get(agent) ?? new Map()
    approved.set(kind, selected); this.approved.set(agent, approved)
    this.pending.get(agent)?.delete(kind)
    return selected.model
  }
  require(agent: Agent, kind: GenerationModelKind, modelId: string | null) {
    const model = this.models(kind).find((model) => model.id === modelId)
    if (!model) throw new CanvasError('请用 canvas_select_model 从当前已配置的模型与供应商中让用户选择', 409, 'AGENT_MODEL_NOT_AVAILABLE')
    if (this.current(agent, kind)?.modelId !== modelId)
      throw new CanvasError('尚未得到用户对该模型与供应商的确认，请先调用 canvas_select_model', 409, 'AGENT_MODEL_SELECTION_REQUIRED')
    return model
  }
}
