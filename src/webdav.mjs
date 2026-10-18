/** Bounded same-origin WebDAV operations. Redirects are never followed. */
import http from 'node:http'
import https from 'node:https'
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import { MAX_BYTES } from './crypto.mjs'
import { validateId } from './snapshot.mjs'
import { OperationError } from './operation-error.mjs'
const stageFor = method => ({ MKCOL: 'mkdir', PUT: 'upload', GET: 'download', PROPFIND: 'list', DELETE: 'cleanup' })[method]

export class WebDAV {
  constructor({ url, username = '', password = '', timeoutMs = 30000 }) {
    this.base = new URL(url)
    if (!['http:', 'https:'].includes(this.base.protocol)) throw new Error('WebDAV requires HTTP or HTTPS')
    if (this.base.username || this.base.password || this.base.search || this.base.hash) throw new Error('WebDAV URL must not contain credentials, query or fragment')
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error('Invalid WebDAV timeout')
    if (username.includes(':') || /[\r\n]/.test(username + password)) throw new Error('Invalid WebDAV credentials')
    this.base.pathname = this.base.pathname.replace(/\/*$/, '/')
    this.retentionScope = JSON.stringify({ url: this.base.href, username })
    this.authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
    this.timeoutMs = timeoutMs
  }

  /** Consume even error bodies under a byte/time budget, without exposing server text. */
  async request(method, url, { body, headers = {}, signal, limit = MAX_BYTES * 1.4, stage = stageFor(method) } = {}) {
    const combined = AbortSignal.any([AbortSignal.timeout(this.timeoutMs), ...signal ? [signal] : []])
    return new Promise((resolve, reject) => {
      const client = url.protocol === 'https:' ? https : http
      const req = client.request(url, { method, signal: combined, headers: { Authorization: this.authorization, ...body ? { 'Content-Length': body.length } : {}, ...headers } }, res => {
        const chunks = []; let length = 0
        res.on('data', chunk => {
          length += chunk.length
          if (length > limit) { res.destroy(); reject(new OperationError('WebDAV response exceeds size limit', { stage, reason: 'size' })); return }
          chunks.push(chunk)
        })
        res.on('error', () => reject(new OperationError('WebDAV response interrupted', { stage, reason: combined.aborted ? (signal?.aborted ? 'cancelled' : 'timeout') : 'network' })))
        res.on('end', () => resolve({ status: res.statusCode, bytes: Buffer.concat(chunks), etag: typeof res.headers.etag === 'string' ? res.headers.etag : null }))
      })
      req.on('error', error => reject(new OperationError(combined.aborted ? 'WebDAV request cancelled or timed out' : 'WebDAV connection failed', {
        stage, reason: combined.aborted ? (signal?.aborted ? 'cancelled' : 'timeout') : /^(ERR_TLS_|ERR_SSL_|CERT_|DEPTH_ZERO_SELF_SIGNED_CERT$|SELF_SIGNED_CERT_IN_CHAIN$|UNABLE_TO_VERIFY_LEAF_SIGNATURE$|UNABLE_TO_GET_ISSUER_CERT_LOCALLY$)/.test(error.code ?? '') ? 'tls' : 'network',
      })))
      req.end(body)
    })
  }

  collection() { return new URL('snapshots/', this.base) }
  object(id) { return new URL(`${validateId(id)}.vault`, this.collection()) }

  async collectionExists(url, signal, stage = 'mkdir') {
    const body = Buffer.from('<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>')
    const result = await this.request('PROPFIND', url, { body, signal, stage, headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' }, limit: 2 * 1024 * 1024 })
    if (result.status === 404) return false
    if (result.status !== 207) throw new OperationError(`WebDAV directory check failed (${result.status})`, { stage, reason: 'http', status: result.status })
    try {
      const xml = result.bytes.toString('utf8')
      if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw new Error()
      const parsed = new XMLParser({ removeNSPrefix: true, processEntities: false, parseTagValue: false, ignoreAttributes: true }).parse(xml)
      for (const response of [parsed.multistatus?.response ?? []].flat()) {
        if (typeof response.href !== 'string') continue
        const href = new URL(response.href, url)
        if (href.origin !== url.origin || href.search || href.hash || href.pathname.replace(/\/$/, '') !== url.pathname.replace(/\/$/, '')) continue
        for (const propstat of [response.propstat ?? []].flat()) {
          const type = propstat.prop?.resourcetype
          if (/^HTTP\/\S+ 200(?:\s|$)/.test(propstat.status) && type && typeof type === 'object' && Object.hasOwn(type, 'collection')) return true
        }
      }
      throw new Error()
    } catch { throw new OperationError('WebDAV resource is not a confirmed collection', { stage, reason: 'invalid-data' }) }
  }

  async testConnection(signal) {
    return { connected: true, directoryExists: await this.collectionExists(this.collection(), signal, 'list') }
  }

  async ensureCollection(signal, target = this.collection()) {
    // Find the closest existing collection first. NAS mount/share ancestors need
    // not permit MKCOL, and must never be recreated just to reach a child.
    const missing = []
    let url = target
    while (!await this.collectionExists(url, signal)) {
      if (url.pathname === '/' || missing.length >= 128) throw new OperationError('No usable WebDAV parent collection', { stage: 'mkdir', reason: 'failed' })
      missing.push(url)
      url = new URL('../', url)
    }
    for (const directory of missing.reverse()) {
      const result = await this.request('MKCOL', directory, { signal, limit: 65536 })
      if (result.status === 201) continue
      // Another client may have created it after our probe; a status alone
      // (including 405) is not evidence that a usable collection exists.
      if ([405, 409].includes(result.status) && await this.collectionExists(directory, signal)) continue
      throw new OperationError(`WebDAV MKCOL failed (${result.status})`, { stage: 'mkdir', reason: 'http', status: result.status })
    }
  }

  /** Conditional create: a UUID snapshot is never silently replaced. */
  async put(id, bytes, signal) {
    await this.ensureCollection(signal)
    const result = await this.request('PUT', this.object(id), { body: bytes, signal, headers: { 'Content-Type': 'application/octet-stream', 'If-None-Match': '*' }, limit: 65536 })
    if (![201, 204].includes(result.status)) throw new OperationError(`WebDAV upload failed (${result.status}); if the connection failed, list snapshots to check whether it completed`, { stage: 'upload', reason: 'http', status: result.status })
  }

  async get(id, signal) {
    return (await this.getVersion(id, signal)).bytes
  }

  async getVersion(id, signal) {
    const result = await this.request('GET', this.object(id), { signal })
    if (result.status !== 200) throw new OperationError(`WebDAV download failed (${result.status})`, { stage: 'download', reason: 'http', status: result.status })
    return { bytes: result.bytes, etag: result.etag }
  }

  async remove(id, etag, signal) {
    if (!/^"[^"\r\n]+"$/.test(etag ?? '')) throw new OperationError('A strong ETag is required for cleanup', { stage: 'cleanup', reason: 'invalid-data' })
    const result = await this.request('DELETE', this.object(id), { signal, headers: { 'If-Match': etag }, limit: 65536 })
    if (![200, 204, 404].includes(result.status)) throw new OperationError(`WebDAV cleanup failed (${result.status})`, { stage: 'cleanup', reason: 'http', status: result.status })
  }

  /** Return names only; metadata is trusted only after authenticated download. */
  async list(signal) {
    const body = Buffer.from('<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>')
    const result = await this.request('PROPFIND', this.collection(), { body, signal, headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' }, limit: 2 * 1024 * 1024 })
    if (result.status === 404) return []
    if (result.status !== 207) throw new OperationError(`WebDAV listing failed (${result.status})`, { stage: 'list', reason: 'http', status: result.status })
    const xml = result.bytes.toString('utf8')
    if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw new Error('Invalid WebDAV XML')
    const parsed = new XMLParser({ removeNSPrefix: true, processEntities: false, parseTagValue: false, ignoreAttributes: true }).parse(xml)
    if (!Object.hasOwn(parsed, 'multistatus') || (parsed.multistatus !== '' && typeof parsed.multistatus !== 'object')) throw new Error('Invalid WebDAV multistatus')
    const responses = parsed.multistatus.response === undefined ? [] : [parsed.multistatus.response].flat()
    const ids = new Set(), directory = this.collection()
    for (const response of responses) {
      if (typeof response.href !== 'string') throw new Error('Invalid WebDAV resource href')
      const url = new URL(response.href, directory)
      if (url.origin !== directory.origin || url.search || url.hash || !url.pathname.startsWith(directory.pathname)) continue
      const tail = decodeURIComponent(url.pathname.slice(directory.pathname.length))
      if (!tail.endsWith('.vault') || tail.includes('/')) continue
      try { ids.add(validateId(tail.slice(0, -6))) } catch { /* Ignore unrelated files in the collection. */ }
    }
    return [...ids].sort().reverse()
  }
}
