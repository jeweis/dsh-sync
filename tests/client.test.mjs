import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { createRequire } from 'node:module'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { Simulate } from 'react-dom/test-utils'
import { JSDOM } from 'jsdom'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { VaultSettingsService, createSettingsHandler } from '../src/ui-service.mjs'
import { home, manifest, dav, passphrase } from './helpers.mjs'
const require = createRequire(import.meta.url)
const { Controller } = require('../src/client/controller.cjs')
const dictionaries = require('../src/client/locales.cjs')
const id = '2026-10-18T01-02-03-000Z_11111111-1111-4111-8111-111111111111'
const config = { url: 'https://example.invalid/dav/', username: 'demo', profiles: ['web'], includeHomePatch: false, timeoutMs: 30000 }
const state = () => ({ config: structuredClone(config), revision: 'revision-1', profiles: [{ name: 'web', available: true }], passwordConfigured: true, passwordWritable: true, busy: false })
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
async function waitFor(predicate) {
  const deadline = Date.now() + 3000
  while (!predicate()) { if (Date.now() > deadline) throw new Error('UI operation did not settle'); await new Promise(resolve => setTimeout(resolve, 5)) }
}

test('controller retains known state until save acceptance, and secrets never enter its store', async () => {
  let release, submitted
  const controller = new Controller(async (url, init) => {
    assert.equal(url, init.method === 'GET' ? '/api/dsh-config-vault/state' : '/api/dsh-config-vault')
    if (init.method === 'GET') return response(state())
    submitted = JSON.parse(init.body)
    return await new Promise(resolve => { release = resolve })
  })
  await controller.load()
  const pending = controller.run('save', { config: { ...config, username: 'new' }, password: 'private-password' })
  assert.equal(controller.state.getSnapshot().host.config.username, 'demo')
  assert.equal(controller.state.getSnapshot().busy, true)
  assert.equal(submitted.password, 'private-password')
  assert.ok(!JSON.stringify(controller.state.getSnapshot()).includes('private-password'))
  release(response({ state: { ...state(), revision: 'revision-2', config: { ...config, username: 'new' } } }))
  await pending
  assert.equal(controller.state.getSnapshot().host.config.username, 'new')
  assert.equal(controller.state.getSnapshot().notice, 'saved')
  controller.dispose()
})

test('lost save response triggers a read, lost backup response is not retried, and list/preview state is validated', async () => {
  let posts = 0
  const controller = new Controller(async (_url, init) => {
    if (init.method === 'GET') return response(state())
    posts += 1; throw new Error('network message may contain secrets')
  })
  await controller.load()
  await controller.run('save', { config, password: 'secret-value' })
  assert.equal(controller.state.getSnapshot().error, 'operation-failed')
  assert.equal(controller.state.getSnapshot().host.config.url, config.url)
  await controller.run('backup', { passphrase: 'long-test-passphrase' })
  assert.equal(posts, 2)
  assert.equal(controller.state.getSnapshot().notice, 'backupUnknown')
  assert.ok(!JSON.stringify(controller.state.getSnapshot()).includes('long-test-passphrase'))
  controller.fetcher = async () => response({ snapshots: ['../not-a-snapshot'] })
  await controller.run('list')
  assert.equal(controller.state.getSnapshot().snapshots, null)
  assert.equal(controller.state.getSnapshot().error, 'operation-failed')
  controller.dispose()
})

test('controller clears stale previews, never updates after dispose, and dictionaries have matching keys', async () => {
  let finish
  const controller = new Controller(async (_url, init) => init.method === 'GET' ? response(state()) : await new Promise(resolve => { finish = resolve }))
  await controller.load()
  controller.state.update(value => { value.plan = { snapshotId: id } })
  const pending = controller.run('preview', { id, passphrase: 'temporary-secret' })
  assert.equal(controller.state.getSnapshot().plan, null)
  controller.dispose(); finish(response({ error: 'stopping' }, 503)); await pending
  assert.equal(controller.state.getSnapshot().error, null)
  assert.deepEqual(Object.keys(dictionaries.en).sort(), Object.keys(dictionaries.zh).sort())
})

