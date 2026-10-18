/** New-device restore preparation. Only encrypted staging is online; file restore stays offline. */
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { validateSnapshot, digest, RUNTIME } from './snapshot.mjs'
import { readManaged, writeManaged, PROFILE } from './files.mjs'
import { preview, restore, restoreLock } from './restore.mjs'
import { seal, unseal } from './crypto.mjs'

const PACKAGE = /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/i
const LAUNCH_BUNDLES = new Set(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-acp-app', '@deepseek-ai/dsh-headless', '@deepseek-ai/dsh-sdk-app'])
// Registry selectors only. Git URLs, aliases, local paths and tags need an explicit installation in Harness.
const versionPart = '(?:[0-9]+|[xX*])(?:\\.(?:[0-9]+|[xX*])){0,2}(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?'
const comparator = '(?:[~^]|[<>]=?|=)?\\s*v?' + versionPart
const registryRange = new RegExp('^' + comparator + '(?:(?:\\s*\\|\\|\\s*|\\s+-\\s+|\\s+)' + comparator + ')*$')
export const registryVersion = value => typeof value === 'string' && value.length <= 128 && registryRange.test(value)

const requestPath = id => { if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('recovery-invalid'); return `config-vault/restore-request-${id}.vault` }
function manifest(snapshot, profile) {
  if (!PROFILE.test(profile)) throw new Error('recovery-invalid')
  const file = snapshot.files.find(x => x.path === `profiles/${profile}/package.json`)
  if (!file) throw new Error('recovery-invalid')
  return JSON.parse(file.content)
}
export function sourceProfiles(snapshot) {
  validateSnapshot(snapshot)
  return snapshot.files.filter(f => /^profiles\/[^/]+\/package.json$/.test(f.path)).map(f => f.path.split('/')[1])
}

/** Merge only the reviewed profile; retain this device's extra bundles and management plugin. */
export async function recoveryPreview(snapshot, { home, sourceProfile, targetProfile, useInstalled = false, runtimeVersion = RUNTIME }) {
  validateSnapshot(snapshot)
  if (!PROFILE.test(targetProfile) || typeof useInstalled !== 'boolean') throw new Error('recovery-invalid')
  const source = manifest(snapshot, sourceProfile)
  if (!source.dsh.profile.bundles.every(name => PACKAGE.test(name))) throw new Error('recovery-invalid')
  const targetPath = `profiles/${targetProfile}/package.json`, targetRaw = await readManaged(home, targetPath)
  const target = targetRaw === null ? {} : JSON.parse(targetRaw)
  const packages = [], dependencies = { ...target.dependencies }, blockers = []
  const sourceDependencies = source.dependencies ?? {}
  for (const [name, spec] of Object.entries(sourceDependencies)) {
    if (!PACKAGE.test(name)) throw new Error('recovery-invalid')
    if (targetRaw !== null && LAUNCH_BUNDLES.has(name)) continue
    const installed = target.dependencies?.[name]
    const portable = registryVersion(spec), installedPortable = registryVersion(installed)
    const keep = useInstalled && installed !== undefined
    dependencies[name] = keep ? installed : spec
    const state = keep ? 'kept-installed' : !portable ? 'needs-install' : installed === spec ? 'present' : 'install'
    packages.push({ name, state, ...(portable ? { requested: spec } : {}), ...(installedPortable ? { installed } : {}) })
    if (!portable && !keep) blockers.push({ code: 'recovery-plugin', dependency: name, path: targetPath })
    else if (state === 'install') blockers.push({ code: 'recovery-install', dependency: name, path: targetPath })
  }
  // Never import package scripts, pnpm policy, arbitrary manifest keys or the source machine's lockfile.
  const next = { ...target, name: target.name ?? `dsh-profile-${targetProfile}`, private: true, dependencies,
    dsh: { ...target.dsh, profile: { ...target.dsh?.profile, bundles: [...new Set([...(target.dsh?.profile?.bundles ?? []), ...source.dsh.profile.bundles.filter(name => targetRaw === null || !LAUNCH_BUNDLES.has(name))])] } } }
  const files = [{ path: targetPath, content: JSON.stringify(next, null, 2) + '\n' }]
  const patch = snapshot.files.find(x => x.path === `profiles/${sourceProfile}/cordis.patch.yml`)
  if (patch) files.push({ path: `profiles/${targetProfile}/cordis.patch.yml`, content: patch.content })
  const selected = { ...snapshot, files: files.map(file => ({ ...file, sha256: digest(file.content) })) }
  const plan = await preview(selected, { home, runtimeVersion, preserveLocal: true })
  // Existing destination-local dependencies are not imported from another machine.
  // Their exact declarations are unchanged; other local dependencies remain blocking.
  plan.warnings = plan.warnings.filter(w => w.code !== 'local-dependency' || !blockers.some(b => b.code === 'recovery-plugin' && b.dependency === w.dependency && b.path === w.path))
  plan.warnings.push(...blockers)
  plan.blocked = plan.warnings.some(w => ['runtime-version', 'local-dependency', 'recovery-plugin', 'recovery-install'].includes(w.code))
  const { hash } = await import('./crypto.mjs')
  const selection = { sourceProfile, targetProfile, useInstalled }
  // Bind UI staging to source bytes, destination files, chosen options and truthful diagnostics.
  const token = hash(JSON.stringify({ base: plan.token, selection, source: snapshot.files.map(f => f.sha256), warnings: plan.warnings }))
  return { snapshot: selected, coreToken: plan.token, plan: { ...plan, token, selection, profiles: sourceProfiles(snapshot), packages, runtime: { source: snapshot.runtimeVersion, destination: runtimeVersion },
    omitted: ['source-lockfile', 'source-install-policy', 'source-launch-bundles', ...(snapshot.files.some(f=>f.path==='cordis.patch.yml') ? ['home-patch'] : [])] } }
}

export async function stageRecovery(snapshot, options) {
  const { plan } = await recoveryPreview(snapshot, options)
  if (plan.blocked || options.token !== plan.token) throw new Error('recovery-stale')
  const id = randomUUID(), request = { format: 'dsh-restore-request', version: 1, home: resolve(options.home), snapshot, selection: plan.selection, reviewedToken: plan.token, runtimeVersion: options.runtimeVersion ?? RUNTIME }
  const release = await restoreLock(options.home)
  try { await writeManaged(options.home, requestPath(id), await seal(request, options.passphrase)) }
  finally { await release() }
  return { requestId: id, home: resolve(options.home), node: process.execPath, cli: fileURLToPath(new URL('./cli.mjs', import.meta.url)) }
}

/** No remote password, server access or copied token is needed once staged. */
export async function finishRecovery({ home, requestId, passphrase, offline = false, confirm = false, token }) {
  const raw = await readManaged(home, requestPath(requestId))
  if (raw === null) throw new Error('recovery-missing')
  let request
  try { request = await unseal(Buffer.from(raw), passphrase) } catch { throw new Error('recovery-passphrase') }
  if (request.format !== 'dsh-restore-request' || request.version !== 1 || request.home !== resolve(home) || request.runtimeVersion !== RUNTIME) throw new Error('recovery-invalid')
  const { snapshot, plan, coreToken } = await recoveryPreview(request.snapshot, { home, ...request.selection, runtimeVersion: request.runtimeVersion })
  if (plan.token !== request.reviewedToken || plan.blocked || confirm && token !== plan.token) throw new Error('recovery-stale')
  if (!confirm) return { plan }
  if (!offline) throw new Error('recovery-offline')
  // Existing core restore remains authoritative for preconditions and encrypted rollback.
  // Its local-dependency check still protects raw snapshot restoration. Here, only
  // destination-local entries proven unchanged above may be allowed.
  const result = await restore(snapshot, { home, passphrase, offline, token: coreToken, preserveLocal: true })
  // Keep the encrypted request for an interrupted operation. Success consumes it.
  await writeManaged(home, requestPath(requestId), null)
  return result
}
