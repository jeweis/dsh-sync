# DSH Sync 0.9.0 改名验收

- 项目名 DSH Sync；npm 包 `@jeweis/dsh-sync`；目录 `plugins/dsh-sync`；中文名称“同步与备份”。
- 主 CLI `dsh-sync`，旧 `dsh-config-vault` 命令作为同一入口的兼容别名。包的 scope、lockfile 根元数据、bundle 模块名、lazy-CJS 加载 id、凭据 provider 入口和示例保持一致；YAML 中作用域模块名带引号。
- 保留 `config-vault/`、`DSH_VAULT_*`、WebDAV 凭据引用、内部记录/CAS 标识、加密 AAD/格式、快照与同步协议、远端路径、补丁 id 和设置 API 路径，不迁移用户数据。
- 保留识别旧凭据模块名及 journal 中的原补丁配方。实际迁移已安装的包需先核对依赖与模块引用；不提供 npm 旧包名自动解析，不直接移除旧扩展。

## 测试与运行时

完整测试 120/120；语法检查、打包预检与实际打包通过。

新增改名兼容验证：作用域自引用、主命令与别名、bundle YAML、客户端加载 id；使用旧版 `dsh-config-vault-0.8.1.tgz` 中的加密实现生成固定合成快照，新包可认证解密并预览；旧模块名的接入 journal/receipt 可安全回退并保留最新合成 Key。

实际 DSH 0.2.1-rc.2 独立安装运行时中，两个临时 profile 可解析新的作用域 provider，完成只读预览 → 停止进程 → 离线接入 → 重启 → 更新 Key/主题 → 停止进程 → 安全回退 → 重启。最新 Key 和其他设置保留。绑定引用夹具等待 llm 服务的警告为预期，本项不包含真实模型认证调用。

npm 公共查询未找到 `@jeweis/dsh-sync` 的公开包；未执行发布或账号修改。未提交、推送或安装至真实 profile。参考 Harness 源码保持只读。