async function mount(t, fetcher, language = 'zh') {
  const dom = new JSDOM('<!doctype html><html><head></head><body><main id="root"></main></body></html>', { url: 'http://localhost' })
  const previous = { window: globalThis.window, document: globalThis.document, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT }
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.IS_REACT_ACT_ENVIRONMENT = true
  let plugin, registration
  runInNewContext(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load(value) { plugin = value.factory(name => {
      if (name === 'react') return React
      if (name === '@deepseek-ai/dsh-client-store') return { createSnapshotStore }
      assert.fail(`Unexpected browser import: ${name}`)
    }) } } }, document: dom.window.document, fetch: fetcher, AbortController, console, setTimeout, clearTimeout,
  })
  const effects = [], events = new Map()
  const ctx = {
    locale: { register: () => () => {}, bind: () => key => dictionaries[language][key] ?? key },
    effect(fn) { effects.push(fn()) }, on(name, handler) { events.set(name, handler) },
    slots: { inject(_name, callback) { callback() }, register(options, component) { registration = { options, component }; return () => {} } },
  }
  let root, face
  await React.act(async () => {
    plugin.apply(ctx)
    face = registration.options.inject()
    // The real renderer creates this hook from the declared hooks compartment.
    const useVault = selector => React.useSyncExternalStore(face.hooks.vault.subscribe, () => selector(face.hooks.vault.getSnapshot()))
    root = createRoot(dom.window.document.getElementById('root'))
    root.render(React.createElement(registration.component, { useVault, run: face.run, reload: face.reload, t: ctx.locale.bind() }))
    await waitFor(() => !face.hooks.vault.getSnapshot().busy)
  })
  t.after(async () => {
    await React.act(async () => { root.unmount(); for (const dispose of effects.toReversed()) await dispose() })
    dom.window.close()
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value }
  })
  const byText = (tag, text) => [...dom.window.document.querySelectorAll(tag)].find(node => node.textContent === text)
  return { dom, face, registration, events, byText, get: () => face.hooks.vault.getSnapshot() }
}

test('built settings page saves WebDAV configuration, clears secrets, creates a snapshot and renders offline-only preview', async t => {
  const target = await home(t, true), secrets = new Map()
  await mkdir(join(target, 'profiles/headless'))
  await writeFile(join(target, 'profiles/headless/package.json'), manifest)
  const credentials = { describe: async key => ({ configured: secrets.has(key), writable: true }), resolve: async key => secrets.has(key) ? { value: secrets.get(key) } : undefined,
    set: async (key, value) => secrets.set(key, value), unset: async key => secrets.delete(key) }
  const service = new VaultSettingsService({ home: target, credentials, environment: {} })
  t.after(() => service.dispose())
  const handler = createSettingsHandler(service), submitted = []
  service.connection = async () => ({
    put: async (snapshotId, bytes) => { service.bytes = bytes; service.snapshotId = snapshotId },
    get: async () => service.bytes, list: async () => service.snapshotId ? [service.snapshotId] : [],
  })
  const m = await mount(t, async (url, init) => {
    if (init.body) submitted.push(JSON.parse(init.body))
    return handler(new Request('http://localhost' + url, init))
  })
  assert.equal(m.registration.options.name, 'settings.section')
  assert.equal(m.registration.options.label(), dictionaries.zh.nav)
  const doc = m.dom.window.document
  assert.equal(doc.querySelector('h2').textContent, '同步与备份')
  const brandIcon = doc.querySelector('.vault-brand-icon')
  assert.match(brandIcon.src, /^data:image\/svg\+xml;base64,/)
  assert.equal(brandIcon.alt, '')
  const url = doc.querySelector('input[type="url"]')
  const webdavPassword = [...doc.querySelectorAll('input[type="password"]')][0]
  const headless = [...doc.querySelectorAll('label')].find(label => label.textContent === 'headless').querySelector('input')
  await React.act(async () => { Simulate.change(url, { target: { value: config.url } }); Simulate.change(webdavPassword, { target: { value: 'browser-only-password' } }); Simulate.change(headless, { target: { checked: true } }) })
  await React.act(async () => { Simulate.submit(doc.querySelector('form')); await waitFor(() => !m.get().busy) })
  assert.equal(m.get().host.config.url, config.url)
  assert.deepEqual([...m.get().host.config.profiles], ['web', 'headless'])
  assert.ok(!JSON.stringify(m.get()).includes('browser-only-password'))
  assert.equal(doc.querySelector('input[type="password"]').value, '')
  const encryptionInput = () => [...doc.querySelectorAll('input[type="password"]')].at(-1)
  await React.act(async () => { Simulate.change(encryptionInput(), { target: { value: 'temporary-encryption-passphrase' } }) })
  await React.act(async () => { m.byText('button', dictionaries.zh.backup).click(); await waitFor(() => !m.get().busy) })
  assert.equal(encryptionInput().value, '')
  assert.equal(m.get().backup.verified, true)
  assert.ok(m.get().backup.files.includes('profiles/headless/package.json'))
  await React.act(async () => { m.byText('button', dictionaries.zh.list).click(); await waitFor(() => !m.get().busy) })
  const select = doc.querySelector('select')
  await React.act(async () => { Simulate.change(select, { target: { value: service.snapshotId } }); Simulate.change(encryptionInput(), { target: { value: 'temporary-encryption-passphrase' } }) })
  await React.act(async () => { m.byText('button', dictionaries.zh.preview).click(); await waitFor(() => !m.get().busy) })
  assert.ok(doc.querySelector('table'))
  assert.match(doc.querySelector('pre').textContent, /preview --home/)
  assert.match(doc.querySelector('pre').textContent, /PLAN_TOKEN_FROM_CLI --offline/)
  assert.ok(!submitted.some(body => body.action === 'restore'))
  assert.ok(!JSON.stringify(m.get()).includes('temporary-encryption-passphrase'))
  assert.ok(!doc.body.textContent.includes('browser-only-password'))
})

