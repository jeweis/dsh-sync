const React = require('react')
const h = React.createElement
const dictionaries = require('./locales.cjs')
const icon = require('./icon.svg')
const { ProviderSetup } = require('./provider-view.cjs')
const { SyncOptions, SyncStatus } = require('./sync-view.cjs')
const warningText = (t, code) => t(Object.hasOwn(dictionaries.en, code) ? code : 'warningOther')
const button = (label, disabled, onClick, primary = false) => h('button', { type: 'button', disabled, onClick, className: primary ? 'vault-button vault-primary' : 'vault-button' }, label)

function RecoveryPlan({ plan, t, encryption }) {
  const [shell, setShell] = React.useState('posix')
  const quote = value => shell === 'powershell' ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\\''")}'`
  const args = `--home ${quote(plan.home)} --id ${quote(plan.snapshotId)}${encryption === false ? ' --unencrypted' : ''}`
  const commands = `dsh-sync preview ${args}\ndsh-sync restore ${args} --confirm PLAN_TOKEN_FROM_CLI --offline`
  return h('section', { className: 'vault-card', 'aria-label': t('plan') },
    h('h3', null, t('plan')), h('p', { className: plan.blocked ? 'vault-warning' : 'vault-positive', role: 'status' }, t(plan.blocked ? 'blocked' : 'ready')),
    h('p', { className: 'vault-muted' }, t('target')), h('code', { className: 'vault-path' }, plan.home),
    plan.blocked && h('p', null, t('blockedHint')),
    plan.files.every(file => file.action === 'unchanged') && h('p', null, t('noChanges')),
    h('div', { className: 'vault-table-scroll' }, h('table', null, h('thead', null, h('tr', null, h('th', { scope: 'col' }, t('file')), h('th', { scope: 'col' }, t('action')))),
      h('tbody', null, plan.files.map(file => h('tr', { key: file.path }, h('td', null, h('code', null, file.path)), h('td', null, t(file.action))))))),
    plan.warnings.length > 0 && h('div', { className: 'vault-warning' }, h('h4', null, t('warnings')), h('ul', null, plan.warnings.map((warning, index) => h('li', { key: `${warning.code}:${warning.path ?? ''}:${index}` }, warningText(t, warning.code), warning.path && h('code', { className: 'vault-path' }, warning.path))))),
    h('details', null, h('summary', null, t('tokenHint')), h('code', { className: 'vault-path' }, plan.token)),
    h('h4', null, t('offline')), h('p', { className: 'vault-muted' }, t('offlineHint')),
    !plan.blocked && h(React.Fragment, null,
      h('label', { className: 'vault-field' }, t('shell'), h('select', { value: shell, onChange: event => setShell(event.target.value) }, h('option', { value: 'posix' }, t('posix')), h('option', { value: 'powershell' }, t('powershell')))),
      h('pre', { className: 'vault-commands', tabIndex: 0 }, commands), h('p', { className: 'vault-muted' }, t('commandHint'))),
    h('p', { className: 'vault-muted' }, t('dependencyHint')))
}

