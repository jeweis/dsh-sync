/** Authenticated settings API implementation; deliberately has no restore action. */
import { backup, download, preview } from './engine.mjs'
import { WebDAV } from './webdav.mjs'
import { discoverProfiles, loadPreferences, savePreferences, validatePreferences, SettingsError, PASSWORD_REF } from './settings.mjs'
import { validateId } from './snapshot.mjs'
import { diagnostic } from './operation-error.mjs'
import { AutoBackup } from './auto-backup.mjs'
import { retentionStatus } from './retention.mjs'
import { resolve } from 'node:path'
import { providerPreview } from './provider-transition.mjs'
import { LiveSync } from './sync.mjs'

export class VaultSettingsService {
  constructor({ home, credentials, defaults = {}, environment = process.env, syncAdapter = null, profile = 'web', providerContext = null }) {
    this.providerContext = providerContext
    this.home = home; this.credentials = credentials; this.defaults = defaults; this.environment = environment
    this.busy = false; this.abort = new AbortController(); this.active = null
    this.autoPassphrase = null; this.timer = null; this.automaticActive = false
    this.auto = new AutoBackup({ home, connection: config => this.connection(config) })
    this.syncPassphrase = null
    this.sync = new LiveSync({ home, profile, adapter: syncAdapter, connection: config => this.connection(config) })
  }

  async state() {
    const preferences = await loadPreferences(this.home, this.environment, this.defaults)
    const info = await this.credentials.describe(PASSWORD_REF)
    const profiles = await discoverProfiles(this.home)
    for (const name of preferences.config.profiles) if (!profiles.some(profile => profile.name === name)) profiles.push({ name, available: false })
    const ready = this.autoPassphrase ?? this.environment.DSH_VAULT_PASSPHRASE
    const phase = !preferences.config.autoBackup?.enabled ? 'disabled' : preferences.config.encryption !== false && (!ready || ready.length < 12 || ready.length > 1024) ? 'locked' : this.auto.status.phase === 'disabled' ? 'watching' : this.auto.status.phase
    const retention = await retentionStatus(this.home, preferences.config.url ? new WebDAV(preferences.config) : null)
    const syncPhase = !preferences.config.sync?.enabled ? 'disabled' : !this.sync.adapter?.available() ? 'unavailable' : !(this.syncPassphrase ?? this.environment.DSH_VAULT_PASSPHRASE) ? 'locked' : this.sync.status.phase === 'disabled' ? 'ready' : this.sync.status.phase
    return { ...preferences, profiles, passwordConfigured: info.configured, passwordWritable: info.writable, busy: this.busy, auto: { ...this.auto.status, phase }, retention, sync: { ...this.sync.status, phase: syncPhase, referenceMode: this.sync.adapter?.referenceMode?.() ?? 'manual' } }
  }

  /** Credentials are resolved once for this operation and never included in returned DTOs. */
  async connection(config) {
    const secret = await this.credentials.resolve(PASSWORD_REF)
    return new WebDAV({ ...config, password: secret?.value ?? '' })
  }

