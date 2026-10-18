/** Read-only onboarding preview and explicitly offline, journaled provider transitions. */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { dirname, join, resolve, relative, isAbsolute } from 'node:path'
import { readFile, readdir } from 'node:fs/promises'
import { createHmac, randomUUID, scryptSync } from 'node:crypto'
import { parseDocument, isSeq } from 'yaml'
import { readManaged, writeManaged, safePath, PROFILE } from './files.mjs'
import { hash, seal, unseal } from './crypto.mjs'
import { canonical } from './sync-adapter.mjs'
import { syncLock } from './sync-lock.mjs'
import { restoreLock } from './restore.mjs'
import { RUNTIME } from './snapshot.mjs'

const PACKAGE = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).name
const LOCAL = '@deepseek-ai/dsh-credentials-local', ATOMIC = `${PACKAGE}/credentials-provider`
const PROVIDERS = [LOCAL, ATOMIC, 'dsh-config-vault/credentials-provider']
const ENTRY = 'dsh-vault-atomic-credentials', JOURNAL = 'config-vault/provider-transition.vault', RECEIPT = 'config-vault/provider-receipt.json'
const validRef = ref => typeof ref === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(ref) && !['DSH_VAULT_WEBDAV_PASSWORD','DSH_VAULT_PASSPHRASE'].includes(ref.toUpperCase())
function flatten(rows,depth=0) {
  return rows.flatMap(row=>{
    if(depth && PROVIDERS.includes(row.name))fail('provider-unsupported-config')
    return [row,...(row.group&&Array.isArray(row.config)?flatten(row.config,depth+1):[])]
  })
}
export class ProviderTransitionError extends Error { constructor(code) { super(code); this.code = code } }
const fail = code => { throw new ProviderTransitionError(code) }
function yaml(text) {
  const doc = parseDocument(text ?? '[]\n', { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => ({ __jsExpr: value }) }] })
  if (doc.errors.length || !isSeq(doc.contents)) fail('provider-unsupported-config')
  const rows = doc.toJS({ maxAliasCount: 32 })
  if (!Array.isArray(rows) || rows.length > 2048 || rows.some(x => !x || typeof x !== 'object' || Array.isArray(x))) fail('provider-unsupported-config')
  return { doc, rows }
}
async function external(path, inputs) {
  const bytes = await readFile(path)
  if (bytes.length > 2 * 1024 * 1024) fail('provider-unsupported-config')
  const text = bytes.toString('utf8'); if (!Buffer.from(text).equals(bytes)) fail('provider-unsupported-config')
  inputs.push([path, hash(bytes)]); return text
}
function packagePath(name, anchors) {
  for (const anchor of anchors) { try { return createRequire(anchor).resolve(`${name}/package.json`) } catch {} }
  fail('provider-missing-dependency')
}
function localConfig(row, home) {
  if (Object.keys(row).some(key => !['id','name','config','disabled'].includes(key))) fail('provider-unsupported-config')
  const value = row.config ?? {}
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['path','dshHome','watch','debounceMs','managedRefs'].includes(key))) fail('provider-unsupported-config')
  const { managedRefs, ...config } = value
  if ((config.path !== undefined && (typeof config.path !== 'string' || !isAbsolute(config.path))) || (config.dshHome !== undefined && (typeof config.dshHome !== 'string' || !isAbsolute(config.dshHome))) || (config.watch !== undefined && typeof config.watch !== 'boolean') || (config.debounceMs !== undefined && (!Number.isFinite(config.debounceMs) || config.debounceMs < 0))) fail('provider-unsupported-config')
  const storage = resolve(config.path ?? join(config.dshHome ?? home, '.credentials.yaml'))
  const rel = relative(resolve(home), storage)
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || rel.includes('\\') || /^(profiles|config-vault|node_modules)\//.test(rel) || rel==='cordis.patch.yml' || !/\.ya?ml$/.test(rel)) fail('provider-external-storage')
  return { config, storage: rel }
}
function refsOf(rows) {
  const refs = []
  for (const row of rows.filter(x => !x.disabled)) {
    if (row.name === '@deepseek-ai/dsh-llm-deepseek-api-key') refs.push(row.config?.apiKeyEnv ?? 'DEEPSEEK_API_KEY')
    if (row.name === '@deepseek-ai/dsh-llm-pi-ai') {
      const providers = row.config?.providers ?? {}
      if (!providers || typeof providers !== 'object' || Array.isArray(providers) || providers.__jsExpr) fail('provider-dynamic-reference')
      for (const config of Object.values(providers)) if (config?.apiKeyEnv !== undefined) refs.push(config.apiKeyEnv)
    }
  }
  if (refs.some(ref => !validRef(ref))) fail('provider-dynamic-reference')
  return refs
}
async function composeHome({ home, installAnchor, overlays = [] }) {
  if (!installAnchor || overlays.length) fail('provider-context-required')
  const inputs = [], req = createRequire(resolve(installAnchor))
  const runtime = JSON.parse(await external(req.resolve('@deepseek-ai/dsh/package.json'), inputs))
  if (runtime.version !== RUNTIME) fail('provider-runtime-mismatch')
  const include = await import(pathToFileURL(req.resolve('@deepseek-ai/cordis-plugin-include')))
  const compose = patches => {
    const warnings = []
    const rows = flatten(include.applyEntryPatches([], structuredClone(patches), (...args) => warnings.push(args)))
    if (warnings.length || new Set(rows.map(x => x.id)).size !== rows.length) fail('provider-unsupported-config')
    return rows
  }
  const rootPatch = await readManaged(home, 'cordis.patch.yml')
  const homeRows = rootPatch === null ? [] : yaml(rootPatch).rows
  inputs.push(['cordis.patch.yml', rootPatch === null ? null : hash(rootPatch)])
  const rootManifest = await readManaged(home, 'package.json')
  inputs.push(['package.json', rootManifest === null ? null : hash(rootManifest)])
  const directories = await readdir(await safePath(home, 'profiles'), { withFileTypes: true }), profiles = []
  for (const entry of directories.sort((a,b)=>a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) fail('provider-unsupported-config')
    if (!entry.isDirectory()) continue
    if (!PROFILE.test(entry.name)) fail('provider-unsupported-config')
    const prefix = `profiles/${entry.name}`, manifestText = await readManaged(home, `${prefix}/package.json`)
    if (manifestText === null) fail('provider-unsupported-config')
    const manifest = JSON.parse(manifestText), bundles = manifest.dsh?.profile?.bundles
    if (!Array.isArray(bundles) || bundles.length > 128 || !bundles.every(x => typeof x === 'string' && /^(@[\w.-]+\/)?[\w.-]+$/.test(x))) fail('provider-unsupported-config')
    inputs.push([`${prefix}/package.json`, hash(manifestText)])
    const base = []
    for (const name of bundles) {
      const path = packagePath(name, [installAnchor, join(resolve(home), prefix, 'package.json')])
      const bundle = JSON.parse(await external(path, inputs)), patches = bundle.dsh?.bundle?.patch
      const files = typeof patches === 'string' ? [patches] : patches
      if (!Array.isArray(files) || !files.length || files.length > 64) fail('provider-unsupported-config')
      for (const file of files) {
        if (typeof file !== 'string' || isAbsolute(file) || file.includes('\\') || file.split('/').includes('..')) fail('provider-unsupported-config')
        base.push(...yaml(await external(resolve(dirname(path), file), inputs)).rows)
      }
    }
    const path = `${prefix}/cordis.patch.yml`, before = await readManaged(home, path)
    const configText = await readManaged(home, `${prefix}/cordis.yml`)
    if (configText !== null && yaml(configText).rows.length) fail('provider-unsupported-config')
    inputs.push([`${prefix}/cordis.yml`, configText === null ? null : hash(configText)], [path, before === null ? null : hash(before)])
    const { doc, rows } = yaml(before)
    const effective = compose([...base, ...rows, ...homeRows])
    const providers = effective.filter(x => !x.disabled && PROVIDERS.includes(x.name))
    if (providers.length !== 1 || effective.some(x => x.name === '@deepseek-ai/cordis-plugin-include')) fail('provider-unsupported-config')
    const provider = providers[0], local = localConfig(provider, home)
    await safePath(home, local.storage)
    // The optional entry must already resolve; never install dependencies here.
    const profileRequire=createRequire(join(resolve(home),prefix,'package.json'))
    const packageInfo=JSON.parse(await external(packagePath(PACKAGE,[join(resolve(home),prefix,'package.json')]),inputs))
    const ownInfo=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'))
    if(packageInfo.version!==ownInfo.version || packageInfo.engines?.dsh!==RUNTIME)fail('provider-runtime-mismatch')
    let module;try{module=profileRequire.resolve(ATOMIC)}catch{fail('provider-missing-dependency')}
    inputs.push(['provider-module', module, hash(await readFile(module))])
    const nativeRequire = createRequire(module)
    for (const name of [LOCAL,'@deepseek-ai/dsh-launch-environment']) {
      const meta = JSON.parse(await external(nativeRequire.resolve(`${name}/package.json`), inputs))
      if (meta.version !== RUNTIME) fail('provider-runtime-mismatch')
    }
    profiles.push({ name: entry.name, path, before, doc, rows, base, homeRows, provider, ...local, effective })
  }
  if (!profiles.length || profiles.length > 40 || new Set(profiles.map(x=>x.storage)).size !== 1) fail('provider-mixed-storage')
  return { profiles, inputs, compose }
}
async function receipt(home) {
  const raw = await readManaged(home, RECEIPT)
  if (raw === null) return null
  const value = JSON.parse(raw)
  if (!value || !Array.isArray(value.refs) || !value.refs.length || value.refs.length>128 || !value.refs.every(validRef) || typeof value.storage!=='string' || value.storage.startsWith('/') || value.storage.split('/').some(x=>['..','.'].includes(x)) || value.version !== 1 || !['switching','enabled','rolling-back','rolled-back'].includes(value.phase) || !Array.isArray(value.profiles) || !value.profiles.every(PROFILE.test.bind(PROFILE))) fail('provider-invalid-journal')
  return value
}
function publicPlan(plan) {
  return { version:1, mode:plan.mode, home:plan.home, installAnchor:plan.installAnchor, profiles:plan.changes.map(x=>({name:x.name,path:x.path,from:x.from,to:x.to,changed:x.before!==x.after,fromId:x.fromId,toId:x.toId,retainedConfig:x.retainedConfig})), refs:plan.refs, storage:plan.storage, credentialAction:plan.mode==='enable'?'retain':'preserve-current-keys', restartRequired:true, offlineRequired:true, allWritersRequired:true }
}
function validateJournal(journal, home) {
  if (!journal || typeof journal.id!=='string' || !/^[a-f0-9-]{36}$/.test(journal.id) || journal.format!=='dsh-provider-transition' || journal.version!==1 || journal.home!==resolve(home) || !Array.isArray(journal.changes) || !journal.changes.length || journal.changes.length>40 || !Array.isArray(journal.refs) || !journal.refs.length || journal.refs.length>128 || !journal.refs.every(validRef) || typeof journal.storage!=='string' || journal.storage.startsWith('/') || journal.storage.split('/').some(x=>['..','.'].includes(x))) fail('provider-invalid-journal')
  for(const change of journal.changes) if(!PROFILE.test(change.name) || change.path!==`profiles/${change.name}/cordis.patch.yml` || (change.before!==null && typeof change.before!=='string') || typeof change.after!=='string' || !Array.isArray(change.nodes) || change.nodes.length!==2) fail('provider-invalid-journal')
}
async function build(options) {
  const home=resolve(options.home), mode=options.mode??'enable'
  if(!['enable','rollback'].includes(mode)) fail('provider-invalid-request')
  const loaded=await composeHome({...options,home}), previous=await receipt(home)
  const discovered=[...new Set(loaded.profiles.flatMap(x=>refsOf(x.effective)))].sort()
  let refs=options.refs??discovered, original=null
  if(mode==='enable') {
    if(previous && previous.phase!=='rolled-back') fail('provider-existing-transition')
    if(!Array.isArray(refs) || !refs.length || refs.length>128 || new Set(refs).size!==refs.length || !refs.every(x=>validRef(x)&&discovered.includes(x))) fail('provider-invalid-references')
    refs=[...refs].sort()
  } else {
    if(!previous || previous.phase==='rolled-back') fail('provider-no-transition')
    if(options.publicOnly) {
      if(!Array.isArray(previous.recipes)||previous.recipes.length!==previous.profiles.length||!previous.recipes.every(x=>x&&PROFILE.test(x.name)&&Array.isArray(x.nodes)&&x.nodes.length===2))fail('provider-invalid-journal')
      original={changes:previous.recipes,refs:previous.refs,storage:previous.storage}
    } else {
      const bytes=await readManaged(home,JOURNAL)
      if(bytes===null) fail('provider-invalid-journal')
      original=await unseal(Buffer.from(bytes),options.passphrase);validateJournal(original,home)
    }
    if(canonical(original.changes.map(x=>x.name).sort())!==canonical(loaded.profiles.map(x=>x.name).sort())) fail('provider-profile-changed')
    refs=original.refs
  }
  const changes=[]
  for(const profile of loaded.profiles) {
    const {doc}=yaml(profile.before);doc.contents.flow=false
    let nodes,from,to,after
    if(mode==='enable') {
      if(profile.provider.name!==LOCAL || profile.effective.some(x=>x.id===ENTRY)) fail('provider-unsupported-config')
      nodes=[{id:profile.provider.id,name:LOCAL,disabled:true},{insert:[{id:ENTRY,name:ATOMIC,config:{...profile.config,managedRefs:refs}}]}]
      if(nodes.some(node=>profile.rows.some(row=>canonical(row)===canonical(node))))fail('provider-unsupported-config')
      for(const node of nodes)doc.add(doc.createNode(node))
      after=String(doc);from=LOCAL;to=ATOMIC
    } else {
      const saved=original.changes.find(x=>x.name===profile.name);nodes=saved.nodes
      const indices=nodes.map(node=>profile.rows.flatMap((row,i)=>canonical(row)===canonical(node)?[i]:[]))
      if(indices.every(list=>list.length===1)) {
        for(const index of indices.flat().sort((a,b)=>b-a)) doc.delete(index)
        after=String(doc)
      } else if(indices.every(list=>list.length===0) && profile.provider.name===LOCAL) after=profile.before??'[]\n'
      else fail('provider-owned-patch-changed')
      from=profile.provider.name;to=LOCAL
    }
    const next=loaded.compose([...profile.base,...yaml(after).rows,...profile.homeRows]).filter(x=>!x.disabled&&PROVIDERS.includes(x.name))
    if(next.length!==1 || next[0].name!==to || canonical(localConfig(next[0],home).config)!==canonical(profile.config) || (to===ATOMIC&&canonical(next[0].config.managedRefs)!==canonical(refs))) fail('provider-overridden')
    if(mode==='rollback' && profile.storage!==original.storage) fail('provider-external-storage')
    changes.push({name:profile.name,path:profile.path,before:profile.before,after,from,to,nodes,fromId:profile.provider.id,toId:mode==='enable'?ENTRY:nodes[0].id,retainedConfig:profile.config})
  }
  return {mode,home,installAnchor:resolve(options.installAnchor),refs,storage:loaded.profiles[0].storage,changes,inputs:loaded.inputs,previous,original}
}
export async function providerPreview(options) {
  try {
    const built=await build({...options,publicOnly:true})
    return {providerPlan:built.publicOnly?built.plan:publicPlan(built)}
  } catch(error) { return {providerPlan:{version:1,mode:options.mode??'enable',blocked:true,reason:error instanceof ProviderTransitionError?error.code:'provider-unsupported-config',profiles:[],refs:[],offlineRequired:true,allWritersRequired:true}} }
}
async function credentialContexts(plan) {
  const [{Context},{default:Local},{default:Atomic,atomicReferenceRecordKey},{createLaunchEnvironmentSnapshot}]=await Promise.all([import('@deepseek-ai/cordis'),import('@deepseek-ai/dsh-credentials-local'),import('./atomic-credentials.mjs'),import('@deepseek-ai/dsh-launch-environment')])
  const native=new Context(), atomic=new Context()
  for(const ctx of [native,atomic])ctx.provide('launchEnvironment',createLaunchEnvironmentSnapshot([{source:'process',values:process.env}]))
  try {
    const path=await safePath(plan.home,plan.storage)
    await native.plugin(Local,{path,watch:false});await atomic.plugin(Atomic,{path,watch:false,managedRefs:plan.refs})
    return {native:native.credentials,atomic:atomic.credentials,recordKey:atomicReferenceRecordKey,dispose:async()=>{await atomic.fiber.dispose();await native.fiber.dispose()}}
  } catch(error) {await atomic.fiber.dispose();await native.fiber.dispose();throw error}
}
async function transfers(plan, contexts) {
  await contexts.native.modifyRecord('dsh-config-vault-transition/refresh',async()=>undefined)
  const values=[]
  for(const ref of plan.refs) {
    const current=await contexts.atomic.referenceSnapshot(ref), old=await contexts.native.resolve(ref)
    values.push({ref,current,native:old?.source==='file'?old.value:null})
  }
  return values
}
/** CLI-only. All modifications require an offline declaration and a fresh keyed preview token. */
async function transition(options) {
  if(typeof options.home!=='string'||!options.home.trim()||typeof options.passphrase!=='string'||options.passphrase.length<12||options.passphrase.length>1024) fail('provider-passphrase-required')
  const plan=await build(options)
  let contexts,tokenKey
  try {
    contexts=await credentialContexts(plan)
    const values=await transfers(plan,contexts)
    tokenKey=scryptSync(options.passphrase,`dsh-provider-plan-v1:${plan.home}`,32)
    const token=createHmac('sha256',tokenKey).update(canonical({plan,values})).digest('hex')
    if(!options.token)return {...publicPlan(plan),token}
    if(!options.offline||!options.allWritersStopped)fail('provider-offline-required')
    if(token!==options.token)fail('provider-stale-plan')
    const release=await syncLock(plan.home,'provider-transition')
    if(!release)fail('provider-busy')
    let releaseRestore
    try {
      try {releaseRestore=await restoreLock(plan.home)}catch{fail('provider-busy')}
      if(await readManaged(plan.home,'config-vault/active.vault')!==null)fail('provider-restore-active')
      // Re-plan inside the transition lock; no file or credential may have changed since preview.
      const fresh=await build(options),latest=await transfers(fresh,contexts)
      if(createHmac('sha256',tokenKey).update(canonical({plan:fresh,values:latest})).digest('hex')!==token)fail('provider-stale-plan')
      const journal=plan.mode==='enable'?{format:'dsh-provider-transition',version:1,id:randomUUID(),home:plan.home,installAnchor:plan.installAnchor,storage:plan.storage,refs:plan.refs,changes:plan.changes}:plan.original
      journal.phase=plan.mode==='enable'?'switching':'rolling-back'
      journal.lastOperation={mode:plan.mode,values:latest,changes:plan.changes}
      const persist=async()=>{
        const bytes=await seal(journal,options.passphrase)
        await writeManaged(plan.home,`config-vault/provider-history-${journal.id}.vault`,bytes)
        await writeManaged(plan.home,JOURNAL,bytes)
        await writeManaged(plan.home,RECEIPT,JSON.stringify({version:1,phase:journal.phase,profiles:journal.changes.map(x=>x.name),refs:journal.refs,storage:journal.storage,recipes:journal.changes.map(x=>({name:x.name,nodes:x.nodes}))}))
      }
      await persist()
      if(plan.mode==='rollback')for(const value of latest) {
        if(value.current.storedState==='set')await contexts.native.set(value.ref,value.current.value)
        else if(value.current.storedState==='unset')await contexts.native.unset(value.ref)
      }
      for(const change of plan.changes) {
        if(await readManaged(plan.home,change.path)!==change.before)fail('provider-stale-plan')
        if(change.before!==change.after)await writeManaged(plan.home,change.path,change.after)
        await options.onProgress?.({stage:'profile',profile:change.name})
      }
      for(const change of plan.changes)if(await readManaged(plan.home,change.path)!==change.after)fail('provider-stale-plan')
      if(plan.mode==='rollback') {
        for(const value of latest) {
          const actual=await contexts.native.resolve(value.ref)
          if((actual?.value??null)!==value.current.value)fail('provider-transfer-verification')
        }
        for(const ref of plan.refs)await contexts.atomic.deleteRecord(contexts.recordKey(ref))
      }
      journal.phase=plan.mode==='enable'?'enabled':'rolled-back';await persist()
      return {status:journal.phase,profiles:plan.changes.map(x=>x.name),refs:plan.refs,keysPreserved:true,restartRequired:true}
    }finally{await releaseRestore?.();await release()}
  }finally{tokenKey?.fill(0);await contexts?.dispose()}
}

export async function providerTransition(options) {
  try { return await transition(options) } catch(error) { if(error instanceof ProviderTransitionError) throw error; fail('provider-operation-failed') }
}
