# 维护者：GitHub + npm 发布

DSH Sync 使用 **main 验证后自动发布 + npm Trusted Publishing（OIDC）**。仓库 `jeweis/dsh-sync`，npm 包 `@jeweis/dsh-sync`，工作流 `.github/workflows/publish.yml`。工作流不读取 `NPM_TOKEN` 或 `NODE_AUTH_TOKEN`，发布凭据由 OIDC 临时签发。

工作区所有插件的规范位于根目录 `docs/github-npm-release.md`，模板位于 `templates/github-npm/`；这两个目录属于工作区根仓库，不要求插件作为 monorepo 发布。本文件保留独立克隆本插件时所需的完整操作。

## npm 信任配置

在 npm 包 Settings → Trusted Publisher 中设置：

| 字段 | 内容 |
| --- | --- |
| Publisher | GitHub Actions |
| Organization or user | `jeweis` |
| Repository | `dsh-sync` |
| Workflow filename | `publish.yml` |
| Environment name | 留空，工作流未声明 environment |
| Allow npm publish | 勾选 |
| Allow npm dist-tag | 不勾选 |

每个包都需要自己的信任关系，mcpcat 等其他包的授权不适用于本包。工作流的 `id-token: write` 不能代替 npm 侧配置。若已存在旧的发布 Token secret，可以在 GitHub 设置中移除；本工作流不会使用它。

## 日常更新

```sh
npm ci --ignore-scripts
npm test
npm run check
npm pack --dry-run
npm version patch --no-git-tag-version
# 核对 package.json 与 package-lock.json 后，提交并推送 main。
```

PR 仅执行测试、检查和打包预检。main push 或 main 手动运行先验证，再检查精确版本：已发布的版本跳过，仅 404 尝试发布，网络/认证/限流错误直接失败。版本不会自动递增；默认只发布稳定三段版本到 `latest`，不创建 Git tag。预发布需要先设计独立 dist-tag。

发布使用 GitHub 托管 Ubuntu runner、Node 24、npm 11 与 `npm publish --access public --provenance`。`prepack` 自包含构建客户端；从 GitHub 安装另有 `prepare`，无需访问工作区根目录或 Harness 参考源码。测试不使用真实 profile 或个人 WebDAV。

## 首发与 OIDC 验证

`0.9.0` 已通过本机 npm 认证完成首发，并核验 registry 的实际 tarball、SHA-512、CLI 入口与客户端构建。新包首发需要 npm 账号权限和可能的浏览器确认，GitHub 登录不等于 npm 登录。首发后的缓存传播可能短暂 404，不应立即换版本重发。

配置 Trusted Publisher 后，必须用**新版本**验证真实的自动发布；重跑 `0.9.0` 会被跳过，不能证明 OIDC 生效。发布完成后检查 Actions 成功状态、日志中的 OIDC/provenance 以及 npm 的精确版本和 tarball。用户完成 npm 信任设置后，本次 `0.9.1` 用于验证无 Token 发布，并包含用户文档与 GitHub 安装构建入口更新。

若出现 `ENEEDAUTH`，先核对上述五项信任字段、Allow npm publish、工作流实际运行位置和 npm CLI 版本，不重新复制 Token。2FA、scope 或包权限问题以 npm 错误提示和账号策略为准。

参考：[npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)、[GitHub npm 发布](https://docs.github.com/en/actions/tutorials/publish-packages/publish-nodejs-packages)。
