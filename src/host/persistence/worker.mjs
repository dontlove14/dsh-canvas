import { parentPort, workerData } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'

const db = new DatabaseSync(workerData.path)
db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;')
const version = db.prepare('PRAGMA user_version').get().user_version
if (version !== 0 && version !== 2) throw new Error(`Unsupported canvas schema ${version}`)
db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'))
if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Canvas foreign key check failed')
if (db.prepare('SELECT id FROM task_catalog WHERE id NOT IN (SELECT task_id FROM task_details)').all().length) throw new Error('Task detail missing')
parentPort.postMessage({ ready: true })
parentPort.on('message', ({ id, steps, write, token, close }) => {
  try {
    if (close) { db.close(); parentPort.postMessage({ id, result: [] }); return }
    db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN')
    if (write && token) {
      const owner = db.prepare('SELECT runtime_token FROM owner_settings').get()
      if (owner && owner.runtime_token !== token) throw new Error('WRITER_FENCED')
    }
    const result = steps.map(({ sql, params = [], mode = 'run', expect }) => {
      const statement = db.prepare(sql)
      const value = mode === 'all' ? statement.all(...params) : mode === 'get' ? statement.get(...params) ?? null : statement.run(...params)
      if (expect !== undefined && Number(value?.changes ?? 0) !== expect) throw new Error('CAS_CONFLICT')
      return value
    })
    db.exec('COMMIT')
    parentPort.postMessage({ id, result })
  } catch (error) {
    try { db.exec('ROLLBACK') } catch {}
    parentPort.postMessage({ id, error: error.message })
  }
})
