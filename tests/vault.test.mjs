import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir, symlink, access } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { collect, validateSnapshot, warningsFor, RUNTIME } from '../src/snapshot.mjs'
import { backup, download } from '../src/engine.mjs'
import { preview, restore, recover } from '../src/restore.mjs'
import { seal, unseal } from '../src/crypto.mjs'
import { safePath, writeManaged } from '../src/files.mjs'
import { WebDAV } from '../src/webdav.mjs'
import { home, dav, passphrase, manifest, patch } from './helpers.mjs'

async function missing(path) { await assert.rejects(access(path), { code: 'ENOENT' }) }

test('WebDAV encrypted backup → authenticated download → reviewed offline restore → rollback', async t => {
  const source = await home(t, true), target = await home(t), fixture = await dav(t)
  const result = await backup({ home: source, remote: fixture.remote, passphrase })
  assert.equal(result.verified, true)
  assert.deepEqual(result.files.sort(), ['profiles/web/cordis.patch.yml', 'profiles/web/package.json'])
  const bytes = [...fixture.objects.values()][0]
  assert.ok(!bytes.includes(Buffer.from('test-model')))
  assert.ok(!bytes.includes(Buffer.from('never-collect')))
  assert.deepEqual(await fixture.remote.list(), [result.id])
  const snapshot = await download({ id: result.id, remote: fixture.remote, passphrase })
  const plan = await preview(snapshot, { home: target })
  await missing(join(target, 'profiles')) // Preview creates nothing.
  assert.equal(plan.blocked, false)
  const restored = await restore(snapshot, { home: target, token: plan.token, passphrase, offline: true })
  assert.equal(restored.status, 'restored'); assert.equal(restored.dependenciesInstalled, false)
  assert.equal(await readFile(join(target, 'profiles/web/package.json'), 'utf8'), manifest)
  assert.equal(await readFile(join(target, 'profiles/web/cordis.patch.yml'), 'utf8'), patch)
  await missing(join(target, '.credentials.yaml'))
  assert.equal((await restore(snapshot, { home: target, token: (await preview(snapshot, { home: target })).token, passphrase, offline: true })).status, 'unchanged')
  const rollback = await recover({ home: target, passphrase, rollbackId: restored.rollbackId })
  assert.equal(rollback.files.some(file => file.conflict), false)
  await recover({ home: target, passphrase, rollbackId: restored.rollbackId, token: rollback.token, offline: true })
  await missing(join(target, 'profiles/web/package.json'))
  assert.ok(fixture.requests.find(req => req.method === 'PUT').condition === '*')
})

test('preserve exact YAML, lockfile and bundle order; home patch is explicit', async t => {
  const source = await home(t, true)
  const yaml = '# retained comment\n- id: x\n  disabled: !!js "!ctx.get(\'x\')"\n  config:\n    path: /device/path\n'
  await writeFile(join(source, 'profiles/web/cordis.patch.yml'), yaml)
  await writeFile(join(source, 'profiles/web/pnpm-lock.yaml'), 'lockfileVersion: \'9.0\'\n')
  await writeFile(join(source, 'cordis.patch.yml'), '- id: home\n  disabled: true\n')
  const snapshot = await collect({ home: source })
  assert.equal(snapshot.files.find(file => file.path.endsWith('cordis.patch.yml')).content, yaml)
  assert.equal(snapshot.files.some(file => file.path === 'cordis.patch.yml'), false)
  assert.ok(warningsFor(snapshot, RUNTIME).some(w => w.code === 'executable-config'))
  assert.ok(warningsFor(snapshot, RUNTIME).some(w => w.code === 'device-path'))
  assert.equal((await collect({ home: source, includeHomePatch: true })).files.length, 4)
})

test('wrong password, modified ciphertext, malformed envelopes and version changes reject', async t => {
  const snapshot = await collect({ home: await home(t, true) })
  const bytes = await seal(snapshot, passphrase)
  assert.notDeepEqual(bytes, await seal(snapshot, passphrase))
  await assert.rejects(unseal(bytes, 'wrong-long-passphrase'), /Cannot decrypt/)
  const value = JSON.parse(bytes); const cipher = Buffer.from(value.ciphertext, 'base64'); cipher[0] ^= 1; value.ciphertext = cipher.toString('base64')
  await assert.rejects(unseal(Buffer.from(JSON.stringify(value)), passphrase), /Cannot decrypt/)
  value.version = 2
  await assert.rejects(unseal(Buffer.from(JSON.stringify(value)), passphrase), /Unsupported/)
  await assert.rejects(seal(snapshot, 'short'), /Passphrase/)
})

