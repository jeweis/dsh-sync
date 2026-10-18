/** Explicit live settings plus separately enabled provider API keys. No raw YAML or executable config. */
import { REFERENCE_CAS } from './credential-cas.mjs'
import { captureKeys, applyKey, isKeyItem, validKeyItem } from './sync-credentials.mjs'
import { hash } from './crypto.mjs'
import { readManaged, PROFILE } from './files.mjs'

export const SYNC_CATEGORIES = ['appearance', 'language', 'models', 'plugins']
const RULES = {
  '@deepseek-ai/dsh-client-ui-theme': { category: 'appearance', fields: ['preference', 'fontSize', 'codeFontSize', 'terminalFontSize', 'textFontFamily', 'codeFontFamily', 'terminalFontFamily'] },
  '@deepseek-ai/dsh-client-locale': { category: 'language', fields: ['preference'] },
  '@deepseek-ai/dsh-agent-default-model': { category: 'models', fields: ['provider', 'model', 'reasoningEffort'], grouped: true },
  '@deepseek-ai/dsh-llm-deepseek': { category: 'models', fields: ['thinking', 'reasoningEffort', 'maxTokens', 'defaultContextWindow', 'streamIdleTimeoutMs'], grouped: true },
}
export const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
export const itemId = item => hash(JSON.stringify([item.module, item.ns, item.field]))
export const sameValue = (a, b) => canonical(a) === canonical(b)
export const itemValue = item => item?.value
const dangerous = new Set(['__proto__', 'constructor', 'prototype', '__jsExpr'])
function plain(value, depth = 0) {
  if (depth > 8) throw new Error('sync-invalid-data')
  if (value === null || ['boolean', 'string'].includes(typeof value)) return typeof value !== 'string' || value.length <= 4096
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.length <= 512 && value.every(x => plain(x, depth + 1))
  return value && typeof value === 'object' && Object.entries(value).every(([key, child]) => !dangerous.has(key) && key.length <= 128 && plain(child, depth + 1))
}
export function validateItems(items) {
  if (!Array.isArray(items) || items.length > 256 || Buffer.byteLength(JSON.stringify(items)) > 262144) throw new Error('sync-invalid-data')
  const ids = new Set()
  for (const item of items) {
    if (!item || Object.keys(item).some(key => !['module', 'ns', 'field', 'category', 'value'].includes(key)) || typeof item.ns !== 'string' || !/^[\w.-]{1,128}$/.test(item.ns) || !plain(item.value)) throw new Error('sync-invalid-data')
    const rule = RULES[item.module]
    if (isKeyItem(item)) {
      if (!validKeyItem(item)) throw new Error('sync-invalid-data')
    } else if (item.module === 'profile-inventory') {
      if (item.category !== 'plugins' || item.field !== 'bundles' || item.ns !== 'profile' || !Array.isArray(item.value) || item.value.length > 128 || !item.value.every(x => x && Object.keys(x).every(k => ['name', 'version', 'enabled'].includes(k)) && typeof x.name === 'string' && /^(@[\w.-]+\/)?[\w.-]+$/.test(x.name) && (x.version === null || typeof x.version === 'string' && /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(x.version)) && typeof x.enabled === 'boolean')) throw new Error('sync-invalid-data')
    } else {
      if (!rule || item.category !== rule.category || (rule.grouped ? item.field !== 'config' : !rule.fields.includes(item.field)) || !item.value || Array.isArray(item.value) || typeof item.value !== 'object' || !Object.keys(item.value).every(key => (rule.grouped ? rule.fields : [item.field]).includes(key)) || !Object.values(item.value).every(x => ['string', 'number', 'boolean'].includes(typeof x))) throw new Error('sync-invalid-data')
    }
    const id = itemId(item)
    if (ids.has(id)) throw new Error('sync-invalid-data')
    ids.add(id)
  }
  return items
}

