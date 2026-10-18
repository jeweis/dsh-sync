import test from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { HarnessSyncAdapter, itemId, validateItems } from '../src/sync-adapter.mjs'
import { LiveSync } from '../src/sync.mjs'
import { VaultSettingsService } from '../src/ui-service.mjs'
import { validatePreferences, loadPreferences, savePreferences } from '../src/settings.mjs'
import { unseal } from '../src/crypto.mjs'
import { home, dav, passphrase } from './helpers.mjs'
const DEEPSEEK = '@deepseek-ai/dsh-llm-deepseek-api-key', PI = '@deepseek-ai/dsh-llm-pi-ai'
const keyItem = key => ({module:DEEPSEEK,ns:'deepseek-key',field:'api-key',category:'apiKeys',value:{key}})
// These are deliberately synthetic; no real profile, environment or remote credentials are read.
const first='fixture-api-key-alpha', second='fixture-api-key-beta', third='fixture-api-key-gamma'
function plane() {
  const refs=new Map(),records=new Map(),reads=[],writes=[]
  return {refs,records,reads,writes,writable:true,
    async describe(ref){return {configured:refs.has(ref),writable:this.writable,source:'file'}},
    async resolve(ref){reads.push(ref);return refs.has(ref)?{value:refs.get(ref),source:'file'}:undefined},
    async set(ref,value){writes.push(ref);refs.set(ref,value)},
    async describeRecord(key){return {configured:records.has(key),kind:records.get(key)?.kind,writable:this.writable}},
    async listRecords(){return [...records].map(([key,value])=>({key,kind:value.kind}))},
    async readRecord(key){reads.push(key);return structuredClone(records.get(key))},
    async modifyRecord(key,mutate){if(this.beforeModify)await this.beforeModify(key);const value=await mutate(structuredClone(records.get(key)));if(value){writes.push(key);records.set(key,value)}return value},
  }
}
async function device(t,server) {
  const directory=await home(t,true), credentials=plane()
  let preference='dark', revision=0
  const rows=[{options:{name:DEEPSEEK,id:'deepseek-key'}},{options:{name:PI,id:'pi'}},{options:{name:'@deepseek-ai/dsh-client-ui-theme',id:'theme'}}]
  const views=()=>[
    {ns:'deepseek-key',value:{apiKeyEnv:'FIXTURE_DEEPSEEK_KEY'}},
    {ns:'pi',value:{providers:{custom:{apiKeyEnv:'FIXTURE_CUSTOM_KEY'}}}},
    {ns:'theme',applies:'live',schema:{dict:{preference:{}}},user:{preference},value:{preference},revision},
  ]
  const ctx={get:name=>({credentials,settings:{describe:views,mutate:async(_ns,ops)=>{preference=ops[0].value;revision++}},configEditor:{entries:()=>rows}}[name])}
  const adapter=new HarnessSyncAdapter({home:directory,profile:'web',getContext:()=>ctx})
  return {home:directory,credentials,adapter,rows,views,ctx,setTheme:value=>{preference=value;revision++},worker:new LiveSync({home:directory,profile:'web',adapter,connection:async()=>server.remote})}
}
async function fixture(t) {
  const server=await dav(t),a=await device(t,server),b=await device(t,server)
  const config={url:server.options.url,username:'test-user',profiles:['web'],includeHomePatch:false,timeoutMs:30000,encryption:false,sync:{enabled:true,apiKeys:true,space:'keys',categories:['appearance'],intervalMs:180000}}
  const step=(d,extra={})=>d.worker.step({config,passphrase,force:true,...extra})
  const choose=(d,choice)=>step(d,{resolution:{token:d.worker.status.token,choices:Object.fromEntries(d.worker.status.changes.map(item=>[item.id,choice]))}})
  return {server,a,b,config,step,choose}
}

