import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { VaultSettingsService, createSettingsHandler, API_PATH } from '../src/ui-service.mjs'
import * as vault from '../src/index.mjs'
import { home, dav, passphrase } from './helpers.mjs'

test('HTTP works through persisted settings, real WebDAV API, offline CLI and Harness tools without a test-only transport flag', async t => {
  const target = await home(t, true), fixture = await dav(t), values = new Map()
  const credentials = {
    describe: async key => ({ configured: values.has(key), writable: true }),
    resolve: async key => ({ value: values.get(key) }),
    set: async (key, value) => values.set(key, value), unset: async key => values.delete(key),
  }
  const service = new VaultSettingsService({ home: target, credentials, environment: {} })
  t.after(() => service.dispose())
  const handler = createSettingsHandler(service)
  const post = async body => {
    const response = await handler(new Request('http://localhost' + API_PATH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }))
    const data = await response.json()
    assert.equal(response.status, 200, JSON.stringify(data))
    return data
  }
  const config = { url: fixture.options.url, username: 'test-user', profiles: ['web'], includeHomePatch: false, timeoutMs: 30000 }
  const saved = await post({ action: 'save', revision: (await service.state()).revision, config, password: 'test-password' })
  assert.equal(saved.state.config.url, fixture.options.url)
  const revision = saved.state.revision
  assert.equal((await post({ action: 'test', revision })).directoryExists, false)
  const backedUp = (await post({ action: 'backup', revision, passphrase })).backup
  assert.equal(backedUp.verified, true)
  assert.equal((await post({ action: 'test', revision })).directoryExists, true)
  assert.deepEqual((await post({ action: 'list', revision })).snapshots, [backedUp.id])
  assert.ok((await post({ action: 'preview', revision, passphrase, id: backedUp.id })).plan.files.every(file => file.action === 'unchanged'))
  assert.ok([...fixture.objects.values()].every(bytes => !bytes.includes(Buffer.from('test-model'))))

  const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url))
  const run = async args => JSON.parse((await promisify(execFile)(process.execPath, [cli, ...args], {
    cwd: target, timeout: 30000, env: { PATH: process.env.PATH, DSH_VAULT_WEBDAV_PASSWORD: 'test-password', DSH_VAULT_PASSPHRASE: passphrase },
  })).stdout)
  assert.deepEqual((await run(['list', '--home', target])).snapshots, [backedUp.id])
  assert.equal((await run(['preview', '--home', target, '--id', backedUp.id])).blocked, false)
  assert.equal((await run(['backup', '--home', target])).verified, true)

  const previous = process.env.DSH_VAULT_PASSPHRASE
  process.env.DSH_VAULT_PASSPHRASE = passphrase
  t.after(() => { if (previous === undefined) delete process.env.DSH_VAULT_PASSPHRASE; else process.env.DSH_VAULT_PASSPHRASE = previous })
  const ctx = new Context(); t.after(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt, {}); await ctx.plugin(ToolRuntime, {})
  await ctx.plugin({ apply(child) { child.provide('credentials', credentials); child.provide('profileContext', { home: target }) } })
  await ctx.plugin(vault, {})
  const execute = async (name, args = {}) => {
    const result = await ctx.tools.execute({ callId: `http-${name}`, name, arguments: args, signal: new AbortController().signal })
    assert.ok(!result.isError, JSON.stringify(result.content))
    return JSON.parse(result.content[0].text)
  }
  assert.equal((await execute('vault_backup')).verified, true)
  assert.ok((await execute('vault_list')).snapshots.includes(backedUp.id))
  assert.equal((await execute('vault_preview', { id: backedUp.id })).blocked, false)
})