test('remote file validation rejects traversal, duplicates, hash mismatch and future formats', async t => {
  const snapshot = await collect({ home: await home(t, true) })
  for (const path of ['../escape', '/absolute', 'profiles/web/../../escape', 'profiles/web/.env', 'profiles/web/node_modules/x', 'profiles\\web\\package.json']) {
    assert.throws(() => validateSnapshot({ ...snapshot, files: [{ ...snapshot.files[0], path }] }), /Invalid snapshot/)
  }
  assert.throws(() => validateSnapshot({ ...snapshot, files: [...snapshot.files, snapshot.files[0]] }), /Invalid/)
  assert.throws(() => validateSnapshot({ ...snapshot, files: [{ ...snapshot.files[0], sha256: 'bad' }] }), /Invalid/)
  assert.throws(() => validateSnapshot({ ...snapshot, version: 2 }), /Unsupported/)
})

test('restore refuses no offline assertion, stale confirmation and runtime mismatch', async t => {
  const snapshot = await collect({ home: await home(t, true) }), target = await home(t, true)
  const plan = await preview(snapshot, { home: target })
  await assert.rejects(restore(snapshot, { home: target, token: plan.token, passphrase }), /Stop all Harness/)
  await writeFile(join(target, 'profiles/web/cordis.patch.yml'), '- id: changed\n')
  await assert.rejects(restore(snapshot, { home: target, token: plan.token, passphrase, offline: true }), /plan changed/)
  const incompatible = await preview(snapshot, { home: target, runtimeVersion: '99.0.0' })
  assert.equal(incompatible.blocked, true)
  await assert.rejects(restore(snapshot, { home: target, runtimeVersion: '99.0.0', token: incompatible.token, passphrase, offline: true }), /blocked/)
  assert.equal(await readFile(join(target, 'profiles/web/cordis.patch.yml'), 'utf8'), '- id: changed\n')
})

test('local plugin dependencies block portable restore; missing profile fails loudly', async t => {
  const source = await home(t, true), target = await home(t)
  const value = JSON.parse(manifest); value.dependencies['test-plugin'] = 'link:../my-plugin'
  await writeFile(join(source, 'profiles/web/package.json'), JSON.stringify(value))
  const snapshot = await collect({ home: source })
  const plan = await preview(snapshot, { home: target })
  assert.equal(plan.blocked, true)
  await assert.rejects(restore(snapshot, { home: target, token: plan.token, passphrase, offline: true }), /blocked/)
  await assert.rejects(collect({ home: source, profiles: ['missing'] }), /does not exist/)
  await assert.rejects(collect({ home: source, profiles: ['../escape'] }), /Invalid profile/)
})

test('symlinked source file and destination ancestors are refused without touching outside data', async t => {
  const source = await home(t), outside = await home(t, true)
  await mkdir(join(source, 'profiles'))
  await symlink(join(outside, 'profiles/web'), join(source, 'profiles/web'), 'dir')
  await assert.rejects(collect({ home: source }), /Symbolic links/)
  const snapshot = await collect({ home: outside })
  await assert.rejects(preview(snapshot, { home: source }), /Symbolic links/)
  assert.equal(await readFile(join(outside, 'profiles/web/package.json'), 'utf8'), manifest)
  await assert.rejects(safePath(source, '../escape'), /Unsafe/)
})

test('recovery repairs a persisted partially applied transaction and protects later edits', async t => {
  const target = await home(t, true)
  const journal = { format: 'dsh-config-vault-journal', version: 1, id: '11111111-1111-4111-8111-111111111111', changes: [
    { path: 'profiles/web/package.json', before: manifest, after: manifest + '\n' },
    { path: 'profiles/web/cordis.patch.yml', before: patch, after: '- id: restored\n' },
  ] }
  const bytes = await seal(journal, passphrase)
  await writeManaged(target, 'config-vault/active.vault', bytes.toString())
  await writeManaged(target, journal.changes[0].path, journal.changes[0].after)
  let plan = await recover({ home: target, passphrase })
  await writeManaged(target, journal.changes[1].path, '- id: subsequent-edit\n')
  await assert.rejects(recover({ home: target, passphrase, token: plan.token, offline: true }), /unchanged conflict-free/)
  assert.equal((await recover({ home: target, passphrase })).files[1].conflict, true)
  await writeManaged(target, journal.changes[1].path, patch)
  plan = await recover({ home: target, passphrase })
  await recover({ home: target, passphrase, token: plan.token, offline: true })
  assert.equal(await readFile(join(target, journal.changes[0].path), 'utf8'), manifest)
  await missing(join(target, 'config-vault/active.vault'))
})

test('active transaction blocks new restore and a live lock cannot be stolen', async t => {
  const snapshot = await collect({ home: await home(t, true) }), target = await home(t)
  await writeManaged(target, 'config-vault/active.vault', 'pending')
  await assert.rejects(restore(snapshot, { home: target, token: (await preview(snapshot, { home: target })).token, passphrase, offline: true }), /Unfinished restore/)
  await writeManaged(target, 'config-vault/active.vault', null)
  await writeManaged(target, 'config-vault/restore.lock', JSON.stringify({ pid: process.pid }))
  await assert.rejects(restore(snapshot, { home: target, token: (await preview(snapshot, { home: target })).token, passphrase, offline: true }), /locked/)
})

