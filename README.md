# Agent Manager Lite

[![CI](https://github.com/sv3nbeast/agent-manager-lite/actions/workflows/ci.yml/badge.svg)](https://github.com/sv3nbeast/agent-manager-lite/actions/workflows/ci.yml)

简体中文 · [English](README.en.md) · [版本下载](https://github.com/sv3nbeast/agent-manager-lite/releases) · [问题反馈](https://github.com/sv3nbeast/agent-manager-lite/issues)

以实例为入口的轻量 Agent 工作台，统一管理账号、供应商密钥和客户端配置，逐步连接终端 Agent、桌面客户端与 AI 编辑器。

**创建实例 → 选择客户端 → 选择兼容账号或供应商 → 配置项目 → 启动**

当前支持 **Codex** 桌面和 CLI。更多 Agent 客户端与编辑器正在规划与评估，见下方「接入方向」。

## 软件界面

以下截图来自 v0.1.0 实际运行的应用内容区，使用默认窗口尺寸和系统主题。账号、供应商与用量均为演示数据。

![Agent Manager Lite 账号管理](assets/screenshots/accounts.png)

<details>
<summary>查看工作空间概览</summary>

![Agent Manager Lite 工作空间概览](assets/screenshots/overview.png)

</details>

## 功能

- **独立实例**：管理 Codex 桌面和 CLI 实例，自动生成可修改的名称；选择账号、接入方式和会话来源，预览配置后启动、停止或归档。
- **账号管理**：ChatGPT 浏览器或设备码登录，导入账号，管理标签、分组、用量窗口、订阅到期信息和账号回收站。到期日以上游实际返回为准。
- **供应商与密钥**：管理多个 API 供应商及密钥，从 API 读取模型列表，执行可取消的连接和对话测试。
- **模型与配置**：选择模型、推理档位、上下文窗口预设或自定义值。每条 API 连接可按模型独立设置上下文，未设置时继承供应商默认值；实例启动前可预览配置并支持恢复。
- **普通 / Fast**：受支持的 Codex 桌面实例可在原有速度菜单中选择；本地 API 支持服务等级配置和实际出站等级记录。可用性取决于客户端版本、模型和服务商。
- **网络代理**：配置默认代理及账号覆盖，支持 HTTP、HTTPS、SOCKS5 和 SOCKS5H。
- **本地 API**：使用多个账号、调度策略及独立访问密钥，提供模型范围和 Token 上限控制。
- **会话与记录**：创建实例时选择空白会话、复制已有实例或本机目录；自动发现兼容工具的本机实例，包括运行中的来源。先预览会话及项目分组、搜索项目详情，再关闭来源客户端并复制，原目录保留。管理会话导入导出、复制和回收站，查询调用记录、统计并导出 CSV。
- **数据备份**：预览导入内容，导出账号或创建加密的便携数据备份。

## 接入方向

后续接入范围不限于 Claude，希望从统一的实例入口连接更多值得使用的 Agent 和编辑器。以下为候选示例，尚未实现，不代表完整名单或确定的发布排期。

| 类型 | 接入候选 |
| --- | --- |
| 终端 Agent | [Claude Code](https://code.claude.com/docs/en/overview)、[Gemini CLI](https://geminicli.com/docs/)、[OpenCode](https://opencode.ai/docs/)、[Kiro CLI](https://kiro.dev/docs/) |
| 桌面 Agent | [Claude Desktop（Chat / Cowork / Code）](https://code.claude.com/docs/en/desktop)、[OpenCode Desktop](https://opencode.ai/docs/) |
| AI 编辑器与 IDE | [Kiro IDE](https://kiro.dev/docs/)、[Cursor](https://cursor.com/docs)、[VS Code / GitHub Copilot](https://code.visualstudio.com/docs/agents/overview)、[Zed](https://zed.dev/docs/ai/overview)、[Devin Desktop（原 Windsurf）](https://docs.devin.ai/desktop/getting-started) |

接入后仍通过「创建实例 → 选择客户端」使用，账号与供应商保持统一管理。登录方式、模型、上下文、速度及实例隔离按各客户端实际能力提供；同一供应商密钥只在兼容的客户端之间复用。

## 安装与使用

当前发布目标为 **macOS Apple Silicon（arm64）**，提供 DMG / ZIP 格式。可用安装包见 [Releases](https://github.com/sv3nbeast/agent-manager-lite/releases)；暂无可下载版本时，可按下方步骤从源码运行。Windows、Linux 和其他架构尚未完成验证。

1. 安装并打开 Agent Manager Lite，准备本机 Codex 桌面应用或 CLI。
2. 在「账号」登录 ChatGPT，或在「供应商与密钥」添加 API 地址、密钥和模型。
3. 在「实例」创建实例，选择 Codex 及兼容账号或供应商。
4. 检查模型、会话来源和启动预览后启动；桌面项目在 Codex 内选择，CLI 可先选择工作目录。

需要代理时，在设置中配置默认网络，再按需为账号覆盖。代理用于管理器的登录交换、令牌刷新、用量查询和本地 API；外部浏览器及原生客户端使用自身网络配置。

升级前退出应用，再安装新版本。应用内自动更新尚未接入。安装包附带 `SHA256SUMS.txt`，当前构建未进行 Developer ID 签名或公证。

## 数据

账号和密钥使用 Electron `safeStorage` 在本机加密存储；系统加密不可用时不保存凭据。账号导出文件包含登录凭据，便携数据备份使用单独密码加密。调用记录不保存请求正文或密钥。

## 从源码运行

技术栈：Electron、Vue 3、TypeScript 和 Go。CI 使用 Node.js **25.8.2**、Go **1.26.1**；依赖版本由锁文件固定。

```sh
git clone https://github.com/sv3nbeast/agent-manager-lite.git
cd agent-manager-lite
npm ci
npm run setup:electron
npm run build:proxy
npm run dev
```

源码检查与构建：

```sh
npm run typecheck
npm test
npm run test:proxy
npm run test:proxy:handlers
npm run build
```

构建 macOS arm64 安装包：

```sh
npm run build:proxy
npm run build
npx electron-builder --mac --arm64 --publish never
```

Codex 客户端需单独安装，本项目不附带官方客户端。桌面菜单和语言适配依赖客户端版本；源码测试通过不代表所有客户端版本及真实账号环境均已验证。

## 许可证与来源

项目代码按 [CC-BY-NC-SA-4.0](LICENSE) 分发。独立第三方依赖继续适用各自许可证，详见 [第三方声明](THIRD_PARTY_NOTICES.md)。

部分 Codex 管理逻辑适配自 [Cockpit Tools](https://github.com/jlcodes99/cockpit-tools)，技术栈和视觉参考 [Kiro Manager Lite](https://github.com/lucks-cloud/kiro-manager-lite)。本项目为独立工具，与 OpenAI、Anthropic 或上述项目无官方关联。