test('read failures have an accessible retry path and blocked previews do not provide an apply command', async t => {
  let failed = true
  const m = await mount(t, async (_url, init) => {
    if (init.method === 'GET') return failed ? response({ error: 'operation-failed' }, 502) : response(state())
    const body = JSON.parse(init.body)
    if (body.action === 'list') return response({ snapshots: [id] })
    return response({ plan: { snapshotId: id, home: '/test/home', token: 'a'.repeat(64), blocked: true, files: [{ path: 'profiles/web/package.json', action: 'replace' }], warnings: [{ code: 'local-dependency' }] } })
  }, 'en')
  assert.ok(m.dom.window.document.querySelector('[role="alert"]'))
  failed = false
  await React.act(async () => { m.byText('button', dictionaries.en.refresh).click(); await new Promise(resolve => setImmediate(resolve)) })
  await React.act(async () => { await m.face.run('list') })
  const doc = m.dom.window.document
  await React.act(async () => {
    Simulate.change(doc.querySelector('select'), { target: { value: id } })
    Simulate.change([...doc.querySelectorAll('input[type="password"]')].at(-1), { target: { value: 'temporary-encryption-passphrase' } })
  })
  await React.act(async () => { m.byText('button', dictionaries.en.preview).click(); await new Promise(resolve => setImmediate(resolve)) })
  assert.match(doc.body.textContent, /Manual migration required/)
  assert.equal(doc.querySelector('pre'), null)
})

test('unsaved profile or connection edits disable remote operations until saved', async t => {
  const m = await mount(t, async () => response(state()), 'en')
  const doc = m.dom.window.document
  const secret = [...doc.querySelectorAll('input[type="password"]')].at(-1)
  await React.act(async () => { Simulate.change(secret, { target: { value: 'temporary-test-passphrase' } }) })
  assert.equal(m.byText('button', dictionaries.en.backup).disabled, false)
  await React.act(async () => { Simulate.change(doc.querySelector('input[type="url"]'), { target: { value: 'https://changed.invalid/dav/' } }) })
  assert.equal(m.byText('button', dictionaries.en.backup).disabled, true)
  assert.equal(m.byText('button', dictionaries.en.test).disabled, true)
  assert.equal(m.byText('button', dictionaries.en.list).disabled, true)
  assert.match(doc.body.textContent, /Unsaved changes/)
  const web = [...doc.querySelectorAll('label')].find(label => label.textContent === 'web').querySelector('input')
  await React.act(async () => { Simulate.change(web, { target: { checked: false } }) })
  assert.equal(m.byText('button', dictionaries.en.save).disabled, true)
})

test('read-only credential providers disable password changes without disabling non-secret preferences', async t => {
  const m = await mount(t, async () => response({ ...state(), passwordWritable: false }), 'en')
  const doc = m.dom.window.document
  assert.equal(doc.querySelector('input[type="password"]').disabled, true)
  assert.equal([...doc.querySelectorAll('label')].find(label => label.textContent === dictionaries.en.clearPassword).querySelector('input').disabled, true)
  assert.equal(doc.querySelector('input[type="url"]').disabled, false)
  assert.match(doc.body.textContent, /read-only/)
})

test('read failures are reduced to public error codes rather than raw network details', async () => {
  const controller = new Controller(async () => { throw new Error('private-network-token-must-not-appear') })
  await controller.load()
  assert.equal(controller.state.getSnapshot().error, 'operation-failed')
  assert.ok(!JSON.stringify(controller.state.getSnapshot()).includes('private-network-token'))
  controller.dispose()
})

