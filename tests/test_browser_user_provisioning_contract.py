from pathlib import Path


def test_browser_user_create_reads_password_without_process_arguments(
    rootfs: Path,
) -> None:
    wrapper = (rootfs / "usr/local/bin/ha-browser-user-create").read_text(
        encoding="utf-8"
    )

    assert wrapper.startswith("#!/usr/bin/env bash\nset -Eeuo pipefail\n")
    assert "Usage: ha-browser-user-create <display-name> <username>" in wrapper
    assert wrapper.count("read -r -s") == 2
    assert "< /dev/tty" in wrapper
    assert "HA_BROWSER_USER_PASSWORD_STDIN" in wrapper
    assert "printf '%s' \"${password}\" | node" in wrapper
    assert 'node "${HELPER}" create "$1" "$2"' in wrapper
    assert "SUPERVISOR_TOKEN=" not in wrapper
    assert "home_assistant_browser_token" in wrapper
    assert "ha-browser-user-remove-password" in wrapper


def test_browser_user_helper_uses_supported_read_only_auth_commands(
    rootfs: Path,
) -> None:
    helper = (
        rootfs / "usr/local/share/codex-ha/browser-user-admin.mjs"
    ).read_text(encoding="utf-8")

    assert '"ws://supervisor/core/websocket"' in helper
    assert 'session.request("config/auth/create"' in helper
    assert "group_ids: [READ_ONLY_GROUP]" in helper
    assert "local_only: true" in helper
    assert 'session.request("config/auth_provider/homeassistant/create"' in helper
    assert 'session.request("config/auth/delete", { user_id: user.id })' in helper
    assert 'session.request("config/auth_provider/homeassistant/delete"' in helper
    assert 'session.request("config/auth/list")' in helper
    assert '"/run/codex-ha/browser-auth-status.json"' in helper
    assert '"/run/codex-ha/home-assistant-browser.token"' in helper
    assert 'status?.status !== "ready"' in helper
    assert "status?.user?.id !== expectedUserId" in helper
    assert "user?.is_owner === false" in helper
    assert 'user.group_ids[0] === READ_ONLY_GROUP' in helper
    assert 'credential?.type === "homeassistant"' in helper
    assert helper.count('browserSession.request("auth/current_user")') == 2

    assert "configuration.yaml" not in helper
    assert ".storage" not in helper
    assert "auth_providers" not in helper
    assert "trusted_networks" not in helper
    assert "trusted_proxies" not in helper
    assert "process.argv" not in helper.split("const password =", 1)[1].split(
        "const result =", 1
    )[0]


def test_password_removal_requires_ready_status_and_explicit_user_id(
    rootfs: Path,
) -> None:
    wrapper = (
        rootfs / "usr/local/bin/ha-browser-user-remove-password"
    ).read_text(encoding="utf-8")

    assert wrapper.startswith("#!/usr/bin/env bash\nset -Eeuo pipefail\n")
    assert "Usage: ha-browser-user-remove-password <user-id>" in wrapper
    assert 'node "${HELPER}" remove-password "$1"' in wrapper
    assert "ha-browser-auth-status" in wrapper
    assert "SUPERVISOR_TOKEN=" not in wrapper
    assert "HA_BROWSER_TOKEN=" not in wrapper
