/** Public registry check: only an explicit 404 authorizes an attempt to publish. */
import { readFile, appendFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

export async function checkVersion({ name, version }, fetcher = fetch) {
  if (name !== '@jeweis/dsh-sync' || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Expected @jeweis/dsh-sync with a stable release version')
  const response = await fetcher(`https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`, {
    headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30000), redirect: 'error',
  })
  if (response.status === 404) return true
  if (response.status !== 200) throw new Error(`Cannot determine published version: HTTP ${response.status}`)
  const published = await response.json()
  if (published.name !== name || published.version !== version) throw new Error('Registry returned unexpected package metadata')
  return false
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const publish = await checkVersion(pkg)
  console.log(publish ? `Publishing ${pkg.name}@${pkg.version}` : `${pkg.name}@${pkg.version} already exists; bump package.json and package-lock.json for another release.`)
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `publish=${publish}\n`)
}
