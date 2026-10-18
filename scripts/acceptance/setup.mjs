/** Initialize new disposable fixtures; refuse to overwrite an existing acceptance setup. */
import { mkdir, writeFile, realpath, access, chmod } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { execFileSync } from 'node:child_process'
const configured = process.env.DSH_VAULT_ACCEPTANCE_DIR
if (!configured) throw new Error('Set DSH_VAULT_ACCEPTANCE_DIR to a fresh mktemp directory')
const root = await realpath(configured)
if (!root.startsWith('/private/tmp/dsh-vault-rc2-acceptance.')) throw new Error('Use a disposable /private/tmp/dsh-vault-rc2-acceptance.* directory')
for (const path of ['tls', 'home']) {
  try { await access(join(root, path)) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
  throw new Error('Fixture already exists; create a fresh acceptance directory')
}
await mkdir(join(root, 'tls'), { mode: 0o700 })
await writeFile(join(root, 'tls/openssl.cnf'), '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1,DNS:localhost\n', { flag: 'wx', mode: 0o600 })
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-config', join(root, 'tls/openssl.cnf'), '-keyout', join(root, 'tls/key.pem'), '-out', join(root, 'tls/cert.pem')], { stdio: 'ignore' })
await chmod(join(root, 'tls/key.pem'), 0o600)
const profile = join(root, 'home/profiles/vault-data')
await mkdir(profile, { recursive: true, mode: 0o700 })
await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'dsh-profile-vault-data', private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
await writeFile(join(profile, 'cordis.patch.yml'), '# Isolated acceptance fixture, before backup\n- id: agent-default-model\n  config:\n    provider: deepseek-official\n    model: deepseek-flash\n', { flag: 'wx', mode: 0o600 })
for (const file of ['npmrc', 'npmrc-global']) await writeFile(join(root, file), '', { flag: 'wx', mode: 0o600 })
console.log('Created isolated TLS certificate and vault-data fixture. System trust settings are unchanged.')
