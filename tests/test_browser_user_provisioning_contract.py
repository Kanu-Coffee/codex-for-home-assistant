import re
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
    assert '`${protocol}//homeassistant:${endpoint.port}/api/websocket`' in helper
    assert "import WebSocket from" in helper
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

    manual_create = helper.split("async function createUser", 1)[1].split(
        "async function readReadyStatus", 1
    )[0]
    manual_remove = helper.split("async function removePassword", 1)[1].split(
        "const supervisorToken", 1
    )[0]
    assert "process.stdin" in manual_create
    assert "process.argv" not in manual_create
    assert manual_remove.count(
        'browserSession.request("auth/current_user")'
    ) == 2
    assert 'operation === "create" && args.length === 2' in helper
    assert 'operation === "remove-password" && args.length === 1' in helper

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


def test_managed_browser_auth_commands_are_argument_free_and_refresh_runtime(
    rootfs: Path,
) -> None:
    bin_root = rootfs / "usr/local/bin"
    setup = (bin_root / "ha-browser-auth-setup").read_text(encoding="utf-8")
    remove = (bin_root / "ha-browser-auth-remove").read_text(encoding="utf-8")
    refresh = (bin_root / "ha-browser-auth-refresh").read_text(encoding="utf-8")

    for command, usage in (
        (setup, "Usage: ha-browser-auth-setup"),
        (remove, "Usage: ha-browser-auth-remove"),
    ):
        assert command.startswith("#!/usr/bin/env bash\nset -Eeuo pipefail\n")
        assert "umask 077" in command
        assert "if (( $# != 0 )); then" in command
        assert usage in command
        for hostile_variable in (
            "BASH_ENV",
            "ENV",
            "HA_BROWSER_EXPECTED_CLIENT_NAME",
            "HA_BROWSER_EXPECTED_DISPLAY_NAME",
            "HA_BROWSER_EXPECTED_USER_ID",
            "HA_BROWSER_TOKEN",
            "NODE_OPTIONS",
            "NODE_PATH",
        ):
            assert hostile_variable in command
        assert "set -x" not in command

    assert 'result=$(node "${HELPER}" auto-setup)' in setup
    assert "/usr/local/bin/ha-browser-auth-refresh --quiet" in setup
    assert "home_assistant_browser_token" in setup
    assert 'if [[ -n "${manual_token}" ]]; then' in setup
    assert "clear it before enabling managed authentication" in setup
    assert 'printf \'%s\' "${manual_token}"' not in setup
    assert 'echo "${manual_token}"' not in setup

    assert 'result=$(node "${HELPER}" auto-remove)' in remove
    assert "/usr/local/bin/ha-browser-auth-refresh --quiet || true" in remove
    assert 'node "${HELPER}" auto-setup ' not in setup
    assert 'node "${HELPER}" auto-remove ' not in remove

    assert refresh.startswith("#!/usr/bin/env bash\nset -Eeuo pipefail\n")
    assert "Usage: ha-browser-auth-refresh [--quiet]" in refresh
    assert "if (( $# == 1 )) && [[ $1 == --quiet ]]; then" in refresh
    for hostile_variable in (
        "BASH_ENV",
        "ENV",
        "HA_BROWSER_EXPECTED_CLIENT_NAME",
        "HA_BROWSER_EXPECTED_DISPLAY_NAME",
        "HA_BROWSER_EXPECTED_USER_ID",
        "HA_BROWSER_TOKEN",
        "NODE_OPTIONS",
        "NODE_PATH",
    ):
        assert hostile_variable in refresh
    assert "set -x" not in refresh


