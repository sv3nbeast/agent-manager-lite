## 更新内容 / Changes

补充此版本已实现的功能和修复。 / Describe the features and fixes included in this version.

## 下载与升级 / Downloads and upgrades

提供 macOS Apple Silicon（arm64）的 DMG / ZIP，附件包含 `SHA256SUMS.txt`。有运行实例时，关闭窗口或普通退出会保留后台服务；请完成任务、等待实例结束且管理器彻底退出后再安装新版。账号、实例、会话与本地配置保留。应用内自动更新尚未接入，安装包未进行 Developer ID 签名或公证。Windows、Linux 和其他架构尚未完成验证。

DMG and ZIP packages are available for macOS Apple Silicon (arm64), with `SHA256SUMS.txt`. Closing the window or using ordinary Quit keeps background services alive while instances are running. Finish active work and wait for the instances and manager to exit completely before installing an update. Accounts, instances, sessions and local settings are retained. In-app automatic updates, Developer ID signing and notarization are not included. Windows, Linux and other architectures have not been validated.

## 客户端支持 / Client support

支持 Codex 桌面 / CLI、macOS Claude Desktop 的独立实例和客户端内登录或 API / 第三方连接，以及 macOS 官方原生 Claude Code CLI 的 API Key、Bearer 和 Claude 订阅 OAuth 连接；客户端需单独安装。Anthropic Messages 网关可用于 Desktop API 与 CLI，额度查询按协议进入供应商链路。云模式和 npm 包装启动器仍未接入。

Desktop 分别保存实例 Cookie、配置、加密状态文件与本地历史，共用当前 macOS 用户的系统钥匙串服务；同账号的云端历史仍可同步。Desktop 遵循管理器设置中的默认网络（代理、直连或继承），Code 用户自定义环境可覆盖默认网络。Desktop 会话在客户端中管理，管理器暂不索引或迁移；CLI 会话管理只读。Codex 菜单和语言适配取决于客户端版本，Fast / Ultra 还取决于模型和服务商。

Codex desktop / CLI, independent Claude Desktop instances on macOS with sign-in inside the client or API / third-party connections, and the official native Claude Code CLI on macOS are supported. CLI connections use API Keys, Bearer tokens or Claude subscription OAuth; Anthropic Messages gateways can be used by Desktop API and CLI connections. Install clients separately. Provider models, protocols and tests are selected per key, and Anthropic usage checks follow the configured protocol. Cloud modes and npm wrapper launchers remain unintegrated.

Desktop instances keep separate cookies, configuration, encrypted state files and local history while sharing the current macOS user's system Keychain service. Cloud history for the same account can still sync. Desktop follows the default network in manager Settings (proxy, direct or inherit); custom Code environments can override that default. Manage Desktop sessions inside the client; the manager does not index or migrate them. CLI session management is read-only. Codex menu and language integration depends on the client version; Fast / Ultra also depend on the model and provider.

## 验证来源 / Verification

补充本版本的实际验证范围与限制，并提供版本标签、完整来源提交、对应构建记录和 `SHA256SUMS.txt` 的链接。区分真实客户端的启动 / 目录 / 代理验证、本地模拟服务验证和真实账号登录验收；没有实际完成真实付费账号的 Desktop 登录、Chat / Code / Cowork 或订阅请求时，不得宣称这些端到端流程已验收。未验证的平台、客户端形态与登录方式不得列为已支持。

Describe the checks actually performed and their limits, with links to the version tag, full source commit, matching build run and `SHA256SUMS.txt`. Distinguish real-client launch, directory and proxy checks from mock-service tests and real-account sign-in. Do not claim paid-account Desktop sign-in, Chat / Code / Cowork or subscription requests were validated end to end unless those checks actually ran. Do not describe unverified platforms, client variants or login methods as supported.
