import re
import tomllib
from pathlib import Path


MEMORY_BINARIES = {
    "ha-memory": "ha-memory.mjs",
    "ha-memory-mcp": "ha-memory-mcp.mjs",
}

MEMORY_SHARE_FILES = (
    "ha-memory-core.mjs",
    "ha-memory-ha-client.mjs",
    "ha-memory.mjs",
    "ha-memory-mcp.mjs",
)

MEMORY_TABLES = (
    "metadata",
    "sync_runs",
    "catalog_objects",
    "catalog_relations",
    "catalog_revisions",
    "memory_items",
    "memory_evidence",
    "conflicts",
    "change_records",
    "audit_events",
    "audit_changes",
    "search_fts",
)

MEMORY_ITEM_STATUSES = (
    "pending",
    "verified",
    "applied",
    "rejected",
    "conflict",
    "superseded",
)

CHANGE_STATUSES = (
    "pending",
    "verified",
    "mismatch",
    "unavailable",
)


def _table_definition(source: str, table: str) -> str:
    match = re.search(
        rf"CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"
        rf"{re.escape(table)}\b(?P<body>.*?);",
        source,
        re.IGNORECASE | re.DOTALL,
    )
    assert match, f"missing SQL table definition: {table}"
    return match.group("body")


def _assert_quoted_sql_values(source: str, values: tuple[str, ...]) -> None:
    for value in values:
        assert re.search(rf"(['\"]){re.escape(value)}\1", source), value


def _assert_nearby_terms(
    source: str,
    anchor: str,
    required: tuple[str, ...],
    distance: int = 320,
) -> None:
    for match in re.finditer(anchor, source):
        nearby = source[
            max(0, match.start() - distance) : min(len(source), match.end() + distance)
        ]
        if all(re.search(pattern, nearby) for pattern in required):
            return
    raise AssertionError(f"terms were not found near /{anchor}/: {required}")


def test_memory_runtime_artifacts_are_image_managed(rootfs: Path) -> None:
    binary_root = rootfs / "usr/local/bin"
    share_root = rootfs / "usr/local/share/codex-ha"

    for binary_name, module_name in MEMORY_BINARIES.items():
        binary = binary_root / binary_name
        assert binary.is_file(), binary_name

        wrapper = binary.read_text(encoding="utf-8")
        assert wrapper.startswith("#!/usr/bin/env bash\n")
        assert "set -Eeuo pipefail" in wrapper
        assert "/usr/bin/node" in wrapper
        assert f"/usr/local/share/codex-ha/{module_name}" in wrapper

    for filename in MEMORY_SHARE_FILES:
        module = share_root / filename
        assert module.is_file(), filename
        assert module.read_text(encoding="utf-8").strip(), filename


def test_memory_runtime_is_packaged_with_node_sqlite(
    addon_root: Path,
) -> None:
    dockerfile = (addon_root / "Dockerfile").read_text(encoding="utf-8")

    assert "nodejs" in dockerfile
    assert "node:sqlite" in dockerfile
    assert re.search(r"node\s+-e\s+.*node:sqlite", dockerfile, re.DOTALL)

    executable_chmod = re.search(
        r"chmod\s+0755\s+\\(?P<body>.*?)(?=&&\s+chmod\s+0644)",
        dockerfile,
        re.DOTALL,
    )
    assert executable_chmod
    assert "/usr/local/bin/*" in executable_chmod.group("body")

    private_modules_chmod = re.search(
        r"chmod\s+0644\s+\\(?P<body>.*?)(?=\n\n|\Z)",
        dockerfile,
        re.DOTALL,
    )
    assert private_modules_chmod
    for filename in MEMORY_SHARE_FILES:
        assert (
            f"/usr/local/share/codex-ha/{filename}"
            in private_modules_chmod.group("body")
        )


