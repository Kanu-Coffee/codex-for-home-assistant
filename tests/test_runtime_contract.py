import os
import re
import stat
from pathlib import Path


S6_ROOT = Path("etc/s6-overlay/s6-rc.d")
S6_SERVICES = ("codex-ha-init", "ttyd", "ingress", "sshd")
EXECUTABLE_ROOTFS_PATHS = (
    "etc/s6-overlay/s6-rc.d/codex-ha-init/run",
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

    for service in ("ttyd", "ingress", "sshd"):
        assert (s6_root / service / "type").read_text().strip() == "longrun"

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
    checksum_match = re.search(
        r"^ARG CODEX_SHA256=([0-9a-f]{64})$", dockerfile, re.MULTILINE
    )

    assert version_match
    assert version_match.group(1) == "0.144.1"
    assert checksum_match
    assert (
        checksum_match.group(1)
        == "84091ae20c65fcc7d4120db97d1bd57d7ff8df9c7609fb781c78c2ebbd4f5a28"
    )
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


def test_init_has_idempotent_and_degraded_mode_guards(rootfs: Path) -> None:
    init_script = (rootfs / "usr/local/bin/codex-ha-init").read_text(
        encoding="utf-8"
    )
    sshd_run = (rootfs / S6_ROOT / "sshd/run").read_text(encoding="utf-8")

    assert 'if [[ ! -e "${CODEX_DATA}/config.toml" ]]' in init_script
    assert 'if [[ ! -s "${host_key}" ]]' in init_script
    assert 'rm -f "${host_key}" "${host_key}.pub"' in init_script
    assert 'ssh-keygen -y -f "${host_key}"' in init_script
    assert 'chmod 0600 "${SSH_DATA}/authorized_keys"' not in init_script
    assert 'mv -f "${authorized_keys_tmp}" "${SSH_DATA}/authorized_keys"' in init_script
    assert '"${RUNTIME_DIR}/ssh-disabled"' in init_script
    assert "exec /command/s6-pause" in sshd_run


def test_web_terminal_uses_tmux_and_returns_to_shell(rootfs: Path) -> None:
    entrypoint = (rootfs / "usr/local/bin/web-terminal-entrypoint").read_text(
        encoding="utf-8"
    )
    session_shell = (rootfs / "usr/local/bin/tmux-session-shell").read_text(
        encoding="utf-8"
    )

    assert 'new-session -A -s "${session_name}" -c /config' in entrypoint
    assert "codex_ha_config_true" in session_shell
    assert "web_terminal_auto_start_codex" in session_shell
    assert "if ha-codex; then" in session_shell
    assert "exec /bin/bash -l" in session_shell