test('missing snapshot directory is shown as pending automatic creation rather than a readable connection', async t => {
  const m = await mount(t, async (_url, init) => init.method === 'GET' ? response(state()) : response({ connected: true, directoryExists: false }))
  await React.act(async () => { await m.face.run('test') })
  assert.equal(m.get().notice, 'connectedMissing')
  assert.match(m.dom.window.document.body.textContent, /404.*自动创建/)
  assert.ok(!m.dom.window.document.body.textContent.includes(dictionaries.zh.connected))
})

test('built settings page accepts HTTP and shows its warning for draft and saved URLs', async t => {
  let submitted
  const m = await mount(t, async (_url, init) => {
    if (init.method === 'GET') return response(state())
    submitted = JSON.parse(init.body)
    return response({ state: { ...state(), revision: 'revision-http', config: submitted.config } })
  })
  const doc = m.dom.window.document
  assert.ok(!doc.body.textContent.includes(dictionaries.zh.httpWarning))
  await React.act(async () => { Simulate.change(doc.querySelector('input[type="url"]'), { target: { value: 'http://nas.example:5005/backups/' } }) })
  assert.match(doc.querySelector('[role="note"]').textContent, /HTTP 不加密连接/)
  await React.act(async () => { Simulate.submit(doc.querySelector('form')); await waitFor(() => !m.get().busy) })
  assert.equal(submitted.config.url, 'http://nas.example:5005/backups/')
  assert.equal(m.get().notice, 'saved')
  assert.ok(doc.body.textContent.includes(dictionaries.zh.httpWarning))
  await React.act(async () => { Simulate.change(doc.querySelector('input[type="url"]'), { target: { value: config.url } }) })
  assert.equal(doc.querySelector('[role="note"]'), null)
})

test('settings UI saves automatic and plaintext options, unlocks only in host memory, and emits offline plaintext commands', async t => {
  const target = await home(t, true), fixture = await dav(t)
  const service = new VaultSettingsService({ home: target, environment: {}, credentials: { describe: async () => ({ configured: true, writable: true }), resolve: async () => ({ value: 'test-password' }) } })
  t.after(() => service.dispose())
  const handler = createSettingsHandler(service)
  const m = await mount(t, (url, init) => handler(new Request('http://localhost' + url, init)))
  const doc = m.dom.window.document
  const labelInput = text => [...doc.querySelectorAll('label')].find(label => label.firstChild?.textContent === text || label.textContent === text)?.querySelector('input')
  await React.act(async () => {
    Simulate.change(doc.querySelector('input[type="url"]'), { target: { value: fixture.options.url } })
    Simulate.change(doc.querySelector('.vault-columns input'), { target: { value: 'test-user' } })
    Simulate.change(labelInput(dictionaries.zh.autoEnable), { target: { checked: true } })
  })
  await React.act(async () => { Simulate.submit(doc.querySelector('form')); await waitFor(() => !m.get().busy) })
  assert.equal(m.get().host.config.autoBackup.enabled, true)
  assert.equal(m.get().host.auto.phase, 'locked')
  const secret = labelInput(dictionaries.zh.autoPassphrase)
  await React.act(async () => { Simulate.change(secret, { target: { value: passphrase } }) })
  await React.act(async () => { m.byText('button', dictionaries.zh.autoUnlock).click(); await waitFor(() => !m.get().busy) })
  assert.equal(secret.value, '')
  assert.equal(service.autoPassphrase, passphrase)
  assert.ok(!JSON.stringify(m.get()).includes(passphrase))
  await React.act(async () => { Simulate.change(labelInput(dictionaries.zh.encryption), { target: { checked: false } }) })
  assert.ok(doc.body.textContent.includes(dictionaries.zh.plaintextWarning))
  await React.act(async () => { Simulate.submit(doc.querySelector('form')); await waitFor(() => !m.get().busy) })
  assert.equal(service.autoPassphrase, null)
  assert.equal(m.byText('button', dictionaries.zh.backup).disabled, false)
  await React.act(async () => { m.byText('button', dictionaries.zh.backup).click(); await waitFor(() => !m.get().busy) })
  assert.equal(m.get().backup.encryption, false)
  await React.act(async () => { m.byText('button', dictionaries.zh.list).click(); await waitFor(() => !m.get().busy) })
  await React.act(async () => { Simulate.change(doc.querySelector('select'), { target: { value: m.get().snapshots[0] } }) })
  await React.act(async () => { m.byText('button', dictionaries.zh.preview).click(); await waitFor(() => !m.get().busy) })
  assert.match(doc.querySelector('pre').textContent, /--unencrypted/)
  assert.match(doc.querySelector('pre').textContent, /--confirm PLAN_TOKEN_FROM_CLI --offline/)
  await React.act(async () => { Simulate.change(labelInput(dictionaries.zh.autoEnable), { target: { checked: false } }) })
  await React.act(async () => { Simulate.submit(doc.querySelector('form')); await waitFor(() => !m.get().busy) })
  assert.equal(m.get().host.auto.phase, 'disabled')
  assert.ok(!String(await readFile(join(target, 'config-vault/settings.json'))).includes(passphrase))
})

