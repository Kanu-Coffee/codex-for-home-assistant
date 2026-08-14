<p align="right">
  <a href="README.md">한국어</a> · <strong>English</strong>
</p>

# Codex for Home Assistant

Use Codex inside Home Assistant to inspect your setup and improve dashboards, automations, entities, and configuration errors through an Ingress Web terminal.

<p align="center">
  <img src="https://raw.githubusercontent.com/Kanu-Coffee/codex-for-home-assistant/main/docs/assets/web-terminal-preview.png" alt="Real Codex for Home Assistant Web terminal preview">
</p>

<p align="center"><em>Captured from the real public 0.5.0 Web terminal in isolated Docker. On HAOS, it appears inside Home Assistant Ingress.</em></p>

## Key features

- Codex CLI with read-write access to `/config` except root or nested `secrets.yaml` files and `.storage`
- Home Assistant Core API and Supervisor `manager` helpers
- Shared `tmux` Web terminal that resumes after you close and reopen the browser
- Public-key-only SSH for direct ChatGPT mobile Remote access to the bundled Codex environment
- **OPEN WEB UI** in the Home Assistant mobile app or website
- Headless Chromium checks for desktop/mobile dashboard layouts and console/network errors
- Project-local verified memory for HA structure and user-stated aliases, purposes, and preferences
- `$ha-feedback` for read-only app bug validation and structured feature proposals

> [!WARNING]
> This app is a powerful administrative tool that can change Home Assistant configuration and consume raw Core/Supervisor API responses. Unprotected `/config` paths, APIs, logs, and browser output may contain sensitive information. Back up important data and review the plan and diff before changes. Never expose the SSH port directly to the internet.

## Quick start

1. Install and start stable `0.7.0`. It supports `amd64` and 64-bit `aarch64`, with `stage: stable` and `boot: manual`. Native ARM CI and multi-architecture image validation passed. A real Raspberry Pi/aarch64 HAOS run was not performed; release approval explicitly accepted that gap based on the automated evidence.
2. Select **OPEN WEB UI**.
3. Sign in once with `ha-codex-login`.
4. Run `ha-codex`.
5. Start with: “Inspect my current setup in read-only mode and do not change anything yet.”

If you do not need SSH, leave `authorized_keys` empty. The Web UI will continue to work.

Custom AppArmor and `/etc/codex/requirements.toml` explicitly block direct access to every `secrets.yaml` and `/config/.storage` content. Codex therefore cannot read those contents through its normal direct filesystem paths, and those contents do not enter Codex through direct file access. Only validator-required `.storage` directory listing remains in the AppArmor profile, while managed requirements also deny Codex directory reads. Init and every Codex launch fail closed on symlinks, special files, or multiple hardlinks. The rest of `/config` remains read-write, and this is not complete DLP against a post-check external hardlink, values copied to unprotected paths, the root runtime credential, or raw API/log/browser responses.

## Example requests

```text
Check whether Bubble Card is already installed.
Preserve my current dashboard and design a one-column mobile home view.
Show me the plan and diff first, then apply and validate it only after I approve.
```

```text
Based on my weekday wake, departure, and arrival times and my current sensors,
suggest five useful automations with safeguards against false triggers.
Do not edit any files yet.
```

```text
$ha-feedback bug Validate an app symptom in read-only mode and prepare a public-safe report.
```

Direct GitHub submission requires an available candidate search, a ten-minute single-use preview, and separate confirmation. Search or submission uncertainty never triggers an automatic retry; use the Issue Form fallback instead.

See the [English user guide](DOCS.en.md) for installation, all settings, mobile Remote, updates, security, and troubleshooting. [한국어 사용 설명서](DOCS.md) is also available.

This is an unofficial community project. It is not affiliated with or endorsed by OpenAI, Home Assistant, or Nabu Casa.