def test_managed_browser_auth_storage_is_private_and_atomic(rootfs: Path) -> None:
    helper = (
        rootfs / "usr/local/share/codex-ha/browser-user-admin.mjs"
    ).read_text(encoding="utf-8")

    assert 'const MANAGED_AUTH_DIRECTORY = "/data/browser-auth"' in helper
    assert (
        "const MANAGED_STATE_PATH = "
        "`${MANAGED_AUTH_DIRECTORY}/managed-user.json`"
    ) in helper
    assert (
        "const MANAGED_TOKEN_PATH = "
        "`${MANAGED_AUTH_DIRECTORY}/managed-token`"
    ) in helper

    ensure_directory = helper.split("async function ensureManagedDirectory", 1)[
        1
    ].split("async function writePrivateFile", 1)[0]
    assert "mkdir(MANAGED_AUTH_DIRECTORY, { mode: 0o700, recursive: true })" in (
        ensure_directory
    )
    assert "!stat.isDirectory()" in ensure_directory
    assert "stat.isSymbolicLink()" in ensure_directory
    assert "stat.uid !== process.getuid()" in ensure_directory
    assert "chmod(MANAGED_AUTH_DIRECTORY, 0o700)" in ensure_directory

    write_private = helper.split("async function writePrivateFile", 1)[1].split(
        "async function readPrivateFile", 1
    )[0]
    assert "`${MANAGED_AUTH_DIRECTORY}/.${randomUrlSafe(12)}.tmp`" in write_private
    for open_flag in (
        "fsConstants.O_CREAT",
        "fsConstants.O_EXCL",
        "fsConstants.O_WRONLY",
        "fsConstants.O_NOFOLLOW",
    ):
        assert open_flag in write_private
    assert "0o600" in write_private
    assert "await handle.sync()" in write_private
    assert "await rename(temporaryPath, path)" in write_private
    assert "await chmod(path, 0o600)" in write_private
    assert "await safeUnlink(temporaryPath)" in write_private

    cleanup_private = helper.split(
        "async function cleanupPrivateTemporaryFiles", 1
    )[1].split("async function writePrivateFile", 1)[0]
    assert "PRIVATE_TEMP_NAME_PATTERN.test(name)" in cleanup_private
    assert "!openedStat.isFile()" in cleanup_private
    assert "openedStat.nlink !== 1" in cleanup_private
    assert "openedStat.uid !== process.getuid()" in cleanup_private
    assert "(openedStat.mode & 0o777) !== 0o600" in cleanup_private
    assert "pathStat.dev !== openedStat.dev" in cleanup_private
    assert "pathStat.ino !== openedStat.ino" in cleanup_private
    assert "await unlink(path)" in cleanup_private
    assert "await syncManagedDirectory()" in cleanup_private

    read_private = helper.split("async function readPrivateFile", 1)[1].split(
        "function validOpaqueId", 1
    )[0]
    assert "fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW" in read_private
    assert "!stat.isFile()" in read_private
    assert "stat.nlink !== 1" in read_private
    assert "stat.uid !== process.getuid()" in read_private
    assert "await handle.chmod(0o600)" in read_private
    assert "await writePrivateFile(" in helper.split(
        "async function writeManagedState", 1
    )[1].split("function requestBuffer", 1)[0]
    assert "await writePrivateFile(MANAGED_TOKEN_PATH, managedToken)" in helper

    refresh = (rootfs / "usr/local/bin/ha-browser-auth-refresh").read_text(
        encoding="utf-8"
    )
    assert "cleanup_managed_temps" in refresh
    assert 'flock -n 8' in refresh
    assert '"${ADMIN_HELPER}" cleanup-temp' in refresh
    assert "managed_storage_unsafe" in refresh


