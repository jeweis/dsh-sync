/** Versioned authenticated encryption shared by snapshots and rollback journals. */
import { createCipheriv, createDecipheriv, randomBytes, scrypt as derive, createHash } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(derive)
export const MAX_BYTES = 16 * 1024 * 1024
export const hash = value => createHash('sha256').update(value).digest('hex')
const aad = Buffer.from('dsh-config-vault:1:scrypt:aes-256-gcm')

function password(value) {
  if (typeof value !== 'string' || value.length < 12 || value.length > 1024) throw new Error('Passphrase must contain 12–1024 characters')
}
function decode(value, length) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('Invalid encrypted envelope')
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value || (length !== undefined && bytes.length !== length)) throw new Error('Invalid encrypted envelope')
  return bytes
}

/** Encrypt JSON with fixed bounded KDF parameters, a fresh salt and nonce. */
export async function seal(value, passphrase) {
  password(passphrase)
  const plain = Buffer.from(JSON.stringify(value))
  if (plain.length > MAX_BYTES) throw new Error('Snapshot exceeds size limit')
  const salt = randomBytes(16), iv = randomBytes(12)
  const key = await scrypt(passphrase, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(aad)
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()])
    return Buffer.from(JSON.stringify({ format: 'dsh-config-vault', version: 1, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') }))
  } finally { key.fill(0); plain.fill(0) }
}

/** Authenticate before parsing; reject unknown envelope versions and oversized input. */
export async function unseal(bytes, passphrase) {
  password(passphrase)
  if (bytes.length > MAX_BYTES * 1.4) throw new Error('Encrypted object exceeds size limit')
  const envelope = JSON.parse(bytes.toString('utf8'))
  if (!envelope || envelope.format !== 'dsh-config-vault' || envelope.version !== 1) throw new Error('Unsupported vault format')
  const salt = decode(envelope.salt, 16), iv = decode(envelope.iv, 12), tag = decode(envelope.tag, 16)
  const ciphertext = decode(envelope.ciphertext)
  if (ciphertext.length > MAX_BYTES) throw new Error('Snapshot exceeds size limit')
  const key = await scrypt(passphrase, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
  let plain
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAAD(aad); decipher.setAuthTag(tag)
    plain = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    return JSON.parse(plain.toString('utf8'))
  } catch { throw new Error('Cannot decrypt vault: wrong passphrase, damaged data or invalid JSON') }
  finally { key.fill(0); plain?.fill(0) }
}
