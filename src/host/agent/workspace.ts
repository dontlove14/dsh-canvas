import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-working-directory'
import { createHash, randomUUID } from 'node:crypto'
import { constants, createWriteStream } from 'node:fs'
import { mkdir, lstat, realpath, open, link, rm } from 'node:fs/promises'
import { join, isAbsolute, relative } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { CanvasError } from '../store'
import { safeName } from '../media/files'
import { AGENT_FOLDER } from '../../shared/agent'

export interface WorkspaceFile { path: string; relativePath: string; bytes: number; sha256: string }
/** Components are owned by this tool; never accept a model-provided destination path. */
async function directory(root: string, parts: string[], create: boolean) {
  let path = root
  for (const part of parts) {
    if (part !== safeName(part) || part === '.' || part === '..') throw new CanvasError('无效工作区目录', 409, 'UNSAFE_PATH')
    path = join(path, part)
    if (create) await mkdir(path, { mode: 0o700 }).catch((e) => { if (e.code !== 'EEXIST') throw e })
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new CanvasError('工作区目录不能是符号链接', 409, 'UNSAFE_PATH')
    if (await realpath(path) !== path) throw new CanvasError('工作区目录已改变', 409, 'UNSAFE_PATH')
  }
  return path
}
async function identity(path: string, signal: AbortSignal): Promise<{ bytes: number; sha256: string } | null> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch((e) => { if (e.code === 'ENOENT') return null; throw new CanvasError('目标文件不可安全读取', 409, 'UNSAFE_PATH') })
  if (!handle) return null
  try {
    if (!(await handle.stat()).isFile()) throw new CanvasError('目标不是普通文件', 409, 'UNSAFE_PATH')
    let bytes = 0; const digest = createHash('sha256')
    for await (const chunk of handle.createReadStream({ autoClose: false })) { signal.throwIfAborted(); bytes += chunk.length; digest.update(chunk) }
    return { bytes, sha256: digest.digest('hex') }
  } finally { await handle.close() }
}
export class AgentWorkspace {
  constructor(private ctx: Context) {}
  async root(agent: Agent, signal: AbortSignal) {
    const cwd = await this.ctx.workingDirectory.ensure(agent, signal)
    if (!isAbsolute(cwd)) throw new CanvasError('当前工作区不是绝对路径', 409, 'UNSAFE_PATH')
    return realpath(cwd)
  }
  async verify(agent: Agent, file: WorkspaceFile, signal: AbortSignal) {
    const root = await this.root(agent, signal), rel = relative(root, file.path)
    if (rel.startsWith('..') || isAbsolute(rel)) throw new CanvasError('文件属于另一个工作区，请使用新操作 ID 保存', 409, 'WORKSPACE_CHANGED')
    const parts = rel.split(/[\\/]/), filename = parts.pop()!
    const dir = await directory(root, parts, false)
    const saved = await identity(join(dir, filename), signal)
    if (!saved || saved.bytes !== file.bytes || saved.sha256 !== file.sha256) throw new CanvasError('已交付文件已被修改或移除，请使用新操作 ID 保存', 409, 'FILE_COLLISION')
  }
  async publish(agent: Agent, project: { id: string; name: string }, parts: string[], filename: string,
    body: Readable, limit: number, signal: AbortSignal, guard: () => void, expected?: { bytes: number; sha256: string }): Promise<WorkspaceFile> {
    let temporary: string | undefined
    try {
      signal.throwIfAborted(); guard()
      const root = await this.root(agent, signal)
      const admittedCwd = this.ctx.workingDirectory.get(agent.session)
      const components = [AGENT_FOLDER, `${safeName(project.name)}-${safeName(project.id).slice(0, 12)}`, ...parts]
      const destinationDir = await directory(root, components, true)
      const destination = join(destinationDir, safeName(filename))
      temporary = join(destinationDir, `.写入-${randomUUID()}`)
      const digest = createHash('sha256'); let bytes = 0
      const meter = new Transform({ transform(chunk: Buffer, _encoding, done) {
        bytes += chunk.length
        if (bytes > limit) { done(new CanvasError('工作区文件超过大小限制', 413, 'MEDIA_TOO_LARGE')); return }
        digest.update(chunk); done(null, chunk)
      } })
      await pipeline(body, meter, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), { signal })
      const sha256 = digest.digest('hex')
      if (expected && (expected.bytes !== bytes || expected.sha256 !== sha256)) throw new CanvasError('素材下载字节校验失败', 409, 'FILE_HASH_MISMATCH')
      const handle = await open(temporary, constants.O_RDWR | constants.O_NOFOLLOW)
      try { await handle.sync() } finally { await handle.close() }
      if (await this.root(agent, signal) !== root) throw new CanvasError('当前工作区已切换，请在新工作区重新保存', 409, 'WORKSPACE_CHANGED')
      await directory(root, components, false)
      const existing = await identity(destination, signal)
      if (existing && (existing.sha256 !== sha256 || existing.bytes !== bytes)) throw new CanvasError('文件已存在且内容不同，不会覆盖用户文件', 409, 'FILE_COLLISION')
      signal.throwIfAborted(); guard()
      if (this.ctx.workingDirectory.get(agent.session) !== admittedCwd) throw new CanvasError('当前工作区已切换', 409, 'WORKSPACE_CHANGED')
      if (!existing) {
        try { await link(temporary, destination) }
        catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
          const raced = await identity(destination, signal)
          if (raced?.sha256 !== sha256 || raced.bytes !== bytes) throw new CanvasError('文件名称已被使用', 409, 'FILE_COLLISION')
        }
        const dir = await open(destinationDir, 'r')
        try { await dir.sync() } finally { await dir.close() }
      }
      return { path: destination, relativePath: relative(root, destination), bytes, sha256 }
    } finally { body.destroy(); if (temporary) await rm(temporary, { force: true }) }
  }
}