export class HarnessSyncAdapter {
  constructor({ home, profile, getContext }) { this.home = home; this.profile = profile; this.getContext = getContext }
  referenceMode() { return this.getContext()?.get('credentials')?.[REFERENCE_CAS]?.version === 1 ? 'atomic' : 'manual' }
  available() { const ctx = this.getContext(); return Boolean(ctx?.get('settings') && ctx?.get('configEditor')) }
  async capture(categories, candidates = []) {
    if (!PROFILE.test(this.profile)) throw new Error('sync-unavailable')
    const ctx = this.getContext(), settings = ctx?.get('settings'), editor = ctx?.get('configEditor')
    if (!settings || !editor) throw new Error('sync-unavailable')
    const views = settings.describe({ redactSecrets: true }), items = [], revisions = new Map(), effective = new Map()
    for (const entry of editor.entries()) {
      const rule = RULES[entry.options.name], ns = entry.options.id
      if (!rule || !categories.includes(rule.category)) continue
      const view = views.find(x => x.ns === ns)
      if (!view || view.applies !== 'live') continue
      // Schemastery serializes a graph envelope, not an inline object schema.
      const schema = view.schema?.refs?.[view.schema.uid] ?? view.schema
      const fields = rule.fields.filter(field => Object.hasOwn(schema?.dict ?? {}, field) && !view.secrets?.some(secret => !secret.path.length || secret.path[0] === field))
      if (rule.grouped && fields.length !== rule.fields.length) continue
      for (const group of rule.grouped ? [fields] : fields.map(field => [field])) {
        const value = Object.fromEntries(group.filter(field => Object.hasOwn(view.user ?? {}, field)).map(field => [field, view.user[field]]))
        const item = { module: entry.options.name, ns, field: rule.grouped ? 'config' : group[0], category: rule.category, value }
        items.push(item); revisions.set(itemId(item), view.revision)
        effective.set(itemId(item), Object.fromEntries(group.filter(field => Object.hasOwn(view.value ?? {}, field)).map(field => [field, view.value[field]])))
      }
    }
    if (categories.includes('plugins')) {
      const raw = await readManaged(this.home, `profiles/${this.profile}/package.json`)
      if (raw === null) throw new Error('sync-unavailable')
      const manifest = JSON.parse(raw), bundles = manifest.dsh?.profile?.bundles
      if (!Array.isArray(bundles)) throw new Error('sync-invalid-data')
      const names = [...new Set([...bundles, ...Object.keys(manifest.dependencies ?? {})])]
      items.push({ module: 'profile-inventory', ns: 'profile', field: 'bundles', category: 'plugins', value: names.map(name => ({ name, enabled: bundles.includes(name), version: /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(manifest.dependencies?.[name] ?? '') ? manifest.dependencies[name] : null })) })
    }
    const keys = categories.includes('apiKeys') ? await captureKeys(ctx, editor.entries(), views, candidates) : null
    const writable = new Map(), bindings = new Map(), referenceKeys = new Set()
    if (keys) for (const item of keys.items) {
      const id = itemId(item), identity = JSON.stringify([item.module, item.ns, item.field])
      items.push(item)
      bindings.set(id, JSON.stringify(keys.bindings.get(identity)))
      if (keys.bindings.get(identity)?.ref && !keys.atomicReferences.has(identity)) referenceKeys.add(id)
      revisions.set(id, keys.revisions.get(identity))
      writable.set(id, keys.writable.get(identity))
    }
    return { writable, bindings, referenceKeys, items: validateItems(items).sort((a, b) => itemId(a).localeCompare(itemId(b))), revisions, effective }
  }
  async apply(item, expected) {
    if (isKeyItem(item)) {
      validateItems([item])
      const ctx = this.getContext()
      const captured = await captureKeys(ctx, ctx.get('configEditor').entries(), ctx.get('settings').describe({ redactSecrets: true }), [item])
      await applyKey(ctx, item, expected, captured)
      const after = await this.capture(['apiKeys'], [item])
      const applied = after.items.find(x => itemId(x) === itemId(item))
      if (!sameValue(applied?.value, item.value)) throw new Error('sync-apply-failed')
      return applied
    }
    if (item.category === 'plugins') throw new Error('sync-pending-offline')
    const current = await this.capture([item.category]), id = itemId(item)
    const local = current.items.find(x => itemId(x) === id)
    if (!local || !sameValue(local.value, expected.value) || current.revisions.get(id) !== expected.revision) throw new Error('sync-local-changed')
    const rule = RULES[item.module], fields = rule.grouped ? rule.fields : [item.field]
    await this.getContext().get('settings').mutate(item.ns, fields.map(field => Object.hasOwn(item.value, field) ? { op: 'set', path: [field], value: item.value[field] } : { op: 'unset', path: [field] }), expected.revision)
    const after = await this.capture([item.category])
    const applied = after.items.find(x => itemId(x) === id)
    if (!applied || !fields.every(field => Object.hasOwn(item.value, field) ? sameValue(applied.value[field], item.value[field]) || sameValue(after.effective.get(id)?.[field], item.value[field]) : !Object.hasOwn(applied.value, field))) throw new Error('sync-apply-failed')
    return applied
  }
}
