import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, access, open, stat, utimes, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { AutoBackup } from '../src/auto-backup.mjs'
import { VaultSettingsService } from '../src/ui-service.mjs'
import { loadPreferences, savePreferences } from '../src/settings.mjs'
import { download } from '../src/engine.mjs'
import { home, dav, passphrase } from './helpers.mjs'

async function setup(t, encryption = true) {
  const target = await home(t, true), fixture = await dav(t)
  const config = { url: fixture.options.url, username: 'test-user', profiles: ['web'], includeHomePatch: false, timeoutMs: 30000, encryption, autoBackup: { enabled: true, debounceMs: 1000, minIntervalMs: 60000 } }
  const auto = new AutoBackup({ home: target, connection: async () => fixture.remote })
  const step = now => auto.step({ config, passphrase, now, signal: new AbortController().signal })
  return { target, fixture, config, auto, step }
}
const origin = 1800000000000

test('unchanged polling performs no disk sync or remote requests, and detects same-size timestamp-preserving replacement', async t => {
  const { target, fixture, auto, step } = await setup(t, false)
  await step(origin); await step(origin + 1000)
  const requestCount = fixture.requests.length
  const probe = await open(join(target, 'profiles/web/cordis.patch.yml'), 'r')
  const proto = Object.getPrototypeOf(probe), originalSync = proto.sync
  await probe.close()
  let syncs = 0
  proto.sync = async function(...args) { syncs++; return originalSync.apply(this, args) }
  try { await step(origin + 5000); await step(origin + 10000) }
  finally { proto.sync = originalSync }
  assert.equal(syncs, 0)
  assert.equal(fixture.requests.length, requestCount)
  assert.equal(auto.status.phase, 'watching')
  await assert.rejects(access(join(target, 'config-vault/auto.lock')), { code: 'ENOENT' })
  const path = join(target, 'profiles/web/cordis.patch.yml'), before = await stat(path)
  const content = (await readFile(path, 'utf8')).replace('test-model', 'next-model')
  await writeFile(path + '.tmp', content); await utimes(path + '.tmp', before.atime, before.mtime); await rename(path + '.tmp', path)
  await step(origin + 60000)
  assert.equal(auto.status.phase, 'pending')
  await step(origin + 61000)
  const snapshot = await download({ id: auto.status.snapshotId, remote: fixture.remote, allowUnencrypted: true })
  assert.equal(snapshot.files.find(file => file.path.endsWith('yml')).content, content)
})

test('lightweight observation cannot upload invalid YAML; full validation still runs when due', async t => {
  const { target, fixture, auto, step } = await setup(t, false)
  await writeFile(join(target, 'profiles/web/cordis.patch.yml'), 'invalid: [\n')
  await step(origin)
  assert.equal(auto.status.phase, 'pending')
  await step(origin + 1000)
  assert.equal(auto.status.phase, 'error')
  assert.equal(fixture.requests.length, 0)
  await assert.rejects(access(join(target, 'config-vault/auto.lock')), { code: 'ENOENT' })
})

test('an edit between observation and upload lock restarts the quiet period with fresh content', async t => {
  const { target, fixture, auto, step } = await setup(t, false)
  await step(origin)
  const path = join(target, 'profiles/web/cordis.patch.yml'), probe = await open(path, 'r')
  const proto = Object.getPrototypeOf(probe), originalWrite = proto.writeFile
  await probe.close()
  let edited = false
  proto.writeFile = async function(data, ...args) {
    const result = await originalWrite.call(this, data, ...args)
    if (!edited && typeof data === 'string' && data.startsWith('{"pid":')) {
      edited = true
      await writeFile(path, '# changed after observation\n')
    }
    return result
  }
  try { await step(origin + 1000) }
  finally { proto.writeFile = originalWrite }
  assert.equal(edited, true)
  assert.equal(auto.status.phase, 'pending')
  assert.equal(fixture.requests.length, 0)
  await step(origin + 2000)
  const snapshot = await download({ id: auto.status.snapshotId, remote: fixture.remote, allowUnencrypted: true })
  assert.equal(snapshot.files.find(file => file.path.endsWith('yml')).content, '# changed after observation\n')
})

