import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { renderSkillContent, type SkillDefinition, type SkillSummary } from '@deepseek-ai/dsh-skill'
import type { AgentRole } from '../../shared/agent'
import type { CanvasAgentCoordinator } from './coordinator'
import { CanvasError } from '../store'
import { hash } from '../persistence/database'
import { capabilities, taskSkills } from './capabilities'
import { PACKAGED_SKILLS, SKILL_VERSION, skillDigest } from './skills/manifest'
import { matchingPromptSkills, MODEL_PROMPT_SKILLS } from './modelPromptSkills'

/** Per-instance pinned methods; no arbitrary file, URL, global skill or executable resource access. */
export class CanvasSkills {
  private states = new WeakMap<Agent, { key: string; loaded: Map<string, SkillDefinition> }>()
  private readonly provider: string
  constructor(private ctx: Context, private coordinator: CanvasAgentCoordinator, readonly role: AgentRole) {
    this.provider = `dsh-canvas/${SKILL_VERSION}/${role}`
    for (const name of capabilities(role).skills) {
      const skill = PACKAGED_SKILLS.get(name)
      if (!skill) throw new CanvasError(`必备方法未打包：${name}`, 409, 'AGENT_SKILL_MISSING')
      ctx.skills.register({ name, description: skill.description, content: skill.content, source: 'bundled', provider: this.provider,
        invocation: { modelInvocable: true, userInvocable: false }, metadata: { version: SKILL_VERSION, sha256: skill.sha256 },
        resourceBase: { kind: 'opaque', description: `${this.provider}/${name}; use canvas_skill_resource` } })
    }
  }
  private state(agent: Agent) {
    const member = this.coordinator.member(agent)
    if (member.role !== this.role) throw new CanvasError('Skill 与真实角色不匹配', 403, 'AGENT_SKILL_FORBIDDEN')
    const control = this.coordinator.session(member.rootId).canvas
    if (this.role !== 'main' && control) this.coordinator.assert(agent, control, false)
    const binding = this.role === 'main' ? undefined : this.coordinator.binding(agent)
    const lastEvent = this.role === 'main' ? agent.session.snapshotEvents().filter((event) => event.type === 'user/message' && event.data.source.kind === 'user').at(-1) : undefined
    const lastUser = lastEvent?.type === 'user/message' ? lastEvent.data.id : undefined
    const selections = this.coordinator.generationModels.selections(this.coordinator.rootAgent(agent))
    const key = hash({ role: this.role, rootId: member.rootId, binding, selections, epoch: control?.epoch, canvasId: control?.canvasId, lastUser, version: SKILL_VERSION })
    let state = this.states.get(agent)
    if (!state || state.key !== key) { state = { key, loaded: new Map() }; this.states.set(agent, state) }
    return state
  }
  private expected(summary: SkillSummary, name: string) {
    const packaged = PACKAGED_SKILLS.get(name)!
    return summary.name === name && summary.provider === this.provider && summary.source === 'bundled' &&
      summary.description === packaged.description && summary.invocation.modelInvocable && !summary.invocation.userInvocable &&
      summary.resourceBase?.kind === 'opaque' && summary.resourceBase.description === `${this.provider}/${name}; use canvas_skill_resource`
  }
  async list(agent: Agent, signal: AbortSignal) {
    signal.throwIfAborted(); const state = this.state(agent)
    const snapshot = await this.ctx.skills.snapshot({ scope: scopeOf(agent.ctx), signal })
    signal.throwIfAborted()
    if (this.state(agent) !== state) throw new CanvasError('任务已切换，Skill 目录已失效', 409, 'AGENT_SKILL_STALE')
    return { version: SKILL_VERSION, complete: snapshot.complete, skills: snapshot.skills.filter((skill) =>
      capabilities(this.role).skills.includes(skill.name) && this.expected(skill, skill.name)).map(({ name, description }) =>
      ({ name, description, loaded: state.loaded.has(name), resources: Object.keys(PACKAGED_SKILLS.get(name)!.resources) })) }
  }
  async load(agent: Agent, name: string, signal: AbortSignal) {
    taskSkills(this.role, [name]); signal.throwIfAborted()
    if (Object.values(MODEL_PROMPT_SKILLS).includes(name) && !matchingPromptSkills(this.role, this.plans(agent)).includes(name))
      throw new CanvasError('提示词方法与本批已确认模型不匹配，请先选择模型或交主 Agent 重新委派', 409, 'AGENT_MODEL_SKILL_MISMATCH')
    const state = this.state(agent), saved = state.loaded.get(name)
    if (saved) return saved
    const skill = await this.ctx.skills.get(name, { scope: scopeOf(agent.ctx), signal })
    signal.throwIfAborted()
    if (this.state(agent) !== state) throw new CanvasError('任务已切换，迟到方法不会注入', 409, 'AGENT_SKILL_STALE')
    const packaged = PACKAGED_SKILLS.get(name)!
    if (!skill || !this.expected(skill, name) || skillDigest(skill.content) !== packaged.sha256 ||
      skill.metadata?.version !== SKILL_VERSION || skill.metadata?.sha256 !== packaged.sha256)
      throw new CanvasError(`方法缺失或来源/版本不匹配：${name}`, 409, 'AGENT_SKILL_UNTRUSTED')
    const pinned = structuredClone(skill)
    state.loaded.set(name, pinned)
    return pinned
  }
  async required(agent: Agent, signal: AbortSignal) {
    const chosen = this.role === 'main' ? [] : this.coordinator.binding(agent).skillNames
    for (const name of [...taskSkills(this.role, chosen), ...matchingPromptSkills(this.role, this.plans(agent))]) await this.load(agent, name, signal)
  }
  private plans(agent: Agent) {
    if (this.role !== 'main') return this.coordinator.binding(agent).planningModels ?? []
    const root = this.coordinator.rootAgent(agent), selections = this.coordinator.generationModels.selections(root)
    return (['image', 'video'] as const).flatMap((kind) => selections[kind] ? [this.coordinator.generationModels.pin(root, kind)] : [])
  }
  context(agent: Agent) {
    const state = this.state(agent)
    return [...state.loaded.values()].map(renderSkillContent).join('\n\n')
  }
  async resource(agent: Agent, name: string, path: string, signal: AbortSignal) {
    await this.load(agent, name, signal)
    const resource = PACKAGED_SKILLS.get(name)!.resources[path]
    if (!Object.hasOwn(PACKAGED_SKILLS.get(name)!.resources, path) || !resource)
      throw new CanvasError('辅助资源未列入随包清单', 404, 'AGENT_SKILL_RESOURCE_MISSING')
    if (skillDigest(resource.content) !== resource.sha256) throw new CanvasError('辅助资源身份不匹配', 409, 'AGENT_SKILL_UNTRUSTED')
    signal.throwIfAborted(); this.state(agent)
    return { name, path, version: SKILL_VERSION, sha256: resource.sha256, content: resource.content, executable: false }
  }
}
