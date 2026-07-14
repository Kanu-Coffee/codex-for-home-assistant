import json
import re
import tomllib
from pathlib import Path


REQUIRED_BROWSER_TOOLS = {
    "browser_close",
    "browser_console_messages",
    "browser_navigate",
    "browser_network_requests",
    "browser_resize",
    "browser_snapshot",
    "browser_take_screenshot",
}

DANGEROUS_BROWSER_TOOLS = {
    "browser_evaluate",
    "browser_file_upload",
    "browser_install",
    "browser_network_request",
    "browser_pdf_save",
    "browser_run_code",
    "browser_run_code_unsafe",
}


def test_playwright_dependency_is_locked_and_built_into_image(
    addon_root: Path,
) -> None:
    playwright_root = addon_root / "playwright"
    package = json.loads((playwright_root / "package.json").read_text(encoding="utf-8"))
    lock = json.loads(
        (playwright_root / "package-lock.json").read_text(encoding="utf-8")
    )
    dockerfile = (addon_root / "Dockerfile").read_text(encoding="utf-8")

    expected_version = package["dependencies"]["@playwright/mcp"]
    assert re.fullmatch(r"\d+\.\d+\.\d+", expected_version)
    assert lock["packages"][""]["dependencies"]["@playwright/mcp"] == expected_version
    assert (
        lock["packages"]["node_modules/@playwright/mcp"]["version"]
        == expected_version
    )
    assert re.search(
        rf"^ARG PLAYWRIGHT_MCP_VERSION={re.escape(expected_version)}$",
        dockerfile,
        re.MULTILINE,
    )

    assert "chromium-headless-shell" in dockerfile
    assert "nodejs" in dockerfile
    assert "font-noto-cjk" in dockerfile
    assert "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1" in dockerfile
    assert "npm ci --prefix /usr/local/lib/codex-ha/playwright" in dockerfile
    for npm_flag in ["--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"]:
        assert npm_flag in dockerfile
    assert "chromium-headless-shell --version" in dockerfile
    assert "npx " not in dockerfile


def test_codex_system_config_registers_restricted_playwright_mcp(
    rootfs: Path,
) -> None:
    config_path = rootfs / "etc/codex/config.toml"
    with config_path.open("rb") as stream:
        config = tomllib.load(stream)

    playwright = config["mcp_servers"]["playwright"]
    assert playwright["command"] == "/usr/bin/env"
    assert playwright["args"] == [
        "-i",
        "HOME=/run/codex-ha/playwright-home",
        "LANG=C.UTF-8",
        "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "/usr/local/bin/ha-playwright-mcp",
    ]
    assert playwright["cwd"] == "/config"
    assert playwright["env_vars"] == []
    assert playwright["enabled"] is True
    assert playwright["required"] is False
    assert playwright["startup_timeout_sec"] == 30
    assert playwright["tool_timeout_sec"] == 120
    assert playwright["default_tools_approval_mode"] == "writes"

    enabled_tools = set(playwright["enabled_tools"])
    assert REQUIRED_BROWSER_TOOLS <= enabled_tools
    assert DANGEROUS_BROWSER_TOOLS.isdisjoint(enabled_tools)

    proxy = (
        rootfs / "usr/local/share/codex-ha/playwright-mcp-proxy.mjs"
    ).read_text(encoding="utf-8")
    allowlist_match = re.search(
        r"const ALLOWED_TOOLS = new Set\(\[(.*?)\]\);", proxy, re.DOTALL
    )
    assert allowlist_match
    proxy_tools = set(re.findall(r'"(browser_[a-z_]+)"', allowlist_match.group(1)))
    assert enabled_tools == proxy_tools


