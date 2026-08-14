import os
import shutil
import subprocess
from pathlib import Path

import pytest


FAKE_TOKEN = "token-boundary-fixture-do-not-use"


def _bash_path() -> str | None:
    if os.name == "nt":
        candidates = (
            Path(r"C:\Program Files\Git\bin\bash.exe"),
            Path(r"C:\Program Files\Git\usr\bin\bash.exe"),
        )
        return next((str(path) for path in candidates if path.exists()), None)
    return shutil.which("bash")


def _run_bash(script: str, *arguments: str, env: dict[str, str] | None = None):
    bash = _bash_path()
    if bash is None:
        pytest.skip("bash is required for token boundary tests")
    return subprocess.run(
        [bash, "-c", script, "token-boundary-test", *arguments],
        capture_output=True,
        text=True,
        check=False,
        env=env,
    )


def test_interactive_environment_discards_ambient_supervisor_token(
    rootfs: Path,
) -> None:
    environment_script = rootfs / "usr/local/lib/codex-ha/environment.sh"
    env = os.environ.copy()
    env["SUPERVISOR_TOKEN"] = FAKE_TOKEN
    env["HA_URL"] = "https://attacker.invalid/core"
    env["SUPERVISOR_URL"] = "https://attacker.invalid/supervisor"

    result = _run_bash(
        """
set -Eeuo pipefail
. "$1"
[[ -z "${SUPERVISOR_TOKEN:-}" ]]
[[ "${HA_URL}" == http://supervisor/core/api ]]
[[ "${SUPERVISOR_URL}" == http://supervisor ]]
""",
        str(environment_script),
        env=env,
    )

    assert result.returncode == 0, result.stderr
    assert FAKE_TOKEN not in result.stdout + result.stderr
    assert "runtime.env" not in environment_script.read_text(encoding="utf-8")


def test_supervisor_credential_loader_rejects_ambient_and_does_not_export(
    tmp_path: Path, rootfs: Path
) -> None:
    loader = rootfs / "usr/local/lib/codex-ha/supervisor-credential.sh"
    runtime_env = tmp_path / "runtime.env"
    runtime_env.write_text(
        f"export SUPERVISOR_TOKEN={FAKE_TOKEN}\n", encoding="utf-8"
    )
    runtime_env.chmod(0o600)
    env = os.environ.copy()
    env["SUPERVISOR_TOKEN"] = "ambient-token-must-be-replaced"

    result = _run_bash(
        """
set -Eeuo pipefail
. "$1"
codex_ha_load_supervisor_credential "$2"
[[ "${SUPERVISOR_TOKEN}" == "$3" ]]
if env | grep -q '^SUPERVISOR_TOKEN='; then
  exit 91
fi
""",
        str(loader),
        str(runtime_env),
        FAKE_TOKEN,
        env=env,
    )

    assert result.returncode == 0, result.stderr
    assert FAKE_TOKEN not in result.stdout + result.stderr


def test_supervisor_credential_loader_fails_closed_on_unsafe_file(
    tmp_path: Path, rootfs: Path
) -> None:
    loader = rootfs / "usr/local/lib/codex-ha/supervisor-credential.sh"
    runtime_env = tmp_path / "runtime.env"
    runtime_env.write_text(
        f"export SUPERVISOR_TOKEN={FAKE_TOKEN}\n", encoding="utf-8"
    )
    runtime_env.chmod(0o640)
    env = os.environ.copy()
    env["SUPERVISOR_TOKEN"] = "ambient-token-must-be-cleared"

    result = _run_bash(
        """
set -Eeuo pipefail
. "$1"
if codex_ha_load_supervisor_credential "$2"; then
  exit 92
else
  rc=$?
fi
[[ "${rc}" == 78 ]]
[[ -z "${SUPERVISOR_TOKEN:-}" ]]
""",
        str(loader),
        str(runtime_env),
        env=env,
    )

    assert result.returncode == 0, result.stderr
    assert FAKE_TOKEN not in result.stdout + result.stderr


def test_api_helpers_use_fixed_endpoints_and_private_credential_loading(
    rootfs: Path,
) -> None:
    expectations = {
        "ha-api": "readonly API_BASE_URL=http://supervisor/core/api",
        "supervisor-api": "readonly API_BASE_URL=http://supervisor",
    }
    for name, fixed_endpoint in expectations.items():
        wrapper = (rootfs / f"usr/local/bin/{name}").read_text(encoding="utf-8")
        assert wrapper.startswith("#!/bin/bash -p\n")
        assert "unset BASH_ENV ENV SUPERVISOR_TOKEN" in wrapper
        assert (
            "codex_ha_load_supervisor_credential /run/codex-ha/runtime.env"
            in wrapper
        )
        assert fixed_endpoint in wrapper
        assert "readonly API_CURL_BIN=/usr/bin/curl" in wrapper
        assert "readonly API_RUNTIME_DIR=/tmp" in wrapper
        assert "${HA_URL" not in wrapper
        assert "${SUPERVISOR_URL" not in wrapper

    client = (rootfs / "usr/local/lib/codex-ha/api-client.sh").read_text(
        encoding="utf-8"
    )
    assert '"${runtime_dir%/}/.codex-ha-api.XXXXXX"' in client
    assert 'printf \'Authorization: Bearer %s\\n\'' in client
    assert "--disable" in client
    assert "--noproxy '*'" in client


