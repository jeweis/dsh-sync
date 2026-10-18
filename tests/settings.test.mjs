import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { VaultSettingsService, createSettingsHandler, API_PATH, STATE_PATH } from '../src/ui-service.mjs'
import { loadPreferences, savePreferences, discoverProfiles, PASSWORD_REF } from '../src/settings.mjs'
import { collect } from '../src/snapshot.mjs'
import { OperationError } from '../src/operation-error.mjs'
import * as vault from '../src/index.mjs'
import { home, dav, passphrase, manifest } from './helpers.mjs'

const config = { url: 'https://example.invalid/dav/', username: 'test-user', profiles: ['web'], includeHomePatch: false, timeoutMs: 30000 }
function credentials() {
  const values = new Map()
  return { values,
    describe: async key => ({ configured: values.has(key), writable: true }),
    resolve: async key => values.has(key) ? { value: values.get(key), source: 'memory' } : undefined,
    set: async (key, value) => { values.set(key, value) }, unset: async key => { values.delete(key) },
  }
}
const request = body => new Request('http://localhost' + API_PATH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

test('readable WebDAV can reject MKCOL or PUT; API identifies each backup failure without exposing secrets', async t => {
  const { target, service, post } = await setup(t)
  const fixture = await dav(t)
  service.connection = async () => fixture.remote
  const saved = await post({ action: 'save', revision: (await service.state()).revision, config })
  const revision = saved.value.state.revision
  assert.equal((await post({ action: 'test', revision })).status, 200)
  fixture.control.methodStatus.MKCOL = 403
  const mkdir = await post({ action: 'backup', revision, passphrase })
  assert.deepEqual(mkdir.value, { error: 'operation-failed', diagnostic: { stage: 'mkdir', reason: 'http', status: 403, remoteMayExist: false } })
  assert.equal(fixture.requests.some(item => item.method === 'PUT'), false)
  delete fixture.control.methodStatus.MKCOL
  fixture.control.methodStatus.PUT = 507
  assert.deepEqual((await post({ action: 'backup', revision, passphrase })).value.diagnostic, { stage: 'upload', reason: 'http', status: 507, remoteMayExist: true })
  delete fixture.control.methodStatus.PUT
  fixture.control.methodStatus.GET = 403
  assert.deepEqual((await post({ action: 'backup', revision, passphrase })).value.diagnostic, { stage: 'download', reason: 'http', status: 403, remoteMayExist: true })
  delete fixture.control.methodStatus.GET
  fixture.control.corrupt = true
  assert.deepEqual((await post({ action: 'backup', revision, passphrase })).value.diagnostic, { stage: 'verify', reason: 'invalid-data', remoteMayExist: true })
  await writeFile(join(target, 'profiles/web/package.json'), 'invalid-json-private-content')
  assert.deepEqual((await post({ action: 'backup', revision, passphrase })).value.diagnostic, { stage: 'collect', reason: 'failed', remoteMayExist: false })
  service.connection = async () => { throw new Error('private-provider-password') }
  assert.deepEqual((await post({ action: 'test', revision })).value, { error: 'operation-failed' })
  service.connection = async () => { throw new OperationError('private raw message', { stage: 'list', reason: 'tls', status: 'private-status' }) }
  assert.deepEqual((await post({ action: 'test', revision })).value, { error: 'operation-failed', diagnostic: { stage: 'list', reason: 'tls' } })
})

async function setup(t) {
  const target = await home(t, true), creds = credentials()
  const service = new VaultSettingsService({ home: target, credentials: creds, environment: {} })
  t.after(() => service.dispose())
  const handler = createSettingsHandler(service)
  const post = async body => { const response = await handler(request(body)); return { status: response.status, value: await response.json() } }
  return { target, creds, service, handler, post }
}

test('preferences persist without secrets; stale forms cannot overwrite them and blank password preserves credentials', async t => {
  const { target, creds, service, post } = await setup(t)
  const before = await service.state()
  const saved = await post({ action: 'save', revision: before.revision, config, password: 'test-password' })
  assert.equal(saved.status, 200); assert.equal(saved.value.state.passwordConfigured, true)
  assert.equal(saved.value.state.busy, false)
  assert.ok(!JSON.stringify(saved.value).includes('test-password'))
  assert.equal(creds.values.get(PASSWORD_REF), 'test-password')
  const raw = await readFile(join(target, 'config-vault/settings.json'), 'utf8')
  assert.ok(!raw.includes('test-password'))
  assert.deepEqual((await loadPreferences(target, {})).config, config)
  assert.equal((await post({ action: 'save', revision: before.revision, config, password: 'do-not-write' })).status, 409)
  assert.equal(creds.values.get(PASSWORD_REF), 'test-password')
  const resaved = await post({ action: 'save', revision: saved.value.state.revision, config: { ...config, includeHomePatch: true }, password: '' })
  assert.equal(resaved.status, 200); assert.equal(creds.values.get(PASSWORD_REF), 'test-password')
  const cleared = await post({ action: 'save', revision: resaved.value.state.revision, config, clearPassword: true })
  assert.equal(cleared.value.state.passwordConfigured, false)
  assert.ok(!(await collect({ home: target })).files.some(file => file.path.includes('config-vault')))
})

test('profile discovery skips symlink directories and reports missing or invalid selected profiles', async t => {
  const { target, service, post } = await setup(t), outside = await home(t, true)
  await mkdir(join(target, 'profiles/broken')); await writeFile(join(target, 'profiles/broken/package.json'), '{invalid')
  await symlink(join(outside, 'profiles/web'), join(target, 'profiles/link'), 'dir')
  assert.deepEqual(await discoverProfiles(target), [{ name: 'broken', available: false }, { name: 'web', available: true }])
  const revision = (await service.state()).revision
  const missing = await post({ action: 'save', revision, config: { ...config, profiles: ['missing'] } })
  assert.equal(missing.status, 400)
  assert.equal((await service.state()).revision, revision)
})

test('settings API rejects unsafe URLs, unknown actions, online restore and oversized or malformed input', async t => {
  const { service, handler, post } = await setup(t), revision = (await service.state()).revision
  for (const url of ['ftp://example.invalid/dav/', 'http://user:secret@example.invalid/', 'https://user:secret@example.invalid/', 'https://example.invalid/?token=secret']) {
    const result = await post({ action: 'save', revision, config: { ...config, url } })
    assert.equal(result.status, 400); assert.equal(result.value.error, 'invalid-webdav')
  }
  for (const extra of [{ keepLast: 0 }, { keepLast: 10001 }, { keepLast: 1.5 }, { keepLast: '30' }, { encryption: 'false' }, { autoBackup: true }, { autoBackup: { enabled: true, debounceMs: 0, minIntervalMs: 60000 } }, { autoBackup: { enabled: true, debounceMs: 1000, minIntervalMs: 1 } }, { autoBackup: { enabled: true, debounceMs: 1000, minIntervalMs: 60000, passphrase: 'must-not-persist' } }]) {
    assert.equal((await post({ action: 'save', revision, config: { ...config, ...extra } })).status, 400)
  }
  assert.equal((await post({ action: 'restore', revision, confirm: true })).status, 400)
  assert.equal((await post({ action: 'constructor', revision })).status, 400)
  assert.equal((await post({ action: 'save', revision, config, passphrase: 'must-not-persist' })).status, 400)
  const malformed = new Request('http://localhost' + API_PATH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"secret":"never-reflect",' })
  const result = await handler(malformed)
  assert.equal(result.status, 400); assert.ok(!(await result.text()).includes('never-reflect'))
  const large = new Request('http://localhost' + API_PATH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: ' '.repeat(32769) })
  assert.equal((await handler(large)).status, 413)
  assert.equal((await handler(new Request('http://localhost' + API_PATH, { method: 'POST', body: '{}' }))).status, 415)
})

test('settings API backup, list and preview share WebDAV engine and never apply the plan', async t => {
  const { target, service, post, creds } = await setup(t), fixture = await dav(t)
  creds.values.set(PASSWORD_REF, 'test-password')
  const revision = (await service.state()).revision
  const saved = await post({ action: 'save', revision, config })
  const current = saved.value.state.revision
  // Storage boundary fixture: same WebDAV implementation, loopback HTTP transport only in tests.
  service.connection = async () => fixture.remote
  assert.equal((await post({ action: 'test', revision: current })).value.connected, true)
  const invalid = await post({ action: 'backup', revision: current, passphrase: 'short' })
  assert.equal(invalid.value.error, 'passphrase-required')
  const result = await post({ action: 'backup', revision: current, passphrase })
  assert.equal(result.status, 200); assert.equal(result.value.backup.verified, true)
  const id = result.value.backup.id
  assert.deepEqual((await post({ action: 'list', revision: current })).value.snapshots, [id])
  await writeFile(join(target, 'profiles/web/package.json'), manifest + '\n')
  const before = await readFile(join(target, 'profiles/web/package.json'), 'utf8')
  const plan = await post({ action: 'preview', revision: current, id, passphrase })
  assert.equal(plan.status, 200); assert.equal(plan.value.plan.files[0].action, 'replace')
  assert.equal(await readFile(join(target, 'profiles/web/package.json'), 'utf8'), before)
  assert.ok(!JSON.stringify(plan.value).includes(passphrase))
  const wrong = await post({ action: 'preview', revision: current, id, passphrase: 'wrong-but-long-password' })
  assert.equal(wrong.status, 502); assert.deepEqual(wrong.value, { error: 'operation-failed', diagnostic: { stage: 'verify', reason: 'invalid-data' } })
})

test('operation exclusion, cancellation and teardown do not duplicate remote writes', async t => {
  const { service, post } = await setup(t)
  const saved = await post({ action: 'save', revision: (await service.state()).revision, config })
  let release
  service.connection = async () => ({ list: signal => new Promise((resolve, reject) => { release = resolve; signal.addEventListener('abort', () => reject(new Error('secret-network-detail')), { once: true }) }) })
  const listing = post({ action: 'list', revision: saved.value.state.revision })
  while (!release) await new Promise(resolve => setImmediate(resolve))
  assert.equal((await post({ action: 'test', revision: saved.value.state.revision })).value.error, 'busy')
  await service.dispose()
  const cancelled = await listing
  assert.deepEqual(cancelled.value, { error: 'operation-failed' })
  assert.equal((await post({ action: 'list', revision: saved.value.state.revision })).status, 503)
})

test('credential save failures are reported as incomplete and never leak provider errors', async t => {
  const { service, post, creds } = await setup(t)
  creds.set = async () => { throw new Error('provider-secret-material') }
  const result = await post({ action: 'save', revision: (await service.state()).revision, config, password: 'test-password' })
  assert.equal(result.status, 500); assert.deepEqual(result.value, { error: 'credentials-save-incomplete' })
  assert.deepEqual((await service.state()).config, config)
})

test('real Connection exact route denies non-owners and disposal removes route', async t => {
  const ctx = new Context(); t.after(() => ctx.fiber.dispose())
  const target = await home(t, true), creds = credentials()
  await ctx.plugin(SystemPrompt, {}); await ctx.plugin(ToolRuntime, {})
  const connectionFiber = await ctx.plugin({ apply(child) { new HostConnectionService(child, [], {}) } })
  await ctx.plugin({ apply(child) { child.provide('credentials', creds); child.provide('profileContext', { home: target }) } })
  const plugin = await ctx.plugin(vault, {})
  const fetcher = ctx.connection.createSharedFetchHandler('/api')
  const get = () => new Request('http://localhost' + STATE_PATH)
  assert.equal(fetcher.requestBodyMode({ method: 'GET', url: new URL(get().url) }), 'buffered')
  assert.equal(fetcher.requestBodyMode({ method: 'POST', url: new URL('http://localhost' + API_PATH) }), 'streaming')
  assert.equal((await fetcher.fetch(get(), { principal: { kind: 'guest' } })).status, 403)
  const owner = await fetcher.fetch(get(), ctx.connection.browserPeer)
  assert.equal(owner.status, 200)
  const ownerState = await owner.json()
  assert.equal(ownerState.passwordConfigured, false)
  let release, resolves = 0
  creds.set = async () => await new Promise(resolve => { release = resolve })
  creds.resolve = async () => { resolves += 1; throw new Error('Must not resolve connection credentials during a settings save') }
  const saving = fetcher.fetch(request({ action: 'save', revision: ownerState.revision, config, password: 'test-only-password' }), ctx.connection.browserPeer)
  const deadline = Date.now() + 2000
  while (!release) { assert.ok(Date.now() < deadline, 'Credential save did not start'); await new Promise(resolve => setImmediate(resolve)) }
  const concurrent = await ctx.tools.execute({ callId: 'concurrent-vault-list', name: 'vault_list', arguments: {}, signal: new AbortController().signal })
  assert.equal(concurrent.isError, true)
  assert.match(JSON.stringify(concurrent.content), /busy/)
  assert.equal(resolves, 0)
  release()
  assert.equal((await saving).status, 200)
  await plugin.dispose()
  assert.equal((await fetcher.fetch(get(), ctx.connection.browserPeer)).status, 404)
  await connectionFiber.dispose()
})
