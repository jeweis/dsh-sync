/** Exercise the installed CLI against disposable HTTPS WebDAV and restore targets. */
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir, realpath, access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = await realpath(process.env.DSH_VAULT_ACCEPTANCE_DIR || '')
const cli = await realpath(process.env.DSH_VAULT_ACCEPTANCE_CLI || '')
if (!root.startsWith('/private/tmp/dsh-vault-rc2-acceptance.') || !cli.startsWith('/private/tmp/dsh-vault-rc2-acceptance.') || !cli.endsWith('/src/cli.mjs')) throw new Error('Use a disposable acceptance directory and its installed CLI')
const pkg = JSON.parse(await readFile(resolve(cli, '../../package.json'), 'utf8'))
assert.ok(['0.2.2', '0.2.3', '0.2.4', '0.2.5', '0.3.0', '0.4.0'].includes(pkg.version))
const { url } = JSON.parse(await readFile(join(root, 'webdav/endpoint.json'), 'utf8'))
assert.equal(new URL(url).hostname, '127.0.0.1')
const { username, password } = JSON.parse(await readFile(join(root, 'webdav/credentials.json'), 'utf8'))
const env = {
  PATH: process.env.PATH, LANG: 'en_US.UTF-8', TMPDIR: '/private/tmp',
  NODE_EXTRA_CA_CERTS: join(root, 'tls/cert.pem'),
  DSH_VAULT_WEBDAV_URL: url, DSH_VAULT_WEBDAV_USERNAME: username,
  DSH_VAULT_WEBDAV_PASSWORD: password, DSH_VAULT_PASSPHRASE: 'disposable-offline-acceptance-passphrase',
}
function run(args, expected = 0) {
  const result = spawnSync(process.execPath, [cli, ...args], { env, cwd: root, encoding: 'utf8', timeout: 30000 })
  assert.equal(result.status, expected, `CLI ${args[0]} returned unexpected status`)
  return expected === 0 ? JSON.parse(result.stdout) : result.stderr
}
const home = join(root, 'home'), target = join(root, 'restore-target'), fresh = join(root, 'fresh-target')
for (const directory of [target, fresh]) {
  try { await access(directory) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
  throw new Error('Restore target already exists; use a fresh acceptance directory')
}
const files = ['package.json', 'cordis.patch.yml']
const originals = await Promise.all(files.map(file => readFile(join(home, 'profiles/vault-data', file), 'utf8')))
await mkdir(join(target, 'profiles/vault-data'), { recursive: true, mode: 0o700 })
const prior = [JSON.stringify({ name: 'previous-profile', private: true, dependencies: {} }) + '\n', '# Before offline restore\n']
for (const [i, file] of files.entries()) await writeFile(join(target, 'profiles/vault-data', file), prior[i], { mode: 0o600 })
const backup = run(['backup', '--home', home, '--profiles', 'vault-data'])
const id = backup.id ?? backup.snapshotId
assert.ok(id)
assert.ok(run(['list']).snapshots.some(item => (typeof item === 'string' ? item : item.id) === id))
const plan = run(['preview', '--home', target, '--id', id])
assert.equal(plan.blocked, false)
assert.deepEqual(plan.files.map(file => file.action), ['replace', 'replace'])
assert.match(run(['restore', '--home', target, '--id', id, '--confirm', plan.token], 1), /--offline/)
assert.match(run(['restore', '--home', target, '--id', id, '--offline', '--confirm', 'invalid-token'], 1), /plan changed|not confirmed/i)
for (const [i, file] of files.entries()) assert.equal(await readFile(join(target, 'profiles/vault-data', file), 'utf8'), prior[i])
const restored = run(['restore', '--home', target, '--id', id, '--offline', '--confirm', plan.token])
assert.equal(restored.status, 'restored')
assert.equal(restored.dependenciesInstalled, false)
for (const [i, file] of files.entries()) assert.equal(await readFile(join(target, 'profiles/vault-data', file), 'utf8'), originals[i])
const journal = await readFile(join(target, `config-vault/rollback-${restored.rollbackId}.vault`), 'utf8')
assert.ok(!journal.includes(prior[1]) && !journal.includes(env.DSH_VAULT_PASSPHRASE))
const recovery = run(['recover', '--home', target, '--rollback', restored.rollbackId])
assert.ok(recovery.files.every(file => !file.conflict))
assert.equal(run(['recover', '--home', target, '--rollback', restored.rollbackId, '--offline', '--confirm', recovery.token]).status, 'rolled-back')
for (const [i, file] of files.entries()) assert.equal(await readFile(join(target, 'profiles/vault-data', file), 'utf8'), prior[i])
await mkdir(fresh, { mode: 0o700 })
const create = run(['preview', '--home', fresh, '--id', id])
assert.ok(create.files.every(file => file.action === 'create'))
const created = run(['restore', '--home', fresh, '--id', id, '--offline', '--confirm', create.token])
for (const [i, file] of files.entries()) assert.equal(await readFile(join(fresh, 'profiles/vault-data', file), 'utf8'), originals[i])
const undoCreate = run(['recover', '--home', fresh, '--rollback', created.rollbackId])
run(['recover', '--home', fresh, '--rollback', created.rollbackId, '--offline', '--confirm', undoCreate.token])
for (const file of files) await assert.rejects(access(join(fresh, 'profiles/vault-data', file)), { code: 'ENOENT' })
for (const directory of [target, fresh]) for (const file of ['active.vault', 'restore.lock']) await assert.rejects(access(join(directory, 'config-vault', file)), { code: 'ENOENT' })
const evidence = { runtime: pkg.engines.dsh, plugin: pkg.version, installedCli: true, httpsBackupAndList: true, offlineRequired: true, confirmationRequired: true, existingFilesRestoredExactly: true, encryptedRollback: true, rollbackRestoredOriginals: true, newHomeRestore: true, newHomeRollback: true, noActiveJournalOrLock: true }
await writeFile(join(root, 'offline-evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 })
console.log(JSON.stringify(evidence, null, 2))
