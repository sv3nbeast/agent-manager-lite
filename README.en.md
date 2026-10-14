# Agent Manager Lite

[![CI](https://github.com/sv3nbeast/agent-manager-lite/actions/workflows/ci.yml/badge.svg)](https://github.com/sv3nbeast/agent-manager-lite/actions/workflows/ci.yml)

[简体中文](README.md) · English · [Downloads](https://github.com/sv3nbeast/agent-manager-lite/releases) · [Issues](https://github.com/sv3nbeast/agent-manager-lite/issues)

A lightweight Agent workspace organized around instances, with shared accounts, provider keys and client settings, gradually connecting terminal agents, desktop clients and AI editors.

**Create an instance → Choose a client → Choose a compatible account or provider → Configure the project → Launch**

**Codex** desktop and CLI, and the **official native Claude Code CLI on macOS with API connections**, are currently supported. More Agent clients and editors are being planned and evaluated; see Integration direction below.

## Screenshots

These screenshots capture the running v0.1.0 application content at its default window size and system theme. Accounts, providers and usage use demo data.

![Agent Manager Lite account management](assets/screenshots/accounts.png)

<details>
<summary>View workspace overview</summary>

![Agent Manager Lite workspace overview](assets/screenshots/overview.png)

</details>

## Features

- **Independent instances**: choose Codex or Claude Code in one wizard, with automatically suggested, editable names and only compatible accounts and supported settings. Preview, launch, stop or archive the instance.
- **Codex personal skills**: managed desktop and CLI instances automatically gain missing entries from the local user's `~/.codex/skills` on launch, including existing instances and session copies. Individual directory links follow source updates while preserving any existing instance directory, file or link with the same name. System skills remain separate. Directly adopted external homes retain their own skill configuration.
- **Accounts**: sign in to ChatGPT using a browser or device code, import accounts, and manage tags, groups, usage windows, subscription expiry and the account recycle bin. Add Claude Code API Key / Bearer connections from the same account entry point or instance wizard. Expiry dates and usage depend on the upstream response.
- **Providers and keys**: manage multiple API providers and keys. Codex connections support API model discovery and cancellable connection and conversation tests; Claude Code uses an explicitly declared Anthropic Messages URL, credential and model list. Manage saved Claude connections in Providers and keys → API connections. Edit the URL, models and credential there; changing the destination requires reentering its key, and active instances must stop before their connection changes.
- **Models and configuration**: choose models according to client capabilities. Codex supports reasoning effort and preset or custom context windows, with per-model connection settings and provider defaults. Claude Code uses models declared by its connection and does not inherit Codex context or speed settings.
- **Standard / Fast**: choose a speed in the existing menu of supported Codex desktop instances. The local API supports service tier settings and outbound tier records. Availability depends on the client version, model and provider.
- **Network proxies**: configure a default proxy and account overrides using HTTP, HTTPS, SOCKS5 or SOCKS5H.
- **Local API**: use multiple Codex accounts, scheduling strategies and separate access keys with model restrictions and Token limits. Claude Code connects directly to the selected Anthropic Messages service.
- **Codex sessions and records**: start fresh or copy sessions from an instance or local directory. Automatically discover local instances from compatible tools, including running sources. Preview session counts and project grouping, search project details, then create an independent snapshot of saved history, preserving the original directory. External sources on macOS APFS can remain active; new messages do not continuously sync to the copy. Directly reusing an existing directory still requires closing its source client. Copies skip temporary files, caches and worktree code, retain original project paths, and report stale session indexes omitted from the copy. Manage session import, export, copies and restoration, and query request history, statistics and CSV exports.
- **Claude Code sessions**: view managed instance history on the shared Sessions page, filter by source and title, open a file, reveal its location or copy its original session ID. Repeated IDs remain separate by instance, project and file. Import, export, copying, synchronization, archiving, deletion, visibility repair, content search and Token statistics are not available for Claude sessions.
- **Data backups**: preview imports, export accounts or create encrypted portable data backups.

## Claude Code support

Install the **official native Claude CLI for macOS** separately. Choose Claude Code when creating an instance, then add or select an API Key, Bearer token or gateway compatible with Anthropic Messages, including its service URL and available models. “API connection configured” indicates that credentials are configured; it does not establish that the upstream service accepts them. Subscription OAuth / browser sign-in, cloud modes such as Bedrock / Vertex / Foundry, npm wrapper launchers and Claude Desktop are not integrated.

Each instance has separate Claude configuration, global state and session directories. User settings and history are retained when the instance stops. Initial startup configures the welcome flow; Claude still asks for workspace trust, API key approval and tool permissions. User-selectable setting sources are limited to that instance's user settings; project and local settings, their environment variables and hooks are excluded, and MCP uses a managed empty configuration. System or organization managed policies still apply through Claude. Project `CLAUDE.md` files remain readable and project code stays in its original location. Configuration isolation is not a filesystem sandbox.

When the official installation entry point stays the same, the executable path is rediscovered after CLI upgrades and required command capabilities are checked before launch. Running processes retain their original launch path for ownership checks and recovery. Compatible upgrades do not require a fixed version list; changes to isolation flags or process behavior can still require adaptation.

Acceptance used real **Claude CLI 2.1.295** processes against a local mock service, covering API Key / Bearer requests, concurrent instance configuration and transcript isolation, same-instance resume and rejection of cross-instance resume. First interactive startup and clean exit were also verified for API Key and Bearer connections. No real paid upstream credentials were used; this does not establish compatibility with every gateway, subscription or client release. The manager provides read-only Claude session browsing; continue conversations inside the corresponding CLI instance.

## Integration direction

Future integrations aim to connect more useful agents and editors through one instance entry point. The examples below are candidates and are not implemented yet; they are neither an exhaustive list nor a committed release schedule.

| Type | Integration candidates |
| --- | --- |
| Terminal agents | [Gemini CLI](https://geminicli.com/docs/), [OpenCode](https://opencode.ai/docs/), [Kiro CLI](https://kiro.dev/docs/) |
| Desktop agents | [Claude Desktop (Chat / Cowork / Code)](https://code.claude.com/docs/en/desktop), [OpenCode Desktop](https://opencode.ai/docs/) |
| AI editors and IDEs | [Kiro IDE](https://kiro.dev/docs/), [Cursor](https://cursor.com/docs), [VS Code / GitHub Copilot](https://code.visualstudio.com/docs/agents/overview), [Zed](https://zed.dev/docs/ai/overview), [Devin Desktop (formerly Windsurf)](https://docs.devin.ai/desktop/getting-started) |

New integrations will use the same Create an instance → Choose a client flow, with shared account and provider management. Sign-in, models, context windows, speed settings and instance isolation will follow each client's actual capabilities; provider keys will only be reused between compatible clients.

## Install and use

The current release target is **macOS Apple Silicon (arm64)**, with DMG and ZIP packages. Check [Releases](https://github.com/sv3nbeast/agent-manager-lite/releases) for available downloads; if none are available, run from source using the instructions below. Windows, Linux and other architectures have not been validated.

1. Install and open Agent Manager Lite, and prepare a local Codex desktop application / CLI or the official native Claude CLI.
2. Create an instance, choosing a client and compatible account or provider. You can also add a connection within the wizard.
3. For Codex, sign in to ChatGPT or use an API connection. For Claude Code, choose API Key / Bearer and provide an Anthropic Messages URL and models.
4. Check the model, working directory and launch preview, then launch. Codex also supports selecting a session source. Choose desktop projects inside Codex; CLI instances run in Terminal.

New ChatGPT account instances default to native sign-in, which supplies the client's real login identity. Account features depend on the plan, workspace and client version. HTTP, HTTPS, SOCKS5 and SOCKS5H proxies also work with native sign-in. Codex API keys and Agent Identity default to Local API. When a ChatGPT OAuth account uses Local API, the manager keeps the local gateway and projects the real account identity for the duration of the launch, then restores the original files when the instance stops. A pure API connection has no ChatGPT OAuth identity for the client to display. Existing instances keep their current mode and can be edited after stopping. If Codex history is hidden after changing modes, select that instance under Sessions → Repair visibility and preview the repair for its connection mode.

If a proxy is required, configure the default network in Settings and override it per account as needed. Proxies apply to the manager’s login exchanges, token refreshes, usage queries, local API, and native desktop/CLI instances launched by the manager. Codex native account instances retain their ChatGPT identity and use a dedicated local relay for authenticated upstream proxies. Explicit direct mode overrides inherited and system proxies. Closing the manager window keeps each relay alive until its instance exits. External browsers and independently launched clients use their own network settings.

While instances are active, Cmd+Q, menu Quit and the ordinary tray Quit close the management UI and keep its background services alive. Instances and their local API connections continue running; the manager exits after all instances finish and their configuration is restored. Reopen the app or show its window from the tray to resume management. The tray's “Quit and stop running instances” action stops the instances and exits completely.

Finish active work and wait for the manager to exit completely before installing an update. In-app automatic updates are not implemented. Packages include `SHA256SUMS.txt`; current builds do not have Developer ID signing or notarization.

## Data

Accounts and keys are encrypted locally with Electron `safeStorage`. Credentials are not saved if system encryption is unavailable. Account exports contain login credentials; portable data backups use a separate password for encryption. Request history does not store request bodies or keys.

Claude CLI startup hands off API credentials through a temporary environment file with `0600` permissions. It is deleted immediately after consumption and cleaned up on cancellation or failure. Keys are not written into command arguments, recovery records or instance `settings.json` files.

## Run from source

Built with Electron, Vue 3, TypeScript and Go. CI uses Node.js **25.8.2** and Go **1.26.1**; dependency versions are pinned in lockfiles.

```sh
git clone https://github.com/sv3nbeast/agent-manager-lite.git
cd agent-manager-lite
npm ci
npm run setup:electron
npm run build:proxy
npm run dev
```

Check and build the source:

```sh
npm run typecheck
npm test
npm run test:claude-code
npm run test:proxy
npm run test:proxy:handlers
npm run build
```

Build macOS arm64 installers:

```sh
npm run build:proxy
npm run build
npx electron-builder --mac --arm64 --publish never
```

Install Codex and Claude Code clients separately; this project does not bundle the official clients. Codex desktop language, Standard/Fast and Ultra are detected independently from the installed client's resources and shown in the launch preview. Compatible resource structures can survive client updates without adding a version entry; changed interfaces still require adaptation. Passing source tests does not establish compatibility with every client version or live account environment.

With the official native Claude CLI installed on macOS, run `npm run test:claude-code:runtime` for acceptance against a local mock service. It uses temporary directories and synthetic credentials and does not require a paid API account. Run `npm run test:claude-code:interactive` to verify first interactive startup (Python 3 required), and `npm run test:desktop:claude-manager` to check the manager UI.

## License and attribution

Project code is distributed under [CC-BY-NC-SA-4.0](LICENSE). Third-party dependencies retain their own licenses; see [Third-party notices](THIRD_PARTY_NOTICES.md).

Parts of the Codex management logic are adapted from [Cockpit Tools](https://github.com/jlcodes99/cockpit-tools). The technology stack and visual direction are inspired by [Kiro Manager Lite](https://github.com/lucks-cloud/kiro-manager-lite). This is an independent tool with no official affiliation with OpenAI, Anthropic or those projects.
