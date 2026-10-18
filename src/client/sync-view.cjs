const React = require('react')
const h = React.createElement
const categories = ['appearance', 'language', 'models', 'plugins']
const button = (text, disabled, onClick) => h('button', { type: 'button', className: 'vault-button', disabled, onClick }, text)
function SyncOptions({ value, update, t, advanced }) {
  return h('fieldset', { className: 'vault-profile-choices' }, h('legend', {className:'vault-sr-only'}, t('syncTitle')),
    h('label', { className: 'vault-check' }, h('input', { type: 'checkbox', checked: value.enabled, onChange: e => update({ ...value, enabled: e.target.checked }) }), t('syncEnable')),
    h('p', { className: 'vault-muted' }, t('syncHint')),
    value.enabled && h(React.Fragment, null,
      h('details', { className: 'vault-more' }, h('summary', null, t('syncContent')),
      categories.map(category => h('label', { className: 'vault-check', key: category }, h('input', { type: 'checkbox', checked: value.categories.includes(category), onChange: e => update({ ...value, categories: e.target.checked ? [...value.categories, category] : value.categories.filter(x => x !== category) }) }), t(`syncCategory-${category}`))),
      h('p', { className: 'vault-muted' }, t('syncScopeHint'))),
      h('label', { className: 'vault-check' }, h('input', { type: 'checkbox', checked: value.apiKeys === true, onChange: e => update({ ...value, apiKeys: e.target.checked }) }), t('syncApiKeys')),
      value.apiKeys && h('p', { className: 'vault-muted' }, t('syncApiKeysHint')),
      value.apiKeys && h('p', { className: 'vault-muted' }, t('syncKeyReceivingHint')),
      h('p', { className: 'vault-muted' }, t('syncEncrypted'))),
      h('details', {className:'vault-more','data-more':'sync'},h('summary',null,t('syncMore')),
      value.enabled && h('label', { className: 'vault-field' }, t('syncSpace'), h('input', { value: value.space, maxLength: 64, pattern: '[A-Za-z0-9][A-Za-z0-9_-]{0,63}', required: true, onChange: e => update({ ...value, space: e.target.value }) })),
      value.enabled && h('p', { className: 'vault-muted' }, t('syncSpaceHint')),
      value.enabled && h('label', { className: 'vault-field' }, t('syncInterval'), h('select', { value: value.intervalMs, onChange: e => update({ ...value, intervalMs: Number(e.target.value) }) }, [3, 15, 30, 60].map(minutes => h('option', { key: minutes, value: minutes * 60000 }, `${minutes} ${t('syncMinutes')}`)))),
      advanced))
}
function changeLabel(item, t) {
  const field = item.label?.split(' · ').at(-1)
  if (item.category === 'appearance' && ['preference','fontSize','codeFontSize','terminalFontSize','textFontFamily','codeFontFamily','terminalFontFamily'].includes(field)) return t(`syncField-${field}`)
  if (item.category === 'language') return t('syncField-language')
  if (item.category === 'models') return t(item.label?.includes('default-model') ? 'syncField-defaultModel' : 'syncField-modelOptions')
  if (item.category === 'plugins') return t('syncField-plugins')
  return item.label
}
function SyncStatus({ host, disabled, run, t }) {
  const [secret, setSecret] = React.useState(''), [choices, setChoices] = React.useState({})
  const status = host.sync ?? { phase: 'unavailable', changes: [], pending: [] }
  const changes = status.changes ?? []
  const display = (item, value) => item.category === 'apiKeys' && value !== null ? t(value.configured ? 'syncKeySet' : 'syncKeyMissing') : value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0 ? t('syncDefaultValue') : JSON.stringify(value, null, 2)
  const receive = () => { void run('sync-resolve', { token: status.token, choices: Object.fromEntries(changes.map(item=>[item.id,item.remote===null?'local':'remote'])) }) }
  const publish = () => { void run('sync-resolve', { token: status.token, choices: Object.fromEntries(changes.map(item=>[item.id,'local'])) }) }
  const chooseAll = choice => setChoices(Object.fromEntries(changes.filter(item => choice === 'local' || item.remote !== null).map(item => [item.id, choice])))
  return h('section', { className: 'vault-subsection', 'aria-label': t('syncStatus') },
    h('h3', null, t('syncStatus')), h('p', { className: 'vault-muted' }, t('syncProfile'), ' ', status.profile),
    host.config.sync?.apiKeys && h('p', { className: 'vault-muted' }, t(`syncReferenceMode-${status.referenceMode ?? 'manual'}`)),
    h('p', { role: 'status' }, t(`syncPhase-${status.phase}`)), status.lastSuccessAt && h('p', { className: 'vault-muted' }, t('syncLast'), ' ', new Date(status.lastSuccessAt).toLocaleString()),
    status.error && h('p', { role: 'alert', className: 'vault-warning' }, t(status.error)),
    h(['locked','error'].includes(status.phase) ? 'div' : 'details', { className: 'vault-more' }, !['locked','error'].includes(status.phase) && h('summary', null, t('syncUnlockAgain')),
    h('label', { className: 'vault-field' }, t('syncPassphrase'), h('input', { type: 'password', value: secret, maxLength: 1024, autoComplete: 'off', disabled, onChange: e => setSecret(e.target.value) })),
    h('p', { className: 'vault-muted' }, t('syncSecretHint')),
    h('div', { className: 'vault-actions' }, button(t('syncUnlock'), disabled || secret.length < 12 || secret.length > 1024, () => { const passphrase = secret; setSecret(''); void run('sync-unlock', { passphrase }) }))), button(t('syncNow'), disabled || ['locked', 'uncertain', 'unavailable'].includes(status.phase), () => { void run('sync-now') }),
    status.phase === 'uncertain' && h(React.Fragment, null, h('p', { className: 'vault-warning' }, t('syncRecheckHint')), button(t('syncRecheck'), disabled, () => { void run('sync-recheck') })),
    changes.length > 0 && h(React.Fragment, null,
      h('h4', null, t(status.phase === 'join' ? 'syncFirst' : 'syncConflicts')), h('p', { className: 'vault-muted' }, t('syncCompareHint')),
      status.phase === 'join' && h(React.Fragment, null, h('p', null, t('syncInitialCount'), ' ', changes.length), h('p', {className:'vault-muted'}, t('syncReceiveHint')),
        h('div',{className:'vault-actions'}, button(t('syncReceive'),disabled || changes.every(item=>item.remote===null),receive),button(t('syncPublish'),disabled,publish))),
      h('details', { open: status.phase !== 'join', className:'vault-more' },h('summary',null,t('syncReviewDetails')),
      h('div', { className: 'vault-actions' }, button(t('syncChooseLocal'), disabled, () => chooseAll('local')), button(t('syncChooseRemote'), disabled || changes.some(item => item.remote === null), () => chooseAll('remote'))),
      changes.map(item => h('div', { key: item.id, className: 'vault-sync-change' }, h('h4', null, changeLabel(item, t)),
        h('div', { className: 'vault-columns' }, h('div', null, h('strong', null, t('syncLocal')), h('pre', { className: 'vault-commands', tabIndex: 0 }, display(item, item.local))), h('div', null, h('strong', null, t('syncRemote')), h('pre', { className: 'vault-commands', tabIndex: 0 }, item.remote === null ? t('syncAbsent') : display(item, item.remote)))),
        item.manualRemote && h('p', { className: 'vault-warning' }, t('syncPending-reference-manual')),
        h('label', { className: 'vault-field' }, t('syncChoice'), h('select', { value: choices[item.id] ?? '', disabled, onChange: e => setChoices(old => ({ ...old, [item.id]: e.target.value })) }, h('option', { value: '' }, t('syncSelect')), h('option', { value: 'local' }, t('syncUseLocal')), item.remote !== null && h('option', { value: 'remote' }, t(item.manualRemote ? 'syncReferenceManualChoice' : 'syncUseRemote')))))),
      button(t('syncConfirm'), disabled || !changes.every(item => ['local', 'remote'].includes(choices[item.id])), () => { void run('sync-resolve', { token: status.token, choices }) }))),
    status.pending?.length > 0 && h(React.Fragment, null, h('h4', null, t('syncPending')), h('p', { className: 'vault-warning' }, t('syncPendingHint')),
      status.pending.map(item => h('details', { key: item.id, open: item.reason === 'reference-manual' }, h('summary', null, changeLabel(item, t)), h('p', null, t(`syncPending-${item.reason}`)), h('pre', { className: 'vault-commands' }, item.category === 'apiKeys' ? `${t('syncLocal')}: ${display(item, item.local)}\n${t('syncRemote')}: ${display(item, item.remote)}` : JSON.stringify({ local: item.local, remote: item.remote }, null, 2))))))
}
module.exports = { SyncOptions, SyncStatus }
