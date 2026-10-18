import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { collect, RUNTIME } from '../src/snapshot.mjs'
import { preview } from '../src/restore.mjs'
import { home } from './helpers.mjs'

const require = createRequire(import.meta.url)

test('manifest, runtime defaults and installed host test packages agree on rc.2', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.engines.dsh, '0.2.1-rc.2')
  assert.equal(pkg.peerDependencies['@deepseek-ai/dsh-tools'], '0.2.1-rc.2')
  assert.equal(pkg.peerDependencies['@deepseek-ai/cordis'], '~4.0.5')
  assert.equal(RUNTIME, '0.2.1-rc.2')
  for (const name of ['@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-connection', '@deepseek-ai/cordis']) {
    const path = join(dirname(require.resolve(name)), '../package.json')
    const installed = JSON.parse(await readFile(path, 'utf8'))
    assert.equal(installed.version, name === '@deepseek-ai/cordis' ? '4.0.5' : '0.2.1-rc.2', name)
  }
})

test('rc.2 snapshots use the correct runtime and alpha snapshots retain the mismatch guard', async t => {
  const source = await home(t, true), target = await home(t)
  const snapshot = await collect({ home: source })
  assert.equal(snapshot.runtimeVersion, '0.2.1-rc.2')
  assert.equal((await preview(snapshot, { home: target })).blocked, false)
  const previous = await collect({ home: source, runtimeVersion: '0.2.1-alpha.5' })
  const plan = await preview(previous, { home: target })
  assert.equal(plan.blocked, true)
  assert.ok(plan.warnings.some(warning => warning.code === 'runtime-version'))
})
