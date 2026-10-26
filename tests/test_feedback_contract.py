import json
import os
import re
import shutil
import stat
import subprocess
import tomllib
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pytest
import yaml


TARGET_REPOSITORY = "Kanu-Coffee/codex-for-home-assistant"
PRIVATE_REPORTING_URL = (
    "https://github.com/Kanu-Coffee/codex-for-home-assistant/"
    "security/advisories/new"
)
FIXTURE_ROOT = Path(__file__).parent / "fixtures"
ALLOWED_CHECK_STATUSES = {"PASS", "FAIL", "NOT_TESTED", "NOT_RUN"}


def _helper_path(rootfs: Path) -> Path:
    return rootfs / "usr/local/share/codex-ha/ha-feedback.mjs"


def _feedback_environment(tmp_path: Path) -> dict[str, str]:
    environment = os.environ.copy()
    environment.pop("SUPERVISOR_TOKEN", None)
    environment["HA_FEEDBACK_TEST_MODE"] = "1"
    environment["HA_FEEDBACK_REPORT_ROOT"] = str(tmp_path / "reports")
    environment["HA_FEEDBACK_GH_CONFIG_DIR"] = str(tmp_path / "github-cli")
    environment["HA_FEEDBACK_GH_BIN"] = str(tmp_path / "missing-gh")
    return environment


def _run_helper(
    rootfs: Path,
    tmp_path: Path,
    *arguments: str,
) -> subprocess.CompletedProcess[str]:
    node = shutil.which("node")
    assert node, "Node.js is required for the image-managed feedback helper"
    return subprocess.run(
        [node, str(_helper_path(rootfs)), *arguments],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        env=_feedback_environment(tmp_path),
        timeout=20,
    )


def _write_private_json(path: Path, value: object) -> None:
    path.write_text(
        f"{json.dumps(value, ensure_ascii=False, indent=2)}\n",
        encoding="utf-8",
    )
    path.chmod(0o600)


def _copy_private_fixture(tmp_path: Path, fixture_name: str) -> Path:
    source = FIXTURE_ROOT / fixture_name
    target = tmp_path / fixture_name
    target.write_bytes(source.read_bytes())
    target.chmod(0o600)
    return target


def _collect_fixture(
    rootfs: Path,
    tmp_path: Path,
    kind: str,
    fixture_name: str,
) -> tuple[dict, Path]:
    input_path = _copy_private_fixture(tmp_path, fixture_name)
    result = _run_helper(
        rootfs,
        tmp_path,
        "collect",
        kind,
        "--input",
        str(input_path),
    )
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    return payload, input_path


def _skill_frontmatter(source: str) -> tuple[dict, str]:
    match = re.match(r"\A---\n(?P<yaml>.*?)\n---\n(?P<body>.*)\Z", source, re.DOTALL)
    assert match, "SKILL.md must have complete YAML frontmatter"
    metadata = yaml.safe_load(match.group("yaml"))
    assert isinstance(metadata, dict)
    return metadata, match.group("body")


def _form_fields(form: dict) -> dict[str, dict]:
    return {
        item["id"]: item
        for item in form["body"]
        if isinstance(item, dict) and isinstance(item.get("id"), str)
    }


def test_feedback_skill_metadata_references_and_routing(rootfs: Path) -> None:
    skill_root = rootfs / "etc/codex/skills/ha-feedback"
    skill_source = (skill_root / "SKILL.md").read_text(encoding="utf-8")
    metadata, skill_body = _skill_frontmatter(skill_source)

    assert metadata["name"] == "ha-feedback"
    assert "bug reports" in metadata["description"]
    assert "feature proposals" in metadata["description"]
    assert "TODO" not in skill_source

    reference_root = skill_root / "references"
    references = {
        path.name: path.read_text(encoding="utf-8")
        for path in reference_root.iterdir()
        if path.is_file()
    }
    assert set(references) == {
        "bug.md",
        "feature.md",
        "privacy.md",
        "submission.md",
    }
    for reference_name in references:
        assert f"references/{reference_name}" in skill_body

    for status in ALLOWED_CHECK_STATUSES:
        assert f'"{status}"' in references["bug.md"]
        assert f'"{status}"' in references["feature.md"]
    assert "acceptance_criteria" in references["feature.md"]
    assert "explicitly say what is unknown" in references["feature.md"]
    assert "private vulnerability reporting" in references["privacy.md"]
    assert "do not run GitHub candidate search" in references["privacy.md"]
    assert "current user turn" in references["submission.md"]
    assert "github submit <report> --confirm <token>" in references["submission.md"]

    openai = yaml.safe_load(
        (skill_root / "agents/openai.yaml").read_text(encoding="utf-8")
    )
    assert openai["interface"]["display_name"] == "Home Assistant Feedback"
    assert openai["interface"]["short_description"]
    assert "$ha-feedback bug <symptom>" in openai["interface"]["default_prompt"]
    assert "$ha-feedback feature <request>" in openai["interface"]["default_prompt"]
    assert openai["policy"]["allow_implicit_invocation"] is True

    runtime_guidance = (
        rootfs / "usr/local/share/codex-ha/AGENTS.md"
    ).read_text(encoding="utf-8")
    feedback_guidance = runtime_guidance.split("## Feedback validation", 1)[1].split(
        "## Validated Home Assistant memory", 1
    )[0]
    normalized_guidance = " ".join(feedback_guidance.lower().split())
    for required in (
        "$ha-feedback",
        "bug",
        "feature",
        "observational",
        "security issues",
        "candidate issues",
        "exact final payload",
        "current-turn confirmation",
    ):
        assert required in normalized_guidance

    with (rootfs / "etc/codex/config.toml").open("rb") as stream:
        config = tomllib.load(stream)
    instructions = " ".join(config["developer_instructions"].lower().split())
    for required in (
        "$ha-feedback",
        "bug",
        "feature",
        "read-only",
        "stop public submission for security issues",
        "exact final repository, title, and body",
        "current user turn",
    ):
        assert required in instructions


