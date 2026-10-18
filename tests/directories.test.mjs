import test from 'node:test'
import assert from 'node:assert/strict'
import { WebDAV } from '../src/webdav.mjs'
import { backup } from '../src/engine.mjs'
import { home, dav, passphrase } from './helpers.mjs'

test('backup creates every missing parent in order on a server that enforces parent existence', async t => {
  const fixture = await dav(t)
  const remote = new WebDAV({ ...fixture.options, url: fixture.options.url + 'one/two/' })
  assert.deepEqual(await remote.testConnection(), { connected: true, directoryExists: false })
  assert.ok(fixture.requests.every(item => item.method === 'PROPFIND'))
  const result = await backup({ home: await home(t, true), remote, passphrase })
  assert.equal(result.verified, true)
  const expected = ['/vault%20test/', '/vault%20test/one/', '/vault%20test/one/two/', '/vault%20test/one/two/snapshots/']
  assert.deepEqual(fixture.requests.filter(item => item.method === 'MKCOL').map(item => item.path), expected)
  assert.deepEqual(await remote.testConnection(), { connected: true, directoryExists: true })
})

test('existing NAS mount ancestors are not recreated, even when MKCOL there would return 409', async t => {
  const fixture = await dav(t)
  for (const path of ['/mount/', '/mount/share/']) {
    fixture.collections.add(path)
    fixture.control.pathStatus[`MKCOL ${path}`] = 409
  }
  const remote = new WebDAV({ ...fixture.options, url: new URL('/mount/share/new/backup/', fixture.options.url).href })
  assert.equal((await backup({ home: await home(t, true), remote, passphrase })).verified, true)
  assert.deepEqual(fixture.requests.filter(item => item.method === 'MKCOL').map(item => item.path), ['/mount/share/new/', '/mount/share/new/backup/', '/mount/share/new/backup/snapshots/'])
})

test('MKCOL conflict is accepted only after confirming a real collection; unsupported MKCOL is rejected', async t => {
  const fixture = await dav(t)
  fixture.collections.add('/vault%20test/')
  fixture.control.methodStatus.MKCOL = 405
  await assert.rejects(fixture.remote.ensureCollection(), error => error.stage === 'mkdir' && error.status === 405)
  assert.equal(fixture.requests.some(item => item.method === 'PUT'), false)
  fixture.control.methodStatus.MKCOL = 409
  const request = fixture.remote.request.bind(fixture.remote)
  fixture.remote.request = async (method, url, options) => {
    if (method === 'MKCOL') fixture.collections.add(url.pathname) // concurrent client creates it
    return request(method, url, options)
  }
  await fixture.remote.ensureCollection()
  assert.ok(fixture.collections.has('/vault%20test/snapshots/'))
})

test('directory probes reject files, foreign hrefs, malformed XML and denied access without writes', async t => {
  const fixture = await dav(t)
  fixture.collections.add('/vault%20test/snapshots/')
  for (const xml of [
    '<broken', '<!DOCTYPE x><multistatus/>',
    '<multistatus><response><href>/vault%20test/snapshots/</href><propstat><prop><resourcetype/></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>',
    '<multistatus><response><href>https://foreign.example/vault%20test/snapshots/</href><propstat><prop><resourcetype><collection/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>',
  ]) {
    fixture.control.xml = xml
    await assert.rejects(fixture.remote.testConnection(), error => error.reason === 'invalid-data')
  }
  fixture.control.xml = null
  fixture.control.methodStatus.PROPFIND = 403
  await assert.rejects(fixture.remote.testConnection(), error => error.status === 403)
  assert.ok(fixture.requests.every(item => item.method === 'PROPFIND'))
})