test('WebDAV handles missing collections, duplicate PUT, errors and refused redirects', async t => {
  const fixture = await dav(t), snapshot = await collect({ home: await home(t, true) }), bytes = await seal(snapshot, passphrase)
  assert.deepEqual(await fixture.remote.list(), [])
  await fixture.remote.put(snapshot.id, bytes)
  await assert.rejects(fixture.remote.put(snapshot.id, bytes), /412/)
  fixture.control.status = 401
  await assert.rejects(fixture.remote.list(), /401/)
  fixture.control.status = null; fixture.control.redirect = true
  await assert.rejects(fixture.remote.get(snapshot.id), /302/)
  assert.equal(new WebDAV({ url: 'http://example.com/dav/' }).base.protocol, 'http:')
  assert.throws(() => new WebDAV({ url: 'ftp://example.com/dav/' }), /HTTP or HTTPS/)
  assert.throws(() => new WebDAV({ url: 'https://user:password@example.com/' }), /credentials/)
})

test('WebDAV XML rejects entities and malformed documents and ignores foreign paths', async t => {
  const fixture = await dav(t), snapshot = await collect({ home: await home(t, true) })
  await fixture.remote.ensureCollection()
  assert.deepEqual(await fixture.remote.list(), [])
  fixture.control.xml = '<!DOCTYPE x [<!ENTITY x "bad">]><multistatus/>'
  await assert.rejects(fixture.remote.list(), /Invalid WebDAV XML/)
  fixture.control.xml = '<broken'
  await assert.rejects(fixture.remote.list(), /Invalid WebDAV XML/)
  fixture.control.xml = `<multistatus><response><href>https://foreign.example/snapshots/${snapshot.id}.vault</href></response><response><href>/outside/${snapshot.id}.vault</href></response></multistatus>`
  assert.deepEqual(await fixture.remote.list(), [])
})

test('timeouts and caller cancellation terminate WebDAV requests', async t => {
  const fixture = await dav(t); fixture.control.delay = true
  const remote = new WebDAV({ ...fixture.options, timeoutMs: 30 })
  await assert.rejects(remote.list(), /cancelled or timed out/)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(fixture.remote.list(controller.signal), /cancelled or timed out/)
})

test('backup fails verification on damaged remote data', async t => {
  const fixture = await dav(t); fixture.control.corrupt = true
  await assert.rejects(backup({ home: await home(t, true), remote: fixture.remote, passphrase }))
})

test('WebDAV rejects oversized downloads and a mismatched authenticated snapshot id', async t => {
  const fixture = await dav(t), snapshot = await collect({ home: await home(t, true) })
  const bytes = await seal(snapshot, passphrase)
  await fixture.remote.put(snapshot.id, bytes)
  fixture.control.oversized = true
  await assert.rejects(fixture.remote.get(snapshot.id), /exceeds size limit/)
  fixture.control.oversized = false
  const other = await collect({ home: await home(t, true) })
  fixture.objects.set(fixture.remote.object(other.id).pathname, bytes)
  await assert.rejects(download({ id: other.id, remote: fixture.remote, passphrase }), /identity mismatch/)
})

test('CLI help and input validation work without loading Harness packages', async () => {
  const run = args => new Promise(resolve => {
    const child = spawn(process.execPath, ['src/cli.mjs', ...args], { env: { PATH: process.env.PATH } })
    let stdout = '', stderr = ''; child.stdout.on('data', bytes => { stdout += bytes }); child.stderr.on('data', bytes => { stderr += bytes })
    child.on('close', code => resolve({ code, stdout, stderr }))
  })
  assert.equal((await run(['--help'])).code, 0)
  const result = await run(['restore']); assert.equal(result.code, 1); assert.match(result.stderr, /--home is required/)
})

test('a disk failure after the first replacement automatically restores original files', async t => {
  const fs = await import('node:fs/promises'), { syncBuiltinESMExports } = await import('node:module')
  const source = await home(t, true), target = await home(t, true)
  await writeFile(join(source, 'profiles/web/package.json'), manifest + '\n')
  await writeFile(join(source, 'profiles/web/cordis.patch.yml'), '- id: new\n')
  const snapshot = await collect({ home: source }), plan = await preview(snapshot, { home: target })
  const original = fs.default.rename; let injected = false
  fs.default.rename = async (from, to) => {
    if (!injected && to === join(target, 'profiles/web/cordis.patch.yml')) {
      injected = true
      assert.equal(await readFile(join(target, 'profiles/web/package.json'), 'utf8'), manifest + '\n')
      throw Object.assign(new Error('simulated disk failure'), { code: 'EIO' })
    }
    return original(from, to)
  }
  syncBuiltinESMExports()
  try {
    await assert.rejects(restore(snapshot, { home: target, token: plan.token, passphrase, offline: true }), /original file contents restored/)
    assert.equal(injected, true)
    assert.equal(await readFile(join(target, 'profiles/web/package.json'), 'utf8'), manifest)
    assert.equal(await readFile(join(target, 'profiles/web/cordis.patch.yml'), 'utf8'), patch)
    await missing(join(target, 'config-vault/active.vault'))
  } finally { fs.default.rename = original; syncBuiltinESMExports() }
})
