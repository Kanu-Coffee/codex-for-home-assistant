# Changelog

All notable changes to this App are documented in this file.

## [0.3.1] - 2026-07-15

### Fixed

- Accept Home Assistant's successful `automation/config` response with `config: null` for an unavailable automation. The automation entity and its `search/related` graph remain indexable with an empty config and a bounded warning instead of aborting the entire catalog snapshot.
- Use the image-pinned `ws` runtime for the memory client with a handshake timeout, 32 MiB payload cap, disabled compression, and normal TLS verification, matching the App's other privileged WebSocket helpers.
- Preserve closed, machine-readable token, DNS, transport, timeout, authentication, protocol, command, and snapshot failure reasons in sync status and change verification. The daemon logs only an allowlisted reason code and never the captured command output.
- Reject valid JSON frames that are not protocol objects without crashing, and clear all pending parallel command timers before the transport closes after a partial failure.

### Security

- Remove the `HA_WS_URL` environment override so a caller cannot redirect the runtime Supervisor credential to an arbitrary WebSocket endpoint. Programmatic test endpoints require an explicit test credential and the production path remains fixed at the documented Supervisor proxy.
- Keep Supervisor authentication in the first WebSocket `auth` frame; do not add the credential to the HTTP Upgrade headers or send it to a direct-Core fallback.

### Upgrade notes

- The existing per-target App-version behavior applies to `0.3.1`: a retained `refresh_agents` or `refresh_all` selection refreshes its selected target once after the update. Select `preserve` before updating if that is not wanted.
- The supplied 0.3.0 read-only HAOS audit established the failure boundary but discarded the original WebSocket error. Automated tests cover the legal null-config response and diagnostic stages; actual HAOS catalog/restart/candidate verification remains separate until the published image is re-tested.

### Testing

- Add unit coverage for unavailable automation config, token/auth/DNS/protocol/timeout/command diagnostics, non-object frames, pending-request cleanup, remote-message and credential suppression, and rejection of environment endpoint redirection.
- Add an installed-image Supervisor-style WebSocket handshake/snapshot test using the actual pinned `ws` package, plus container checks for failed-refresh diagnosis, last-known-good preservation, and recovery.

## [0.3.0] - 2026-07-15

### Added

- Add a persistent, root-only SQLite/FTS5 Home Assistant memory store with a normalized index of areas, devices, entities, automations, and their registry/automation relationships.
- Add the non-blocking `ha-memoryd` S6 refresh service, the `ha-memory` administration CLI, and an optional image-managed `ha_memory` MCP server with bounded search and exact-subject tools.
- Add provenance-aware semantic memory candidates for aliases, purposes, preferences, relationships, and notes. Candidates must move through separate pending, verified, and applied states; repeated observations, explicit user evidence, fresh HA structure, and verified Codex changes have distinct verification rules.
- Add pre-change subject and expectation-digest records, fresh post-change Home Assistant API verification against the same contract, conflict tracking, bounded audit history, and dependency-safe compensating rollback for semantic-memory events.

### Security

- Store only allowlisted registry and automation metadata plus typed semantic values and structured provenance labels. Raw current/history state values, timestamps, automation actions/templates, conversations, API responses, and credentials are excluded from durable memory; state may be compared during fresh verification, but only expectation/predicate digests, checked field names, and match booleans are retained. A verified change can validate a relationship candidate only through the exact source/relation/target existence predicate.
- Protect `/data/codex-ha-memory` as root-only storage, reject unsafe links/ownership/schema, use atomic WAL transactions and integrity checks, preserve the last-known-good catalog on refresh failure, and cap every normal search by query length, result count, relationships, applied memories, conflicts, and serialized bytes.
- Keep Home Assistant structural facts under fresh Core API authority and explicit user explanations above observations or model inference. Conflicts remain visible instead of silently replacing equal/higher-authority memory.

### Upgrade notes

