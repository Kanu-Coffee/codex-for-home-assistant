import os
import re
import shutil
import subprocess
import tomllib
from pathlib import Path

import pytest


PROTECTED_CONFIG_PATTERNS = [
    "/config/secrets.yaml",
    "/config/**/secrets.yaml",
    "/config/.storage",
]


def test_codex_admin_requirements_deny_sensitive_reads(rootfs: Path) -> None:
    requirements_path = rootfs / "etc/codex/requirements.toml"
    requirements = tomllib.loads(requirements_path.read_text(encoding="utf-8"))

    assert requirements == {
        "allowed_sandbox_modes": ["read-only", "workspace-write"],
        "permissions": {
            "filesystem": {"deny_read": PROTECTED_CONFIG_PATTERNS}
        }
    }


def test_codex_admin_requirements_are_image_managed(
    addon_root: Path,
) -> None:
    dockerfile = (addon_root / "Dockerfile").read_text(encoding="utf-8")

    assert "COPY rootfs /" in dockerfile
    assert "/etc/codex/requirements.toml" in dockerfile


def _validate_sensitive_paths(rootfs: Path, config_root: Path) -> subprocess.CompletedProcess[str]:
    policy = rootfs / "usr/local/lib/codex-ha/sensitive-path-policy.sh"
    return subprocess.run(
        [
            "bash",
            "-c",
            '. "$1"; codex_ha_sensitive_paths_validate "$2"',
            "sensitive-path-policy-test",
            str(policy),
            str(config_root),
        ],
        check=False,
        capture_output=True,
        text=True,
        timeout=5,
    )


def test_sensitive_path_integrity_check_accepts_normal_home_assistant_tree(
    tmp_path: Path, rootfs: Path
) -> None:
    config_root = tmp_path / "config"
    storage = config_root / ".storage"
    nested = config_root / "packages" / "lighting"
    storage.mkdir(parents=True)
    nested.mkdir(parents=True)
    (config_root / "secrets.yaml").write_text("fake: value\n", encoding="utf-8")
    (nested / "secrets.yaml").write_text("nested: fake\n", encoding="utf-8")
    (storage / "core.config_entries").write_text("{}\n", encoding="utf-8")
    (config_root / "configuration.yaml").write_text("default_config:\n", encoding="utf-8")

    result = _validate_sensitive_paths(rootfs, config_root)

    assert result.returncode == 0, result.stderr
    assert result.stdout == ""


def test_sensitive_path_integrity_check_redacts_traversal_errors(
    tmp_path: Path, rootfs: Path
) -> None:
    config_root = tmp_path / "config"
    unreadable = config_root / "unreadable"
    unreadable.mkdir(parents=True)
    unreadable.chmod(0)
    try:
        result = _validate_sensitive_paths(rootfs, config_root)
    finally:
        unreadable.chmod(0o700)

    assert result.returncode == 78
    assert result.stdout == ""
    assert result.stderr == ""


@pytest.mark.parametrize("protected_area", ["secrets", "storage"])
def test_sensitive_path_integrity_check_rejects_preexisting_hardlink_alias(
    tmp_path: Path, rootfs: Path, protected_area: str
) -> None:
    config_root = tmp_path / "config"
    storage = config_root / ".storage"
    storage.mkdir(parents=True)
    protected = (
        config_root / "secrets.yaml"
        if protected_area == "secrets"
        else storage / "core.config_entries"
    )
    protected.write_text("fake-sensitive-fixture\n", encoding="utf-8")
    (config_root / "unprotected-alias").hardlink_to(protected)

    result = _validate_sensitive_paths(rootfs, config_root)

    assert result.returncode == 1
    assert "fake-sensitive-fixture" not in result.stdout + result.stderr
    assert str(config_root) not in result.stdout + result.stderr


@pytest.mark.parametrize("protected_area", ["secrets", "storage-root", "storage-child"])
def test_sensitive_path_integrity_check_rejects_symbolic_links(
    tmp_path: Path, rootfs: Path, protected_area: str
) -> None:
    config_root = tmp_path / "config"
    config_root.mkdir()
    target = config_root / "target"
    target.write_text("fake-sensitive-fixture\n", encoding="utf-8")
    if protected_area == "secrets":
        (config_root / "secrets.yaml").symlink_to(target)
    elif protected_area == "storage-root":
        (config_root / ".storage").symlink_to(config_root)
    else:
        storage = config_root / ".storage"
        storage.mkdir()
        (storage / "core.config_entries").symlink_to(target)

    result = _validate_sensitive_paths(rootfs, config_root)

    assert result.returncode == 1
    assert "fake-sensitive-fixture" not in result.stdout + result.stderr


@pytest.mark.parametrize(
    "protected_area", ["root-secrets", "nested-secrets", "storage-child"]
)
def test_sensitive_path_integrity_check_rejects_named_pipes_without_disclosure(
    tmp_path: Path, rootfs: Path, protected_area: str
) -> None:
    config_root = tmp_path / "config"
    config_root.mkdir()
    if protected_area == "root-secrets":
        fifo = config_root / "secrets.yaml"
    elif protected_area == "nested-secrets":
        nested = config_root / "packages" / "lighting"
        nested.mkdir(parents=True)
        fifo = nested / "secrets.yaml"
    else:
        storage = config_root / ".storage"
        storage.mkdir()
        fifo = storage / "fake-sensitive-fifo"
    os.mkfifo(fifo, mode=0o600)

    result = _validate_sensitive_paths(rootfs, config_root)

    assert result.returncode == 1
    assert result.stdout == ""
    assert result.stderr == ""


