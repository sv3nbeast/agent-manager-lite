# Agent Manager Lite

[![CI](https://github.com/sv3nbeast/agent-manager-lite/actions/workflows/ci.yml/badge.svg)](https://github.com/sv3nbeast/agent-manager-lite/actions/workflows/ci.yml)

[简体中文](README.md) · English · [Downloads](https://github.com/sv3nbeast/agent-manager-lite/releases) · [Issues](https://github.com/sv3nbeast/agent-manager-lite/issues)

A lightweight Agent client manager organized around instances, with shared accounts, provider keys and client settings.

**Create an instance → Choose a client → Choose a compatible account or provider → Configure the project → Launch**

**Codex** is currently supported. **Claude Code** and **Claude Desktop (Chat / Cowork / Code)** are planned and are not implemented yet. Client and mode names follow the [official Claude documentation](https://code.claude.com/docs/en/desktop).

## Features

- **Independent instances**: manage Codex desktop and CLI instances, choose an account, connection mode and project, then preview, launch, stop or archive.
- **Accounts**: sign in to ChatGPT using a browser or device code, import accounts, and manage tags, groups, usage windows and the account recycle bin.
- **Providers and keys**: manage multiple API providers and keys, discover models through their APIs, and run cancellable connection and conversation tests.
- **Models and configuration**: choose a model, reasoning effort and preset or custom context window; preview configuration changes and restore them.
- **Standard / Fast**: choose a speed in the existing menu of supported Codex desktop instances. The local API supports service tier settings and outbound tier records. Availability depends on the client version, model and provider.
- **Network proxies**: configure a default proxy and account overrides using HTTP, HTTPS, SOCKS5 or SOCKS5H.
- **Local API**: use multiple accounts, scheduling strategies and separate access keys with model restrictions and Token limits.
- **Sessions and records**: manage sessions from registered directories, import, export, copy and restore them; query request history, view statistics and export CSV files.
- **Data backups**: preview imports, export accounts or create encrypted portable data backups.

## Install and use

The current release target is **macOS Apple Silicon (arm64)**, with DMG and ZIP packages. Check [Releases](https://github.com/sv3nbeast/agent-manager-lite/releases) for available downloads; if none are available, run from source using the instructions below. Windows, Linux and other architectures have not been validated.

1. Install and open Agent Manager Lite, and prepare a local Codex desktop application or CLI.
2. Sign in to ChatGPT under Accounts, or add an API URL, key and models under Providers and Keys.
3. Create an instance, choosing Codex and a compatible account or provider.
4. Select the project and settings, review the preview, then launch.

If a proxy is required, configure the default network in Settings and override it per account as needed. Proxies apply to the manager’s login exchanges, Token refreshes, usage queries and local API. External browsers and native clients use their own network settings.

Quit the application before installing an update. In-app automatic updates are not implemented. Packages include `SHA256SUMS.txt`; current builds do not have Developer ID signing or notarization.

## Data

Accounts and keys are encrypted locally with Electron `safeStorage`. Credentials are not saved if system encryption is unavailable. Account exports contain login credentials; portable data backups use a separate password for encryption. Request history does not store request bodies or keys.

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

Install the Codex client separately; this project does not bundle the official client. Desktop menu and language integration depend on the client version. Passing source tests does not establish compatibility with every client version or live account environment.

## License and attribution

Project code is distributed under [CC-BY-NC-SA-4.0](LICENSE). Third-party dependencies retain their own licenses; see [Third-party notices](THIRD_PARTY_NOTICES.md).

Parts of the Codex management logic are adapted from [Cockpit Tools](https://github.com/jlcodes99/cockpit-tools). The technology stack and visual direction are inspired by [Kiro Manager Lite](https://github.com/lucks-cloud/kiro-manager-lite). This is an independent tool with no official affiliation with OpenAI, Anthropic or those projects.
