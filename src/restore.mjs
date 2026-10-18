/** Offline restore with optimistic preconditions and an encrypted recovery journal. */
import { mkdir, open, unlink, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { hash, seal, unseal } from './crypto.mjs'
import { managedPath, readManaged, safePath, writeManaged } from './files.mjs'
import { digest, validateSnapshot, warningsFor, RUNTIME } from './snapshot.mjs'

const ACTIVE = 'config-vault/active.vault'
const LOCK = 'config-vault/restore.lock'

export async function preview(snapshot, { home, runtimeVersion = RUNTIME, preserveLocal = false }) {
  validateSnapshot(snapshot)
  const files = []
  for (const file of snapshot.files) {
    const before = await readManaged(home, file.path)
    files.push({ path: file.path, beforeHash: digest(before), afterHash: file.sha256, action: before === file.content ? 'unchanged' : before === null ? 'create' : 'replace' })
  }
  let warnings = warningsFor(snapshot, runtimeVersion)
  if (preserveLocal) {
    const preserved = new Set()
    for (const warning of warnings.filter(w => w.code === 'local-dependency')) {
      const before = await readManaged(home, warning.path)
      const after = snapshot.files.find(f => f.path === warning.path)?.content
      if (before !== null && after && warning.dependency && Object.hasOwn(JSON.parse(before).dependencies ?? {}, warning.dependency) && JSON.parse(before).dependencies[warning.dependency] === JSON.parse(after).dependencies?.[warning.dependency]) preserved.add(warning)
    }
    warnings = warnings.filter(w => !preserved.has(w))
  }
  const blocked = warnings.some(w => ['runtime-version', 'local-dependency'].includes(w.code))
  const plan = { snapshotId: snapshot.id, home: resolve(home), runtimeVersion, files, warnings, blocked, mode: 'offline-overlay', dependenciesInstalled: false }
  return { ...plan, token: hash(JSON.stringify(plan)) }
}

async function lock(home, { recover = false } = {}) {
  await safePath(home, LOCK)
  await mkdir(await safePath(home, 'config-vault'), { recursive: true, mode: 0o700 })
  let file
  try { file = await open(await safePath(home, LOCK), 'wx', 0o600) }
  catch (error) {
    if (error.code !== 'EEXIST' || !recover) throw new Error('Restore is locked; stop the other operation or inspect recovery')
    const saved = JSON.parse(await readFile(await safePath(home, LOCK), 'utf8'))
    if (!Number.isInteger(saved.pid) || saved.pid <= 0) throw new Error('Invalid restore lock; manual inspection required')
    try { process.kill(saved.pid, 0); throw new Error('Restore owner is still running') }
    catch (failure) { if (failure.code !== 'ESRCH') throw failure }
    await unlink(await safePath(home, LOCK))
    file = await open(await safePath(home, LOCK), 'wx', 0o600)
  }
  await file.writeFile(JSON.stringify({ pid: process.pid })); await file.sync(); await file.close()
  return () => unlink(resolve(home, LOCK))
}

/** Apply only a reviewed plan. Caller must stop every Harness using this home. */
export async function restore(snapshot, { home, token, passphrase, offline = false, runtimeVersion = RUNTIME, preserveLocal = false }) {
  if (!offline) throw new Error('Stop all Harness processes using the target home and pass --offline')
  const release = await lock(home)
  try {
    if (await readManaged(home, ACTIVE) !== null) throw new Error('Unfinished restore exists; recover it first')
    const plan = await preview(snapshot, { home, runtimeVersion, preserveLocal })
    if (plan.blocked) throw new Error('Restore blocked by runtime mismatch or local plugin dependency; migrate manually')
    if (token !== plan.token) throw new Error('Restore plan changed or was not confirmed; preview again')
    const changes = []
    for (const file of snapshot.files) {
      const before = await readManaged(home, file.path)
      if (digest(before) !== plan.files.find(item => item.path === file.path).beforeHash) throw new Error('Target changed after preview')
      if (before !== file.content) changes.push({ path: file.path, before, after: file.content })
    }
    if (!changes.length) return { status: 'unchanged', files: 0, dependenciesInstalled: false }
    const journal = { format: 'dsh-config-vault-journal', version: 1, id: randomUUID(), snapshotId: snapshot.id, changes }
    const encrypted = await seal(journal, passphrase)
    // Retained before the first target write; remains available after success.
    await writeManaged(home, `config-vault/rollback-${journal.id}.vault`, encrypted.toString('utf8'))
    await writeManaged(home, ACTIVE, encrypted.toString('utf8'))
    try {
      for (const change of changes) {
        if (await readManaged(home, change.path) !== change.before) throw new Error('Target was edited during restore')
        await writeManaged(home, change.path, change.after)
      }
      for (const change of changes) if (await readManaged(home, change.path) !== change.after) throw new Error('Restored file verification failed')
      await writeManaged(home, ACTIVE, null)
      return { status: 'restored', files: changes.length, rollbackId: journal.id, dependenciesInstalled: false, next: 'With Harness stopped, inspect the restored manifest, install its dependencies through dsh plugin, then restart and verify plugin loading.' }
    } catch (failure) {
      try { await rollback(home, journal); await writeManaged(home, ACTIVE, null) }
      catch { throw new Error('Restore failed and automatic rollback is incomplete; run recover while offline') }
      throw new Error('Restore failed; original file contents restored', { cause: failure })
    }
  } finally { await release() }
}

function validateJournal(journal) {
  if (!journal || journal.format !== 'dsh-config-vault-journal' || journal.version !== 1 || !Array.isArray(journal.changes) || !journal.changes.length || journal.changes.length > 128) throw new Error('Invalid recovery journal')
  const paths = new Set()
  for (const change of journal.changes) {
    if (!managedPath(change.path) || paths.has(change.path) || (change.before !== null && typeof change.before !== 'string') || typeof change.after !== 'string') throw new Error('Invalid recovery entry')
    paths.add(change.path)
  }
}

async function rollback(home, journal) {
  validateJournal(journal)
  // Check all files before changing any. Never overwrite unrelated subsequent edits.
  for (const change of journal.changes) {
    const current = await readManaged(home, change.path)
    if (current !== change.before && current !== change.after) throw new Error('Recovery conflicts with a subsequent local edit')
  }
  for (const change of [...journal.changes].reverse()) {
    const current = await readManaged(home, change.path)
    if (current !== change.before && current !== change.after) throw new Error('Target changed during recovery')
    if (current !== change.before) await writeManaged(home, change.path, change.before)
  }
}

/** Preview or execute rollback from the active journal or a retained transaction. */
export async function recover({ home, passphrase, rollbackId, token, offline = false }) {
  if (rollbackId !== undefined && !/^[a-f0-9-]{36}$/.test(rollbackId)) throw new Error('Invalid rollback id')
  const path = rollbackId ? `config-vault/rollback-${rollbackId}.vault` : ACTIVE
  const content = await readManaged(home, path)
  if (content === null) throw new Error('No recovery journal found')
  const journal = await unseal(Buffer.from(content), passphrase)
  validateJournal(journal)
  const files = []
  for (const change of journal.changes) {
    const current = await readManaged(home, change.path)
    files.push({ path: change.path, currentHash: digest(current), restoredHash: digest(change.before), conflict: current !== change.before && current !== change.after })
  }
  const plan = { transactionId: journal.id, home: resolve(home), files }
  const expected = hash(JSON.stringify(plan))
  if (token === undefined) return { ...plan, token: expected }
  if (!offline || token !== expected || files.some(file => file.conflict)) throw new Error('Recovery requires offline mode and an unchanged conflict-free plan')
  const release = await lock(home, { recover: true })
  try {
    // A retained rollback must not erase the journal of a different unfinished transaction.
    const active = await readManaged(home, ACTIVE)
    if (active !== null && (await unseal(Buffer.from(active), passphrase)).id !== journal.id) throw new Error('Recover the active transaction first')
    await rollback(home, journal)
    await writeManaged(home, ACTIVE, null)
    return { status: 'rolled-back', transactionId: journal.id }
  } finally { await release() }
}

// Shared offline mutation exclusion for provider transitions and snapshot recovery.
export { lock as restoreLock }