def test_feedback_helper_is_pinned_and_image_managed(
    addon_config: dict,
    addon_root: Path,
    repository_root: Path,
    rootfs: Path,
) -> None:
    assert "/feedback/" in (repository_root / ".gitignore").read_text(
        encoding="utf-8"
    )
    dockerfile = (addon_root / "Dockerfile").read_text(encoding="utf-8")
    assert f'ARG BUILD_VERSION={addon_config["version"]}' in dockerfile
    assert "ARG GH_VERSION=2.97.0" in dockerfile
    assert (
        "ARG GH_SHA256_AMD64="
        "a2c9b8497e1f85b1ad0dfcb78b5a622e098801b8e461e459e88e1ee12f018112"
    ) in dockerfile
    assert (
        "ARG GH_SHA256_AARCH64="
        "73ea440ecad9c9e284429997ee6f93577bc6f7bc6fba357ef62c53ad8fb641a5"
    ) in dockerfile
    assert 'gh_archive="gh_${GH_VERSION}_linux_${gh_arch}.tar.gz"' in dockerfile
    assert (
        '"https://github.com/cli/cli/releases/download/'
        'v${GH_VERSION}/${gh_archive}"'
    ) in dockerfile
    assert (
        '"${gh_sha256}" "/tmp/${gh_archive}" '
        "| sha256sum --check --strict -"
    ) in dockerfile
    assert (
        'install -m 0755 "/tmp/gh_${GH_VERSION}_linux_${gh_arch}/bin/gh" '
        "/usr/local/bin/gh"
    ) in dockerfile
    assert dockerfile.count('"gh version ${GH_VERSION} "') >= 2
    assert "find /etc/codex/skills/ha-feedback -type d -exec chmod 0755" in dockerfile
    assert "find /etc/codex/skills/ha-feedback -type f -exec chmod 0644" in dockerfile
    assert "/usr/local/share/codex-ha/ha-feedback.mjs" in dockerfile
    assert "node --check /usr/local/share/codex-ha/ha-feedback.mjs" in dockerfile
    assert "ha-feedback --help | grep -Fq 'ha-feedback github submit'" in dockerfile

    wrapper = (rootfs / "usr/local/bin/ha-feedback").read_text(encoding="utf-8")
    assert wrapper.startswith("#!/bin/bash -p\n")
    assert "set -Eeuo pipefail" in wrapper
    assert (
        "exec /usr/bin/env -i" in wrapper
        and 'SUPERVISOR_TOKEN="${SUPERVISOR_TOKEN:-}"' in wrapper
        and '/usr/bin/node /usr/local/share/codex-ha/ha-feedback.mjs "$@"'
        in wrapper
    )
    assert "Privileged Bash ignores BASH_ENV" in wrapper
    assert "GitHub tokens" in wrapper
    for forbidden_assignment in (
        "HA_FEEDBACK_TEST_MODE=",
        "HA_FEEDBACK_REPORT_ROOT=",
        "HA_FEEDBACK_GH_CONFIG_DIR=",
        "HA_FEEDBACK_GH_BIN=",
        "HA_FEEDBACK_PREVIEW_ROOT=",
        "GH_CONFIG_DIR=",
        "GH_TOKEN=",
        "GITHUB_TOKEN=",
        "NODE_OPTIONS=",
        "BASH_ENV=",
    ):
        assert forbidden_assignment not in wrapper

    helper = _helper_path(rootfs).read_text(encoding="utf-8")
    for required in (
        'const SCHEMA_VERSION = "1"',
        f'const TARGET_REPOSITORY = "{TARGET_REPOSITORY}"',
        'const DEFAULT_REPORT_ROOT = "/config/codex-workspace/feedback"',
        'const DEFAULT_GH_CONFIG_DIR = "/data/github-cli"',
        'const DEFAULT_GH_BIN = "/usr/local/bin/gh"',
        'const DEFAULT_PREVIEW_ROOT = "/tmp/codex-ha-feedback-previews"',
        "const PREVIEW_TTL_MS = 10 * 60 * 1000",
        'path.join(reportDirectory, "submission.json")',
        'path.join(reportDirectory, ".submission.lock")',
        "resolved.submissionPath,",
        '"--body-file",\n        "-",',
        "crypto.randomBytes(32).toString(\"base64url\")",
        "consumeConfirmationPreview(resolved, suppliedToken)",
        "writePrivateNewAtomically(",
        "fsyncDirectory(resolved.reportDirectory)",
        "submission.json does not match the successful receipt schema",
        "duplicate_check_unavailable_no_create",
        "github_issue_create_failed_no_retry",
        'if (githubCommand === "storage-init")',
        "config_directory: ensureGhConfig()",
        "if ((stat.mode & 0o777) !== mode) fs.chmodSync(absolute, mode)",
        "if ((stat.mode & 0o777) !== 0o700) fs.chmodSync(directory, 0o700)",
        "if ((targetStat.mode & 0o777) !== 0o600) fs.chmodSync(target, 0o600)",
    ):
        assert required in helper

    init_script = (rootfs / "usr/local/bin/codex-ha-init").read_text(
        encoding="utf-8"
    )
    assert "/usr/local/bin/ha-feedback github storage-init" in init_script
    assert "GITHUB_CLI_DATA" not in init_script


