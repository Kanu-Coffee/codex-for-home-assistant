import os
import re
import stat
from pathlib import Path


S6_ROOT = Path("etc/s6-overlay/s6-rc.d")
S6_SERVICES = (
    "codex-ha-init",
    "codex-updater",
    "ha-memoryd",
    "ttyd",
    "ingress",
    "sshd",
)
EXECUTABLE_ROOTFS_PATHS = (
    "etc/s6-overlay/s6-rc.d/codex-ha-init/run",
    "etc/s6-overlay/s6-rc.d/codex-updater/run",
    "etc/s6-overlay/s6-rc.d/ha-memoryd/run",
    "etc/s6-overlay/s6-rc.d/ingress/finish",
    "etc/s6-overlay/s6-rc.d/ingress/run",
    "etc/s6-overlay/s6-rc.d/sshd/finish",
    "etc/s6-overlay/s6-rc.d/sshd/run",
    "etc/s6-overlay/s6-rc.d/ttyd/finish",
    "etc/s6-overlay/s6-rc.d/ttyd/run",
)


def test_s6_user_bundle_and_dependency_graph(rootfs: Path) -> None:
    s6_root = rootfs / S6_ROOT
    contents = s6_root / "user/contents.d"
    assert {path.name for path in contents.iterdir()} == set(S6_SERVICES)

    assert (s6_root / "codex-ha-init/type").read_text().strip() == "oneshot"
    assert (s6_root / "codex-ha-init/up").is_file()
    assert (s6_root / "codex-ha-init/dependencies.d/base").is_file()

    for service in ("codex-updater", "ha-memoryd", "ttyd", "ingress", "sshd"):
        assert (s6_root / service / "type").read_text().strip() == "longrun"

    assert (s6_root / "codex-updater/dependencies.d/codex-ha-init").is_file()
    assert (s6_root / "ha-memoryd/dependencies.d/codex-ha-init").is_file()
    assert (s6_root / "ttyd/dependencies.d/codex-ha-init").is_file()
    assert (s6_root / "sshd/dependencies.d/codex-ha-init").is_file()
    assert (s6_root / "ingress/dependencies.d/ttyd").is_file()


def test_s6_entrypoints_have_container_executable_policy(
    addon_root: Path, rootfs: Path
) -> None:
    dockerfile = (addon_root / "Dockerfile").read_text(encoding="utf-8")
    for relative_path in EXECUTABLE_ROOTFS_PATHS:
        script = rootfs / relative_path
        assert script.read_text(encoding="utf-8").startswith(
            "#!/command/with-contenv bashio\n"
        )
        assert f"/{relative_path}" in dockerfile
        if os.name != "nt":
            assert script.stat().st_mode & stat.S_IXUSR


def test_codex_release_is_pinned_and_checksum_verified(addon_root: Path) -> None:
    dockerfile = (addon_root / "Dockerfile").read_text(encoding="utf-8")
    version_match = re.search(r"^ARG CODEX_VERSION=([^\s]+)$", dockerfile, re.MULTILINE)
    checksum_matches = dict(
        re.findall(
            r"^ARG CODEX_SHA256_(AMD64|AARCH64)=([0-9a-f]{64})$",
            dockerfile,
            re.MULTILINE,
        )
    )

    assert version_match
    assert version_match.group(1) == "0.162.1"
    assert checksum_matches == {
        "AMD64": "a676f5722aae0d86cbe3764332f08eab1fdd89dc0a300b3ad4ffbf48611fa3e3",
        "AARCH64": "53a9ce0b94beb27a63fdeb2f7704d95199e17b3898aa33b60461a1a93ac0d88b",
    }
    assert "rust-v${CODEX_VERSION}" in dockerfile
    assert "sha256sum --check --strict" in dockerfile
    assert 'codex_version_output="$(/usr/local/libexec/codex-real --version)"' in dockerfile
    assert (addon_root / "rootfs/usr/local/bin/codex").is_file()


def test_sshd_is_public_key_only(rootfs: Path) -> None:
    sshd_config = (rootfs / "etc/ssh/sshd_config").read_text(encoding="utf-8")
    required_lines = (
        "PubkeyAuthentication yes",
        "AuthenticationMethods publickey",
        "PasswordAuthentication no",
        "KbdInteractiveAuthentication no",
        "PermitEmptyPasswords no",
        "PermitRootLogin prohibit-password",
        "AuthorizedKeysFile /data/ssh/authorized_keys",
    )
    for line in required_lines:
        assert line in sshd_config


