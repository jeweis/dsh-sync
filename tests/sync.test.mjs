import test from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LiveSync } from '../src/sync.mjs'
import { SyncRemote } from '../src/sync-remote.mjs'
import { HarnessSyncAdapter, itemId, validateItems } from '../src/sync-adapter.mjs'
import { seal, unseal } from '../src/crypto.mjs'
import { loadPreferences, savePreferences, validatePreferences } from '../src/settings.mjs'
import { VaultSettingsService } from '../src/ui-service.mjs'
import { home, dav, passphrase } from './helpers.mjs'
const origin = 1800000000000
const appearance = value => ({ module: '@deepseek-ai/dsh-client-ui-theme', ns: 'theme', field: 'preference', category: 'appearance', value: { preference: value } })
const language = value => ({ module: '@deepseek-ai/dsh-client-locale', ns: 'locale', field: 'preference', category: 'language', value: { preference: value } })
class MemoryAdapter {
  constructor(items) { this.items = structuredClone(items); this.revision = 0; this.applied = []; this.fail = false }
  available() { return true }
  async capture(categories) { const items = this.items.filter(x => categories.includes(x.category)).sort((a,b) => itemId(a).localeCompare(itemId(b))); return {items: structuredClone(items), revisions: new Map(items.map(x => [itemId(x), this.revision]))} }
  edit(index, value) { this.items[index].value = value; this.revision++ }
  async apply(item, expected) { if (this.fail || this.revision !== expected.revision) throw new Error('private service failure'); this.items[this.items.findIndex(x => itemId(x) === itemId(item))] = structuredClone(item); this.revision++; this.applied.push(item) }
}
async function fixture(t, items = [appearance('light'), language('zh')]) {
  const server = await dav(t), target = await home(t, true), adapter = new MemoryAdapter(items)
  const config = { url: server.options.url, username: 'test-user', profiles: ['web'], includeHomePatch: false, timeoutMs: 30000, sync: { enabled: true, space: 'team', categories: ['appearance', 'language'], intervalMs: 180000 } }
  const create = async (values = items) => { const directory = await home(t,true), live = new MemoryAdapter(values); return { home: directory, adapter: live, worker: new LiveSync({ home: directory, profile: 'web', adapter: live, connection: async () => server.remote }) } }
  const worker = new LiveSync({ home: target, profile: 'web', adapter, connection: async () => server.remote })
  const step = (worker, extra = {}) => worker.step({ config, passphrase, now: origin, force: true, ...extra })
  const choose = async (worker, choice) => step(worker, { resolution: { token: worker.status.token, choices: Object.fromEntries(worker.status.changes.map(x => [x.id, choice])) } })
  return { server, target, adapter, config, worker, create, step, choose }
}

test('two devices preview their first connection, sync both directions, dedupe and retain encrypted recovery pre-images', async t => {
  const f = await fixture(t)
  await f.step(f.worker)
  assert.equal(f.worker.status.phase, 'join'); assert.equal(f.server.objects.size,0)
  await f.choose(f.worker,'local'); assert.equal(f.worker.status.phase,'synced')
  const other = await f.create([appearance('dark'),language('en')])
  await f.step(other.worker); assert.equal(other.worker.status.phase,'join'); assert.equal(other.adapter.applied.length,0)
  await f.choose(other.worker,'remote'); assert.equal(other.worker.status.phase,'synced'); assert.deepEqual(other.adapter.items,f.adapter.items)
  f.adapter.edit(0,{preference:'dark'})
  await f.step(f.worker); await f.step(other.worker)
  assert.equal(other.adapter.items[0].value.preference,'dark')
  other.adapter.edit(1,{preference:'en'})
  await f.step(other.worker); await f.step(f.worker)
  assert.equal(f.adapter.items[1].value.preference,'en')
  const count = f.server.requests.filter(x => x.method === 'PUT').length
  await f.step(f.worker); await f.step(other.worker)
  assert.equal(f.server.requests.filter(x => x.method === 'PUT').length,count)
  const head = [...f.server.objects.values()][0].toString()
  assert.ok(!head.includes('preference') && !head.includes(passphrase))
  const stateName = (await readdir(join(f.target,'config-vault'))).find(x=> x.endsWith('.vault'))
  const encrypted = await readFile(join(f.target,'config-vault',stateName))
  assert.ok(!encrypted.toString().includes('preference'))
  const state = await unseal(encrypted,passphrase)
  assert.ok(state.history.length >= 2 && state.history[0].local && state.history[0].remote)
  const restarted = new LiveSync({home:f.target,profile:'web',adapter:f.adapter,connection:async()=>f.server.remote})
  await f.step(restarted); assert.equal(restarted.status.phase,'synced')
})