test('automatic backup coalesces bursts, fingerprints content and backs up the latest change after cooldown', async t => {
  const { target, fixture, config, auto, step } = await setup(t)
  await step(origin)
  await writeFile(join(target, 'profiles/web/cordis.patch.yml'), '# edit one\n')
  await step(origin + 500)
  await writeFile(join(target, 'profiles/web/cordis.patch.yml'), '# edit two\n')
  await step(origin + 900)
  await step(origin + 1500)
  assert.equal(fixture.objects.size, 0)
  await step(origin + 1900)
  assert.equal(fixture.objects.size, 1)
  assert.equal(auto.status.phase, 'watching')
  await writeFile(join(target, '.credentials.yaml'), 'unwatched-secret')
  await writeFile(join(target, 'config-vault/unwatched.json'), '{}')
  await step(origin + 2000)
  assert.equal(fixture.objects.size, 1)
  const snapshot = await download({ id: auto.status.snapshotId, remote: fixture.remote, passphrase })
  assert.equal(snapshot.files.find(file => file.path.endsWith('yml')).content, '# edit two\n')
  await writeFile(join(target, 'profiles/web/cordis.patch.yml'), '# latest during cooldown\n')
  await step(origin + 3000); await step(origin + 5000)
  assert.equal(fixture.objects.size, 1)
  await step(origin + 61900)
  assert.equal(fixture.objects.size, 2)
  const restarted = new AutoBackup({ home: target, connection: async () => fixture.remote })
  await restarted.step({ config, passphrase, now: origin + 999999 })
  assert.equal(fixture.objects.size, 2)
  assert.equal(restarted.status.phase, 'watching')
  const state = await readFile(join(target, 'config-vault/auto-state.json'), 'utf8')
  assert.ok(!state.includes(passphrase) && !state.includes('latest during cooldown'))
})

test('disabled and locked states do not contact WebDAV; plaintext auto backup needs no passphrase', async t => {
  const { fixture, config, auto } = await setup(t, false)
  config.autoBackup.enabled = false
  await auto.step({ config, now: origin })
  assert.equal(auto.status.phase, 'disabled')
  config.autoBackup.enabled = true; config.encryption = true
  await auto.step({ config, now: origin })
  assert.equal(auto.status.phase, 'locked')
  assert.equal(fixture.requests.length, 0)
  config.encryption = false
  await auto.step({ config, now: origin }); await auto.step({ config, now: origin + 1000 })
  assert.equal(fixture.objects.size, 1)
  const plain = JSON.parse([...fixture.objects.values()][0])
  assert.equal(plain.format, 'dsh-config-vault-snapshot')
})

test('lost upload verification pauses across restarts until explicitly resumed; certain failures back off', async t => {
  const { target, fixture, config, auto, step } = await setup(t)
  fixture.control.corrupt = true
  await step(origin); await step(origin + 1000)
  assert.equal(auto.status.phase, 'uncertain')
  assert.equal(fixture.objects.size, 1)
  await step(origin + 999999)
  const restarted = new AutoBackup({ home: target, connection: async () => fixture.remote })
  await restarted.step({ config, passphrase, now: origin + 9999999 })
  assert.equal(restarted.status.phase, 'uncertain')
  assert.equal(fixture.objects.size, 1)
  fixture.control.corrupt = false
  await restarted.retry()
  await restarted.step({ config, passphrase, now: origin + 10000000 })
  await restarted.step({ config, passphrase, now: origin + 10001000 })
  assert.equal(fixture.objects.size, 2)
  await writeFile(join(target, 'profiles/web/cordis.patch.yml'), '# retry this\n')
  // A fresh destination forces MKCOL, whose rejection proves no PUT started.
  config.url += 'new/'
  fixture.collections.delete('/vault%20test/snapshots/')
  fixture.control.methodStatus.MKCOL = 403
  await restarted.step({ config, passphrase, now: origin + 20000000 })
  await restarted.step({ config, passphrase, now: origin + 20001000 })
  assert.equal(restarted.status.phase, 'error')
  assert.ok(!JSON.parse(await readFile(join(target, 'config-vault/auto-state.json'), 'utf8')).pending)
  const count = fixture.requests.length
  await restarted.step({ config, passphrase, now: origin + 20002000 })
  assert.equal(fixture.requests.length, count)
})

test('same-home workers share a lock and persisted deduplication', async t => {
  const { target, fixture, config, auto, step } = await setup(t)
  const second = new AutoBackup({ home: target, connection: async () => fixture.remote })
  await step(origin)
  let finish
  const put = fixture.remote.put.bind(fixture.remote)
  fixture.remote.put = async (...args) => { await new Promise(resolve => { finish = resolve }); return put(...args) }
  const active = step(origin + 1000)
  while (!finish) await new Promise(resolve => setImmediate(resolve))
  await second.step({ config, passphrase, now: origin + 1000 })
  assert.equal(second.status.phase, 'busy')
  finish(); await active
  await second.step({ config, passphrase, now: origin + 100000 })
  assert.equal(fixture.objects.size, 1)
  assert.equal(second.status.phase, 'watching')
  await assert.rejects(access(join(target, 'config-vault/auto.lock')), { code: 'ENOENT' })
})