- The new memory database is created automatically and survives normal App replacement through `/data`. Unsafe memory links/files fail closed without being followed or blocking the main App init. Initial Core indexing runs in a separate retrying service, so an unavailable Core or memory database does not block Web UI, SSH, Codex, or browser startup.
- Existing user `config.toml` and `AGENTS.md` remain subject to `codex_user_files_update_mode`. The image-managed system config still supplies the optional memory MCP and its operating rules; start a new Codex session after updating to discover it.
- A retained `refresh_agents` or `refresh_all` selection runs once again for its selected targets at version `0.3.0`. Select `preserve` before updating if that reset is not wanted.

### Testing

- Add fixture-driven Node/SQLite lifecycle coverage for bootstrap, state/entity-registry automation union including disabled registry-only entries, normalized relationships, raw/transient byte exclusion, candidate verification/application, exact change-predicate binding, stronger-provenance deduplication, source precedence, conflicts, precommitted fresh change success/mismatch, bounded search, dependency-safe history/rollback, and concurrent atomic refresh failure.
- Add static packaging/S6/MCP/schema contracts and a container smoke covering unsafe and broken init/SQLite auxiliary links, root-only permissions, CLI and real MCP tool calls, active-automation detail failure, persistence across replacement, and raw sentinel exclusion.

## [0.2.4] - 2026-07-14

### Changed

- Publish a validation/evidence patch with no runtime feature or security-policy changes relative to public `0.2.3`.
- Record the user's successful Home Assistant Configuration UI/Supervisor normal update on public `0.2.3`.
- Record the user's successful authenticated `http://127.0.0.1:8099` dashboard verification on real HAOS with AppArmor enabled, covering desktop/mobile rendering, console, network/static resources, and the Core WebSocket path.

### Upgrade notes

- The existing per-target App-version behavior still applies even though this is an evidence-only patch. Installations that leave `codex_user_files_update_mode` set to `refresh_agents` or `refresh_all` will refresh the selected target once again when the App version changes to `0.2.4`.
- To avoid that reapplication, save `codex_user_files_update_mode: preserve` in the Home Assistant Configuration UI **before** updating to `0.2.4`.

### Testing

- Keep the public `0.2.3` HAOS user confirmation separate from the automated `0.2.4` candidate regression and release checks.
- Do not infer or publish an HAOS version, screenshots, or detailed execution logs that the user did not provide. Existing automated negative tests continue to cover token redaction, hostile environment handling, managed-auth lifecycle, and unsafe user-file targets; those checks are not claimed as part of the new HAOS user confirmation.

## [0.2.3] - 2026-07-14

### Added

- Add the `home_assistant_browser_auto_auth` App setting, enabled by default, to create or reuse the dedicated local-only `system-read-only` browser identity without a terminal setup step.
- Add `ha-browser-auth-ensure` so App initialization and each new Playwright MCP process converge on the configured managed or manual authentication source.
- Add `codex_user_files_update_mode` with `preserve` (default), `refresh_agents`, and `refresh_all` choices so Home Assistant Web UI updates can optionally reset the image-managed base guidance or both guidance and the current App-option-based default Codex configuration.
- Add root-only pre-refresh backups, crash-recovery metadata, and per-target App-version state for selected user-file updates.

### Changed

- Treat a missing automatic-auth option as enabled so existing installations gain the new default after a normal update; disabling it takes effect for the next App/MCP browser session and preserves the managed identity for later reactivation.
- Inject an image-managed Codex developer instruction and Playwright navigation-tool guidance that direct Home Assistant dashboard checks immediately to `http://127.0.0.1:8099/` instead of first searching for another browser skill or probing Core/external URLs.
- Keep the manual `home_assistant_browser_token` as an explicit override only while automatic authentication is enabled; OFF suppresses all automatic token injection.
- Treat a missing user-file update option as `preserve`, so a normal public `0.2.2` to `0.2.3` update changes no existing `config.toml` or `AGENTS.md`. Users may choose a refresh after the new Configuration field appears and restart the App.
- Apply each selected target at most once per App version. Keeping a refresh mode selected applies it once again on the next version; returning to `preserve` makes the selection one-off.
- Preserve `AGENTS.override.md` at its higher precedence and exclude Codex authentication/sessions, SSH and browser identities, App options, and the entire Home Assistant `/config` tree from user-file refreshes.

