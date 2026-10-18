# main 分支自动发布 npm

工作流 `.github/workflows/publish.yml`：PR 执行验证；推送 main 或在 main 手动运行时，验证通过后发布 `@jeweis/dsh-sync` 到 npm。验证包括锁文件安装、全部测试、语法检查和打包预检。使用 GitHub 托管 Ubuntu runner 与 Node 24，不访问 Harness 源码或真实 profile。

## 首次启用

GitHub 仓库有代码不代表 npm 已有包，GitHub 登录也不等于 npm 发布授权。需要 npm 账号拥有 `@jeweis` 作用域的发布权限。

可通过仓库 Settings → Secrets and variables → Actions 创建 `NPM_TOKEN` secret，用具备目标包发布权限、适用于 CI 的 npm granular access token 完成首次发布。首次创建作用域中的新包，token 的包范围需允许创建该包；还需满足 npm 账号/组织的 2FA 发布策略。不要将 token 写入仓库或聊天。

也可先在可信终端以 npm 账号登录，执行 `npm publish --access public` 完成首次发布，然后设置以下 trusted publisher。不要重复发布已存在的版本。

## 后续优先使用 Trusted Publishing（OIDC）

在 npm 的 `@jeweis/dsh-sync` 包设置中添加 GitHub Actions trusted publisher：

- Organization or user：`jeweis`
- Repository：`dsh-sync`
- Workflow filename：`publish.yml`（不含目录）
- Environment name：留空（当前工作流没有声明 environment）
- 若界面提供 Allowed actions，允许直接 `npm publish`。

配置完成后，可删除 GitHub 的 `NPM_TOKEN` secret；工作流通过 `id-token: write` 和 npm 11 获取 OIDC 发布凭据，附带 provenance。OIDC 需在 npm 端建立信任，单靠 YAML 中的权限声明不足以授权。新建信任配置的启用时限以 npm 当前页面要求为准。

参考：[npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)、[GitHub 发布 Node.js 包](https://docs.github.com/en/actions/tutorials/publish-packages/publish-nodejs-packages)。

## 每次更新

1. 修改代码并更新版本：例如 `npm version patch --no-git-tag-version`，同时更新 package.json 与 package-lock.json。
2. 提交并推送 main，查看 GitHub Actions 的 Verify and publish。
3. 工作流先验证，再检查 npm 上的精确版本。只在 404 明确表明版本不存在时尝试发布；网络、认证、限流、服务器错误会失败，不能冒充“未发布”。

已发布的同版本会跳过，不覆盖、不自动改版本，也不自动提交或创建 tag。当前默认仅发布稳定的三段版本；预发布版本应另设 dist-tag 策略。仓库变更后的 main 推送会首次触发该流程，旧的推送不会自动补跑，也可在 Actions 手动 Run workflow。
