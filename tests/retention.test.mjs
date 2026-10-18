import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { backup } from '../src/engine.mjs'
import { collect } from '../src/snapshot.mjs'
import { retentionStatus } from '../src/retention.mjs'
import { AutoBackup } from '../src/auto-backup.mjs'
import { WebDAV } from '../src/webdav.mjs'
import { hash } from '../src/crypto.mjs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { home, dav } from './helpers.mjs'

test('default retention keeps 30 owned snapshots and deletes only after the new download verifies', async t => {
  const source = await home(t, true), fixture = await dav(t), ids = []
  let result
  for (let i = 0; i < 32; i++) { result = await backup({ home: source, remote: fixture.remote, encryption: false }); ids.push(result.id) }
  assert.equal(result.verified, true)
  assert.equal(result.retention.keepLast, 30)
  assert.equal(result.retention.status, 'ok')
  assert.equal(fixture.objects.size, 30)
  assert.deepEqual(await fixture.remote.list(), ids.slice(2).reverse())
  const deletes = fixture.requests.filter(item => item.method === 'DELETE')
  assert.equal(deletes.length, 2)
  assert.ok(deletes.every(item => /^".+"$/.test(item.ifMatch)))
  const put = fixture.requests.findLastIndex(item => item.method === 'PUT')
  const currentGet = fixture.requests.findIndex((item, index) => index > put && item.method === 'GET' && item.path === fixture.remote.object(result.id).pathname)
  const deletion = fixture.requests.findIndex((item, index) => index > put && item.method === 'DELETE')
  assert.ok(currentGet > put && deletion > currentGet)
})

test('other devices, untracked legacy snapshots and forged remote device claims are never deletion candidates', async t => {
  const a = await home(t, true), b = await home(t, true), fixture = await dav(t)
  const first = await backup({ home: a, remote: fixture.remote, encryption: false, keepLast: 1 })
  const other = await backup({ home: b, remote: fixture.remote, encryption: false, keepLast: 1 })
  const claimed = await collect({ home: b })
  claimed.deviceId = JSON.parse(await readFile(join(a, 'config-vault/retention-device.json'), 'utf8')).id
  await fixture.remote.put(claimed.id, Buffer.from(JSON.stringify(claimed)))
  const current = await backup({ home: a, remote: fixture.remote, encryption: false, keepLast: 1 })
  assert.equal(current.retention.deleted, 1)
  assert.deepEqual(new Set(await fixture.remote.list()), new Set([current.id, other.id, claimed.id]))
  assert.deepEqual(fixture.requests.filter(item => item.method === 'DELETE').map(item => item.path), [fixture.remote.object(first.id).pathname])
  assert.notEqual((await retentionStatus(a, fixture.remote)).deviceId, (await retentionStatus(b, fixture.remote)).deviceId)
})

test('failed verification cannot start cleanup and invalid retention values cannot upload', async t => {
  const source = await home(t, true), fixture = await dav(t)
  const first = await backup({ home: source, remote: fixture.remote, encryption: false, keepLast: 1 })
  fixture.control.corrupt = true
  await assert.rejects(backup({ home: source, remote: fixture.remote, encryption: false, keepLast: 1 }))
  assert.equal(fixture.requests.filter(item => item.method === 'DELETE').length, 0)
  assert.ok(fixture.objects.has(fixture.remote.object(first.id).pathname))
  const count = fixture.requests.length
  await assert.rejects(backup({ home: source, remote: fixture.remote, encryption: false, keepLast: 0 }), /keepLast/)
  assert.equal(fixture.requests.length, count)
})

test('cleanup failures do not fail a verified backup, and the next successful backup retries old receipts', async t => {
  const source = await home(t, true), fixture = await dav(t)
  await backup({ home: source, remote: fixture.remote, encryption: false, keepLast: 1 })
  fixture.control.methodStatus.DELETE = 403
  const blocked = await backup({ home: source, remote: fixture.remote, encryption: false, keepLast: 1 })
  assert.equal(blocked.verified, true)
  assert.equal(blocked.retention.status, 'warning')
  assert.equal(blocked.retention.httpStatus, 403)
  assert.equal(fixture.objects.size, 2)
  assert.ok(!JSON.stringify(blocked).includes('private-server'))
  delete fixture.control.methodStatus.DELETE
  const retried = await backup({ home: source, remote: fixture.remote, encryption: false, keepLast: 1 })
  assert.equal(retried.retention.deleted, 2)
  assert.equal(retried.retention.pending, 0)
  assert.equal(fixture.objects.size, 1)
})

test('modified objects, weak or missing ETags and replacement races are retained safely', async t => {
  const source = await home(t, true), fixture = await dav(t)
  const first = await backup({ home: source, remote: fixture.remote, encryption: false, keepLast: 1 })
  const firstPath = fixture.remote.object(first.id).pathname
  const original = fixture.objects.get(firstPath)
  fixture.objects.set(firstPath, Buffer.from('another writer replaced this object'))
  const changed = await backup({ home: source, remote: fixture.remote, encryption: false, keepLast: 1 })
  assert.equal(changed.retention.reason, 'changed')
  assert.ok(fixture.objects.has(firstPath))
  fixture.objects.set(firstPath, original)
  fixture.control.noEtag = true
  assert.equal((await backup({ home: source, remote: fixture.remote, encryption: false, keepLast: 1 })).retention.reason, 'no-strong-etag')
  fixture.control.noEtag = false; fixture.control.weakEtag = true
  assert.equal((await backup({ home: source, remote: fixture.remote, encryption: false, keepLast: 1 })).retention.reason, 'no-strong-etag')
  fixture.control.weakEtag = false
  fixture.control.beforeDelete = (path, objects) => objects.set(path, Buffer.from('replaced between GET and DELETE'))
  const race = await backup({ home: source, remote: fixture.remote, encryption: false, keepLast: 1 })
  assert.equal(race.retention.httpStatus, 412)
  assert.equal(race.verified, true)
  assert.ok(fixture.objects.has(firstPath))
})