### Security

- Continue to validate the exact local-only/read-only user and single managed LLAT before browser injection; automatic provisioning does not add trusted networks, change authentication providers, edit `.storage`, or expose the Supervisor credential to Chromium.
- Do not delete the Home Assistant user or persistent recovery material when the setting is turned off. Complete identity deletion remains an explicit `ha-browser-auth-remove` operation.
- Require automatic authentication to be OFF before `ha-browser-auth-remove` can delete the identity, preventing the next automatic ensure from silently recreating what the user intended to remove permanently.
- Warn that `refresh_all` resets user MCP, model, provider, trust, endpoint, and other Codex settings; preserve the original bytes in `0700`/`0600` backup storage that must itself be treated as a credential.
- Preflight every selected target and fail closed without following symbolic links, overwriting multiply linked files, or mutating non-regular/unsafe paths. Commit replacements atomically only after all targets and backups verify.

### Testing

- Cover default-ON fresh/update behavior, automatic creation, restart reuse, OFF/ON preservation and reactivation, ON-state removal refusal, OFF-state removal, manual override suppression, and OFF-state setup refusal in the managed authentication smoke suite.
- Verify the 8099 route in model-visible `codex debug prompt-input` output and in the filtered Playwright `browser_navigate` tool description, alongside the existing desktop/mobile, console, network, update, and credential-redaction checks.
- Cover the default/missing preserve path, agents-only and all-target refreshes, per-version/per-target one-shot behavior, private byte-exact backups, restart idempotency, crash recovery, and unsafe symlink/hardlink/non-regular rejection without changing protected identities or `/config`.
- Keep the actual Home Assistant Configuration UI/Supervisor update and HAOS/AppArmor dashboard path explicitly **NOT RUN** until verified on a real installation.

## [0.2.2] - 2026-07-14

### Added

- Add `ha-browser-auth-setup` to create a dedicated active, local-only `system-read-only` Home Assistant browser user, complete the official local login flow, mint its long-lived token, and activate it without asking the user to copy a token.
- Add `ha-browser-auth-remove` for policy-checked identity cleanup and `ha-browser-auth-refresh` for automatic revalidation and reuse after App restart or update.

### Changed

- Prefer a validated manual `home_assistant_browser_token` when explicitly configured; otherwise reuse the App-managed credential stored privately under `/data/browser-auth`.
- Revalidate the managed identity, exact single-token invariant, and credential-free user at App initialization and before every Playwright MCP launch.
- Verify the internal Home Assistant HTTPS upstream against the image CA bundle and the `homeassistant` hostname; certificate, DNS, TLS, or Core outages now disable runtime auto-login without destroying recovery state.

### Security

- Use only official Home Assistant admin/user WebSocket commands and login/token/revoke HTTP endpoints; do not edit `configuration.yaml`, `.storage`, auth-provider order, `trusted_networks`, or `trusted_proxies`.
- Journal setup state and the managed LLAT in root-only `0700`/`0600` storage, remove the temporary password credential and OAuth refresh token automatically, and keep non-ready state unavailable to Chromium.
- Serialize setup/removal with a kernel `flock`, verify self-revocation by reconnecting, preserve ambiguous `local_only` rejections, and fail closed on policy, credential, ownership, TLS, or transport mismatches.

### Testing