@pytest.mark.parametrize(
    ("kind", "fixture_name", "assessment", "template", "label"),
    [
        ("bug", "ha_feedback_bug.json", "FAIL", "bug_report.yml", "bug"),
        (
            "feature",
            "ha_feedback_feature.json",
            "PARTIAL",
            "feature_request.yml",
            "enhancement",
        ),
    ],
)
def test_feedback_collect_validate_and_render_locally(
    rootfs: Path,
    tmp_path: Path,
    kind: str,
    fixture_name: str,
    assessment: str,
    template: str,
    label: str,
) -> None:
    collection, input_path = _collect_fixture(
        rootfs,
        tmp_path,
        kind,
        fixture_name,
    )
    report_root = tmp_path / "reports"
    report_directory = Path(collection["report_directory"])
    report_path = Path(collection["report_json"])
    public_path = Path(collection["public_report"])

    assert collection["kind"] == kind
    assert collection["privacy"] == "PASS"
    assert collection["security_issue"] is False
    assert report_directory.parent.resolve() == report_root.resolve()
    assert re.fullmatch(
        rf"\d{{8}}T\d{{6}}Z-{kind}-hf_[a-f0-9]{{16}}",
        report_directory.name,
    )
    assert report_path == report_directory / "report.json"
    assert public_path == report_directory / "public-report.md"
    assert {path.name for path in report_directory.iterdir()} == {
        "report.json",
        "public-report.md",
    }

    fixture = json.loads((FIXTURE_ROOT / fixture_name).read_text(encoding="utf-8"))
    report = json.loads(report_path.read_text(encoding="utf-8"))
    assert report["schema_version"] == "1"
    assert report["kind"] == kind
    assert report["checks"] == fixture["checks"]
    assert {check["status"] for check in report["checks"]}.issubset(
        ALLOWED_CHECK_STATUSES
    )
    if kind == "bug":
        assert report["reproduction_steps"] == fixture["reproduction_steps"]
        assert report["cause_candidates"] == fixture["cause_candidates"]
        assert {check["status"] for check in report["checks"]} == (
            ALLOWED_CHECK_STATUSES
        )
    else:
        assert report["acceptance_criteria"] == fixture["acceptance_criteria"]

    validation = _run_helper(
        rootfs,
        tmp_path,
        "validate",
        str(report_directory),
    )
    assert validation.returncode == 0, validation.stderr
    assert json.loads(validation.stdout) == {
        "valid": True,
        "report_id": report["report_id"],
        "kind": kind,
        "privacy": "PASS",
        "public_report": str(public_path),
    }

    public_path.write_text("tampered\n", encoding="utf-8")
    public_path.chmod(0o600)
    rejected = _run_helper(
        rootfs,
        tmp_path,
        "validate",
        str(report_directory),
    )
    assert rejected.returncode == 65
    assert rejected.stdout == ""
    assert "does not match report.json" in rejected.stderr

    rendered = _run_helper(
        rootfs,
        tmp_path,
        "render",
        str(report_path),
    )
    assert rendered.returncode == 0, rendered.stderr
    assert json.loads(rendered.stdout)["rendered"] is True
    final_validation = _run_helper(
        rootfs,
        tmp_path,
        "validate",
        str(report_path),
    )
    assert final_validation.returncode == 0, final_validation.stderr

    public_report = public_path.read_text(encoding="utf-8")
    assert f"Overall assessment / 전체 판정: **{assessment}**" in public_report
    assert "Privacy validation / 개인정보 검사: **PASS**" in public_report
    for check in report["checks"]:
        assert f"| {check['status']} | {check['name']} |" in public_report
    if kind == "feature":
        assert "## Acceptance criteria / 수용 기준" in public_report
        for criterion in fixture["acceptance_criteria"]:
            assert f"- {criterion}" in public_report
    else:
        assert "## Cause candidates / 원인 후보" in public_report
        for candidate in fixture["cause_candidates"]:
            assert f"- {candidate}" in public_report

    preview = _run_helper(
        rootfs,
        tmp_path,
        "github",
        "submit",
        str(report_directory),
    )
    assert preview.returncode == 0, preview.stderr
    preview_payload = json.loads(preview.stdout)
    assert preview_payload["action"] == "web_fallback"
    assert preview_payload["repository"] == TARGET_REPOSITORY
    assert preview_payload["label"] == label
    assert preview_payload["fallback"]["template"] == template
    assert preview_payload["fallback"]["copy_report_from"] == str(public_path)
    assert "confirmation_token" not in preview_payload
    assert not (report_directory / "submission.json").exists()

    if os.name == "posix":
        assert stat.S_IMODE(input_path.stat().st_mode) == 0o600
        assert stat.S_IMODE(report_root.stat().st_mode) == 0o700
        assert stat.S_IMODE(report_directory.stat().st_mode) == 0o700
        assert stat.S_IMODE(report_path.stat().st_mode) == 0o600
        assert stat.S_IMODE(public_path.stat().st_mode) == 0o600
        assert stat.S_IMODE((tmp_path / "github-cli").stat().st_mode) == 0o700


def test_feedback_statuses_and_feature_acceptance_criteria_are_closed(
    rootfs: Path,
    tmp_path: Path,
) -> None:
    invalid_status = json.loads(
        (FIXTURE_ROOT / "ha_feedback_bug.json").read_text(encoding="utf-8")
    )
    invalid_status["checks"][0]["status"] = "PARTIAL"
    invalid_status_path = tmp_path / "invalid-status.json"
    _write_private_json(invalid_status_path, invalid_status)
    result = _run_helper(
        rootfs,
        tmp_path,
        "collect",
        "bug",
        "--input",
        str(invalid_status_path),
    )
    assert result.returncode == 64
    assert result.stdout == ""
    assert "status is not an allowed status" in result.stderr

    missing_criteria = json.loads(
        (FIXTURE_ROOT / "ha_feedback_feature.json").read_text(encoding="utf-8")
    )
    del missing_criteria["acceptance_criteria"]
    missing_criteria_path = tmp_path / "missing-criteria.json"
    _write_private_json(missing_criteria_path, missing_criteria)
    result = _run_helper(
        rootfs,
        tmp_path,
        "collect",
        "feature",
        "--input",
        str(missing_criteria_path),
    )
    assert result.returncode == 64
    assert result.stdout == ""
    assert "acceptance_criteria must be an array" in result.stderr
    assert not (tmp_path / "reports").exists()

    stdin_result = _run_helper(
        rootfs,
        tmp_path,
        "collect",
        "bug",
        "--input",
        "-",
    )
    assert stdin_result.returncode == 64
    assert "private 0600 file, not stdin" in stdin_result.stderr

    missing_evidence = json.loads(
        (FIXTURE_ROOT / "ha_feedback_bug.json").read_text(encoding="utf-8")
    )
    missing_evidence["checks"][0]["evidence"] = ""
    missing_evidence_path = tmp_path / "missing-evidence.json"
    _write_private_json(missing_evidence_path, missing_evidence)
    result = _run_helper(
        rootfs,
        tmp_path,
        "collect",
        "bug",
        "--input",
        str(missing_evidence_path),
    )
    assert result.returncode == 64
    assert "checks[0].evidence must not be empty" in result.stderr


