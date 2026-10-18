import { mkdir,writeFile,symlink,readFile } from 'node:fs/promises'
import { join,dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import Local from '@deepseek-ai/dsh-credentials-local'
import Atomic from '../src/atomic-credentials.mjs'
import { providerTransition } from '../src/provider-transition.mjs'
import { home,passphrase } from './helpers.mjs'
import { RUNTIME } from '../src/snapshot.mjs'
const require=createRequire(import.meta.url),root=fileURLToPath(new URL('..',import.meta.url)),ref='FIXTURE_TRANSITION_KEY',first='fixture-initial-key'
const packageName=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).name
export async function transitionFixture(t) {
 const directory=await home(t),anchor=join(directory,'runtime/package.json')
 await mkdir(join(directory,'runtime/node_modules/@deepseek-ai/dsh'),{recursive:true})
 await writeFile(anchor,'{"name":"test-runtime-anchor"}')
 await writeFile(join(directory,'runtime/node_modules/@deepseek-ai/dsh/package.json'),JSON.stringify({name:'@deepseek-ai/dsh',version:RUNTIME}))
 await symlink(dirname(require.resolve('@deepseek-ai/cordis-plugin-include/package.json')),join(directory,'runtime/node_modules/@deepseek-ai/cordis-plugin-include'))
 for(const profile of ['a','b']) {
  const dir=join(directory,'profiles',profile),bundle=join(dir,'node_modules/transition-fixture-bundle')
  await mkdir(bundle,{recursive:true})
  await mkdir(dirname(join(dir,'node_modules',packageName)),{recursive:true})
  await symlink(root,join(dir,'node_modules',packageName))
  await writeFile(join(dir,'package.json'),JSON.stringify({name:`profile-${profile}`,dsh:{profile:{bundles:['transition-fixture-bundle']}}}))
  await writeFile(join(bundle,'package.json'),JSON.stringify({name:'transition-fixture-bundle',dsh:{bundle:{patch:'cordis.patch.yml'}}}))
  await writeFile(join(bundle,'cordis.patch.yml'),JSON.stringify([{insert:[{id:'credentials',name:'@deepseek-ai/dsh-credentials-local',config:{dshHome:directory,watch:false}},{id:'deepseek',name:'@deepseek-ai/dsh-llm-deepseek-api-key',config:{apiKeyEnv:ref}}]}]))
  await writeFile(join(dir,'cordis.patch.yml'),'# preserve this comment\n[]\n')
  await writeFile(join(dir,'cordis.yml'),'[]\n')
 }
 const options={home:directory,installAnchor:anchor,mode:'enable',passphrase}
 const mount=async Provider=>{const ctx=new Context();await ctx.plugin(Provider,{dshHome:directory,watch:false,...Provider===Atomic?{managedRefs:[ref]}:{}});return ctx}
 const native=await mount(Local);await native.credentials.set(ref,first);await native.fiber.dispose()
 return {home:directory,anchor,options,mount,preview:(extra={})=>providerTransition({...options,...extra}),apply:async(extra={})=>{const plan=await providerTransition({...options,...extra});return providerTransition({...options,...extra,token:plan.token,offline:true,allWritersStopped:true})}}
}