def test_browser_network_helper_loads_token_privately(rootfs: Path) -> None:
    helper = (rootfs / "usr/local/bin/ha-browser-network-info").read_text(
        encoding="utf-8"
    )
    assert helper.startswith("#!/bin/bash -p\n")
    assert "unset BASH_ENV ENV SUPERVISOR_TOKEN" in helper
    assert 'codex_ha_load_supervisor_credential "${RUNTIME_ENV}"' in helper
    assert '--header "@${supervisor_header}"' in helper
    assert '--header "Authorization: Bearer ${SUPERVISOR_TOKEN}"' not in helper
    assert "unset SUPERVISOR_TOKEN" in helper
    assert "mktemp /tmp/.codex-ha-browser-network-auth.XXXXXX" in helper
    assert helper.count("--disable") >= 2
    assert helper.count("--noproxy '*'") >= 2


def test_codex_and_interactive_services_scrub_supervisor_token(rootfs: Path) -> None:
    codex_wrapper = (rootfs / "usr/local/bin/codex").read_text(encoding="utf-8")
    assert codex_wrapper.index("unset SUPERVISOR_TOKEN") < codex_wrapper.index(
        "exec /usr/local/libexec/codex-real"
    )
    assert "--add-dir /data/codex-ha-memory" in codex_wrapper

    memory_wrapper = (rootfs / "usr/local/bin/ha-memory").read_text(
        encoding="utf-8"
    )
    assert memory_wrapper.startswith("#!/bin/bash -p\n")
    assert "unset BASH_ENV ENV NODE_OPTIONS NODE_PATH SUPERVISOR_TOKEN" in (
        memory_wrapper
    )
    assert "exec /usr/bin/env -i" in memory_wrapper
    assert (
        "codex_ha_load_supervisor_credential /run/codex-ha/runtime.env"
        in memory_wrapper
    )
    assert 'SUPERVISOR_TOKEN="${SUPERVISOR_TOKEN:-}"' in memory_wrapper
    assert "export -n SUPERVISOR_TOKEN" not in memory_wrapper
    assert "readonly TEST_MARKER=/run/codex-ha/allow-memory-test-fixture" in (
        memory_wrapper
    )
    assert '"$(id -u):600:1"' in memory_wrapper
    assert "caller-controlled test variables alone" in memory_wrapper

    memory_mcp_wrapper = (rootfs / "usr/local/bin/ha-memory-mcp").read_text(
        encoding="utf-8"
    )
    assert memory_mcp_wrapper.startswith("#!/bin/bash -p\n")
    assert "exec /usr/bin/env -i" in memory_mcp_wrapper
    assert (
        "codex_ha_load_supervisor_credential /run/codex-ha/runtime.env"
        in memory_mcp_wrapper
    )
    assert 'SUPERVISOR_TOKEN="${SUPERVISOR_TOKEN:-}"' in memory_mcp_wrapper
    assert "readonly TEST_MARKER=/run/codex-ha/allow-memory-test-fixture" in (
        memory_mcp_wrapper
    )

    s6_root = rootfs / "etc/s6-overlay/s6-rc.d"
    for service in ("ttyd", "sshd", "ingress", "ha-memoryd"):
        run_script = (s6_root / service / "run").read_text(encoding="utf-8")
        assert "unset SUPERVISOR_TOKEN" in run_script

    sshd_config = (rootfs / "etc/ssh/sshd_config").read_text(encoding="utf-8")
    permit_line = next(
        line for line in sshd_config.splitlines() if line.startswith("PermitUserEnvironment")
    )
    assert "SUPERVISOR_TOKEN" not in permit_line

    init_script = (rootfs / "usr/local/bin/codex-ha-init").read_text(
        encoding="utf-8"
    )
    assert (
        "readonly S6_SUPERVISOR_ENV=/run/s6/container_environment/SUPERVISOR_TOKEN"
        in init_script
    )
    runtime_copy_position = init_script.index(
        'mv -f "${runtime_tmp}" "${RUNTIME_DIR}/runtime.env"'
    )
    s6_clear_position = init_script.index('rm -f -- "${S6_SUPERVISOR_ENV}"')
    assert runtime_copy_position < s6_clear_position
    assert '[[ -e "${S6_SUPERVISOR_ENV}" || -L "${S6_SUPERVISOR_ENV}" ]]' in (
        init_script
    )
    assert "/usr/bin/curl --disable --fail --silent" in init_script
    assert "--noproxy '*'" in init_script
    assert '--header "@${core_info_header_tmp}"' in init_script
    assert '--header "Authorization: Bearer ${SUPERVISOR_TOKEN}"' not in (
        init_script
    )
    assert init_script.index("unset SUPERVISOR_TOKEN", s6_clear_position) < (
        init_script.index("ha_render_upstream_tmp=")
    )
    ssh_environment_block = init_script.split(
        "ssh_environment_tmp=", maxsplit=1
    )[1].split('mv -f "${ssh_environment_tmp}" /root/.ssh/environment', maxsplit=1)[0]
    assert "SUPERVISOR_TOKEN" not in ssh_environment_block