  async execute(body, signal) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new SettingsError('invalid-request')
    const actions = {
      'provider-preview': ['action','revision','mode','refs'],
      save: ['action', 'revision', 'config', 'password', 'clearPassword'],
      'auto-unlock': ['action', 'revision', 'passphrase'], 'auto-retry': ['action', 'revision'],
      'sync-unlock': ['action', 'revision', 'passphrase'], 'sync-now': ['action', 'revision'], 'sync-recheck': ['action', 'revision'], 'sync-resolve': ['action', 'revision', 'token', 'choices'],
      test: ['action', 'revision'], list: ['action', 'revision'],
      backup: ['action', 'revision', 'passphrase'], preview: ['action', 'revision', 'passphrase', 'id'],
    }
    const allowed = typeof body.action === 'string' && Object.hasOwn(actions, body.action) ? actions[body.action] : undefined
    if (!allowed || Object.keys(body).some(key => !allowed.includes(key)) || typeof body.revision !== 'string') throw new SettingsError('invalid-request')
    // A poll may begin between the form's last status read and its POST. Let the
    // user action follow that single automatic cycle rather than lose a draft.
    if (this.busy && this.automaticActive) await this.active?.catch(() => {})
    if (this.busy) throw new SettingsError('busy', 409)
    if (this.abort.signal.aborted) throw new SettingsError('stopping', 503)
    this.busy = true
    const combined = AbortSignal.any([this.abort.signal, ...signal ? [signal] : []])
    const operation = this.run(body, combined)
    this.active = operation
    try { return await operation }
    finally { this.busy = false; this.active = null }
  }

  async run(body, signal) {
    signal.throwIfAborted()
    const current = await loadPreferences(this.home, this.environment, this.defaults)
    if (body.revision !== current.revision) throw new SettingsError('stale-settings', 409)
    if (body.action === 'provider-preview') {
      if (!['enable','rollback'].includes(body.mode) || (body.refs !== undefined && (!Array.isArray(body.refs) || body.refs.length>128 || !body.refs.every(x=>typeof x==='string'&&x.length<=128)))) throw new SettingsError('invalid-request')
      const validLocation=!this.providerContext?.dir || resolve(this.providerContext.dir)===resolve(this.home,'profiles',this.providerContext.name??'')
      return providerPreview({home:this.home,installAnchor:validLocation?this.providerContext?.installAnchor:null,overlays:this.providerContext?.overlays??[],mode:body.mode,refs:body.refs})
    }
    if (body.action.startsWith('sync-')) {
      if (!current.config.sync?.enabled) throw new SettingsError('invalid-settings')
      if (body.action === 'sync-unlock') {
        if (typeof body.passphrase !== 'string' || body.passphrase.length < 12 || body.passphrase.length > 1024) throw new SettingsError('passphrase-required')
        if (body.passphrase === (await this.credentials.resolve(PASSWORD_REF))?.value) throw new SettingsError('invalid-request')
        this.syncPassphrase = body.passphrase
      }
      if (body.action === 'sync-resolve' && (typeof body.token !== 'string' || !/^[a-f0-9]{64}$/.test(body.token) || !body.choices || typeof body.choices !== 'object' || Array.isArray(body.choices) || Object.keys(body.choices).length > 256 || !Object.entries(body.choices).every(([id, choice]) => /^[a-f0-9]{64}$/.test(id) && ['local', 'remote'].includes(choice)))) throw new SettingsError('invalid-request')
      await this.sync.step({ config: current.config, passphrase: this.syncPassphrase ?? this.environment.DSH_VAULT_PASSPHRASE, signal, force: true,
        ...(body.action === 'sync-resolve' ? { resolution: { token: body.token, choices: body.choices } } : {}), recheck: body.action === 'sync-recheck' })
      return { state: { ...await this.state(), busy: false } }
    }
    if (body.action === 'auto-unlock') {
      if (!current.config.autoBackup?.enabled) throw new SettingsError('invalid-settings')
      if (typeof body.passphrase !== 'string' || body.passphrase.length < 12 || body.passphrase.length > 1024) throw new SettingsError('passphrase-required')
      this.autoPassphrase = body.passphrase
      if (this.auto.status.phase === 'locked') this.auto.status.phase = 'watching'
      return { state: { ...await this.state(), busy: false } }
    }
    if (body.action === 'auto-retry') {
      if (!await this.auto.retry()) throw new SettingsError('busy', 409)
      return { state: { ...await this.state(), busy: false } }
    }
    if (body.action === 'save') {
      const proposed = validatePreferences(body.config)
      const available = await discoverProfiles(this.home)
      if (!proposed.profiles.every(name => available.some(profile => profile.name === name && profile.available))) throw new SettingsError('invalid-settings')
      if (body.password !== undefined && (typeof body.password !== 'string' || body.password.length > 4096 || /[\r\n]/.test(body.password))) throw new SettingsError('invalid-password')
      if (body.clearPassword !== undefined && typeof body.clearPassword !== 'boolean') throw new SettingsError('invalid-request')
      if (body.clearPassword && body.password) throw new SettingsError('invalid-request')
      const changesPassword = Boolean(body.password) || body.clearPassword === true
      if (changesPassword && !(await this.credentials.describe(PASSWORD_REF)).writable) throw new SettingsError('credentials-readonly')
      await savePreferences(this.home, body.config, body.revision, this.environment, this.defaults)
      if (JSON.stringify(proposed.sync) !== JSON.stringify(current.config.sync) || proposed.url !== current.config.url || proposed.username !== current.config.username) { this.sync.reset(); this.syncPassphrase = null }
      if (!proposed.autoBackup?.enabled || proposed.encryption === false) this.autoPassphrase = null
      if (proposed.encryption === false && this.auto.status.phase === 'locked') this.auto.status.phase = 'watching'
      try {
        if (body.password) await this.credentials.set(PASSWORD_REF, body.password)
        if (body.clearPassword) await this.credentials.unset(PASSWORD_REF)
      } catch { throw new SettingsError('credentials-save-incomplete', 500) }
      return { state: { ...await this.state(), busy: false } }
    }
    if (!current.config.url) throw new SettingsError('connection-required')
    if (['backup', 'preview'].includes(body.action) && (current.config.encryption !== false || body.passphrase !== undefined) && (typeof body.passphrase !== 'string' || body.passphrase.length < 12 || body.passphrase.length > 1024)) throw new SettingsError('passphrase-required')
    if (body.action === 'preview') { try { validateId(body.id) } catch { throw new SettingsError('invalid-snapshot') } }
    const remote = await this.connection(current.config)
    if (body.action === 'test') return remote.testConnection(signal)
    if (body.action === 'list') return { snapshots: await remote.list(signal) }
    if (body.action === 'backup') return { backup: await backup({ home: this.home, ...current.config, remote, passphrase: body.passphrase, signal,
      onVerified: (snapshot, result) => this.auto.noteManual(snapshot, current.config, result).catch(() => { this.auto.status.phase = 'error' }),
    }) }
    return { plan: await preview(await download({ id: body.id, remote, passphrase: body.passphrase, signal, allowUnencrypted: current.config.encryption === false }), { home: this.home }) }
  }

  startAuto(intervalMs = 5000) {
    if (this.timer || this.abort.signal.aborted) return
    const loop = async () => {
      try { await this.autoTick() } catch { this.auto.status.phase = 'error' }
      if (!this.abort.signal.aborted) { this.timer = setTimeout(loop, intervalMs); this.timer.unref?.() }
    }
    this.timer = setTimeout(loop, 0); this.timer.unref?.()
  }
  async autoTick(now = Date.now()) {
    if (this.busy || this.abort.signal.aborted) return
    this.busy = true; this.automaticActive = true
    this.active = (async () => {
      const { config } = await loadPreferences(this.home, this.environment, this.defaults)
      if (!config.autoBackup?.enabled || config.encryption === false) this.autoPassphrase = null
      await this.auto.step({ config, now, passphrase: this.autoPassphrase ?? this.environment.DSH_VAULT_PASSPHRASE, signal: this.abort.signal })
      await this.sync.step({ config, now, passphrase: this.syncPassphrase ?? this.environment.DSH_VAULT_PASSPHRASE, signal: this.abort.signal })
    })()
    try { await this.active } finally { this.busy = false; this.active = null; this.automaticActive = false }
  }
  async dispose() { clearTimeout(this.timer); this.abort.abort(); await this.active?.catch(() => {}); this.autoPassphrase = null; this.syncPassphrase = null }
}