function VaultForm({ host, state, run, t }) {
  const [draft, setDraft] = React.useState(() => ({ ...host.config, profiles: [...host.config.profiles] }))
  const [password, setPassword] = React.useState(''), [clearPassword, setClear] = React.useState(false)
  const [passphrase, setPassphrase] = React.useState(''), [selected, setSelected] = React.useState('')
  const [autoPassphrase, setAutoPassphrase] = React.useState('')
  const auto = draft.autoBackup ?? { enabled: false, debounceMs: 30000, minIntervalMs: 300000 }
  const encrypted = draft.encryption !== false
  const sync = draft.sync ?? { enabled: false, apiKeys: false, space: 'default', categories: ['appearance', 'language', 'models'], intervalMs: 180000 }
  const changed = JSON.stringify(draft) !== JSON.stringify(host.config) || password !== '' || clearPassword
  const busy = state.busy || host.busy
  const validProfiles = draft.profiles.length > 0 && draft.profiles.every(name => host.profiles.some(profile => profile.name === name && profile.available))
  const remoteDisabled = busy || changed || !host.config.url
  const selectedId = state.snapshots?.includes(selected) ? selected : ''
  const passphraseValid = passphrase.length >= 12 && passphrase.length <= 1024
  const update = (key, value) => setDraft(previous => ({ ...previous, [key]: value }))
  const toggle = (name, checked) => update('profiles', checked ? [...draft.profiles, name] : draft.profiles.filter(profile => profile !== name))
  const save = event => {
    event.preventDefault()
    const payload = { config: draft, ...(password ? { password } : {}), ...(clearPassword ? { clearPassword: true } : {}) }
    setPassword(''); setClear(false); void run('save', payload)
  }
  const secretAction = (action, payload = {}) => { const value = passphrase; setPassphrase(''); void run(action, { ...payload, ...(value || host.config.encryption !== false ? { passphrase: value } : {}) }) }
  return h(React.Fragment, null,
    h('form', { onSubmit: save, className: 'vault-card', 'aria-label': t('connection') },
      h('h3', null, t('connection')),
      h('fieldset', { disabled: busy },
        h('label', { className: 'vault-field' }, t('url'), h('input', { type: 'url', value: draft.url, placeholder: 'https://dav.example.com/backups/dsh/', required: true, maxLength: 4096, onChange: event => update('url', event.target.value) })),
        draft.url.trim().toLowerCase().startsWith('http:') && h('p', { role: 'note', className: 'vault-warning' }, t('httpWarning')),
        h('div', { className: 'vault-columns' },
          h('label', { className: 'vault-field' }, t('username'), h('input', { value: draft.username, maxLength: 256, autoComplete: 'off', onChange: event => update('username', event.target.value) })),
          h('label', { className: 'vault-field' }, t('password'), h('input', { type: 'password', value: password, disabled: !host.passwordWritable || clearPassword, maxLength: 4096, autoComplete: 'new-password', onChange: event => setPassword(event.target.value) }))),
        h('p', { className: 'vault-muted' }, t('passwordHint')),
        h('p', { className: 'vault-muted', role: 'status' }, t(host.passwordConfigured ? 'passwordSet' : 'passwordMissing'), !host.passwordWritable && ` · ${t('passwordReadonly')}`),
        h('label', { className: 'vault-check' }, h('input', { type: 'checkbox', checked: clearPassword, disabled: !host.passwordWritable, onChange: event => { setClear(event.target.checked); setPassword('') } }), t('clearPassword')),
        clearPassword && h('p', { className: 'vault-muted' }, t('clearHint')),
        h(SyncOptions, { value: sync, update: value => update('sync', value), t }),
        h('details', { className: 'vault-backup-settings' }, h('summary', null, t('backupSettings')),
        h('fieldset', { className: 'vault-profile-choices' }, h('legend', null, t('profiles')), host.profiles.map(profile => h('label', { key: profile.name, className: 'vault-check' },
          h('input', { type: 'checkbox', checked: draft.profiles.includes(profile.name), disabled: !profile.available && !draft.profiles.includes(profile.name), onChange: event => toggle(profile.name, event.target.checked) }), profile.name, !profile.available && ` (${t('unavailable')})`))),
        h('p', { className: 'vault-muted' }, t('profilesHint')),
        h('label', { className: 'vault-check' }, h('input', { type: 'checkbox', checked: draft.includeHomePatch, onChange: event => update('includeHomePatch', event.target.checked) }), t('homePatch')),
        h('p', { className: 'vault-muted' }, t('homeHint')),
        h('label', { className: 'vault-check' }, h('input', { type: 'checkbox', checked: encrypted, onChange: event => update('encryption', event.target.checked) }), t('encryption')),
        !encrypted && h('p', { role: 'note', className: 'vault-warning' }, t('plaintextWarning')),
        h('label', { className: 'vault-field' }, t('keepLast'), h('input', { type: 'number', min: 1, max: 10000, step: 1, value: draft.keepLast ?? 30, onChange: event => update('keepLast', Number(event.target.value)) })),
        h('p', { className: 'vault-muted' }, t('retentionHint')),
        host.retention?.deviceId && h('p', { className: 'vault-muted' }, t('retentionDevice'), ' ', h('code', null, host.retention.deviceId)),
        host.retention?.lastCleanup && h('p', { className: 'vault-muted' }, t('cleanupDeleted'), ' ', host.retention.lastCleanup.deleted ?? 0, ' · ', t('cleanupPending'), ' ', host.retention.lastCleanup.pending ?? 0),
        host.retention?.lastCleanup && (host.retention.lastCleanup.status !== 'ok' || host.retention.lastCleanup.pending > 0) && h('p', { role: 'status', className: 'vault-warning' }, t('cleanupWarning'), ' ', t('cleanupPending'), ' ', host.retention.lastCleanup.pending ?? 0, host.retention.lastCleanup.httpStatus && ` · HTTP ${host.retention.lastCleanup.httpStatus}`),
        h('fieldset', { className: 'vault-profile-choices' }, h('legend', null, t('autoTitle')),
          h('label', { className: 'vault-check' }, h('input', { type: 'checkbox', checked: auto.enabled, onChange: event => update('autoBackup', { ...auto, enabled: event.target.checked }) }), t('autoEnable')),
          h('p', { className: 'vault-muted' }, t('autoHint')),
          auto.enabled && h(React.Fragment, null,
            h('label', { className: 'vault-field' }, t('autoDebounce'), h('input', { type: 'number', min: 1, max: 600, value: auto.debounceMs / 1000, onChange: event => update('autoBackup', { ...auto, debounceMs: Number(event.target.value) * 1000 }) })),
            h('label', { className: 'vault-field' }, t('autoInterval'), h('input', { type: 'number', min: 1, max: 1440, value: auto.minIntervalMs / 60000, onChange: event => update('autoBackup', { ...auto, minIntervalMs: Number(event.target.value) * 60000 }) })))),
        ),
        h('label', { className: 'vault-field vault-timeout' }, t('timeout'), h('input', { type: 'number', min: 1, max: 120, step: 1, value: draft.timeoutMs / 1000, onChange: event => update('timeoutMs', Number(event.target.value) * 1000) })),
        changed && h('p', { role: 'status', className: 'vault-muted' }, t('unsaved')),
        h('div', { className: 'vault-actions' }, h('button', { type: 'submit', disabled: busy || !validProfiles || !draft.url || sync.enabled && !sync.categories.length && !sync.apiKeys, className: 'vault-button vault-primary' }, t('save')), button(t('test'), remoteDisabled, () => { void run('test') })),
        h('p', { className: 'vault-muted' }, t('testHint')))),
    host.config.sync?.enabled && h(SyncStatus, { key: host.sync?.token ?? 'sync', host, disabled: remoteDisabled, run, t }),
    h(ProviderSetup, {referenceMode:host.sync?.referenceMode,plan:state.providerPlan,disabled:busy,run,t}),
    host.config.autoBackup?.enabled && h('section', { className: 'vault-card', 'aria-label': t('autoTitle') },
      h('h3', null, t('autoTitle')),
      h('p', { role: 'status' }, t(`auto-${host.auto?.phase ?? 'watching'}`)),
      host.auto?.lastSuccessAt && h('p', null, t('autoLast'), ' ', host.auto.lastSuccessAt),
      host.auto?.snapshotId && h('code', { className: 'vault-path' }, host.auto.snapshotId),
      host.auto?.nextAt && h('p', null, t('autoNext'), ' ', new Date(host.auto.nextAt).toLocaleString()),
      host.auto?.error && h('p', { className: 'vault-warning' }, t('failureStage'), t(`stage-${host.auto.error.stage}`), host.auto.error.status && ` · HTTP ${host.auto.error.status}`, ' · ', t(`reason-${host.auto.error.reason}`)),
      host.config.encryption !== false && h(React.Fragment, null,
        h('label', { className: 'vault-field' }, t('autoPassphrase'), h('input', { type: 'password', value: autoPassphrase, maxLength: 1024, autoComplete: 'off', disabled: busy, onChange: event => setAutoPassphrase(event.target.value) })),
        h('p', { className: 'vault-muted' }, t('autoSecretHint')),
        button(t('autoUnlock'), remoteDisabled || autoPassphrase.length < 12 || autoPassphrase.length > 1024, () => { const value = autoPassphrase; setAutoPassphrase(''); void run('auto-unlock', { passphrase: value }) })),
      ['error', 'uncertain'].includes(host.auto?.phase) && h(React.Fragment, null,
        h('p', { className: 'vault-warning' }, t('autoRetryHint')),
        button(t('autoRetry'), remoteDisabled, () => { void run('auto-retry') }))),
    h('section', { className: 'vault-card', 'aria-label': t('operations') },
      h('h3', null, t('operations')), h('p', { className: 'vault-muted' }, t('scope')),
      h('label', { className: 'vault-field' }, t('passphrase'), h('input', { type: 'password', value: passphrase, maxLength: 1024, disabled: busy, autoComplete: 'off', onChange: event => setPassphrase(event.target.value) })),
      h('p', { className: 'vault-muted' }, t('passphraseHint')),
      button(t('backup'), remoteDisabled || (host.config.encryption !== false && !passphraseValid) || !validProfiles, () => secretAction('backup'), true),
      state.backup && h('p', { role: 'status', className: 'vault-positive' }, t('backedUp'), h('code', { className: 'vault-path' }, state.backup.id))),
    h('section', { className: 'vault-card', 'aria-label': t('snapshots') },
      h('div', { className: 'vault-heading' }, h('h3', null, t('snapshots')), button(t('list'), remoteDisabled, () => { void run('list') })),
      h('p', { className: 'vault-muted' }, t('snapshotHint')),
      state.snapshots === null ? h('p', null, t('notLoaded')) : state.snapshots.length === 0 ? h('p', null, t('empty')) : h(React.Fragment, null,
        h('label', { className: 'vault-field' }, t('selectSnapshot'), h('select', { value: selectedId, disabled: busy, onChange: event => setSelected(event.target.value) },
          h('option', { value: '' }, t('selectSnapshot')), state.snapshots.map(id => h('option', { key: id, value: id }, id)))),
        button(t('preview'), remoteDisabled || !selectedId || (host.config.encryption !== false && !passphraseValid), () => secretAction('preview', { id: selectedId })))),
    state.plan && state.plan.snapshotId === selectedId && h(RecoveryPlan, { plan: state.plan, t, encryption: host.config.encryption }))
}

