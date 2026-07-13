# Changelog

All notable changes to this App are documented in this file.

## [0.1.0-dev] - Unreleased

### Added

- amd64 Home Assistant App manifest with admin-only Ingress, `/config` read-write mapping, Core API access, and Supervisor `manager` role.
- OpenAI Codex CLI 0.144.1 from the official x86_64 musl release archive with a pinned SHA-256 check.
- Persistent `HOME=/data/home` and `CODEX_HOME=/data/codex`, file credential storage, and `ha-codex`/`ha-codex-login` commands.
- A non-destructive `codex` wrapper that applies current approval/sandbox App options to CLI and Remote app-server launches.
- Ingress terminal using nginx, ttyd, and a shared tmux session, including optional one-time Codex auto-start.
- Public-key-only OpenSSH on container port 22 with default Network mapping 2223, persistent host keys, and disabled SSH when no valid authorized key is configured.
- Core and Supervisor REST helpers with HTTP/result error handling and token redaction, plus config-check and log commands.
- English and Korean App option/Network translations and operator documentation.

### Security

- Kept AppArmor enabled and omitted Supervisor `admin`, Docker API, `full_access`, and host networking.
- Applied `0700` to secret directories, `0600` to Codex credentials, authorized keys and SSH private keys, and `0644` to SSH public host keys.
- Documented that `/config` read-write and runtime API access are intentional high-risk capabilities.

### Known limitations

- The repository is private and no release `image` is configured; this development version uses the Home Assistant Local Apps build flow.
- Local Docker verification covers public-key SSH, password rejection, host-key/config persistence, degraded no-key operation, API helper error/redaction behavior, and the complete lint suite.
- Actual HAOS amd64 installation, Ingress/WebSocket behavior, device-auth persistence, Network port mapping, Windows SSH, Codex Desktop Remote SSH on Alpine/musl, real Core service calls, and Supervisor `manager` endpoints remain unverified M2 work.
- Only amd64 is declared. aarch64 is not supported or claimed.
