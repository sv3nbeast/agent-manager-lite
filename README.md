# Agent Manager Lite

[![CI](https://github.com/sv3nbeast/agent-manager-lite/actions/workflows/ci.yml/badge.svg)](https://github.com/sv3nbeast/agent-manager-lite/actions/workflows/ci.yml)

简体中文 · [English](README.en.md) · [版本下载](https://github.com/sv3nbeast/agent-manager-lite/releases) · [问题反馈](https://github.com/sv3nbeast/agent-manager-lite/issues)

以实例为入口的轻量 Agent 工作台，统一管理账号、供应商密钥和客户端配置，逐步连接终端 Agent、桌面客户端与 AI 编辑器。

**创建实例 → 选择客户端 → 选择兼容账号或供应商 → 配置项目 → 启动**

当前支持 **Codex** 桌面和 CLI，以及使用 API 连接的 **Claude Code 官方原生 CLI（macOS）**。更多 Agent 客户端与编辑器正在规划与评估，见下方「接入方向」。

## 软件界面

以下截图来自 v0.1.0 实际运行的应用内容区，使用默认窗口尺寸和系统主题。账号、供应商与用量均为演示数据。

![Agent Manager Lite 账号管理](assets/screenshots/accounts.png)

<details>
<summary>查看工作空间概览</summary>

![Agent Manager Lite 工作空间概览](assets/screenshots/overview.png)

</details>

## 功能

- **独立实例**：在统一向导选择 Codex 或 Claude Code，自动生成可修改的名称，只列出兼容账号和已支持的设置；预览配置后启动、停止或归档。
- **账号管理**：ChatGPT 浏览器或设备码登录，导入账号，管理标签、分组、用量窗口、订阅到期信息和账号回收站。Claude Code 可在同一账号入口或创建流程中添加 API Key / Bearer 连接。到期日和用量以上游实际返回为准。
- **供应商与密钥**：管理多个 API 供应商及密钥。Codex 连接可从 API 读取模型列表，执行可取消的连接和对话测试；Claude Code 使用明确声明的 Anthropic Messages 地址、凭据和模型列表。在「供应商与密钥 → API 连接」管理已保存的 Claude 连接。可编辑地址、模型和密钥；更换地址需重新填写密钥，使用中的连接需先停止实例。
- **模型与配置**：按客户端能力选择模型。Codex 支持推理档位、上下文窗口预设或自定义值；每条 API 连接可按模型设置上下文并继承供应商默认值。Claude Code 使用所选连接声明的模型，不套用 Codex 的上下文和速度配置。
- **普通 / Fast**：受支持的 Codex 桌面实例可在原有速度菜单中选择；本地 API 支持服务等级配置和实际出站等级记录。可用性取决于客户端版本、模型和服务商。
- **网络代理**：配置默认代理及账号覆盖，支持 HTTP、HTTPS、SOCKS5 和 SOCKS5H。
- **本地 API**：为 Codex 连接提供多账号、调度策略及独立访问密钥，支持模型范围和 Token 上限控制。Claude Code 直接连接所选 Anthropic Messages 服务。
- **Codex 会话与记录**：创建实例时选择空白会话、复制已有实例或本机目录；自动发现兼容工具的本机实例，包括运行中的来源。先预览会话及项目分组、搜索项目详情，再复制已保存历史的独立快照，原目录保留。macOS APFS 外部来源可以继续使用，副本不会持续同步新消息；直接使用已有目录仍需先关闭来源。复制跳过临时文件、缓存和工作树代码，项目继续使用原路径；失效的会话索引会在副本中排除并提示。管理会话导入导出、复制和回收站，查询调用记录、统计并导出 CSV。
- **Claude Code 会话**：在统一「会话」页查看受管实例的历史，按来源和标题筛选、打开文件、显示文件位置或复制原始会话 ID。同 ID 记录按实例、项目和文件分别展示；当前不提供导入导出、复制、同步、归档、删除、修复可见性、正文搜索或 Token 统计。
- **数据备份**：预览导入内容，导出账号或创建加密的便携数据备份。

## Claude Code 支持范围

需要单独安装 **macOS 官方原生 Claude CLI**。在创建实例时选择 Claude Code，添加或选择 API Key、Bearer Token，或兼容 Anthropic Messages 协议的网关连接，填写服务地址和可用模型。界面中的「API 连接已配置」表示凭据已配置，不代表上游已接受该凭据。订阅 OAuth / 浏览器登录、Bedrock / Vertex / Foundry 等云模式、npm 包装启动器和 Claude Desktop 尚未接入。

每个实例拥有独立的 Claude 配置、全局状态和会话目录，停止实例后保留用户设置与历史。首次启动会初始化欢迎流程，项目信任、API Key 确认和工具权限仍由 Claude 提示。用户可选的配置来源限定为该实例的 user 设置；项目与 local settings 中的环境变量和 hooks 不参与启动，MCP 使用受控的空配置。系统或组织管理策略仍由 Claude 执行。项目 `CLAUDE.md` 仍可读取，项目代码继续使用原目录；配置隔离不是文件系统沙箱。

官方安装入口保持不变时，CLI 升级后的程序路径会重新发现，启动前按实际参数能力校验。已运行进程保留原启动路径用于归属检查和恢复。兼容升级无需维护固定版本名单；上游改变隔离参数或进程行为时仍可能需要适配。

本轮使用真实 **Claude CLI 2.1.295** 进程连接本地模拟服务，验证了 API Key / Bearer 请求、并发实例配置与会话隔离、同实例续接和跨实例续接拒绝。另已验证 API Key / Bearer 的首次交互启动及正常退出。未使用真实上游付费凭据验收，不据此承诺任意网关、订阅或客户端版本均可用。管理器只读展示 Claude 会话，继续对话仍在对应实例的 CLI 中操作。

## 接入方向

后续从统一的实例入口连接更多值得使用的 Agent 和编辑器。以下为候选示例，尚未实现，不代表完整名单或确定的发布排期。

| 类型 | 接入候选 |
| --- | --- |
| 终端 Agent | [Gemini CLI](https://geminicli.com/docs/)、[OpenCode](https://opencode.ai/docs/)、[Kiro CLI](https://kiro.dev/docs/) |
| 桌面 Agent | [Claude Desktop（Chat / Cowork / Code）](https://code.claude.com/docs/en/desktop)、[OpenCode Desktop](https://opencode.ai/docs/) |
| AI 编辑器与 IDE | [Kiro IDE](https://kiro.dev/docs/)、[Cursor](https://cursor.com/docs)、[VS Code / GitHub Copilot](https://code.visualstudio.com/docs/agents/overview)、[Zed](https://zed.dev/docs/ai/overview)、[Devin Desktop（原 Windsurf）](https://docs.devin.ai/desktop/getting-started) |

接入后仍通过「创建实例 → 选择客户端」使用，账号与供应商保持统一管理。登录方式、模型、上下文、速度及实例隔离按各客户端实际能力提供；同一供应商密钥只在兼容的客户端之间复用。

## 安装与使用

当前发布目标为 **macOS Apple Silicon（arm64）**，提供 DMG / ZIP 格式。可用安装包见 [Releases](https://github.com/sv3nbeast/agent-manager-lite/releases)；暂无可下载版本时，可按下方步骤从源码运行。Windows、Linux 和其他架构尚未完成验证。

1. 安装并打开 Agent Manager Lite，准备本机 Codex 桌面应用 / CLI 或官方原生 Claude CLI。
2. 在「实例」创建实例，选择客户端及兼容账号或供应商，也可在向导中添加连接。
3. Codex 可登录 ChatGPT 或使用 API 连接；Claude Code 选择 API Key / Bearer，填写 Anthropic Messages 地址和模型。
4. 检查模型、工作目录和启动预览后启动；Codex 还可选择会话来源。桌面项目在 Codex 内选择，CLI 在 Terminal 中运行。

新建 ChatGPT 账号实例默认使用「原生账号登录」，客户端读取真实登录身份，具体账号功能由套餐、工作区与客户端版本决定。HTTP、HTTPS、SOCKS5、SOCKS5H 代理可与原生账号登录同时使用。Codex 的 API 密钥和 Agent Identity 默认走「本地 API」；ChatGPT OAuth 账号使用本地 API 时，管理器会保留本地网关并在启动期间投影真实账号身份，停止实例后恢复原配置。纯 API 连接没有可供客户端显示的 ChatGPT OAuth 身份。已有实例保留当前接入方式，可停止后在编辑中切换。若切换后 Codex 历史列表未显示，可在「会话 → 修复可见性」选择该实例，按实例接入方式预览修复。

需要代理时，在设置中配置默认网络，再按需为账号覆盖。代理用于管理器的登录交换、令牌刷新、用量查询、本地 API，以及管理器启动的原生桌面和 CLI 实例。Codex 原生账号实例保留 ChatGPT 身份，通过独立的本地转接服务使用账号代理（支持认证）；显式直连会覆盖系统及继承的代理设置。关闭管理窗口后，转接服务随实例保留到退出。外部浏览器及自行启动的客户端仍使用自身网络配置。

有运行实例时，Cmd+Q、菜单退出和托盘普通退出会关闭管理界面并保留后台服务，实例与本地 API 连接继续运行；实例全部结束并完成配置回收后，管理器自动退出。重新打开应用或从托盘显示主窗口可继续管理。托盘的「退出并停止运行实例」会停止实例并彻底退出。

升级前请完成运行中的任务，等待管理器彻底退出后再安装新版本。应用内自动更新尚未接入。安装包附带 `SHA256SUMS.txt`，当前构建未进行 Developer ID 签名或公证。

## 数据

账号和密钥使用 Electron `safeStorage` 在本机加密存储；系统加密不可用时不保存凭据。账号导出文件包含登录凭据，便携数据备份使用单独密码加密。调用记录不保存请求正文或密钥。

Claude CLI 启动时通过权限为 `0600` 的临时环境文件交接 API 凭据，消费后立即删除，取消或失败时清理。密钥不写入启动参数、恢复记录或实例 `settings.json`。

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
npm run test:claude-code
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

Codex 和 Claude Code 客户端需单独安装，本项目不附带官方客户端。Codex 桌面语言、普通 / Fast 和 Ultra 按实际功能结构独立检测，启动预览会显示各项状态。仅版本号或资源名称变化时可自动兼容；内部接口变化仍可能需要适配。Ultra 和 Fast 还取决于模型及服务商能力。

macOS 已安装官方原生 Claude CLI 时，可运行 `npm run test:claude-code:runtime` 进行本地模拟服务验收；测试使用临时目录和合成凭据，不需要付费 API 账号。`npm run test:claude-code:interactive` 验证首次交互启动（另需 Python 3），`npm run test:desktop:claude-manager` 验证管理器界面。

## 许可证与来源

项目代码按 [CC-BY-NC-SA-4.0](LICENSE) 分发。独立第三方依赖继续适用各自许可证，详见 [第三方声明](THIRD_PARTY_NOTICES.md)。

部分 Codex 管理逻辑适配自 [Cockpit Tools](https://github.com/jlcodes99/cockpit-tools)，技术栈和视觉参考 [Kiro Manager Lite](https://github.com/lucks-cloud/kiro-manager-lite)。本项目为独立工具，与 OpenAI、Anthropic 或上述项目无官方关联。