function VaultPage({ useVault, run, reload, t }) {
  const state = useVault(value => value)
  return h('div', { className: 'dsh-vault-page', 'aria-busy': state.busy },
    h('header', { className: 'vault-heading' }, h('div', { className: 'vault-brand' }, h('img', { src: icon, width: 44, height: 44, alt: '', 'aria-hidden': true, className: 'vault-brand-icon' }), h('div', null, h('h2', null, t('title')), h('p', { className: 'vault-muted' }, t('subtitle')))), button(t('refresh'), state.busy, () => { void reload() })),
    h('div', { 'aria-live': 'polite' }, state.busy && h('p', { role: 'status' }, t('working')), state.notice && h('p', { role: 'status', className: ['backupUnknown', 'backupNotUploaded', 'connectedMissing', 'backedUpCleanupWarning'].includes(state.notice) ? 'vault-warning' : 'vault-positive' }, t(state.notice))),
    state.error && h('div', { role: 'alert', className: 'vault-warning' }, state.diagnostic ? h(React.Fragment, null,
      h('p', null, t('failureStage'), t(`stage-${state.diagnostic.stage}`), state.diagnostic.status && ` · HTTP ${state.diagnostic.status}`),
      h('p', null, t(state.diagnostic.reason === 'invalid-data' && ['mkdir', 'list'].includes(state.diagnostic.stage) ? 'reason-invalid-directory' : `reason-${state.diagnostic.reason}`)),
      h('p', null, t(`help-${state.diagnostic.stage}`))) : t(state.error)),
    state.host && h(VaultForm, { key: `${state.host.revision}:${state.refreshRevision}`, host: state.host, state, run, t }))
}
module.exports = { VaultPage }
