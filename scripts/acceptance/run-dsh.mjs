/** Launch only the disposable installed runtime; never inherit a user's Harness home. */
import { readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { spawn } from 'node:child_process'
const root = process.env.DSH_VAULT_ACCEPTANCE_DIR
if (!root || !resolve(root).startsWith('/private/tmp/dsh-vault-rc2-acceptance.')) throw new Error('A dedicated temporary acceptance directory is required')
const packageDir = join(root, 'runtime/node_modules/@deepseek-ai/dsh')
const pkg = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'))
if (pkg.version !== '0.2.1-rc.2') throw new Error('Acceptance requires exact DSH 0.2.1-rc.2')
const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin.dsh
const env = {
  PATH: process.env.PATH, LANG: 'en_US.UTF-8', TMPDIR: '/private/tmp',
  DSH_HOME: join(root, 'home'), DSH_AGENTS_HOME: join(root, 'agents'), DSH_TELEMETRY_DISABLED: '1',
  NODE_EXTRA_CA_CERTS: join(root, 'tls/cert.pem'),
  COREPACK_HOME: join(root, 'corepack'), PNPM_HOME: join(root, 'pnpm'),
  XDG_CACHE_HOME: join(root, 'cache'), XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'),
  npm_config_cache: join(root, 'npm-cache'), npm_config_store_dir: join(root, 'pnpm-store'),
  npm_config_userconfig: join(root, 'npmrc'), npm_config_globalconfig: join(root, 'npmrc-global'),
}
const child = spawn(process.execPath, [resolve(packageDir, bin), ...process.argv.slice(2)], { cwd: root, env, stdio: 'inherit' })
child.on('error', error => { console.error(error.message); process.exitCode = 1 })
child.on('close', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0) })
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { child.kill(signal) })