def test_playwright_wrapper_uses_only_the_image_managed_stdio_server(
    rootfs: Path,
) -> None:
    wrapper = (rootfs / "usr/local/bin/ha-playwright-mcp").read_text(
        encoding="utf-8"
    )

    assert wrapper.startswith("#!/usr/bin/env bash\n")
    assert "set -Eeuo pipefail" in wrapper
    assert "umask 077" in wrapper
    assert 'readonly PLAYWRIGHT_HOME=/run/codex-ha/playwright-home' in wrapper
    assert '"${RUNTIME_DIR}/playwright-output" "${PLAYWRIGHT_HOME}"' in wrapper
    assert 'readonly PLAYWRIGHT_PROXY=' in wrapper
    assert 'if (( $# != 0 )); then' in wrapper
    assert 'exec "${NODE_BINARY}" "${PLAYWRIGHT_PROXY}"' in wrapper
    assert 'readonly NODE_BINARY=/usr/bin/node' in wrapper
    assert "NODE_OPTIONS" in wrapper
    assert "NODE_PATH" in wrapper
    assert 'for variable in "${!PLAYWRIGHT_MCP_@}"' in wrapper
    assert "CODEX_HA_BROWSER_TOKEN_VALIDATED=1" in wrapper
    assert '"${NODE_BINARY}" "${BROWSER_AUTH_CHECK}"' in wrapper
    assert '"$@"' not in wrapper
    assert "npx" not in wrapper
    assert "npm" not in wrapper
    assert "--port" not in wrapper

    proxy = (
        rootfs / "usr/local/share/codex-ha/playwright-mcp-proxy.mjs"
    ).read_text(encoding="utf-8")
    assert '"--config", PLAYWRIGHT_CONFIG' in proxy
    assert '"--secrets"' not in proxy
    assert "PLAYWRIGHT_SECRETS" not in proxy
    assert 'readFileSync(HOME_ASSISTANT_BROWSER_TOKEN, "utf8")' in proxy
    assert "childEnvironment.HA_BROWSER_TOKEN = token" in proxy
    assert "const childEnvironment = {" in proxy
    assert "...process.env" not in proxy
    assert "PLAYWRIGHT_MCP_" not in proxy
    assert "NODE_OPTIONS" not in proxy
    assert "NODE_PATH" not in proxy
    assert 'process.env.CODEX_HA_BROWSER_TOKEN_VALIDATED === "1"' in proxy
    assert "function redactExactSecret(value)" in proxy
    assert "writeJson(process.stdout, message, true)" in proxy
    assert 'createInterface({ input: child.stderr, crlfDelay: Infinity })' in proxy
    assert 'Object.prototype.hasOwnProperty.call(toolArgs, "filename")' in proxy
    assert "ALLOWED_TOOLS.has(toolName)" in proxy
    assert "message.result.tools.filter" in proxy


def test_playwright_runtime_is_headless_isolated_and_ephemeral(
    rootfs: Path,
) -> None:
    config = json.loads(
        (rootfs / "usr/local/share/codex-ha/playwright-mcp.json").read_text(
            encoding="utf-8"
        )
    )

    browser = config["browser"]
    launch = browser["launchOptions"]
    context = browser["contextOptions"]
    assert browser["browserName"] == "chromium"
    assert browser["isolated"] is True
    assert "userDataDir" not in browser
    assert launch["headless"] is True
    assert launch["executablePath"] == "/usr/bin/chromium-headless-shell"
    assert launch["chromiumSandbox"] is False
    assert {"--disable-dev-shm-usage", "--no-sandbox"} <= set(launch["args"])
    assert context["viewport"] == {"width": 1440, "height": 900}
    assert context["locale"] == "ko-KR"

    assert set(config["capabilities"]) == {"core", "network"}
    assert config["outputDir"] == "/run/codex-ha/playwright-output"
    assert config["outputMaxSize"] == 50 * 1024 * 1024
    assert config["outputMode"] == "stdout"
    assert config["saveSession"] is False
    assert config["sharedBrowserContext"] is False
    assert config["imageResponses"] == "allow"
    assert config["allowUnrestrictedFileAccess"] is False
    assert config["codegen"] == "none"
    assert config["browser"]["initPage"] == [
        "/usr/local/share/codex-ha/playwright-init-page.ts"
    ]


