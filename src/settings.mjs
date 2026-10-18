/** Device-local preferences contain no secrets and are excluded from snapshots. */
import { readdir } from 'node:fs/promises'
import { hash } from './crypto.mjs'
import { PROFILE, readManaged, safePath, writeManaged } from './files.mjs'
import { WebDAV } from './webdav.mjs'
import { randomUUID } from 'node:crypto'
import { SYNC_CATEGORIES } from './sync-adapter.mjs'

export const SETTINGS_PATH = 'config-vault/settings.json'
export const PASSWORD_REF = 'DSH_VAULT_WEBDAV_PASSWORD'

export class SettingsError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status }
}

export function validatePreferences(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['url', 'username', 'profiles', 'includeHomePatch', 'timeoutMs', 'encryption', 'autoBackup', 'keepLast', 'sync'].includes(key))) throw new SettingsError('invalid-settings')
  const { url, username, profiles, includeHomePatch, timeoutMs } = value
  if (typeof url !== 'string' || url.length > 4096 || typeof username !== 'string' || username.length > 256 || !Array.isArray(profiles) || !profiles.length || profiles.length > 40 || new Set(profiles).size !== profiles.length || !profiles.every(x => typeof x === 'string' && PROFILE.test(x)) || typeof includeHomePatch !== 'boolean' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new SettingsError('invalid-settings')
  try { if (url) new WebDAV({ url, username, timeoutMs }) }
  catch { throw new SettingsError('invalid-webdav') }
  if (value.encryption !== undefined && typeof value.encryption !== 'boolean') throw new SettingsError('invalid-settings')
  if (value.keepLast !== undefined && (!Number.isInteger(value.keepLast) || value.keepLast < 1 || value.keepLast > 10000)) throw new SettingsError('invalid-settings')
  const auto = value.autoBackup
  const sync = value.sync
  if (sync !== undefined && (!sync || typeof sync !== 'object' || Array.isArray(sync) || Object.keys(sync).some(key => !['enabled', 'space', 'categories', 'intervalMs', 'apiKeys'].includes(key)) || (sync.apiKeys !== undefined && typeof sync.apiKeys !== 'boolean') || typeof sync.enabled !== 'boolean' || typeof sync.space !== 'string' || !PROFILE.test(sync.space) || !Array.isArray(sync.categories) || (!sync.categories.length && sync.apiKeys !== true) || new Set(sync.categories).size !== sync.categories.length || !sync.categories.every(key => SYNC_CATEGORIES.includes(key)) || ![180000, 900000, 1800000, 3600000].includes(sync.intervalMs))) throw new SettingsError('invalid-settings')
  if (auto !== undefined && (!auto || typeof auto !== 'object' || Array.isArray(auto) || Object.keys(auto).some(key => !['enabled', 'debounceMs', 'minIntervalMs'].includes(key)) || typeof auto.enabled !== 'boolean' || !Number.isInteger(auto.debounceMs) || auto.debounceMs < 1000 || auto.debounceMs > 600000 || !Number.isInteger(auto.minIntervalMs) || auto.minIntervalMs < 60000 || auto.minIntervalMs > 86400000)) throw new SettingsError('invalid-settings')
  return { url, username, profiles, includeHomePatch, timeoutMs, ...(value.encryption !== undefined ? { encryption: value.encryption } : {}), ...(auto ? { autoBackup: { ...auto } } : {}), ...(value.keepLast !== undefined ? { keepLast: value.keepLast } : {}), ...(sync ? { sync: { ...sync, categories: [...sync.categories] } } : {}) }
}

/** A saved preference overrides environment defaults, but secrets never enter this object. */
export async function loadPreferences(home, environment = process.env, defaults = {}) {
  const raw = await readManaged(home, SETTINGS_PATH)
  const baseline = { url: environment.DSH_VAULT_WEBDAV_URL ?? '', username: environment.DSH_VAULT_WEBDAV_USERNAME ?? '', profiles: defaults.profiles ?? ['web'], includeHomePatch: defaults.includeHomePatch ?? false, timeoutMs: defaults.timeoutMs ?? 30000 }
  let config = baseline
  if (raw !== null) {
    const saved = JSON.parse(raw)
    if (saved.version !== 1) throw new SettingsError('unsupported-settings')
    config = saved.config
  }
  return { config: validatePreferences(config), revision: hash(raw ?? JSON.stringify(baseline)) }
}

/** Serialized by the UI service; revision detects stale forms and prior external edits. */
export async function savePreferences(home, value, expectedRevision, environment, defaults) {
  const current = await loadPreferences(home, environment, defaults)
  if (expectedRevision !== current.revision) throw new SettingsError('stale-settings', 409)
  const config = validatePreferences(value)
  await writeManaged(home, SETTINGS_PATH, JSON.stringify({ version: 1, revision: randomUUID(), config }, null, 2) + '\n')
}

export async function discoverProfiles(home) {
  let entries
  try { entries = await readdir(await safePath(home, 'profiles'), { withFileTypes: true }) }
  catch (error) { if (error.code === 'ENOENT') return []; throw error }
  const profiles = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !PROFILE.test(entry.name)) continue
    const raw = await readManaged(home, `profiles/${entry.name}/package.json`)
    if (raw === null) continue
    let valid = false
    try { valid = Array.isArray(JSON.parse(raw).dsh?.profile?.bundles) }
    catch { /* Invalid manifests stay visible as unavailable profile choices. */ }
    profiles.push({ name: entry.name, available: valid })
  }
  return profiles.sort((a, b) => a.name.localeCompare(b.name))
}
