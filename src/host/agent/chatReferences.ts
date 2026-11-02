import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-working-directory'
import { constants } from 'node:fs'
import { open, lstat, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, dirname, sep } from 'node:path'
import { ChatReferenceSchema, referenceSpans, referenceText, type ChatReference, type ChatReferenceChoices } from '../../shared/chatReferences'
import { CanvasError } from '../store'
import { hash } from '../persistence/database'
import type { CanvasAgentCoordinator } from './coordinator'

export function submittedReferences(agent: Agent) {
  const refs = new Map<string, { referenceId: string; ref: ChatReference; messageId: string }>()
  for (const event of agent.session.snapshotEvents()) {
    if (event.type !== 'user/message' || event.data.source.kind !== 'user') continue
    for (const part of event.data.content) if (part.type === 'text') {
      for (const { ref } of referenceSpans(part.text)) {
        if (ref.sessionId !== agent.id) continue
        const referenceId = hash(ref)
        refs.set(referenceId, { referenceId, ref, messageId: event.data.id })
      }
    }
  }
  return [...refs.values()].slice(-100)
}
export class CanvasChatReferences {
  constructor(private ctx: Context, private coordinator: CanvasAgentCoordinator) {}
  private agent(sessionId: string) {
    const state = this.coordinator.session(sessionId)
    const agent = this.ctx.agents.get(sessionId as Agent['id'])
    if (!state.preset || !agent || this.coordinator.member(agent).role !== 'main')
      throw new CanvasError('请选择当前无限画布会话', 403, 'REFERENCE_SESSION')
    return { agent, state }
  }
  async choices(sessionId: string, query: string, signal: AbortSignal): Promise<ChatReferenceChoices> {
    const { agent, state } = this.agent(sessionId)
    signal.throwIfAborted()
    const cwd = await this.ctx.workingDirectory.ensure(agent, signal)
    const media: ChatReferenceChoices['media'] = []
    if (state.canvas) {
      const snapshot = await this.coordinator.canvas.store.snapshot(state.canvas.canvasId)
      const canvas = (await this.coordinator.canvas.store.catalog()).canvases.find((item) => item.id === state.canvas!.canvasId)
      for (const node of snapshot.graph.nodes) {
        const assets = snapshot.assets.filter((asset) => asset.id === node.assetId || asset.nodeId === node.id)
        const current = node.selectedResultId ?? node.assetId ?? assets.at(-1)?.id
        for (const [index, asset] of assets.entries()) {
          const kind = { image: '图片', video: '视频', audio: '音频' }[asset.kind]
          const label = `${node.title} · ${kind}${assets.length > 1 ? ` ${index + 1}` : ''}`
          if (query && !`${label} ${asset.filename}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())) continue
          media.push({ label, kind: asset.kind, description: `${asset.id === current ? '当前' : '历史'} · ${asset.filename}`,
            section: `画布 · ${canvas?.name ?? '当前画布'}`,
            ref: { version: 1, kind: 'media', sessionId, canvasId: snapshot.workspaceId, nodeId: node.id, assetId: asset.id, label } })
        }
      }
    }
    signal.throwIfAborted()
    const now = this.agent(sessionId)
    if (now.agent !== agent || now.state.canvas?.canvasId !== state.canvas?.canvasId || this.ctx.workingDirectory.get(agent.session) !== cwd)
      throw new CanvasError('会话位置已变化，请重新输入 #', 409, 'REFERENCE_STALE')
    return { preset: true, cwd, media: media.slice(0, 200) }
  }
  async resolve(sessionId: string, input: unknown, signal: AbortSignal): Promise<ChatReference> {
    const ref = ChatReferenceSchema.parse(input), { agent, state } = this.agent(sessionId)
    signal.throwIfAborted()
    if (ref.sessionId !== sessionId) throw new CanvasError('引用属于其他会话', 403, 'REFERENCE_SESSION')
    if (ref.kind === 'media') {
      if (state.canvas?.canvasId !== ref.canvasId) throw new CanvasError('当前画布已切换，请重新选择素材', 409, 'REFERENCE_STALE')
      const snapshot = await this.coordinator.canvas.store.snapshot(ref.canvasId)
      const node = snapshot.graph.nodes.find((node) => node.id === ref.nodeId)
      const asset = snapshot.assets.find((asset) => asset.id === ref.assetId)
      if (!node || !asset || !(asset.nodeId === node.id || node.assetId === asset.id))
        throw new CanvasError('引用的节点或素材已移除，请重新选择', 409, 'REFERENCE_STALE')
      await this.coordinator.canvas.store.locator(ref.canvasId, ref.assetId)
      signal.throwIfAborted()
      if (this.agent(sessionId).state.canvas?.canvasId !== ref.canvasId) throw new CanvasError('当前画布已切换', 409, 'REFERENCE_STALE')
      return ref
    }
    const file = await this.file(agent, ref, signal, false)
    return { ...ref, pin: file.pin }
  }
  /** Only read ordinary files under the actual current workspace; pin before sending and check again at use. */
  async file(agent: Agent, ref: Extract<ChatReference, { kind: 'file' }>, signal: AbortSignal, read: boolean) {
    const cwd = await this.ctx.workingDirectory.ensure(agent, signal)
    if (cwd !== ref.cwd) throw new CanvasError('工作区已切换，请重新选择文件', 409, 'REFERENCE_STALE')
    const root = await realpath(cwd), path = resolve(root, ref.path), rel = relative(root, path)
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || ref.path.includes('\0'))
      throw new CanvasError('文件不在当前工作区内', 403, 'REFERENCE_PATH')
    let cursor = root
    for (const part of rel.split(sep)) {
      cursor = resolve(cursor, part)
      const info = await lstat(cursor).catch(() => { throw new CanvasError('文件已移除', 409, 'REFERENCE_STALE') })
      if (info.isSymbolicLink()) throw new CanvasError('引用文件不能经过符号链接', 403, 'REFERENCE_PATH')
    }
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const info = await handle.stat()
      if (!info.isFile()) throw new CanvasError('请选择工作区中的文件', 400, 'REFERENCE_PATH')
      const pin = { bytes: info.size, modified: info.mtimeMs, inode: String(info.ino) }
      if (ref.pin && JSON.stringify(ref.pin) !== JSON.stringify(pin)) throw new CanvasError('引用文件已修改，请重新选择', 409, 'REFERENCE_STALE')
      const limit = Math.min(2 * 1024 * 1024, this.coordinator.canvas.config.maxReferenceBytes)
      let data: Buffer | undefined
      if (read && info.size <= limit) {
        const chunks: Buffer[] = []; let bytes = 0
        for await (const chunk of handle.createReadStream({ autoClose: false })) {
          signal.throwIfAborted(); bytes += chunk.length
          if (bytes > limit) throw new CanvasError('引用文件读取超过限制', 413, 'REFERENCE_SIZE')
          chunks.push(Buffer.from(chunk))
        }
        data = Buffer.concat(chunks)
      }
      signal.throwIfAborted()
      const after = await handle.stat()
      if (after.size !== pin.bytes || after.mtimeMs !== pin.modified || await realpath(dirname(path)) !== dirname(path) ||
        (await lstat(path)).ino !== info.ino || this.ctx.workingDirectory.get(agent.session) !== cwd)
        throw new CanvasError('读取期间文件或工作区已变化', 409, 'REFERENCE_STALE')
      return { pin, data, path: rel, readable: !!data }
    } finally { await handle.close() }
  }
  async serialize(sessionId: string, input: unknown, signal: AbortSignal) {
    return referenceText(await this.resolve(sessionId, input, signal))
  }
}
