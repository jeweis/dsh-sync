/** Ephemeral HTTPS WebDAV used only by explicit isolated acceptance runs. */
import https from 'node:https'
import { readFile, mkdir, writeFile, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomBytes, createHash } from 'node:crypto'

const root = process.env.DSH_VAULT_ACCEPTANCE_DIR
if (!root || !resolve(root).startsWith('/private/tmp/dsh-vault-rc2-acceptance.')) throw new Error('Set a dedicated temporary acceptance directory')
const username = 'acceptance-user', password = randomBytes(24).toString('base64url')
const objects = new Map(), collections = new Set(['/'])
const counts = { MKCOL: 0, PUT: 0, GET: 0, PROPFIND: 0, DELETE: 0, rejected: 0 }
const directory = resolve(root, 'webdav')
await mkdir(directory, { recursive: true, mode: 0o700 })
await writeFile(resolve(directory, 'credentials.json'), JSON.stringify({ username, password }), { mode: 0o600 })
const record = () => writeFile(resolve(directory, 'audit.json'), JSON.stringify({ ...counts, objects: [...objects.keys()] }, null, 2), { mode: 0o600 })
const server = https.createServer({ key: await readFile(resolve(root, 'tls/key.pem')), cert: await readFile(resolve(root, 'tls/cert.pem')) }, async (req, res) => {
  if (req.headers.authorization !== `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`) {
    counts.rejected++; await record(); res.writeHead(401); res.end(); return
  }
  const pathname = new URL(req.url, 'https://localhost').pathname
  if (!Object.hasOwn(counts, req.method)) { res.writeHead(405); res.end(); return }
  counts[req.method]++
  if (req.method === 'MKCOL') {
    if (!collections.has(new URL('../', `https://localhost${pathname}`).pathname)) { await record(); res.writeHead(409); res.end(); return }
    const exists = collections.has(pathname); collections.add(pathname)
    await record(); res.writeHead(exists ? 405 : 201); res.end(); return
  }
  if (req.method === 'PUT') {
    if (!collections.has(new URL('.', `https://localhost${pathname}`).pathname)) { await record(); res.writeHead(409); res.end(); return }
    if (objects.has(pathname) && req.headers['if-none-match'] === '*') { res.writeHead(412); res.end(); return }
    const chunks = []; let size = 0
    for await (const chunk of req) { size += chunk.length; if (size > 24 * 1024 * 1024) { res.writeHead(413); res.end(); return }; chunks.push(chunk) }
    const bytes = Buffer.concat(chunks); objects.set(pathname, bytes)
    await writeFile(resolve(directory, pathname.split('/').at(-1)), bytes, { mode: 0o600 })
    await record(); res.writeHead(201); res.end(); return
  }
  if (req.method === 'GET') {
    await record(); const bytes = objects.get(pathname)
    res.writeHead(bytes ? 200 : 404, bytes ? { ETag: '"' + createHash('sha256').update(bytes).digest('hex') + '"' } : {}); res.end(bytes); return
  }
  if (req.method === 'DELETE') {
    const bytes = objects.get(pathname)
    if (!bytes) { await record(); res.writeHead(404); res.end(); return }
    const etag = '"' + createHash('sha256').update(bytes).digest('hex') + '"'
    if (req.headers['if-match'] !== etag) { await record(); res.writeHead(412); res.end(); return }
    objects.delete(pathname)
    await unlink(resolve(directory, pathname.split('/').at(-1)))
    await record(); res.writeHead(204); res.end(); return
  }
  await record()
  if (!collections.has(pathname)) { res.writeHead(404); res.end(); return }
  const paths = req.headers.depth === '0' ? [] : [...objects.keys()].filter(path => path.startsWith(pathname))
  res.writeHead(207, { 'Content-Type': 'application/xml' })
  res.end(`<d:multistatus xmlns:d="DAV:"><d:response><d:href>${pathname}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>${paths.map(path => `<d:response><d:href>${path}</d:href><d:propstat><d:prop/><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`).join('')}</d:multistatus>`)
})
server.listen(0, '127.0.0.1', async () => {
  const url = `https://127.0.0.1:${server.address().port}/acceptance/`
  await writeFile(resolve(directory, 'endpoint.json'), JSON.stringify({ url }), { mode: 0o600 })
  console.log(`Acceptance WebDAV: ${url}`)
})
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.closeAllConnections(); server.close() })
