/** Poll only allowlisted configuration; coalesce edits and remember verified content. */
import { mkdir, open, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { hash } from './crypto.mjs'
import { collect, observe } from './snapshot.mjs'
import { uploadSnapshot } from './engine.mjs'
import { readManaged, writeManaged, safePath } from './files.mjs'
import { diagnostic } from './operation-error.mjs'

const STATE = 'config-vault/auto-state.json', LOCK = 'config-vault/auto.lock'
export const AUTO_DEFAULTS = { enabled: false, debounceMs: 30000, minIntervalMs: 300000 }
export const fingerprint = (snapshot, config) => hash(JSON.stringify({
  url: config.url, username: config.username, encryption: config.encryption !== false,
  profiles: [...config.profiles].sort(), includeHomePatch: config.includeHomePatch,
  runtime: snapshot.runtimeVersion, files: snapshot.files.map(file => [file.path, file.sha256]).sort((a, b) => a[0].localeCompare(b[0])),
}))

async function acquire(home) {
  await mkdir(await safePath(home, 'config-vault'), { recursive: true, mode: 0o700 })
  const path = await safePath(home, LOCK), token = randomUUID()
  for (let attempt = 0; attempt < 2; attempt++) {
    let file
    try { file = await open(path, 'wx', 0o600) }
    catch (error) {
      if (error.code !== 'EEXIST') throw error
      const raw = await readManaged(home, LOCK)
      if (raw === null) continue
      const owner = JSON.parse(raw)
      if (!Number.isInteger(owner.pid) || owner.pid < 1) return null
      try { process.kill(owner.pid, 0); return null }
      catch (failure) { if (failure.code !== 'ESRCH') return null }
      // Recheck ownership before reclaiming a lock from a dead process.
      if (await readManaged(home, LOCK) === raw) await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error })
      continue
    }
    try { await file.writeFile(JSON.stringify({ pid: process.pid, token })); await file.sync() }
    finally { await file.close() }
    return async () => {
      const raw = await readManaged(home, LOCK)
      if (raw && JSON.parse(raw).token === token) await unlink(path)
    }
  }
  return null
}

async function readState(home) {
  const raw = await readManaged(home, STATE)
  if (raw === null) return { version: 1 }
  const value = JSON.parse(raw)
  if (value.version !== 1 || (value.fingerprint !== undefined && !/^[a-f0-9]{64}$/.test(value.fingerprint)) || (value.lastAttemptAt !== undefined && (!Number.isFinite(value.lastAttemptAt) || value.lastAttemptAt < 0))) throw new Error('Invalid automatic backup state')
  return value
}

