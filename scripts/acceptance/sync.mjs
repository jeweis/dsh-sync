/** Real rc.2 services, two disposable profiles and local fake DAV; no source checkout is modified. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { mkdir, writeFile, symlink, realpath, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { HarnessSyncAdapter } from '../../src/sync-adapter.mjs'
import { LiveSync } from '../../src/sync.mjs'
import { dav, passphrase } from '../../tests/helpers.mjs'
const atomic = process.env.DSH_VAULT_TEST_ATOMIC_REFS === '1'
const runtime = process.env.DSH_VAULT_TEST_RUNTIME
if (!runtime) throw new Error('Set DSH_VAULT_TEST_RUNTIME to an independently installed rc.2 runtime directory')
const require = createRequire(join(runtime,'package.json'))
if (require('@deepseek-ai/dsh/package.json').version !== '0.2.1-rc.2') throw new Error('Exact rc.2 runtime required')
const imported = name => import(pathToFileURL(require.resolve(name)))
const {boot,initProfile,readProfilePatches}=await imported('@deepseek-ai/dsh-app-boot')
const {default:Timer}=await imported('@deepseek-ai/cordis-plugin-timer')
const {createLaunchEnvironmentSnapshot}=await imported('@deepseek-ai/dsh-launch-environment')
const {default:Hmr}=await imported('@deepseek-ai/dsh-hmr')
const root=await realpath(await mkdtemp(join(tmpdir(),'dsh-sync-real-'))), disposers=[]
const after=fn=>disposers.push(fn)
try {
 const server=await dav({after})
 const make=async name=>{
  const home=join(root,name),dir=join(home,'profiles/web')
  await mkdir(dir,{recursive:true});initProfile(dir,['sync-test-bundle'])
  await writeFile(join(home,'package.json'),'{"name":"sync-test-installation"}')
  await mkdir(join(dir,'node_modules'),{recursive:true})
  await symlink(join(runtime,'node_modules/@deepseek-ai'),join(dir,'node_modules/@deepseek-ai'))
  const bundle=join(dir,'node_modules/sync-test-bundle');await mkdir(bundle)
  await writeFile(join(bundle,'package.json'),JSON.stringify({name:'sync-test-bundle',version:'1.0.0',dsh:{bundle:{patch:'cordis.patch.yml'}}}))
  await writeFile(join(bundle,'cordis.patch.yml'),JSON.stringify([{insert:[
   {id:'config-editor',name:'@deepseek-ai/dsh-config-editor'},
   {id:'settings',name:'@deepseek-ai/dsh-settings'},
   {id:'credentials',name:atomic?new URL('../../src/atomic-credentials.mjs',import.meta.url).pathname:'@deepseek-ai/dsh-credentials-local',config:{dshHome:home,watch:false,...atomic?{managedRefs:['SYNC_ACCEPTANCE_API_KEY']}:{}}},
   {id:'theme',name:'@deepseek-ai/dsh-client-ui-theme'},
   {id:'locale',name:'@deepseek-ai/dsh-client-locale'},
   {id:'model',name:'@deepseek-ai/dsh-agent-default-model',config:{provider:'test',model:'one'}},
  ]}]))
  await writeFile(join(dir,'cordis.yml'),'[]\n')
  const profile={name:'web',dir,home,patchPath:join(dir,'cordis.patch.yml'),installAnchor:join(home,'package.json'),cwd:home,startedBundles:['sync-test-bundle'],overlays:[],telemetryDisabledEnv:undefined}
  const ctx=await boot('sync-test',join(dir,'cordis.yml'),readProfilePatches('sync-test',profile),ctx=>{
   ctx.provide('launchEnvironment',createLaunchEnvironmentSnapshot([]));ctx.provide('profileContext',profile);ctx.provide('appReady',{onReady:fn=>{fn();return()=>{}}})
  })
  after(()=>ctx.fiber.dispose())
  await ctx.plugin(Timer);await ctx.plugin(Hmr,{root:[],ignored:[],debounce:0});await ctx.hmr.runExclusive(async()=>{})
  // Provider discovery is a fixed fixture; settings, credentials, files and HMR are official rc.2 services.
  const discovery={get:name=>name==='configEditor'?{entries:()=>[...ctx.configEditor.entries(),{options:{name:'@deepseek-ai/dsh-llm-deepseek-api-key',id:'deepseek-key'}},{options:{name:'@deepseek-ai/dsh-llm-pi-ai',id:'pi'}}]}:name==='settings'?{mutate:(...args)=>ctx.settings.mutate(...args),describe:options=>[...ctx.settings.describe(options),{ns:'deepseek-key',value:{apiKeyEnv:'SYNC_ACCEPTANCE_API_KEY'}}]}:ctx.get(name)}
  const adapter=new HarnessSyncAdapter({home,profile:'web',getContext:()=>discovery})
  return {ctx,adapter,worker:new LiveSync({home,profile:'web',adapter,connection:async()=>server.remote})}
 }
 const a=await make('device-a'),b=await make('device-b')
 const config={url:server.options.url,username:'test-user',sync:{enabled:true,space:'real-services',apiKeys:true,categories:['appearance','language','models'],intervalMs:180000}}
 const step=(worker,extra={})=>worker.step({config,passphrase,force:true,...extra})
 const choose=(worker,choice)=>step(worker,{resolution:{token:worker.status.token,choices:Object.fromEntries(worker.status.changes.map(x=>[x.id,choice]))}})
 const fixtureKey='acceptance-only-api-key-one', rotatedKey='acceptance-only-api-key-two'
 await a.ctx.credentials.set('SYNC_ACCEPTANCE_API_KEY',fixtureKey)
 await a.ctx.credentials.modifyRecord('llm-pi-ai/openai',async()=>({kind:'api-key',key:fixtureKey,env:{LOCAL_ONLY:'never-sync'}}))
 const theme=a.ctx.configEditor.entries().find(x=>x.options.id==='theme'),fiber=theme.fiber
 await a.ctx.settings.update('model',{model:'two'});await a.ctx.settings.update('locale',{preference:'en'});await a.ctx.settings.update('theme',{preference:'dark'})
 await step(a.worker);assert.equal(a.worker.status.phase,'join',JSON.stringify(a.worker.status));await choose(a.worker,'local');assert.equal(a.worker.status.phase,'synced')
 await step(b.worker);assert.equal(b.worker.status.phase,'join');await choose(b.worker,'remote');assert.equal(b.worker.status.phase,atomic?'synced':'pending',JSON.stringify(b.worker.status))
 if(!atomic){assert.equal(await b.ctx.credentials.resolve('SYNC_ACCEPTANCE_API_KEY'),undefined);assert.equal(b.worker.status.pending[0].reason,'reference-manual')}
 // Simulate the user's manual credential entry through the actual Harness service.
 if(!atomic){await b.ctx.credentials.set('SYNC_ACCEPTANCE_API_KEY',fixtureKey);await step(b.worker)}
 assert.equal((await b.ctx.credentials.resolve('SYNC_ACCEPTANCE_API_KEY')).value,fixtureKey)
 assert.equal(b.worker.status.phase,'synced')
 assert.deepEqual(await b.ctx.credentials.readRecord('llm-pi-ai/openai'),{kind:'api-key',key:fixtureKey})
 await b.ctx.credentials.set('SYNC_ACCEPTANCE_API_KEY',rotatedKey);await step(b.worker);await step(a.worker)
 assert.equal((await a.ctx.credentials.resolve('SYNC_ACCEPTANCE_API_KEY')).value,atomic?rotatedKey:fixtureKey)
 if(!atomic){assert.equal(a.worker.status.phase,'pending');await a.ctx.credentials.set('SYNC_ACCEPTANCE_API_KEY',rotatedKey);await step(a.worker)}
 // A record rotation remains atomic and automatic.
 await b.ctx.credentials.modifyRecord('llm-pi-ai/openai',async current=>({...current,key:rotatedKey}));await step(b.worker);await step(a.worker)
 assert.equal((await a.ctx.credentials.readRecord('llm-pi-ai/openai')).key,rotatedKey)
 assert.equal(b.ctx.settings.describe().find(x=>x.ns==='theme').value.preference,'dark');assert.equal(b.ctx.agentDefaultModel.currentSelection().model,'two');assert.equal(b.ctx.settings.describe().find(x=>x.ns==='locale').value.preference,'en')
 await b.ctx.settings.update('theme',{preference:'light'})
 await step(b.worker);await step(a.worker)
 assert.equal(a.ctx.settings.describe().find(x=>x.ns==='theme').value.preference,'light');assert.equal(theme.fiber,fiber)
 await a.ctx.settings.update('theme',{preference:'dark'});await b.ctx.settings.update('theme',{preference:'system'})
 await step(a.worker);await step(b.worker);assert.equal(b.worker.status.phase,'conflict');await choose(b.worker,'remote')
 assert.equal(b.ctx.settings.describe().find(x=>x.ns==='theme').value.preference,'dark')
 assert.ok(!JSON.stringify(a.worker.status).includes(fixtureKey))
 console.log(JSON.stringify({realCredentials:true,referencesNeverOverwritten:true,atomicReferenceReceiving:atomic,manualReferenceResume:!atomic,atomicRecordRotation:true,providerDiscoveryFixture:true,runtime:'0.2.1-rc.2',devices:2,realSettings:true,hmr:true,firstJoinPreview:true,bidirectional:true,conflictResolution:true,sameFiber:true,defaultModel:true,language:true,remoteObjects:server.objects.size}))
} finally {for(const dispose of disposers.reverse()) await dispose();await rm(root,{recursive:true,force:true})}
