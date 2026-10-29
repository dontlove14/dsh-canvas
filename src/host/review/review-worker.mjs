import { parentPort, workerData } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, chmodSync } from 'node:fs'

const main = new DatabaseSync(workerData.mainPath, { readOnly: true })
const db = new DatabaseSync(workerData.path)
db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;')
const version = db.prepare('PRAGMA user_version').get().user_version
if (version !== 0 && version !== 1) throw new Error(`Unsupported review schema ${version}`)
db.exec(readFileSync(new URL('./review-schema.sql', import.meta.url), 'utf8'))
chmodSync(workerData.path, 0o600)
parentPort.postMessage({ ready: true })
parentPort.on('message', ({ id, steps, write, close }) => {
  try {
    if (close) { db.close(); main.close(); parentPort.postMessage({ id, result: [] }); return }
    if (write && main.prepare('SELECT runtime_token FROM owner_settings WHERE owner_id=?').get('local-owner')?.runtime_token !== workerData.mainToken)
      throw new Error('WRITER_FENCED')
    db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN')
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
