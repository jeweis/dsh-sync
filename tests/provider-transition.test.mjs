import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir,writeFile,readFile,symlink,readdir } from 'node:fs/promises'
import { join,dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import Local from '@deepseek-ai/dsh-credentials-local'
import Atomic from '../src/atomic-credentials.mjs'
import { providerPreview,providerTransition } from '../src/provider-transition.mjs'
import { readManaged,writeManaged } from '../src/files.mjs'
import { home,passphrase } from './helpers.mjs'
import { RUNTIME } from '../src/snapshot.mjs'
import { main } from '../src/cli.mjs'
const packageName=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).name
const require=createRequire(import.meta.url),root=fileURLToPath(new URL('..',import.meta.url)),ref='FIXTURE_TRANSITION_KEY',first='fixture-initial-key',latest='fixture-latest-key'
import { transitionFixture } from './provider-fixture.mjs'


test('online preview is read-only, covers all profiles, exposes no key or reusable content fingerprints, and emits a reversible provider recipe',async t=>{
 const f=await transitionFixture(t),before=await readFile(join(f.home,'.credentials.yaml'))
 const result=await providerPreview(f.options)
 assert.ok(!result.providerPlan.blocked,JSON.stringify(result));assert.equal(result.providerPlan.profiles.length,2)
 assert.deepEqual(result.providerPlan.refs,[ref]);assert.equal(result.providerPlan.storage,'.credentials.yaml')
 assert.ok(result.providerPlan.profiles.every(x=>x.from==='@deepseek-ai/dsh-credentials-local'&&x.to===`${packageName}/credentials-provider`))
 const json=JSON.stringify(result);assert.ok(!json.includes(first));assert.ok(!json.includes('Hash'));assert.ok(!json.includes('token'))
 assert.deepEqual(await readFile(join(f.home,'.credentials.yaml')),before)
 assert.ok(!(await readdir(f.home)).includes('config-vault'))
})

test('offline setup requires fresh confirmation and both stop declarations; latest managed keys survive rollback and unrelated patch edits',async t=>{
 const f=await transitionFixture(t),plan=await f.preview()
 await assert.rejects(f.preview({token:plan.token}),/offline-required/)
 await assert.rejects(f.preview({token:plan.token,offline:true}),/offline-required/)
 assert.equal((await f.apply()).status,'enabled')
 for(const profile of ['a','b'])assert.match(await readManaged(f.home,`profiles/${profile}/cordis.patch.yml`),/dsh-vault-atomic-credentials/)
 const atomic=await f.mount(Atomic);assert.equal((await atomic.credentials.resolve(ref)).value,first)
 await atomic.credentials.set(ref,latest);await atomic.fiber.dispose()
 const extra='\n- id: deepseek\n  config:\n    apiKeyEnv: FIXTURE_TRANSITION_KEY\n    reasoningEffort: high\n'
 await writeManaged(f.home,'profiles/a/cordis.patch.yml',(await readManaged(f.home,'profiles/a/cordis.patch.yml'))+extra)
 const rollback=await f.preview({mode:'rollback'});assert.ok(!JSON.stringify(rollback).includes(latest));assert.equal(rollback.credentialAction,'preserve-current-keys')
 assert.equal((await f.apply({mode:'rollback'})).status,'rolled-back')
 const native=await f.mount(Local);assert.equal((await native.credentials.resolve(ref)).value,latest)
 assert.ok(!(await native.credentials.listRecords()).some(x=>x.key.startsWith('dsh-config-vault-refs/')));await native.fiber.dispose()
 assert.match(await readManaged(f.home,'profiles/a/cordis.patch.yml'),/reasoningEffort: high/)
 assert.ok(!(await readManaged(f.home,'profiles/a/cordis.patch.yml')).includes('dsh-vault-atomic-credentials'))
 assert.equal((await providerPreview({...f.options,mode:'rollback'})).providerPlan.reason,'provider-no-transition')
 // Re-enabling cannot resurrect an old internal Key record.
 await f.apply();const again=await f.mount(Atomic);assert.equal((await again.credentials.resolve(ref)).value,latest);await again.fiber.dispose()
})

