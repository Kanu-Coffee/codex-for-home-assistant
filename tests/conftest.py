from pathlib import Path

import pytest
import yaml


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
ADDON_ROOT = REPOSITORY_ROOT / "codex_home_assistant"
ROOTFS = ADDON_ROOT / "rootfs"


@pytest.fixture(scope="session")
def repository_root() -> Path:
    return REPOSITORY_ROOT


@pytest.fixture(scope="session")
def addon_root() -> Path:
    return ADDON_ROOT


@pytest.fixture(scope="session")
def rootfs() -> Path:
    return ROOTFS


@pytest.fixture(scope="session")
def addon_config(addon_root: Path) -> dict:
    with (addon_root / "config.yaml").open(encoding="utf-8") as config_file:
        config = yaml.safe_load(config_file)
    assert isinstance(config, dict)
    return config
