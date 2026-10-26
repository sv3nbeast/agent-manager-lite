# Agent Manager Lite

[![CI](https://github.com/sv3nbeast/agent-manager-lite/actions/workflows/ci.yml/badge.svg)](https://github.com/sv3nbeast/agent-manager-lite/actions/workflows/ci.yml)

[简体中文](README.md) · English · [Downloads](https://github.com/sv3nbeast/agent-manager-lite/releases) · [Issues](https://github.com/sv3nbeast/agent-manager-lite/issues)

A lightweight workspace for **Codex, Claude Code CLI and Claude Desktop**, with multiple instances, shared accounts and provider keys, separate configurations, session management and network proxies.

**Create an instance → Choose Codex / Claude → Choose desktop / CLI → Select sign-in or a connection → Preview and launch**

The following clients are supported on macOS. Isolation details and acceptance limits are described below.

| Client | Launch mode | Sign-in and connections |
| --- | --- | --- |
| Codex | Desktop application, CLI terminal | ChatGPT accounts, API connections |
| Claude Code | Official native CLI terminal | Claude subscription accounts, API Key / Bearer, Anthropic Messages gateways |
| Claude Desktop | Desktop application | Sign-in inside the client, or API / third-party connections for Code / Cowork |

More Agent clients and editors are being planned and evaluated; see Integration direction below.

## Screenshots

These screenshots capture the running v0.1.0 application content at its default window size and system theme. Accounts, providers and usage use demo data.

![Agent Manager Lite account management](assets/screenshots/accounts.png)

<details>
<summary>View workspace overview</summary>

![Agent Manager Lite workspace overview](assets/screenshots/overview.png)

</details>

## Features

- **Independent instances**: choose Codex or Claude, then desktop application or CLI terminal in one wizard, with automatically suggested, editable names and only compatible accounts and supported settings. Preview, launch and stop instances. Claude Desktop supports sign-in inside its own client or API / third-party connections for native Code / Cowork.
- **Codex personal skills**: managed desktop and CLI instances automatically gain missing entries from the local user's `~/.codex/skills` on launch, including existing instances and session copies. Individual directory links follow source updates while preserving any existing instance directory, file or link with the same name. System skills remain separate. Directly adopted external homes retain their own skill configuration.
- **Accounts**: sign in to ChatGPT using a browser or device code, import accounts, and manage tags, groups, usage windows, subscription expiry and the account recycle bin. Add Claude subscription accounts and refresh their identity, plan and usage, or use them in managed CLI instances alongside API Key / Bearer connections. Desktop API connections reuse shared provider keys. Expiry dates and usage depend on the upstream response.
- **Providers and keys**: each key has its own models, API protocol and authentication method. One supplier can hold separate OpenAI Responses, Chat Completions and Anthropic Messages keys. Fetch models and run cancellable connection or conversation tests for the selected key, choosing from its own model list. Clear all selected models without discarding fetched results, then add all fetched models. Editing one key only updates connections linked to that key; existing standalone connections keep their configuration until explicitly linked. Active instances must stop before their connection changes.
- **Models and configuration**: choose models according to client capabilities. Codex supports reasoning effort and preset or custom context windows, with per-model connection settings and provider defaults. Claude Code CLI uses models declared by its connection and does not inherit Codex context or speed settings.
- **Standard / Fast**: choose a speed in the existing menu of supported Codex desktop instances. The local API supports service tier settings and outbound tier records. Availability depends on the client version, model and provider.
- **Network proxies**: configure a default proxy and account overrides using HTTP, HTTPS, SOCKS5 or SOCKS5H.
- **Local API**: use multiple Codex accounts, scheduling strategies and separate access keys with model restrictions and Token limits. Claude Code CLI connects directly to the selected Anthropic Messages service.
- **Image generation and editing APIs**: the local API forwards `/v1/images/generations` and `/v1/images/edits` to providers that support Images APIs, enforcing key model scopes and account authorization, using the configured proxy and preserving provider streaming responses.
- **Codex sessions and records**: the Sessions page scans registered directories, the local default `~/.codex`, and other Codex homes the user explicitly adds as read-only sources. Search by source, working directory, title, ID or body text, including chats whose working directory is in a separate project folder. Codex and Claude share the paginated transcript viewer, which opens on the latest 10 readable records with adjacent older / newer windows; same-ID conflicts require choosing a specific file version. Registered external sources can be used for one-way import after conflict checks and preview, with managed Codex instances as the only targets. Disabling or removing a source, or changing its rollout files, invalidates a pending preview. External sources are never added to client configuration and are excluded from archive, deletion and visibility repair; the default `~/.codex` remains browse-only. Newer Codex paginated histories can be viewed and searched only after their complete `history_base` chain is verified, and resumed in a stopped managed Codex CLI instance after the active SQLite rollout and full lineage are revalidated. A single complete paginated conversation can be migrated, including its lineage and SQLite session state, from a stopped managed instance or registered read-only external home to a stopped managed instance. Select the active SQLite rollout in the preview; batch migrations, the default ~/.codex and external targets do not support paginated migration. When copying an existing instance, choose which working directories' conversations to include; the copy is an independent snapshot, leaves the source untouched, and does not sync later messages. Manage session import, export, copies and restoration, and query request history, statistics and CSV exports.
- **Claude sessions**: browse the default Claude Code directory, managed CLI instances and locally saved Claude Desktop Code history on the shared Sessions page. Filter by client, source, project, title / ID and message content; read paginated user, assistant, thinking and tool records without automatically loading attachments. Preview the account, model and original project before resuming a stopped managed CLI instance. Mixed-ID transcripts can only resume from the latest, clearly ordered session whose ID matches the filename; this starts a new fork. If its `parentUuid` chain reaches earlier messages, the official CLI includes reachable ancestor context and the preview explains this. Older IDs, ambiguous ordering, filename mismatches, conflicting or changed records remain read-only, and the original transcript is not rewritten. Repeated IDs remain separate by source. Default-directory and Desktop records are read-only. Manage Chat, Cowork, SSH and cloud history in the original client. Cross-instance copying, import, export, synchronization, archiving, deletion, visibility repair and Token statistics remain unavailable for Claude sessions.
- **Data backups**: preview imports, export accounts or create encrypted portable data backups.

## Image generation and editing APIs

Configure the image models available to a provider key, then call `/v1/images/generations` or `/v1/images/edits` with an authorized local API access key. Model routes select the provider and its connection's network proxy; image models must satisfy both provider-key and local-access-key model scopes. Generation accepts JSON, and editing accepts JSON or multipart file uploads. When the provider supports streaming, its SSE events and returned usage information are preserved.

Provider image requests call its Images endpoint directly, preserving native fields, image data and response formats while applying configured model mappings. The ChatGPT OAuth image account pool continues to use the Responses `image_generation` tool through a separate upstream path. Available image models, editing fields and streaming modes depend on the provider. Configuring Responses, Chat Completions or Anthropic Messages for conversations does not establish that the service offers an Images API.

Sub2API balance queries are independent of the model protocol: OpenAI and Anthropic Messages keys each use their own credentials and balance. Once the provider integration has been identified, the manager prefers Sub2API's `/v1/usage`, retains legacy endpoint fallback, and distinguishes timeout, connection / proxy and server rejection errors.

## Claude support

### Claude Desktop

Install the official Claude Desktop application for macOS separately. Choose **Claude → Desktop application** and the installed application when creating an instance, then sign in and select models and projects inside that client. Chat, Code and Cowork availability depends on the account plan and client version. If browser sign-in does not return to the intended instance, use its **Complete sign-in** action to send that attempt's Claude callback link to it. Confirm the result in the client. Desktop API / third-party connections use the verified native 3p deployment for Code / Cowork; Claude.ai browser sign-in remains a separate client-login mode.

When an API / third-party instance starts without an existing Developer preference, the manager initializes its native Developer menu so connection settings are available under **Developer → Configure Third-Party Inference…**. An explicit disabled preference is retained, and Claude still enforces organization and restricted-account policies. Instances using sign-in inside the client keep their native preference. Proxy configurations are also registered in the native configuration list so the editor can read and save them. On the next instance launch after upgrading, older recovery records remain compatible, preserving native configurations created, selected or edited in the client and their extension fields.

Each instance stores its own desktop profile, cookies, client configuration and local history, retained after stopping. Cloud history for the same Claude account can still sync across instances. Instances use the current macOS user's system Keychain service while keeping their encrypted state files separate. The manager makes that service available without reading or copying Keychain credentials. Native custom environments and temporary directory settings are retained; configuration isolation is not a filesystem sandbox. The manager can read locally saved Code transcripts from each instance. Manage Desktop Chat, Cowork and remote history, and continue Desktop conversations, inside the corresponding client.

Desktop sign-in inside the client uses the default network in **Settings**; API / third-party connections can also use the selected connection's account proxy override. A configured proxy runs through a relay dedicated to the instance, explicit direct mode bypasses system proxies, and inherit keeps the system network behavior. Explicit custom environment variables in Code mode can still override that default proxy. Upstream proxy credentials are never written into Desktop configuration or command arguments. Closing the manager window keeps the instance and its relay running.

### Claude subscription accounts

Use **Accounts → Add account → Claude subscription** to authorize through the official page and paste a callback link or one-time code. The manager saves and refreshes identity, organization, plan and usage returned by the upstream service. This authorization uses Claude Code OAuth scopes, which differ from Desktop browser sessions, and does not sign in to Desktop automatically. Managed CLI instances can use an access-only projection refreshed by the manager; refresh tokens remain in the manager vault.

### Claude Code CLI

Install the **official native Claude CLI for macOS** separately. Choose **Claude → CLI terminal** when creating an instance, then add or select a Claude subscription account. Alternatively, choose an API Key, Bearer token or Anthropic Messages gateway connection and configure its service URL and available models. Keys and model lists are managed in the shared provider library. “API connection configured” indicates that credentials are configured; it does not establish that the upstream service accepts them. Cloud modes such as Bedrock / Vertex / Foundry and npm wrapper launchers are not integrated.

Each instance has separate Claude configuration, global state and session directories. User settings and history are retained when the instance stops. Initial startup configures the welcome flow; Claude still asks for workspace trust, API key approval and tool permissions. User-selectable setting sources are limited to that instance's user settings; project and local settings, their environment variables and hooks are excluded, and MCP uses a managed empty configuration. System or organization managed policies still apply through Claude. Project `CLAUDE.md` files remain readable and project code stays in its original location. Configuration isolation is not a filesystem sandbox.

When the official installation entry point stays the same, the executable path is rediscovered after CLI upgrades and required command capabilities are checked before launch. Running processes retain their original launch path for ownership checks and recovery. Compatible upgrades do not require a fixed version list; changes to isolation flags or process behavior can still require adaptation.

CLI acceptance used real **Claude CLI 2.1.295** processes against a local mock service, covering API Key / Bearer requests, concurrent instance configuration and transcript isolation, same-instance resume and rejection of cross-instance resume. First interactive startup and clean exit were also verified for API Key and Bearer connections. The manager can browse and search local transcripts and, after a preview, resume a stopped managed CLI instance in its original project with the configured account, permissions and network. Desktop checks cover the official welcome page, proxy routing, local profile isolation and lifecycle. No real account has completed Desktop sign-in in acceptance; callback checks only verify delivery and rejection of a synthetic callback at the intended instance. Live end-to-end Chat / Code / Cowork and subscription requests were not tested. Local tests do not establish compatibility with every gateway, plan or client release.

## Integration direction

Future integrations aim to connect more useful agents and editors through one instance entry point. The examples below are candidates and are not implemented yet; they are neither an exhaustive list nor a committed release schedule.

| Type | Integration candidates |
| --- | --- |
| Terminal agents | [Gemini CLI](https://geminicli.com/docs/), [OpenCode](https://opencode.ai/docs/), [Kiro CLI](https://kiro.dev/docs/) |
| Desktop agents | [OpenCode Desktop](https://opencode.ai/docs/) |
| AI editors and IDEs | [Kiro IDE](https://kiro.dev/docs/), [Cursor](https://cursor.com/docs), [VS Code / GitHub Copilot](https://code.visualstudio.com/docs/agents/overview), [Zed](https://zed.dev/docs/ai/overview), [Devin Desktop (formerly Windsurf)](https://docs.devin.ai/desktop/getting-started) |

New integrations will use the same Create an instance → Choose a client flow, with shared account and provider management. Sign-in, models, context windows, speed settings and instance isolation will follow each client's actual capabilities; provider keys will only be reused between compatible clients.

## Install and use

The current release target is **macOS Apple Silicon (arm64)**, with DMG and ZIP packages. Check [Releases](https://github.com/sv3nbeast/agent-manager-lite/releases) for available downloads; if none are available, run from source using the instructions below. Windows, Linux and other architectures have not been validated.

1. Install and open Agent Manager Lite, and prepare a local Codex desktop application / CLI, Claude Desktop or the official native Claude CLI.
2. Create an instance, choose Codex or Claude, then choose a desktop application or CLI terminal. Select an existing account or API connection where needed, or add one within the wizard.
3. For Codex, sign in to ChatGPT or use an API connection. For Claude Code CLI, select a Claude subscription account or configure an API Key / Bearer connection with its Anthropic Messages URL and models. For Claude Desktop, sign in inside the client after launch or select a saved API / third-party connection for Code / Cowork.
4. Check the launch preview, then launch. Codex also supports selecting a session source. Choose desktop models and projects inside the corresponding client; CLI instances run in Terminal.

New ChatGPT account instances default to native sign-in, which supplies the client's real login identity. Native account desktop instances use the installed client’s original UI, without manager page scripts or forced home navigation. This launch path does not depend on a renderer patch version; the client retains its language, home and feature preferences. Account features depend on the plan, workspace and client version. HTTP, HTTPS, SOCKS5 and SOCKS5H proxies also work with native sign-in. Codex API keys and Agent Identity default to Local API. When a ChatGPT OAuth account uses Local API, the manager keeps the local gateway and projects the real account identity for the duration of the launch, then restores the original files when the instance stops. A pure API connection has no ChatGPT OAuth identity for the client to display. Existing instances keep their current mode and can be edited after stopping. If Codex history is hidden after changing modes, select that instance under Sessions → Repair visibility and preview the repair for its connection mode.

Local API keeps its gateway and API UI compatibility settings even when it displays a ChatGPT account. To use the original account UI, finish the instance’s active work, stop it, choose Native sign-in in Edit, save, and relaunch. The instance card and launch preview identify the UI mode. A new instance has its own desktop profile and does not copy the main client’s cookies or home preferences.

If a proxy is required, configure the default network in Settings and override it per account as needed. Proxies apply to the manager’s login exchanges, token refreshes, usage queries, local API, and native desktop/CLI instances launched by the manager. Codex native account instances retain their ChatGPT identity and use a dedicated local relay for authenticated upstream proxies. Claude Desktop sign-in inside the client uses the default network; API / third-party connections can use an account proxy override. Explicit direct mode overrides inherited and system proxies. Closing the manager window keeps each relay alive until its instance exits. External browsers and independently launched clients use their own network settings.

While instances are active, Cmd+Q, menu Quit and the ordinary tray Quit close the management UI and keep its background services alive. Instances and their local API connections continue running; the manager exits after all instances finish and their configuration is restored. Reopen the app or show its window from the tray to resume management. The tray's “Quit and stop running instances” action stops the instances and exits completely.

Finish active work and wait for both the instances and manager to exit completely before installing an update. If an older manager remains in the background, opening a new bundle brings back the old window; check the version at the bottom of the sidebar. Existing client instances also need a fresh launch to use the updated launch behavior. In-app automatic updates are not implemented. Packages include `SHA256SUMS.txt`; current builds do not have Developer ID signing or notarization.

## Data

Accounts and keys are encrypted locally with Electron `safeStorage`. Credentials are not saved if system encryption is unavailable. Account exports contain login credentials; portable data backups use a separate password for encryption. Request history does not store request bodies or keys.

Claude CLI startup hands off API credentials through a temporary environment file with `0600` permissions. It is deleted immediately after consumption and cleaned up on cancellation or failure. Keys are not written into command arguments, recovery records or instance `settings.json` files.

Claude Desktop sign-in and local history remain in each instance's client files. Portable data backups include instance definitions, excluding those client files and the system Keychain. Required local service entries are recreated when a restored instance launches.

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

Install Codex, Claude Desktop and Claude Code CLI separately; this project does not bundle the official clients. For Codex API desktop modes, language, Standard/Fast and Ultra are detected independently from the installed client's resources and applicable results are shown in the launch preview. Native account desktop instances use the original client UI. Compatible resource structures can survive client updates without adding a version entry; changed interfaces still require adaptation. Passing source tests does not establish compatibility with every client version or live account environment.

Ultra is a reasoning and task delegation preset offered according to the model catalog, independent of the Ultra Fast speed tier. Newer clients may map Ultra to the model's declared API reasoning effort (such as `xhigh`) while enabling proactive task delegation. The request's `reasoning.effort` alone does not establish a downgrade; the manager preserves the native behavior.

With the official native Claude CLI installed on macOS, run `npm run test:claude-code:runtime` for acceptance against a local mock service. It uses temporary directories and synthetic credentials and does not require a paid API account. Run `npm run test:claude-code:interactive` to verify first interactive startup (Python 3 required), and `npm run test:desktop:claude-manager` to check the manager UI.

With official Claude Desktop installed, check two-instance isolation, networking and synthetic login callback delivery:

```sh
npm run build:proxy
npm run test:claude-desktop:runtime -- --upstream-proxy-file /absolute/path/proxy.txt --test-callback
```

The proxy file must contain only the proxy URL, belong to the current user and have `0600` permissions. Alternatively, set `CML_CLAUDE_DESKTOP_PROXY`; do not supply both inputs. The script uses temporary instances and does not read manager Settings. The default two-instance check requires a proxy; `--single-instance` checks startup and Keychain availability separately. Tests do not sign in to a real account or send model requests.

`npm run test:claude-desktop:config` uses a temporary instance, synthetic credentials and a loopback Messages service to verify the Developer configuration menu, Retry recovery from the old configuration-list error, native editing and saving, and persistence after restart. It requires Xcode Command Line Tools and Accessibility and Screen Recording permissions for the terminal running it. A test proxy blocks external requests. Evidence is saved in a temporary directory, or a private local directory set through `CML_DESKTOP_CONFIG_EVIDENCE`.

## License and attribution

Project code is distributed under [CC-BY-NC-SA-4.0](LICENSE). Third-party dependencies retain their own licenses; see [Third-party notices](THIRD_PARTY_NOTICES.md).

Parts of the Codex management logic are adapted from [Cockpit Tools](https://github.com/jlcodes99/cockpit-tools). The technology stack and visual direction are inspired by [Kiro Manager Lite](https://github.com/lucks-cloud/kiro-manager-lite). This is an independent tool with no official affiliation with OpenAI, Anthropic or those projects.
## Storage inventory

The Storage page read-only scans manager-owned instances, session-trash backups and recognized copy / archive staging directories, reporting logical bytes and file counts for conversation files, SQLite databases, configuration, skills, cache and other files. It skips symbolic links, external workspaces and unrecognized archives, and stops at file-count, nesting-depth or time limits. Damaged recovery journals and staging entries are warnings only and cannot be deleted from this page; process session-trash backups through the Sessions recovery workflow. APFS clones may share underlying blocks, so allocated space is an estimate rather than guaranteed reclaimable space. Legacy archives without a source manifest cannot be restored or deleted from this page.
