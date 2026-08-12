import re
from pathlib import Path


CODEX_CHECKSUMS = {
    "AMD64": "84091ae20c65fcc7d4120db97d1bd57d7ff8df9c7609fb781c78c2ebbd4f5a28",
    "AARCH64": "b9f8ef5f98e46ced4dbbd3756a4223e3ee299a457ff488a3305bea455da8b5b8",
}

GH_CHECKSUMS = {
    "AMD64": "a2c9b8497e1f85b1ad0dfcb78b5a622e098801b8e461e459e88e1ee12f018112",
    "AARCH64": "73ea440ecad9c9e284429997ee6f93577bc6f7bc6fba357ef62c53ad8fb641a5",
}

BASE_IMAGE = (
    "ghcr.io/home-assistant/base:3.24@"
    "sha256:94ff231402a5e7ad2a82e261ad5fa4ffae7d7bb095c3febb2edbdf309c9b6aca"
)

ARCHITECTURE_NEUTRAL_SMOKES = (
    "browser-approval-smoke.sh",
    "docker-smoke.sh",
    "feedback-smoke.sh",
    "managed-auth-smoke.sh",
    "managed-sandbox-smoke.sh",
    "memory-smoke.sh",
    "user-files-update-smoke.sh",
)


def _checksum_args(dockerfile: str, prefix: str) -> dict[str, str]:
    return dict(
        re.findall(
            rf"^ARG {prefix}_(AMD64|AARCH64)=([0-9a-f]{{64}})$",
            dockerfile,
            re.MULTILINE,
        )
    )


def test_multiarch_binary_assets_are_exactly_pinned(addon_root: Path) -> None:
    dockerfile = (addon_root / "Dockerfile").read_text(encoding="utf-8")

    assert f"ARG BUILD_FROM={BASE_IMAGE}" in dockerfile
    assert "apk upgrade --no-cache" in dockerfile
    assert _checksum_args(dockerfile, "CODEX_SHA256") == CODEX_CHECKSUMS
    assert _checksum_args(dockerfile, "GH_SHA256") == GH_CHECKSUMS
    assert 'codex_archive="codex-${codex_target}.tar.gz"' in dockerfile
    assert 'gh_archive="gh_${GH_VERSION}_linux_${gh_arch}.tar.gz"' in dockerfile
    assert 'codex_target="x86_64-unknown-linux-musl"' in dockerfile
    assert 'codex_target="aarch64-unknown-linux-musl"' in dockerfile
    assert 'gh_arch="amd64"' in dockerfile
    assert 'gh_arch="arm64"' in dockerfile
    assert re.search(r"^\s+bubblewrap\s+\\$", dockerfile, re.MULTILINE)
    assert "/usr/bin/bwrap --version" in dockerfile
    assert "rm -f /usr/bin/tempio" in dockerfile
    assert "[[ ! -e /usr/bin/tempio ]]" in dockerfile


def test_architecture_selection_accepts_only_supported_targets(
    addon_root: Path,
) -> None:
    dockerfile = (addon_root / "Dockerfile").read_text(encoding="utf-8")

    assert 'resolved_arch="${TARGETARCH:-${BUILD_ARCH}}"' in dockerfile
    assert re.search(r"\n\s+amd64\) \\\n", dockerfile)
    assert re.search(r"\n\s+arm64\|aarch64\) \\\n", dockerfile)
    assert "Unsupported architecture: ${resolved_arch}" in dockerfile
    assert "supported architectures: amd64, aarch64" in dockerfile
    assert "armv7" not in dockerfile


def test_build_and_target_architectures_must_describe_the_same_platform(
    repository_root: Path,
) -> None:
    dockerfile = (
        repository_root / "codex_home_assistant/Dockerfile"
    ).read_text(encoding="utf-8")
    workflow = (
        repository_root / ".github/workflows/ci.yaml"
    ).read_text(encoding="utf-8")

    assert "amd64:|amd64:amd64|aarch64:|aarch64:arm64" in dockerfile
    assert "Architecture mismatch or unsupported target" in dockerfile
    assert "--platform linux/amd64" in workflow
    assert "--build-arg BUILD_ARCH=aarch64" in workflow
    assert "--platform linux/arm64" in workflow
    assert "--build-arg BUILD_ARCH=amd64" in workflow
    assert workflow.count(
        "mismatched BUILD_ARCH/TARGETARCH unexpectedly built"
    ) == 2


def test_builder_matrix_is_driven_by_app_architectures(
    repository_root: Path,
) -> None:
    workflow = (
        repository_root / ".github/workflows/build-app.yaml"
    ).read_text(encoding="utf-8")

    builder_pin = "4de35182ce1e329181bffcbcc84d33db5e2c7e10"
    assert f"prepare-multi-arch-matrix@{builder_pin}" in workflow
    assert "architectures: ${{ steps.info.outputs.architectures }}" in workflow
    assert "matrix: ${{ fromJSON(needs.prepare.outputs.build_matrix) }}" in workflow
    assert "arch: ${{ matrix.arch }}" in workflow
    assert "publish-multi-arch-manifest" not in workflow
    assert "Create staging manifest from verified architecture digests" in workflow
    assert 'sources+=("${architecture_image}@${expected_digest}")' in workflow


def test_container_smokes_use_an_overridable_docker_platform(
    repository_root: Path,
) -> None:
    for script_name in ARCHITECTURE_NEUTRAL_SMOKES:
        script = (repository_root / "tests" / script_name).read_text(
            encoding="utf-8"
        )
        assert "DOCKER_PLATFORM=${DOCKER_PLATFORM:-linux/amd64}" in script
        assert '--platform "${DOCKER_PLATFORM}"' in script
        assert "--platform linux/amd64" not in script


def test_native_arm_ci_runs_current_smokes_but_not_amd64_update_fixture(
    repository_root: Path,
) -> None:
    workflow = (
        repository_root / ".github/workflows/ci.yaml"
    ).read_text(encoding="utf-8")
    arm_job = workflow.split("  aarch64-build-and-smoke:\n", maxsplit=1)[1]

    assert "runs-on: ubuntu-24.04-arm" in arm_job
    assert "DOCKER_PLATFORM: linux/arm64" in arm_job
    for script_name in ARCHITECTURE_NEUTRAL_SMOKES:
        assert f"bash tests/{script_name}" in arm_job
    assert "tests/update-smoke.sh" not in arm_job


def test_ci_loads_checksum_pinned_bubblewrap_userns_profile(
    repository_root: Path,
) -> None:
    workflow = (
        repository_root / ".github/workflows/ci.yaml"
    ).read_text(encoding="utf-8")

    profile_commit = "b4dfdf50f50ed1d64161424d036a2453645f0cfe"
    profile_sha256 = (
        "a964037f6cf0df1099f14226b037eaedde6237c86e715188e93eb460b30be859"
    )
    assert workflow.count("Load CI-only bubblewrap user namespace profile") == 2
    assert workflow.count(profile_commit) == 2
    assert workflow.count(profile_sha256) == 2
    assert workflow.count("sha256sum --check --strict") == 2
    assert workflow.count('apparmor_parser --replace "${profile_path}"') == 2
    assert "--cap-add SYS_ADMIN" not in workflow
    assert "--privileged" not in workflow
