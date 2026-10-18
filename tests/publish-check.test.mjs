import test from 'node:test'
import assert from 'node:assert/strict'
import { checkVersion } from '../scripts/publish-check.mjs'
const pkg={name:'@jeweis/dsh-sync',version:'0.9.0'}

test('release check publishes only missing stable versions and skips an exact existing version',async()=>{
 assert.equal(await checkVersion(pkg,async(url,options)=>{
  assert.equal(url,'https://registry.npmjs.org/%40jeweis%2Fdsh-sync/0.9.0');assert.equal(options.redirect,'error')
  return new Response('',{status:404})
 }),true)
 assert.equal(await checkVersion(pkg,async()=>Response.json(pkg)),false)
})

test('registry failures, incorrect metadata and unexpected package names cannot be mistaken for missing versions',async()=>{
 for(const status of [401,403,429,500,503])await assert.rejects(checkVersion(pkg,async()=>new Response('',{status})),/Cannot determine/)
 await assert.rejects(checkVersion(pkg,async()=>{throw new Error('offline')}),/offline/)
 await assert.rejects(checkVersion(pkg,async()=>Response.json({...pkg,version:'1.0.0'})),/unexpected/)
 await assert.rejects(checkVersion({...pkg,name:'other'},async()=>assert.fail()),/Expected/)
 await assert.rejects(checkVersion({...pkg,version:'0.9.1-beta.1'},async()=>assert.fail()),/stable/)
})