def test_memory_daemon_is_optional_to_terminal_and_ssh(rootfs: Path) -> None:
    s6_root = rootfs / "etc/s6-overlay/s6-rc.d"
    user_bundle = s6_root / "user/contents.d"
    memory_service = s6_root / "ha-memoryd"

    assert (user_bundle / "ha-memoryd").is_file()
    assert (memory_service / "type").read_text(encoding="utf-8").strip() == (
        "longrun"
    )
    run_script = (memory_service / "run").read_text(encoding="utf-8")
    assert run_script.startswith("#!/command/with-contenv bashio\n")
    assert "/usr/local/bin/ha-memory" in run_script
    assert ">/dev/null 2>&1" not in run_script
    assert "jq --exit-status --raw-output" in run_script
    assert ".reason" in run_script
    assert ".warnings | length" in run_script
    assert "bounded warning(s)" in run_script
    assert "ha_token_unavailable" in run_script
    assert "ha_auth_rejected" in run_script
    assert "ha_command_automation_config_failed" in run_script
    assert "refresh_reason=ha_unavailable" in run_script
    assert all(
        "refresh_output" not in line
        for line in run_script.splitlines()
        if "bashio::log" in line
    )
    assert (memory_service / "dependencies.d/codex-ha-init").is_file()

    for service in ("ttyd", "sshd"):
        assert not (s6_root / service / "dependencies.d/ha-memoryd").exists()


def test_init_bootstraps_only_the_local_memory_database(rootfs: Path) -> None:
    init_script = (rootfs / "usr/local/bin/codex-ha-init").read_text(
        encoding="utf-8"
    )

    assert re.search(r"install\s+-d\s+-m\s+0700", init_script)
    install_block = init_script.split("install -d -m 0700", 1)[1].split(
        "/root/.ssh", 1
    )[0]
    assert "codex-ha-memory" not in install_block
    assert "/usr/local/bin/ha-memory init" in init_script
    assert "if /usr/local/bin/ha-memory init" in init_script
    assert "/usr/local/bin/ha-memory refresh" not in init_script


def test_system_config_registers_optional_memory_mcp(rootfs: Path) -> None:
    config_path = rootfs / "etc/codex/config.toml"
    with config_path.open("rb") as stream:
        config = tomllib.load(stream)

    instructions = " ".join(config["developer_instructions"].lower().split())
    for required in (
        "/data/codex-ha-memory/memory.sqlite3",
        "memory_search",
        "memory_remember_explicit",
        "memory_list_candidates",
        "memory_reject_candidate",
        "memory_begin_change",
        "memory_verify_change",
        "ha-memory remember",
        "home:household",
        "empty",
        "degraded",
        "stale",
        "agents.override.md",
        "home assistant api",
    ):
        assert required in instructions
    assert "when practical" not in instructions
    assert "never substitute an exists/name check" in instructions

    memory_mcp = config["mcp_servers"]["ha_memory"]
    assert memory_mcp["command"] == "/usr/bin/env"
    assert memory_mcp["args"][0] == "-i"
    assert memory_mcp["args"][-1] == "/usr/local/bin/ha-memory-mcp"
    assert any(arg.startswith("PATH=") for arg in memory_mcp["args"])
    assert all("SUPERVISOR_TOKEN" not in arg for arg in memory_mcp["args"])
    assert memory_mcp["cwd"] == "/config"
    assert memory_mcp["env_vars"] == []
    assert memory_mcp["enabled"] is True
    assert memory_mcp["required"] is False
    assert set(memory_mcp["enabled_tools"]) == {
        "memory_search",
        "memory_show",
        "memory_remember_explicit",
        "memory_propose",
        "memory_list_candidates",
        "memory_reject_candidate",
        "memory_add_evidence",
        "memory_verify_candidate",
        "memory_apply_candidate",
        "memory_begin_change",
        "memory_verify_change",
        "memory_status",
        "memory_history",
        "memory_conflicts",
        "memory_resolve_conflict",
        "memory_rollback",
    }


def test_memory_mcp_exposes_only_the_structured_protocol(rootfs: Path) -> None:
    mcp = (
        rootfs / "usr/local/share/codex-ha/ha-memory-mcp.mjs"
    ).read_text(encoding="utf-8")

    for method in ("initialize", "ping", "tools/list", "tools/call"):
        assert f'"{method}"' in mcp
    for tool in (
        "memory_remember_explicit",
        "memory_list_candidates",
        "memory_reject_candidate",
    ):
        assert f'name: "{tool}"' in mcp
    assert 'const SERVER_VERSION = "1.1.0"' in mcp
    assert 'required: ["summary", "subjects", "expectations"]' in mcp
    assert "Unsupported argument" in mcp
    assert "HA_MEMORY_INSTALLED_TEST" not in mcp

    search_case = mcp.split('case "memory_search":', 1)[1].split(
        'case "memory_show"', 1
    )[0]
    assert 'requireString(args, "subject", {' in search_case
    assert "optional: true" in search_case

    list_case = mcp.split('case "memory_list_candidates":', 1)[1].split(
        'case "memory_reject_candidate"', 1
    )[0]
    assert 'requireString(args, "subject", { maxLength: 512 })' in list_case
    assert "optional: true" not in list_case