test('settings UI defaults retention to 30, persists a smaller limit and reports cleanup failure as verified backup', async t => {
  const target = await home(t, true), fixture = await dav(t)
  const service = new VaultSettingsService({ home: target, environment: {}, credentials: { describe: async () => ({ configured: true, writable: true }), resolve: async () => ({ value: 'test-password' }) } })
  t.after(() => service.dispose())
  const handler = createSettingsHandler(service)
  const m = await mount(t, (url, init) => handler(new Request('http://localhost' + url, init)))
  const doc = m.dom.window.document
  const keepInput = () => [...doc.querySelectorAll('label')].find(label => label.firstChild?.textContent === dictionaries.zh.keepLast).querySelector('input')
  assert.equal(keepInput().value, '30')
  await React.act(async () => {
    Simulate.change(doc.querySelector('input[type="url"]'), { target: { value: fixture.options.url } })
    Simulate.change(doc.querySelector('.vault-columns input'), { target: { value: 'test-user' } })
    Simulate.change(keepInput(), { target: { value: '1' } })
    const encryption = [...doc.querySelectorAll('label')].find(label => label.textContent === dictionaries.zh.encryption).querySelector('input')
    Simulate.change(encryption, { target: { checked: false } })
  })
  await React.act(async () => { Simulate.submit(doc.querySelector('form')); await waitFor(() => !m.get().busy) })
  assert.equal(m.get().host.config.keepLast, 1)
  await React.act(async () => { m.byText('button', dictionaries.zh.backup).click(); await waitFor(() => !m.get().busy) })
  assert.equal(m.get().backup.retention.status, 'ok')
  fixture.control.methodStatus.DELETE = 403
  await React.act(async () => { m.byText('button', dictionaries.zh.backup).click(); await waitFor(() => !m.get().busy) })
  assert.equal(m.get().backup.verified, true)
  assert.equal(m.get().notice, 'backedUpCleanupWarning')
  assert.equal(m.get().error, null)
  assert.equal(fixture.objects.size, 2)
  await React.act(async () => { m.byText('button', dictionaries.zh.refresh).click(); await waitFor(() => !m.get().busy) })
  assert.equal(keepInput().value, '1')
  assert.match(doc.body.textContent, /清理未完成.*HTTP 403/)
})

test('built page renders safe failure stage and HTTP status, distinguishes no upload, and clears stale success', async t => {
  let reply = response({ backup: { id, verified: true } })
  const m = await mount(t, async (_url, init) => init.method === 'GET' ? response(state()) : reply)
  await React.act(async () => { await m.face.run('backup', { passphrase: 'temporary-passphrase' }) })
  assert.equal(m.get().backup.verified, true)
  reply = response({ error: 'operation-failed', diagnostic: { stage: 'mkdir', reason: 'http', status: 403, remoteMayExist: false, message: 'private-password' } }, 502)
  await React.act(async () => { await m.face.run('backup', { passphrase: 'temporary-passphrase' }) })
  assert.equal(m.get().backup, null)
  assert.equal(m.get().notice, 'backupNotUploaded')
  const doc = m.dom.window.document
  assert.match(doc.querySelector('[role="alert"]').textContent, /创建 WebDAV 目录（MKCOL）.*HTTP 403/)
  assert.ok(!doc.body.textContent.includes(dictionaries.zh.backupUnknown))
  assert.ok(!JSON.stringify(m.get()).includes('private-password'))
  reply = response({ error: 'operation-failed', diagnostic: { stage: 'upload', reason: 'http', status: 507, remoteMayExist: true } }, 502)
  await React.act(async () => { await m.face.run('backup') })
  assert.equal(m.get().notice, 'backupUnknown')
  assert.match(doc.querySelector('[role="alert"]').textContent, /上传快照（PUT）.*HTTP 507/)
  reply = response({ error: 'operation-failed', diagnostic: { stage: 'private-url', reason: 'http', status: 403 } }, 502)
  await React.act(async () => { await m.face.run('backup') })
  assert.equal(m.get().diagnostic, null)
  assert.ok(!doc.body.textContent.includes('private-url'))
  reply = response({ snapshots: [] })
  await React.act(async () => { await m.face.run('list') })
  assert.equal(doc.querySelector('[role="alert"]'), null)
})