test('API key opt-in defaults off, rejects malformed options and does not access credentials while off or locked', async t=>{
  const f=await fixture(t), config=structuredClone(f.config);delete config.sync.apiKeys
  assert.equal(validatePreferences(config).sync.apiKeys,undefined)
  assert.deepEqual(validatePreferences({...config,sync:{...config.sync,apiKeys:true,categories:[]}}).sync.categories,[])
  assert.throws(()=>validatePreferences({...config,sync:{...config.sync,apiKeys:'true'}}),/invalid-settings/)
  assert.throws(()=>validatePreferences({...config,sync:{...config.sync,categories:['apiKeys']}}),/invalid-settings/)
  await f.step(f.a,{config});await f.step(f.a,{config,passphrase:undefined})
  assert.equal(f.a.credentials.reads.length,0);assert.equal(f.a.credentials.writes.length,0)
  await f.step(f.a,{config:{...f.config,sync:{...f.config.sync,enabled:false}}})
  assert.equal(f.a.credentials.reads.length,0)
  f.a.credentials.refs.set('FIXTURE_DEEPSEEK_KEY',first)
  await f.step(f.a,{config:{...f.config,sync:{...f.config.sync,categories:[]}}})
  assert.equal(f.a.worker.status.phase,'join')
  assert.ok(f.a.worker.status.changes.length && f.a.worker.status.changes.every(item=>item.category==='apiKeys'))
})

test('two devices manually reconcile references and atomically sync records encrypted even with plaintext backup mode; previews and DTOs are masked',async t=>{
  const f=await fixture(t)
  f.a.credentials.refs.set('FIXTURE_DEEPSEEK_KEY',first)
  f.a.credentials.refs.set('FIXTURE_CUSTOM_KEY',second)
  f.a.credentials.records.set('llm-pi-ai/openai',{kind:'api-key',key:third,env:{LOCAL_ONLY:'source-env'}})
  f.a.credentials.records.set('llm-pi-ai/oauth',{kind:'grant',payload:{access_token:'fixture-oauth-never-read'}})
  f.a.credentials.records.set('other-owner/secret',{kind:'api-key',key:'fixture-other-never-read'})
  await f.step(f.a);assert.equal(f.a.worker.status.phase,'join')
  const preview=f.a.worker.status.changes.find(x=>x.category==='apiKeys')
  assert.deepEqual(preview.local,{configured:true});assert.equal(preview.remote,null)
  for(const value of [first,second,third,'fixture-oauth-never-read'])assert.ok(!JSON.stringify(f.a.worker.status).includes(value))
  await f.choose(f.a,'local');assert.equal(f.a.worker.status.phase,'synced')
  await f.step(f.b);assert.equal(f.b.worker.status.phase,'join');assert.equal(f.b.credentials.writes.length,0)
  const service=new VaultSettingsService({home:f.b.home,profile:'web',credentials:{describe:async()=>({configured:true,writable:true})},environment:{DSH_VAULT_PASSPHRASE:passphrase},syncAdapter:f.b.adapter})
  t.after(()=>service.dispose());await savePreferences(f.b.home,f.config,(await loadPreferences(f.b.home,{})).revision,{})
  service.sync=f.b.worker
  for(const value of [first,second,third])assert.ok(!JSON.stringify(await service.state()).includes(value))
  await f.choose(f.b,'remote');assert.equal(f.b.worker.status.phase,'pending',JSON.stringify(f.b.worker.status))
  assert.equal(f.b.credentials.refs.get('FIXTURE_DEEPSEEK_KEY'),undefined)
  assert.equal(f.b.credentials.refs.get('FIXTURE_CUSTOM_KEY'),undefined)
  assert.ok(f.b.worker.status.pending.every(x=>x.reason==='reference-manual'))
  f.b.credentials.refs.set('FIXTURE_DEEPSEEK_KEY',first);f.b.credentials.refs.set('FIXTURE_CUSTOM_KEY',second)
  await f.step(f.b);assert.equal(f.b.worker.status.phase,'synced')
  assert.deepEqual(f.b.credentials.records.get('llm-pi-ai/openai'),{kind:'api-key',key:third})
  assert.ok(!f.a.credentials.reads.includes('llm-pi-ai/oauth'));assert.ok(!f.a.credentials.reads.includes('other-owner/secret'))
  for(const bytes of f.server.objects.values())for(const value of [first,second,third,'source-env'])assert.ok(!bytes.toString().includes(value))
  const file=(await readdir(join(f.b.home,'config-vault'))).find(x=>x.endsWith('.vault')), bytes=await readFile(join(f.b.home,'config-vault',file))
  assert.ok(!bytes.toString().includes(first));const state=await unseal(bytes,passphrase);assert.ok(state.history.length)
  f.b.credentials.refs.set('FIXTURE_DEEPSEEK_KEY',second);await f.step(f.b);await f.step(f.a)
  assert.equal(f.a.credentials.refs.get('FIXTURE_DEEPSEEK_KEY'),first)
  assert.equal(f.a.worker.status.phase,'pending')
  f.a.credentials.refs.set('FIXTURE_DEEPSEEK_KEY',second);await f.step(f.a)
  const restarted=new LiveSync({home:f.a.home,profile:'web',adapter:f.a.adapter,connection:async()=>f.server.remote})
  await restarted.step({config:f.config,passphrase,force:true});assert.equal(restarted.status.phase,'synced')
})

