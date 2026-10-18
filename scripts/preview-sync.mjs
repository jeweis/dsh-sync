/** Loopback-only live sync UI fixture; synthetic data, no real Harness/profile/remote storage. */
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { home, dav } from '../tests/helpers.mjs'
import { savePreferences, loadPreferences } from '../src/settings.mjs'
import { VaultSettingsService, createSettingsHandler } from '../src/ui-service.mjs'
import { itemId, HarnessSyncAdapter } from '../src/sync-adapter.mjs'
import { Context } from '@deepseek-ai/cordis'
import AtomicCredentialProvider from '../src/atomic-credentials.mjs'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { join } from 'node:path'
const atomic=process.env.DSH_VAULT_PREVIEW_ATOMIC==='1'
const dispose=[];const t={after:fn=>dispose.push(fn)}, target=await home(t,true), peerHome=await home(t,true), fixture=await dav(t)
const secret='preview-only-encryption-key'
function adapter(preference){return {revision:0,items:[{module:'@deepseek-ai/dsh-client-ui-theme',ns:'theme',field:'preference',category:'appearance',value:{preference}},{module:'@deepseek-ai/dsh-llm-deepseek-api-key',ns:'deepseek-key',field:'api-key',category:'apiKeys',value:{key:`fixture-hidden-key-${preference}`}}],available(){return true},async capture(categories){const items=this.items.filter(x=>categories.includes(x.category));return {referenceKeys:new Set(items.filter(x=>x.category==='apiKeys').map(itemId)),items:structuredClone(items),revisions:new Map(items.map(item=>[itemId(item),this.revision]))}},async apply(item){this.items[this.items.findIndex(x=>itemId(x)===itemId(item))]=structuredClone(item);this.revision++;return item}}}
const options={url:fixture.options.url,username:'test-user',profiles:['web'],includeHomePatch:false,timeoutMs:30000,sync:{enabled:true,apiKeys:true,space:'demo',categories:['appearance','language','models'],intervalMs:180000}}
const credentials={describe:async()=>({configured:true,writable:true}),resolve:async()=>({value:'test-password'})}
const make=async(directory,preference)=>{
 await savePreferences(directory,options,(await loadPreferences(directory,{})).revision,{})
 let live=adapter(preference)
 if(atomic){
  const ctx=new Context();ctx.provide('launchEnvironment',createLaunchEnvironmentSnapshot([]))
  await ctx.plugin(AtomicCredentialProvider,{path:join(directory,'atomic-preview.yaml'),watch:false,managedRefs:['PREVIEW_FIXTURE_API_KEY']})
  dispose.push(()=>ctx.fiber.dispose());await ctx.credentials.set('PREVIEW_FIXTURE_API_KEY',`fixture-hidden-key-${preference}`)
  let revision=0,value=preference
  const settings={describe:()=>[{ns:'theme',applies:'live',schema:{dict:{preference:{}}},user:{preference:value},value:{preference:value},revision},{ns:'deepseek-key',value:{apiKeyEnv:'PREVIEW_FIXTURE_API_KEY'}}],mutate:async(_ns,ops)=>{value=ops[0].value;revision++}}
  const editor={entries:()=>[{options:{name:'@deepseek-ai/dsh-client-ui-theme',id:'theme'}},{options:{name:'@deepseek-ai/dsh-llm-deepseek-api-key',id:'deepseek-key'}}]}
  live=new HarnessSyncAdapter({home:directory,profile:'web',getContext:()=>({get:name=>name==='settings'?settings:name==='configEditor'?editor:ctx.get(name)})})
 }
 const service=new VaultSettingsService({home:directory,profile:'web',syncAdapter:live,credentials,environment:{DSH_VAULT_PASSPHRASE:secret}})
 service.connection=async()=>fixture.remote;dispose.push(()=>service.dispose());return service
}
const peer=await make(peerHome,'dark');await peer.autoTick();await peer.sync.step({config:options,passphrase:secret,force:true,resolution:{token:peer.sync.status.token,choices:Object.fromEntries(peer.sync.status.changes.map(x=>[x.id,'local']))}})
const service=await make(target,'light');await service.autoTick();const handler=createSettingsHandler(service)
const html=`<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>同步与备份 · 隔离验收</title><style>body{margin:0;padding:24px;background:#f5f5f7;color:#222;font-family:system-ui,sans-serif}#note{max-width:900px;margin:0 auto 24px;border:1px dashed #aaa;padding:12px;font-size:12px}#root{max-width:900px;margin:auto}.vault-card{background:#fff!important}.vault-backup-settings{margin-top:20px}.vault-sync-change{margin:20px 0}summary{cursor:pointer}@media(max-width:600px){body{padding:12px}}</style><p id="note">隔离验收 · 两台模拟设备与本机 WebDAV · 不访问真实 profile 或远端 · 云端主题为 dark，本机为 light · API Key 为合成测试数据，预览只显示配置状态</p><main id="root"></main><script src="/react.js"></script><script src="/react-dom.js"></script><script>
const dictionaries=new Map();let registration;const effects=[];const stores={createSnapshotStore(initial){let value=initial;const listeners=new Set();return{getSnapshot:()=>value,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn)},update(fn){value=structuredClone(value);fn(value);for(const listener of listeners)listener()}}}};
const ctx={locale:{register(ns,dict){dictionaries.set(ns,dict);return()=>dictionaries.delete(ns)},bind:ns=>key=>dictionaries.get(ns).zh[key]||key},effect(fn){effects.push(fn())},on(){},slots:{inject(name,fn){fn()},register(options,component){registration={options,component};return()=>{}}}};
window.__ModuleLoader__={load(entry){const plugin=entry.factory(name=>{if(name==='react')return React;if(name==='@deepseek-ai/dsh-client-store')return stores;throw Error('Unexpected browser dependency')});plugin.apply(ctx);const face=registration.options.inject();function useVault(selector){return React.useSyncExternalStore(face.hooks.vault.subscribe,()=>selector(face.hooks.vault.getSnapshot()))}ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(registration.component,{useVault,run:face.run,reload:face.reload,t:ctx.locale.bind('dshConfigVault')}))}};
</script><script src="/client.js"></script></html>`
const files=new Map([['/react.js',new URL('../node_modules/react/umd/react.development.js',import.meta.url)],['/react-dom.js',new URL('../node_modules/react-dom/umd/react-dom.development.js',import.meta.url)],['/client.js',new URL('../lib/client.js',import.meta.url)]])
const server=http.createServer(async(req,res)=>{
 try{if(req.url==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(html);return}
 if(req.url.startsWith('/api/')){const chunks=[];for await(const chunk of req)chunks.push(chunk);const response=await handler(new Request('http://localhost'+req.url,{method:req.method,headers:req.headers,...req.method==='POST'?{body:Buffer.concat(chunks)}:{}}));res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));return}
 const file=files.get(req.url);if(!file){res.writeHead(404);res.end();return}res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8'});res.end(await readFile(file))
 }catch{res.writeHead(500);res.end('fixture failure')}
})
server.listen(0,'127.0.0.1',()=>console.log(`Sync UI fixture: http://127.0.0.1:${server.address().port}`))
let closing=false
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{if(closing)return;closing=true;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));for(const fn of dispose.reverse())await fn()})
