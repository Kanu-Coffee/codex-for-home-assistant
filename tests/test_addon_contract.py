import json
import os
import re
import struct
import subprocess
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


def test_release_is_multiarch_with_generic_registry_image(
    addon_config: dict,
) -> None:
    assert addon_config["arch"] == ["amd64", "aarch64"]
    assert (
        addon_config["image"]
        == "ghcr.io/kanu-coffee/codex-for-home-assistant"
    )
    assert "{arch}" not in addon_config["image"]
    assert addon_config["stage"] == "experimental"


def test_development_candidate_is_visible_in_home_assistant_and_image(
    addon_config: dict, addon_root: Path, repository_root: Path
) -> None:
    assert addon_config["name"] == "Codex for Home Assistant (DEV)"
    assert addon_config["version"] == "0.7.0-dev.1"
    assert addon_config["description"].startswith("[DEV] ")
    assert addon_config["panel_title"] == "Codex DEV"
    assert addon_config["slug"] == "codex_home_assistant"
    assert (
        addon_config["image"]
        == "ghcr.io/kanu-coffee/codex-for-home-assistant"
    )

    repository = yaml.safe_load(
        (repository_root / "repository.yaml").read_text(encoding="utf-8")
    )
    assert repository["name"] == "Codex for Home Assistant (DEV)"

    dockerfile = (addon_root / "Dockerfile").read_text(encoding="utf-8")
    assert (
        'org.opencontainers.image.title="Home Assistant App: '
        'Codex for Home Assistant (DEV)"' in dockerfile
    )
    assert 'org.opencontainers.image.version="${BUILD_VERSION}"' in dockerfile
    motd = (addon_root / "rootfs/etc/motd").read_text(encoding="utf-8")
    assert motd.startswith("Codex for Home Assistant (DEV)\n")


def _builder_validation_script(repository_root: Path) -> str:
    with (
        repository_root / ".github/workflows/builder.yaml"
    ).open(encoding="utf-8") as stream:
        workflow = yaml.safe_load(stream)
    validation_steps = workflow["jobs"]["validate"]["steps"]
    return next(
        step["run"]
        for step in validation_steps
        if step.get("name") == "Validate image and release tag"
    )


def _prepare_builder_validation_fixture(
    repository_root: Path, target: Path
) -> None:
    relative_paths = (
        Path("repository.yaml"),
        Path("codex_home_assistant/config.yaml"),
        Path("codex_home_assistant/Dockerfile"),
        Path("codex_home_assistant/rootfs/etc/motd"),
    )
    for relative_path in relative_paths:
        destination = target / relative_path
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes((repository_root / relative_path).read_bytes())


def _run_builder_validation(
    script: str, fixture: Path, **overrides: str
) -> subprocess.CompletedProcess[str]:
    environment = os.environ.copy()
    environment.update(
        {
            "APP_DESCRIPTION": (
                "[DEV] Codex CLI with verified feedback, browser, terminal, "
                "and SSH for Home Assistant"
            ),
            "APP_IMAGE": (
                "ghcr.io/kanu-coffee/codex-for-home-assistant"
            ),
            "APP_NAME": "Codex for Home Assistant (DEV)",
            "APP_VERSION": "0.7.0-dev.1",
            "GITHUB_EVENT_NAME": "pull_request",
            "RELEASE_TAG": "merge",
        }
    )
    environment.update(overrides)
    return subprocess.run(
        ["bash", "-Eeuo", "pipefail", "-c", script],
        cwd=fixture,
        env=environment,
        text=True,
        capture_output=True,
        check=False,
        timeout=10,
    )