test('credential rotation conflicts require a fresh masked choice; disabling key sync preserves encrypted cloud keys without credential reads',async t=>{
  const f=await fixture(t);f.a.credentials.refs.set('FIXTURE_DEEPSEEK_KEY',first)
  await f.step(f.a);await f.choose(f.a,'local');await f.step(f.b);await f.choose(f.b,'remote')
  f.b.credentials.refs.set('FIXTURE_DEEPSEEK_KEY',first);await f.step(f.b)
  f.a.credentials.refs.set('FIXTURE_DEEPSEEK_KEY',second);f.b.credentials.refs.set('FIXTURE_DEEPSEEK_KEY',third)
  await f.step(f.a);await f.step(f.b);assert.equal(f.b.worker.status.phase,'conflict')
  assert.deepEqual(f.b.worker.status.changes[0].local,{configured:true});assert.deepEqual(f.b.worker.status.changes[0].remote,{configured:true})
  const token=f.b.worker.status.token, choices=Object.fromEntries(f.b.worker.status.changes.map(x=>[x.id,'remote']))
  f.b.credentials.refs.set('FIXTURE_DEEPSEEK_KEY','fixture-newer-key')
  await f.step(f.b,{resolution:{token,choices}});assert.equal(f.b.worker.status.error,'sync-stale-preview')
  assert.equal(f.b.credentials.refs.get('FIXTURE_DEEPSEEK_KEY'),'fixture-newer-key')
  await f.step(f.b);await f.choose(f.b,'remote');assert.equal(f.b.credentials.refs.get('FIXTURE_DEEPSEEK_KEY'),'fixture-newer-key')
  assert.equal(f.b.worker.status.phase,'pending')
  f.b.credentials.refs.set('FIXTURE_DEEPSEEK_KEY',second);await f.step(f.b)
  const off={...f.config,sync:{...f.config.sync,apiKeys:false}}, count=f.b.credentials.reads.length
  f.b.setTheme('light');await f.step(f.b,{config:off});assert.equal(f.b.credentials.reads.length,count)
  await f.step(f.b,{config:off})
  const changes=f.b.worker.status.changes
  if(changes.length)await f.step(f.b,{config:off,resolution:{token:f.b.worker.status.token,choices:Object.fromEntries(changes.map(x=>[x.id,'local']))}})
  const before=f.b.credentials.reads.length;await f.step(f.b,{config:off});assert.equal(f.b.credentials.reads.length,before)
  assert.ok(before>=count)
  const cloud=await unseal([...f.server.objects.values()][0],passphrase)
  assert.equal(cloud.items.find(x=>x.module===DEEPSEEK).value.key,second)
})

