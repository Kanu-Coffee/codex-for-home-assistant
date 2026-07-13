# Changelog

All notable changes to this App are documented in this file.

## [0.1.3-dev] - Unreleased

### Added

- Add transparent Home Assistant `icon.png` and `logo.png` assets derived without distortion from the user-provided project mark, and display the logo in the public GitHub README.
- Extend the real ttyd WebSocket smoke test to prove terminal resize propagation and reattachment to the same tmux session, pane, and process within one running App container.
- Record the user-confirmed HAOS Web UI, authenticated Codex, update-path credential persistence, and mobile Remote-to-SSH project workflow.

### Fixed

- Negotiate `text/x-log` in `ha-core-logs` and `ha-addon-logs` instead of sending the JSON-only `Accept` header that failed against live Core and App log endpoints.
- Remove the stale hand-maintained document checksum manifest instead of presenting outdated hashes as integrity evidence.

### Security

- Allowlist API helper response media types so the new `--accept` option cannot inject arbitrary HTTP headers.
- Keep this release update-only and non-destructive: no migration or reset touches persistent `/data` content.

### Testing

- Add regression coverage for default JSON negotiation, log media negotiation, malformed Accept values, wrapper arguments, and Home Assistant brand asset dimensions.
- Treat the HAOS report's tmux result as unverified because no pre-existing Ingress session was present; do not infer a runtime regression from a non-interactive `TERM=dumb` observation.

## [0.1.2-dev] - 2026-07-13

### Added

- Add default global Home Assistant operating guidance at `/data/codex/AGENTS.md` when neither a global base nor override file exists.
- Separate diagnostic findings from authorization to modify automations, permissions, integrations, updates, restarts, or devices.

### Security

- Guide Codex to protect secrets, prefer supported APIs over direct `.storage` edits, open Recorder databases read-only, run `ha-config-check` after configuration changes, and require explicit authorization for high-risk operations.
- Preserve existing `AGENTS.md`, `AGENTS.override.md`, empty files, and symbolic links without changing their content or permissions.
- Document that model guidance is defense in depth rather than an enforcement boundary.

### Testing

- Verify default guidance creation, mode, safety content, init/restart persistence, and existing override preservation in policy and amd64 container smoke tests.
- Record the user's successful HAOS Web UI and authenticated Codex execution, `/config` write, and selected Supervisor information/log/config-check endpoints without overstating untested service calls or restart operations.

## [0.1.1-dev] - 2026-07-13

### Fixed

- Restore `TERM=xterm-256color` after S6 `with-contenv` removes ttyd's per-PTY value, preventing tmux from exiting with `terminal does not support clear`.
- Preserve tmux's own `TERM=tmux-256color` in the session shell instead of rebuilding its environment through `with-contenv`.
- Force all `rootfs` files to LF in Git so Windows checkouts cannot produce broken container shebangs.

### Testing

- Added a dependency-free real ttyd WebSocket handshake and shell command smoke test that requires `/config` and a non-dumb TERM.
- Reproduced the failure and verified the fix with S6, ttyd 1.7.7, tmux 3.6b, and headless Chrome.
- HAOS public repository install/start and Ingress HTTP/token/WebSocket transport were confirmed; the fixed `0.1.1-dev` terminal UI still requires user retest on HAOS.

## [0.1.0-dev] - 2026-07-13

### Added

- amd64 Home Assistant App manifest with admin-only Ingress, `/config` read-write mapping, Core API access, and Supervisor `manager` role.
- OpenAI Codex CLI 0.144.1 from the official x86_64 musl release archive with a pinned SHA-256 check.
- Persistent `HOME=/data/home` and `CODEX_HOME=/data/codex`, file credential storage, and `ha-codex`/`ha-codex-login` commands.
- A non-destructive `codex` wrapper that applies current approval/sandbox App options to CLI and Remote app-server launches.
- Ingress terminal using nginx, ttyd, and a shared tmux session, including optional one-time Codex auto-start.
- Public-key-only OpenSSH on container port 22 with default Network mapping 2223, persistent host keys, and disabled SSH when no valid authorized key is configured.
- Core and Supervisor REST helpers with HTTP/result error handling and token redaction, plus config-check and log commands.
- English and Korean App option/Network translations and operator documentation.
- Public Home Assistant App repository metadata and direct App Store repository URL installation instructions.

### Security

- Kept AppArmor enabled and omitted Supervisor `admin`, Docker API, `full_access`, and host networking.
- Applied `0700` to secret directories, `0600` to Codex credentials, authorized keys and SSH private keys, and `0644` to SSH public host keys.
- Documented that `/config` read-write and runtime API access are intentional high-risk capabilities.

### Known limitations

- No registry `image` is configured; this public development repository installs by building its Dockerfile on the amd64 Home Assistant host.
- Local Docker verification covers public-key SSH, password rejection, host-key/config persistence, degraded no-key operation, API helper error/redaction behavior, and the complete lint suite.
- Actual HAOS amd64 installation, Ingress/WebSocket behavior, device-auth persistence, Network port mapping, Windows SSH, Codex Desktop Remote SSH on Alpine/musl, real Core service calls, and Supervisor `manager` endpoints remain unverified M2 work.
- Only amd64 is declared. aarch64 is not supported or claimed.
