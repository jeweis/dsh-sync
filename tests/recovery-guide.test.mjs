import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir, access } from 'node:fs/promises'
import { join } from 'node:path'
import { collect } from '../src/snapshot.mjs'
import { preview, recover } from '../src/restore.mjs'
import { recoveryPreview, stageRecovery, finishRecovery, registryVersion } from '../src/recovery-guide.mjs'
import { home, passphrase, manifest } from './helpers.mjs'

async function pair(t, { local = false, sourceVersion = '^1.2.3' } = {}) {
  const source = await home(t,true), target = await home(t,true)
  const old = JSON.parse(manifest), current = JSON.parse(manifest)
  old.dependencies['test-plugin'] = local ? 'file:/old-device/private-plugin' : sourceVersion
  old.scripts = { postinstall:'must-never-import' };old.pnpm={onlyBuiltDependencies:['test-plugin']}
  current.dependencies['test-plugin'] = '1.2.9';current.dependencies.extra='2.0.0';current.dsh.profile.bundles.push('extra')
  await writeFile(join(source,'profiles/web/package.json'),JSON.stringify(old))
  await writeFile(join(target,'profiles/web/package.json'),JSON.stringify(current))
  await writeFile(join(target,'profiles/web/cordis.patch.yml'),'# New device settings\n[]\n')
  await writeFile(join(source,'profiles/web/pnpm-lock.yaml'),'lockfileVersion: 9\n')
  await writeFile(join(target,'profiles/web/pnpm-lock.yaml'),'# destination lockfile\n')
  return { source,target,snapshot:await collect({home:source,profiles:['web']}) }
}

test('new-device guide reuses destination plugin versions, names exact blockers and excludes source install policy and lockfile',async t=>{
  for (const value of ['^0.2.1-rc.2','~1.2.3','>=1.0.0 <2','1.2 - 2.0','1.x','*','1.0.0 || 2.0.0']) assert.equal(registryVersion(value),true,value)
  for (const value of ['latest','file:/old/path','git+https://example.invalid/plugin','1.0.0-'+ 'a'.repeat(200)]) assert.equal(registryVersion(value),false,value)
  const f=await pair(t,{local:true})
  const raw=await preview(f.snapshot,{home:f.target});assert.equal(raw.blocked,true)
  const unresolved=await recoveryPreview(f.snapshot,{home:f.target,sourceProfile:'web',targetProfile:'web'})
  assert.ok(unresolved.plan.warnings.some(w=>w.code==='recovery-plugin'&&w.dependency==='test-plugin'))
  const {plan,snapshot}=await recoveryPreview(f.snapshot,{home:f.target,sourceProfile:'web',targetProfile:'web',useInstalled:true})
  assert.equal(plan.blocked,false)
  const next=JSON.parse(snapshot.files[0].content)
  assert.equal(next.dependencies['test-plugin'],'1.2.9');assert.equal(next.dependencies.extra,'2.0.0')
  assert.ok(next.dsh.profile.bundles.includes('extra'));assert.equal(next.scripts,undefined);assert.equal(next.pnpm,undefined)
  assert.equal(snapshot.files.length,2);assert.ok(snapshot.files.every(f=>!f.path.endsWith('lock.yaml')))
  assert.equal(plan.packages[0].state,'kept-installed')
  assert.equal(await readFile(join(f.target,'profiles/web/cordis.patch.yml'),'utf8'),'# New device settings\n[]\n')
})

test('encrypted offline handoff restores across two homes and retains a rollback; no remote credentials are staged',async t=>{
  const f=await pair(t,{local:true}),options={home:f.target,sourceProfile:'web',targetProfile:'web',useInstalled:true,passphrase}
  const before=await readFile(join(f.target,'profiles/web/package.json'),'utf8')
  const {plan}=await recoveryPreview(f.snapshot,options)
  const stage=await stageRecovery(f.snapshot,{...options,token:plan.token})
  const path=join(f.target,`config-vault/restore-request-${stage.requestId}.vault`),bytes=await readFile(path,'utf8')
  assert.ok(!bytes.includes('private-plugin'));assert.ok(!bytes.includes(passphrase));assert.ok(!bytes.includes('test-model'))
  await assert.rejects(finishRecovery({home:f.target,requestId:stage.requestId,passphrase:'incorrect-passphrase'}),/recovery-passphrase/)
  const check=await finishRecovery({home:f.target,requestId:stage.requestId,passphrase})
  await assert.rejects(finishRecovery({home:f.target,requestId:stage.requestId,passphrase,confirm:true,token:check.plan.token}),/recovery-offline/)
  await assert.rejects(finishRecovery({home:f.target,requestId:stage.requestId,passphrase,offline:true,confirm:true,token:'invalid'}),/recovery-stale/)
  const restored=await finishRecovery({home:f.target,requestId:stage.requestId,passphrase,offline:true,confirm:true,token:check.plan.token})
  assert.equal(restored.status,'restored');assert.ok(restored.rollbackId)
  assert.equal(await readFile(join(f.target,'profiles/web/pnpm-lock.yaml'),'utf8'),'# destination lockfile\n')
  await assert.rejects(access(path),{code:'ENOENT'})
  const undo=await recover({home:f.target,passphrase,rollbackId:restored.rollbackId})
  await recover({home:f.target,passphrase,rollbackId:restored.rollbackId,token:undo.token,offline:true})
  assert.equal(await readFile(join(f.target,'profiles/web/package.json'),'utf8'),before)
})

