/** Constrained filesystem access; never follow links in a home or managed path. */
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { resolve, parse, join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'

export const PROFILE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/
export const managedPath = path => typeof path === 'string' && (/^profiles\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}\/(package\.json|cordis\.patch\.yml|pnpm-lock\.yaml)$/.test(path) || path === 'cordis.patch.yml')

/** Check every existing component including ancestors of the configured root. */
export async function safePath(home, path = '') {
  if (typeof path !== 'string' || path.includes('\\') || path.split('/').some(p => p === '..' || p === '.') || path.startsWith('/')) throw new Error('Unsafe relative path')
  const target = resolve(home, path), root = parse(target).root
  let current = root
  for (const part of target.slice(root.length).split('/').filter(Boolean)) {
    current = join(current, part)
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink()) throw new Error('Symbolic links are not supported in managed paths')
      if (current !== target && !info.isDirectory()) throw new Error('Managed path parent is not a directory')
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  return target
}

/** Return an absent file as null; cap size before and during reading. */
export async function readManaged(home, path) {
  const target = await safePath(home, path)
  let file
  try { file = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
  try {
    const info = await file.stat()
    const limit = path.startsWith('config-vault/') ? 24 * 1024 * 1024 : 2 * 1024 * 1024
    if (!info.isFile() || info.size > limit) throw new Error('Managed file is not a regular file or exceeds size limit')
    const bytes = Buffer.alloc(Math.min(info.size + 1, limit + 1))
    let bytesRead = 0
    while (bytesRead < bytes.length) {
      const read = await file.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead)
      if (read.bytesRead === 0) break
      bytesRead += read.bytesRead
    }
    if (bytesRead > info.size || bytesRead > limit) throw new Error('Managed file grew during reading; retry')
    const content = bytes.subarray(0, bytesRead).toString('utf8')
    if (!Buffer.from(content).equals(bytes.subarray(0, bytesRead))) throw new Error('Managed file is not UTF-8')
    return content
  } finally { await file.close() }
}

/** Replace one file with a flushed private sibling, or remove it for rollback. */
export async function writeManaged(home, path, content) {
  let target = await safePath(home, path)
  if (content === null) { try { await unlink(target) } catch (error) { if (error.code !== 'ENOENT') throw error }; return }
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  target = await safePath(home, path)
  const temporary = `${target}.${randomUUID()}.tmp`
  const file = await open(temporary, 'wx', 0o600)
  try {
    await file.writeFile(content); await file.sync(); await file.close()
    await safePath(home, path)
    await rename(temporary, target)
  } finally {
    await file.close().catch(() => {})
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error })
  }
}
