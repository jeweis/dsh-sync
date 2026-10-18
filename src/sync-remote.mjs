/** Encrypted sync heads live outside snapshot retention. Require real compare-and-swap. */
import { randomUUID } from 'node:crypto'
import { PROFILE } from './files.mjs'
import { hash } from './crypto.mjs'
const strong = etag => typeof etag === 'string' && /^"[^"\r\n]+"$/.test(etag)
export class SyncRemote {
  constructor(dav, space) {
    if (!PROFILE.test(space)) throw new Error('sync-invalid-data')
    this.dav = dav; this.directory = new URL('sync/', dav.base); this.url = new URL(`${space}.vault`, this.directory)
  }
  async read(signal, url = this.url) {
    const result = await this.dav.request('GET', url, { signal, limit: 1048576 })
    if (result.status === 404) return null
    if (result.status !== 200) throw new Error('sync-network')
    if (!strong(result.etag)) throw new Error('sync-no-cas')
    return result
  }
  async write(bytes, etag, signal, url = this.url) {
    if (etag !== null && !strong(etag)) throw new Error('sync-no-cas')
    const result = await this.dav.request('PUT', url, { body: bytes, signal, limit: 65536, headers: { 'Content-Type': 'application/octet-stream', ...etag === null ? { 'If-None-Match': '*' } : { 'If-Match': etag } } })
    if (result.status === 412) throw new Error('sync-remote-changed')
    if (![200, 201, 204].includes(result.status)) throw new Error('sync-network')
    const verified = await this.read(signal, url)
    if (!verified || hash(verified.bytes) !== hash(bytes)) throw new Error('sync-verification')
    return verified
  }
  async checkCAS(signal) {
    await this.dav.ensureCollection(signal, this.directory)
    const url = new URL(`probe-${randomUUID()}`, this.directory), bytes = Buffer.from('dsh-sync conditional write check')
    let created = false
    try {
      created = true; await this.write(bytes, null, signal, url)
      for (const headers of [{ 'If-Match': '"dsh-sync-stale-version"' }, { 'If-None-Match': '*' }]) {
        const result = await this.dav.request('PUT', url, { body: Buffer.from('must not replace'), headers, signal, limit: 65536 })
        if (result.status !== 412) throw new Error('sync-no-cas')
      }
      const unchanged = await this.read(signal, url)
      if (!unchanged || !unchanged.bytes.equals(bytes)) throw new Error('sync-no-cas')
    } finally {
      if (created && !signal?.aborted) {
        const latest = await this.read(signal, url).catch(() => null)
        if (latest) await this.dav.request('DELETE', url, { headers: { 'If-Match': latest.etag }, signal, limit: 65536 }).catch(() => {})
      }
    }
  }
}