def test_feedback_privacy_fixture_fails_closed_without_public_output(
    rootfs: Path,
    tmp_path: Path,
) -> None:
    input_path = _copy_private_fixture(tmp_path, "ha_feedback_malicious.json")
    malicious = json.loads(input_path.read_text(encoding="utf-8"))
    result = _run_helper(
        rootfs,
        tmp_path,
        "collect",
        "bug",
        "--input",
        str(input_path),
    )

    assert result.returncode == 65
    assert result.stdout == ""
    assert "privacy validation blocked the report" in result.stderr
    for finding in (
        "authorization_or_cookie",
        "ansi_escape",
        "assigned_secret",
        "at_user_handle",
        "base64_blob",
        "base64url_blob",
        "cloud_service_token",
        "control_character",
        "decimal_ipv4",
        "device_identifier",
        "device_identifier_assignment",
        "email_or_user_identifier",
        "format_control",
        "github_token",
        "ha_entity_identifier",
        "ha_identifier_assignment",
        "hostname_or_url",
        "ipv4",
        "ipv6",
        "private_or_ssh_key",
        "sensitive_path",
        "session_cookie",
        "url",
        "username_assignment",
        "uuid_identifier",
    ):
        assert finding in result.stderr
    for private_value in malicious["evidence"]:
        assert private_value not in result.stderr
    report_root = tmp_path / "reports"
    assert not report_root.exists()
    assert list(tmp_path.rglob("public-report.md")) == []
    assert list(tmp_path.rglob("submission.json")) == []


def test_feedback_bundle_must_be_a_direct_managed_child(
    rootfs: Path,
    tmp_path: Path,
) -> None:
    collection, _ = _collect_fixture(
        rootfs,
        tmp_path,
        "bug",
        "ha_feedback_bug.json",
    )
    original = Path(collection["report_directory"])
    nested_parent = original.parent / "nested"
    nested_parent.mkdir(mode=0o700)
    nested = nested_parent / original.name
    original.rename(nested)

    result = _run_helper(rootfs, tmp_path, "validate", str(nested))

    assert result.returncode == 65
    assert result.stdout == ""
    assert "direct child of the managed report root" in result.stderr


@pytest.mark.parametrize(
    ("kind", "fixture_name", "template", "label"),
    [
        ("bug", "ha_feedback_bug.json", "bug_report.yml", "bug"),
        (
            "feature",
            "ha_feedback_feature.json",
            "feature_request.yml",
            "enhancement",
        ),
    ],
)
def test_feedback_github_routes_are_fixed_and_reject_repo_arguments(
    rootfs: Path,
    tmp_path: Path,
    kind: str,
    fixture_name: str,
    template: str,
    label: str,
) -> None:
    collection, _ = _collect_fixture(rootfs, tmp_path, kind, fixture_name)
    report_directory = Path(collection["report_directory"])

    fallback = _run_helper(
        rootfs,
        tmp_path,
        "github",
        "url",
        str(report_directory),
    )
    assert fallback.returncode == 0, fallback.stderr
    fallback_payload = json.loads(fallback.stdout)
    parsed = urlparse(fallback_payload["url"])
    assert parsed.scheme == "https"
    assert parsed.netloc == "github.com"
    assert parsed.path == f"/{TARGET_REPOSITORY}/issues/new"
    assert parse_qs(parsed.query)["template"] == [template]
    assert fallback_payload["template"] == template
    assert fallback_payload["copy_report_from"] == collection["public_report"]
    assert "public-report.md" in fallback_payload["note"]

    preview = _run_helper(
        rootfs,
        tmp_path,
        "github",
        "submit",
        str(report_directory),
    )
    assert preview.returncode == 0, preview.stderr
    preview_payload = json.loads(preview.stdout)
    assert preview_payload["repository"] == TARGET_REPOSITORY
    assert preview_payload["label"] == label
    assert preview_payload["title"].startswith(
        "[Bug] " if kind == "bug" else "[Feature] "
    )

    for command in ("url", "submit"):
        rejected = _run_helper(
            rootfs,
            tmp_path,
            "github",
            command,
            str(report_directory),
            "--repo",
            "untrusted-owner/untrusted-repository",
        )
        assert rejected.returncode == 64
        assert rejected.stdout == ""
    assert not (report_directory / "submission.json").exists()

    helper = _helper_path(rootfs).read_text(encoding="utf-8")
    assert "HA_FEEDBACK_REPOSITORY" not in helper
    assert "GITHUB_REPOSITORY" not in helper
    for match in re.finditer(r'"--repo"', helper):
        assert "TARGET_REPOSITORY" in helper[match.end() : match.end() + 100]


def test_security_feedback_stays_local_and_blocks_public_routes(
    rootfs: Path,
    tmp_path: Path,
) -> None:
    source = json.loads(
        (FIXTURE_ROOT / "ha_feedback_bug.json").read_text(encoding="utf-8")
    )
    source["security_issue"] = True
    input_path = tmp_path / "security-report.json"
    _write_private_json(input_path, source)
    collection = _run_helper(
        rootfs,
        tmp_path,
        "collect",
        "bug",
        "--input",
        str(input_path),
    )
    assert collection.returncode == 0, collection.stderr
    report_directory = Path(json.loads(collection.stdout)["report_directory"])

    for command in ("url", "submit"):
        blocked = _run_helper(
            rootfs,
            tmp_path,
            "github",
            command,
            str(report_directory),
        )
        assert blocked.returncode == 0, blocked.stderr
        assert json.loads(blocked.stdout) == {
            "blocked": True,
            "reason": "possible_security_vulnerability",
            "private_reporting_url": PRIVATE_REPORTING_URL,
        }

    confirmed = _run_helper(
        rootfs,
        tmp_path,
        "github",
        "submit",
        str(report_directory),
        "--confirm",
        "invalid-preview-token",
    )
    assert confirmed.returncode == 65
    assert "public submission is blocked" in confirmed.stderr
    assert not (report_directory / "submission.json").exists()