def test_builder_channel_guard_accepts_consistent_dev_and_stable_metadata(
    repository_root: Path, tmp_path: Path
) -> None:
    script = _builder_validation_script(repository_root)
    dev_fixture = tmp_path / "dev"
    _prepare_builder_validation_fixture(repository_root, dev_fixture)
    assert _run_builder_validation(script, dev_fixture).returncode == 0

    stable_fixture = tmp_path / "stable"
    _prepare_builder_validation_fixture(repository_root, stable_fixture)
    replacements = {
        "repository.yaml": (
            "Codex for Home Assistant (DEV)",
            "Codex for Home Assistant",
        ),
        "codex_home_assistant/config.yaml": (
            "name: Codex for Home Assistant (DEV)\nversion: \"0.7.0-dev.1\"",
            "name: Codex for Home Assistant\nversion: \"0.7.0\"",
        ),
        "codex_home_assistant/Dockerfile": (
            "Codex for Home Assistant (DEV)",
            "Codex for Home Assistant",
        ),
        "codex_home_assistant/rootfs/etc/motd": (
            "Codex for Home Assistant (DEV)",
            "Codex for Home Assistant",
        ),
    }
    for relative_path, (old, new) in replacements.items():
        path = stable_fixture / relative_path
        path.write_text(
            path.read_text(encoding="utf-8").replace(old, new),
            encoding="utf-8",
        )
    stable_config = stable_fixture / "codex_home_assistant/config.yaml"
    stable_config.write_text(
        stable_config.read_text(encoding="utf-8").replace(
            'description: "[DEV] ', 'description: "'
        ).replace("panel_title: Codex DEV", "panel_title: Codex"),
        encoding="utf-8",
    )
    stable_result = _run_builder_validation(
        script,
        stable_fixture,
        APP_DESCRIPTION=(
            "Codex CLI with verified feedback, browser, terminal, and SSH "
            "for Home Assistant"
        ),
        APP_NAME="Codex for Home Assistant",
        APP_VERSION="0.7.0",
    )
    assert stable_result.returncode == 0, stable_result.stderr


def test_builder_channel_guard_rejects_invalid_or_incomplete_dev_metadata(
    repository_root: Path, tmp_path: Path
) -> None:
    script = _builder_validation_script(repository_root)
    cases = (
        ("dev-zero", None, None, None, {"APP_VERSION": "0.7.0-dev.0"}),
        (
            "wrong-name",
            None,
            None,
            None,
            {"APP_NAME": "Codex for Home Assistant"},
        ),
        (
            "missing-description-marker",
            None,
            None,
            None,
            {"APP_DESCRIPTION": "Codex for Home Assistant"},
        ),
        (
            "wrong-repository-name",
            "repository.yaml",
            "Codex for Home Assistant (DEV)",
            "Codex for Home Assistant",
            {},
        ),
        (
            "wrong-panel",
            "codex_home_assistant/config.yaml",
            "panel_title: Codex DEV",
            "panel_title: Codex",
            {},
        ),
        (
            "wrong-oci-title",
            "codex_home_assistant/Dockerfile",
            "Codex for Home Assistant (DEV)",
            "Codex for Home Assistant",
            {},
        ),
        (
            "wrong-motd",
            "codex_home_assistant/rootfs/etc/motd",
            "Codex for Home Assistant (DEV)",
            "Codex for Home Assistant",
            {},
        ),
    )
    for case_name, relative_path, old, new, overrides in cases:
        fixture = tmp_path / case_name
        _prepare_builder_validation_fixture(repository_root, fixture)
        if relative_path is not None and old is not None and new is not None:
            path = fixture / relative_path
            path.write_text(
                path.read_text(encoding="utf-8").replace(old, new),
                encoding="utf-8",
            )
        result = _run_builder_validation(script, fixture, **overrides)
        assert result.returncode != 0, case_name


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
    assert "RELEASE_TAG: ${{ github.ref_name }}" in builder_text
    assert "APP_IMAGE: ${{ fromJSON(steps.info.outputs.image) }}" in (
        builder_text
    )
    assert "Release tag and App version differ" in builder_text
    assert "X.Y.Z or a numbered X.Y.Z-dev.N build" in builder_text
    assert "(-dev\\.[1-9][0-9]*)?" in builder_text
    assert "App name does not match the release channel" in builder_text
    for required_channel_guard in (
        "APP_DESCRIPTION: ${{ fromJSON(steps.info.outputs.description) }}",
        "DEV App description must start with [DEV]",
        "Stable App description must not start with [DEV]",
        "Repository name does not match the release channel",
        "Panel title does not match the release channel",
        "OCI title does not match the release channel",
        "MOTD title does not match the release channel",
    ):
        assert required_channel_guard in builder_text
    assert "publish: false" in builder_text
    assert "publish: true" in builder_text
    assert "secrets: inherit" not in builder_text
    assert "packages: write" in builder_text
    assert "release-guard:" not in builder_text
    assert "needs: validate" in builder_text
    assert "github.repository == 'Kanu-Coffee/codex-for-home-assistant'" in (
        build_app_text
    )
    builder_pin = "4de35182ce1e329181bffcbcc84d33db5e2c7e10"
    assert f"home-assistant/builder/actions/build-image@{builder_pin}" in (
        build_app_text
    )
    assert "publish-multi-arch-manifest" not in build_app_text
    assert (
        "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a"
        in build_app_text
    )
    assert (
        "actions/download-artifact@37930b1c2abaa49bbe596cd826c3c89aef350131"
        in build_app_text
    )
    assert "image-tags: latest" not in build_app_text
    assert "-staging-${{ github.run_id }}" in build_app_text
    assert "github.run_attempt" not in build_app_text
    assert (
        "Refusing to overwrite a release tag with different content"
        in build_app_text
    )