test('tombstones remain unset after returning to the native provider instead of reviving the old key',async t=>{
 const f=await transitionFixture(t);await f.apply()
 const atomic=await f.mount(Atomic);await atomic.credentials.unset(ref);await atomic.fiber.dispose()
 await f.apply({mode:'rollback'})
 const native=await f.mount(Local);assert.equal(await native.credentials.resolve(ref),undefined);await native.fiber.dispose()
})

test('stale profile or credential previews cannot apply; owned patch edits fail closed',async t=>{
 const f=await transitionFixture(t),plan=await f.preview()
 const native=await f.mount(Local);await native.credentials.set(ref,latest);await native.fiber.dispose()
 await assert.rejects(f.preview({token:plan.token,offline:true,allWritersStopped:true}),/stale-plan/)
 const fresh=await f.preview();await writeManaged(f.home,'profiles/a/cordis.patch.yml','# external edit\n[]\n')
 await assert.rejects(f.preview({token:fresh.token,offline:true,allWritersStopped:true}),/stale-plan/)
 await f.apply()
 const text=await readManaged(f.home,'profiles/a/cordis.patch.yml');await writeManaged(f.home,'profiles/a/cordis.patch.yml',text.replace('managedRefs:', 'unexpectedField:'))
 await assert.rejects(f.preview({mode:'rollback'}),/unsupported-config|owned-patch-changed/)
})

test('an interrupted multi-profile switch retains an encrypted journal and offline rollback recovers the partially switched home',async t=>{
 const f=await transitionFixture(t)
 await assert.rejects(f.apply({onProgress:async()=>{throw new Error('fixture interrupted')}}),/provider-operation-failed/)
 const receipt=JSON.parse(await readManaged(f.home,'config-vault/provider-receipt.json'));assert.equal(receipt.phase,'switching')
 const journal=await readManaged(f.home,'config-vault/provider-transition.vault');assert.ok(!journal.includes(first))
 const atomic=await f.mount(Atomic);await atomic.credentials.set(ref,latest);await atomic.fiber.dispose()
 await f.apply({mode:'rollback'})
 for(const profile of ['a','b'])assert.ok(!(await readManaged(f.home,`profiles/${profile}/cordis.patch.yml`)).includes('dsh-vault-atomic-credentials'))
 const native=await f.mount(Local);assert.equal((await native.credentials.resolve(ref)).value,latest);await native.fiber.dispose()
})

test('unsupported stores, missing packages, overlays and symlinks are blocked before any mutation',async t=>{
 const f=await transitionFixture(t)
 assert.equal((await providerPreview({...f.options,overlays:[{}]})).providerPlan.reason,'provider-context-required')
 assert.equal((await providerPreview({...f.options,refs:['DSH_VAULT_WEBDAV_PASSWORD']})).providerPlan.reason,'provider-invalid-references')
 const path=join(f.home,'profiles/a/node_modules/transition-fixture-bundle/cordis.patch.yml'),raw=await readFile(path,'utf8')
 await writeFile(path,raw.replace(f.home,'/outside-fixture-home'))
 assert.equal((await providerPreview(f.options)).providerPlan.reason,'provider-external-storage')
 await writeFile(path,raw)
 await symlink(join(f.home,'profiles/a'),join(f.home,'profiles/linked'))
 assert.equal((await providerPreview(f.options)).providerPlan.reason,'provider-unsupported-config')
})

test('CLI provider commands preview without applying, sanitize failures and preserve the offline confirmation boundary',async t=>{
 const f=await transitionFixture(t),previous=process.env.DSH_VAULT_PASSPHRASE
 process.env.DSH_VAULT_PASSPHRASE=passphrase;t.after(()=>{if(previous===undefined)delete process.env.DSH_VAULT_PASSPHRASE;else process.env.DSH_VAULT_PASSPHRASE=previous})
 const args=['--home',f.home,'--install-anchor',f.anchor,'--mode','enable']
 const plan=await main(['provider-preview',...args]);assert.equal(plan.mode,'enable');assert.ok(!JSON.stringify(plan).includes(first))
 await assert.rejects(main(['provider-switch',...args,'--confirm',plan.token]),/offline-required/)
 const result=await main(['provider-switch',...args,'--confirm',plan.token,'--offline','--all-writers-stopped']);assert.equal(result.status,'enabled')
 await assert.rejects(main(['provider-preview',...args,'--mode','unknown']),/provider-invalid-request/)
})

