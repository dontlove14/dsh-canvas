import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import type { CredentialProvider, CredentialKey } from '@deepseek-ai/dsh-credentials'

export interface CredentialVault { put(key: string): Promise<string>; read(ref: string): Promise<string> }
export class HarnessVault implements CredentialVault {
  constructor(private provider: CredentialProvider) {}
  async put(key: string): Promise<string> {
    const ref = `dsh-canvas/key-${randomUUID()}`
    await this.provider.modifyRecord(ref as CredentialKey, async () => ({ kind: 'api-key', ...(key ? { key } : {}) }))
    return ref
  }
  async read(ref: string): Promise<string> {
    if (!/^dsh-canvas\/key-[a-f0-9-]+$/.test(ref)) throw new Error('Invalid plugin credential reference')
    const record = await this.provider.readRecord(ref as CredentialKey)
    if (!record || record.kind !== 'api-key') throw new Error('任务凭据版本缺失')
    return record.key ?? ''
  }
}
export async function atomicJson(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`
  const handle = await open(temp, 'wx', 0o600)
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync() } finally { await handle.close() }
  await rename(temp, path)
}
export class LocalVault implements CredentialVault {
  constructor(private root: string) {}
  async put(key: string): Promise<string> {
    await mkdir(join(this.root, 'vault'), { recursive: true, mode: 0o700 })
    const ref = `key-${randomUUID()}`
    await atomicJson(join(this.root, 'vault', `${ref}.json`), { key })
    return ref
  }
  async read(ref: string): Promise<string> {
    if (!/^key-[a-f0-9-]+$/.test(ref)) throw new Error('Invalid local credential reference')
    return JSON.parse(await readFile(join(this.root, 'vault', `${ref}.json`), 'utf8')).key
  }
}