test('missing, read-only and OAuth credentials never erase or overwrite local credentials; record RMW detects a concurrent rotation',async t=>{
  const f=await fixture(t);f.a.credentials.refs.set('FIXTURE_DEEPSEEK_KEY',first)
  f.a.credentials.records.set('llm-pi-ai/openai',{kind:'api-key',key:first})
  f.b.credentials.records.set('llm-pi-ai/openai',{kind:'api-key',key:second,env:{LOCAL_ONLY:'keep'}})
  await f.step(f.a);await f.choose(f.a,'local');f.b.credentials.writable=false
  await f.step(f.b);await f.choose(f.b,'remote');assert.equal(f.b.worker.status.phase,'pending');assert.equal(f.b.credentials.writes.length,0)
  assert.ok(f.b.worker.status.pending.every(x=>x.reason==='credentials-readonly'))
  f.b.credentials.writable=true;await f.step(f.b);await f.choose(f.b,'remote')
  assert.equal(f.b.credentials.records.get('llm-pi-ai/openai').env.LOCAL_ONLY,'keep')
  f.b.credentials.refs.set('FIXTURE_DEEPSEEK_KEY',first);await f.step(f.b)
  f.b.credentials.refs.delete('FIXTURE_DEEPSEEK_KEY');await f.step(f.b);assert.ok(f.b.worker.status.pending.some(x=>x.reason==='key-absent'))
  assert.equal(f.a.credentials.refs.get('FIXTURE_DEEPSEEK_KEY'),first)
  const captured=await f.b.adapter.capture(['apiKeys']), item=captured.items.find(x=>x.field==='api-key-record')
  f.b.credentials.beforeModify=async()=>f.b.credentials.records.set('llm-pi-ai/openai',{kind:'api-key',key:third})
  await assert.rejects(f.b.adapter.apply({...item,value:{key:second}},{value:item.value,revision:captured.revisions.get(itemId(item))}),/sync-local-changed/)
  assert.equal(f.b.credentials.records.get('llm-pi-ai/openai').key,third)
  f.b.credentials.records.set('llm-pi-ai/openai',{kind:'grant',payload:{token:'fixture-login'}})
  const keys=await f.b.adapter.capture(['apiKeys'],[item]);assert.ok(!keys.items.some(x=>x.field==='api-key-record'))
})

test('cloud cannot select a credential reference or smuggle arbitrary records; wrong encryption keys never write credentials',async t=>{
  for(const item of [{...keyItem(first),value:{key:first,ref:'ANY_SECRET'}},{...keyItem(first),module:'other-plugin'},{...keyItem(first),field:'DSH_VAULT_WEBDAV_PASSWORD'},{module:PI,ns:'../escape',field:'api-key-record',category:'apiKeys',value:{key:first}}])assert.throws(()=>validateItems([item]),/sync-invalid-data/)
  const f=await fixture(t);f.a.credentials.refs.set('FIXTURE_DEEPSEEK_KEY',first);await f.step(f.a);await f.choose(f.a,'local')
  await f.step(f.b,{passphrase:'fixture-wrong-passphrase'});assert.equal(f.b.worker.status.phase,'error');assert.equal(f.b.credentials.writes.length,0)
  assert.equal(f.b.credentials.reads.length,0)
})

test('a credential failure pauses with encrypted pre-images and masked errors; reserved references stay excluded',async t=>{
  const f=await fixture(t);f.a.credentials.records.set('llm-pi-ai/openai',{kind:'api-key',key:first})
  await f.step(f.a);await f.choose(f.a,'local');await f.step(f.b)
  f.b.credentials.modifyRecord=async()=>{throw new Error(first)}
  await f.choose(f.b,'remote');assert.equal(f.b.worker.status.phase,'uncertain');assert.ok(!JSON.stringify(f.b.worker.status).includes(first))
  const file=(await readdir(join(f.b.home,'config-vault'))).find(x=>x.endsWith('.vault')),bytes=await readFile(join(f.b.home,'config-vault',file))
  assert.ok(!bytes.toString().includes(first));assert.ok((await unseal(bytes,passphrase)).pending)
  const rows=[{options:{name:DEEPSEEK,id:'reserved'}}],ctx={get:name=>name==='credentials'?f.a.credentials:null}
  const {captureKeys}=await import('../src/sync-credentials.mjs')
  for(const ref of ['DSH_VAULT_WEBDAV_PASSWORD','DSH_VAULT_PASSPHRASE','dsh_vault_webdav_password'])assert.equal((await captureKeys(ctx,rows,[{ns:'reserved',value:{apiKeyEnv:ref}}])).items.length,0)
})

