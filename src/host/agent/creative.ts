import { randomUUID, createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, readFile, writeFile, rename, open, lstat, realpath } from 'node:fs/promises'
import { join, resolve, relative, isAbsolute, extname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { z } from 'zod'
import { CreativeSourceSchema, CreativeArtifactSchema, CreativeRunSchema, type CreativeSource, type CreativeArtifact, type CreativeRun } from '../../shared/creative'
import { CanvasError } from '../store'
import { hash } from '../persistence/database'
import { readUserAttachment } from './attachments'
import { AgentWorkspace } from './workspace'

const LIMIT = 32 * 1024 * 1024
const ProjectSchema = z.object({ id: z.string(), rootId: z.string(), workspace: z.string(), canvasId: z.string().optional(), name: z.string() })
const StateSchema = z.object({
  version: z.literal(1), projects: z.array(ProjectSchema), sources: z.array(CreativeSourceSchema),
  artifacts: z.array(CreativeArtifactSchema), runs: z.array(CreativeRunSchema),
})
type Project = z.infer<typeof ProjectSchema>
type State = z.infer<typeof StateSchema>
function decode(bytes: Buffer) {
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8'
  let text: string
  try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes).replace(/\r\n?/g, '\n') }
  catch { throw new CanvasError('文本编码不受支持，请转成 UTF-8 或带 BOM 的 UTF-16 文本', 415, 'SOURCE_ENCODING') }
  if (!text.trim() || /[\u0000-\u0008\u000e-\u001f]/.test(text)) throw new CanvasError('不是可读取的文本', 415, 'SOURCE_FORMAT')
  return { text, encoding }
}
function sections(text: string) {
  const headings: Array<{ title: string; start: number; end: number }> = []
  const pattern = /^(?:#{1,6}\s+.+|第[零〇一二三四五六七八九十百千万两\d]+[章节卷回部篇][^\n]*|(?:序章|楔子|引子|尾声|后记)(?:[：:\s].*)?|Chapter\s+\d+[^\n]*)$/gim
  for (const match of text.matchAll(pattern)) {
    if (headings.length >= 10000) throw new CanvasError('章节数量超过上限，请拆分源文件', 413, 'SOURCE_TOO_LARGE')
    headings.push({ title: match[0].slice(0, 160), start: match.index!, end: text.length })
  }
  if (!headings.length || headings[0].start > 0) headings.unshift({ title: headings.length ? '正文开头' : '全文', start: 0, end: text.length })
  return headings.map((entry, index) => ({ ...entry, end: headings[index + 1]?.start ?? text.length }))
}
/** Separate sidecar and immutable text snapshots; never changes stored CanvasGraph or SQL schemas. */
export class CreativeProjects {
  private state: State = { version: 1, projects: [], sources: [], artifacts: [], runs: [] }
  private saving: Promise<void> = Promise.resolve()
  private listeners = new Set<() => void>()
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private readonly path: string
  private readonly sourcesDir: string
  constructor(dataDir: string) { this.path = join(dataDir, 'creative-projects.json'); this.sourcesDir = join(dataDir, 'creative-sources') }
  async init() {
    try { this.state = StateSchema.parse(JSON.parse(await readFile(this.path, 'utf8'))) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new CanvasError('创作项目记录无法读取，请恢复备份', 503, 'CREATIVE_STATE_INVALID') }
    await mkdir(this.sourcesDir, { recursive: true, mode: 0o700 })
    if ((await lstat(this.sourcesDir)).isSymbolicLink()) throw new CanvasError('原文快照目录不可为符号链接', 503, 'UNSAFE_PATH')
    for (const run of this.state.runs) if (run.state === 'running') { run.state = 'interrupted'; run.progress = '宿主重启；已有成果保留，不自动重提'; run.updatedAt = Date.now() }
    await this.persist()
  }
  project(rootId: string, workspace: string, canvasId?: string, name = '会话方案'): Project {
    let project = this.state.projects.find((p) => p.workspace === workspace && (canvasId ? p.canvasId === canvasId : p.rootId === rootId && !p.canvasId))
    project ??= this.state.projects.find((p) => p.workspace === workspace && p.rootId === rootId && !p.canvasId)
    if (!project) {
      if (this.state.projects.length >= 10000) throw new CanvasError('创作项目容量已满', 409, 'CREATIVE_STATE_FULL')
      project = { id: canvasId && !this.state.projects.some((p) => p.id === canvasId) ? canvasId : randomUUID(), rootId, workspace, name }; this.state.projects.push(project)
    }
    if (canvasId) { project.canvasId = canvasId; project.name = name }
    return structuredClone(project)
  }
  summary(projectId: string, cursor = 0, limit = 50) {
    const sources = this.state.sources.filter((s) => s.projectId === projectId).reverse()
    const artifacts = this.state.artifacts.filter((a) => a.projectId === projectId).reverse()
    const runs = this.state.runs.filter((r) => r.projectId === projectId).reverse()
    return {
      sources: sources.slice(cursor, cursor + limit).map(({ sections: index, ...s }) => ({ ...s, sectionCount: index.length })),
      artifacts: artifacts.slice(cursor, cursor + limit).map((artifact) => { const { draft, ...a } = artifact; return { ...a, kind: draft.kind, title: draft.title, dependencies: draft.dependencies, needsReview: this.needsReview(artifact) } }),
      runs: runs.slice(cursor, cursor + limit).map(({ result: _result, task, ...run }) => ({ ...structuredClone(run), task: task.slice(0, 300) })),
      next: cursor + limit < Math.max(sources.length, artifacts.length, runs.length) ? cursor + limit : null,
      totals: { sources: sources.length, artifacts: artifacts.length, runs: runs.length },
    }
  }
  source(projectId: string, id: string) {
    const source = this.state.sources.find((s) => s.id === id && s.projectId === projectId)
    if (!source) throw new CanvasError('原文不属于本创作项目', 403, 'SOURCE_FORBIDDEN')
    return structuredClone(source)
  }
  artifact(projectId: string, id: string) {
    const artifact = this.state.artifacts.find((a) => a.id === id && a.projectId === projectId)
    if (!artifact) throw new CanvasError('成果不属于本创作项目', 403, 'ARTIFACT_FORBIDDEN')
    return { ...structuredClone(artifact), needsReview: this.needsReview(artifact) }
  }
  private needsReview(artifact: CreativeArtifact) {
    const pending = [artifact], visited = new Set<string>()
    while (pending.length) {
      const current = pending.pop()!
      if (visited.has(current.id)) continue
      visited.add(current.id)
      for (const range of current.sources) {
        const source = this.state.sources.find((s) => s.id === range.sourceId)
        if (!source || this.state.sources.some((s) => s.projectId === source.projectId && s.origin === source.origin && s.version > source.version)) return true
      }
      for (const id of current.draft.dependencies) {
        const dependency = this.state.artifacts.find((a) => a.id === id)
        if (!dependency || dependency.status === 'rejected' || this.state.artifacts.some((a) =>
          a.projectId === dependency.projectId && a.draft.kind === dependency.draft.kind && a.draft.title === dependency.draft.title && a.version > dependency.version)) return true
        pending.push(dependency)
      }
    }
    return false
  }
  async import(projectId: string, origin: string, name: string, bytes: Buffer, guard: () => void) {
    guard()
    if (bytes.length > LIMIT) throw new CanvasError('原文超过 32 MiB', 413, 'SOURCE_TOO_LARGE')
    const { text, encoding } = decode(bytes), content = Buffer.from(text, 'utf16le'), sha256 = createHash('sha256').update(content).digest('hex')
    const previous = this.state.sources.filter((s) => s.projectId === projectId && s.origin === origin)
    const existing = previous.at(-1)?.sha256 === sha256 ? previous.at(-1) : undefined
    if (existing) return structuredClone(existing)
    if (this.state.sources.length >= 10000) throw new CanvasError('原文容量已满', 409, 'CREATIVE_STATE_FULL')
    const source: CreativeSource = { id: randomUUID(), projectId, origin, name, version: previous.length + 1,
      sha256, bytes: bytes.length, length: text.length, encoding, createdAt: Date.now(), sections: sections(text) }
    const path = join(this.sourcesDir, `${sha256}.utf16`)
    await writeFile(path, content, { flag: 'wx', mode: 0o600 }).catch((error) => { if (error.code !== 'EEXIST') throw error })
    guard(); this.state.sources.push(source); await this.persist(); guard()
    return structuredClone(source)
  }
  async page(projectId: string, id: string, start: number, length: number, signal: AbortSignal) {
    const source = this.source(projectId, id)
    if (start < 0 || start >= source.length || length < 1 || length > 12000) throw new CanvasError('原文分页范围无效', 400, 'SOURCE_RANGE')
    signal.throwIfAborted()
    const handle = await open(join(this.sourcesDir, `${source.sha256}.utf16`), constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const digest = createHash('sha256')
      for await (const chunk of handle.createReadStream({ autoClose: false })) { signal.throwIfAborted(); digest.update(chunk) }
      if (digest.digest('hex') !== source.sha256) throw new CanvasError('原文快照校验失败', 409, 'SOURCE_STALE')
      let end = Math.min(source.length, start + length)
      // Adjacent pages keep UTF-16 citation offsets without cutting a surrogate pair.
      const buffer = Buffer.alloc((end - start + (end < source.length ? 1 : 0)) * 2)
      await handle.read(buffer, 0, buffer.length, start * 2)
      let text = buffer.toString('utf16le').slice(0, end - start)
      if (/^[\uDC00-\uDFFF]/.test(text)) throw new CanvasError('起点切断了字符，请使用上一页返回的next', 400, 'SOURCE_RANGE')
      if (end < source.length && /[\uD800-\uDBFF]$/.test(text)) {
        if (text.length === 1) throw new CanvasError('分页长度切断了字符，请使用至少2个单位', 400, 'SOURCE_RANGE')
        end--; text = text.slice(0, -1)
      }
      signal.throwIfAborted()
      return { sourceId: id, version: source.version, sha256: source.sha256, start, end, text, next: end < source.length ? end : null, citation: { sourceId: id, start, end }, offsetUnit: 'UTF-16', totalLength: source.length }
    } finally { await handle.close() }
  }
  run(projectId: string, id: string) { return structuredClone(this.state.runs.find((r) => r.id === id && r.projectId === projectId)) }
  begin(projectId: string, id: string, role: CreativeRun['role'], input: unknown, task: string, sourceIds: string[], artifactIds: string[]) {
    const existing = this.state.runs.find((r) => r.id === id)
    if (existing) {
      if (existing.projectId !== projectId || existing.inputHash !== hash(input)) throw new CanvasError('任务 ID 已用于其他内容', 409, 'REQUEST_REUSED')
      return structuredClone(existing)
    }
    for (const source of sourceIds) this.source(projectId, source)
    for (const artifact of artifactIds) this.artifact(projectId, artifact)
    if (this.state.runs.length >= 10000) throw new CanvasError('创作任务容量已满', 409, 'CREATIVE_STATE_FULL')
    const run: CreativeRun = { id, projectId, role, inputHash: hash(input), task, sourceIds, artifactIds, state: 'running', createdAt: Date.now(), updatedAt: Date.now(), artifactOutputIds: [], readRanges: [], progress: '已启动' }
    this.state.runs.push(run); return structuredClone(run)
  }
  update(projectId: string, id: string, state: CreativeRun['state'], progress: string, result?: unknown) {
    const run = this.state.runs.find((r) => r.id === id && r.projectId === projectId)
    if (!run) throw new CanvasError('创作任务不存在')
    Object.assign(run, { state, progress, updatedAt: Date.now(), ...(result === undefined ? {} : { result: structuredClone(result) }) })
  }
  recordRead(projectId: string, taskId: string, range: { sourceId: string; start: number; end: number }) {
    const run = this.state.runs.find((r) => r.id === taskId && r.projectId === projectId)
    if (!run || !run.sourceIds.includes(range.sourceId)) throw new CanvasError('原文超出任务授权', 403, 'CREATIVE_SCOPE')
    const ranges = [...run.readRanges, range].sort((a, b) => a.sourceId.localeCompare(b.sourceId) || a.start - b.start)
    run.readRanges = []
    for (const item of ranges) {
      const last = run.readRanges.at(-1)
      if (last?.sourceId === item.sourceId && item.start <= last.end) last.end = Math.max(last.end, item.end)
      else run.readRanges.push({ ...item })
    }
    run.updatedAt = Date.now()
  }
  saveArtifact(input: CreativeArtifact) {
    input = CreativeArtifactSchema.parse(input)
    const existing = this.state.artifacts.find((a) => a.id === input.id)
    if (existing) {
      if (hash(existing) !== hash({ ...input, version: existing.version, createdAt: existing.createdAt })) throw new CanvasError('成果 ID 已用于其他内容', 409, 'REQUEST_REUSED')
      return this.artifact(existing.projectId, existing.id)
    }
    for (const id of input.draft.dependencies) this.artifact(input.projectId, id)
    for (const range of input.sources) if (range.end > this.source(input.projectId, range.sourceId).length) throw new CanvasError('引用超出原文', 400, 'SOURCE_RANGE')
    if (this.state.artifacts.length >= 10000) throw new CanvasError('成果容量已满', 409, 'CREATIVE_STATE_FULL')
    input.version = 1 + this.state.artifacts.filter((a) => a.projectId === input.projectId && a.draft.kind === input.draft.kind && a.draft.title === input.draft.title).length
    this.state.artifacts.push(structuredClone(input))
    const run = this.state.runs.find((r) => r.id === input.taskId && r.projectId === input.projectId)
    if (run) { run.artifactOutputIds.push(input.id); run.updatedAt = Date.now(); run.progress = `已保存 ${run.artifactOutputIds.length} 份成果` }
    return this.artifact(input.projectId, input.id)
  }
  decide(projectId: string, id: string, status: 'approved' | 'rejected', decision: string) {
    const artifact = this.state.artifacts.find((a) => a.id === id && a.projectId === projectId)
    if (!artifact) throw new CanvasError('成果不存在', 404, 'ARTIFACT_FORBIDDEN')
    artifact.status = status; artifact.decision = decision; return this.artifact(projectId, id)
  }
  persist() {
    const contents = JSON.stringify(this.state)
    const work = this.saving.then(async () => {
      const temp = `${this.path}.${randomUUID()}.tmp`
      await writeFile(temp, contents, { mode: 0o600 }); await rename(temp, this.path)
      for (const listener of this.listeners) { try { listener() } catch { /* Read-only observers cannot invalidate saved creative artifacts. */ } }
    })
    this.saving = work.catch(() => {}); return work
  }
}

/** The model supplies only a user-designated TXT/Markdown path below the root's actual workspace. */
export async function readCreativeSource(ctx: Context, agent: Agent, input: { path?: string; attachmentId?: string }, signal: AbortSignal) {
  const workspace = new AgentWorkspace(ctx), root = await workspace.root(agent, signal)
  let body: AsyncIterable<Uint8Array>, origin: string, name: string, dispose: () => Promise<void>
  let verify = async () => {}
  if (input.attachmentId) {
    const file = await readUserAttachment(ctx, agent, input.attachmentId, LIMIT, signal)
    name = file.filename; origin = `attachment:${input.attachmentId}`; body = file.body; dispose = async () => { file.body.destroy() }
  } else {
    const path = resolve(root, input.path!), rel = relative(root, path)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new CanvasError('原文必须在当前工作区内', 403, 'SOURCE_FORBIDDEN')
    let cursor = root
    for (const part of rel.split('/')) {
      cursor = join(cursor, part)
      if ((await lstat(cursor)).isSymbolicLink()) throw new CanvasError('原文路径不能包含符号链接', 403, 'UNSAFE_PATH')
    }
    if (await realpath(path) !== path) throw new CanvasError('原文路径已改变', 409, 'SOURCE_STALE')
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > LIMIT) { await handle.close(); throw new CanvasError('原文必须是 32 MiB 以内的普通文件', 413, 'SOURCE_TOO_LARGE') }
    body = handle.createReadStream({ autoClose: false }); dispose = () => handle.close(); name = path.split('/').at(-1)!; origin = `workspace:${rel}`
    verify = async () => {
      const current = await handle.stat(), located = await lstat(path)
      if (current.size !== stat.size || current.mtimeMs !== stat.mtimeMs || current.ctimeMs !== stat.ctimeMs ||
        located.isSymbolicLink() || located.ino !== stat.ino || located.dev !== stat.dev || await realpath(path) !== path)
        throw new CanvasError('读取期间原文已变化，请重试', 409, 'SOURCE_STALE')
    }
  }
  try {
    if (!['.txt', '.md', '.markdown'].includes(extname(name).toLowerCase())) throw new CanvasError('当前原文读取支持 TXT / Markdown；请先将 PDF、Word 等转为文本', 415, 'SOURCE_FORMAT')
    const chunks: Buffer[] = []; let bytes = 0
    for await (const chunk of body) { signal.throwIfAborted(); bytes += chunk.length; if (bytes > LIMIT) throw new CanvasError('原文超过 32 MiB', 413, 'SOURCE_TOO_LARGE'); chunks.push(Buffer.from(chunk)) }
    await verify(); signal.throwIfAborted()
    if (await workspace.root(agent, signal) !== root) throw new CanvasError('工作区已切换，请重新读取', 409, 'WORKSPACE_CHANGED')
    return { origin, name, bytes: Buffer.concat(chunks) }
  } finally { await dispose() }
}
