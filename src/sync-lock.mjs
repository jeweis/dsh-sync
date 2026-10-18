import { mkdir, open, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { safePath, readManaged } from './files.mjs'
/** Cross-process lock; stale owners are reclaimed, malformed ownership fails closed. */
export async function syncLock(home, profileKey) {
  await mkdir(await safePath(home, 'config-vault'), { recursive: true, mode: 0o700 })
  const relative = `config-vault/sync-${profileKey}.lock`, path = await safePath(home, relative), token = randomUUID()
  for (let attempt = 0; attempt < 2; attempt++) {
    let file
    try { file = await open(path, 'wx', 0o600) }
    catch (error) {
      if (error.code !== 'EEXIST') throw error
      const raw = await readManaged(home, relative)
      if (!raw) continue
      const owner = JSON.parse(raw)
      if (!Number.isInteger(owner.pid) || owner.pid < 1) return null
      try { process.kill(owner.pid, 0); return null } catch (failure) { if (failure.code !== 'ESRCH') return null }
      if (await readManaged(home, relative) === raw) await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error })
      continue
    }
    try { await file.writeFile(JSON.stringify({ pid: process.pid, token })) } finally { await file.close() }
    return async () => { const raw = await readManaged(home, relative); if (raw && JSON.parse(raw).token === token) await unlink(path) }
  }
  return null
}