test('built sync UI saves scope, unlocks only in process memory, reviews first join and resolves a two-device conflict', async t => {
  const { LiveSync } = await import('../src/sync.mjs')
  const { itemId } = await import('../src/sync-adapter.mjs')
  const target = await home(t,true), fixture = await dav(t)
  const makeAdapter = preference => ({
    item: {module:'@deepseek-ai/dsh-client-ui-theme',ns:'theme',field:'preference',category:'appearance',value:{preference}}, revision:0,
    available(){return true}, async capture(){return {items:[structuredClone(this.item)],revisions:new Map([[itemId(this.item),this.revision]])}},
    async apply(item,expected){assert.equal(expected.revision,this.revision);this.item=structuredClone(item);this.revision++},
  })
  const adapter=makeAdapter('light')
  const service=new VaultSettingsService({home:target,profile:'web',syncAdapter:adapter,environment:{},credentials:{describe:async()=>({configured:true,writable:true}),resolve:async()=>({value:'test-password'})}})
  t.after(()=>service.dispose());service.connection=async()=>fixture.remote
  const {savePreferences,loadPreferences}=await import('../src/settings.mjs')
  const initial={url:fixture.options.url,username:'test-user',profiles:['web'],includeHomePatch:false,timeoutMs:30000}
  await savePreferences(target,initial,(await loadPreferences(target,{})).revision,{})
  const handler=createSettingsHandler(service), m=await mount(t,(url,init)=>handler(new Request('http://localhost'+url,init)))
  const doc=m.dom.window.document
  const label=text=>[...doc.querySelectorAll('label')].find(node=>node.firstChild?.textContent===text||node.textContent===text)
  const enable=[...doc.querySelectorAll('label')].find(node=>node.textContent===dictionaries.zh.syncEnable).querySelector('input')
  await React.act(async()=>{Simulate.change(enable,{target:{checked:true}})})
  const space=label(dictionaries.zh.syncSpace).querySelector('input')
  await React.act(async()=>{Simulate.change(space,{target:{value:'ui-test'}})})
  await React.act(async()=>{Simulate.submit(doc.querySelector('form'));await waitFor(()=>!m.get().busy)})
  assert.equal(m.get().host.config.sync.space,'ui-test');assert.equal(m.get().host.sync.phase,'locked')
  const secret=label(dictionaries.zh.syncPassphrase).querySelector('input')
  await React.act(async()=>{Simulate.change(secret,{target:{value:passphrase}})})
  await React.act(async()=>{Simulate.click(m.byText('button',dictionaries.zh.syncUnlock));await waitFor(()=>!m.get().busy)})
  assert.equal(m.get().host.sync.phase,'join');assert.equal(label(dictionaries.zh.syncPassphrase).querySelector('input').value,'')
  assert.ok(!JSON.stringify(m.get()).includes(passphrase))
  await React.act(async()=>{Simulate.click(m.byText('button',dictionaries.zh.syncChooseLocal))})
  await React.act(async()=>{Simulate.click(m.byText('button',dictionaries.zh.syncConfirm));await waitFor(()=>!m.get().busy)})
  assert.equal(m.get().host.sync.phase,'synced')
  const peer=makeAdapter('light'), peerHome=await home(t,true), worker=new LiveSync({home:peerHome,profile:'web',adapter:peer,connection:async()=>fixture.remote})
  const peerStep=extra=>worker.step({config:m.get().host.config,passphrase,force:true,...extra})
  await peerStep();peer.item.value.preference='dark';peer.revision++;await peerStep()
  adapter.item.value.preference='system';adapter.revision++
  await React.act(async()=>{Simulate.click(m.byText('button',dictionaries.zh.syncNow));await waitFor(()=>!m.get().busy)})
  assert.equal(m.get().host.sync.phase,'conflict');assert.equal(adapter.item.value.preference,'system')
  assert.ok(doc.body.textContent.includes(dictionaries.zh.syncConflicts))
  await React.act(async()=>{Simulate.click(m.byText('button',dictionaries.zh.syncChooseRemote))})
  await React.act(async()=>{Simulate.click(m.byText('button',dictionaries.zh.syncConfirm));await waitFor(()=>!m.get().busy)})
  assert.equal(adapter.item.value.preference,'dark');assert.equal(m.get().host.sync.phase,'synced')
  assert.equal(doc.querySelector('button[data-action="restore"]'),null)
})

