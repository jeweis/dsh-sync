/** Collect only explicit configuration files; validate decrypted data before use. */
import { randomUUID } from 'node:crypto'
import { parseDocument, isMap, isSeq, isScalar } from 'yaml'
import { hash, MAX_BYTES } from './crypto.mjs'
import { managedPath, PROFILE, readManaged, safePath } from './files.mjs'

export const RUNTIME = '0.2.1-rc.2'
const ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[a-f0-9-]{36}$/
export function validateId(id) { if (typeof id !== 'string' || !ID.test(id)) throw new Error('Invalid snapshot id'); return id }
export function newId() { return `${new Date().toISOString().replaceAll(':', '-').replace('.', '-')}_${randomUUID()}` }
export function digest(content) { return content === null ? null : hash(content) }

function inspect(path, content) {
  const warnings = []
  if (path.endsWith('/package.json')) {
    const value = JSON.parse(content)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid profile manifest')
    if (value.scripts || value.pnpm || value.overrides) warnings.push({ path, code: 'install-policy', message: 'Manifest contains scripts or package-manager policy; review before installing dependencies' })
    if (!Array.isArray(value.dsh?.profile?.bundles) || !value.dsh.profile.bundles.every(x => typeof x === 'string')) throw new Error('Profile manifest must declare dsh.profile.bundles')
    if (value.dependencies !== undefined && (!value.dependencies || typeof value.dependencies !== 'object' || Array.isArray(value.dependencies))) throw new Error('Invalid profile dependencies')
    for (const [name, spec] of Object.entries(value.dependencies ?? {})) {
      if (typeof spec !== 'string') throw new Error('Invalid dependency spec')
      if (/^(?:link:|file:|workspace:|\/|[A-Za-z]:|\.\.?\/)/.test(spec)) warnings.push({ path, code: 'local-dependency', message: `Local dependency requires manual migration: ${name}` })
      else if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(spec)) warnings.push({ path, code: 'unpinned-dependency', message: `Dependency is not an exact registry version: ${name}` })
    }
  } else {
    const doc = parseDocument(content, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }], uniqueKeys: true })
    if (doc.errors.length) throw new Error(`Invalid YAML: ${path}`)
    const walk = node => {
      if (!node) return
      if (node.tag === 'tag:yaml.org,2002:js') warnings.push({ path, code: 'executable-config', message: 'Configuration contains !!js; restore preserves executable expressions without evaluating them' })
      if (isScalar(node) && typeof node.value === 'string' && /^(?:\/|~[/\\]|[a-zA-Z]:[\\/])/.test(node.value)) warnings.push({ path, code: 'device-path', message: 'Configuration contains a machine-specific path; review on the destination device' })
      if (isMap(node)) for (const pair of node.items) { walk(pair.key); walk(pair.value) }
      if (isSeq(node)) for (const item of node.items) walk(item)
    }
    walk(doc.contents)
    if (doc.warnings.length) warnings.push({ path, code: 'yaml-tag', message: 'Unknown YAML tags require manual review' })
  }
  return warnings
}

/** Reject paths outside the allowlist, duplicates, tampering and future formats. */
export function validateSnapshot(snapshot) {
  if (!snapshot || snapshot.format !== 'dsh-config-vault-snapshot' || snapshot.version !== 1) throw new Error('Unsupported snapshot format')
  validateId(snapshot.id)
  if (typeof snapshot.runtimeVersion !== 'string' || typeof snapshot.createdAt !== 'string' || !Number.isFinite(Date.parse(snapshot.createdAt))) throw new Error('Invalid snapshot metadata')
  if (!Array.isArray(snapshot.files) || snapshot.files.length === 0 || snapshot.files.length > 128) throw new Error('Invalid snapshot file count')
  const seen = new Set(); let size = 0
  for (const file of snapshot.files) {
    if (!file || !managedPath(file.path) || seen.has(file.path) || typeof file.content !== 'string' || Buffer.byteLength(file.content) > 2 * 1024 * 1024 || file.sha256 !== hash(file.content)) throw new Error('Invalid snapshot file or hash')
    seen.add(file.path); size += Buffer.byteLength(file.content)
    inspect(file.path, file.content)
  }
  if (size > MAX_BYTES) throw new Error('Snapshot exceeds size limit')
  for (const file of snapshot.files) if (file.path.startsWith('profiles/') && !seen.has(`profiles/${file.path.split('/')[1]}/package.json`)) throw new Error('Profile patch or lock has no manifest')
  return snapshot
}

export function warningsFor(snapshot, runtimeVersion) {
  const warnings = snapshot.files.flatMap(file => inspect(file.path, file.content))
  if (snapshot.runtimeVersion !== runtimeVersion) warnings.push({ code: 'runtime-version', message: `Snapshot targets Harness ${snapshot.runtimeVersion}; destination declares ${runtimeVersion}` })
  return warnings
}

/** Bounded content scan for polling. No parsing or retained configuration text. */
export async function observe(options) {
  const readings = await readSelection(options)
  return { runtimeVersion: options.runtimeVersion ?? RUNTIME, files: readings.filter(file => file.content !== null).map(file => ({ path: file.path, sha256: hash(file.content) })) }
}

async function readSelection({ home, profiles = ['web'], includeHomePatch = false }) {
  await safePath(home)
  if (!Array.isArray(profiles) || profiles.length === 0 || profiles.length > 40 || new Set(profiles).size !== profiles.length || !profiles.every(name => typeof name === 'string' && PROFILE.test(name))) throw new Error('Invalid profile selection')
  const paths = profiles.flatMap(name => [`profiles/${name}/package.json`, `profiles/${name}/cordis.patch.yml`, `profiles/${name}/pnpm-lock.yaml`])
  if (includeHomePatch) paths.push('cordis.patch.yml')
  const readings = []; let size = 0
  for (const path of paths) {
    const content = await readManaged(home, path)
    if (content === null && path.endsWith('/package.json')) throw new Error(`Selected profile does not exist: ${path.split('/')[1]}`)
    size += content === null ? 0 : Buffer.byteLength(content)
    if (size > MAX_BYTES) throw new Error('Snapshot exceeds size limit')
    readings.push({ path, content })
  }
  return readings
}

/** Read the selected files twice so an observed concurrent edit aborts collection. */
export async function collect(options) {
  const { home, runtimeVersion = RUNTIME } = options
  const readings = await readSelection(options)
  for (const file of readings) if (await readManaged(home, file.path) !== file.content) throw new Error('Configuration changed during backup; retry when configuration is idle')
  const snapshot = { format: 'dsh-config-vault-snapshot', version: 1, id: newId(), createdAt: new Date().toISOString(), runtimeVersion, files: readings.filter(file => file.content !== null).map(file => ({ ...file, sha256: hash(file.content) })) }
  return validateSnapshot(snapshot)
}
