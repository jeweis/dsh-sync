/** Optional replacement credential provider. Never installed or enabled by the main plugin. */
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { createHash, randomUUID } from 'node:crypto'
import { REFERENCE_CAS } from './credential-cas.mjs'

const SCOPE = 'dsh-config-vault-refs/'
// Stored Harness refs are exact names; only ambient environment lookup folds case.
const normalize = ref => ref
const validRef = ref => typeof ref === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(ref) && !['DSH_VAULT_WEBDAV_PASSWORD', 'DSH_VAULT_PASSPHRASE'].includes(ref.toUpperCase())
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const slot = ref => SCOPE + 'r' + digest(ref)
export function atomicReferenceRecordKey(ref) { if(!validRef(ref))throw new Error('atomic-credentials-invalid-reference');return slot(normalize(ref)) }
function options(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['path', 'dshHome', 'watch', 'debounceMs', 'managedRefs'].includes(key))) throw new Error('atomic-credentials-invalid-config')
  const { managedRefs, ...local } = input
  if (!Array.isArray(managedRefs) || !managedRefs.length || managedRefs.length > 128 || !managedRefs.every(validRef) || new Set(managedRefs.map(normalize)).size !== managedRefs.length) throw new Error('atomic-credentials-invalid-config')
  return { ...LocalCredentialProvider.Config(local), managedRefs: managedRefs.map(normalize) }
}
function payload(ref, record) {
  if (record === undefined) return null
  const value = record?.payload
  if (record.kind !== 'grant' || !value || value.version !== 1 || value.ref !== ref || typeof value.generation !== 'string' || !/^[0-9a-f-]{36}$/.test(value.generation) || !['set', 'unset'].includes(value.state) || Object.keys(value).some(key => !['version','ref','generation','state','value'].includes(key)) || (value.state === 'set' ? typeof value.value !== 'string' || !value.value.length || value.value.length > 4096 : value.value !== null)) throw new Error('atomic-credentials-invalid-record')
  return value
}
const nextRecord = (ref, value) => ({ kind: 'grant', payload: { version: 1, ref, generation: randomUUID(), state: value === null ? 'unset' : 'set', value } })

export default class AtomicCredentialProvider extends LocalCredentialProvider {
  static Config = { '~standard': { version: 1, vendor: 'dsh-sync', validate(input) { try { return { value: options(input) } } catch { return { issues: [{ message: 'Invalid atomic credential provider configuration' }] } } } } }
  constructor(ctx, input) {
    const config = options(input)
    super(ctx, config)
    this.managed = new Set(config.managedRefs)
    this.refsBySlot = new Map(config.managedRefs.map(ref => [slot(ref), ref]))
    this[REFERENCE_CAS] = Object.freeze({ version: 1, manages: ref => this.managed.has(normalize(ref)), snapshot: ref => this.referenceSnapshot(ref), compareAndSet: (ref, expected, value) => this.compareAndSetReference(ref, expected, value) })
    // Includes writes reconciled from another process using this provider.
    ctx.on('credentials/record-updated', key => {
      const ref = this.refsBySlot.get(key)
      if (ref) this.notifyUpdated(ref)
    })
  }
  requireManaged(ref) {
    ref = normalize(ref)
    if (!this.managed.has(ref)) throw new Error('atomic-credentials-unmanaged-reference')
    return ref
  }
  ambient(ref) {
    const environment = launchEnvironmentOf(this.ctx)
    const processValue = environment.getFrom(ref, ['process'])
    if (processValue?.value) return { value: processValue.value, source: 'env' }
    const fallback = environment.getFrom(ref, ['project-env', 'user-env'])
    return fallback?.value ? { value: fallback.value, source: fallback.source } : undefined
  }
  async view(ref, record) {
    const stored = payload(ref, record)
    const hit = stored?.state === 'set' ? { value: stored.value, source: 'file' } : stored?.state === 'unset' ? this.ambient(ref) : await super.resolve(ref)
    return { value: hit?.value ?? null, source: hit?.source ?? null, revision: digest([stored, hit ?? null]) }
  }
  async resolve(ref) {
    if (!this.managed.has(normalize(ref))) return super.resolve(ref)
    ref = normalize(ref)
    const value = await this.view(ref, await super.readRecord(slot(ref)))
    return value.value === null ? undefined : { value: value.value, source: value.source }
  }
  async describe(ref) {
    if (!this.managed.has(normalize(ref))) return super.describe(ref)
    const value = await this.resolve(ref)
    return { configured: Boolean(value), writable: true, ...(value ? { source: value.source } : {}) }
  }
  async set(ref, value) {
    if (!this.managed.has(normalize(ref))) return super.set(ref, value)
    if (typeof value !== 'string' || !value.length || value.length > 4096) throw new Error('atomic-credentials-invalid-key')
    ref = normalize(ref)
    await super.modifyRecord(slot(ref), async current => { payload(ref, current); return nextRecord(ref, value) })
  }
  async unset(ref) {
    if (!this.managed.has(normalize(ref))) return super.unset(ref)
    ref = normalize(ref)
    // Tombstone preserves unset semantics: do not resurrect the old legacy file value.
    await super.modifyRecord(slot(ref), async current => { payload(ref, current); return nextRecord(ref, null) })
  }
  async referenceSnapshot(ref) {
    ref = this.requireManaged(ref)
    let snapshot
    // A read-only transaction reconciles disk before the snapshot, including another process's edits.
    await super.modifyRecord(slot(ref), async current => { snapshot = { ...await this.view(ref, current), storedState: payload(ref, current)?.state ?? 'legacy' }; return undefined })
    return snapshot
  }
  async compareAndSetReference(ref, expected, value) {
    ref = this.requireManaged(ref)
    if (!expected || typeof expected.revision !== 'string' || typeof value !== 'string' || !value.length || value.length > 4096) throw new Error('atomic-credentials-invalid-key')
    await super.modifyRecord(slot(ref), async current => {
      const actual = await this.view(ref, current)
      if (actual.revision !== expected.revision || actual.value !== expected.value) throw new Error('sync-local-changed')
      return nextRecord(ref, value)
    })
  }
}