test('handoff refuses target edits after review, including installation changes, and cannot apply another home',async t=>{
  const f=await pair(t),options={home:f.target,sourceProfile:'web',targetProfile:'web',useInstalled:true,passphrase}
  const {plan}=await recoveryPreview(f.snapshot,options)
  const stage=await stageRecovery(f.snapshot,{...options,token:plan.token})
  await writeFile(join(f.target,'profiles/web/cordis.patch.yml'),'# User just edited\n[]\n')
  await assert.rejects(stageRecovery(f.snapshot,{...options,token:plan.token}),/recovery-stale/)
  await assert.rejects(finishRecovery({home:f.target,requestId:stage.requestId,passphrase}),/recovery-stale/)
  assert.equal(await readFile(join(f.target,'profiles/web/cordis.patch.yml'),'utf8'),'# User just edited\n[]\n')
})

test('profile mapping changes only the explicitly selected destination and unresolved dependencies block staging',async t=>{
  const f=await pair(t)
  const noInstall=await recoveryPreview(f.snapshot,{home:f.target,sourceProfile:'web',targetProfile:'desktop',useInstalled:true})
  assert.equal(noInstall.plan.blocked,true)
  assert.ok(noInstall.plan.warnings.some(w=>w.code==='recovery-install'))
  await assert.rejects(stageRecovery(f.snapshot,{home:f.target,sourceProfile:'web',targetProfile:'desktop',useInstalled:true,token:noInstall.plan.token,passphrase}),/recovery-stale/)
  await assert.rejects(recoveryPreview(f.snapshot,{home:f.target,sourceProfile:'web',targetProfile:'../escape'}),/recovery-invalid/)
  const wrongRuntime=await recoveryPreview({...f.snapshot,runtimeVersion:'0.1.0'},{home:f.target,sourceProfile:'web',targetProfile:'web',useInstalled:true})
  assert.equal(wrongRuntime.plan.blocked,true);assert.equal(wrongRuntime.plan.runtime.source,'0.1.0')
})

test('preserved-local exemption only allows declarations unchanged on this device; raw restore remains blocked',async t=>{
  const f=await pair(t,{local:true})
  const path=join(f.target,'profiles/web/package.json'),m=JSON.parse(await readFile(path,'utf8'));m.dependencies['test-plugin']='file:/new-device/plugin';await writeFile(path,JSON.stringify(m))
  const {plan,snapshot}=await recoveryPreview(f.snapshot,{home:f.target,sourceProfile:'web',targetProfile:'web',useInstalled:true})
  assert.equal(plan.blocked,false)
  assert.equal((await preview(snapshot,{home:f.target})).blocked,true)
  assert.equal((await preview(snapshot,{home:f.target,preserveLocal:true})).blocked,false)
  assert.equal((await preview(f.snapshot,{home:f.target,preserveLocal:true})).blocked,true)
})

test('new device retains its launch mode rather than importing another profile’s app bundle',async t=>{
 const f=await pair(t),path=join(f.source,'profiles/web/package.json'),m=JSON.parse(await readFile(path,'utf8'))
 m.dsh.profile.bundles=m.dsh.profile.bundles.filter(x=>x!=='@deepseek-ai/dsh-web-app');m.dsh.profile.bundles.push('@deepseek-ai/dsh-acp-app');m.dependencies['@deepseek-ai/dsh-acp-app']='0.2.1-rc.2'
 await writeFile(path,JSON.stringify(m))
 const snapshot=await collect({home:f.source,profiles:['web']})
 const result=await recoveryPreview(snapshot,{home:f.target,sourceProfile:'web',targetProfile:'web',useInstalled:true})
 const migrated=JSON.parse(result.snapshot.files[0].content)
 assert.ok(migrated.dsh.profile.bundles.includes('@deepseek-ai/dsh-web-app'))
 assert.ok(!migrated.dsh.profile.bundles.includes('@deepseek-ai/dsh-acp-app'))
 assert.equal(migrated.dependencies['@deepseek-ai/dsh-acp-app'],undefined)
})
