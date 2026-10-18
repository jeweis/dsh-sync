/** Loopback-only UI fixture. No Harness profile or remote storage is accessed. */
import http from 'node:http'
import { readFile } from 'node:fs/promises'
const files = new Map([
  ['/react.js', new URL('../node_modules/react/umd/react.development.js', import.meta.url)],
  ['/react-dom.js', new URL('../node_modules/react-dom/umd/react-dom.development.js', import.meta.url)],
  ['/client.js', new URL('../lib/client.js', import.meta.url)],
])
const html = `<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>DSH Sync · UI fixture</title>
<style>body{margin:0;padding:24px;background:#f5f5f7;color:#222;font-family:system-ui,sans-serif}#fixture-note{max-width:900px;margin:0 auto 24px;padding:10px 16px;border:1px dashed #aaa;border-radius:8px;font-size:12px}#root{max-width:900px;margin:auto}.vault-card{background:white!important}@media(max-width:600px){body{padding:12px}}</style>
<p id="fixture-note">隔离界面预览 · 仅模拟数据 · 不会访问 Harness 或 WebDAV · 请勿输入真实凭据</p><main id="root"></main>
<script src="/react.js"></script><script src="/react-dom.js"></script><script>
const snapshotId='2026-10-18T01-02-03-000Z_11111111-1111-4111-8111-111111111111';
let revision=1;
let host={config:{url:'https://dav.example.com/backups/dsh/',username:'demo-user',profiles:['web'],includeHomePatch:false,timeoutMs:30000},revision:'demo-1',profiles:[{name:'web',available:true},{name:'headless',available:true},{name:'desktop',available:true}],passwordConfigured:true,passwordWritable:true,busy:false};
window.fetch=async(_url,init)=>{await new Promise(r=>setTimeout(r,250));let value=structuredClone(host);if(init.method==='POST'){const body=JSON.parse(init.body);if(body.action==='save'){host.config=body.config;host.revision='demo-'+(++revision);host.passwordConfigured=body.clearPassword?false:body.password?true:host.passwordConfigured;value={state:structuredClone(host)}}if(body.action==='test')value={connected:true};if(body.action==='list')value={snapshots:[snapshotId]};if(body.action==='backup')value={backup:{id:snapshotId,verified:true}};if(body.action==='preview')value={plan:{snapshotId,home:'/example/dsh-home',token:'a'.repeat(64),blocked:false,files:[{path:'profiles/web/package.json',action:'replace'},{path:'profiles/web/cordis.patch.yml',action:'create'},{path:'profiles/web/pnpm-lock.yaml',action:'unchanged'}],warnings:[{code:'device-path',path:'profiles/web/cordis.patch.yml'}]}}}return new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}})};
const stores={createSnapshotStore(initial){let value=initial;const listeners=new Set();return{getSnapshot:()=>value,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn)},update(fn){value=structuredClone(value);fn(value);for(const listener of listeners)listener()}}}};
const dictionaries=new Map();let registration;const effects=[];
const ctx={locale:{register(ns,dict){dictionaries.set(ns,dict);return()=>dictionaries.delete(ns)},bind:ns=>key=>dictionaries.get(ns).zh[key]||key},effect(fn){effects.push(fn())},on(){},slots:{inject(name,fn){fn()},register(options,component){registration={options,component};return()=>{}}}};
window.__ModuleLoader__={load(entry){const plugin=entry.factory(name=>{if(name==='react')return React;if(name==='@deepseek-ai/dsh-client-store')return stores;throw Error('Unexpected browser dependency: '+name)});plugin.apply(ctx);const face=registration.options.inject();function useVault(selector){return React.useSyncExternalStore(face.hooks.vault.subscribe,()=>selector(face.hooks.vault.getSnapshot()))}ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(registration.component,{useVault,run:face.run,reload:face.reload,t:ctx.locale.bind('dshConfigVault')}))}};
</script><script src="/client.js"></script></html>`
const server = http.createServer(async (req, res) => {
  const file = files.get(req.url)
  if (req.url === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(html); return }
  if (!file) { res.writeHead(404); res.end(); return }
  try { const bytes = await readFile(file); res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }); res.end(bytes) }
  catch { res.writeHead(500); res.end('Run npm ci --ignore-scripts and npm run build first') }
})
server.listen(0, '127.0.0.1', () => { console.log(`UI fixture: http://127.0.0.1:${server.address().port}`) })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.closeAllConnections(); server.close() })
