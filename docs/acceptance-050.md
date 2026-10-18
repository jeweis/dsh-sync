# 0.5.0 双设备同步验收

目标 DSH 为 `0.2.1-rc.2`。Harness checkout 全程只读；没有安装到真实 profile，没有访问用户 NAS/WebDAV，没有提交、推送或发布 npm。

## 实际发行包服务验收

`scripts/acceptance/sync.mjs` 从独立安装的精确 rc.2 runtime 读取官方 app-boot、Settings、ConfigEditor、HMR、主题、locale 和默认模型插件，启动两份临时 profile 与本机假 WebDAV。真实 Loader 配置读写、schema 校验和 HMR 均走官方服务。

通过项目：首次连接先预览、确认后云端初始化、第二设备确认采用云端、双向主题变更、默认模型与语言传播、并发冲突选择，以及主题插件 fiber 保持不变。结束后关闭两个 Context、HTTP 服务并删除临时 home。

复测前需有独立安装的官方 rc.2 runtime；路径通过环境传入，不要求参考 checkout 中安装或构建：

```sh
DSH_VAULT_TEST_RUNTIME=/path/to/isolated/runtime node --expose-internals scripts/acceptance/sync.mjs
```

结果：

```json
{"runtime":"0.2.1-rc.2","devices":2,"realSettings":true,"hmr":true,"firstJoinPreview":true,"bidirectional":true,"conflictResolution":true,"sameFiber":true,"defaultModel":true,"language":true,"remoteObjects":1}
```

这是实际发行包服务组合验收，不等于两台物理设备、真实外部 WebDAV 或完整 DSH Web 应用启动验收。

## 设置页和回归

构建后的 lazy-CJS 设置页通过 jsdom 调用真实设置 API 与本机假 WebDAV，完成开关保存、解锁、首次确认、双设备冲突和采用云端，检查口令不进入共享状态、输入在提交后清空。真实浏览器另运行 `npm run preview:sync` 的隔离界面，完成“全部选云端 → 确认 → 核对一致”。

截图：[首次连接](screenshots/sync-first-join.png)、[同步完成](screenshots/sync-complete.png)。预览界面使用两份模拟配置适配器和真实同步服务；它不访问真实 Harness 配置。

新增回归包含：无变化不 PUT、不重复应用；重启去重；并发写入 CAS 拒绝；忽略条件写/无强 ETag 时停止；错误口令与无效/不兼容数据不应用；部分失败和不确定上传跨重启暂停；同 profile 并发锁；上传期间新编辑不误确认；默认值归一化不回传；卸载取消与会话口令清除；插件清单差异保留待处理且不安装包。原有离线恢复、rollback、路径防护和保留策略继续回归。

最终结果：`npm test` **86/86 通过**；`npm run check` 通过；`npm pack --dry-run` 包含全部同步模块、构建后客户端、元数据与图标。额外覆盖“不确定操作重新核对只生成确认计划，不静默重放失败应用”和“环境口令也不能复用 WebDAV 密码”。