def test_sensitive_path_integrity_check_is_enforced_at_init_and_codex_launch(
    rootfs: Path,
) -> None:
    for executable in ("codex", "codex-ha-init"):
        source = (rootfs / f"usr/local/bin/{executable}").read_text(encoding="utf-8")
        assert ". /usr/local/lib/codex-ha/sensitive-path-policy.sh" in source
        assert "codex_ha_sensitive_paths_validate /config" in source


def test_apparmor_profile_enforces_fixed_sensitive_paths(
    addon_root: Path,
) -> None:
    profile_path = addon_root / "apparmor.txt"
    profile = profile_path.read_text(encoding="utf-8")

    assert re.search(r"^profile codex_home_assistant\b", profile, re.MULTILINE)
    assert "flags=(attach_disconnected,mediate_deleted)" in profile
    assert "complain" not in profile
    assert "/config/{,**} rwklix," in profile

    required_denials = (
        "deny /config/secrets.yaml rwklx,",
        "deny /config/**/secrets.yaml rwklx,",
        "deny /config/.storage rwklx,",
        "deny /config/.storage/ wklx,",
        "deny /config/.storage/**/ wklx,",
        "deny /config/.storage/**[^/] rwklx,",
        "deny /proc/*/environ r,",
        "deny /proc/*/task/*/environ r,",
    )
    for denial in required_denials:
        # The bwrap child must retain every confidentiality deny after the
        # sandbox setup transition.
        assert profile.count(denial) == 2

    config_denials = re.findall(r"^\s*deny (/config/\S+)", profile, re.MULTILINE)
    expected_config_denials = [
        "/config/secrets.yaml",
        "/config/**/secrets.yaml",
        "/config/.storage",
        "/config/.storage/",
        "/config/.storage/**/",
        "/config/.storage/**[^/]",
    ]
    assert config_denials == expected_config_denials * 2
    assert "/config/** r," not in profile
    assert "apparmor: false" not in profile


def test_apparmor_scopes_bubblewrap_mount_operations_to_child_profile(
    addon_root: Path,
) -> None:
    profile = (addon_root / "apparmor.txt").read_text(encoding="utf-8")

    # HAOS currently ships an AppArmor 3.1 parser. Its ABI does not mediate
    # user namespaces, while Home Assistant Supervisor disables Docker's
    # seccomp profile for apps. An explicit `userns,` rule would not parse on
    # HAOS; ABI 3.0 preserves that compatible behavior on newer parsers too.
    assert profile.startswith("abi <abi/3.0>,\n")
    assert not re.search(r"^\s*userns\b", profile, re.MULTILINE)

    transitions = re.findall(r"^\s*(\S+) Cx -> (\S+),$", profile, re.MULTILINE)
    assert transitions == [("/usr/bin/bwrap", "codex_bwrap")]
    assert re.search(
        r"^  profile codex_bwrap flags=\(attach_disconnected,mediate_deleted\) \{",
        profile,
        re.MULTILINE,
    )
    assert "    /usr/local/libexec/codex-real ix," in profile
    assert "/init ix," in profile
    assert not re.search(r"(?:/init|codex-ha-init|codex-real) Cx ->", profile)

    # Namespace mount privileges must occur only in the nested profile, never
    # in the S6/init parent profile.
    for operation in ("mount", "umount", "pivot_root"):
        assert profile.count(f"    {operation},") == 1
        assert not re.search(rf"^  {operation},$", profile, re.MULTILINE)

    assert "capability sys_admin" not in profile
    assert not re.search(r"\b[Uu][xX]\b", profile)


def test_apparmor_avoids_a_broken_privilege_gaining_feedback_transition(
    addon_root: Path,
) -> None:
    profile = (addon_root / "apparmor.txt").read_text(encoding="utf-8")

    # Codex bubblewrap commands run with no_new_privs. A child profile that
    # denies GitHub credentials in codex_bwrap and then grants them to
    # ha-feedback would be a privilege-gaining transition and fail with EPERM
    # on HAOS. Credential isolation therefore needs a future broker rather
    # than an AppArmor Cx escape from the sandbox.
    assert "ha_feedback" not in profile
    assert "/data/github-cli" not in profile
    assert "/data/github-cli" not in (
        addon_root / "rootfs/etc/codex/requirements.toml"
    ).read_text(encoding="utf-8")


def test_apparmor_profile_parses_when_parser_is_available(
    addon_root: Path,
) -> None:
    parser = shutil.which("apparmor_parser")
    if parser is None:
        pytest.skip("apparmor_parser is not installed")

    profile_path = addon_root / "apparmor.txt"
    result = subprocess.run(
        [
            parser,
            "--skip-kernel-load",
            "--skip-cache",
            "--names",
            str(profile_path),
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    assert set(result.stdout.splitlines()) == {
        "codex_home_assistant",
        "codex_home_assistant//codex_bwrap",
    }
