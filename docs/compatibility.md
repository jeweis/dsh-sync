# 运行时兼容性

## @jeweis/dsh-sync 0.9.0

项目改名为 DSH Sync，独立目录为 `plugins/dsh-sync`，npm 包为 `@jeweis/dsh-sync`。继续要求 DSH `0.2.1-rc.2`；主命令改为 `dsh-sync`，保留旧命令别名。数据格式与本机状态不改名；已安装 profile 的 npm 包/module 引用需明确迁移，不自动改配置。详见 [品牌与兼容](branding.md)。

## dsh-config-vault 0.4.0

继续支持 DSH 0.2.1-rc.2。新增设置页默认 30 份的本设备保留策略和 CLI `--keep-last`；手动及自动备份只在新快照验证成功后清理。归属以本机设备 ID 和按远端目录/账号分区的上传凭据为准，不信任远端声明；校对上传字节哈希并使用强 ETag If-Match DELETE。旧版无凭据的快照不自动接管，密文协议和离线确认流程保持不变。详见 [保留策略](retention.md)。

## dsh-config-vault 0.3.0

继续支持 DSH 0.2.1-rc.2。新增设置页自动备份开关、防抖、最小间隔、持久化内容去重、同 home 进程锁和不确定上传暂停；口令可显式解锁，仅在本次宿主进程暂存。另新增默认关闭的明文快照选项，CLI 使用 `--unencrypted` 显式读取/写入；加密模式不会自动接受明文对象。旧配置默认自动备份关闭、加密开启，历史加密快照协议保持 v1，回滚日志继续加密。详见 [自动备份与可选加密](automatic-backup.md)。

## dsh-config-vault 0.2.5

继续支持 DSH 0.2.1-rc.2。WebDAV 地址接受 HTTP 与 HTTPS，无需额外开关；HTTP 地址显示连接不加密和认证信息暴露提示，快照加密保持不变。其他协议、URL 内嵌凭据、查询参数与片段继续拒绝，不跟随重定向、不自动降级。45 项回归通过，包括 HTTP 设置保存后的实际 WebDAV 请求、CLI 进程、真实 Cordis 工具备份/列表/预览，以及构建后 UI 的 HTTP 提示。测试仅使用本机服务，未访问用户 NAS 或改动真实 profile。

## dsh-config-vault 0.2.4

继续支持 DSH 0.2.1-rc.2。改用 Depth: 0 PROPFIND 确认已有 collection，从最近的已有父目录开始创建缺失子目录，不再向已有共享目录或挂载祖先发送 MKCOL。405/409 只在再次确认目标确为 collection 后接受。连接测试遇到快照目录 404 会明确提示待创建。43 项回归覆盖严格父目录检查、多级自动创建、已有挂载点拒绝 MKCOL、并发创建、文件占位与无效响应拒绝；未访问用户 NAS，不能据此断言其实际路径和写入权限正确。

## dsh-config-vault 0.2.3

运行时仍为 DSH 0.2.1-rc.2。新增安全的失败阶段、HTTP 状态码和 TLS/超时等诊断，区分未上传与远端结果不确定；新备份开始时清除旧成功状态。新增本地 WebDAV 的“读取成功但 MKCOL/PUT/GET 失败”及构建后设置页错误呈现回归测试。0.2.2 的完整启动验收保留为历史证据；这些新增错误诊断不代表已访问或定位用户 NAS 的实际故障。

## dsh-config-vault 0.2.2

目标运行时为 **DSH 0.2.1-rc.2**。包声明 `engines.dsh: 0.2.1-rc.2`，共享 peer 为 `@deepseek-ai/dsh-tools: 0.2.1-rc.2` 和 `@deepseek-ai/cordis: ~4.0.5`。开发测试使用同版本的 tools、system-prompt、client-connection、client-store 和 Cordis 4.0.5；不依赖本机旧版参考源码的构建产物。

0.2.0 曾按 DSH 0.2.1-alpha.5 开发，peer 精确锁定在 alpha.5。rc.2 拒绝它是版本检查的正常行为；不要使用版本豁免跳过这个检查。

升级后，备份默认标记的 Harness 版本为 0.2.1-rc.2，CLI 预览/恢复也默认采用该版本。快照协议仍为 v1；早期快照中的 alpha.5 元数据不会被自动修改。已有运行时版本不匹配的快照依然会阻止恢复，需要另行评估配置迁移。

0.2.2 还修复了真实 HTTP 状态读取和深色按钮对比度，并完成 [rc.2 完整启动验收](acceptance-rc2.md)。

## 使用更新版本

在插件目录执行 `npm ci --ignore-scripts` 和 `npm run build`，或者执行 `npm pack` 获取带构建产物的归档。按自己实际使用的 profile 更新插件，并完全重启 DSH；如果之前安装了 0.2.0 的 tgz，需要改装新归档，旧归档不会自动变化。

开发测试不会执行上述真实 profile 安装。当前明确支持 rc.2，不把未经验证的 alpha、其他 rc 或后续稳定版本纳入兼容范围。
