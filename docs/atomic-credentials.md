# 引用型 Key 的原子自动接收（0.8.0）

无需修改 Harness 源码，可以在插件中提供可选的凭据 provider。普通 provider 的无条件 `set` 无法提供 CAS 保证，因此默认行为仍保留 0.6.1 的手动保护；仅显式接入 `@jeweis/dsh-sync/credentials-provider` 且列入 `managedRefs` 的引用恢复自动接收。

## 为什么它能协调用户保存与同步

provider 继承官方 rc.2 `LocalCredentialProvider`，继续提供原有 `ctx.credentials` 服务。对托管引用，界面/调用方正常使用 `resolve/describe/set/unset`；同步使用仅宿主可见的原子能力 `snapshot/compareAndSet`。

用户保存、取消配置和同步 CAS 均进入同一个官方 `modifyRecord` 事务。回调在跨进程文件锁内重新读取磁盘，对照当前 Key 与 generation，再决定提交；用户若先保存，旧计划被拒绝；同步若先提交，排队的用户保存随后生效。每次保存都生成新的 generation，即使 Key 字节相同也使旧计划失效。三方同步保存加密的本机版本基线，自动检查前发生的同值保存也能与云端修改形成冲突。

托管引用保存在官方凭据服务拥有的 `dsh-config-vault-refs/r<hash>` 记录中，每个引用固定一条，轮换不会新增历史文件。记录含版本、引用名、generation、设置/取消状态与值；它是本 provider 的内部格式，不是 OAuth 登录。插件不直接打开、解析或改写凭据文件，不使用私有字段、方法替换或补丁化官方 provider。旧的 `refs` 数据保留，首次读取可作为回退；第一次托管写入后，以新记录为准。取消配置留下 tombstone，不会重新启用旧 `refs` 值，但仍保留环境回退语义。

普通请求读取走官方缓存；仅同步快照和写事务需要磁盘协调，不新增轮询。参考变更事件仍以 `credentials/reference-updated` 发出，包含来自同 provider 的其他进程变更。同步口令、Key 与版本指纹均不进入浏览器 DTO；首次确认和冲突预览继续只显示配置状态。

## 接入条件

**同一凭据存储中，写入某个托管引用的全部 profile/进程必须使用这个 provider。** 只包住同步自身的锁没有意义。通过旧 provider、其他工具或直接编辑旧 `refs` 写入，绕过了本 provider，不能保证协调或当前生效值；原生 provider 也不会读取新托管记录。无法统一写入入口时，继续使用普通 provider 的手动接收保护，不应启用该引用的自动接收。

可通过 0.8.0 设置页预览、离线 CLI 确认接入，也可手动配置。此扩展只通过显式 provider 配置启用，主插件不会自动修改 profile、替换服务、迁移真实凭据或启动额外进程。设置页显示的是 provider 能力可用状态；每项引用是否托管仍由 `managedRefs` 判断，未托管引用继续手动接收。

## 配置示例

[独立示例](../examples/atomic-credentials.yml) 展示的是替换现有凭据服务行后的内容，**不是直接追加到现有 profile 的补丁**：同一服务作用域只能有一个 credentials provider。保留原行实际 id，以及已有的 `path/dshHome/watch/debounceMs` 配置。填入当前 DeepSeek/pi-ai 供应商设置所用的实际 `apiKeyEnv` 名称，不能由云端指定；WebDAV 密码和同步口令引用不允许托管。

```yaml
- id: credentials
  name: '@jeweis/dsh-sync/credentials-provider'
  config:
    managedRefs:
      - DEEPSEEK_API_KEY
      - OPENAI_API_KEY
```

扩展需要官方 `@deepseek-ai/dsh-credentials-local` 与 `@deepseek-ai/dsh-launch-environment` 的 0.2.1-rc.2 版本，作为可选 peer 声明；主同步插件本身仍能在普通 provider 下工作。新增入口可单独被 Harness 加载，不默认加入主 bundle。

将来实际接入前，应停掉相关 home 的所有写入进程，保留安全备份，统一替换其 provider 后重启，再开启 API Key 同步并确认首次差异。**本轮仅实现、打包及隔离验收，没有对真实 profile 做上述操作。**

## 退出、卸载和恢复

托管记录不会在卸载、关闭 API Key 同步或移除 `managedRefs` 时自动删除。关闭同步不影响凭据正常解析，但替换 provider、移除某引用的托管配置或退回旧版本，可能重新暴露旧 `refs`/环境值，不能把它当作无损回退。

退出前需停止相关进程，通过当前凭据服务有意识地把需要保留的有效 Key 配置到目标 provider，再切换；0.8.0 可通过[设置页引导与离线确认](provider-onboarding.md)转存当前 Key 并安全回退；不会自动或在线降级。不要直接删除内部记录或期待旧 provider 自动识别它们。历史完整快照仍不包含凭据文件，也不能用它代替凭据迁移。完整配置恢复继续离线确认。

## 验证范围与性能

见 [0.7.0 验收](acceptance-070.md)。覆盖真实 rc.2 Boot 加载、双临时设备自动接收、两端冲突、同值保存、另一进程抢先保存、CAS 持锁时另一进程保存、普通 provider 回退以及旧待处理状态接入扩展。

本机合成数据测量：1000 次缓存读取总计 9.50 ms，100 次原子快照总计 18.88 ms，凭据存储 mtime 未变。数字仅描述本机测试环境，不能作为其他设备的延迟承诺。默认同步间隔仍为 3 分钟，未增加后台定时器。