def test_reusable_build_workflow_cannot_elevate_caller_permissions(
    repository_root: Path,
) -> None:
    workflow_root = repository_root / ".github" / "workflows"
    with (workflow_root / "builder.yaml").open(encoding="utf-8") as stream:
        builder = yaml.safe_load(stream)
    with (workflow_root / "build-app.yaml").open(encoding="utf-8") as stream:
        build_app = yaml.safe_load(stream)

    assert builder["jobs"]["build-app"]["permissions"] == {
        "contents": "read",
        "packages": "read",
    }
    assert builder["jobs"]["publish-app"]["permissions"] == {
        "artifact-metadata": "write",
        "attestations": "write",
        "contents": "read",
        "id-token": "write",
        "packages": "write",
    }
    assert build_app["jobs"]["prepare"]["permissions"] == {
        "contents": "read"
    }
    assert "permissions" not in build_app["jobs"]["build"]
    assert "permissions" not in build_app["jobs"]["manifest"]


def test_registry_publish_happens_only_after_local_vulnerability_gates(
    repository_root: Path,
) -> None:
    workflow_path = (
        repository_root / ".github" / "workflows" / "build-app.yaml"
    )
    workflow = workflow_path.read_text(encoding="utf-8")
    build_section = workflow.split("  build:\n", maxsplit=1)[1].split(
        "  manifest:\n", maxsplit=1
    )[0]

    assert "          push: false\n" in build_section
    assert "          load: true\n" in build_section
    assert "          cosign: false\n" in build_section
    assert "push: ${{ inputs.publish }}" not in build_section
    assert (
        "image: ${{ matrix.image }}:${{ needs.prepare.outputs.version }}"
        in build_section
    )

    critical_gate = build_section.index(
        "name: Enforce critical vulnerability gate"
    )
    report = build_section.index(
        "name: Report high and critical vulnerabilities (non-blocking)"
    )
    registry_login = build_section.index(
        "name: Log in to GHCR after vulnerability gates"
    )
    registry_push = build_section.index(
        "name: Push scanned architecture staging image and verify digest"
    )
    digest_signing = build_section.index(
        "name: Sign scanned architecture image digest"
    )
    provenance = build_section.index(
        "name: Attest architecture build provenance"
    )
    assert critical_gate < report < registry_login < registry_push
    assert registry_push < digest_signing < provenance

    report_section = build_section[report:registry_login]
    assert "if: ${{ !cancelled() }}" in report_section
    assert "continue-on-error: true" in report_section
    assert "fail-build: false" in report_section
    assert "severity-cutoff: high" in report_section

    gate_section = build_section[critical_gate:report]
    assert "fail-build: true" in gate_section
    assert "severity-cutoff: critical" in gate_section

    assert "Staging digest does not match the scanned image push" in (
        build_section
    )
    assert "docker buildx imagetools create" not in build_section
    assert build_section.count(
        "subject-digest: ${{ steps.publish-image.outputs.digest }}"
    ) == 2

    manifest_section = workflow.split("  manifest:\n", maxsplit=1)[1]
    digest_download = manifest_section.index(
        "name: Download verified architecture digests"
    )
    staging_manifest = manifest_section.index(
        "name: Create staging manifest from verified architecture digests"
    )
    manifest_signing = manifest_section.index(
        "name: Sign multi-architecture manifest digest"
    )
    manifest_attestation = manifest_section.index(
        "name: Attest multi-architecture manifest provenance"
    )
    promotion = manifest_section.index(
        "name: Promote verified architecture and manifest tags"
    )
    assert (
        digest_download
        < staging_manifest
        < manifest_signing
        < manifest_attestation
        < promotion
    )
    staging_section = manifest_section[staging_manifest:manifest_signing]
    assert "Architecture staging tag changed after verification" in (
        staging_section
    )
    assert "${architecture_image}@${expected_digest}" in staging_section
    assert "Staging manifest contains an unverified architecture digest" in (
        staging_section
    )
    assert '"${IMAGE}@${staging_digest}" --raw' in staging_section
    assert "Staging manifest bytes do not match the resolved digest" in (
        staging_section
    )
    assert 'sha256sum "${raw_manifest_file}"' in staging_section
    assert "${expected_digest}|${oci_architecture}|linux" in staging_section
    assert staging_section.index("staging_digest=$(docker buildx") < (
        staging_section.index('"${IMAGE}@${staging_digest}" --raw')
    )
    promotion_section = manifest_section[promotion:]
    assert "docker buildx imagetools create --prefer-index=false" in (
        promotion_section
    )
    assert "Refusing to overwrite a release tag with different content" in (
        promotion_section
    )
    assert "Promoted release tag does not match its verified digest" in (
        promotion_section
    )