def test_home_assistant_browser_auth_is_limited_to_loopback_gateway(
    rootfs: Path,
) -> None:
    init_page = (
        rootfs / "usr/local/share/codex-ha/playwright-init-page.ts"
    ).read_text(encoding="utf-8")
    nginx = (rootfs / "etc/nginx/nginx.conf").read_text(encoding="utf-8")

    assert 'process.env.HA_BROWSER_TOKEN' in init_page
    assert "SUPERVISOR_TOKEN" not in init_page
    assert 'window.location.origin !== "http://127.0.0.1:8099"' in init_page
    assert 'window.location.origin !== "http://localhost:8099"' in init_page
    assert 'window.localStorage.setItem("hassTokens"' in init_page
    assert "console." not in init_page

    assert "listen 127.0.0.1:8099;" in nginx
    assert not re.search(r"^\s*listen\s+8099;", nginx, re.MULTILINE)
    assert "location = /api/websocket" in nginx
    assert "rewrite ^ /core/websocket break;" not in nginx
    assert "rewrite ^/api/(.*)$ /core/api/$1 break;" not in nginx
    assert "proxy_pass $supervisor_upstream;" not in nginx
    assert "include /run/codex-ha/home-assistant-render-upstream.conf;" in nginx
    assert nginx.count("proxy_pass $ha_frontend_upstream;") == 3
    assert nginx.count('proxy_set_header X-Forwarded-For "";') == 3
    assert nginx.count('proxy_set_header X-Real-IP "";') == 3
    assert nginx.count('proxy_set_header Forwarded "";') == 3


def test_playwright_secrets_and_gateway_config_are_runtime_only_and_private(
    rootfs: Path,
) -> None:
    init_script = (rootfs / "usr/local/bin/codex-ha-init").read_text(
        encoding="utf-8"
    )

    assert (
        "LEGACY_PLAYWRIGHT_SECRETS=${RUNTIME_DIR}/playwright-secrets.env"
        in init_script
    )
    assert "HA_BROWSER_TOKEN_FILE=${RUNTIME_DIR}/home-assistant-browser.token" in init_script
    assert "HA_BROWSER_AUTH_STATUS=${RUNTIME_DIR}/browser-auth-status.json" in init_script
    assert 'install -d -m 0700' in init_script
    assert "PLAYWRIGHT_OUTPUT=${RUNTIME_DIR}/playwright-output" in init_script
    assert "rm -rf -- /run/codex-ha/playwright-output" in init_script
    assert 'rm -f "${LEGACY_PLAYWRIGHT_SECRETS}"' in init_script
    assert "playwright_secrets_tmp" not in init_script
    assert 'printf \'HA_BROWSER_TOKEN=%s\\n\'' not in init_script
    assert (
        'HA_BROWSER_TOKEN="${browser_token}" "${NODE_BINARY}" '
        '"${HA_BROWSER_AUTH_CHECK}"'
        in init_script
    )
    assert "unset NODE_OPTIONS NODE_PATH" in init_script
    assert 'for variable in "${!PLAYWRIGHT_MCP_@}"' in init_script
    assert "user_or_token_validation_failed" in init_script
    assert "system-read-only" in (
        rootfs / "usr/local/share/codex-ha/browser-auth-check.mjs"
    ).read_text(encoding="utf-8")
    assert 'chmod 0600 "${ha_render_upstream_tmp}"' in init_script
    assert 'mv -f "${ha_render_upstream_tmp}" "${HA_RENDER_UPSTREAM}"' in init_script


def test_browser_network_diagnostic_is_read_only_and_rejects_ip_trust(
    rootfs: Path,
) -> None:
    diagnostic = (rootfs / "usr/local/bin/ha-browser-network-info").read_text(
        encoding="utf-8"
    )

    assert "--write-out '%{local_ip}\\n%{remote_ip}\\n%{http_code}\\n'" in diagnostic
    assert "/apps/self/info /addons/self/info" in diagnostic
    assert 'safe_for_persistent_trusted_networks: false' in diagnostic
    assert "configuration.yaml" not in diagnostic
    assert ".storage" not in diagnostic
    assert "trusted_proxies" not in diagnostic


def test_browser_auth_checker_requires_exact_least_privilege_user(
    rootfs: Path,
) -> None:
    checker = (
        rootfs / "usr/local/share/codex-ha/browser-auth-check.mjs"
    ).read_text(encoding="utf-8")

    assert 'browserSession.request("auth/current_user")' in checker
    assert 'const websocketUrl = "ws://supervisor/core/websocket"' in checker
    assert "HA_BROWSER_AUTH_WEBSOCKET_URL" not in checker
    assert 'supervisorSession.request("config/auth/list")' in checker
    assert 'currentUser.is_admin === false' in checker
    assert 'user.local_only === true' in checker
    assert 'user.system_generated === false' in checker
    assert 'groupIds.length === 1' in checker
    assert 'groupIds[0] === "system-read-only"' in checker
    assert "access_token" not in re.sub(
        r'JSON\.stringify\(\{ type: "auth", access_token: accessToken \}\)',
        "",
        checker,
    )


