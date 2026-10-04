# Codex sidecar provenance

This sidecar is adapted from
[Cockpit Tools](https://github.com/jlcodes99/cockpit-tools), baseline
`ee816002b771b766af23b575b6f59b586d547acc`, under CC-BY-NC-SA-4.0.

The bundled `third_party/CLIProxyAPI` module derives from
[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) `v7.2.155`
(`7fac6b15`), with Cockpit-specific extensions and selected `v7.2.157`
compatibility changes. It retains its original MIT license and copyright
notices in `third_party/CLIProxyAPI/LICENSE`. The local Go `replace` directive
selects this bundled module.

Project adaptations include scoped account/key routing, provider gateways,
service-tier normalization, model capability projection, cancellation-aware
HTTP/SOCKS transport, streaming error propagation, and Responses WebSocket
session/terminal-error handling. These modifications do not change the upstream
license. Optional provider OAuth client configuration uses environment values
without embedded default credentials.

The sidecar is built from source by `scripts/build-proxy.mjs` and runs as a
separate local process. See the root `THIRD_PARTY_NOTICES.md` for the complete
application attribution and license boundaries.
