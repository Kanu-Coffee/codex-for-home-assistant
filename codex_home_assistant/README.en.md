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

- Codex CLI with read-write access to all of `/config`
- Home Assistant Core API and Supervisor `manager` helpers
- Shared `tmux` Web terminal that resumes after you close and reopen the browser
- Public-key-only SSH and desktop Codex SSH projects
- **OPEN WEB UI** in the Home Assistant mobile app or website
- Headless Chromium checks for desktop/mobile dashboard layouts and console/network errors
- Project-local verified memory for HA structure and user-stated aliases, purposes, and preferences

> [!WARNING]
> This app is a powerful administrative tool that can directly change your Home Assistant configuration. Back up important data and review the plan and diff before changes. Never expose the SSH port directly to the internet.

## Quick start

1. Install and start the app. It is currently **amd64-only**, `stage: experimental`, and `boot: manual`.
2. Select **OPEN WEB UI**.
3. Sign in once with `ha-codex-login`.
4. Run `ha-codex`.
5. Start with: “Inspect my current setup in read-only mode and do not change anything yet.”

If you do not need SSH, leave `authorized_keys` empty. The Web UI will continue to work.

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

See the [English user guide](DOCS.en.md) for installation, all settings, mobile Remote, updates, security, and troubleshooting. [한국어 사용 설명서](DOCS.md) is also available.

This is an unofficial community project. It is not affiliated with or endorsed by OpenAI, Home Assistant, or Nabu Casa.
