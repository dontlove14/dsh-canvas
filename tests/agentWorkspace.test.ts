import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createHash } from 'node:crypto'
import { AgentWorkspace } from '../src/host/agent/workspace'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'

const cleanup: string[] = []
afterEach(async () => { for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true }) })
async function fixture() {
  let cwd = await mkdtemp(join(tmpdir(), 'agent-workspace-')); cleanup.push(cwd)
  const root = cwd, agent = { session: {} } as Agent
  const workspace = new AgentWorkspace({ workingDirectory: { ensure: async () => cwd, get: () => cwd } } as unknown as Context)
  const project = { name: '../产品:广告', id: 'project-one' }, signal = new AbortController()
  const save = (body: Readable, expected?: { bytes: number; sha256: string }, guard = () => {}) =>
    workspace.publish(agent, project, ['媒体', '视频'], '镜头.mp4', body, 1024, signal.signal, guard, expected)
  return { root, agent, workspace, save, signal, setCwd: (value: string) => { cwd = value } }
}
it('streams exact media bytes and hash to the project category and does not overwrite on retry', async () => {
  const f = await fixture(), bytes = Buffer.from('exact original media'), expected = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  const file = await f.save(Readable.from([bytes.subarray(0, 4), bytes.subarray(4)]), expected)
  expect(file.relativePath).toContain('/媒体/视频/镜头.mp4')
  expect(await readFile(file.path)).toEqual(bytes)
  expect(await f.save(Readable.from([bytes]), expected)).toEqual(file)
  await expect(f.save(Readable.from(['corrupt']), expected)).rejects.toMatchObject({ code: 'FILE_HASH_MISMATCH' })
  expect(await readFile(file.path)).toEqual(bytes)
})
it.each(['cwd', 'cancel', 'guard', 'limit'] as const)('cleans partial streams and publishes nothing after %s', async (mode) => {
  const f = await fixture(), second = await mkdtemp(join(tmpdir(), 'agent-workspace-next-')); cleanup.push(second)
  let revoked = false
  const body = Readable.from((async function* () {
    yield Buffer.from('first')
    if (mode === 'cwd') f.setCwd(second)
    if (mode === 'cancel') f.signal.abort()
    if (mode === 'guard') revoked = true
    yield Buffer.alloc(mode === 'limit' ? 2048 : 5)
  })())
  await expect(f.save(body, undefined, () => { if (revoked) throw new Error('control revoked') })).rejects.toThrow()
  async function files(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true })
    return (await Promise.all(entries.map((entry) => entry.isDirectory() ? files(join(dir, entry.name)) : [entry.name]))).flat()
  }
  expect(await files(f.root)).toEqual([])
  expect(await files(second)).toEqual([])
})
