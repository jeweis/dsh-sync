import test from 'node:test'
import assert from 'node:assert/strict'
import {cp,mkdir,readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {home} from './helpers.mjs'
const exec=promisify(execFile)

test('GitHub prepare builds the settings entry with no node_modules, sibling workspace or Harness source',async t=>{
 const target=await home(t),root=new URL('../',import.meta.url)
 await mkdir(join(target,'scripts'));await mkdir(join(target,'src'))
 await cp(new URL('package.json',root),join(target,'package.json'))
 await cp(new URL('scripts/build.mjs',root),join(target,'scripts/build.mjs'))
 await cp(new URL('src/client',root),join(target,'src/client'),{recursive:true})
 await cp(new URL('assets',root),join(target,'assets'),{recursive:true})
 await exec('npm',['run','prepare'],{cwd:target,timeout:30000,env:{...process.env,npm_config_audit:'false',npm_config_fund:'false'}})
 const built=await readFile(join(target,'lib/client.js'),'utf8')
 assert.ok(built.includes('id:"@jeweis/dsh-sync"'))
 assert.ok(built.includes('settings.section'));assert.ok(built.includes('data:image/svg+xml;base64,'))
})