test('independent edits merge; conflicting edits pause and a stale choice cannot overwrite newer local values', async t => {
  const f=await fixture(t); await f.step(f.worker); await f.choose(f.worker,'local')
  const b=await f.create(); await f.step(b.worker)
  f.adapter.edit(0,{preference:'dark'}); b.adapter.edit(1,{preference:'en'})
  await f.step(f.worker); await f.step(b.worker); await f.step(f.worker)
  assert.equal(f.adapter.items[1].value.preference,'en'); assert.equal(b.adapter.items[0].value.preference,'dark')
  f.adapter.edit(0,{preference:'light'}); b.adapter.edit(0,{preference:'system'})
  await f.step(f.worker); await f.step(b.worker)
  assert.equal(b.worker.status.phase,'conflict')
  const resolution = {token:b.worker.status.token,choices:Object.fromEntries(b.worker.status.changes.map(x=>[x.id,'remote']))}
  b.adapter.edit(0,{preference:'newer'})
  await f.step(b.worker,{resolution}); assert.equal(b.worker.status.error,'sync-stale-preview'); assert.equal(b.adapter.items[0].value.preference,'newer')
  await f.step(b.worker); await f.choose(b.worker,'remote')
  assert.equal(b.adapter.items[0].value.preference,'light')
})

test('cloud CAS race refuses the write without applying a local pull or leaving an uncertain attempt', async t => {
  const f=await fixture(t); await f.step(f.worker); await f.choose(f.worker,'local')
  f.adapter.edit(0,{preference:'dark'})
  f.server.control.beforePut = (path,objects) => { if(path.endsWith('team.vault')) objects.set(path,Buffer.from('concurrent-version')) }
  await f.step(f.worker)
  assert.equal(f.worker.status.error,'sync-remote-changed'); assert.equal(f.worker.status.phase,'error'); assert.equal(f.adapter.applied.length,0)
})

test('disabled, locked, unavailable and polling cooldown do not access WebDAV', async t => {
  const f=await fixture(t)
  await f.step(f.worker,{config:{...f.config,sync:{...f.config.sync,enabled:false}}}); assert.equal(f.worker.status.phase,'disabled')
  await f.step(f.worker,{passphrase:undefined}); assert.equal(f.worker.status.phase,'locked')
  f.adapter.available=()=>false; await f.step(f.worker); assert.equal(f.worker.status.phase,'unavailable')
  assert.equal(f.server.requests.length,0)
  f.adapter.available=()=>true; await f.step(f.worker); const n=f.server.requests.length
  await f.step(f.worker,{force:false,now:origin+5000}); assert.equal(f.server.requests.length,n)
})

test('servers ignoring conditional writes or omitting strong ETags cannot enable device synchronization', async t => {
  for(const kind of ['ignoreConditions','weakEtag','noEtag']) {
    const f=await fixture(t); f.server.control[kind]=true
    await f.step(f.worker); assert.equal(f.worker.status.error,'sync-no-cas',kind); assert.equal(f.adapter.applied.length,0)
    const count=f.server.requests.length
    await f.step(f.worker,{force:false,now:origin+9999999}); assert.equal(f.server.requests.length,count)
    assert.ok(![...f.server.objects.keys()].some(x=>x.endsWith('team.vault')))
  }
})

test('wrong keys, invalid payloads, runtime mismatches and remote-only unsupported entries never mutate local configuration', async t => {
  const f=await fixture(t); await f.step(f.worker); await f.choose(f.worker,'local')
  const path=[...f.server.objects.keys()][0], original=f.server.objects.get(path)
  const b=await f.create([appearance('dark'),language('en')])
  await f.step(b.worker,{passphrase:'wrong-test-passphrase'}); assert.equal(b.worker.status.phase,'error'); assert.equal(b.adapter.applied.length,0)
  const data=await unseal(original,passphrase)
  for(const bad of [{...data,runtime:'0.2.1-alpha.5'},{...data,items:[{...appearance('light'),field:'apiKey'}]}]) {
    f.server.objects.set(path,await seal(bad,passphrase)); await f.step(b.worker); assert.equal(b.worker.status.error,'sync-invalid-data'); assert.equal(b.adapter.applied.length,0)
  }
  f.server.objects.set(path,original)
  b.adapter.items=[language('zh')]
  await f.step(b.worker); assert.equal(b.worker.status.phase,'pending'); assert.equal(b.worker.status.pending[0].reason,'missing-plugin')
})