- Add a Home Assistant 2026.7.1-compatible auth fixture covering setup, reuse, App replacement, token rotation, exact token cleanup, ambiguous source rejection, concurrent operations, Core/provider failures, policy mutation, removal, and rollback without logging credentials.
- Run managed-auth smoke in CI alongside the existing real Chromium desktop/mobile screenshot, console, network, Core REST/WebSocket, loopback isolation, SSH, ttyd, and persistence smoke suite.
- Verify update replacement from public `0.2.1` to the `0.2.2` candidate while preserving `/data`, `/config`, Codex credentials/configuration, App options, operating guidance, and SSH identity.

## [0.2.1] - 2026-07-14

### Added

- Add `ha-browser-network-info` to report the current App socket source, Home Assistant peer and Supervisor-reported App address without exposing credentials or changing Home Assistant configuration.
- Add a masked optional browser token setting, exact read-only/local-only user validation, and runtime authentication status diagnostics.
- Add supported WebSocket-based helpers for creating a dedicated `system-read-only` user and removing its temporary password credential after a long-lived token is configured.

### Changed

- Send frontend, authentication, REST and WebSocket traffic through the same direct Core upstream so the dedicated user's permissions apply to the whole dashboard session.
- Disable Home Assistant dashboard auto-login when the dedicated credential is absent, invalid, inactive, over-privileged, not local-only, or belongs to more than the read-only group.

### Security

- Do not add the dynamic App `/32`, the Docker App pool, or a synthetic forwarded address to `trusted_networks` or `trusted_proxies`; a released App address can be reassigned to another App after recreation.
- Keep the existing `homeassistant` authentication provider untouched, never edit `configuration.yaml` or `.storage`, and fail closed instead of falling back to the Supervisor/system credential.
- Exclude the Supervisor token from Codex MCP `env_vars`; use it only in the launcher to revalidate the dedicated user at App initialization and each MCP launch, then remove it before the Node proxy and browser child start.
- Reject inherited browser token, WebSocket endpoint, `BASH_ENV`, and `ENV` values; hard-code policy checks to the internal Supervisor Core WebSocket, inject only the revalidated dedicated-user token at the two loopback browser origins, and clear forwarded-client identity headers on the Core gateway.
- Do not enable Playwright `--secrets`, whose form-input substitution could disclose the browser token to a page; redact exact token text in the managed proxy instead and test the path with a reflection fixture.
- Start the system MCP through a clean `env -i` boundary, remove inherited `PLAYWRIGHT_MCP_*`, `NODE_OPTIONS` and `NODE_PATH` before validation, and give the Playwright child only a fixed environment allowlist.

### Testing

- Cross-check Docker's App address, the browser gateway socket source, Supervisor self report and the Chromium/Core fixture's observed peer, and reproduce reuse of a released container address by another container.
- Exercise direct Core REST/WebSocket authentication with a dedicated read-only token, reject broader user policies and inherited environment tokens, and capture the internal gateway itself at desktop/mobile sizes with console, network, loopback isolation and secret-redaction coverage.
- Verify a public `0.2.0` to candidate update preserves `/data`, `/config`, SSH identity and the masked browser token option.
- Keep live HAOS `8099` dashboard rendering explicitly unverified until the candidate is updated on the user's App and tested inside that container namespace.

## [0.2.0] - 2026-07-14

### Added

- Add an image-pinned Microsoft Playwright MCP runtime and headless Chromium so Codex can navigate, inspect, interact with, and capture real Web UIs without a runtime browser download.
- Register Playwright as an image-managed Codex system MCP with desktop/mobile viewport resizing, screenshots, DOM snapshots, console messages, and network/resource status tools.
- Add a loopback-only Home Assistant browser gateway at `http://127.0.0.1:8099/` that combines frontend assets with the supported Core REST and WebSocket proxy paths.

### Changed

- Extend the default Home Assistant operating guidance with a rendered UI validation loop and browser-specific safety boundaries.
- Keep browser sessions isolated, force generated files under `/run`, and cap managed browser output with a 50 MiB eviction limit.

### Security

