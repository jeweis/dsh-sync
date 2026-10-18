import test from 'node:test'
import assert from 'node:assert/strict'
import { backup, download, preview, restore, recover } from '../src/engine.mjs'
import { home, dav, passphrase, manifest } from './helpers.mjs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

test('plaintext is opt-in, validates paths/hashes, refuses silent encryption downgrade and retains offline encrypted rollback', async t => {
  const source = await home(t, true), target = await home(t), fixture = await dav(t)
  const result = await backup({ home: source, remote: fixture.remote, encryption: false })
  assert.equal(result.encryption, false)
  const bytes = await fixture.remote.get(result.id)
  assert.ok(bytes.includes(Buffer.from('test-model')))
  await assert.rejects(download({ id: result.id, remote: fixture.remote, passphrase }), /validate/)
  const snapshot = await download({ id: result.id, remote: fixture.remote, allowUnencrypted: true })
  const plan = await preview(snapshot, { home: target })
  await assert.rejects(restore(snapshot, { home: target, token: plan.token, passphrase }), /Stop all Harness/)
  const restored = await restore(snapshot, { home: target, token: plan.token, passphrase, offline: true })
  assert.equal(await readFile(join(target, 'profiles/web/package.json'), 'utf8'), manifest)
  assert.equal(JSON.parse(await readFile(join(target, `config-vault/rollback-${restored.rollbackId}.vault`), 'utf8')).format, 'dsh-config-vault')
  const undo = await recover({ home: target, passphrase, rollbackId: restored.rollbackId })
  await recover({ home: target, passphrase, rollbackId: restored.rollbackId, token: undo.token, offline: true })
  const path = fixture.remote.object(result.id).pathname
  for (const change of [value => { value.files[0].path = '../escape' }, value => { value.files[0].sha256 = 'bad' }, value => { value.version = 999 }]) {
    const value = JSON.parse(bytes); change(value); fixture.objects.set(path, Buffer.from(JSON.stringify(value)))
    await assert.rejects(download({ id: result.id, remote: fixture.remote, allowUnencrypted: true }), /validate/)
  }
  const encrypted = await backup({ home: source, remote: fixture.remote, passphrase })
  assert.equal(encrypted.encryption, true)
  await assert.rejects(download({ id: encrypted.id, remote: fixture.remote, allowUnencrypted: true }), /validate/)
  assert.equal((await download({ id: encrypted.id, remote: fixture.remote, allowUnencrypted: true, passphrase })).id, encrypted.id)
})

test('CLI explicitly opts into plaintext without a snapshot key; confirmed restore still requires encrypted-journal key and offline token', async t => {
  const source = await home(t, true), target = await home(t), fixture = await dav(t)
  const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url))
  const env = { PATH: process.env.PATH, DSH_VAULT_WEBDAV_URL: fixture.options.url, DSH_VAULT_WEBDAV_USERNAME: 'test-user', DSH_VAULT_WEBDAV_PASSWORD: 'test-password' }
  const run = async args => JSON.parse((await promisify(execFile)(process.execPath, [cli, ...args], { env, timeout: 15000 })).stdout)
  const result = await run(['backup', '--home', source, '--unencrypted'])
  assert.equal(result.encryption, false)
  const plan = await run(['preview', '--home', target, '--id', result.id, '--unencrypted'])
  assert.equal(plan.blocked, false)
  const args = ['restore', '--home', target, '--id', result.id, '--unencrypted', '--confirm', plan.token, '--offline']
  await assert.rejects(run(args), /DSH_VAULT_PASSPHRASE/)
  env.DSH_VAULT_PASSPHRASE = passphrase
  assert.equal((await run(args)).status, 'restored')
})