test('partial application failure pauses across restart, keeps encrypted history, and explicitly rechecks without replaying a write', async t => {
  const f=await fixture(t); await f.step(f.worker); await f.choose(f.worker,'local')
  const b=await f.create([appearance('dark'),language('en')]); await f.step(b.worker); b.adapter.fail=true
  await f.choose(b.worker,'remote'); assert.equal(b.worker.status.phase,'uncertain'); assert.ok(!JSON.stringify(b.worker.status).includes('private service failure'))
  const restarted=new LiveSync({home:b.home,profile:'web',adapter:b.adapter,connection:async()=>f.server.remote})
  await f.step(restarted); assert.equal(restarted.status.phase,'uncertain')
  b.adapter.fail=false; await f.step(restarted,{recheck:true}); assert.equal(restarted.status.phase,'join')
  await f.choose(restarted,'remote'); assert.equal(restarted.status.phase,'synced')
})

test('plugin inventory travels as a manual action, never automatic install or package-file replacement', async t => {
  const inventory=value=>({module:'profile-inventory',ns:'profile',field:'bundles',category:'plugins',value})
  const f=await fixture(t,[inventory([{name:'example-plugin',version:'1.0.0',enabled:true}])]); f.config.sync.categories=['plugins']
  await f.step(f.worker); await f.choose(f.worker,'local')
  const b=await f.create([inventory([])]); await f.step(b.worker)
  assert.equal(b.worker.status.phase,'pending'); assert.equal(b.worker.status.pending[0].reason,'offline'); assert.equal(b.adapter.applied.length,0)
  assert.equal(JSON.parse(await readFile(join(b.home,'profiles/web/package.json'),'utf8')).dependencies['test-plugin'],'1.2.3')
})

test('Harness adapter exports only supported live overrides, preserves secrets and passes current revision to mutate', async t => {
  const target=await home(t,true), rows=[{options:{id:'theme',name:'@deepseek-ai/dsh-client-ui-theme'}},{options:{id:'unsafe',name:'third-party'}}]
  let user={preference:'dark'}, revision=7, args
  const settings={describe:()=>[{ns:'theme',applies:'live',schema:{dict:{preference:{},fontSize:{}}},user,revision,secrets:[{path:['fontSize'],set:true}]},{ns:'unsafe',applies:'live',schema:{dict:{apiKey:{}}},user:{apiKey:'never-export'},revision:0,secrets:[] }],mutate:async(...input)=>{args=input;user={preference:input[1][0].value};revision++}}
  const ctx={get:name=>name==='settings'?settings:name==='configEditor'?{entries:()=>rows}:null}
  const adapter=new HarnessSyncAdapter({home:target,profile:'web',getContext:()=>ctx}), snapshot=await adapter.capture(['appearance'])
  assert.deepEqual(snapshot.items,[appearance('dark')]); assert.ok(!JSON.stringify(snapshot).includes('never-export'))
  await adapter.apply(appearance('light'),{value:{preference:'dark'},revision:7})
  assert.equal(args[2],7); assert.equal(user.preference,'light')
  await assert.rejects(adapter.apply(appearance('dark'),{value:{preference:'light'},revision:7}),/sync-local-changed/)
  assert.throws(()=>validateItems([{...appearance('dark'),value:JSON.parse('{"__jsExpr":"steal()"}')}]),/sync-invalid-data/)
})

test('settings service persists opt-in, isolates unlock secrets and disables sync on save/unload', async t => {
  const f=await fixture(t), service=new VaultSettingsService({home:f.target,profile:'web',syncAdapter:f.adapter,credentials:{describe:async()=>({configured:true,writable:true}),resolve:async()=>({value:'test-password'})},environment:{}})
  t.after(()=>service.dispose()); service.connection=async()=>f.server.remote
  assert.equal((await service.state()).sync.phase,'disabled')
  await service.execute({action:'save',revision:(await service.state()).revision,config:f.config})
  const unlocked=await service.execute({action:'sync-unlock',revision:(await service.state()).revision,passphrase})
  assert.equal(unlocked.state.sync.phase,'join'); assert.ok(!JSON.stringify(unlocked).includes(passphrase))
  assert.ok(!(await readFile(join(f.target,'config-vault/settings.json'),'utf8')).includes(passphrase))
  await service.execute({action:'sync-resolve',revision:(await service.state()).revision,token:unlocked.state.sync.token,choices:Object.fromEntries(unlocked.state.sync.changes.map(x=>[x.id,'local']))})
  assert.equal((await service.state()).sync.phase,'synced')
  await service.execute({action:'save',revision:(await service.state()).revision,config:{...f.config,sync:{...f.config.sync,enabled:false}}})
  assert.equal(service.syncPassphrase,null)
  const count=f.server.requests.length; await service.autoTick(origin+999999); assert.equal(f.server.requests.length,count)
  await service.dispose(); assert.equal(service.syncPassphrase,null)
  for(const sync of [{...f.config.sync,space:'../x'},{...f.config.sync,categories:['credentials']},{...f.config.sync,intervalMs:5000}]) assert.throws(()=>validatePreferences({...f.config,sync}))
})