def test_build_workflow_external_actions_are_commit_pinned(
    repository_root: Path,
) -> None:
    workflow = (
        repository_root / ".github" / "workflows" / "build-app.yaml"
    ).read_text(encoding="utf-8")
    action_refs = re.findall(r"^\s*uses:\s+([^\s#]+)", workflow, re.MULTILINE)

    assert action_refs
    for action_ref in action_refs:
        assert re.fullmatch(r"[^@\s]+@[0-9a-f]{40}", action_ref), action_ref


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
    assert addon_config["options"]["codex_sandbox_mode"] == "workspace-write"
    assert addon_config["schema"]["codex_sandbox_mode"] == (
        "list(workspace-write|danger-full-access)"
    )
    assert addon_config["options"]["browser_approval_policy"] == "safe"
    assert addon_config["schema"]["browser_approval_policy"] == (
        "list(safe|never|always)"
    )
    assert addon_config["options"]["home_assistant_browser_auto_auth"] is True
    assert addon_config["schema"]["home_assistant_browser_auto_auth"] == "bool"
    assert "home_assistant_browser_token" not in addon_config["options"]
    assert addon_config["schema"]["home_assistant_browser_token"] == "password?"


def test_browser_approval_policy_is_translated(addon_root: Path) -> None:
    for locale in ("en", "ko"):
        with (addon_root / f"translations/{locale}.yaml").open(
            encoding="utf-8"
        ) as stream:
            translation = yaml.safe_load(stream)
        option = translation["configuration"]["browser_approval_policy"]
        assert option["name"]
        for value in ("safe", "never", "always"):
            assert value in option["description"]