def test_ttyd_and_nginx_are_split_for_ingress(rootfs: Path) -> None:
    ttyd_run = (rootfs / S6_ROOT / "ttyd/run").read_text(encoding="utf-8")
    ingress_run = (rootfs / S6_ROOT / "ingress/run").read_text(encoding="utf-8")
    nginx_config = (rootfs / "etc/nginx/nginx.conf").read_text(encoding="utf-8")

    assert "--interface 127.0.0.1" in ttyd_run
    assert "--port 7682" in ttyd_run
    assert "--writable" in ttyd_run
    assert "exec nginx" in ingress_run
    assert "listen 7681" in nginx_config
    assert "proxy_pass http://127.0.0.1:7682" in nginx_config
    assert "proxy_set_header Upgrade $http_upgrade" in nginx_config


def test_ingress_access_log_excludes_private_request_context(rootfs: Path) -> None:
    nginx_config = (rootfs / "etc/nginx/nginx.conf").read_text(encoding="utf-8")
    match = re.search(
        r"log_format ingress_minimal\s+'([^']+)';",
        nginx_config,
    )

    assert match
    log_format = match.group(1)
    assert "$request_method $uri $server_protocol" in log_format
    assert "$status" in log_format
    assert "$body_bytes_sent" in log_format
    for forbidden in (
        "$remote_addr",
        "$request_uri",
        "$args",
        "$query_string",
        "$http_referer",
        "$http_user_agent",
    ):
        assert forbidden not in log_format
    assert "access_log /dev/stdout ingress_minimal;" in nginx_config
    assert "error_log /dev/stderr crit;" in nginx_config
    assert "error_log /dev/stderr notice;" not in nginx_config
    assert "listen 127.0.0.1:8099;\n    server_name localhost;\n    access_log off;" in (
        nginx_config
    )


def test_init_has_idempotent_and_degraded_mode_guards(rootfs: Path) -> None:
    init_script = (rootfs / "usr/local/bin/codex-ha-init").read_text(
        encoding="utf-8"
    )
    sshd_run = (rootfs / S6_ROOT / "sshd/run").read_text(encoding="utf-8")

    assert "/usr/local/bin/codex-user-files-update" in init_script
    assert "user_files_update_status == 30" in init_script
    assert "existing files were preserved" in init_script
    assert 'if [[ ! -e "${CODEX_DATA}/config.toml" ]]' not in init_script
    assert 'install -m 0644 "${DEFAULT_AGENTS}" "${agents_tmp}"' not in init_script
    assert 'if [[ ! -s "${host_key}" ]]' in init_script
    assert 'rm -f "${host_key}" "${host_key}.pub"' in init_script
    assert 'ssh-keygen -y -f "${host_key}"' in init_script
    assert 'chmod 0600 "${SSH_DATA}/authorized_keys"' not in init_script
    assert 'mv -f "${authorized_keys_tmp}" "${SSH_DATA}/authorized_keys"' in init_script
    assert '"${RUNTIME_DIR}/ssh-disabled"' in init_script
    assert "exec /command/s6-pause" in sshd_run


def test_default_codex_guidance_has_home_assistant_safety_rules(rootfs: Path) -> None:
    guidance = (
        rootfs / "usr/local/share/codex-ha/AGENTS.md"
    ).read_text(encoding="utf-8")
    normalized_guidance = " ".join(guidance.lower().split())

    assert "live Home Assistant App" in guidance
    assert "A diagnostic finding alone does not authorize" in guidance
    assert "defense-in-depth guidance, not an enforcement boundary" in guidance
    assert "Run `ha-config-check`" in guidance
    assert "SUPERVISOR_TOKEN" in guidance
    assert "Never describe an unverified" in guidance
    assert "http://127.0.0.1:8099/" in guidance
    assert "do not first search for, invoke, or install another browser skill" in (
        normalized_guidance
    )
    assert "home_assistant_browser_auto_auth" in guidance


def test_boolean_option_reader_accepts_an_explicit_false(rootfs: Path) -> None:
    config_helpers = (
        rootfs / "usr/local/lib/codex-ha/config.sh"
    ).read_text(encoding="utf-8")
    bool_reader = config_helpers.split("codex_ha_config_bool()", maxsplit=1)[1]
    bool_reader = bool_reader.split("codex_ha_config_json()", maxsplit=1)[0]

    assert "jq --raw-output" in bool_reader
    assert "--exit-status" not in bool_reader