test('manual verified backups update automatic dedupe; unload cancels an in-flight automatic upload', async t => {
  const { target, fixture, config } = await setup(t)
  await savePreferences(target, config, (await loadPreferences(target, {})).revision, {})
  const service = new VaultSettingsService({ home: target, environment: { DSH_VAULT_PASSPHRASE: passphrase }, credentials: { describe: async () => ({ configured: true, writable: true }), resolve: async () => ({ value: 'test-password' }) } })
  t.after(() => service.dispose())
  await service.execute({ action: 'backup', revision: (await service.state()).revision, passphrase })
  await service.autoTick(Date.now() + 999999)
  assert.equal(fixture.objects.size, 1)
  await writeFile(join(target, 'profiles/web/cordis.patch.yml'), '# cancel upload\n')
  const now = Date.now() + 1000000
  await service.autoTick(now)
  let started
  service.connection = async () => ({ put: async (_id, _bytes, signal) => {
    started = true
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))
  } })
  const active = service.autoTick(now + 1000)
  while (!started) await new Promise(resolve => setImmediate(resolve))
  await service.dispose(); await active
  assert.equal(fixture.objects.size, 1)
  assert.equal(service.autoPassphrase, null)
  await assert.rejects(access(join(target, 'config-vault/auto.lock')), { code: 'ENOENT' })
  assert.equal(JSON.parse(await readFile(join(target, 'config-vault/auto-state.json'), 'utf8')).pending !== undefined, true)
})

test('a settings save waits for an automatic cycle instead of losing a form to a polling race', async t => {
  const { target, fixture, config } = await setup(t, false)
  await savePreferences(target, config, (await loadPreferences(target, {})).revision, {})
  const service = new VaultSettingsService({ home: target, environment: {}, credentials: { describe: async () => ({ configured: true, writable: true }), resolve: async () => ({ value: 'test-password' }) } })
  t.after(() => service.dispose())
  let finish
  const put = fixture.remote.put.bind(fixture.remote)
  service.connection = async () => ({ put: async (...args) => { await new Promise(resolve => { finish = resolve }); return put(...args) }, get: (...args) => fixture.remote.get(...args) })
  await service.autoTick(origin)
  const active = service.autoTick(origin + 1000)
  while (!finish) await new Promise(resolve => setImmediate(resolve))
  const revision = (await service.state()).revision
  const saving = service.execute({ action: 'save', revision, config: { ...config, autoBackup: { ...config.autoBackup, enabled: false } } })
  finish(); await active
  assert.equal((await saving).state.config.autoBackup.enabled, false)
  assert.equal(fixture.objects.size, 1)
})

test('service timer observes real edits, keeps unlock secret out of storage, and stops on disable/unload', async t => {
  const { target, fixture, config } = await setup(t)
  await savePreferences(target, config, (await loadPreferences(target, {})).revision, {})
  const service = new VaultSettingsService({ home: target, environment: {}, credentials: { describe: async () => ({ configured: true, writable: true }), resolve: async () => ({ value: 'test-password' }) } })
  t.after(() => service.dispose())
  await service.autoTick()
  assert.equal((await service.state()).auto.phase, 'locked')
  const unlocked = await service.execute({ action: 'auto-unlock', revision: (await service.state()).revision, passphrase })
  assert.ok(!JSON.stringify(unlocked).includes(passphrase))
  assert.ok(!String(await readFile(join(target, 'config-vault/settings.json'))).includes(passphrase))
  service.startAuto(25)
  await writeFile(join(target, 'profiles/web/cordis.patch.yml'), '# real timer edit\n')
  const deadline = Date.now() + 5000
  while (!fixture.objects.size || service.busy) { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 25)) }
  const snapshot = await download({ id: (await service.state()).auto.snapshotId, remote: fixture.remote, passphrase })
  assert.equal(snapshot.files.find(file => file.path.endsWith('yml')).content, '# real timer edit\n')
  await service.execute({ action: 'save', revision: (await service.state()).revision, config: { ...config, autoBackup: { ...config.autoBackup, enabled: false } } })
  assert.equal(service.autoPassphrase, null)
  await writeFile(join(target, 'profiles/web/cordis.patch.yml'), '# disabled edit\n')
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(fixture.objects.size, 1)
  await service.dispose()
  assert.equal(service.autoPassphrase, null)
  const count = fixture.requests.length
  await service.autoTick(Date.now() + 999999)
  assert.equal(fixture.requests.length, count)
})
