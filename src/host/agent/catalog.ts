import { randomUUID } from 'node:crypto'
import { AGENT_FOLDER } from '../../shared/agent'
import { CanvasError, type Store } from '../store'
import { hash } from '../persistence/database'
import type { AgentLedger } from './ledger'

/** The catalogue itself enforces owner/name uniqueness and stable creation receipts. */
export async function createAgentCanvas(store: Store, ledger: AgentLedger, operationId: string, name: string, guard: () => void) {
  const receiptKey = `create:${operationId}`, identity = { operationId, name }
  const pinned = ledger.receipt(receiptKey, identity)?.value as { folderId: string } | undefined
  const previous = await store.db.get('SELECT * FROM catalog_mutations WHERE owner_id=? AND request_id=?', [store.owner, operationId])
  if (previous) {
    const value = JSON.parse(previous.result_json)
    const catalog = await store.catalog(), row = catalog.canvases.find((c) => c.id === value.id)
    if (previous.operation !== 'canvas-create' || !row) throw new CanvasError('操作 ID 已被使用', 409, 'REQUEST_REUSED')
    // A retry must use the original input even after a user rename or move.
    const input = { requestId: operationId, operation: 'canvas-create', name, ...(pinned ? { folderId: pinned.folderId } : {}) }
    if (previous.request_hash !== hash(input)) throw new CanvasError('操作 ID 已用于其他内容', 409, 'REQUEST_REUSED')
    guard()
    return { id: value.id, folderName: catalog.folders.find((f) => f.id === row.folderId)?.name ?? '未归档', folderCreated: false }
  }
  guard()
  let folder = (await store.catalog()).folders.find((f) => f.name === AGENT_FOLDER), folderCreated = false
  if (!folder) {
    try {
      const made = await store.catalogCommand({ requestId: randomUUID(), operation: 'folder-create', name: AGENT_FOLDER }, guard)
      folder = (await store.catalog()).folders.find((f) => f.id === made.id); folderCreated = true
    } catch (e) {
      if (!(e instanceof CanvasError) || e.code !== 'NAME_EXISTS') throw e
      folder = (await store.catalog()).folders.find((f) => f.name === AGENT_FOLDER)
    }
  }
  if (!folder) throw new CanvasError('Agent 创作文件夹创建失败')
  ledger.remember(receiptKey, identity, { folderId: folder.id }); await ledger.persist()
  guard()
  const made = await store.catalogCommand({ requestId: operationId, operation: 'canvas-create', name, folderId: folder.id }, guard)
  return { ...made, folderName: AGENT_FOLDER, folderCreated }
}
