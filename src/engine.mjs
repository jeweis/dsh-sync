/** The CLI and Harness tools share this backup/download pipeline. */
import { collect, validateSnapshot, warningsFor, RUNTIME } from './snapshot.mjs'
import { seal, unseal, MAX_BYTES } from './crypto.mjs'
import { WebDAV } from './webdav.mjs'
import { OperationError, atStage } from './operation-error.mjs'
import { retainVerified } from './retention.mjs'
export { preview, restore, recover } from './restore.mjs'

export function transportFromEnvironment(environment = process.env, options = {}) {
  const url = options.url ?? environment.DSH_VAULT_WEBDAV_URL
  if (!url) throw new Error('Set DSH_VAULT_WEBDAV_URL before using remote storage')
  return new WebDAV({ url, username: options.username ?? environment.DSH_VAULT_WEBDAV_USERNAME ?? '', password: environment.DSH_VAULT_WEBDAV_PASSWORD ?? '', timeoutMs: options.timeoutMs ?? 30000 })
}
export function passphraseFromEnvironment(environment = process.env) {
  const passphrase = environment.DSH_VAULT_PASSPHRASE
  if (!passphrase) throw new Error('Set DSH_VAULT_PASSPHRASE in the process environment')
  return passphrase
}

/** Upload an encrypted immutable object, then download and authenticate it. */
export async function backup({ home, profiles, includeHomePatch = false, runtimeVersion = RUNTIME, remote, passphrase, signal, encryption = true, onVerified, keepLast = 30 }) {
  let snapshot
  try { snapshot = await collect({ home, profiles, includeHomePatch, runtimeVersion }) }
  catch (error) { throw atStage(error, 'collect', false) }
  return uploadSnapshot(snapshot, { home, remote, passphrase, signal, encryption, onVerified, keepLast })
}

/** The watcher uploads the exact stable snapshot it fingerprinted, without recapturing. */
export async function uploadSnapshot(snapshot, { home, remote, passphrase, signal, encryption = true, onVerified, keepLast = 30 }) {
  if (!Number.isInteger(keepLast) || keepLast < 1 || keepLast > 10000) throw new Error('keepLast must be 1–10000')
  validateSnapshot(snapshot)
  let bytes, verified
  try {
    if (typeof encryption !== 'boolean') throw new Error('Invalid encryption mode')
    bytes = encryption ? await seal(snapshot, passphrase) : Buffer.from(JSON.stringify(snapshot))
    if (bytes.length > (encryption ? MAX_BYTES * 1.4 : MAX_BYTES)) throw new Error('Snapshot exceeds size limit')
  }
  catch (error) { throw atStage(error, 'encrypt', false) }
  try { await remote.put(snapshot.id, bytes, signal) }
  catch (error) { throw atStage(error, 'upload', error instanceof OperationError && error.stage === 'mkdir' ? false : true) }
  try { verified = await download({ id: snapshot.id, remote, passphrase, signal, allowUnencrypted: !encryption }) }
  catch (error) { throw atStage(error, 'verify', true) }
  if (JSON.stringify(verified) !== JSON.stringify(snapshot)) throw new OperationError('Remote snapshot verification failed; do not treat the backup as complete', { stage: 'verify', reason: 'invalid-data', remoteMayExist: true })
  const result = { id: snapshot.id, createdAt: snapshot.createdAt, files: snapshot.files.map(file => file.path), encryptedBytes: bytes.length, encryption, verified: true, warnings: warningsFor(snapshot, snapshot.runtimeVersion) }
  result.retention = await retainVerified({ home, remote, snapshot, bytes, keepLast, signal })
  await onVerified?.(snapshot, result)
  return result
}

export async function download({ id, remote, passphrase, signal, allowUnencrypted = false }) {
  const bytes = await remote.get(id, signal)
  let snapshot
  try {
    const outer = JSON.parse(bytes.toString('utf8'))
    if (outer?.format === 'dsh-config-vault-snapshot') {
      if (!allowUnencrypted || bytes.length > MAX_BYTES) throw new Error('Plaintext snapshot refused')
      snapshot = validateSnapshot(outer)
    } else snapshot = validateSnapshot(await unseal(bytes, passphrase))
  }
  catch { throw new OperationError('Cannot decrypt or validate the snapshot', { stage: 'verify', reason: 'invalid-data' }) }
  if (snapshot.id !== id) throw new OperationError('Downloaded snapshot identity mismatch', { stage: 'verify', reason: 'invalid-data' })
  return snapshot
}