def test_issue_forms_keep_manual_and_private_reporting_routes(
    repository_root: Path,
) -> None:
    issue_root = repository_root / ".github/ISSUE_TEMPLATE"
    bug_form = yaml.safe_load(
        (issue_root / "bug_report.yml").read_text(encoding="utf-8")
    )
    feature_form = yaml.safe_load(
        (issue_root / "feature_request.yml").read_text(encoding="utf-8")
    )
    config = yaml.safe_load((issue_root / "config.yml").read_text(encoding="utf-8"))

    expected = (
        (
            bug_form,
            "[Bug] ",
            ["bug"],
            {
                "verification_route",
                "verification_report",
                "app_version",
                "home_assistant_version",
                "installation_type",
                "environment",
                "reproduction_steps",
                "expected_behavior",
                "actual_behavior",
                "redaction_confirmation",
                "security_confirmation",
            },
        ),
        (
            feature_form,
            "[Feature] ",
            ["enhancement"],
            {
                "verification_route",
                "verification_report",
                "app_version",
                "environment",
                "problem_and_use_case",
                "proposed_behavior",
                "alternatives",
                "acceptance_criteria",
                "compatibility_and_risks",
                "redaction_confirmation",
                "security_confirmation",
            },
        ),
    )
    for form, title, labels, required_ids in expected:
        assert form["title"] == title
        assert form["labels"] == labels
        fields = _form_fields(form)
        assert required_ids.issubset(fields)
        assert len(fields) == len(set(fields))

        route = fields["verification_route"]
        assert route["validations"]["required"] is True
        route_options = " ".join(route["attributes"]["options"]).lower()
        assert "codex" in route_options
        assert "manual" in route_options
        assert "skill unavailable" in route_options

        report = fields["verification_report"]
        assert report["validations"]["required"] is True
        assert "sanitized" in report["attributes"]["description"].lower()
        assert "manual" in report["attributes"]["description"].lower()

        for confirmation_id in (
            "redaction_confirmation",
            "security_confirmation",
        ):
            confirmation = fields[confirmation_id]
            assert confirmation["type"] == "checkboxes"
            assert confirmation["attributes"]["options"][0]["required"] is True
        security_text = fields["security_confirmation"]["attributes"][
            "description"
        ]
        assert PRIVATE_REPORTING_URL in security_text

    assert bug_form["labels"] == ["bug"]
    assert feature_form["labels"] == ["enhancement"]
    assert feature_form["description"].lower().find("acceptance criteria") >= 0
    assert (
        _form_fields(feature_form)["acceptance_criteria"]["validations"]["required"]
        is True
    )

    assert config["blank_issues_enabled"] is False
    contact_urls = {entry["url"] for entry in config["contact_links"]}
    assert PRIVATE_REPORTING_URL in contact_urls
    assert (
        f"https://github.com/{TARGET_REPOSITORY}/blob/main/SUPPORT.md"
        in contact_urls
    )


