import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { stat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import AtomicCredentialProvider from '../src/atomic-credentials.mjs'
import { REFERENCE_CAS, referenceCAS } from '../src/credential-cas.mjs'
import { HarnessSyncAdapter } from '../src/sync-adapter.mjs'
import { LiveSync } from '../src/sync.mjs'
import { home, dav, passphrase } from './helpers.mjs'
const execFile = promisify(execFileCallback)
const ref = 'FIXTURE_ATOMIC_API_KEY', first='fixture-key-one', second='fixture-key-two', third='fixture-key-three'
async function mount(t, directory, Provider=AtomicCredentialProvider, extra={}) {
  const ctx=new Context()
  ctx.provide('launchEnvironment',createLaunchEnvironmentSnapshot([{source:'process',values:extra.environment??{}}]))
  await ctx.plugin(Provider,{dshHome:directory,watch:false,...Provider===AtomicCredentialProvider?{managedRefs:[ref]}:{}})
  t.after(()=>ctx.fiber.dispose())
  return ctx
}

test('atomic provider preserves the Harness credential API, generation CAS detects same-value writes and unset does not resurrect legacy file keys',async t=>{
  const directory=await home(t),legacy=await mount(t,directory,LocalCredentialProvider)
  await legacy.credentials.set(ref,first);await legacy.fiber.dispose()
  const ctx=await mount(t,directory,AtomicCredentialProvider,{environment:{[ref]:'fixture-env-fallback'}}),c=ctx.credentials,cap=c[REFERENCE_CAS]
  assert.equal((await c.resolve(ref)).value,first)
  const initial=await cap.snapshot(ref)
  await c.set(ref,second)
  await assert.rejects(cap.compareAndSet(ref,initial,third),/sync-local-changed/)
  assert.equal((await c.resolve(ref)).value,second)
  const same=await cap.snapshot(ref)
  await c.set(ref,second) // an intentional save of the same bytes still advances the generation
  await assert.rejects(cap.compareAndSet(ref,same,third),/sync-local-changed/)
  await c.unset(ref);assert.equal((await c.resolve(ref)).value,'fixture-env-fallback')
  const empty=await cap.snapshot(ref);await cap.compareAndSet(ref,empty,third)
  assert.equal((await c.resolve(ref)).value,third)
  await c.set('OTHER_FIXTURE_KEY',first);assert.equal(referenceCAS(c,'OTHER_FIXTURE_KEY'),null)
  assert.equal((await c.resolve('OTHER_FIXTURE_KEY')).value,first)
  assert.equal(referenceCAS(c,'DSH_VAULT_WEBDAV_PASSWORD'),null)
  await assert.rejects(cap.compareAndSet('OTHER_FIXTURE_KEY',empty,second),/unmanaged-reference/)
})

test('a second process saving through the provider cannot be overwritten by a stale CAS, even with watchers disabled',async t=>{
  const directory=await home(t),ctx=await mount(t,directory),c=ctx.credentials,cap=c[REFERENCE_CAS]
  await c.set(ref,first);const before=await cap.snapshot(ref)
  const code=`import {Context} from '@deepseek-ai/cordis';import Provider from './src/atomic-credentials.mjs';const ctx=new Context();try{await ctx.plugin(Provider,{dshHome:process.argv[1],watch:false,managedRefs:['FIXTURE_ATOMIC_API_KEY']});await ctx.credentials.set('FIXTURE_ATOMIC_API_KEY','fixture-key-two')}finally{await ctx.fiber.dispose()}`
  await execFile(process.execPath,['--input-type=module','-e',code,directory],{cwd:new URL('..',import.meta.url),env:{PATH:process.env.PATH}})
  await assert.rejects(cap.compareAndSet(ref,before,third),/sync-local-changed/)
  assert.equal((await c.resolve(ref)).value,second)
  const refreshed=await cap.snapshot(ref);await cap.compareAndSet(ref,refreshed,third)
  assert.equal((await c.resolve(ref)).value,third)
})

test('read-only snapshots and cached request resolution do not rewrite the credential store; notifications remain reference-shaped',async t=>{
  const ctx=await mount(t,await home(t)),c=ctx.credentials,events=[]
  ctx.on('credentials/reference-updated',name=>events.push(name))
  await c.set(ref,first);assert.ok(events.includes(ref))
  const directory=ctx.credentials.config.dshHome,file=join(directory,'.credentials.yaml'),before=await readFile(file),mtime=(await stat(file,{bigint:true})).mtimeNs
  for(let i=0;i<50;i++)assert.equal((await c.resolve(ref)).value,first)
  await c[REFERENCE_CAS].snapshot(ref)
  assert.deepEqual(await readFile(file),before);assert.equal((await stat(file,{bigint:true})).mtimeNs,mtime)
  await c.unset(ref);assert.equal(await c.resolve(ref),undefined)
  assert.ok(events.every(value=>value===ref));assert.ok(!JSON.stringify(events).includes(first))
})

async function syncDevice(t,server,Provider=AtomicCredentialProvider) {
  const directory=await home(t),ctx=await mount(t,directory,Provider)
  const getContext=()=>({get:name=>name==='credentials'?ctx.credentials:name==='settings'?{describe:()=>[{ns:'deepseek-key',value:{apiKeyEnv:ref}}]}:name==='configEditor'?{entries:()=>[{options:{name:'@deepseek-ai/dsh-llm-deepseek-api-key',id:'deepseek-key'}}]}:undefined})
  const adapter=new HarnessSyncAdapter({home:directory,profile:'web',getContext})
  return {home:directory,ctx,adapter,worker:new LiveSync({home:directory,profile:'web',adapter,connection:async()=>server.remote})}
}

test('two devices automatically receive reference rotations through CAS and keep real user edits as masked conflicts',async t=>{
  const server=await dav(t),a=await syncDevice(t,server),b=await syncDevice(t,server)
  const config={url:server.options.url,username:'test-user',sync:{enabled:true,apiKeys:true,space:'atomic',categories:[],intervalMs:180000}}
  const step=d=>d.worker.step({config,passphrase,force:true})
  const choose=(d,choice)=>d.worker.step({config,passphrase,force:true,resolution:{token:d.worker.status.token,choices:Object.fromEntries(d.worker.status.changes.map(x=>[x.id,choice]))}})
  await a.ctx.credentials.set(ref,first)
  await step(a);await choose(a,'local');assert.equal(a.worker.status.phase,'synced')
  await step(b);assert.ok(!b.worker.status.changes[0].manualRemote);await choose(b,'remote')
  assert.equal(b.worker.status.phase,'synced',JSON.stringify(b.worker.status));assert.equal((await b.ctx.credentials.resolve(ref)).value,first)
  await a.ctx.credentials.set(ref,second);await step(a);await step(b)
  assert.equal(b.worker.status.phase,'synced');assert.equal((await b.ctx.credentials.resolve(ref)).value,second)
  await a.ctx.credentials.set(ref,first);await step(a)
  await b.ctx.credentials.set(ref,second);await step(b)
  assert.equal(b.worker.status.phase,'conflict');assert.equal((await b.ctx.credentials.resolve(ref)).value,second)
  await choose(b,'remote')
  await a.ctx.credentials.set(ref,second);await b.ctx.credentials.set(ref,third);await step(a);await step(b)
  assert.equal(b.worker.status.phase,'conflict');assert.equal((await b.ctx.credentials.resolve(ref)).value,third)
  const token=b.worker.status.token,choices=Object.fromEntries(b.worker.status.changes.map(x=>[x.id,'remote']))
  await b.ctx.credentials.set(ref,third)
  await b.worker.step({config,passphrase,force:true,resolution:{token,choices}})
  assert.equal(b.worker.status.error,'sync-stale-preview');assert.equal((await b.ctx.credentials.resolve(ref)).value,third)
  for(const value of [first,second,third])assert.ok(!JSON.stringify(b.worker.status).includes(value))
  await step(b);await choose(b,'remote');assert.equal((await b.ctx.credentials.resolve(ref)).value,second)
})

test('ordinary providers remain manual; selecting the optional provider resumes an existing pending reference without resetting user values',async t=>{
  const server=await dav(t),a=await syncDevice(t,server),b=await syncDevice(t,server,LocalCredentialProvider)
  const config={url:server.options.url,username:'test-user',sync:{enabled:true,apiKeys:true,space:'upgrade',categories:[],intervalMs:180000}}
  const step=d=>d.worker.step({config,passphrase,force:true})
  const choose=(d,choice)=>d.worker.step({config,passphrase,force:true,resolution:{token:d.worker.status.token,choices:Object.fromEntries(d.worker.status.changes.map(x=>[x.id,choice]))}})
  await a.ctx.credentials.set(ref,first);await b.ctx.credentials.set(ref,second)
  await step(a);await choose(a,'local');await step(b);await choose(b,'remote')
  assert.equal(b.worker.status.phase,'pending');assert.equal((await b.ctx.credentials.resolve(ref)).value,second)
  await b.ctx.fiber.dispose()
  const upgraded=await mount(t,b.home)
  b.adapter.getContext=()=>({get:name=>name==='credentials'?upgraded.credentials:name==='settings'?{describe:()=>[{ns:'deepseek-key',value:{apiKeyEnv:ref}}]}:name==='configEditor'?{entries:()=>[{options:{name:'@deepseek-ai/dsh-llm-deepseek-api-key',id:'deepseek-key'}}]}:undefined})
  await step(b);assert.equal(b.worker.status.phase,'join');assert.equal((await upgraded.credentials.resolve(ref)).value,second)
  await choose(b,'remote');assert.equal(b.worker.status.phase,'synced');assert.equal((await upgraded.credentials.resolve(ref)).value,first)
})

test('provider configuration and corrupted private records fail closed',async t=>{
  for(const managedRefs of [[],['DSH_VAULT_WEBDAV_PASSWORD'],['DSH_VAULT_PASSPHRASE'],['BAD REF'],[ref,ref]])assert.ok(AtomicCredentialProvider.Config['~standard'].validate({managedRefs}).issues)
  const ctx=await mount(t,await home(t)),c=ctx.credentials
  await c.set(ref,first)
  const key=(await c.listRecords()).find(x=>x.key.startsWith('dsh-config-vault-refs/')).key
  await c.modifyRecord(key,async()=>({kind:'grant',payload:{unsupported:true}}))
  await assert.rejects(c[REFERENCE_CAS].snapshot(ref),/invalid-record/)
  await assert.rejects(c.set(ref,second),/invalid-record/)
})

test('a user save in another process while CAS holds the record lock commits afterwards and remains the final value',async t=>{
  const directory=await home(t),ctx=await mount(t,directory),c=ctx.credentials,cap=c[REFERENCE_CAS]
  await c.set(ref,first);const before=await cap.snapshot(ref)
  let entered,release
  const inside=new Promise(resolve=>{entered=resolve}),gate=new Promise(resolve=>{release=resolve})
  const view=c.view.bind(c)
  c.view=async(...args)=>{const result=await view(...args);entered();await gate;return result}
  const cas=cap.compareAndSet(ref,before,third)
  await inside
  const {spawn}=await import('node:child_process')
  const code=`import {Context} from '@deepseek-ai/cordis';import Provider from './src/atomic-credentials.mjs';const ctx=new Context();try{await ctx.plugin(Provider,{dshHome:process.argv[1],watch:false,managedRefs:['FIXTURE_ATOMIC_API_KEY']});process.stdout.write('attempt\\n');await ctx.credentials.set('FIXTURE_ATOMIC_API_KEY','fixture-key-two')}finally{await ctx.fiber.dispose()}`
  const child=spawn(process.execPath,['--input-type=module','-e',code,directory],{cwd:new URL('..',import.meta.url),env:{PATH:process.env.PATH},stdio:['ignore','pipe','pipe']})
  const attempted=new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);child.once('exit',code=>{if(code)reject(new Error('fixture writer failed'))})})
  const done=new Promise((resolve,reject)=>{child.once('exit',code=>code===0?resolve():reject(new Error('fixture writer failed')));child.once('error',reject)})
  try { await attempted;release();await cas;await done } finally {release();child.kill()}
  c.view=view
  // Parent watcher is off: the authoritative read must reconcile the child's committed value.
  assert.equal((await cap.snapshot(ref)).value,second)
})
