// Browser controller owns request state. Form secrets stay in component-local inputs only.
const { createSnapshotStore } = require('@deepseek-ai/dsh-client-store')
const ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[a-f0-9-]{36}$/
const errors = new Set(['invalid-settings', 'invalid-webdav', 'stale-settings', 'invalid-password', 'invalid-request', 'credentials-readonly', 'credentials-save-incomplete', 'connection-required', 'passphrase-required', 'invalid-snapshot', 'busy', 'stopping', 'request-too-large', 'operation-failed', 'unsupported-settings'])
function publicDiagnostic(value) {
  if (!value || !['collect', 'encrypt', 'mkdir', 'upload', 'download', 'verify', 'list', 'cleanup'].includes(value.stage) || !['failed', 'http', 'network', 'tls', 'timeout', 'cancelled', 'size', 'invalid-data'].includes(value.reason)) return null
  return { stage: value.stage, reason: value.reason,
    ...(Number.isInteger(value.status) && value.status >= 100 && value.status <= 599 ? { status: value.status } : {}),
    ...(typeof value.remoteMayExist === 'boolean' ? { remoteMayExist: value.remoteMayExist } : {}) }
}
function validState(value) {
  return value && typeof value.revision === 'string' && typeof value.passwordConfigured === 'boolean' && typeof value.passwordWritable === 'boolean' && typeof value.busy === 'boolean'
    && value.config && typeof value.config.url === 'string' && typeof value.config.username === 'string'
    && Array.isArray(value.config.profiles) && value.config.profiles.every(x => typeof x === 'string') && typeof value.config.includeHomePatch === 'boolean' && Number.isInteger(value.config.timeoutMs)
    && Array.isArray(value.profiles) && value.profiles.every(x => typeof x.name === 'string' && typeof x.available === 'boolean')
}
function validPlan(plan) {
  return plan && ID.test(plan.snapshotId) && typeof plan.home === 'string' && typeof plan.token === 'string' && /^[a-f0-9]{64}$/.test(plan.token) && typeof plan.blocked === 'boolean'
    && Array.isArray(plan.files) && plan.files.every(file => typeof file.path === 'string' && ['create', 'replace', 'unchanged'].includes(file.action))
    && Array.isArray(plan.warnings) && plan.warnings.every(warning => typeof warning.code === 'string')
}
function validProviderPlan(plan) {
  return plan && plan.version===1 && ['enable','rollback'].includes(plan.mode) && Array.isArray(plan.profiles) && Array.isArray(plan.refs) && (plan.blocked===true && typeof plan.reason==='string' || typeof plan.home==='string' && typeof plan.installAnchor==='string' && typeof plan.storage==='string' && plan.refs.every(x=>typeof x==='string'&&/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(x)) && plan.profiles.every(x=>x&&typeof x.name==='string'&&typeof x.path==='string'&&typeof x.from==='string'&&typeof x.to==='string'))
}
class Controller {
  constructor(fetcher = (...args) => fetch(...args)) {
    this.fetcher = fetcher; this.abort = new AbortController()
    this.state = createSnapshotStore({ host: null, busy: false, error: null, diagnostic: null, notice: null, snapshots: null, plan: null, providerPlan:null, backup: null, refreshRevision: 0 })
  }
  async request(method, body) {
    const response = await this.fetcher(method === 'GET' ? '/api/dsh-config-vault/state' : '/api/dsh-config-vault', { method, credentials: 'same-origin', cache: 'no-store', signal: this.abort.signal,
      ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) })
    const value = await response.json()
    if (!response.ok) {
      const error = new Error(errors.has(value.error) ? value.error : 'operation-failed')
      error.diagnostic = publicDiagnostic(value.diagnostic)
      throw error
    }
    return value
  }
  async read() { const host = await this.request('GET'); if (!validState(host)) throw new Error('operation-failed'); return host }
  async load() {
    if (this.state.getSnapshot().busy || this.abort.signal.aborted) return
    this.state.update(state => { state.busy = true; state.error = null; state.diagnostic = null; state.notice = null })
    try {
      const host = await this.read()
      if (!this.abort.signal.aborted) this.state.update(state => {
        if (state.host?.revision !== host.revision) { state.snapshots = null; state.plan = null; state.backup = null }
        state.host = host; state.refreshRevision += 1
      })
    } catch (error) { if (!this.abort.signal.aborted) this.state.update(state => { state.error = errors.has(error.message) ? error.message : 'operation-failed'; state.diagnostic = publicDiagnostic(error.diagnostic); state.host = null }) }
    finally { if (!this.abort.signal.aborted) this.state.update(state => { state.busy = false }) }
  }
  async run(action, payload = {}) {
    const before = this.state.getSnapshot()
    if (before.busy || !before.host || this.abort.signal.aborted) return
    this.state.update(state => { state.busy = true; state.error = null; state.diagnostic = null; state.notice = null; if (action === 'preview') state.plan = null; if(action==='provider-preview') state.providerPlan=null; if (action === 'backup') { state.backup = null; state.plan = null; state.snapshots = null } })
    try {
      const value = await this.request('POST', { ...payload, action, revision: before.host.revision })
      if (this.abort.signal.aborted) return
      if ((['save', 'auto-unlock', 'auto-retry'].includes(action) || action.startsWith('sync-')) && !validState(value.state)) throw new Error('operation-failed')
      if (action === 'test' && value.connected !== true) throw new Error('operation-failed')
      if (action === 'list' && (!Array.isArray(value.snapshots) || !value.snapshots.every(id => typeof id === 'string' && ID.test(id)))) throw new Error('operation-failed')
      if(action==='provider-preview'&&!validProviderPlan(value.providerPlan)) throw new Error('operation-failed')
      if (action === 'preview' && !validPlan(value.plan)) throw new Error('operation-failed')
      if (action === 'backup' && (!value.backup || !ID.test(value.backup.id) || value.backup.verified !== true)) throw new Error('operation-failed')
      this.state.update(state => {
        if (action === 'save') { state.host = value.state; state.refreshRevision += 1; state.snapshots = null; state.plan = null; state.backup = null; state.notice = 'saved' }
        if (['auto-unlock', 'auto-retry'].includes(action)) { state.host = value.state; state.notice = 'saved' }
        if (action.startsWith('sync-')) { state.host = value.state; state.notice = null }
        if(action==='provider-preview') state.providerPlan=value.providerPlan
        if (action === 'test') state.notice = value.directoryExists === false ? 'connectedMissing' : 'connected'
        if (action === 'list') { state.snapshots = value.snapshots; state.plan = null }
        if (action === 'preview') state.plan = value.plan
        if (action === 'backup') { state.backup = value.backup; state.snapshots = null; state.plan = null; state.notice = value.backup.retention && (value.backup.retention.status !== 'ok' || value.backup.retention.pending > 0) ? 'backedUpCleanupWarning' : 'backedUp' }
      })
    } catch (error) {
      if (this.abort.signal.aborted) return
      // Do not repeat writes after a lost response: outcome may already be committed.
      let host = before.host
      if (action === 'save' || action.startsWith('sync-')) { try { host = await this.read() } catch { host = null } }
      if (!this.abort.signal.aborted) this.state.update(state => {
        state.host = host; state.error = errors.has(error.message) ? error.message : 'operation-failed'; state.diagnostic = publicDiagnostic(error.diagnostic)
        if (action === 'save') { state.refreshRevision += 1; state.snapshots = null; state.plan = null; state.backup = null }
        if (action === 'backup') state.notice = state.diagnostic?.remoteMayExist === false || state.error !== 'operation-failed' ? 'backupNotUploaded' : 'backupUnknown'
      })
    } finally { if (!this.abort.signal.aborted) this.state.update(state => { state.busy = false }) }
  }
  startPolling() {
    const poll = async () => {
      if (!this.state.getSnapshot().busy && !this.abort.signal.aborted) {
        try {
          const host = await this.read()
          if (!this.abort.signal.aborted && !this.state.getSnapshot().busy) this.state.update(state => {
            if (state.host?.revision === host.revision) state.host = host
            // Do not discard an in-progress form draft after an external settings edit.
          })
        } catch { /* Keep the form and explicit action errors; the Reload button retries. */ }
      }
      if (!this.abort.signal.aborted) this.pollTimer = setTimeout(poll, 5000)
    }
    this.pollTimer = setTimeout(poll, 5000)
  }
  dispose() { clearTimeout(this.pollTimer); this.abort.abort() }
}
module.exports = { Controller }
