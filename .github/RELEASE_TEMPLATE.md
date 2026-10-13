## 更新内容 / Changes

补充此版本已实现的功能和修复。 / Describe the features and fixes included in this version.

## 下载与升级 / Downloads and upgrades

提供 macOS Apple Silicon（arm64）的 DMG / ZIP，附件包含 `SHA256SUMS.txt`。有运行实例时，关闭窗口或普通退出会保留后台服务；请完成任务、等待实例结束且管理器彻底退出后再安装新版。账号、实例、会话与本地配置保留。应用内自动更新尚未接入，安装包未进行 Developer ID 签名或公证。Windows、Linux 和其他架构尚未完成验证。

DMG and ZIP packages are available for macOS Apple Silicon (arm64), with `SHA256SUMS.txt`. Closing the window or using ordinary Quit keeps background services alive while instances are running. Finish active work and wait for the instances and manager to exit completely before installing an update. Accounts, instances, sessions and local settings are retained. In-app automatic updates, Developer ID signing and notarization are not included. Windows, Linux and other architectures have not been validated.

## 客户端支持 / Client support

支持 Codex 桌面 / CLI，以及 macOS 官方原生 Claude Code CLI 的 API Key、Bearer 和兼容 Anthropic Messages 网关连接；客户端需单独安装。Claude 的订阅 OAuth、云模式、npm 包装启动器和 Claude Desktop（Chat / Cowork / Code）尚未接入。Claude 模型由连接明确声明，会话管理当前只读，不使用 Codex 的修改、同步、修复或统计能力。Codex 桌面菜单和语言适配取决于版本，Fast 还取决于模型和服务商能力。

Codex desktop / CLI and the official native Claude Code CLI on macOS are supported. Claude connections use API Keys, Bearer tokens or gateways compatible with Anthropic Messages. Install clients separately. Claude subscription OAuth, cloud modes, npm wrapper launchers and Claude Desktop (Chat / Cowork / Code) are not integrated. Claude models must be declared by the connection; its session management is read-only and does not use Codex mutation, synchronization, repair or statistics features. Codex desktop menus and language integration depend on the version; Fast also depends on the model and provider.

## 验证来源 / Verification

补充本版本的实际验证范围与限制，并提供版本标签、完整来源提交、对应构建记录和 `SHA256SUMS.txt` 的链接。模拟服务验证不等同于真实上游账号验收；未验证的平台、客户端形态与登录方式不得列为已支持。

Describe the checks actually performed and their limits, with links to the version tag, full source commit, matching build run and `SHA256SUMS.txt`. Mock-service tests do not establish real upstream account acceptance. Do not describe unverified platforms, client variants or login methods as supported.
