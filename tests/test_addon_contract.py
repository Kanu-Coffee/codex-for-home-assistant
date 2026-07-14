import json
import re
import struct
from pathlib import Path

import yaml


def _png_header(path: Path) -> tuple[int, int, int]:
    header = path.read_bytes()[:26]
    assert header[:8] == b"\x89PNG\r\n\x1a\n"
    assert header[12:16] == b"IHDR"
    width, height = struct.unpack(">II", header[16:24])
    return width, height, header[25]


def test_all_yaml_files_parse(repository_root: Path) -> None:
    yaml_files = [
        path
        for path in repository_root.rglob("*.yaml")
        if ".git" not in path.parts and ".pytest_cache" not in path.parts
    ]
    assert yaml_files

    for yaml_file in yaml_files:
        with yaml_file.open(encoding="utf-8") as stream:
            yaml.safe_load(stream)


def test_release_is_amd64_with_generic_registry_image(addon_config: dict) -> None:
    assert addon_config["arch"] == ["amd64"]
    assert (
        addon_config["image"]
        == "ghcr.io/kanu-coffee/codex-for-home-assistant"
    )
    assert "{arch}" not in addon_config["image"]
    assert addon_config["stage"] == "experimental"


def test_registry_release_workflow_is_tag_gated(repository_root: Path) -> None:
    workflow_root = repository_root / ".github" / "workflows"
    builder_path = workflow_root / "builder.yaml"
    build_app_path = workflow_root / "build-app.yaml"

    with builder_path.open(encoding="utf-8") as stream:
        builder = yaml.safe_load(stream)
    assert builder["on"]["push"] == {
        "tags": ["[0-9]*.[0-9]*.[0-9]*"]
    }
    assert "branches" not in builder["on"]["push"]

    builder_text = builder_path.read_text(encoding="utf-8")
    build_app_text = build_app_path.read_text(encoding="utf-8")
    validate_section, release_guard_section = builder_text.split(
        "  release-guard:\n", maxsplit=1
    )
    assert "RELEASE_TAG: ${{ github.ref_name }}" in validate_section
    assert "APP_IMAGE: ${{ fromJSON(steps.info.outputs.image) }}" in (
        validate_section
    )
    assert "Release tag and App version differ" in validate_section
    assert "Release tag and App version differ" not in release_guard_section
    assert "publish: false" in builder_text
    assert "publish: true" in builder_text
    assert "secrets: inherit" not in builder_text
    assert "packages: write" in builder_text
    assert "Refusing to overwrite ${package}:${APP_VERSION}" in builder_text
    assert "github.repository == 'Kanu-Coffee/codex-for-home-assistant'" in (
        build_app_text
    )
    assert "home-assistant/builder/actions/build-image@2026.06.0" in (
        build_app_text
    )
    assert (
        "home-assistant/builder/actions/"
        "publish-multi-arch-manifest@2026.06.0"
    ) in build_app_text
    assert "image-tags: latest" not in build_app_text


def test_home_assistant_brand_assets(addon_root: Path) -> None:
    assert _png_header(addon_root / "icon.png") == (128, 128, 6)
    assert _png_header(addon_root / "logo.png") == (250, 250, 6)


def test_app_and_dockerfile_versions_match(
    addon_config: dict, addon_root: Path
) -> None:
    dockerfile = (addon_root / "Dockerfile").read_text(encoding="utf-8")
    assert f'ARG BUILD_VERSION={addon_config["version"]}' in dockerfile

    changelog = (addon_root / "CHANGELOG.md").read_text(encoding="utf-8")
    newest_heading = re.search(r"^## \[([^]]+)]", changelog, re.MULTILINE)
    assert newest_heading
    assert newest_heading.group(1) == addon_config["version"]

    package = json.loads(
        (addon_root / "playwright/package.json").read_text(encoding="utf-8")
    )
    lock = json.loads(
        (addon_root / "playwright/package-lock.json").read_text(
            encoding="utf-8"
        )
    )
    assert package["version"] == addon_config["version"]
    assert lock["version"] == addon_config["version"]
    assert lock["packages"][""]["version"] == addon_config["version"]


def test_ingress_and_network_contract(addon_config: dict) -> None:
    assert addon_config["ingress"] is True
    assert addon_config["ingress_stream"] is True
    assert addon_config["ingress_port"] == 7681
    assert addon_config.get("panel_admin", True) is True
    assert addon_config["ports"] == {"22/tcp": 2223}
    assert "ssh_port" not in addon_config["options"]
    assert "ssh_port" not in addon_config["schema"]


def test_home_assistant_config_is_mapped_read_write(addon_config: dict) -> None:
    config_maps = [
        mapping
        for mapping in addon_config["map"]
        if mapping.get("type") == "homeassistant_config"
    ]
    assert config_maps == [
        {
            "type": "homeassistant_config",
            "path": "/config",
            "read_only": False,
        }
    ]


def test_core_and_supervisor_manager_apis_are_enabled(addon_config: dict) -> None:
    assert addon_config["homeassistant_api"] is True
    assert addon_config["hassio_api"] is True
    assert addon_config["hassio_role"] == "manager"


def test_forbidden_privilege_settings_are_absent(addon_config: dict) -> None:
    for forbidden_key in ("docker_api", "full_access", "host_network"):
        assert forbidden_key not in addon_config

    assert addon_config.get("hassio_role") != "admin"
    assert addon_config.get("apparmor", True) is True


def test_security_sensitive_defaults(addon_config: dict) -> None:
    assert addon_config["options"]["authorized_keys"] == []
    assert addon_config["options"]["web_terminal_auto_start_codex"] is False
    assert addon_config["options"]["codex_approval_policy"] == "on-request"
    assert addon_config["options"]["codex_sandbox_mode"] == "danger-full-access"
    assert "home_assistant_browser_token" not in addon_config["options"]
    assert addon_config["schema"]["home_assistant_browser_token"] == "password?"
