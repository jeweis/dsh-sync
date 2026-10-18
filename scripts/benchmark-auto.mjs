/** Isolated unchanged-configuration benchmark; never connects to remote storage. */
import { mkdtemp, mkdir, writeFile, rm, open, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { parseArgs } from 'node:util'
import { AutoBackup, fingerprint } from '../src/auto-backup.mjs'
import { collect } from '../src/snapshot.mjs'

const { values } = parseArgs({ options: { output: { type: 'string' }, rounds: { type: 'string' } } })
if (values.rounds && (!/^\d+$/.test(values.rounds) || +values.rounds < 1 || +values.rounds > 10000)) throw new Error('Invalid rounds')
const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-auto-benchmark-')))
const probe = await open(join(root, 'probe'), 'wx')
const proto = Object.getPrototypeOf(probe), read = proto.read, sync = proto.sync
await probe.close()
let measuring = null
proto.read = async function(...args) { const result = await read.apply(this, args); if (measuring) { measuring.readCalls++; measuring.readBytes += result.bytesRead } return result }
proto.sync = async function(...args) { if (measuring) measuring.fsyncCalls++; return sync.apply(this, args) }
const rows = []
try {
  for (const scenario of [
    { name: 'small', profiles: 1, lockKiB: 16, patchKiB: 1, rounds: 10 },
    { name: 'medium', profiles: 5, lockKiB: 128, patchKiB: 8, rounds: 5 },
    { name: 'large', profiles: 10, lockKiB: 256, patchKiB: 16, rounds: 3 },
  ]) {
    scenario.rounds = values.rounds ? +values.rounds : scenario.rounds
    const home = join(root, scenario.name), profiles = []
    let sourceBytes = 0
    for (let i = 0; i < scenario.profiles; i++) {
      const name = `profile${i}`, directory = join(home, 'profiles', name)
      profiles.push(name); await mkdir(directory, { recursive: true })
      const manifest = JSON.stringify({ private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } })
      const patch = '# benchmark fixture\n' + '# example configuration comment\n'.repeat(Math.ceil(scenario.patchKiB * 1024 / 32))
      const lines = ["lockfileVersion: '9.0'", 'packages:']
      const count = Math.ceil(scenario.lockKiB * 1024 / 70)
      for (let j = 0; j < count; j++) lines.push(`  entry${j}:`, '    resolution: {integrity: sha512-example}')
      const lockfile = lines.join('\n') + '\n'
      for (const [file, content] of [['package.json', manifest], ['cordis.patch.yml', patch], ['pnpm-lock.yaml', lockfile]]) { await writeFile(join(directory, file), content); sourceBytes += Buffer.byteLength(content) }
    }
    const config = { url: 'https://benchmark.invalid/dav/', username: 'example', profiles, includeHomePatch: false, encryption: false, autoBackup: { enabled: true, debounceMs: 30000, minIntervalMs: 300000 } }
    await mkdir(join(home, 'config-vault'))
    const snapshot = await collect({ home, ...config })
    await writeFile(join(home, 'config-vault/auto-state.json'), JSON.stringify({ version: 1, fingerprint: fingerprint(snapshot, config) }))
    const worker = new AutoBackup({ home, connection: async () => { throw new Error('Benchmark must never connect to WebDAV') } })
    let now = 1800000000000
    await worker.step({ config, now })
    globalThis.gc?.()
    const heapBefore = process.memoryUsage().heapUsed
    const counters = { readCalls: 0, readBytes: 0, fsyncCalls: 0 }, times = [], cpus = []
    let rssMax = process.memoryUsage().rss
    measuring = counters
    for (let round = 0; round < scenario.rounds; round++) {
      now += 5000
      const cpu = process.cpuUsage(), start = performance.now()
      await worker.step({ config, now })
      times.push(performance.now() - start)
      const used = process.cpuUsage(cpu); cpus.push((used.user + used.system) / 1000)
      rssMax = Math.max(rssMax, process.memoryUsage().rss)
      if (worker.status.phase !== 'watching') throw new Error('Benchmark did not remain idle')
    }
    measuring = null
    globalThis.gc?.()
    const heapAfter = process.memoryUsage().heapUsed
    const avg = numbers => numbers.reduce((sum, n) => sum + n, 0) / numbers.length
    rows.push({ scenario: scenario.name, profiles: scenario.profiles, files: scenario.profiles * 3, sourceKiB: +(sourceBytes / 1024).toFixed(1), rounds: scenario.rounds,
      wallMeanMs: +avg(times).toFixed(3), cpuMeanMs: +avg(cpus).toFixed(3), cpuAtFiveSecondPollPercent: +(avg(cpus) / 50).toFixed(3),
      readCallsPerCycle: counters.readCalls / scenario.rounds, readKiBPerCycle: +(counters.readBytes / scenario.rounds / 1024).toFixed(2), fsyncPerCycle: counters.fsyncCalls / scenario.rounds,
      observedProcessRssMiB: +(rssMax / 1024 / 1024).toFixed(1),
      heapDeltaAfterGcKiB: globalThis.gc ? +((heapAfter - heapBefore) / 1024).toFixed(1) : null })
  }
  const result = { node: process.version, platform: process.platform, arch: process.arch, description: 'Warm-cache unchanged worker.step only; CPU percentage extrapolates one cycle per 5 seconds, RSS is the whole benchmark process, not incremental Harness memory.', rows }
  if (values.output) await writeFile(values.output, JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result, null, 2))
} finally { measuring = null; proto.read = read; proto.sync = sync; await rm(root, { recursive: true, force: true }) }