- Preserve the existing `/data/codex/config.toml` and install the browser server in lower-precedence `/etc/codex/config.toml`, so a normal update neither overwrites user settings nor requires a new Codex login.
- Reuse the protected runtime environment to pass the Supervisor token to the MCP process, register a root-only ephemeral secrets file for exact-value redaction, and inject the token only for the loopback Home Assistant origin.
- Expose a browser tool allowlist that omits arbitrary page-code execution, unrestricted file access, file upload, persistent profiles, and externally listening browser ports.

### Testing

- Add policy coverage for the pinned MCP lockfile, system Codex configuration, browser tool allowlist, loopback gateway, ephemeral secret handling, and forbidden privilege regression.
- Add a real stdio MCP smoke flow covering desktop and mobile screenshots, console errors, successful and failed resource requests, and token redaction.
- Exercise the loopback Home Assistant gateway against mock Supervisor/Core services, including authenticated REST, frontend rendering, WebSocket upgrade, external reachability denial, and runtime-output cleanup.
- Replace the public `0.1.3` container with the candidate on the same named `/data` and `/config` volumes, preserving Codex settings, an authentication marker, operating guidance, Home Assistant configuration, and SSH identity while enabling the new MCP.
- Keep actual HAOS/AppArmor execution and authenticated live dashboard rendering as explicit post-update E2E checks rather than claiming them from a standalone Docker test.

## [0.1.3] - 2026-07-13

### Added

- Publish an amd64 image and preferred generic manifest at `ghcr.io/kanu-coffee/codex-for-home-assistant:0.1.3` with the official Home Assistant builder actions.
- Add a My Home Assistant one-click App repository button and clarify that Supervisor Apps are not a supported HACS repository type.

### Changed

- Promote the HAOS-validated `0.1.3-dev` payload to the first non-dev release while retaining `stage: experimental` and amd64-only support.
- Download the pre-built public GHCR image during install/update instead of building the Dockerfile on the Home Assistant host.
- Gate registry publishing on an exact numeric Git tag and refuse to overwrite an existing generic or per-architecture GHCR version tag.

### Security

- Publish with the repository-scoped GitHub Actions token and explicit `contents: read`, `packages: write`, and `id-token: write` permissions; no long-lived registry credential is stored.
- Keep the transition update-only and non-destructive: the runtime, options, `/data` format, Codex credentials, and SSH host keys are unchanged.

### Testing

- Confirm HAOS auto-start false/true, device-code login, restart credential persistence, SSH host identity persistence, and reversible Core notification create/dismiss calls.
- Require the public generic manifest to resolve anonymously as linux/amd64 and pass the full container smoke test before release completion.

## [0.1.3-dev] - 2026-07-13

### Added

- Add transparent Home Assistant `icon.png` and `logo.png` assets derived without distortion from the user-provided project mark, and display the logo in the public GitHub README.
- Extend the real ttyd WebSocket smoke test to prove terminal resize propagation and reattachment to the same tmux session, pane, and process within one running App container.
- Record the user-confirmed HAOS Web UI, authenticated Codex, update-path credential persistence, and mobile Remote-to-SSH project workflow.

### Fixed

- Negotiate `text/x-log` in `ha-core-logs` and `ha-addon-logs` instead of sending the JSON-only `Accept` header that failed against live Core and App log endpoints.

### Security

- Allowlist API helper response media types so the new `--accept` option cannot inject arbitrary HTTP headers.
- Keep this release update-only and non-destructive: no migration or reset touches persistent `/data` content.

### Testing

- Add regression coverage for default JSON negotiation, log media negotiation, malformed Accept values, wrapper arguments, and Home Assistant brand asset dimensions.
- Confirm on HAOS that direct `text/x-log` requests and both log helpers return rc 0 with nonempty responses and no negotiation error.
- Confirm functional Web UI reconnection, conversation recovery, resize, and no recurring `clear` error on HAOS; the local real WebSocket smoke separately proves identical tmux session, pane, and process IDs.

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