export class AutoBackup {
  constructor({ home, connection }) {
    this.home = home; this.connection = connection; this.candidate = null; this.retryAt = 0; this.failures = 0
    this.status = { phase: 'disabled', lastSuccessAt: null, snapshotId: null, nextAt: null, error: null }
  }
  async step({ config, passphrase, signal, now = Date.now() }) {
    const options = config.autoBackup ?? AUTO_DEFAULTS
    if (!options.enabled) { this.candidate = null; this.status.phase = 'disabled'; this.status.nextAt = null; return }
    if (config.encryption !== false && (!passphrase || passphrase.length < 12 || passphrase.length > 1024)) { this.status.phase = 'locked'; return }
    if (!config.url) { this.status.phase = 'connection-required'; return }
    if (now < this.retryAt) return
    let release, saved
    try {
      // Idle polling reads and hashes only: no YAML AST, lock writes or network.
      // This observation never authorizes an upload; collect again under the lock.
      const observedState = await readState(this.home)
      this.status.lastSuccessAt = observedState.lastSuccessAt ?? null; this.status.snapshotId = observedState.snapshotId ?? null
      this.status.retention = observedState.retention ?? null
      if (!observedState.pending) {
        const current = fingerprint(await observe({ home: this.home, ...config }), config)
        if (current === observedState.fingerprint) { this.candidate = null; this.status.phase = 'watching'; this.status.nextAt = null; this.status.error = null; return }
        if (this.candidate?.fingerprint !== current) this.candidate = { fingerprint: current, since: now }
        const due = Math.max(this.candidate.since + options.debounceMs, (observedState.lastAttemptAt ?? 0) + options.minIntervalMs)
        if (now < due) { this.status.phase = 'pending'; this.status.nextAt = due; return }
      }
      release = await acquire(this.home)
      if (!release) { this.status.phase = 'busy'; return }
      saved = await readState(this.home)
      this.status.lastSuccessAt = saved.lastSuccessAt ?? null; this.status.snapshotId = saved.snapshotId ?? null
      this.status.retention = saved.retention ?? null
      if (saved.pending) { this.status.phase = 'uncertain'; this.status.nextAt = null; return }
      const snapshot = await collect({ home: this.home, ...config })
      const current = fingerprint(snapshot, config)
      if (current === saved.fingerprint) { this.candidate = null; this.status.phase = 'watching'; this.status.nextAt = null; this.status.error = null; return }
      if (this.candidate?.fingerprint !== current) this.candidate = { fingerprint: current, since: now }
      const due = Math.max(this.candidate.since + options.debounceMs, (saved.lastAttemptAt ?? 0) + options.minIntervalMs)
      if (now < due) { this.status.phase = 'pending'; this.status.nextAt = due; return }
      signal?.throwIfAborted()
      saved = { ...saved, lastAttemptAt: now, pending: { id: snapshot.id, fingerprint: current } }
      // A crash or lost response leaves an uncertain attempt, never an automatic retry PUT.
      await writeManaged(this.home, STATE, JSON.stringify(saved))
      this.status.phase = 'backing-up'; this.status.nextAt = null
      const result = await uploadSnapshot(snapshot, { home: this.home, remote: await this.connection(config), passphrase, signal, encryption: config.encryption !== false, keepLast: config.keepLast ?? 30 })
      await this.record(saved, snapshot, config, result, now)
      this.failures = 0; this.retryAt = 0; this.candidate = null
    } catch (error) {
      const detail = diagnostic(error)
      if (saved?.pending && detail?.remoteMayExist === false) {
        delete saved.pending
        await writeManaged(this.home, STATE, JSON.stringify(saved)).catch(() => {})
      }
      this.status.phase = saved?.pending ? 'uncertain' : 'error'
      this.status.error = detail ?? { stage: 'collect', reason: 'failed' }
      this.retryAt = now + Math.min(options.minIntervalMs * 2 ** Math.min(this.failures++, 5), 3600000)
      this.status.nextAt = saved?.pending ? null : this.retryAt
    } finally { await release?.() }
  }
  async record(saved, snapshot, config, result, now) {
    const value = { version: 1, fingerprint: fingerprint(snapshot, config), lastAttemptAt: now, lastSuccessAt: new Date(now).toISOString(), snapshotId: result.id, retention: result.retention }
    await writeManaged(this.home, STATE, JSON.stringify(value))
    this.status = { phase: 'watching', lastSuccessAt: value.lastSuccessAt, snapshotId: result.id, nextAt: null, error: null, retention: result.retention }
  }
  async noteManual(snapshot, config, result) {
    if (!config.autoBackup?.enabled) return
    const release = await acquire(this.home)
    if (!release) return
    try { await this.record({}, snapshot, config, result, Date.now()); this.candidate = null }
    finally { await release() }
  }
  async retry() {
    const release = await acquire(this.home)
    if (!release) return false
    try {
      const saved = await readState(this.home)
      delete saved.pending
      await writeManaged(this.home, STATE, JSON.stringify(saved))
      this.candidate = null; this.retryAt = 0; this.failures = 0; this.status.error = null
      this.status.phase = 'watching'
      return true
    } finally { await release() }
  }
}