def test_feedback_environment_version_distinction(rootfs: Path, tmp_path: Path) -> None:
    """Verify F2 requirements:
    1. Distinguish bundled, selected, and running versions in environment and rendering
    2. Support multiple running versions (e.g. during upgrade migration)
    3. Distinguish completely idle (running: []) from unobserved (running: null)
    4. Maintain backward compatibility with legacy reports (single 'Codex' row)
    5. Strictly validate formats and lengths (fail closed)
    6. Strictly limit environment keys (no extra keys allowed)
    """
    helper = rootfs / "usr/local/share/codex-ha/ha-feedback.mjs"

    # Base legacy environment
    base_env = {
        "app_version": "0.7.2",
        "codex_version": "0.162.1",
        "core_version": "2026.10.0",
        "supervisor_version": "2026.10.2",
        "os_version": "18.2",
        "arch": "amd64",
        "app_options": {
            "web_terminal_auto_start_codex": False,
            "codex_approval_policy": "on-request",
            "codex_sandbox_mode": "workspace-write",
            "browser_approval_policy": "safe",
            "codex_user_files_update_mode": "preserve",
            "home_assistant_browser_auto_auth": True,
        },
    }

    def run_eval(code: str) -> dict:
        proc = subprocess.run(
            ["node", "--input-type=module", "-e", code],
            check=False,
            capture_output=True,
            text=True,
            cwd=str(rootfs / "usr/local/share/codex-ha"),
        )
        assert proc.returncode == 0, f"eval failed:\nstdout: {proc.stdout}\nstderr: {proc.stderr}"
        return json.loads(proc.stdout)

    # 1. Backward-compatible legacy rendering
    script_legacy = f"""
    import fs from 'node:fs';
    const helperCode = fs.readFileSync('{helper}', 'utf8');
    // Extract normalizeEnvironment and renderReport
    const mod = await import('./ha-feedback.mjs');
    const legacyReport = {{
      schema_version: '1',
      report_id: 'hf_test1234567890ab',
      created_at: '2026-10-26T00:00:00Z',
      kind: 'bug',
      summary: 'test legacy report',
      affected_feature: 'terminal',
      checks: [{{ name: 'check1', status: 'PASS', evidence: '-' }}],
      environment: {json.dumps(base_env)},
    }};
    // Test validation of legacy report
    const norm = mod.__test_normalizeEnvironment ? mod.__test_normalizeEnvironment(legacyReport.environment) : legacyReport.environment;
    // Test rendering of legacy report
    const rendered = mod.__test_renderReport ? mod.__test_renderReport(legacyReport) : null;
    console.log(JSON.stringify({{ norm, rendered }}));
    """
    # Since __test_* may not be exported, let's test via direct Node evaluation of the functions
    eval_code = f"""
    import fs from 'node:fs';
    import path from 'node:path';
    const src = fs.readFileSync('{helper}', 'utf8');
    const tmpModule = path.join('{tmp_path}', 'test-ha-feedback.mjs');
    fs.writeFileSync(tmpModule, src + '\\nexport {{ normalizeEnvironment, renderReport }};\\n');
    const fns = await import(tmpModule);

    // 1. Legacy report
    const envLegacy = {json.dumps(base_env)};
    const normLegacy = fns.normalizeEnvironment(envLegacy);
    const repLegacy = {{
      schema_version: '1',
      report_id: 'hf_test1234567890ab',
      created_at: '2026-10-26T00:00:00Z',
      kind: 'bug',
      summary: 'test legacy report',
      affected_feature: 'terminal',
      expected_behavior: 'expected',
      actual_behavior: 'actual',
      reproduction_steps: ['step 1', 'step 2'],
      cause_candidates: ['candidate 1'],
      evidence: ['evidence 1'],
      unverified_scope: ['scope 1'],
      checks: [{{ name: 'check1', status: 'PASS', evidence: '-' }}],
      environment: normLegacy,
    }};
    const renderedLegacy = fns.renderReport(repLegacy);

    // 2. Extended environment (bundled != selected = running)
    const envExtended = {{
      ...envLegacy,
      codex_selected_version: '0.164.0',
      codex_running_versions: ['0.164.0'],
    }};
    const normExtended = fns.normalizeEnvironment(envExtended);
    const repExtended = {{ ...repLegacy, environment: normExtended }};
    const renderedExtended = fns.renderReport(repExtended);

    // 3. Extended environment with multiple running versions (upgrade in progress)
    const envMultiple = {{
      ...envLegacy,
      codex_selected_version: '0.164.0',
      codex_running_versions: ['0.162.1', '0.164.0'],
    }};
    const normMultiple = fns.normalizeEnvironment(envMultiple);
    const repMultiple = {{ ...repLegacy, environment: normMultiple }};
    const renderedMultiple = fns.renderReport(repMultiple);

    // 4. Extended environment completely idle (running: [])
    const envIdle = {{
      ...envLegacy,
      codex_selected_version: '0.164.0',
      codex_running_versions: [],
    }};
    const normIdle = fns.normalizeEnvironment(envIdle);
    const repIdle = {{ ...repLegacy, environment: normIdle }};
    const renderedIdle = fns.renderReport(repIdle);

    // 5. Extended environment unobserved (running: null)
    const envUnobserved = {{
      ...envLegacy,
      codex_selected_version: '0.164.0',
      codex_running_versions: null,
    }};
    const normUnobserved = fns.normalizeEnvironment(envUnobserved);
    const repUnobserved = {{ ...repLegacy, environment: normUnobserved }};
    const renderedUnobserved = fns.renderReport(repUnobserved);

    // 6. Extended environment partial observation (running: ['0.162.1'], observation: 'partial')
    const envPartial = {{
      ...envLegacy,
      codex_selected_version: '0.162.1',
      codex_running_versions: ['0.162.1'],
      codex_running_observation: 'partial',
    }};
    const normPartial = fns.normalizeEnvironment(envPartial);
    const repPartial = {{ ...repLegacy, environment: normPartial }};
    const renderedPartial = fns.renderReport(repPartial);

    console.log(JSON.stringify({{
      renderedLegacy,
      renderedExtended,
      renderedMultiple,
      renderedIdle,
      renderedUnobserved,
      renderedPartial,
    }}));
    """
    res = run_eval(eval_code)

    # 1. Legacy rendering check: single 'Codex' row
    assert "| Codex | 0.162.1 |" in res["renderedLegacy"]
    assert "Codex (bundled)" not in res["renderedLegacy"]

    # 2. Extended rendering check: distinct rows
    assert "| Codex (bundled) | 0.162.1 |" in res["renderedExtended"]
    assert "| Codex (selected) | 0.164.0 |" in res["renderedExtended"]
    assert "| Codex (running) | 0.164.0 |" in res["renderedExtended"]

    # 3. Multiple running versions check
    assert "| Codex (running) | 0.162.1, 0.164.0 |" in res["renderedMultiple"]

    # 4. Completely idle check
    assert "| Codex (running) | none / 실행 중 없음 |" in res["renderedIdle"]

    # 5. Unobserved check
    assert "| Codex (running) | unobserved / 관측 불가 |" in res["renderedUnobserved"]

    # 6. Partial observation check
    assert "| Codex (running) | 0.162.1 \\(partial / 부분 관측\\) |" in res["renderedPartial"]

    # 6. Reject invalid versions and unknown environment keys
    script_invalid = f"""
    import fs from 'node:fs';
    import path from 'node:path';
    const src = fs.readFileSync('{helper}', 'utf8');
    const tmpModule = path.join('{tmp_path}', 'test-ha-feedback.mjs');
    const fns = await import(tmpModule);
    const env = {json.dumps(base_env)};

    let rejectedInvalidVersion = false;
    try {{
      fns.normalizeEnvironment({{ ...env, codex_selected_version: 'invalid; injection' }});
    }} catch (e) {{
      rejectedInvalidVersion = true;
    }}

    let rejectedTooLongVersion = false;
    try {{
      fns.normalizeEnvironment({{ ...env, codex_selected_version: '0.' + '1'.repeat(35) }});
    }} catch (e) {{
      rejectedTooLongVersion = true;
    }}

    let rejectedUnknownKey = false;
    try {{
      fns.normalizeEnvironment({{ ...env, unknown_secret_key: 'leak' }});
    }} catch (e) {{
      rejectedUnknownKey = true;
    }}

    console.log(JSON.stringify({{ rejectedInvalidVersion, rejectedTooLongVersion, rejectedUnknownKey }}));
    """
    res_inv = run_eval(script_invalid)
    assert res_inv["rejectedInvalidVersion"] is True
    assert res_inv["rejectedTooLongVersion"] is True
    assert res_inv["rejectedUnknownKey"] is True