def test_web_terminal_uses_tmux_and_returns_to_shell(rootfs: Path) -> None:
    entrypoint = (rootfs / "usr/local/bin/web-terminal-entrypoint").read_text(
        encoding="utf-8"
    )
    session_shell = (rootfs / "usr/local/bin/tmux-session-shell").read_text(
        encoding="utf-8"
    )

    assert "export TERM=xterm-256color" in entrypoint
    assert 'new-session -A -s "${session_name}" -c /config' in entrypoint
    assert session_shell.startswith("#!/usr/bin/env bash\n")
    assert "codex_ha_config_true" in session_shell
    assert "web_terminal_auto_start_codex" in session_shell
    assert "if ha-codex; then" in session_shell
    assert "exec /bin/bash -l" in session_shell


APPARMOR_EXEC_TRANSITION_CHARS = frozenset("xpicuUCU")
S6_INTERPRETER_AND_SERVICE_BINARIES = (
    "/command/with-contenv",
    "/usr/bin/node",
    "/usr/bin/ttyd",
    "/usr/sbin/nginx",
    "/usr/sbin/sshd",
    "/usr/local/bin/codex-ha-init",
    "/run/s6/basedir/bin/halt",
    "/command/s6-pause",
)
APPARMOR_UNLISTED_PATHS_WITHOUT_EXEC = (
    "/etc/s6-overlay.d/evil/run",
    "/opt/s6-rc.d/service/run",
    "/var/tmp/s6-overlay-helper/run",
)


def _expand_apparmor_braces(pattern: str) -> tuple[str, ...]:
    match = re.search(r"\{([^{}]*)\}", pattern)
    if match is None:
        return (pattern,)
    expanded: list[str] = []
    for alternative in match.group(1).split(","):
        expanded.extend(
            _expand_apparmor_braces(
                pattern[: match.start()] + alternative + pattern[match.end() :]
            )
        )
    return tuple(expanded)


def _apparmor_pattern_matches(pattern: str, path: str) -> bool:
    for expanded in _expand_apparmor_braces(pattern):
        regex = re.escape(expanded)
        regex = regex.replace(r"\*\*", "\x00")
        regex = regex.replace(r"\*", "[^/]*")
        regex = regex.replace(r"\?", "[^/]")
        regex = regex.replace("\x00", ".*")
        regex = regex.replace(r"\[", "[").replace(r"\^", "^").replace(r"\]", "]")
        if re.fullmatch(regex, path):
            return True
    return False


def _parent_profile_rules(apparmor_text: str) -> list[tuple[bool, str, set[str]]]:
    parent = apparmor_text[: apparmor_text.index("profile codex_bwrap")]
    rules: list[tuple[bool, str, set[str]]] = []
    for line in parent.splitlines():
        match = re.match(r"\s*(deny\s+)?(/[^\s]+)\s+([A-Za-z ]+),", line)
        if match is None:
            continue
        permission_token = match.group(3).split("->")[0].strip()
        rules.append((bool(match.group(1)), match.group(2), set(permission_token)))
    assert rules
    return rules


def _apparmor_effective_perms(apparmor_text: str, path: str) -> set[str]:
    allowed: set[str] = set()
    denied: set[str] = set()
    for is_deny, pattern, chars in _parent_profile_rules(apparmor_text):
        if _apparmor_pattern_matches(pattern, path):
            (denied if is_deny else allowed).update(chars)
    return allowed - denied


def _apparmor_allows_exec(apparmor_text: str, path: str) -> bool:
    return bool(
        _apparmor_effective_perms(apparmor_text, path) & APPARMOR_EXEC_TRANSITION_CHARS
    )


def test_apparmor_profile_grants_exec_to_s6_service_scripts(addon_root: Path) -> None:
    apparmor_text = (addon_root / "apparmor.txt").read_text(encoding="utf-8")

    for relative_path in EXECUTABLE_ROOTFS_PATHS:
        assert _apparmor_allows_exec(apparmor_text, f"/{relative_path}"), relative_path


def test_apparmor_profile_grants_exec_to_s6_interpreter_and_services(
    addon_root: Path,
) -> None:
    apparmor_text = (addon_root / "apparmor.txt").read_text(encoding="utf-8")

    for path in S6_INTERPRETER_AND_SERVICE_BINARIES:
        assert _apparmor_allows_exec(apparmor_text, path), path


def test_apparmor_s6_exec_allowance_stays_scoped_outside_s6_tree(
    addon_root: Path,
) -> None:
    apparmor_text = (addon_root / "apparmor.txt").read_text(encoding="utf-8")

    for path in APPARMOR_UNLISTED_PATHS_WITHOUT_EXEC:
        assert not _apparmor_allows_exec(apparmor_text, path), path
    for secret_path in ("/config/secrets.yaml", "/config/backup/secrets.yaml"):
        assert "r" not in _apparmor_effective_perms(apparmor_text, secret_path)
