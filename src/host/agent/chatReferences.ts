import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-working-directory'
import { constants } from 'node:fs'
import { createHmac, randomBytes } from 'node:crypto'
import { open, lstat, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, dirname, sep } from 'node:path'
import { ChatReferenceSchema, ChatReferenceBrowseSchema, referenceSpans, referenceText, type ChatReference, type ChatReferenceChoices, type ReferenceFolder } from '../../shared/chatReferences'
import { CanvasError } from '../store'
import { hash } from '../persistence/database'
import type { CanvasAgentCoordinator } from './coordinator'
import { ReferenceCatalog } from '../../shared/referenceCatalog'

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
  private readonly cursorKey = randomBytes(32)
  constructor(private ctx: Context, private coordinator: CanvasAgentCoordinator) {}
  private agent(sessionId: string) {
    const state = this.coordinator.session(sessionId)
    const agent = this.ctx.agents.get(sessionId as Agent['id'])
    if (!state.preset || !agent || this.coordinator.member(agent).role !== 'main')
      throw new CanvasError('请选择当前无限画布会话', 403, 'REFERENCE_SESSION')
    return { agent, state }
  }
  async choices(sessionId: string, query: string, signal: AbortSignal, input?: unknown): Promise<ChatReferenceChoices> {
    const { agent, state } = this.agent(sessionId)
    const browse = ChatReferenceBrowseSchema.parse(input ?? {})
    signal.throwIfAborted()
    const catalog = await this.coordinator.canvas.store.catalog()
    // Legacy callers retain their bound-canvas preference. The UI explicitly
    // sends null when no editor is open, so stale Agent control cannot win.
    const currentCanvasId = browse.currentCanvasId === undefined ? state.canvas?.canvasId ?? null : browse.currentCanvasId
    const canvases = catalog.canvases.map((item) => ({ ...item, updatedAt: item.updatedAt ?? 0 }))
      .sort((a, b) => Number(b.id === currentCanvasId) - Number(a.id === currentCanvasId) || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
    const folders: ReferenceFolder[] = catalog.folders.map((folder) => ({
      id: folder.id, name: folder.name, canvases: canvases.filter((canvas) => canvas.folderId === folder.id),
    }))
    const unfiled = canvases.filter((canvas) => !canvas.folderId)
    if (unfiled.length) folders.push({ id: null, name: '未分类', canvases: unfiled })
    const preferred = canvases[0]
    folders.sort((a, b) => Number(b.id === preferred?.folderId) - Number(a.id === preferred?.folderId) ||
      (b.canvases[0]?.updatedAt ?? 0) - (a.canvases[0]?.updatedAt ?? 0) || a.name.localeCompare(b.name) || String(a.id).localeCompare(String(b.id)))
    const folder = browse.folderId === undefined ? undefined : folders.find((item) => item.id === browse.folderId)
    if (browse.folderId !== undefined && !folder) throw new CanvasError('文件夹已移除，请重新选择', 409, 'REFERENCE_STALE')
    const canvas = browse.browseCanvasId ? canvases.find((item) => item.id === browse.browseCanvasId) :
      browse.folderId !== undefined ? undefined : preferred
    if (browse.browseCanvasId && (!canvas || (folder && canvas.folderId !== folder.id)))
      throw new CanvasError('画布已移除或移出文件夹，请重新选择', 409, 'REFERENCE_STALE')
    const media: ChatReferenceChoices['media'] = []
    let items: ChatReferenceChoices['items'], nextCursor: string | undefined, graphRevision: number | undefined
    if (canvas) {
      const snapshot = await this.coordinator.canvas.store.snapshot(canvas.id)
      const folderName = folders.find((item) => item.id === canvas.folderId)?.name ?? '未分类'
      if (browse.view === 'node-media') {
        const index = new ReferenceCatalog(snapshot), node = browse.nodeId && index.nodes.get(browse.nodeId)
        if (browse.nodeId && !node || browse.taskId && (!node || !(index.tasks.get(node.id) ?? []).some((task) => task.id === browse.taskId)))
          throw new CanvasError('节点或历史批次已移除，请重新选择', 409, 'REFERENCE_STALE')
        const all = index.items(sessionId, `画布 · ${folderName} · ${canvas.name}`, query, browse.nodeId, browse.taskId)
        graphRevision = snapshot.graphRevision
        const scope = hash({ sessionId, query, browse: { ...browse, cursor: undefined }, canvasId: canvas.id,
          graphRevision, items: all })
        let offset = 0
        if (browse.cursor) {
          const parts = browse.cursor.split('.'), [payload, signature] = parts
          if (parts.length !== 2 || !payload || !signature || createHmac('sha256', this.cursorKey).update(payload).digest('hex') !== signature)
            throw new CanvasError('分页引用无效，请重新查询', 409, 'REFERENCE_STALE')
          try {
            const value = JSON.parse(Buffer.from(payload, 'base64url').toString())
            if (value.scope !== scope || !Number.isSafeInteger(value.offset) || value.offset <= 0 || value.offset >= all.length)
              throw new Error()
            offset = value.offset
          } catch { throw new CanvasError('画布或查询已变化，请重新查询', 409, 'REFERENCE_STALE') }
        }
        // Keep each node together with its direct current-media shortcut.
        let end = Math.min(offset + 200, all.length)
        if (end < all.length && all[end - 1]?.type === 'node' && all[end]?.type === 'media') end--
        items = all.slice(offset, end)
        if (end < all.length) {
          const payload = Buffer.from(JSON.stringify({ scope, offset: end })).toString('base64url')
          nextCursor = `${payload}.${createHmac('sha256', this.cursorKey).update(payload).digest('hex')}`
        }
        for (const item of items) if (item.type === 'media') media.push(item)
      } else {
      for (const node of snapshot.graph.nodes) {
        const assets = snapshot.assets.filter((asset) => asset.id === node.assetId || asset.nodeId === node.id)
        const current = node.selectedResultId ?? node.assetId ?? assets.at(-1)?.id
        for (const [index, asset] of assets.entries()) {
          const kind = { image: '图片', video: '视频', audio: '音频' }[asset.kind]
          const label = `${node.title} · ${kind}${assets.length > 1 ? ` ${index + 1}` : ''}`
          if (query && !`${label} ${asset.filename}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())) continue
          media.push({ label, kind: asset.kind, description: `${asset.id === current ? '当前' : '历史'} · ${asset.filename}`,
            section: `画布 · ${folderName} · ${canvas.name}`,
            ref: { version: 1, kind: 'media', sessionId, canvasId: snapshot.workspaceId, nodeId: node.id, assetId: asset.id, label } })
        }
      }
      }
    }
    if (browse.cursor && !canvas) throw new CanvasError('分页画布已变化，请重新查询', 409, 'REFERENCE_STALE')
    signal.throwIfAborted()
    const now = this.agent(sessionId)
    if (now.agent !== agent)
      throw new CanvasError('会话已变化，请重新输入 #', 409, 'REFERENCE_STALE')
    return { preset: true, folders, currentCanvasId, expandedCanvasId: canvas?.id, media: media.slice(0, 200), mediaTruncated: media.length > 200,
      ...(browse.view ? { items: items ?? [], nextCursor, truncated: !!nextCursor, graphRevision } : {}) }
  }
  async resolve(sessionId: string, input: unknown, signal: AbortSignal): Promise<ChatReference> {
    const ref = ChatReferenceSchema.parse(input), { agent } = this.agent(sessionId)
    signal.throwIfAborted()
    if (ref.sessionId !== sessionId) throw new CanvasError('引用属于其他会话', 403, 'REFERENCE_SESSION')
    if (ref.kind === 'media' || ref.kind === 'node') {
      if (!(await this.coordinator.canvas.store.catalog()).canvases.some((item) => item.id === ref.canvasId))
        throw new CanvasError('引用的画布已移除，请重新选择', 409, 'REFERENCE_STALE')
      const snapshot = await this.coordinator.canvas.store.snapshot(ref.canvasId)
      const node = snapshot.graph.nodes.find((node) => node.id === ref.nodeId)
      if (!node) throw new CanvasError('引用的节点已移除，请重新选择', 409, 'REFERENCE_STALE')
      if (ref.kind === 'node') {
        signal.throwIfAborted()
        if (this.agent(sessionId).agent !== agent) throw new CanvasError('会话已变化，请重新选择', 409, 'REFERENCE_STALE')
        return ref
      }
      const asset = snapshot.assets.find((asset) => asset.id === ref.assetId)
      if (!node || !asset || !(asset.nodeId === node.id || node.assetId === asset.id))
        throw new CanvasError('引用的节点或素材已移除，请重新选择', 409, 'REFERENCE_STALE')
      await this.coordinator.canvas.store.locator(ref.canvasId, ref.assetId)
      signal.throwIfAborted()
      if (this.agent(sessionId).agent !== agent) throw new CanvasError('会话已变化，请重新选择', 409, 'REFERENCE_STALE')
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
