#!/usr/bin/env node
/** Offline configuration operations; intentionally not an alternate Harness launcher. */
import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { backup, download, preview, restore, recover, transportFromEnvironment, passphraseFromEnvironment } from './engine.mjs'
import { RUNTIME } from './snapshot.mjs'
import { providerTransition, ProviderTransitionError } from './provider-transition.mjs'
import { loadPreferences } from './settings.mjs'

const help = `dsh-sync <backup|list|preview|restore|recover|provider-preview|provider-switch> [options]
  --home PATH              Explicit source/target Harness home
  --profiles web,headless   Backup profile selection (default: web)
  --include-home-patch      Include machine-wide cordis.patch.yml (default: false)
  --id ID                   Remote snapshot for preview/restore
  --runtime-version VERSION Declared destination/source Harness version
  --confirm TOKEN           Exact token returned by preview (or recover preview)
  --offline                 Assert all Harness processes using this home are stopped
  --unencrypted             Write/read plaintext snapshots (configuration may contain secrets)
  --keep-last COUNT         Keep latest device-owned snapshots after verified backup (default: 30)
  --mode enable|rollback    Provider onboarding or safe return to the old provider
  --install-anchor PATH     Existing DSH package-resolution anchor (provider commands)
  --refs REF,REF            Explicit provider references (default: discovered refs)
  --all-writers-stopped     Assert every writer sharing this credential store is stopped
  --rollback ID             Retained rollback transaction (recover only)
Environment: DSH_VAULT_WEBDAV_URL, DSH_VAULT_WEBDAV_USERNAME,
DSH_VAULT_WEBDAV_PASSWORD, DSH_VAULT_PASSPHRASE (12+ characters).
With --home, saved non-secret connection preferences are loaded from that home.
The offline CLI reads secrets from the environment. Plaintext backup/preview need
no passphrase; confirmed restore/recover always need one for encrypted journals.
No dependencies are installed, scripts executed or live profiles reloaded by this CLI.
Restore without --confirm only previews. recover without --confirm only previews.
Provider preview/switch require DSH_VAULT_PASSPHRASE for encrypted journals.
provider-switch without --confirm only previews; applying also requires --offline
and --all-writers-stopped. Rollback transfers the current managed Keys before
returning to the original provider, and can recover interrupted transitions.`

export async function main(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    mode:{type:'string'},'install-anchor':{type:'string'},refs:{type:'string'},'all-writers-stopped':{type:'boolean',default:false},
    home: { type: 'string' }, profiles: { type: 'string' }, id: { type: 'string' }, confirm: { type: 'string' }, rollback: { type: 'string' },
    'runtime-version': { type: 'string' }, 'include-home-patch': { type: 'boolean', default: false }, offline: { type: 'boolean', default: false }, help: { type: 'boolean' }, unencrypted: { type: 'boolean', default: false }, 'keep-last': { type: 'string' },
  } })
  if (values.help) return { help }
  const command = positionals[0]
  if (values['keep-last'] !== undefined && (!/^[1-9]\d{0,4}$/.test(values['keep-last']) || Number(values['keep-last']) > 10000 || command !== 'backup')) throw new Error('--keep-last must be 1–10000 and is only valid for backup')
  if (positionals.length !== 1 || !['backup', 'list', 'preview', 'restore', 'recover', 'provider-preview', 'provider-switch'].includes(command)) throw new Error(help)
  if (command !== 'list' && !values.home?.trim()) throw new Error('--home is required; no implicit restore target')
  const home = values.home && resolve(values.home), runtimeVersion = values['runtime-version'] ?? RUNTIME
  if (command.startsWith('provider-')) {
    if(!values['install-anchor'] || !['enable','rollback'].includes(values.mode)) throw new Error('provider-invalid-request')
    if(command==='provider-preview' && values.confirm) throw new Error('provider-invalid-request')
    try { return await providerTransition({home,installAnchor:resolve(values['install-anchor']),mode:values.mode,refs:values.refs?.split(','),passphrase:passphraseFromEnvironment(),token:command==='provider-switch'?values.confirm:undefined,offline:values.offline,allWritersStopped:values['all-writers-stopped']}) }
    catch(error) {throw new Error(error instanceof ProviderTransitionError?error.code:'provider-operation-failed')}
  }
  if (command === 'recover') return recover({ home, passphrase: passphraseFromEnvironment(), token: values.confirm, rollbackId: values.rollback, offline: values.offline })
  const preferences = home ? (await loadPreferences(home)).config : {}
  const remote = transportFromEnvironment(process.env, preferences)
  if (command === 'list') return { snapshots: await remote.list() }
  const encryption = values.unencrypted ? false : preferences.encryption !== false
  const passphrase = encryption || (command === 'restore' && values.confirm) ? passphraseFromEnvironment() : process.env.DSH_VAULT_PASSPHRASE
  if (command === 'backup') {
    if (values.confirm) throw new Error('--confirm does not apply to backup')
    return backup({ home, profiles: values.profiles ? values.profiles.split(',') : preferences.profiles, includeHomePatch: values['include-home-patch'] || preferences.includeHomePatch, runtimeVersion, remote, passphrase, encryption, keepLast: values['keep-last'] ? Number(values['keep-last']) : preferences.keepLast ?? 30 })
  }
  if (!values.id) throw new Error('--id is required')
  const snapshot = await download({ id: values.id, remote, passphrase, allowUnencrypted: !encryption })
  if (command === 'restore' && values.confirm) return restore(snapshot, { home, runtimeVersion, passphrase, token: values.confirm, offline: values.offline })
  return preview(snapshot, { home, runtimeVersion })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await main(), null, 2)) }
  catch (error) { console.error(`Vault: ${error.message}`); process.exitCode = 1 }
}
