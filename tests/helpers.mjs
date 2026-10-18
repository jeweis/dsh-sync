import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import { createHash } from 'node:crypto'
import { WebDAV } from '../src/webdav.mjs'
export const passphrase = 'test-only-long-passphrase'
export const manifest = JSON.stringify({ name: 'dsh-profile-web', private: true, dependencies: { 'test-plugin': '1.2.3' }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'test-plugin'] } } }, null, 2)
export const patch = '- id: model\n  config:\n    model: test-model\n'
export async function home(t, seeded = false) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'dsh-vault-test-')))
  t.after(() => rm(dir, { recursive: true, force: true }))
  if (seeded) {
    await mkdir(join(dir, 'profiles/web'), { recursive: true })
    await writeFile(join(dir, 'profiles/web/package.json'), manifest)
    await writeFile(join(dir, 'profiles/web/cordis.patch.yml'), patch)
    await writeFile(join(dir, '.credentials.yaml'), 'never-collect-this-secret')
    await writeFile(join(dir, '.env'), 'PRIVATE=never-collect-env')
  }
  return dir
}
export async function dav(t) {
  const objects = new Map(), requests = [], collections = new Set(['/'])
  const control = { status: null, methodStatus: {}, pathStatus: {}, redirect: false, corrupt: false, delay: false, oversized: false, xml: null, noEtag: false, weakEtag: false, beforeDelete: null, beforePut: null, ignoreConditions: false }
  const server = http.createServer(async (req, res) => {
    requests.push({ method: req.method, path: req.url, authorization: req.headers.authorization, condition: req.headers['if-none-match'], ifMatch: req.headers['if-match'] })
    if (req.headers.authorization !== 'Basic ' + Buffer.from('test-user:test-password').toString('base64')) { res.writeHead(401); res.end(); return }
    const pathStatus = control.pathStatus[`${req.method} ${req.url}`]
    if (pathStatus) { res.writeHead(pathStatus); res.end(); return }
    if (control.methodStatus[req.method]) { res.writeHead(control.methodStatus[req.method]); res.end('private-server-body-must-not-appear'); return }
    if (control.delay) return
    if (control.redirect) { res.writeHead(302, { Location: 'http://127.0.0.1:1/steal' }); res.end(); return }
    if (control.status) { res.writeHead(control.status); res.end('must-not-leak-server-detail'); return }
    const url = new URL(req.url, 'http://local')
    if (req.method === 'MKCOL') {
      const parent = new URL('../', url).pathname
      if (!collections.has(parent)) { res.writeHead(409); res.end(); return }
      const exists = collections.has(url.pathname); collections.add(url.pathname); res.writeHead(exists ? 405 : 201); res.end(); return
    }
    if (req.method === 'PUT') {
      await control.beforePut?.(url.pathname, objects)
      if (!collections.has(new URL('.', url).pathname)) { res.writeHead(409); res.end(); return }
      if (!control.ignoreConditions && objects.has(url.pathname) && req.headers['if-none-match'] === '*') { res.writeHead(412); res.end(); return }
      if (!control.ignoreConditions && req.headers['if-match'] && (!objects.has(url.pathname) || req.headers['if-match'] !== '"' + createHash('sha256').update(objects.get(url.pathname)).digest('hex') + '"')) { res.writeHead(412); res.end(); return }
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      objects.set(url.pathname, Buffer.concat(chunks)); res.writeHead(201); res.end(); return
    }
    if (req.method === 'GET') {
      if (!objects.has(url.pathname)) { res.writeHead(404); res.end(); return }
      const etag = '"' + createHash('sha256').update(objects.get(url.pathname)).digest('hex') + '"'
      res.writeHead(200, control.noEtag ? {} : { ETag: (control.weakEtag ? 'W/' : '') + etag })
      res.end(control.oversized ? Buffer.alloc(24 * 1024 * 1024) : control.corrupt ? Buffer.from('corrupt') : objects.get(url.pathname)); return
    }
    if (req.method === 'DELETE') {
      await control.beforeDelete?.(url.pathname, objects)
      if (!objects.has(url.pathname)) { res.writeHead(404); res.end(); return }
      const etag = '"' + createHash('sha256').update(objects.get(url.pathname)).digest('hex') + '"'
      if (req.headers['if-match'] !== etag) { res.writeHead(412); res.end(); return }
      objects.delete(url.pathname); res.writeHead(204); res.end(); return
    }
    if (req.method === 'PROPFIND') {
      if (!collections.has(url.pathname)) { res.writeHead(404); res.end(); return }
      res.writeHead(207, { 'Content-Type': 'application/xml' })
      const self = `<D:response><D:href>${url.pathname}</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`
      const paths = req.headers.depth === '0' ? [] : [...objects.keys()].filter(path => path.startsWith(url.pathname))
      res.end(control.xml ?? `<D:multistatus xmlns:D="DAV:">${self}${paths.map(path => `<D:response><D:href>${path}</D:href><D:propstat><D:prop/><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`).join('')}</D:multistatus>`); return
    }
    res.writeHead(405); res.end()
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) })
  const url = `http://127.0.0.1:${server.address().port}/vault%20test/`
  const options = { url, username: 'test-user', password: 'test-password' }
  return { remote: new WebDAV(options), options, objects, requests, control, collections }
}
