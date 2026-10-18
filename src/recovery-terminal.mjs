/** One offline handoff command; secrets are prompted, never shell arguments or environment exports. */
import { createInterface } from 'node:readline/promises'
import { Writable } from 'node:stream'
import { finishRecovery } from './recovery-guide.mjs'

export async function recoveryTerminal(options, { input = process.stdin, output = process.stdout } = {}) {
  if (!options.offline) throw new Error('请先退出使用目标配置的全部 Harness 窗口和后台进程，再加 --offline。离线不代表断网。')
  if (!input.isTTY || !output.isTTY) throw new Error('请在交互终端运行此命令，以便输入口令并确认恢复。')
  let hidden = false
  const sink = new Writable({ write(chunk, _encoding, callback) { if (!hidden) output.write(chunk); callback() } })
  const rl = createInterface({ input, output: sink, terminal: true })
  let passphrase
  try {
    const answer = rl.question('请输入备份加密口令（输入不会显示）：')
    hidden = true
    try { passphrase = await answer } finally { hidden = false; output.write('\n') }
    const { plan } = await finishRecovery({ ...options, passphrase })
    output.write(`将恢复配置 ${plan.selection.sourceProfile} → ${plan.selection.targetProfile}\n目标：${plan.home}\n`)
    for (const file of plan.files) output.write(`${file.action === 'create' ? '新增' : file.action === 'replace' ? '替换' : '不变'}：${file.path}\n`)
    output.write('恢复前会保存加密的回退副本。不会恢复聊天记录或凭据文件；插件安装由 Harness 管理。\n')
    const confirmation = await rl.question('确认相关 Harness 进程已退出，并继续恢复？请输入“确认恢复”：')
    if (confirmation.trim() !== '确认恢复') return { status: 'cancelled' }
    const result = await finishRecovery({ ...options, passphrase, confirm: true, token: plan.token })
    output.write('配置已恢复。请重新打开 Harness 检查；如需撤销，请保留下面的 rollbackId。\n')
    return result
  } finally { passphrase = undefined; rl.close(); sink.end() }
}
