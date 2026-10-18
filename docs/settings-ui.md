# 设置页方案（0.4.0）

## 用户流程

独立 `settings.section` 入口“配置备份”：连接与 profile 选择 → 保存 → 连接测试/加密备份 → 快照列表 → 认证预览 → 停止 Harness 后离线 CLI 重新预览与确认。不存在在线恢复调用，也不自动安装插件。

连接表单包括 HTTP / HTTPS URL、用户名、WebDAV 密码、明确移除密码的复选框、profile 多选、home patch 选择、请求超时、默认开启的加密开关，以及自动备份开关和等待/最小间隔。HTTP 提示认证信息可能被截获；关闭加密时另行提示配置及内嵌密钥会明文存放。先保存再执行远端动作。不可用的已选 profile 会显示出来，可取消选择；后台也拒绝保存不存在的 profile。

手动口令为操作级输入，不进行环境口令的隐式 GUI 回退。点击备份或预览时立即清除输入；失败后需要重新输入。明文备份/预览、列表和连接测试不需要口令。自动备份需另行明确解锁，会话口令只留在宿主内存，也可使用已有进程环境。页面不展示配置正文，只展示文件动作、警告和计划指纹。

## 宿主接口与数据归属

- `settings.mjs` 管理 home 下的 `config-vault/settings.json`：version、revision nonce 和非秘密配置。默认值来自插件 Config/环境；存在本地设置后由它优先。文件不在快照 allowlist。
- WebDAV 密码使用 `ctx.credentials`，引用为 `DSH_VAULT_WEBDAV_PASSWORD`。响应只含 configured/writable 标志。空字符串不改已有密码，明确的 clearPassword 才 unset；unset 后环境回退可能仍生效。
- 表单连接设置与凭据服务之间没有跨存储事务。如果偏好保存成功而凭据修改失败，返回 `credentials-save-incomplete`，前端重读状态并明确提示，避免虚报原子成功。
- `ui-service.mjs` 复用既有采集、加密/明文上传、WebDAV 和恢复预览引擎；只允许 save/test/list/backup/preview/auto-unlock/auto-retry 动作。没有在线恢复动作，口令不经过配置持久化。
- 根插件在 credentials 与 profileContext 可用时创建共享服务和宿主调度器，再在 connection 可用时注册设置路由。工具仍以 tools 为必需依赖。URL/用户名/范围/加密模式在下一次工具调用生效；工具的加密口令仍来自进程环境。
- 状态 GET `/api/dsh-config-vault/state` 使用 buffered 路由，动作 POST `/api/dsh-config-vault` 使用 streaming 路由，均注册到 `connection.fetch`，由既有通道处理认证、Host/Origin 和 owner 检查。没有绕开通道的裸 HTTP 路由。POST 请求体限制为 32 KiB，未知字段/动作拒绝，响应不回传原始解析器或凭据提供方错误。
- 设置页与模型工具复用同一服务锁，避免保存连接与密码时另一个操作读到混合配置。保存带 revision 前提；外部进程与手工编辑不属于此进程锁的保护范围。卸载时取消并等待进行中的操作、撤销 exact route。

## 浏览器客户端

浏览器只依赖 React 和 Harness 公用 client-store，使用 lazy-CJS factory，经 package 的 `./client` 和 `dsh.client` 元数据加载。由 slots 的 inject hooks 绑定响应式状态，组件不接触 ctx；口令与未保存密码只在组件本地输入中，不放入 controller 共享 store 或 localStorage。

控制器跟踪 host、busy、error、notice、snapshots、plan、backup。保存响应丢失时重新读取实际设置，但不重复 POST；上传响应丢失可能已经创建对象，显示未知结果并要求先查看列表。切换连接、刷新或新备份会清除旧预览，失败的预览不保留先前的成功计划。组件在 dirty 或 busy 时禁用远端动作。中英文产品文案归本插件字典管理。

每 5 秒只读刷新宿主自动状态，不重置表单草稿、不改变 revision；显示等待口令、待合并上传、最近已验证快照及时间、下次最早尝试和错误状态。自动任务、频率限制和异常暂停的详细语义见 [自动备份说明](automatic-backup.md)。

0.4.0 增加“本设备保留的最近快照数”，缺省 30、范围 1–10000；显示本机随机设备标识、上次清理删除数及待处理数。新快照验证后才清理本机有凭据的旧对象，清理失败显示独立警告但备份仍为成功。只修改数量不会立即删除；细节见 [保留策略](retention.md)。

恢复指引按 POSIX 或 PowerShell 正确引用目标 home 和快照 ID。命令中没有秘密值，不把在线生成的 token 当作离线授权；明确要求 CLI 在停止全部目标实例后重新计算计划，再填入 `PLAN_TOKEN_FROM_CLI`。版本或本地插件依赖阻塞时不显示执行命令。

## 隔离验证

- 临时 home 验证本机偏好、发现 profile、revision、凭据不回显/不备份、半成功保存的报告。
- 本地 WebDAV 模拟验证 API 备份、快照列表、认证预览及零恢复写入。
- 真实 Connection 库验证 owner 通道可达、非 owner 被拒绝及卸载后 404；真实 Cordis 工具注册测试继续覆盖 headless 行为。
- 使用实际构建的客户端模块，在 jsdom 中完成填写 → 保存 → 备份 → 列表 → 预览，检查输入清除、失败重读、状态隔离和阻塞提示。
- `npm run preview:ui` 在 loopback 提供明确标记的模拟页面用于浏览器视觉检查，不是实际 Harness 集成验收，也不安装任何真实 profile。
