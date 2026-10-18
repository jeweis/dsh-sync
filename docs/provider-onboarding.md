# 设置页接入引导与离线安全回退（0.8.1）

本功能为可选增强，入口位于设置页默认折叠的“高级：引用型 API Key 自动接收（可选）”。常规配置同步、备份与 Key 加密上传无需接入或退出。默认模式的引用型 Key 接收提示用户到 Harness 配置；确认按钮不等于原子条件写入，不会用于绕过保护。受支持的 Key 记录保留自动双向同步。

展开高级选项只显示说明，不调用预览或执行切换。已有扩展能力会在折叠标题提示；折叠、关闭 API Key 同步或关闭设置页均不会回退 provider。实际退出扩展仍须走下述安全回退流程。

支持的标准 profile 不再需要用户手写 provider YAML。设置页的“原子凭据接入与回退”可以发现供应商 Key 引用、展示涉及的全部 profile、旧/新条目、凭据存储与保留参数，并生成本机离线命令。网页只读预览，既没有在线切换接口，也没有在线回退接口。

## 接入流程

1. 打开“同步与备份”中的“原子凭据接入与回退”。托管引用可留空自动发现，或填写要接入的已绑定引用名，以逗号/换行分隔。这里填写的是 `DEEPSEEK_API_KEY` 这类名字，**不是 Key 值**。
2. 点击“预览接入变更”。核对本 home 全部 profile、凭据存储、停用的原条目、新增的原子条目，以及保留的存储/监听配置。这个步骤不读取 Key 值、不修改 profile，也不创建切换日志。
3. 确认所有共享该凭据存储的 Harness、其他 profile 与外部写入进程都已停止。其他 home、命令行覆盖和外部工具不能自动穷尽发现；不能停止或统一写入入口时，不要切换。
4. 在终端安全设置 `DSH_VAULT_PASSPHRASE`（12–1024 字符），用于本机加密日志。运行界面生成的 `provider-preview` 命令，检查离线重新生成的计划和 token。
5. 将 `PLAN_TOKEN_FROM_CLI` 替换为刚得到的 token，再运行 `provider-switch ... --offline --all-writers-stopped`。没有 token 只会预览；缺少任一停止声明都拒绝写入。Key、配置或依赖在确认前改变后，必须重新预览。
6. 重启涉及的全部 profile，确认设置页显示原子 provider 能力。API Key 同步开关和首次同步确认仍独立保留，不会因接入 provider 自动开启。

命令形式如下。实际 home 与安装解析位置由设置页填好，用户无需寻找内部文件。

```sh
dsh-sync provider-preview --home HOME --install-anchor ANCHOR --mode enable --refs DEEPSEEK_API_KEY
dsh-sync provider-switch --home HOME --install-anchor ANCHOR --mode enable --refs DEEPSEEK_API_KEY --confirm PLAN_TOKEN_FROM_CLI --offline --all-writers-stopped
```

Harness 的补丁 `name` 是匹配条件，不能用来直接重命名已有插件。工具因此追加两条受控补丁：停用原 provider，再插入 `dsh-vault-atomic-credentials`。不会修改 bundle 源文件、manifest 或 lockfile，也不安装依赖。原存储位置和 watch/debounce 等参数保留。

## 安全回退

点击“预览安全回退”，按相同方式停止全部写入者、离线重新预览并确认，只将 mode 改为 `rollback`：

```sh
dsh-sync provider-preview --home HOME --install-anchor ANCHOR --mode rollback
dsh-sync provider-switch --home HOME --install-anchor ANCHOR --mode rollback --confirm PLAN_TOKEN_FROM_CLI --offline --all-writers-stopped
```

回退不是重新启用旧 Key。工具通过 Harness 凭据服务读取**当前**托管状态，在切回原 provider 前完成：

- 当前明确托管的 Key 通过原 provider 的 `set` 转存；已取消配置的引用通过 `unset` 保持取消，避免旧 `refs` 值复活。
- 没有托管记录、仍沿用旧引用的项不重复转存；不会把环境回退值强行写进凭据文件。启动环境由 Harness 重启时重新提供。
- 只移除本工具生成且内容未改变的两条 profile 补丁，其他主题、模型等修改可以保留。所有目标文件与转存结果再次校验后，才精确删除本次引用的内部记录，避免日后重新接入读到过时值；其他记录不清理。
- 当前 Key 更新或源配置改变，会使旧离线 token 失效。网页不显示 Key、Key 片段或可复用的 Key 指纹。

## 中断恢复与日志

切换前保存 `config-vault/provider-transition.vault` 和按事务 id 保留的加密历史；其中包含配置/凭据操作前副本，使用与快照相同的认证加密。`provider-receipt.json` 只含非秘密阶段、引用名、profile 名和补丁配方，供网页只读核对，不足以授权执行。

接入或回退中断后，不要启动部分切换的 profile，也不要删除日志。保持全部写入者停止，重新运行 `provider-preview --mode rollback`，核对新 token 后用相同离线声明执行回退。工具可处理部分 profile 已改、部分未改的状态，并保留当前 Key；不确定结果不会自动重放。

provider 转换与原有快照 restore/recover 共用离线修改锁，互不并发。日志与凭据不属于普通快照采集范围，远端快照保留策略也不清理这些本机日志。保管原加密口令；工具不会自动解密旧日志或删除历史。

## 当前支持边界

本版针对 DSH 0.2.1-rc.2，支持本 home 的常规 `profiles/<name>`，每个 profile 有一个顶层官方本地/本插件原子 provider，且共享同一凭据存储。自动发现 DeepSeek 官方和 pi-ai 的字面量 `apiKeyEnv`；不执行表达式。

以下情况直接阻止自动接入/回退，留下原文件供人工核对：

- 依赖未安装、profile 内插件版本与执行器不一致、运行时不匹配；工具不安装或升级任何依赖。
- 动态引用、动态/未知 provider 配置、嵌套/隔离 provider、额外非空 `cordis.yml` 或当前启动 overlays；高优先级补丁覆盖计划也会阻止执行。
- profile 使用不同存储、存储在 home 外、符号链接，或存储与 `profiles/config-vault/node_modules` 等受管理路径重叠。本版要求凭据存储为独立 YAML 文件。
- 接入后 profile 集合改变、工具自己的补丁被改动、日志损坏或快照恢复未完成。

安全回退只适用于通过本引导建立且日志完整的接入；旧版手工接入没有原始补丁记录时，需要人工核对，工具不会猜测旧配置。

网页预览只是可审查的说明；真正的授权边界是离线 CLI 的新计划、加密口令和两项停止声明。`--offline` 是操作者声明，不能替代实际停止进程。本轮开发只在隔离 profile 执行，没有对真实 profile 接入、迁移或回退。