def test_real_playwright_mcp_smoke_is_part_of_container_validation(
    repository_root: Path,
) -> None:
    smoke_script = repository_root / "tests/playwright_mcp_smoke.mjs"
    gateway_fixture = repository_root / "tests/ha_browser_gateway_fixture.mjs"
    docker_smoke = (repository_root / "tests/docker-smoke.sh").read_text(
        encoding="utf-8"
    )

    assert smoke_script.read_text(encoding="utf-8").startswith(
        'import assert from "node:assert/strict";\n'
    )
    assert gateway_fixture.read_text(encoding="utf-8").startswith(
        'import assert from "node:assert/strict";\n'
    )
    assert "tests/playwright_mcp_smoke.mjs" in docker_smoke
    assert "tests/ha_browser_gateway_fixture.mjs" in docker_smoke
    assert "/usr/local/bin/ha-playwright-mcp" in docker_smoke
    assert "codex mcp list --json" in docker_smoke
    assert "PLAYWRIGHT_MCP_SMOKE_URL=http://127.0.0.1:8099/" in docker_smoke
    assert "PLAYWRIGHT_MCP_SMOKE_EXPECT_SOURCE_IP" in docker_smoke
    assert "home-assistant-internal-desktop.png" in docker_smoke
    assert "home-assistant-internal-mobile.png" in docker_smoke
    assert "PLAYWRIGHT_MCP_SMOKE_EXPECT_UNAUTHENTICATED=1" in docker_smoke
    assert '--env HA_BROWSER_TOKEN="${BROWSER_TOKEN}"' in docker_smoke
    assert "--probe-websocket ws://127.0.0.1:8099/api/websocket" in docker_smoke
    assert "Home Assistant browser gateway was reachable outside app loopback" in docker_smoke
    assert "/run/codex-ha/playwright-output/init-sentinel" in docker_smoke


def test_released_image_update_smoke_is_wired_into_ci(
    repository_root: Path,
) -> None:
    update_smoke_path = repository_root / "tests/update-smoke.sh"
    update_smoke = update_smoke_path.read_text(encoding="utf-8")
    ci = (repository_root / ".github/workflows/ci.yaml").read_text(
        encoding="utf-8"
    )

    assert update_smoke.startswith("#!/usr/bin/env bash\nset -Eeuo pipefail\n")
    assert "ghcr.io/kanu-coffee/codex-for-home-assistant:0.2.0" in update_smoke
    assert '"${DATA_VOLUME}:/data"' in update_smoke
    assert '"${CONFIG_VOLUME}:/config"' in update_smoke
    assert "/data/codex/config.toml" in update_smoke
    assert "/data/codex/auth.json" in update_smoke
    assert "/data/codex/AGENTS.md" in update_smoke
    assert "/data/ssh/ssh_host_ed25519_key.pub" in update_smoke
    for preserved_value in (
        "CONFIG_HASH_BEFORE",
        "AUTH_HASH_BEFORE",
        "AGENTS_HASH_BEFORE",
        "HA_CONFIG_HASH_BEFORE",
        "HOST_KEY_BEFORE",
        "OPTIONS_HASH_BEFORE",
    ):
        assert preserved_value in update_smoke
    assert "codex mcp list --json" in update_smoke
    assert "tests/playwright_mcp_smoke.mjs" in update_smoke

    assert "Run container smoke tests" in ci
    assert "Verify update from released 0.2.0" in ci
    assert ci.index("Run container smoke tests") < ci.index(
        "Verify update from released 0.2.0"
    )
    assert "bash tests/update-smoke.sh" in ci
    assert "ghcr.io/kanu-coffee/codex-for-home-assistant:0.2.0" in ci
    assert "codex-for-home-assistant:test" in ci
