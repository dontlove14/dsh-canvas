import { Worker } from 'node:worker_threads'
import { createHash, randomUUID } from 'node:crypto'
import { canonical } from '../../shared/v2'

export type SqlValue = string | number | null
export interface Statement { sql: string; params?: SqlValue[]; mode?: 'all' | 'get' | 'run'; expect?: number }
export const sql = (text: string, params: SqlValue[] = [], mode: Statement['mode'] = 'run', expect?: number): Statement => ({ sql: text, params, mode, expect })
export const hash = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex')
export class Database {
  readonly token = randomUUID()
  private worker?: Worker
  private sequence = 0
  private pending = new Map<number, { resolve: (v: any[]) => void; reject: (e: Error) => void }>()
  async open(path: string): Promise<void> {
    this.worker = new Worker(new URL('./worker.mjs', import.meta.url), { workerData: { path } })
    await new Promise<void>((resolve, reject) => {
      this.worker!.on('message', (message) => {
        if (message.ready) { resolve(); return }
        const callback = this.pending.get(message.id)
        if (!callback) return
        this.pending.delete(message.id)
        if (message.error) callback.reject(new Error(message.error))
        else callback.resolve(message.result)
      })
      this.worker!.on('error', (error) => {
        reject(error)
        for (const callback of this.pending.values()) callback.reject(error)
        this.pending.clear()
      })
      this.worker!.on('exit', (code) => {
        const error = new Error(`SQLite worker exited (${code})`)
        reject(error)
        for (const callback of this.pending.values()) callback.reject(error)
        this.pending.clear()
      })
    })
  }
  batch(steps: Statement[], write = true, claim = false): Promise<any[]> {
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.worker!.postMessage({ id, steps, write, token: claim ? null : this.token })
    })
  }
  async all<T = any>(text: string, params: SqlValue[] = []): Promise<T[]> { return (await this.batch([sql(text, params, 'all')], false))[0] }
  async get<T = any>(text: string, params: SqlValue[] = []): Promise<T | null> { return (await this.batch([sql(text, params, 'get')], false))[0] }
  async close(): Promise<void> {
    if (!this.worker) return
    const id = ++this.sequence
    await new Promise<void>((resolve, reject) => {
      this.pending.set(id, { resolve: () => resolve(), reject })
      this.worker!.postMessage({ id, close: true })
    })
    await this.worker.terminate()
    this.worker = undefined
  }
}