def test_memory_ha_client_uses_the_fixed_snapshot_allowlist(rootfs: Path) -> None:
    client = (
        rootfs / "usr/local/share/codex-ha/ha-memory-ha-client.mjs"
    ).read_text(encoding="utf-8")

    for command in (
        "config/area_registry/list",
        "config/device_registry/list",
        "config/entity_registry/list",
        "get_states",
        "automation/config",
        "search/related",
    ):
        assert command in client
    assert "config/automation/config" not in client
    assert "config/automation/related" not in client
    assert 'item_type: "automation"' in client
    assert "HomeAssistantCommandRejectedError" in client
    assert 'remoteCode === "unknown_error"' in client
    assert "automation_related_unavailable" in client
    assert "incomplete automation detail snapshot" in client
    assert "process.env.HA_WS_URL" not in client
    assert "/usr/local/lib/codex-ha/playwright/node_modules/ws/wrapper.mjs" in client
    assert "maxPayload: MAX_MESSAGE_BYTES" in client
    assert "perMessageDeflate: false" in client
    assert "configValue === null" in client


def test_default_guidance_defines_verified_memory_workflow(rootfs: Path) -> None:
    guidance = (
        rootfs / "usr/local/share/codex-ha/AGENTS.md"
    ).read_text(encoding="utf-8")
    memory_guidance = guidance.split("## Validated Home Assistant memory", 1)[1].split(
        "## Browser validation", 1
    )[0]
    normalized = " ".join(memory_guidance.lower().split())

    assert "/data/codex-ha-memory/memory.sqlite3" in normalized
    assert "ha-memory search" in normalized
    assert "memory_remember_explicit" in normalized
    assert "ha-memory remember" in normalized
    assert re.search(
        r"candidate.{0,160}verified.{0,160}applied",
        normalized,
    )

    assert "memory_begin_change" in normalized
    assert "memory_verify_change" in normalized
    assert "every persistent home assistant" in normalized
    assert "when practical" not in normalized
    assert "never use a weaker exists/name check" in normalized
    assert "home assistant api" in normalized
    _assert_nearby_terms(
        normalized,
        r"memory_verify_change",
        (r"after|following", r"fresh", r"home assistant api"),
    )

    _assert_nearby_terms(
        normalized,
        r"agents\.md",
        (r"never", r"entity-specific", r"aliases|preferences|relationships"),
    )

    _assert_nearby_terms(
        normalized,
        r"transient|temporary|current",
        (r"do not|never", r"persist|store", r"state"),
    )
    _assert_nearby_terms(
        normalized,
        r"database|sqlite",
        (r"do not|never", r"read|dump|load", r"entire|whole|full"),
    )

    assert "ha-memory rollback" in normalized
    assert "history" in normalized or "audit" in normalized
    _assert_nearby_terms(
        normalized,
        r"roll back|rollback",
        (r"do not|never", r"home assistant|snapshot"),
    )


def test_memory_schema_declares_catalog_workflow_and_audit_tables(
    rootfs: Path,
) -> None:
    core = (
        rootfs / "usr/local/share/codex-ha/ha-memory-core.mjs"
    ).read_text(encoding="utf-8")

    definitions = {table: _table_definition(core, table) for table in MEMORY_TABLES}
    assert re.search(
        r"CREATE\s+VIRTUAL\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?search_fts",
        core,
        re.IGNORECASE,
    )

    memory_status_sql = definitions["memory_items"]
    assert re.search(r"\bstatus\b", memory_status_sql, re.IGNORECASE)
    _assert_quoted_sql_values(memory_status_sql, MEMORY_ITEM_STATUSES)

    change_status_sql = definitions["change_records"]
    assert re.search(r"\bstatus\b", change_status_sql, re.IGNORECASE)
    assert re.search(r"\bexpectation_hash\b", change_status_sql, re.IGNORECASE)
    _assert_quoted_sql_values(change_status_sql, CHANGE_STATUSES)


def test_memory_feature_does_not_expand_app_privileges(
    addon_config: dict,
) -> None:
    assert addon_config["homeassistant_api"] is True
    assert addon_config["hassio_api"] is True
    assert addon_config["hassio_role"] == "manager"
    assert addon_config.get("apparmor", True) is True

    for forbidden_key in ("docker_api", "full_access", "host_network"):
        assert forbidden_key not in addon_config