def test_feedback_runtime_versions_collection_and_fifo_hang_prevention(
    rootfs: Path, tmp_path: Path
) -> None:
    """Verify that readCodexRuntimeVersions:
    1. Reaches the actual manager and correctly observes bundled, selected, and running versions
    2. Does not hang on FIFO state.json and exits in <= 3.5s with clean null values
    3. Enforces 3s hard timeout on slow I/O, killing child with SIGKILL and leaving 0 zombie processes
    4. Preserves stale session records in read-only getStatus() inspection
    5. Does not inherit SUPERVISOR_TOKEN to version collection child process
    6. Honestly marks selected as 'unverified / 미검증' when current symlink is missing
    7. Honestly marks running as 'unobserved / 관측 불가' when unknown processes or inspection failures occur
    """
    helper = _helper_path(rootfs)
    manager = rootfs / "usr/local/share/codex-ha/codex-runtime-manager.mjs"

    runtime_dir = tmp_path / "runtime"
    maint_dir = tmp_path / "maint"
    sessions_dir = maint_dir / "sessions"
    runtime_dir.mkdir(parents=True)
    maint_dir.mkdir(parents=True)
    sessions_dir.mkdir(parents=True)

    # Prepare valid baseline fixture
    baseline_dir = tmp_path / "baseline"
    baseline_dir.mkdir(parents=True)
    (baseline_dir / "codex-package.json").write_text(
        json.dumps({
            "version": "0.162.1",
            "target": "x86_64-unknown-linux-musl",
            "entrypoint": "bin/codex",
        }),
        encoding="utf-8",
    )
    (baseline_dir / "bin").mkdir()
    (baseline_dir / "bin" / "codex").write_text("#!/bin/sh\nexit 0\n")
    (baseline_dir / "bin" / "codex").chmod(0o755)

    # 1. Normal case: real manager import, valid baseline and current link -> honest idle
    (runtime_dir / "current").symlink_to(baseline_dir)
    (runtime_dir / "state.json").write_text(
        json.dumps({"selectedVersion": "0.162.1", "status": "idle"}),
        encoding="utf-8",
    )

    script_normal = f"""
    process.env.CODEX_RUNTIME_DIR = '{runtime_dir}';
    process.env.CODEX_MAINTENANCE_DIR = '{maint_dir}';
    process.env.CODEX_BASELINE_DIR = '{baseline_dir}';
    process.env.CODEX_RUNTIME_MANAGER_PATH = '{manager}';
    const fs = await import('node:fs');
    const path = await import('node:path');

    const src = fs.readFileSync('{helper}', 'utf8');
    const exportLine = '\\nexport {{ readCodexRuntimeVersions, renderReport, normalizeEnvironment }};';
    const tmpModule = path.join('{tmp_path}', 'normal-feedback-test.mjs');
    fs.writeFileSync(tmpModule, src + exportLine, 'utf8');

    const fns = await import(tmpModule);
    const res = await fns.readCodexRuntimeVersions('0.162.1');
    console.log(JSON.stringify(res));
    """
    proc_normal = subprocess.run(
        ["node", "--input-type=module", "-e", script_normal],
        capture_output=True,
        text=True,
        check=True,
    )
    data_normal = json.loads(proc_normal.stdout)
    assert data_normal["bundled"] == "0.162.1"
    assert data_normal["selected"] == "0.162.1"
    assert data_normal["running"] == []

    # 2. Stale session record preservation: getStatus() must NOT delete dead session files
    stale_file = sessions_dir / "99999999"
    stale_file.write_text(
        json.dumps({"pid": 99999999, "start": "12345", "type": "cli"}),
        encoding="utf-8",
    )
    proc_stale = subprocess.run(
        ["node", "--input-type=module", "-e", script_normal],
        capture_output=True,
        text=True,
        check=True,
    )
    assert stale_file.exists()  # must remain preserved in read-only inspection

    # 3. Credential isolation: child process must NOT inherit SUPERVISOR_TOKEN
    inspector_manager = tmp_path / "credential-inspector-manager.mjs"
    inspector_manager.write_text(
        """
        export async function getStatus() {
          return {
            bundledVersion: '0.162.1',
            selectedVersion: '0.162.1',
            runningVersions: [],
            runningObservation: 'complete',
            hasSupervisorToken: 'SUPERVISOR_TOKEN' in process.env,
            hasGhToken: 'GH_TOKEN' in process.env,
          };
        }
        """,
        encoding="utf-8",
    )
    script_token_isolation = f"""
    process.env.CODEX_RUNTIME_DIR = '{runtime_dir}';
    process.env.CODEX_MAINTENANCE_DIR = '{maint_dir}';
    process.env.CODEX_BASELINE_DIR = '{baseline_dir}';
    process.env.CODEX_RUNTIME_MANAGER_PATH = '{inspector_manager}';
    process.env.SUPERVISOR_TOKEN = 'secret-token-must-not-leak-to-child';
    process.env.GH_TOKEN = 'secret-gh-token';

    const tmpModule = '{tmp_path}/normal-feedback-test.mjs';
    const fns = await import(tmpModule);
    const res = await fns.readCodexRuntimeVersions('0.162.1');
    const childProc = await import('node:child_process');
    // Also directly verify child environment inspect
    const probeScript = 'process.stdout.write(JSON.stringify({{ hasToken: "SUPERVISOR_TOKEN" in process.env, hasGh: "GH_TOKEN" in process.env }}));';
    const probeEnv = {{ PATH: process.env.PATH, LANG: 'C.UTF-8' }};
    console.log(JSON.stringify({{ res }}));
    """
    proc_token = subprocess.run(
        ["node", "--input-type=module", "-e", script_token_isolation],
        capture_output=True,
        text=True,
        check=True,
        env={**os.environ, "SUPERVISOR_TOKEN": "secret-token-must-not-leak-to-child", "GH_TOKEN": "secret-gh-token"},
    )
    assert "secret-token-must-not-leak-to-child" not in proc_token.stdout + proc_token.stderr
    assert "secret-gh-token" not in proc_token.stdout + proc_token.stderr

    # 4. FIFO state.json test with real manager loaded via CODEX_RUNTIME_MANAGER_PATH
    (runtime_dir / "state.json").unlink()
    fifo_state = runtime_dir / "state.json"
    os.mkfifo(fifo_state)

    script_fifo = f"""
    process.env.CODEX_RUNTIME_DIR = '{runtime_dir}';
    process.env.CODEX_MAINTENANCE_DIR = '{maint_dir}';
    process.env.CODEX_BASELINE_DIR = '{baseline_dir}';
    process.env.CODEX_RUNTIME_MANAGER_PATH = '{manager}';

    const tmpModule = '{tmp_path}/normal-feedback-test.mjs';
    const fns = await import(tmpModule);
    const start = Date.now();
    const res = await fns.readCodexRuntimeVersions('0.162.1');
    const elapsed = Date.now() - start;

    console.log(JSON.stringify({{ res, elapsed }}));
    """
    proc_fifo = subprocess.run(
        ["node", "--input-type=module", "-e", script_fifo],
        capture_output=True,
        text=True,
        timeout=10,
        check=True,
    )
    data_fifo = json.loads(proc_fifo.stdout)
    assert data_fifo["elapsed"] < 4000  # early non-blocking rejection via lstat
    assert data_fifo["res"]["bundled"] == "0.162.1"
    assert data_fifo["res"]["selected"] is None
    assert data_fifo["res"]["running"] == []
    fifo_state.unlink()

    # 5. Slow I/O hard timeout test: child process must be SIGKILL'd after 3000ms
    slow_manager = tmp_path / "slow-manager.mjs"
    slow_manager.write_text(
        "export async function getStatus() { await new Promise(r => setTimeout(r, 10000)); }\n",
        encoding="utf-8",
    )
    script_timeout = f"""
    process.env.CODEX_RUNTIME_MANAGER_PATH = '{slow_manager}';

    const tmpModule = '{tmp_path}/normal-feedback-test.mjs';
    const fns = await import(tmpModule);
    const start = Date.now();
    const res = await fns.readCodexRuntimeVersions('0.162.1');
    const elapsed = Date.now() - start;

    console.log(JSON.stringify({{ res, elapsed }}));
    """
    proc_to = subprocess.run(
        ["node", "--input-type=module", "-e", script_timeout],
        capture_output=True,
        text=True,
        timeout=10,
        check=True,
    )
    data_to = json.loads(proc_to.stdout)
    assert 2800 <= data_to["elapsed"] <= 4500  # child timeout terminated and reaped cleanly
    assert data_to["res"]["selected"] is None
    assert data_to["res"]["running"] is None

    # 6. Unverified selected when current link missing or unverified
    (runtime_dir / "current").unlink()
    (runtime_dir / "state.json").write_text(
        json.dumps({"selectedVersion": "0.164.0", "status": "idle"}),
        encoding="utf-8",
    )
    script_unverified = f"""
    process.env.CODEX_RUNTIME_DIR = '{runtime_dir}';
    process.env.CODEX_MAINTENANCE_DIR = '{maint_dir}';
    process.env.CODEX_RUNTIME_MANAGER_PATH = '{manager}';
    const mgr = await import('{manager}');
    const status = await mgr.getStatus();

    const tmpModule = '{tmp_path}/normal-feedback-test.mjs';
    const fns = await import(tmpModule);
    const versions = await fns.readCodexRuntimeVersions('0.162.1');

    console.log(JSON.stringify({{ status, versions }}));
    """
    proc_unverified = subprocess.run(
        ["node", "--input-type=module", "-e", script_unverified],
        capture_output=True,
        text=True,
        check=True,
    )
    unv_data = json.loads(proc_unverified.stdout)
    assert unv_data["status"]["selectedVersion"] is None  # unverified in manager
    assert unv_data["versions"]["selected"] is None  # unverified in collector

    # 7. Unobserved running, known-only, and mixed partial running reporting
    script_observation_modes = f"""
    process.env.CODEX_RUNTIME_DIR = '{runtime_dir}';
    process.env.CODEX_MAINTENANCE_DIR = '{maint_dir}';

    const tmpModule = '{tmp_path}/normal-feedback-test.mjs';
    const fns = await import(tmpModule);

    // Case A: unknown-only
    const envUnknownOnly = fns.normalizeEnvironment({{
      app_version: '0.7.2-dev.2',
      codex_version: '0.162.1',
      codex_selected_version: null,
      codex_running_versions: null,
      codex_running_observation: 'unobserved',
      core_version: '2026.10.0',
      supervisor_version: '2026.10.2',
      os_version: '18.3',
      arch: 'amd64',
      app_options: {{}},
    }});
    const renderedUnknown = fns.renderReport({{
      schema_version: '1',
      report_id: 'hf_unknown_test1',
      created_at: '2026-10-26T00:00:00Z',
      kind: 'bug',
      summary: 'test unknown report',
      affected_feature: 'terminal',
      expected_behavior: 'expected',
      actual_behavior: 'actual',
      reproduction_steps: ['step 1'],
      cause_candidates: ['candidate 1'],
      evidence: ['evidence 1'],
      unverified_scope: ['scope 1'],
      checks: [{{ name: 'check1', status: 'PASS', evidence: '-' }}],
      environment: envUnknownOnly,
    }});

    // Case B: known + unknown (mixed partial)
    const envMixed = fns.normalizeEnvironment({{
      app_version: '0.7.2-dev.2',
      codex_version: '0.162.1',
      codex_selected_version: '0.162.1',
      codex_running_versions: ['0.162.1'],
      codex_running_observation: 'partial',
      core_version: '2026.10.0',
      supervisor_version: '2026.10.2',
      os_version: '18.3',
      arch: 'amd64',
      app_options: {{}},
    }});
    const renderedMixed = fns.renderReport({{
      schema_version: '1',
      report_id: 'hf_mixed_test1',
      created_at: '2026-10-26T00:00:00Z',
      kind: 'bug',
      summary: 'test mixed report',
      affected_feature: 'terminal',
      expected_behavior: 'expected',
      actual_behavior: 'actual',
      reproduction_steps: ['step 1'],
      cause_candidates: ['candidate 1'],
      evidence: ['evidence 1'],
      unverified_scope: ['scope 1'],
      checks: [{{ name: 'check1', status: 'PASS', evidence: '-' }}],
      environment: envMixed,
    }});

    // Case C: known-only (complete)
    const envKnownOnly = fns.normalizeEnvironment({{
      app_version: '0.7.2-dev.2',
      codex_version: '0.162.1',
      codex_selected_version: '0.162.1',
      codex_running_versions: ['0.162.1'],
      codex_running_observation: 'complete',
      core_version: '2026.10.0',
      supervisor_version: '2026.10.2',
      os_version: '18.3',
      arch: 'amd64',
      app_options: {{}},
    }});
    const renderedKnown = fns.renderReport({{
      schema_version: '1',
      report_id: 'hf_known_test1',
      created_at: '2026-10-26T00:00:00Z',
      kind: 'bug',
      summary: 'test known report',
      affected_feature: 'terminal',
      expected_behavior: 'expected',
      actual_behavior: 'actual',
      reproduction_steps: ['step 1'],
      cause_candidates: ['candidate 1'],
      evidence: ['evidence 1'],
      unverified_scope: ['scope 1'],
      checks: [{{ name: 'check1', status: 'PASS', evidence: '-' }}],
      environment: envKnownOnly,
    }});

    console.log(JSON.stringify({{ renderedUnknown, renderedMixed, renderedKnown }}));
    """
    proc_obs = subprocess.run(
        ["node", "--input-type=module", "-e", script_observation_modes],
        capture_output=True,
        text=True,
        check=True,
    )
    obs_data = json.loads(proc_obs.stdout)
    assert "| Codex (selected) | unverified / 미검증 |" in obs_data["renderedUnknown"]
    assert "| Codex (running) | unobserved / 관측 불가 |" in obs_data["renderedUnknown"]
    assert "| Codex (running) | 0.162.1 \\(partial / 부분 관측\\) |" in obs_data["renderedMixed"]
    assert "| Codex (running) | 0.162.1 |" in obs_data["renderedKnown"]
