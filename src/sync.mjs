/** Three-way, opt-in live settings synchronization; snapshot restore remains offline. */
import { createHmac, randomBytes } from 'node:crypto'
import { isKeyItem, keyPreview } from './sync-credentials.mjs'
import { hash, seal, unseal } from './crypto.mjs'
import { readManaged, writeManaged } from './files.mjs'
import { RUNTIME } from './snapshot.mjs'
import { SyncRemote } from './sync-remote.mjs'
import { syncLock } from './sync-lock.mjs'
import { canonical, itemId, sameValue, validateItems } from './sync-adapter.mjs'

const CODES = new Set(['sync-invalid-data', 'sync-unavailable', 'sync-local-changed', 'sync-remote-changed', 'sync-no-cas', 'sync-network', 'sync-verification', 'sync-apply-failed', 'sync-stale-preview', 'sync-key-reused', 'sync-credentials-readonly', 'sync-key-absent', 'sync-key-alias', 'sync-reference-manual'])
const preview = item => isKeyItem(item) ? keyPreview(item.value) : item?.value ?? null
const selected = (items, categories) => items.filter(item => categories.includes(item.category))
const mapOf = items => new Map(items.map(item => [itemId(item), item]))
function document(value, space) {
  if (!value || value.format !== 'dsh-live-sync' || value.version !== 1 || value.runtime !== RUNTIME || value.space !== space || Object.keys(value).some(key => !['format', 'version', 'runtime', 'space', 'items'].includes(key))) throw new Error('sync-invalid-data')
  validateItems(value.items); return value
}
export class LiveSync {
  constructor({ home, profile, adapter, connection }) {
    this.home = home; this.profile = profile; this.adapter = adapter; this.connection = connection
    this.previewKey = randomBytes(32)
    this.nextAt = 0; this.failures = 0; this.cas = null; this.scope = null
    this.status = { phase: 'disabled', profile, changes: [], pending: [], token: null, lastSuccessAt: null }
  }
  reset() { this.nextAt = 0; this.scope = null; this.status = { ...this.status, phase: 'disabled', changes: [], pending: [], token: null, error: null, lastSuccessAt: null } }
  async step({ config, passphrase, signal, now = Date.now(), force = false, resolution, recheck = false }) {
    const options = config.sync && { ...config.sync, categories: [...config.sync.categories.filter(x => x !== 'apiKeys'), ...(config.sync.apiKeys === true ? ['apiKeys'] : [])] }
    if (!options?.enabled) { this.reset(); return }
    if (!this.adapter?.available()) { this.status.phase = 'unavailable'; return }
    if (!passphrase || passphrase.length < 12 || passphrase.length > 1024) { this.status.phase = 'locked'; return }
    if (!config.url) { this.status.phase = 'connection-required'; return }
    const scope = hash(canonical([config.url, config.username, options.space, this.profile, [...options.categories].sort()]))
    if (this.scope !== scope) { this.reset(); this.scope = scope }
    if (!force && now < this.nextAt) return
    this.nextAt = now + options.intervalMs
    let release, state, path, save, capabilityScope, changed = false
    try {
      release = await syncLock(this.home, hash(this.profile))
      if (!release) { this.status.phase = 'busy'; return }
      signal?.throwIfAborted()
      path = `config-vault/sync-${scope}.vault`
      const raw = await readManaged(this.home, path)
      state = raw === null ? { format: 'dsh-sync-state', version: 1, scope, base: [] } : await unseal(Buffer.from(raw), passphrase)
      if (state.format !== 'dsh-sync-state' || state.version !== 1 || state.scope !== scope) throw new Error('sync-invalid-data')
      validateItems(state.base)
      const oldReferencePending = canonical(state.referencePending ?? {})
      if (state.localBase) validateItems(state.localBase)
      this.status.lastSuccessAt = state.lastSuccessAt ?? null
      save = async () => writeManaged(this.home, path, await seal(state, passphrase))
      if (state.pending && !recheck) { this.status.phase = 'uncertain'; this.status.changes = []; this.status.token = null; return }
      if (recheck) { delete state.pending; state.review = true; await save() }
      const dav = await this.connection(config), remote = new SyncRemote(dav, options.space)
      if (dav.authorization === `Basic ${Buffer.from(`${config.username}:${passphrase}`).toString('base64')}`) throw new Error('sync-key-reused')
      capabilityScope = dav.retentionScope
      if (this.casFailed === capabilityScope && !force) { this.status.phase = 'error'; this.status.error = 'sync-no-cas'; return }
      if (this.cas !== capabilityScope) { await remote.checkCAS(signal); this.cas = capabilityScope }
      const version = await remote.read(signal)
      const cloud = version ? document(await unseal(version.bytes, passphrase), options.space) : { format: 'dsh-live-sync', version: 1, runtime: RUNTIME, space: options.space, items: [] }
      const local = await this.adapter.capture(options.categories, cloud.items), L = mapOf(local.items), R = mapOf(selected(cloud.items, options.categories)), B = mapOf(state.base), BL = mapOf(state.localBase ?? state.base)
      if (!local.items.length) throw new Error('sync-unavailable')
      const changes = [], pending = [], pulls = [], outgoing = mapOf(cloud.items)
      const token = createHmac('sha256', this.previewKey).update(canonical([scope, version?.etag ?? null, local.items, [...(local.revisions ?? [])], state.base, state.localBase ?? state.base, Boolean(state.review)])).digest('hex')
      const choices = resolution?.choices ?? {}
      if (resolution && (resolution.token !== token || !choices || Array.isArray(choices) || typeof choices !== 'object')) throw new Error('sync-stale-preview')
      const conflicts = new Set()
      for (const id of new Set([...L.keys(), ...R.keys()])) {
        const l = L.get(id), r = R.get(id), base = B.get(id)
        const localChanged = !sameValue(l?.value, BL.get(id)?.value) || isKeyItem(l) && state.localRevisions?.[id] !== undefined && state.localRevisions[id] !== local.revisions.get(id)
        const label = `${(l ?? r).ns} · ${(l ?? r).field}`
        if (!l) { pending.push({ id, label, category: r.category, reason: 'missing-plugin', local: null, remote: preview(r) }); continue }
        if (r && sameValue(l.value, r.value)) { if (state.referencePending) delete state.referencePending[id]; continue }
        if (local.referenceKeys?.has(id) && r && sameValue(state.referencePending?.[id], { local: l.value, remote: r.value })) { pending.push({ id, label, category: l.category, reason: 'reference-manual', local: preview(l), remote: preview(r) }); continue }
        if (isKeyItem(l) && !l.value.key && !r?.value.key) continue
        if (isKeyItem(l) && r && (!l.value.key || !r.value.key) && base) { pending.push({ id, label, category: l.category, reason: 'key-absent', local: preview(l), remote: preview(r) }); continue }
        if (l.category === 'plugins' && r && (!base || !sameValue(r.value, base.value))) { pending.push({ id, label, category: l.category, reason: 'offline', local: preview(l), remote: preview(r) }); continue }
        if (base && r && !localChanged && sameValue(r.value, base.value)) continue
        let choice
        const initial = !base
        if (initial || !r || state.review || (base && localChanged && !sameValue(r.value, base.value))) {
          conflicts.add(id)
          changes.push({ id, label, category: l.category, kind: initial ? 'join' : 'conflict', ...(local.referenceKeys?.has(id) && r ? { manualRemote: true } : {}), local: preview(l), remote: preview(r) })
          choice = choices[id]
          if (choice !== undefined && (!['local', 'remote'].includes(choice) || choice === 'remote' && !r)) throw new Error('sync-stale-preview')
        } else choice = localChanged ? 'local' : 'remote'
        if (isKeyItem(l) && choice && !(choice === 'local' ? l : r)?.value.key) { pending.push({ id, label, category: l.category, reason: 'key-absent', local: preview(l), remote: preview(r) }); continue }
        if (choice === 'remote' && isKeyItem(l) && local.writable?.get(id) === false) { pending.push({ id, label, category: l.category, reason: 'credentials-readonly', local: preview(l), remote: preview(r) }); continue }
        if (choice === 'remote' && local.referenceKeys?.has(id)) { (state.referencePending ??= {})[id] = { local: l.value, remote: r.value }; pending.push({ id, label, category: l.category, reason: 'reference-manual', local: preview(l), remote: preview(r) }); continue }
        if (choice === 'local') { outgoing.set(id, l); if (state.referencePending) delete state.referencePending[id] }
        if (choice === 'remote') {
          if (l.category === 'plugins') pending.push({ id, label, category: l.category, reason: 'offline', local: preview(l), remote: preview(r) })
          else pulls.push({ item: r, before: l })
        }
      }
      if (Object.keys(choices).some(id => !conflicts.has(id))) throw new Error('sync-stale-preview')
      this.status = { ...this.status, changes, pending, token, error: null }
      if (changes.some(item => choices[item.id] === undefined)) { this.status.phase = state.base.length ? 'conflict' : 'join'; return }
      const nextCloud = { ...cloud, items: [...outgoing.values()].sort((a, b) => itemId(a).localeCompare(itemId(b))) }
      validateItems(nextCloud.items)
      // Multiple provider routes can intentionally share a local credential reference.
      // Refuse contradictory cloud values before any write; identical pulls write that ref once.
      const targets = new Map(), pulled = new Set()
      for (const item of selected(nextCloud.items, options.categories).filter(isKeyItem)) {
        const binding = local.bindings?.get(itemId(item))
        if (!binding || !item.value.key) continue
        if (targets.has(binding) && !sameValue(targets.get(binding), item.value)) throw new Error('sync-key-alias')
        targets.set(binding, item.value)
      }
      for (let i = 0; i < pulls.length; i++) {
        const binding = local.bindings?.get(itemId(pulls[i].item))
        if (!binding) continue
        if (pulled.has(binding)) { pulls.splice(i--, 1); continue }
        pulled.add(binding)
      }
      const push = !sameValue(cloud.items, nextCloud.items)
      const appliedValues = new Map()
      if (push || pulls.length) {
        // Persist an encrypted pre-image before either side can change. A crash pauses, never blindly replays.
        state.history = [...(state.history ?? []), { at: new Date(now).toISOString(), local: local.items, remote: cloud.items }].slice(-10)
        state.pending = { at: new Date(now).toISOString(), token }
        await save(); changed = true
        signal?.throwIfAborted()
        const fresh = await this.adapter.capture(options.categories, cloud.items)
        if ([...L.values()].some(item => isKeyItem(item) && fresh.revisions.get(itemId(item)) !== local.revisions.get(itemId(item)))) throw new Error('sync-local-changed')
        if (!sameValue(fresh.items, local.items)) throw new Error('sync-local-changed')
        if (push) await remote.write(await seal(nextCloud, passphrase), version?.etag ?? null, signal)
        for (const { item, before } of pulls) {
          signal?.throwIfAborted()
          const current = await this.adapter.capture(options.categories, cloud.items), id = itemId(item)
          if (isKeyItem(item) && current.revisions.get(id) !== local.revisions.get(id)) throw new Error('sync-local-changed')
          if (!sameValue(current.items.find(x => itemId(x) === id)?.value, before.value)) throw new Error('sync-local-changed')
          const applied = await this.adapter.apply(item, { value: before.value, revision: current.revisions.get(id) })
          appliedValues.set(id, applied?.value ?? item.value)
          if (state.referencePending) delete state.referencePending[id]
        }
      }
      const after = await this.adapter.capture(options.categories, cloud.items)
      const actual = mapOf(after.items), oldRevisions = canonical(state.localRevisions ?? {}), oldBase = state.base, oldLocal = state.localBase, reviewed = state.review
      const deferred = new Set(pending.map(item => item.id))
      for (const item of selected(nextCloud.items, options.categories)) {
        const id = itemId(item), expected = appliedValues.has(id) ? appliedValues.get(id) : sameValue(B.get(id)?.value, item.value) && sameValue(BL.get(id)?.value, L.get(id)?.value) ? L.get(id)?.value : item.value
        if (L.has(id) && !deferred.has(id) && !sameValue(actual.get(id)?.value, expected)) throw new Error('sync-local-changed')
      }
      const base = mapOf(state.base)
      const localBase = mapOf(state.localBase ?? state.base)
      for (const item of selected(nextCloud.items, options.categories)) {
        const id = itemId(item)
        if (actual.has(id) && !deferred.has(id)) {
          base.set(id, item); localBase.set(id, actual.get(id))
          if (isKeyItem(item) && after.revisions?.has(id)) (state.localRevisions ??= {})[id] = after.revisions.get(id)
        }
      }
      state.base = [...base.values()].sort((a, b) => itemId(a).localeCompare(itemId(b)))
      validateItems(state.base)
      state.localBase = [...localBase.values()].sort((a, b) => itemId(a).localeCompare(itemId(b)))
      validateItems(state.localBase)
      delete state.pending
      delete state.review
      state.lastSuccessAt = new Date(now).toISOString()
      if (changed || reviewed || canonical(state.localRevisions ?? {}) !== oldRevisions || canonical(state.referencePending ?? {}) !== oldReferencePending || raw === null || !sameValue(oldBase, state.base) || !sameValue(oldLocal, state.localBase)) await save()
      this.failures = 0
      this.status = { ...this.status, phase: pending.length ? 'pending' : 'synced', lastSuccessAt: state.lastSuccessAt, changes: [], token: null, error: null }
    } catch (error) {
      if (error.message === 'sync-no-cas') this.casFailed = capabilityScope
      // A definite CAS refusal made no remote write and is safe to re-plan.
      if (changed && error.message === 'sync-remote-changed') {
        const pending = state.pending
        delete state.pending
        try { await save() } catch { state.pending = pending }
      }
      this.status.phase = state?.pending ? 'uncertain' : 'error'
      this.status.error = CODES.has(error.message) ? error.message : 'sync-failed'
      this.status.changes = []; this.status.token = null
      this.nextAt = now + Math.min(options.intervalMs * 2 ** Math.min(this.failures++, 4), 3600000)
    } finally { await release?.() }
  }
}