test('built page offers a separate default-off API key switch and renders masked key comparisons without storing or posting values', async t => {
  const initial=state();initial.config.sync={enabled:true,space:'default',categories:['appearance'],intervalMs:180000}
  initial.sync={phase:'join',referenceMode:'atomic',profile:'web',token:'a'.repeat(64),pending:[],changes:[{id:'b'.repeat(64),label:'deepseek-key · api-key',category:'apiKeys',kind:'join',manualRemote:true,local:{configured:false},remote:{configured:true}}]}
  let submitted, current=initial
  const m=await mount(t,async(_url,init)=>{
    if(init.method==='GET')return response(current)
    submitted=JSON.parse(init.body)
    if(submitted.action==='save')current={...current,config:submitted.config,revision:'revision-2'}
    if(submitted.action==='sync-resolve')current={...current,sync:{...current.sync,phase:'pending',changes:[],pending:[{...current.sync.changes[0],reason:'reference-manual'}]}}
    return response({state:current})
  })
  const doc=m.dom.window.document
  const toggle=[...doc.querySelectorAll('label')].find(label=>label.textContent===dictionaries.zh.syncApiKeys)?.querySelector('input')
  assert.ok(toggle);assert.equal(toggle.checked,false)
  assert.ok(!doc.body.textContent.includes(dictionaries.zh['syncReferenceMode-atomic']))
  assert.ok(doc.querySelector('.vault-provider-advanced summary').textContent.includes(dictionaries.zh.providerActive))
  assert.ok(doc.body.textContent.includes(dictionaries.zh.syncKeySet));assert.ok(doc.body.textContent.includes(dictionaries.zh.syncKeyMissing))
  assert.ok(!doc.body.textContent.includes('"configured"'))
  await React.act(async()=>{Simulate.change(toggle,{target:{checked:true}})})
  await React.act(async()=>{Simulate.submit(doc.querySelector('form'));await waitFor(()=>!m.get().busy)})
  assert.equal(submitted.config.sync.apiKeys,true)
  assert.ok(doc.body.textContent.includes(dictionaries.zh['syncReferenceMode-atomic']))
  assert.deepEqual(Object.keys(submitted).sort(),['action','config','revision'])
  await React.act(async()=>{m.byText('button',dictionaries.zh.syncChooseRemote).click()})
  await React.act(async()=>{m.byText('button',dictionaries.zh.syncConfirm).click();await waitFor(()=>!m.get().busy)})
  assert.equal(submitted.action,'sync-resolve');assert.deepEqual(Object.keys(submitted).sort(),['action','choices','revision','token'])
  assert.equal(submitted.choices['b'.repeat(64)],'remote')
  assert.ok(doc.body.textContent.includes(dictionaries.zh['syncPending-reference-manual']))
  assert.equal(doc.querySelector('.vault-card details[open] summary')?.textContent,'deepseek-key · api-key')
})

test('built provider setup guide previews all profiles, gives offline commands and exposes no online switch or credential values',async t=>{
  const {transitionFixture}=await import('./provider-fixture.mjs')
  const f=await transitionFixture(t)
  const service=new VaultSettingsService({home:f.home,environment:{},credentials:{describe:async()=>({configured:false,writable:true})},providerContext:{installAnchor:f.anchor,overlays:[]}})
  t.after(()=>service.dispose())
  const handler=createSettingsHandler(service),requests=[]
  const m=await mount(t,async(url,init)=>{if(init.method==='POST')requests.push(JSON.parse(init.body));return handler(new Request('http://localhost'+url,init))})
  const before=await readFile(join(f.home,'profiles/a/cordis.patch.yml'),'utf8')
  await expandProvider(m)
  await React.act(async()=>{m.byText('button',dictionaries.zh.providerEnablePreview).click();await waitFor(()=>!m.get().busy)})
  assert.equal(m.get().providerPlan.mode,'enable');assert.equal(m.get().providerPlan.profiles.length,2)
  assert.ok(!m.get().providerPlan.blocked)
  const text=m.dom.window.document.body.textContent
  assert.match(text,/provider-preview.*--mode enable/)
  assert.match(text,/provider-switch.*--confirm PLAN_TOKEN_FROM_CLI --offline --all-writers-stopped/)
  assert.ok(text.includes(dictionaries.zh.providerAllWriters));assert.ok(!text.includes('fixture-initial-key'))
  assert.deepEqual(Object.keys(requests[0]).sort(),['action','mode','revision'])
  assert.ok(!requests.some(x=>x.action==='provider-switch'))
  const rejected=await handler(new Request('http://localhost/api/dsh-config-vault',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'provider-switch',revision:m.get().host.revision,mode:'enable'})}))
  assert.equal(rejected.status,400);assert.equal(await readFile(join(f.home,'profiles/a/cordis.patch.yml'),'utf8'),before)
})