test('an ambiguous successful PUT pauses across restart and recheck verifies it without a duplicate upload', async t => {
 const f=await fixture(t);await f.step(f.worker)
 f.server.control.beforePut=path=>{if(path.endsWith('team.vault')) f.server.control.corrupt=true}
 await f.choose(f.worker,'local');assert.equal(f.worker.status.phase,'uncertain')
 f.server.control.beforePut=null;f.server.control.corrupt=false
 const restarted=new LiveSync({home:f.target,profile:'web',adapter:f.adapter,connection:async()=>f.server.remote})
 await f.step(restarted);assert.equal(restarted.status.phase,'uncertain')
 const n=f.server.requests.filter(x=>x.method==='PUT'&&x.path.endsWith('team.vault')).length
 await f.step(restarted,{recheck:true});assert.equal(restarted.status.phase,'synced')
 assert.equal(f.server.requests.filter(x=>x.method==='PUT'&&x.path.endsWith('team.vault')).length,n)
})

test('same-profile processes share a lock, and edits during PUT are not falsely acknowledged', async t => {
 const f=await fixture(t);await f.step(f.worker)
 const second=new LiveSync({home:f.target,profile:'web',adapter:f.adapter,connection:async()=>f.server.remote})
 let finish
 f.server.control.beforePut=async path=>{if(path.endsWith('team.vault'))await new Promise(resolve=>{finish=resolve})}
 const active=f.choose(f.worker,'local')
 while(!finish)await new Promise(resolve=>setImmediate(resolve))
 await f.step(second);assert.equal(second.status.phase,'busy')
 f.adapter.edit(0,{preference:'newer-during-upload'});finish();await active
 assert.equal(f.worker.status.phase,'uncertain');assert.equal(f.worker.status.error,'sync-local-changed')
})

test('normalized inherited values retain separate local/cloud baselines without echo uploads', async t => {
 const f=await fixture(t,[appearance('light')]);await f.step(f.worker);await f.choose(f.worker,'local')
 const b=await f.create([appearance('system')])
 b.adapter.apply=async function(item){this.items=[{...item,value:{}}];this.revision++;return this.items[0]}
 await f.step(b.worker);await f.choose(b.worker,'remote');assert.equal(b.worker.status.phase,'synced')
 const count=f.server.requests.filter(x=>x.method==='PUT').length
 const restarted=new LiveSync({home:b.home,profile:'web',adapter:b.adapter,connection:async()=>f.server.remote})
 await f.step(restarted);assert.equal(restarted.status.phase,'synced')
 assert.equal(f.server.requests.filter(x=>x.method==='PUT'&&x.path.endsWith('team.vault')).length,1)
 assert.ok(f.server.requests.filter(x=>x.method==='PUT').length>=count) // only the new process capability probe may write
})

test('unload aborts a background sync request, drops its key, and starts no follow-up request', async t => {
 const f=await fixture(t), service=new VaultSettingsService({home:f.target,profile:'web',syncAdapter:f.adapter,credentials:{describe:async()=>({configured:true,writable:true}),resolve:async()=>({value:'test-password'})},environment:{}})
 t.after(()=>service.dispose());service.connection=async()=>f.server.remote
 await savePreferences(f.target,f.config,(await loadPreferences(f.target,{})).revision,{})
 service.syncPassphrase=passphrase;f.server.control.delay=true
 const pending=service.autoTick(origin)
 while(!f.server.requests.length)await new Promise(resolve=>setImmediate(resolve))
 await service.dispose();await pending
 assert.equal(service.syncPassphrase,null);const count=f.server.requests.length
 await service.autoTick(origin+999999);assert.equal(f.server.requests.length,count)
})

test('an encryption passphrase equal to the DAV password is rejected even through environment configuration', async t => {
 const f=await fixture(t)
 await f.step(f.worker,{passphrase:'test-password'})
 assert.equal(f.worker.status.error,'sync-key-reused');assert.equal(f.server.requests.length,0)
})

test('rechecking an uncertain receive only prepares a review, and never silently retries a failed mutation', async t => {
 const f=await fixture(t);await f.step(f.worker);await f.choose(f.worker,'local')
 const b=await f.create();await f.step(b.worker)
 f.adapter.edit(0,{preference:'dark'});await f.step(f.worker)
 b.adapter.fail=true;await f.step(b.worker);assert.equal(b.worker.status.phase,'uncertain')
 b.adapter.fail=false;const count=b.adapter.applied.length
 await f.step(b.worker,{recheck:true});assert.equal(b.worker.status.phase,'conflict');assert.equal(b.adapter.applied.length,count)
 await f.step(b.worker);assert.equal(b.worker.status.phase,'conflict');assert.equal(b.adapter.applied.length,count)
 await f.choose(b.worker,'remote');assert.equal(b.worker.status.phase,'synced');assert.equal(b.adapter.items[0].value.preference,'dark')
})
