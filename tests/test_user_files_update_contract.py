import re
from pathlib import Path

import yaml


VALID_UPDATE_MODES = "list(preserve|refresh_agents|refresh_all)"


def test_user_file_update_option_is_safe_by_default(
    addon_config: dict,
) -> None:
    assert addon_config["options"]["codex_user_files_update_mode"] == "preserve"
    assert (
        addon_config["schema"]["codex_user_files_update_mode"]
        == VALID_UPDATE_MODES
    )


def test_user_file_update_option_is_translated(addon_root: Path) -> None:
    for locale in ("en", "ko"):
        translation_path = addon_root / "translations" / f"{locale}.yaml"
        translation = yaml.safe_load(translation_path.read_text(encoding="utf-8"))
        option = translation["configuration"]["codex_user_files_update_mode"]
        assert isinstance(option["name"], str) and option["name"].strip()
        assert isinstance(option["description"], str) and option["description"].strip()


def test_user_file_update_runtime_is_image_managed(
    addon_root: Path, rootfs: Path
) -> None:
    dockerfile = (addon_root / "Dockerfile").read_text(encoding="utf-8")
    init_script = (rootfs / "usr/local/bin/codex-ha-init").read_text(
        encoding="utf-8"
    )
    wrapper = (rootfs / "usr/local/bin/codex-user-files-update").read_text(
        encoding="utf-8"
    )
    helper = (
        rootfs / "usr/local/share/codex-ha/user-files-update.mjs"
    ).read_text(encoding="utf-8")

    assert "${BUILD_VERSION}" in dockerfile
    assert "/usr/local/share/codex-ha/app-version" in dockerfile
    assert "/usr/local/share/codex-ha/user-files-update.mjs" in dockerfile
    assert "/usr/local/bin/codex-user-files-update" in init_script
    assert re.search(r"(?:==|-eq)\s*30", init_script)

    assert "flock -n" in wrapper
    assert "LOCK_DIRECTORY=/run/codex-ha" in wrapper
    assert "stat -Lc '%u:%h:%F' /proc/self/fd/9" in wrapper
    assert "stat -Lc '%d:%i'" in wrapper
    assert "user-files-update.mjs" in wrapper
    assert "process.argv.length !== 2" in helper
    assert "O_NOFOLLOW" in helper
    assert "O_NONBLOCK" in helper
    assert "stats.uid !== 0 || stats.nlink !== 1" in helper
    assert 'new Set(["preserve", "refresh_agents", "refresh_all"])' in helper


def test_user_file_update_has_fixed_scopes_and_private_recovery_state(
    rootfs: Path,
) -> None:
    helper = (
        rootfs / "usr/local/share/codex-ha/user-files-update.mjs"
    ).read_text(encoding="utf-8")

    for fixed_path in (
        'join(DATA_DIRECTORY, "config.toml")',
        'join(DATA_DIRECTORY, "AGENTS.md")',
        'join(DATA_DIRECTORY, ".user-files-update-state.json")',
        'join(DATA_DIRECTORY, ".user-files-update-journal.json")',
        'join(DATA_DIRECTORY, "backups")',
        'join(BACKUPS_DIRECTORY, "user-files")',
    ):
        assert fixed_path in helper

    assert 'new Set(["config", "agents"])' in helper
    assert 'options.mode === "refresh_all"' in helper
    assert 'options.mode === "refresh_agents"' in helper
    assert "versionApplied(state, scope, appVersion)" in helper
    assert "await preflightRefreshTargets(scopes)" in helper
    assert "await writePrivateJson(JOURNAL_PATH" in helper
    assert "await writePrivateJson(STATE_PATH" in helper
    assert "await recoverPendingTransaction" in helper
    assert "0o700" in helper
    assert "0o600" in helper

    assert 'join(DATA_DIRECTORY, "AGENTS.override.md")' in helper
    assert "writeAtomic(AGENTS_OVERRIDE_PATH" not in helper
    assert "removeSafeRegular(AGENTS_OVERRIDE_PATH" not in helper

    for excluded_path in (
        'join(DATA_DIRECTORY, "auth.json")',
        '"/config"',
        '"/data/ssh"',
        '"/data/browser-auth"',
    ):
        assert excluded_path not in helper
