/** Local upload receipts are the authority for ownership, never remote metadata. */
import { mkdir, open, readdir, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { hash } from './crypto.mjs'
import { validateId } from './snapshot.mjs'
import { readManaged, safePath, writeManaged } from './files.mjs'

export const DEFAULT_KEEP_LAST = 30
const DEVICE = 'config-vault/retention-device.json'
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const safeId = id => { try { return validateId(id) } catch { return null } }
const validCount = count => Number.isInteger(count) && count >= 1 && count <= 10000
const REASONS = ['unsupported-transport', 'busy', 'changed', 'no-strong-etag', 'local-state', 'http', 'network', 'tls', 'timeout', 'cancelled', 'size', 'invalid-data']
function publicResult(value) {
  if (!value || !['ok', 'warning', 'deferred'].includes(value.status) || !validCount(value.keepLast) || !Number.isInteger(value.deleted) || value.deleted < 0 || value.deleted > 50 || !Number.isInteger(value.pending) || value.pending < 0 || value.pending > 50000) throw new Error('Invalid cleanup summary')
  return { status: value.status, keepLast: value.keepLast, deleted: value.deleted, pending: value.pending,
    ...(REASONS.includes(value.reason) ? { reason: value.reason } : {}),
    ...(Number.isInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599 ? { httpStatus: value.httpStatus } : {}) }
}

async function deviceId(home, create = false) {
  let raw = await readManaged(home, DEVICE)
  if (raw === null && create) {
    await mkdir(await safePath(home, 'config-vault'), { recursive: true, mode: 0o700 })
    let file
    try { file = await open(await safePath(home, DEVICE), 'wx', 0o600) }
    catch (error) { if (error.code !== 'EEXIST') throw error }
    if (file) {
      try { await file.writeFile(JSON.stringify({ version: 1, id: randomUUID() })); await file.sync() }
      finally { await file.close() }
    }
    raw = await readManaged(home, DEVICE)
  }
  if (raw === null) return null
  const value = JSON.parse(raw)
  if (value.version !== 1 || !UUID.test(value.id)) throw new Error('Invalid local device identity')
  return value.id
}

const directory = (scope, id) => `config-vault/retention/${hash(scope)}/${id}`
async function lock(home, dir) {
  const path = `${dir}/cleanup.lock`, token = randomUUID()
  for (let attempt = 0; attempt < 2; attempt++) {
    let file
    try { file = await open(await safePath(home, path), 'wx', 0o600) }
    catch (error) {
      if (error.code !== 'EEXIST') throw error
      const raw = await readManaged(home, path)
      if (raw === null) continue
      const owner = JSON.parse(raw)
      if (!Number.isInteger(owner.pid) || owner.pid < 1) return null
      try { process.kill(owner.pid, 0); return null }
      catch (failure) { if (failure.code !== 'ESRCH') return null }
      if (await readManaged(home, path) === raw) await unlink(await safePath(home, path)).catch(error => { if (error.code !== 'ENOENT') throw error })
      continue
    }
    try { await file.writeFile(JSON.stringify({ pid: process.pid, token })); await file.sync() }
    finally { await file.close() }
    return async () => {
      const raw = await readManaged(home, path)
      if (raw && JSON.parse(raw).token === token) await unlink(await safePath(home, path))
    }
  }
  return null
}

export async function retentionStatus(home, remote) {
  try {
    const id = await deviceId(home)
    if (!id || !remote?.retentionScope) return { deviceId: id, lastCleanup: null }
    const raw = await readManaged(home, `${directory(remote.retentionScope, id)}/status.json`)
    return { deviceId: id, lastCleanup: raw ? publicResult(JSON.parse(raw)) : null }
  } catch { return { deviceId: null, lastCleanup: { status: 'warning', deleted: 0, reason: 'local-state' } } }
}

/** Called only after a new object was downloaded and matched byte-for-byte data. */
export async function retainVerified({ home, remote, snapshot, bytes, keepLast = DEFAULT_KEEP_LAST, signal }) {
  const result = { status: 'ok', keepLast, deleted: 0, pending: 0 }
  const cleanupSignal = AbortSignal.any([AbortSignal.timeout(30000), ...signal ? [signal] : []])
  let release, dir
  try {
    if (!validCount(keepLast)) throw new Error('Invalid retention count')
    if (!home || !remote?.retentionScope) return { ...result, status: 'warning', reason: 'unsupported-transport' }
    const owner = await deviceId(home, true)
    dir = directory(remote.retentionScope, owner)
    const receipt = { version: 1, deviceId: owner, scope: hash(remote.retentionScope), id: snapshot.id, sha256: hash(bytes), verifiedAt: Date.now() }
    // Each upload has its own atomic receipt, so concurrent cleanups cannot lose
    // registration of a newly verified backup. No configuration or key is saved.
    await writeManaged(home, `${dir}/${validateId(snapshot.id)}.json`, JSON.stringify(receipt))
    release = await lock(home, dir)
    if (!release) return { ...result, status: 'deferred', reason: 'busy' }
    const entries = await readdir(await safePath(home, dir), { withFileTypes: true })
    const receipts = []
    for (const entry of entries) {
      cleanupSignal.throwIfAborted()
      if (!entry.name.endsWith('.json') || !safeId(entry.name.slice(0, -5))) continue
      if (!entry.isFile()) throw new Error('Invalid receipt file')
      const raw = await readManaged(home, `${dir}/${entry.name}`)
      const value = JSON.parse(raw)
      if (value.version !== 1 || value.deviceId !== owner || value.scope !== receipt.scope || value.id !== entry.name.slice(0, -5) || !/^[a-f0-9]{64}$/.test(value.sha256) || !Number.isFinite(value.verifiedAt) || value.verifiedAt < 0) throw new Error('Invalid upload receipt')
      receipts.push(value)
      if (receipts.length > 50000) throw new Error('Too many local receipts')
    }
    receipts.sort((a, b) => b.verifiedAt - a.verifiedAt || b.id.localeCompare(a.id))
    const retained = new Set(receipts.slice(0, keepLast).map(item => item.id))
    retained.add(snapshot.id) // Never delete the just-verified recovery point.
    const candidates = receipts.filter(item => !retained.has(item.id) && item.verifiedAt <= receipt.verifiedAt).reverse()
    result.pending = candidates.length
    for (const item of candidates.slice(0, 50)) {
      cleanupSignal.throwIfAborted()
      if (typeof remote.getVersion !== 'function' || typeof remote.remove !== 'function') { result.status = 'warning'; result.reason = 'unsupported-transport'; break }
      let version
      try { version = await remote.getVersion(item.id, cleanupSignal) }
      catch (error) {
        if (error.status !== 404) throw error
        await writeManaged(home, `${dir}/${item.id}.json`, null); result.pending--; continue
      }
      if (hash(version.bytes) !== item.sha256) { result.status = 'warning'; result.reason = 'changed'; continue }
      if (!/^"[^"\r\n]+"$/.test(version.etag ?? '')) { result.status = 'warning'; result.reason = 'no-strong-etag'; continue }
      // If another writer replaces this exact object after GET, If-Match must
      // fail. A copied device tag or a matching filename alone never authorizes deletion.
      await remote.remove(item.id, version.etag, cleanupSignal)
      await writeManaged(home, `${dir}/${item.id}.json`, null)
      result.deleted++; result.pending--
    }
  } catch (error) {
    result.status = 'warning'
    result.reason = signal?.aborted ? 'cancelled' : cleanupSignal.aborted ? 'timeout' : ['cleanup', 'download'].includes(error.stage) ? (['http', 'network', 'tls', 'timeout', 'cancelled', 'size', 'invalid-data'].includes(error.reason) ? error.reason : 'network') : 'local-state'
    if (Number.isInteger(error.status) && error.status >= 100 && error.status <= 599) result.httpStatus = error.status
  } finally {
    if (release) {
      try { if (dir) await writeManaged(home, `${dir}/status.json`, JSON.stringify(result)) }
      catch { result.status = 'warning'; result.reason = 'local-state' }
      await release().catch(() => { result.status = 'warning'; result.reason = 'local-state' })
    }
  }
  return result
}