test('snapshot restore and provider transitions share an offline mutation lock',async t=>{
 const f=await transitionFixture(t),{restoreLock}=await import('../src/restore.mjs')
 const release=await restoreLock(f.home)
 try {await assert.rejects(f.apply(),/provider-busy/)}finally{await release()}
 assert.equal((await f.apply()).status,'enabled')
})

test('an interrupted rollback can resume and retains the newest key across partially restored profiles',async t=>{
 const f=await transitionFixture(t);await f.apply()
 const atomic=await f.mount(Atomic);await atomic.credentials.set(ref,latest);await atomic.fiber.dispose()
 await assert.rejects(f.apply({mode:'rollback',onProgress:async()=>{throw new Error('fixture rollback interruption')}}),/operation-failed/)
 assert.equal(JSON.parse(await readManaged(f.home,'config-vault/provider-receipt.json')).phase,'rolling-back')
 await f.apply({mode:'rollback'})
 const native=await f.mount(Local);assert.equal((await native.credentials.resolve(ref)).value,latest);await native.fiber.dispose()
})

test('a rollback preview becomes stale after a user rotates a key and only exact managed records are retired',async t=>{
 const f=await transitionFixture(t);await f.apply()
 let atomic=await f.mount(Atomic);await atomic.credentials.set(ref,latest);await atomic.fiber.dispose()
 const preview=await f.preview({mode:'rollback'})
 atomic=await f.mount(Atomic);await atomic.credentials.set(ref,'fixture-even-newer-key');await atomic.credentials.modifyRecord('dsh-config-vault-refs/not-the-owned-slot',async()=>({kind:'grant',payload:{ref,value:'unrelated-opaque-data'}}));await atomic.fiber.dispose()
 await assert.rejects(f.preview({mode:'rollback',token:preview.token,offline:true,allWritersStopped:true}),/stale-plan/)
 await f.apply({mode:'rollback'})
 const native=await f.mount(Local)
 assert.equal((await native.credentials.resolve(ref)).value,'fixture-even-newer-key')
 assert.ok(await native.credentials.readRecord('dsh-config-vault-refs/not-the-owned-slot'));await native.fiber.dispose()
})

test('credential store paths cannot overlap transition journals or profile configuration',async t=>{
 const f=await transitionFixture(t),path=join(f.home,'profiles/a/node_modules/transition-fixture-bundle/cordis.patch.yml'),raw=await readFile(path,'utf8')
 const data=JSON.parse(raw);data[0].insert[0].config={path:join(f.home,'config-vault/provider-transition.vault')}
 await writeFile(path,JSON.stringify(data))
 assert.equal((await providerPreview(f.options)).providerPlan.reason,'provider-external-storage')
})


test('renamed package recognizes legacy provider recipes and rolls back without losing the latest key',async t=>{
 const {seal,unseal}=await import('../src/crypto.mjs'),f=await transitionFixture(t)
 await f.apply()
 const oldName='dsh-config-vault/credentials-provider',newName=`${packageName}/credentials-provider`
 const journalPath='config-vault/provider-transition.vault',receiptPath='config-vault/provider-receipt.json'
 const journal=await unseal(Buffer.from(await readManaged(f.home,journalPath)),passphrase)
 const convert=value=>JSON.parse(JSON.stringify(value).replaceAll(newName,oldName))
 for(const change of journal.changes){
   const before=await readManaged(f.home,change.path)
   await writeManaged(f.home,change.path,before.replaceAll(newName,oldName))
 }
 await writeManaged(f.home,journalPath,await seal(convert(journal),passphrase))
 await writeManaged(f.home,receiptPath,JSON.stringify(convert(JSON.parse(await readManaged(f.home,receiptPath)))))
 const ctx=await f.mount(Atomic);await ctx.credentials.set(ref,latest);await ctx.fiber.dispose()
 const plan=(await providerPreview({...f.options,mode:'rollback'})).providerPlan
 assert.ok(!plan.blocked,JSON.stringify(plan));assert.ok(plan.profiles.every(x=>x.from===oldName))
 assert.equal((await f.apply({mode:'rollback'})).status,'rolled-back')
 const native=await f.mount(Local);assert.equal((await native.credentials.resolve(ref)).value,latest);await native.fiber.dispose()
})
