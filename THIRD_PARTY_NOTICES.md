# Third-party notices / 第三方来源与许可

Agent Manager Lite project code and adaptations of Cockpit Tools are distributed
under the root [CC-BY-NC-SA-4.0 license](LICENSE). Independent dependencies retain
their own licenses and copyright notices. This project is not an official product
of OpenAI, Anthropic, Cockpit Tools, or Kiro Manager Lite.

项目代码及 Cockpit Tools 适配代码遵循根目录的 CC-BY-NC-SA-4.0。
独立依赖继续适用各自的许可证及版权声明，本项目不替代其许可。

## Cockpit Tools

- Source: <https://github.com/jlcodes99/cockpit-tools>
- Author: jlcodes99 and contributors.
- Baseline: `ee816002b771b766af23b575b6f59b586d547acc`.
- License: CC-BY-NC-SA-4.0, as declared by the upstream package.

The Codex sidecar is adapted from `sidecars/cockpit-cliproxy`. Account and provider
management, model catalogs, instance launch/configuration, local access, sessions,
login/import, proxy resources, quota handling, and configuration backup semantics
are adapted from the upstream Codex modules and services. The Electron/Vue UI,
TypeScript lifecycle and persistence, cancellation and recovery, and integration
with the bundled sidecar contain project-specific adaptations. This application
does not include Cockpit Tools' other client-management interfaces.

## CLIProxyAPI

- Source: <https://github.com/router-for-me/CLIProxyAPI>
- Baseline: `v7.2.155` (`7fac6b15`), with Cockpit adaptations and selected
  `v7.2.157` compatibility changes.
- License: MIT; original copyright and license are retained in
  `sidecars/codex-proxy/third_party/CLIProxyAPI/LICENSE`.

The vendored module contains modifications to account scoping, provider forwarding,
service-tier handling, proxy transport, streaming errors, WebSocket lifecycle,
model discovery, and optional OAuth configuration. Model capability data from
`internal/registry/models/codex_client_models.json` retains the same MIT license.
See [sidecar provenance](sidecars/codex-proxy/UPSTREAM.md).

## OpenAI Codex

- Source: <https://github.com/openai/codex>
- Baseline: `rust-v0.153.2`, commit `657a993cbee87acf52d14b758ce49dbd46d1b8eb`.
- License: Apache-2.0, OpenAI; retained in `licenses/OpenAI-Codex-LICENSE` and
  `licenses/OpenAI-Codex-NOTICE`.

The CLI resolver adapts npm launcher/platform resolution. The original launcher
is retained as `tests/fixtures/codex-npm-launcher.js` for tests and is not shipped
in the application. Session layout and index integration reference the same
source version. The official Codex executable is not bundled.

## Kiro Manager Lite

- Reference: <https://github.com/lucks-cloud/kiro-manager-lite>
- Baseline: `ba0c00f1ebdff83b8c28cd4d7f226f0acdec3827`.
- Upstream license: AGPL-3.0.

Electron/Vue architecture and visual design are references. No Kiro business
implementation or UI component source is copied into this application.

## Mihomo

- Source: <https://github.com/MetaCubeX/mihomo/tree/v1.19.31>
- License: GPL-3.0; retained in `licenses/Mihomo-LICENSE`.

Asset metadata references this version. Mihomo is a separate executable and is
not bundled in the application; the optional installer obtains it only through
an explicit user operation. Its license does not replace other components' licenses.

## JavaScript dependencies

| Component | Version | Source | License |
| --- | --- | --- | --- |
| acorn | 8.15.0 | <https://github.com/acornjs/acorn> | MIT |
| toml-eslint-parser | 1.0.3 | <https://github.com/ota-meshi/toml-eslint-parser> | MIT |
| eslint-visitor-keys | Locked transitive version | <https://github.com/eslint/js> | MIT |
| yaml | 2.9.1 | <https://github.com/eemeli/yaml> | ISC |
| yauzl | 3.4.0 | <https://github.com/thejoshwolfe/yauzl> | MIT |
| yazl | 3.3.1 | <https://github.com/thejoshwolfe/yazl> | MIT |
| buffer-crc32 | Locked transitive version | <https://github.com/brianloveswords/buffer-crc32> | MIT |
| pend | Locked transitive version | <https://github.com/andrewrk/node-pend> | MIT |

These libraries retain the copyright and license files supplied in their npm
packages. Packaging also includes the parser, visitor-key, and YAML licenses as
application resources. Other npm and Go dependencies retain their original
notices; exact versions and integrity hashes are recorded in the lockfiles and
Go module files.