test('shared local references reject conflicting cloud keys before mutation, and identical values remain manual until configured',async t=>{
  const f=await fixture(t);f.a.credentials.refs.set('FIXTURE_DEEPSEEK_KEY',first);f.a.credentials.refs.set('FIXTURE_CUSTOM_KEY',second)
  await f.step(f.a);await f.choose(f.a,'local')
  f.b.credentials.refs.set('FIXTURE_DEEPSEEK_KEY',third)
  // Both local routes deliberately point at the same reference, unlike the cloud producer.
  const original=f.b.ctx.get.bind(f.b.ctx)
  f.b.ctx.get=name=>name==='settings'?{describe:()=>f.b.views().map(view=>view.ns==='pi'?{...view,value:{providers:{custom:{apiKeyEnv:'FIXTURE_DEEPSEEK_KEY'}}}}:view)}:original(name)
  await f.step(f.b);await f.choose(f.b,'remote')
  assert.equal(f.b.worker.status.error,'sync-key-alias');assert.equal(f.b.credentials.writes.length,0)
  f.a.credentials.refs.set('FIXTURE_CUSTOM_KEY',first);await f.step(f.a)
  await f.step(f.b);await f.choose(f.b,'remote');assert.equal(f.b.worker.status.phase,'pending',JSON.stringify(f.b.worker.status))
  assert.deepEqual(f.b.credentials.writes,[])
  f.b.credentials.refs.set('FIXTURE_DEEPSEEK_KEY',first);await f.step(f.b);assert.equal(f.b.worker.status.phase,'synced')
})

test('reference receive never invokes unconditional set, including empty targets and a change after the last credential read',async t=>{
  const f=await fixture(t)
  const credentials=f.b.credentials, originalResolve=credentials.resolve.bind(credentials)
  credentials.set=async()=>assert.fail('sync must never call reference set')
  for(const ref of ['FIXTURE_DEEPSEEK_KEY','FIXTURE_CUSTOM_KEY']) {
    for(const previous of [null,first]) {
      if(previous)credentials.refs.set(ref,previous);else credentials.refs.delete(ref)
      const captured=await f.b.adapter.capture(['apiKeys'])
      const item=captured.items.find(x=>ref==='FIXTURE_DEEPSEEK_KEY'?x.module===DEEPSEEK:x.field==='api-key-ref.custom')
      credentials.resolve=async name=>{const old=await originalResolve(name);if(name===ref)credentials.refs.set(ref,third);return old}
      await assert.rejects(f.b.adapter.apply({...item,value:{key:second}},{value:item.value,revision:captured.revisions.get(itemId(item))}),/sync-reference-manual/)
      assert.equal(credentials.refs.get(ref),third)
      credentials.resolve=originalResolve
    }
  }
  assert.equal(credentials.writes.length,0)
})

test('manual reference receive remains pending across polls and restart, does not acknowledge baseline, and resumes only after manual matching update',async t=>{
  const f=await fixture(t);f.a.credentials.refs.set('FIXTURE_DEEPSEEK_KEY',first);f.b.credentials.refs.set('FIXTURE_DEEPSEEK_KEY',second)
  await f.step(f.a);await f.choose(f.a,'local');await f.step(f.b)
  assert.equal(f.b.worker.status.changes[0].manualRemote,true)
  await f.choose(f.b,'remote');assert.equal(f.b.worker.status.phase,'pending')
  const cloudBefore=Buffer.from([...f.server.objects.values()][0])
  await f.step(f.b);assert.equal(f.b.worker.status.phase,'pending');assert.equal(f.b.worker.status.changes.length,0)
  const restarted=new LiveSync({home:f.b.home,profile:'web',adapter:f.b.adapter,connection:async()=>f.server.remote})
  await f.step({...f.b,worker:restarted});assert.equal(restarted.status.phase,'pending')
  assert.equal(f.b.credentials.refs.get('FIXTURE_DEEPSEEK_KEY'),second);assert.deepEqual(f.b.credentials.writes,[])
  assert.deepEqual([...f.server.objects.values()][0],cloudBefore)
  assert.ok(!JSON.stringify(restarted.status).includes(first));assert.ok(!JSON.stringify(restarted.status).includes(second))
  const name=(await readdir(join(f.b.home,'config-vault'))).find(x=>x.endsWith('.vault'))
  const state=await unseal(await readFile(join(f.b.home,'config-vault',name)),passphrase)
  assert.ok(!state.base.some(x=>x.category==='apiKeys'));assert.ok(state.referencePending)
  f.b.credentials.refs.set('FIXTURE_DEEPSEEK_KEY',first);await f.step({...f.b,worker:restarted});assert.equal(restarted.status.phase,'synced')
  assert.deepEqual(f.b.credentials.writes,[])
})
