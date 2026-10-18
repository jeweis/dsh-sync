import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {home,dav,passphrase,manifest} from './helpers.mjs'
import {backup} from '../src/engine.mjs'
import {VaultSettingsService,createSettingsHandler} from '../src/ui-service.mjs'
import {savePreferences,loadPreferences} from '../src/settings.mjs'

test('recovery installs only a reviewed named npm version through Harness, without enabling or approving builds',async t=>{
 const source=await home(t,true),target=await home(t,true),fixture=await dav(t)
 const m=JSON.parse(manifest);m.dependencies['test-plugin']='file:/old-device/plugin'
 await writeFile(join(source,'profiles/web/package.json'),JSON.stringify(m))
 const dest=JSON.parse(manifest);delete dest.dependencies['test-plugin'];dest.dsh.profile.bundles=dest.dsh.profile.bundles.filter(x=>x!=='test-plugin')
 await writeFile(join(target,'profiles/web/package.json'),JSON.stringify(dest))
 const saved=await backup({home:source,remote:fixture.remote,passphrase,profiles:['web']})
 const calls=[]
 const pluginManager={inspect:async spec=>{calls.push(['inspect',spec]);return{status:'accepted',name:'test-plugin',version:'2.0.0',bundle:true}},installBundle:async(spec,options)=>{
  calls.push(['install',spec,options]);dest.dependencies['test-plugin']='2.0.0';await writeFile(join(target,'profiles/web/package.json'),JSON.stringify(dest));return{application:'applied',stage:'install',changed:true}
 }}
 const service=new VaultSettingsService({home:target,pluginManager,credentials:{describe:async()=>({configured:true,writable:true}),resolve:async()=>({value:'test-password'})},environment:{}})
 t.after(()=>service.dispose());service.connection=async()=>fixture.remote
 const initial=await loadPreferences(target,{});await savePreferences(target,{...initial.config,url:fixture.options.url,username:'test-user'},initial.revision,{})
 const revision=(await service.state()).revision
 const body={revision,id:saved.id,passphrase,sourceProfile:'web',useInstalled:true}
 const first=await service.execute({action:'recovery-preview',...body});assert.equal(first.recoveryPlan.blocked,true)
 await assert.rejects(service.execute({action:'recovery-install',...body,name:'test-plugin',token:'not-reviewed'}),/recovery-stale/)
 const checked=await service.execute({action:'recovery-package',...body,name:'test-plugin'})
 assert.equal(checked.recoveryPackage.version,'2.0.0');assert.equal(calls.length,1)
 await assert.rejects(service.execute({action:'recovery-package',...body,name:'other-package'}),/invalid-request/)
 const result=await service.execute({action:'recovery-install',...body,name:'test-plugin',token:checked.recoveryPackage.token})
 assert.equal(result.recoveryPlan.blocked,false)
 assert.deepEqual(calls[1],['install','test-plugin@2.0.0',{enabled:false,saveExact:true}])
 await assert.rejects(service.execute({action:'recovery-install',...body,name:'test-plugin',token:checked.recoveryPackage.token}),/recovery-stale/)
 const before=await readFile(join(target,'profiles/web/cordis.patch.yml'),'utf8')
 const stage=await service.execute({action:'recovery-stage',...body,token:result.recoveryPlan.token})
 assert.ok(stage.recoveryStage.requestId);assert.ok(!JSON.stringify(stage).includes(passphrase))
 assert.equal(await readFile(join(target,'profiles/web/cordis.patch.yml'),'utf8'),before)
 const handler=createSettingsHandler(service)
 const refused=await handler(new Request('http://localhost/api/dsh-config-vault',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'restore',...body})}))
 assert.equal(refused.status,400)
})