test('provider guide previews rollback and makes unsupported active overlays visible without mutating profile files',async t=>{
  const {transitionFixture}=await import('./provider-fixture.mjs'),f=await transitionFixture(t)
  await f.apply()
  const service=new VaultSettingsService({home:f.home,environment:{},credentials:{describe:async()=>({configured:false,writable:true})},providerContext:{installAnchor:f.anchor,overlays:[]}})
  t.after(()=>service.dispose());const handler=createSettingsHandler(service)
  const m=await mount(t,(url,init)=>handler(new Request('http://localhost'+url,init)))
  await expandProvider(m)
  await React.act(async()=>{m.byText('button',dictionaries.zh.providerRollbackPreview).click();await waitFor(()=>!m.get().busy)})
  assert.equal(m.get().providerPlan.mode,'rollback');assert.ok(!m.get().providerPlan.blocked)
  assert.ok(m.dom.window.document.body.textContent.includes(dictionaries.zh.providerRollbackEffect))
  service.providerContext.overlays=[{}]
  await React.act(async()=>{m.byText('button',dictionaries.zh.providerRollbackPreview).click();await waitFor(()=>!m.get().busy)})
  assert.equal(m.get().providerPlan.blocked,true)
  assert.ok(m.dom.window.document.body.textContent.includes(dictionaries.zh['provider-context-required']))
})


async function expandProvider(m) {
  const details=m.dom.window.document.querySelector('.vault-provider-advanced')
  await React.act(async()=>{details.open=true;Simulate.toggle(details)})
  assert.ok(m.byText('button',dictionaries.zh.providerEnablePreview))
}

test('default settings need no provider setup; advanced disclosure is read-only and receiving guidance follows the key toggle',async t=>{
  let current=state(),posts=[]
  current.config.sync={enabled:true,space:'default',categories:['appearance'],intervalMs:180000}
  current.sync={phase:'locked',referenceMode:'manual',profile:'web',changes:[],pending:[]}
  const m=await mount(t,async(_url,init)=>{
    if(init.method==='GET')return response(current)
    const body=JSON.parse(init.body);posts.push(body)
    if(body.action==='save')current={...current,revision:'revision-2',config:body.config}
    return response({state:current})
  })
  const doc=m.dom.window.document,advanced=doc.querySelector('.vault-provider-advanced')
  assert.equal(advanced.open,false)
  assert.equal(m.byText('button',dictionaries.zh.providerEnablePreview),undefined)
  assert.ok(!doc.body.textContent.includes(dictionaries.zh.providerOffline))
  assert.ok(!doc.body.textContent.includes(dictionaries.zh['syncReferenceMode-manual']))
  assert.ok(!doc.body.textContent.includes(dictionaries.zh.syncKeyReceivingHint))
  const toggle=[...doc.querySelectorAll('label')].find(x=>x.textContent===dictionaries.zh.syncApiKeys).querySelector('input')
  await React.act(async()=>{Simulate.change(toggle,{target:{checked:true}})})
  assert.ok(doc.body.textContent.includes(dictionaries.zh.syncKeyReceivingHint))
  await React.act(async()=>{Simulate.submit(doc.querySelector('form'));await waitFor(()=>!m.get().busy)})
  assert.equal(posts.length,1);assert.equal(posts[0].action,'save')
  assert.equal(posts[0].config.sync.apiKeys,true)
  assert.ok(doc.body.textContent.includes(dictionaries.zh['syncReferenceMode-manual']))
  assert.equal(advanced.open,false)
  await expandProvider(m)
  assert.ok(doc.body.textContent.includes(dictionaries.zh.providerOptional))
  assert.ok(doc.body.textContent.includes(dictionaries.zh.providerCost))
  assert.equal(posts.length,1)
  await React.act(async()=>{advanced.open=false;Simulate.toggle(advanced)})
  assert.equal(advanced.open,false)
  assert.equal(posts.length,1)
  assert.equal(m.get().host.config.sync.apiKeys,true)
})
