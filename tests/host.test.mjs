import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import * as vault from '../src/index.mjs'
import { home } from './helpers.mjs'

test('real Cordis activation tracks tools and removes registrations on unload', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const fiber = ctx.plugin(vault, { profiles: ['web'], timeoutMs: 5000 })
  assert.equal(ctx.get('tools'), undefined)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, {})
  await fiber
  assert.deepEqual(ctx.tools.schemas().map(tool => tool.name).sort(), ['vault_backup', 'vault_list', 'vault_preview'])
  assert.ok(!JSON.stringify(ctx.tools.schemas()).includes('passphrase'))
  await fiber.dispose()
  assert.deepEqual(ctx.tools.schemas(), [])
})

test('real tool pipeline validates arguments, reports missing secret configuration and honours cancellation', async t => {
  const original = { DSH_HOME: process.env.DSH_HOME, DSH_VAULT_WEBDAV_URL: process.env.DSH_VAULT_WEBDAV_URL, DSH_VAULT_PASSPHRASE: process.env.DSH_VAULT_PASSPHRASE }
  process.env.DSH_HOME = await home(t, true)
  process.env.DSH_VAULT_WEBDAV_URL = 'https://unused.invalid/vault/'
  delete process.env.DSH_VAULT_PASSPHRASE
  t.after(() => { for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value } })
  const ctx = new Context(); t.after(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt, {}); await ctx.plugin(ToolRuntime, {}); await ctx.plugin(vault, {})
  const execute = (name, args, signal = new AbortController().signal) => ctx.tools.execute({ callId: 'test-vault-call', name, arguments: args, signal })
  const invalid = await execute('vault_preview', { id: 123 })
  assert.equal(invalid.isError, true)
  const missing = await execute('vault_backup', {})
  assert.equal(missing.isError, true)
  assert.match(JSON.stringify(missing.content), /DSH_VAULT_PASSPHRASE/)
  const controller = new AbortController(); controller.abort()
  const cancelled = await execute('vault_list', {}, controller.signal)
  assert.equal(cancelled.isError, true)
})

test('Standard Schema configuration validates defaults and rejects plaintext secrets and invalid tunables', () => {
  const validate = vault.Config['~standard'].validate
  assert.deepEqual(validate({}).value, { profiles: ['web'], includeHomePatch: false, timeoutMs: 30000 })
  for (const config of [{ profiles: [] }, { profiles: ['../escape'] }, { profiles: ['web', 'web'] }, { timeoutMs: -1 }, { password: 'must-not-be-configured-here' }, { includeHomePatch: 'yes' }]) assert.ok(validate(config).issues)
})