def test_managed_browser_auth_uses_official_login_and_token_commands(
    rootfs: Path,
) -> None:
    helper = (
        rootfs / "usr/local/share/codex-ha/browser-user-admin.mjs"
    ).read_text(encoding="utf-8")

    assert 'jsonRequest(endpoint, "POST", "/auth/login_flow"' in helper
    assert "`/auth/login_flow/${encodeURIComponent(flow.flow_id)}`" in helper
    assert 'formRequest(endpoint, "/auth/token"' in helper
    assert 'grant_type: "authorization_code"' in helper
    assert 'postForm(endpoint, "/auth/revoke", { token: refreshToken })' in helper
    assert re.search(
        r'temporarySession\.request\(\s*"auth/long_lived_access_token"',
        helper,
    )
    assert "lifespan: LONG_LIVED_TOKEN_DAYS" in helper
    assert 'request("auth/refresh_tokens")' in helper
    assert 'request("auth/delete_refresh_token"' in helper
    assert 'type !== "long_lived_access_token"' in helper
    assert "client_name !== state.client_name" in helper
    setup_flow = helper.split("async function setupManagedBrowserAuth", 1)[1].split(
        "async function removeManagedBrowserAuth", 1
    )[0]
    persist_index = setup_flow.index(
        "await writePrivateFile(MANAGED_TOKEN_PATH, managedToken)"
    )
    token_cleanup_index = setup_flow.index(
        "await enforceSingleManagedToken(managedSession, state.client_name)",
        persist_index,
    )
    credential_delete_index = setup_flow.index(
        'session.request("config/auth_provider/homeassistant/delete"',
        token_cleanup_index,
    )
    assert persist_index < token_cleanup_index < credential_delete_index
    assert "temporaryTokenCleanupRequired = true" in setup_flow
    assert "temporaryTokenCleanupRequired = false" in setup_flow
    assert "managedTokenCreationAttempted = true" in setup_flow
    assert "managedTokenCleanupAuthorized = true" in setup_flow
    assert (
        "managedSession &&\n      managedTokenCleanupAuthorized &&"
        in setup_flow
    )
    assert (
        "managedTokenCreationAttempted && !managedSession && temporarySession"
        in setup_flow
    )
    assert "temporary_username: temporaryUsername" in setup_flow
    assert "temporaryTokenCleanupRequired ||" in setup_flow

    assert "const temporaryPassword = randomUrlSafe(32)" in helper
    assert "password: temporaryPassword" in helper
    assert 'operation === "auto-setup" && args.length === 0' in helper
    assert 'operation === "auto-remove" && args.length === 0' in helper
    assert "console." not in helper
    for secret_name in (
        "temporaryPassword",
        "temporaryRefreshToken",
        "managedToken",
        "supervisorToken",
    ):
        assert not re.search(
            rf"process\.(?:stdout|stderr)\.write\([^;]*{secret_name}",
            helper,
            re.DOTALL,
        )

    sanitized_result = helper.split("function sanitizedManagedResult", 1)[1].split(
        "async function createManagedUser", 1
    )[0]
    assert "password" not in sanitized_result.lower()
    assert "token" not in sanitized_result.lower()


def test_managed_browser_auth_policy_is_exact_and_fails_closed(rootfs: Path) -> None:
    helper = (
        rootfs / "usr/local/share/codex-ha/browser-user-admin.mjs"
    ).read_text(encoding="utf-8")
    policy = helper.split("function isExactReadOnlyBrowserUser", 1)[1].split(
        "function isExactManagedUser", 1
    )[0]

    for required_policy in (
        "user?.is_owner === false",
        "user?.is_active === true",
        "user?.local_only === true",
        "user?.system_generated === false",
        "user.group_ids.length === 1",
        "user.group_ids[0] === READ_ONLY_GROUP",
    ):
        assert required_policy in policy

    assert 'const READ_ONLY_GROUP = "system-read-only"' in helper
    assert "group_ids: [READ_ONLY_GROUP]" in helper
    assert "local_only: true" in helper
    assert "managed_user_policy_changed" in helper
    assert "automatic repair is disabled" in helper
    assert "automatic deletion is disabled" in helper
    assert "user.credentials.length !== 0" in helper
    assert "currentUser?.is_admin !== false" in helper
    assert "currentUser?.is_owner !== false" in helper
    setup = (rootfs / "usr/local/bin/ha-browser-auth-setup").read_text(
        encoding="utf-8"
    )
    remove = (rootfs / "usr/local/bin/ha-browser-auth-remove").read_text(
        encoding="utf-8"
    )
    for wrapper in (setup, remove):
        assert "MANAGED_LOCK=${MANAGED_AUTH_DIRECTORY}/operation.lock" in wrapper
        assert 'exec 9>> "${MANAGED_LOCK}"' in wrapper
        assert "flock -n 9" in wrapper
        assert 'chmod 0600 "${MANAGED_LOCK}"' in wrapper
        assert '-L "${MANAGED_LOCK}"' in wrapper
