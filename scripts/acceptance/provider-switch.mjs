/** Exact published rc.2 Boot; two disposable profiles; setup -> restart -> key update -> safe rollback -> restart. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL,fileURLToPath } from 'node:url'
import { mkdir,writeFile,readFile,symlink,mkdtemp,realpath,rm } from 'node:fs/promises'
import { join,dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { providerPreview,providerTransition } from '../../src/provider-transition.mjs'
import { REFERENCE_CAS } from '../../src/credential-cas.mjs'
const runtime=process.env.DSH_VAULT_TEST_RUNTIME
if(!runtime)throw new Error('Set DSH_VAULT_TEST_RUNTIME to an independently installed rc.2 runtime')
const anchor=join(runtime,'package.json'),require=createRequire(anchor)
assert.equal(require('@deepseek-ai/dsh/package.json').version,'0.2.1-rc.2')
const imported=name=>import(pathToFileURL(require.resolve(name)))
const {boot,initProfile,readProfilePatches}=await imported('@deepseek-ai/dsh-app-boot')
const {createLaunchEnvironmentSnapshot}=await imported('@deepseek-ai/dsh-launch-environment')
const root=await realpath(await mkdtemp(join(tmpdir(),'dsh-provider-real-'))),home=join(root,'home'),live=[]
const ref='SWITCH_FIXTURE_API_KEY',initial='fixture-initial-provider-key',latest='fixture-updated-after-switch',passphrase='fixture-transition-encryption-key'
try{
 await mkdir(home);await writeFile(join(home,'package.json'),'{"name":"isolated-provider-installation"}')
 const contexts=[]
 for(const name of ['web','headless']){
  const dir=join(home,'profiles',name);initProfile(dir,['provider-test-bundle'])
  await mkdir(join(dir,'node_modules'),{recursive:true})
  await symlink(join(runtime,'node_modules/@deepseek-ai'),join(dir,'node_modules/@deepseek-ai'))
  const packageName=JSON.parse(await readFile(new URL('../../package.json',import.meta.url),'utf8')).name
  await mkdir(dirname(join(dir,'node_modules',packageName)),{recursive:true})
  await symlink(fileURLToPath(new URL('../..',import.meta.url)),join(dir,'node_modules',packageName))
  const bundle=join(dir,'node_modules/provider-test-bundle');await mkdir(bundle)
  await writeFile(join(bundle,'package.json'),JSON.stringify({name:'provider-test-bundle',version:'1.0.0',dsh:{bundle:{patch:'cordis.patch.yml'}}}))
  await writeFile(join(bundle,'cordis.patch.yml'),JSON.stringify([{insert:[
   {id:'config-editor',name:'@deepseek-ai/dsh-config-editor'},
   {id:'settings',name:'@deepseek-ai/dsh-settings'},
   {id:'credentials',name:'@deepseek-ai/dsh-credentials-local',config:{dshHome:home,watch:false}},
   {id:'theme',name:'@deepseek-ai/dsh-client-ui-theme'},
   {id:'bound-reference',name:'@deepseek-ai/dsh-llm-deepseek-api-key',config:{apiKeyEnv:ref}},
  ]}]))
  await writeFile(join(dir,'cordis.yml'),'[]\n')
  contexts.push({name,dir,home,patchPath:join(dir,'cordis.patch.yml'),installAnchor:anchor,cwd:home,startedBundles:['provider-test-bundle'],overlays:[],telemetryDisabledEnv:undefined})
 }
 const start=async profile=>{
  const ctx=await boot('provider-test',join(profile.dir,'cordis.yml'),readProfilePatches('provider-test',profile),ctx=>{
   ctx.provide('profileContext',profile);ctx.provide('launchEnvironment',createLaunchEnvironmentSnapshot([]));ctx.provide('appReady',{onReady:fn=>{fn();return()=>{}}})
  });live.push(ctx);return ctx
 }
 const stop=async()=>{for(const ctx of live.splice(0).reverse())await ctx.fiber.dispose()}
 let a=await start(contexts[0]);await a.credentials.set(ref,initial);await start(contexts[1])
 const before=await readFile(contexts[0].patchPath,'utf8'),options={home,installAnchor:anchor,mode:'enable',passphrase}
 const publicPlan=(await providerPreview(options)).providerPlan
 assert.ok(!publicPlan.blocked,JSON.stringify(publicPlan));assert.equal(publicPlan.profiles.length,2)
 assert.equal(await readFile(contexts[0].patchPath,'utf8'),before)
 await stop()
 let plan=await providerTransition(options)
 assert.equal((await providerTransition({...options,token:plan.token,offline:true,allWritersStopped:true})).status,'enabled')
 a=await start(contexts[0]);const b=await start(contexts[1])
 assert.ok(a.credentials[REFERENCE_CAS]);assert.ok(b.credentials[REFERENCE_CAS])
 assert.equal((await a.credentials.resolve(ref)).value,initial)
 await a.credentials.set(ref,latest);assert.equal((await b.credentials[REFERENCE_CAS].snapshot(ref)).value,latest)
 await a.settings.update('theme',{preference:'dark'})
 await stop()
 plan=await providerTransition({...options,mode:'rollback'})
 assert.ok(!JSON.stringify(plan).includes(latest))
 assert.equal((await providerTransition({...options,mode:'rollback',token:plan.token,offline:true,allWritersStopped:true})).status,'rolled-back')
 for(const profile of contexts){const ctx=await start(profile);assert.ok(!ctx.credentials[REFERENCE_CAS]);assert.equal((await ctx.credentials.resolve(ref)).value,latest)}
 assert.equal(live[0].settings.describe().find(x=>x.ns==='theme').value.preference,'dark')
 console.log(JSON.stringify({runtime:'0.2.1-rc.2',profiles:2,readOnlyOnlinePreview:true,offlineSetup:true,restartedAtomicProvider:true,latestKeyPreserved:true,unrelatedSettingsPreserved:true,offlineRollback:true,restartedOriginalProvider:true,sourceModified:false,realProfileTouched:false}))
 await stop()
}finally{for(const ctx of live.reverse())await ctx.fiber.dispose();await rm(root,{recursive:true,force:true})}