test('ownership is scoped to the normalized remote directory and account; receipts survive restart but are excluded from snapshots', async t => {
  const source = await home(t, true), fixture = await dav(t)
  const a = await backup({ home: source, remote: fixture.remote, encryption: false, keepLast: 1 })
  const elsewhere = new WebDAV({ ...fixture.options, url: fixture.options.url + 'different/' })
  await backup({ home: source, remote: elsewhere, encryption: false, keepLast: 1 })
  await backup({ home: source, remote: elsewhere, encryption: false, keepLast: 1 })
  assert.ok(fixture.objects.has(fixture.remote.object(a.id).pathname))
  const restarted = new WebDAV(fixture.options)
  assert.equal((await backup({ home: source, remote: restarted, encryption: false, keepLast: 1 })).retention.deleted, 1)
  assert.ok((await collect({ home: source })).files.every(item => item.path.startsWith('profiles/')))
  const raw = await readFile(join(source, 'config-vault/retention-device.json'), 'utf8')
  assert.ok(!raw.includes('test-password') && !raw.includes('http://'))
})

test('automatic backups apply the same policy and dedupe still works after cleanup', async t => {
  const source = await home(t, true), fixture = await dav(t)
  const config = { url: fixture.options.url, username: 'test-user', profiles: ['web'], includeHomePatch: false, encryption: false, keepLast: 2, autoBackup: { enabled: true, debounceMs: 1000, minIntervalMs: 60000 } }
  const worker = new AutoBackup({ home: source, connection: async () => fixture.remote })
  for (let i = 0; i < 4; i++) {
    await writeFile(join(source, 'profiles/web/cordis.patch.yml'), `# version ${i}\n`)
    const now = 1800000000000 + i * 61000
    await worker.step({ config, now }); await worker.step({ config, now: now + 1000 })
  }
  assert.equal(fixture.objects.size, 2)
  assert.equal(worker.status.phase, 'watching')
  const requests = fixture.requests.length
  await worker.step({ config, now: 1800000999999 })
  assert.equal(fixture.requests.length, requests)
})

test('encrypted history can be retained across passphrase changes without decrypting old backups', async t => {
  const source = await home(t, true), fixture = await dav(t)
  const first = await backup({ home: source, remote: fixture.remote, passphrase: 'old-acceptance-passphrase', keepLast: 1 })
  const second = await backup({ home: source, remote: fixture.remote, passphrase: 'new-acceptance-passphrase', keepLast: 1 })
  assert.equal(second.retention.deleted, 1)
  assert.ok(!fixture.objects.has(fixture.remote.object(first.id).pathname))
  assert.equal(fixture.objects.size, 1)
})

test('corrupt local ownership records fail closed and do not reflect raw fields', async t => {
  const source = await home(t, true), fixture = await dav(t)
  const first = await backup({ home: source, remote: fixture.remote, encryption: false, keepLast: 1 })
  const device = JSON.parse(await readFile(join(source, 'config-vault/retention-device.json'), 'utf8')).id
  const dir = join(source, 'config-vault/retention', hash(fixture.remote.retentionScope), device)
  await writeFile(join(dir, `${first.id}.json`), '{"private":"must-not-leak"}')
  const result = await backup({ home: source, remote: fixture.remote, encryption: false, keepLast: 1 })
  assert.equal(result.verified, true)
  assert.equal(result.retention.reason, 'local-state')
  assert.equal(fixture.requests.filter(item => item.method === 'DELETE').length, 0)
  assert.ok(!JSON.stringify(result).includes('must-not-leak'))
  await writeFile(join(dir, 'status.json'), JSON.stringify({ status: 'ok', keepLast: 1, deleted: 0, pending: 0, message: 'must-not-leak' }))
  assert.ok(!JSON.stringify(await retentionStatus(source, fixture.remote)).includes('must-not-leak'))
})

test('CLI accepts a retention override and rejects invalid policy before any upload', async t => {
  const source = await home(t, true), fixture = await dav(t)
  const env = { PATH: process.env.PATH, DSH_VAULT_WEBDAV_URL: fixture.options.url, DSH_VAULT_WEBDAV_USERNAME: 'test-user', DSH_VAULT_WEBDAV_PASSWORD: 'test-password' }
  const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url))
  const run = async args => JSON.parse((await promisify(execFile)(process.execPath, [cli, ...args], { env, timeout: 15000 })).stdout)
  const args = ['backup', '--home', source, '--unencrypted', '--keep-last', '1']
  await run(args)
  assert.equal((await run(args)).retention.deleted, 1)
  assert.equal(fixture.objects.size, 1)
  const count = fixture.requests.length
  for (const invalid of ['0', '-1', '1.5', '10001']) await assert.rejects(run([...args.slice(0, -1), invalid]), /keep-last/)
  assert.equal(fixture.requests.length, count)
})
