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
        assert (
            "codex_ha_sensitive_paths_enforce /config" in source
            or "codex_ha_sensitive_paths_validate /config" in source
        )


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
    assert transitions == [(path, "codex_bwrap") for path in [
        "/usr/local/lib/codex-ha/codex-baseline/codex-resources/bwrap",
        "/data/codex-runtime/releases/*/codex-resources/bwrap",
        "/data/codex-runtime/staging/.extract-*/codex-resources/bwrap",
    ]]
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


def test_sensitive_path_policy_code_distinction_between_unsafe_shape_and_unverifiable(
    tmp_path: Path, rootfs: Path
) -> None:
    """Verify distinct return codes:
    0  - clean tree
    1  - unsafe shape (symlink, broken symlink, hardlink alias, FIFO)
    78 - unverifiable (unreadable directory, unreadable protected path, missing root)
    73 - preparation failure (mktemp failure)
    """
    config_root = tmp_path / "config"
    storage = config_root / ".storage"
    config_root.mkdir(parents=True)
    storage.mkdir(parents=True)
    secrets_file = config_root / "secrets.yaml"
    secrets_file.write_text("secret: 1\n", encoding="utf-8")
    (storage / "core.config").write_text("{}\n", encoding="utf-8")

    # 1. Clean tree -> 0
    res = _validate_sensitive_paths(rootfs, config_root)
    assert res.returncode == 0

    # 2. Unreadable .storage tree -> 78 (permission denied / inspection incomplete, NOT 1)
    storage.chmod(0)
    try:
        res = _validate_sensitive_paths(rootfs, config_root)
        assert res.returncode == 78
    finally:
        storage.chmod(0o700)

    # 3. Unreadable general directory -> 78
    sub = config_root / "custom_components"
    sub.mkdir()
    sub.chmod(0)
    try:
        res = _validate_sensitive_paths(rootfs, config_root)
        assert res.returncode == 78
    finally:
        sub.chmod(0o700)

    # 4. Missing root -> 78
    res = _validate_sensitive_paths(rootfs, tmp_path / "nonexistent")
    assert res.returncode == 78

    # 4b. Non-absolute root path -> 78
    policy = rootfs / "usr/local/lib/codex-ha/sensitive-path-policy.sh"
    res_rel = subprocess.run(
        ["bash", "-c", f'. "{policy}"; codex_ha_sensitive_paths_validate "relative/path"'],
        check=False,
        capture_output=True,
        text=True,
    )
    assert res_rel.returncode == 78

    # 4c. Root path is a symlink -> 1 (unsafe shape, not 78)
    root_symlink = tmp_path / "symlink_root"
    root_symlink.symlink_to(config_root)
    res_root_link = _validate_sensitive_paths(rootfs, root_symlink)
    assert res_root_link.returncode == 1

    # 4d. Root path is a broken symlink -> 1 (unsafe shape)
    root_broken = tmp_path / "broken_root"
    root_broken.symlink_to(tmp_path / "does-not-exist")
    res_root_broken = _validate_sensitive_paths(rootfs, root_broken)
    assert res_root_broken.returncode == 1

    # 4e. Root path is a regular file or FIFO -> 1 (unsafe shape)
    root_file = tmp_path / "regular_file_root"
    root_file.write_text("not a dir\n", encoding="utf-8")
    res_root_file = _validate_sensitive_paths(rootfs, root_file)
    assert res_root_file.returncode == 1

    # 5. Broken symlink -> 1 (unsafe shape)
    broken_link = config_root / "packages"
    broken_link.mkdir()
    (broken_link / "secrets.yaml").symlink_to(tmp_path / "does-not-exist")
    try:
        res = _validate_sensitive_paths(rootfs, config_root)
        assert res.returncode == 1
    finally:
        shutil.rmtree(broken_link)

    # 6. Preparation failure (mktemp fails) -> 73
    policy = rootfs / "usr/local/lib/codex-ha/sensitive-path-policy.sh"
    res_mktemp_fail = subprocess.run(
        [
            "bash",
            "-c",
            'function /bin/mktemp { return 1; }; export -f /bin/mktemp; . "$1"; codex_ha_sensitive_paths_validate "$2"',
            "prep-fail-test",
            str(policy),
            str(config_root),
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    assert res_mktemp_fail.returncode == 73


def test_codex_wrapper_distinguishes_unsafe_link_vs_restricted_access_messages(
    tmp_path: Path, rootfs: Path
) -> None:
    """Verify that the production codex wrapper and init caller output distinct allowlisted messages:
    - code 1 (unsafe shape): 'protected Home Assistant paths have an unsafe link or file type'
    - code 78 (unverifiable): 'cannot verify protected Home Assistant path integrity (access or traversal restricted)'
    - code 73 (preparation): 'failed to prepare temporary storage for path integrity verification'
    - does not leak filenames, secrets or paths
    - exercises actual wrapper in bwrap sandbox and shared enforce helper
    """
    config_root = tmp_path / "config"
    storage = config_root / ".storage"
    config_root.mkdir(parents=True)
    storage.mkdir(parents=True)
    secrets_file = config_root / "secrets.yaml"
    secrets_file.write_text("super_secret_value_12345\n", encoding="utf-8")
    (storage / "core.config").write_text("{}\n", encoding="utf-8")

    def run_bwrap_codex(cfg_path: Path, is_symlink: bool = False, extra_mounts: list[str] | None = None) -> subprocess.CompletedProcess:
        bwrap_args = [
            "bwrap",
            "--ro-bind", "/usr", "/usr",
            "--ro-bind", "/bin", "/bin",
            "--ro-bind", "/lib", "/lib",
            "--ro-bind", "/lib64", "/lib64",
            "--dev", "/dev",
            "--proc", "/proc",
            "--tmpfs", "/tmp",
            "--tmpfs", "/run",
            "--ro-bind", str(rootfs / "usr/local"), "/usr/local",
        ]
        if is_symlink:
            bwrap_args.extend(["--symlink", str(cfg_path), "/config"])
        else:
            bwrap_args.extend(["--dir", "/config", "--ro-bind", str(cfg_path), "/config"])
        if extra_mounts:
            bwrap_args.extend(extra_mounts)
        bwrap_args.extend(["bash", "/usr/local/bin/codex", "--version"])
        return subprocess.run(
            bwrap_args,
            check=False,
            capture_output=True,
            text=True,
        )

    # 1. Actual wrapper with root /config being a symlink -> code 78, unsafe message
    symlink_target = tmp_path / "somewhere"
    symlink_target.mkdir(parents=True)
    res_root_symlink = run_bwrap_codex(symlink_target, is_symlink=True)
    assert res_root_symlink.returncode == 78
    assert "codex: protected Home Assistant paths have an unsafe link or file type; Codex will not start" in res_root_symlink.stderr
    assert "codex-real" not in res_root_symlink.stderr + res_root_symlink.stdout

    # 2. Actual wrapper with /config/secrets.yaml being a symlink -> code 78, unsafe message
    secrets_file.unlink()
    secrets_file.symlink_to(symlink_target)
    res_secrets_symlink = run_bwrap_codex(config_root)
    assert res_secrets_symlink.returncode == 78
    assert "codex: protected Home Assistant paths have an unsafe link or file type; Codex will not start" in res_secrets_symlink.stderr
    assert "super_secret_value_12345" not in res_secrets_symlink.stderr + res_secrets_symlink.stdout

    # 3. Actual wrapper with unreadable directory in /config -> code 78, restricted message
    secrets_file.unlink()
    secrets_file.write_text("super_secret_value_12345\n", encoding="utf-8")
    unreadable = config_root / "unreadable_dir"
    unreadable.mkdir()
    unreadable.chmod(0)
    try:
        res_restricted = run_bwrap_codex(config_root)
        assert res_restricted.returncode == 78
        assert "codex: cannot verify protected Home Assistant path integrity (access or traversal restricted); Codex will not start" in res_restricted.stderr
        assert "unsafe link or file type" not in res_restricted.stderr
        assert "super_secret_value_12345" not in res_restricted.stderr + res_restricted.stdout
    finally:
        unreadable.chmod(0o700)

    # 4. Verify shared enforcement function for both codex and init callers
    policy = rootfs / "usr/local/lib/codex-ha/sensitive-path-policy.sh"
    enforce_test_script = f"""
    bashio::log.fatal() {{ printf 'FATAL: %s\\n' "$*" >&2; }}
    . "{policy}"
    codex_ha_sensitive_paths_enforce "$1" "$2"
    """
    # 4a. Init caller on symlink -> exit 1, remove aliases fatal message
    root_symlink = tmp_path / "init_root_symlink"
    if not root_symlink.exists():
        root_symlink.symlink_to(config_root)
    res_init_symlink = subprocess.run(
        ["bash", "-c", enforce_test_script, "test", str(root_symlink), "init"],
        check=False,
        capture_output=True,
        text=True,
    )
    assert res_init_symlink.returncode == 1
    assert "FATAL: Protected Home Assistant paths have an unsafe link or file type; remove aliases before starting this App" in res_init_symlink.stderr

    # 4b. Init caller on unreadable dir -> exit 1, permission fatal message
    unreadable.chmod(0)
    try:
        res_init_unreadable = subprocess.run(
            ["bash", "-c", enforce_test_script, "test", str(config_root), "init"],
            check=False,
            capture_output=True,
            text=True,
        )
        assert res_init_unreadable.returncode == 1
        assert "FATAL: Cannot verify protected Home Assistant path integrity (access or traversal restricted); ensure permissions allow inspection" in res_init_unreadable.stderr
    finally:
        unreadable.chmod(0o700)

    # 4c. Preparation failure (mktemp fails) -> code 78 in codex caller, code 1 in init caller
    prep_fail_script = f"""
    function /bin/mktemp {{ return 1; }}
    export -f /bin/mktemp
    bashio::log.fatal() {{ printf 'FATAL: %s\\n' "$*" >&2; }}
    . "{policy}"
    codex_ha_sensitive_paths_enforce "$1" "$2"
    """
    res_prep_codex = subprocess.run(
        ["bash", "-c", prep_fail_script, "test", str(config_root), "codex"],
        check=False,
        capture_output=True,
        text=True,
    )
    assert res_prep_codex.returncode == 78
    assert "codex: failed to prepare temporary storage for path integrity verification; Codex will not start" in res_prep_codex.stderr

    res_prep_init = subprocess.run(
        ["bash", "-c", prep_fail_script, "test", str(config_root), "init"],
        check=False,
        capture_output=True,
        text=True,
    )
    assert res_prep_init.returncode == 1
    assert "FATAL: Failed to prepare temporary storage for path integrity verification; Codex will not start" in res_prep_init.stderr