export const API_PATH = '/api/dsh-config-vault'
export const STATE_PATH = '/api/dsh-config-vault/state'
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } })

/** Connection's shared Fetch channel enforces Host/Origin authentication and owner access. */
export function createSettingsHandler(service) {
  return async request => {
    try {
      if (request.method === 'GET') return json(await service.state())
      if (request.method !== 'POST') return json({ error: 'method-not-allowed' }, 405)
      if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') return json({ error: 'invalid-request' }, 415)
      const reader = request.body?.getReader(); const chunks = []; let size = 0
      if (!reader) throw new SettingsError('invalid-request')
      try {
        while (true) {
          const part = await reader.read(); if (part.done) break
          size += part.value.length
          if (size > 32768) { await reader.cancel(); throw new SettingsError('request-too-large', 413) }
          chunks.push(Buffer.from(part.value))
        }
      } finally { reader.releaseLock() }
      let body
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
      catch { throw new SettingsError('invalid-request') }
      return json(await service.execute(body, request.signal))
    } catch (error) {
      // Never reflect raw parser/network/provider messages that may contain secret material.
      const detail = diagnostic(error)
      return json({ error: error instanceof SettingsError ? error.code : 'operation-failed', ...(detail ? { diagnostic: detail } : {}) }, error instanceof SettingsError ? error.status : 502)
    }
  }
}
