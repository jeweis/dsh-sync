/** Harness host entry: live field sync via Settings; snapshot restore stays offline. */
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { backup, download, preview, passphraseFromEnvironment, transportFromEnvironment } from './engine.mjs'
import { PROFILE, safePath } from './files.mjs'
import { loadPreferences, PASSWORD_REF } from './settings.mjs'
import { WebDAV } from './webdav.mjs'
import { VaultSettingsService, createSettingsHandler, API_PATH, STATE_PATH } from './ui-service.mjs'
import { HarnessSyncAdapter } from './sync-adapter.mjs'

export const name = 'dsh-sync'
export const inject = ['tools']

/** Standard Schema validation keeps credentials out of plugin configuration. */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-sync',
    validate(input) {
      const value = input ?? {}
      if (!value || typeof value !== 'object' || Array.isArray(value)) return { issues: [{ message: 'Expected configuration object' }] }
      if (Object.keys(value).some(key => !['profiles', 'includeHomePatch', 'timeoutMs'].includes(key))) return { issues: [{ message: 'Unknown configuration field' }] }
      const profiles = value.profiles ?? ['web'], includeHomePatch = value.includeHomePatch ?? false, timeoutMs = value.timeoutMs ?? 30000
      if (!Array.isArray(profiles) || profiles.length === 0 || profiles.length > 40 || new Set(profiles).size !== profiles.length || !profiles.every(x => typeof x === 'string' && PROFILE.test(x)) || typeof includeHomePatch !== 'boolean' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) return { issues: [{ message: 'Invalid profiles, includeHomePatch or timeoutMs' }] }
      return { value: { profiles, includeHomePatch, timeoutMs } }
    },
  },
}

/** Register tracked tools; passphrases never appear in tool arguments or results. */
export function apply(ctx, input) {
  const parsed = Config['~standard'].validate(input)
  if (parsed.issues) throw new Error(parsed.issues[0].message)
  const config = parsed.value
  const home = resolve(ctx.get('profileContext')?.home ?? (process.env.DSH_HOME || resolve(homedir(), '.dsh')))
  const preferences = async () => (await loadPreferences(home, process.env, config)).config
  const remote = async selected => {
    const credentials = ctx.get('credentials')
    if (!credentials) return transportFromEnvironment(process.env, selected)
    return new WebDAV({ ...selected, password: (await credentials.resolve(PASSWORD_REF))?.value ?? '' })
  }
  const passphrase = () => passphraseFromEnvironment()
  let settingsService
  const settingsAction = async (action, payload, signal) => {
    const service = settingsService
    if (!service) return null
    return service.execute({ action, ...payload, revision: (await service.state()).revision }, signal)
  }
  ctx.inject(['credentials', 'profileContext'], child => {
    const profile = child.profileContext.name
    const syncAdapter = new HarnessSyncAdapter({ home: child.profileContext.home, profile, getContext: () => child })
    const service = new VaultSettingsService({ home: child.profileContext.home, credentials: child.credentials, defaults: config, profile, syncAdapter, providerContext: child.profileContext })
    settingsService = service
    service.startAuto()
    child.effect(() => () => { if (settingsService === service) settingsService = undefined; return service.dispose() })
    child.inject(['connection'], channel => {
    const handler = createSettingsHandler(service)
    // rc.2's streaming bridge always attaches a body, which WHATWG GET forbids.
    channel.effect(() => channel.connection.fetch.register({ path: STATE_PATH, methods: ['GET'], requestBody: 'buffered', fetch: handler }))
    channel.effect(() => channel.connection.fetch.register({ path: API_PATH, methods: ['POST'], requestBody: 'streaming', fetch: handler }))
    })
  })
  const output = { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }
  ctx.tools.register(defineTool({
    name: 'vault_backup',
    description: 'Explicitly upload an encrypted snapshot of configured Harness profiles to WebDAV and verify it. This writes remote storage. No credentials file or sessions are collected.',
    parameters: {}, output,
    async execute(_args, exec) {
      const selected = await preferences()
      const secret = selected.encryption === false ? undefined : passphrase()
      const shared = await settingsAction('backup', { passphrase: secret }, exec.signal)
      if (shared) return shared.backup
      return backup({ home, ...selected, remote: await remote(selected), passphrase: secret, signal: exec.signal })
    },
  }))
  ctx.tools.register(defineTool({
    name: 'vault_list', description: 'List encrypted WebDAV snapshot identifiers. Listing names alone does not authenticate their contents.',
    parameters: {}, output,
    async execute(_args, exec) {
      const shared = await settingsAction('list', {}, exec.signal)
      return shared ?? { snapshots: await (await remote(await preferences())).list(exec.signal) }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'vault_preview', description: 'Download and authenticate a snapshot, then preview restoring it to the current home without writing files. Actual restore requires the offline CLI after Harness is stopped.',
    parameters: { id: { type: 'string', required: true, description: 'Snapshot identifier from vault_list' } }, output,
    async execute(args, exec) {
      const selected = await preferences()
      const secret = selected.encryption === false ? process.env.DSH_VAULT_PASSPHRASE : passphrase()
      const shared = await settingsAction('preview', { id: args.id, passphrase: secret }, exec.signal)
      if (shared) return shared.plan
      await safePath(home)
      return preview(await download({ id: args.id, remote: await remote(selected), passphrase: secret, signal: exec.signal, allowUnencrypted: selected.encryption === false }), { home })
    },
  }))
}
