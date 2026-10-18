/** Loopback-only provider wizard fixture. All profiles and credentials are synthetic. */
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { transitionFixture } from '../tests/provider-fixture.mjs'
import { VaultSettingsService,createSettingsHandler } from '../src/ui-service.mjs'
import Atomic from '../src/atomic-credentials.mjs'
const dispose=[],t={after:fn=>dispose.push(fn)},fixture=await transitionFixture(t)
if(process.env.DSH_VAULT_PREVIEW_PROVIDER==='rollback') {
 await fixture.apply()
 const ctx=await fixture.mount(Atomic);await ctx.credentials.set('FIXTURE_TRANSITION_KEY','fixture-latest-hidden-key');await ctx.fiber.dispose()
}
const service=new VaultSettingsService({home:fixture.home,defaults:{profiles:['a','b']},environment:{},credentials:{describe:async()=>({configured:false,writable:true})},providerContext:{installAnchor:fixture.anchor,overlays:[]}})
dispose.push(()=>service.dispose());const handler=createSettingsHandler(service)
const html=`<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>同步与备份 · 隔离验收</title><style>body{margin:0;padding:24px;background:#f5f5f7;color:#222;font-family:system-ui,sans-serif}#note{max-width:900px;margin:0 auto 24px;border:1px dashed #aaa;padding:12px;font-size:12px}#root{max-width:900px;margin:auto}.vault-card{background:#fff!important}.vault-backup-settings{margin-top:20px}.vault-sync-change{margin:20px 0}summary{cursor:pointer}@media(max-width:600px){body{padding:12px}}</style><p id="note">隔离验收 · 两台模拟设备与本机 WebDAV · 不访问真实 profile 或远端 · 凭据 provider 接入与回退 · 两个临时 profile · 仅预览，不在浏览器执行切换</p><main id="root"></main><script src="/react.js"></script><script src="/react-dom.js"></script><script>
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
server.listen(0,'127.0.0.1',()=>console.log(`Provider setup fixture: http://127.0.0.1:${server.address().port}`))
let closing=false
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{if(closing)return;closing=true;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));for(const fn of dispose.reverse())await fn()})
