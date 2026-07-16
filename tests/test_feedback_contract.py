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
    assert addon_config["version"] == "0.6.0"
    assert "/feedback/" in (repository_root / ".gitignore").read_text(
        encoding="utf-8"
    )
    dockerfile = (addon_root / "Dockerfile").read_text(encoding="utf-8")
    assert "ARG BUILD_VERSION=0.6.0" in dockerfile
    assert "ARG GH_VERSION=2.93.0" in dockerfile
    assert (
        "ARG GH_SHA256="
        "02d1290eba130e0b896f3709ffff22e1c75a51475ddb70476a85abc6b5807af0"
    ) in dockerfile
    assert 'gh_archive="gh_${GH_VERSION}_linux_amd64.tar.gz"' in dockerfile
    assert (
        '"https://github.com/cli/cli/releases/download/'
        'v${GH_VERSION}/${gh_archive}"'
    ) in dockerfile
    assert (
        '"${GH_SHA256}" "/tmp/${gh_archive}" '
        "| sha256sum --check --strict -"
    ) in dockerfile
    assert (
        'install -m 0755 "/tmp/gh_${GH_VERSION}_linux_amd64/bin/gh" '
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
        'const DEFAULT_PREVIEW_ROOT = "/run/codex-ha/ha-feedback-previews"',
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
    ):
        assert required in helper


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
