/** Provider-bound API keys only; no OAuth, credential files or arbitrary reference enumeration. */
import { referenceCAS } from './credential-cas.mjs'
import { createHash } from 'node:crypto'
const DEEPSEEK = '@deepseek-ai/dsh-llm-deepseek-api-key'
const PI = '@deepseek-ai/dsh-llm-pi-ai'
const refName = value => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value) && !['DSH_VAULT_WEBDAV_PASSWORD', 'DSH_VAULT_PASSPHRASE'].includes(value.toUpperCase())
const routeName = value => typeof value === 'string' && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value) && value.length <= 128
const keyValue = value => value === null || typeof value === 'string' && value.length > 0 && value.length <= 4096
export const isKeyItem = item => item?.category === 'apiKeys'
export function validKeyItem(item) {
  return item.value && Object.keys(item.value).length === 1 && Object.hasOwn(item.value, 'key') && keyValue(item.value.key) && (
    item.module === DEEPSEEK && item.field === 'api-key' || item.module === PI && (item.field === 'api-key-record' && routeName(item.ns) || /^api-key-ref\.[\w.-]{1,100}$/.test(item.field)))
}
export const keyPreview = value => value == null ? null : { configured: Boolean(value.key) }
const identity = item => JSON.stringify([item.module, item.ns, item.field])
const revision = (binding, value, info) => createHash('sha256').update(JSON.stringify([binding, value, info])).digest('hex')
export async function captureKeys(ctx, entries, views, candidates = []) {
  const credentials = ctx.get('credentials')
  if (!credentials) throw new Error('sync-unavailable')
  const bindings = new Map(), items = [], revisions = new Map(), writable = new Map(), atomicReferences = new Set(), nativeRevisions = new Map()
  const add = async (module, ns, field, binding) => {
    const cas = binding.ref ? referenceCAS(credentials, binding.ref) : null
    const snapshot = cas ? await cas.snapshot(binding.ref) : null
    const info = snapshot ? { configured: snapshot.value !== null, writable: true, source: snapshot.source, atomicRevision: snapshot.revision } : binding.record ? await credentials.describeRecord(binding.record) : await credentials.describe(binding.ref)
    if (binding.record && info.kind && info.kind !== 'api-key') return
    const raw = snapshot ? { value: snapshot.value } : binding.record ? await credentials.readRecord(binding.record) : await credentials.resolve(binding.ref)
    if (binding.record && raw && raw.kind !== 'api-key') return
    const key = (binding.record ? raw?.key : raw?.value) || null
    if (!keyValue(key)) throw new Error('sync-invalid-data')
    const item = { module, ns, field, category: 'apiKeys', value: { key } }, id = identity(item)
    if (snapshot) { atomicReferences.add(id); nativeRevisions.set(id, snapshot.revision) }
    bindings.set(id, binding); items.push(item); revisions.set(id, revision(binding, item.value, info)); writable.set(id, Boolean(info.writable))
  }
  for (const entry of entries) {
    const module = entry.options.name, ns = entry.options.id, view = views.find(x => x.ns === ns)
    if (!view) continue
    if (module === DEEPSEEK && refName(view.value?.apiKeyEnv)) await add(module, ns, 'api-key', { ref: view.value.apiKeyEnv })
    if (module === PI) for (const [route, config] of Object.entries(view.value?.providers ?? {})) {
      if (/^[\w.-]{1,100}$/.test(route) && refName(config?.apiKeyEnv)) await add(module, ns, `api-key-ref.${route}`, { ref: config.apiKeyEnv })
    }
  }
  if (entries.some(entry => entry.options.name === PI)) {
    const stored = await credentials.listRecords()
    const routes = new Set(stored.filter(x => x.kind === 'api-key' && x.key.startsWith('llm-pi-ai/')).map(x => x.key.slice('llm-pi-ai/'.length)))
    // Cloud may initialize a missing record only inside the installed adapter's own scope.
    for (const item of candidates) if (item.module === PI && item.field === 'api-key-record' && item.category === 'apiKeys') routes.add(item.ns)
    for (const route of routes) if (routeName(route)) await add(PI, route, 'api-key-record', { record: `llm-pi-ai/${route}` })
  }
  return { items, revisions, writable, bindings, atomicReferences, nativeRevisions }
}
export async function applyKey(ctx, item, expected, captured) {
  const id = identity(item), binding = captured.bindings.get(id), current = captured.items.find(x => identity(x) === id)
  if (!binding || JSON.stringify(current?.value) !== JSON.stringify(expected.value) || captured.revisions.get(id) !== expected.revision) throw new Error('sync-local-changed')
  if (!captured.writable.get(id)) throw new Error('sync-credentials-readonly')
  if (!item.value.key) throw new Error('sync-key-absent')
  const credentials = ctx.get('credentials')
  if (binding.record) {
    await credentials.modifyRecord(binding.record, async record => {
      if (record && record.kind !== 'api-key' || (record?.key || null) !== expected.value.key) throw new Error('sync-local-changed')
      return { ...record, kind: 'api-key', key: item.value.key }
    })
  } else {
    const cas = referenceCAS(credentials, binding.ref)
    if (cas && captured.atomicReferences.has(id)) {
      await cas.compareAndSet(binding.ref, { value: expected.value.key, revision: captured.nativeRevisions.get(id) }, item.value.key)
      return
    }
    // set(ref, value) cannot atomically check the old value. Never call it from sync,
    // even for an empty reference or after an explicit cloud choice.
    throw new Error('sync-reference-manual')
  }
}
