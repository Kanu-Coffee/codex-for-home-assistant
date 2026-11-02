#!/usr/bin/env bash
# Prepare official Codex test binaries for local verification and CI.
# Downloads official 0.162.1 baseline and 0.166.0 candidate packages with strict SHA-256 verification.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

BASELINE_DIR="${CODEX_TEST_BASELINE_DIR:-"${REPO_ROOT}/.test-tmp/task007-baseline"}"
CANDIDATE_DIR="${CODEX_TEST_CANDIDATE_DIR:-"${REPO_ROOT}/.test-tmp/resume-166"}"

ARCH="$(uname -m)"
case "${ARCH}" in
  x86_64|amd64)
    TARGET="x86_64-unknown-linux-musl"
    SHA256_162="a676f5722aae0d86cbe3764332f08eab1fdd89dc0a300b3ad4ffbf48611fa3e3"
    SHA256_166="1d44b28bc4ac9937d7d3532264baa68a507ce364956a0d4ebb856f331cdee254"
    ;;
  aarch64|arm64)
    TARGET="aarch64-unknown-linux-musl"
    SHA256_162="53a9ce0b94beb27a63fdeb2f7704d95199e17b3898aa33b60461a1a93ac0d88b"
    SHA256_166="7821b77dda2e6283fb1f63f3165177a271da8833e857cf673c6ca1c9db3bfcc6"
    ;;
  *)
    echo "Unsupported architecture for test binary preparation: ${ARCH}" >&2
    exit 1
    ;;
esac

provision_package() {
  local version="$1"
  local expected_sha="$2"
  local dest_dir="$3"

  if [[ -x "${dest_dir}/bin/codex" ]]; then
    local current_version
    current_version="$("${dest_dir}/bin/codex" --version 2>/dev/null || true)"
    if [[ "${current_version}" == "codex-cli ${version}" ]]; then
      echo "Codex ${version} already provisioned at ${dest_dir}"
      return 0
    fi
  fi

  echo "Provisioning official Codex ${version} (${TARGET}) into ${dest_dir}..."
  local tmp_work
  tmp_work="$(mktemp -d "${REPO_ROOT}/.test-tmp/prov-XXXXXX")"
  # shellcheck disable=SC2064
  trap "rm -rf -- '${tmp_work}'" EXIT

  local archive_name="codex-package-${TARGET}.tar.gz"
  local archive_path="${tmp_work}/${archive_name}"
  local url="https://github.com/openai/codex/releases/download/rust-v${version}/${archive_name}"

  curl --fail --show-error --silent --location --output "${archive_path}" "${url}"
  printf '%s  %s\n' "${expected_sha}" "${archive_path}" | sha256sum --check --strict -

  local extract_dir="${tmp_work}/extract"
  mkdir -p "${extract_dir}"
  tar --extract --gzip --file "${archive_path}" --directory "${extract_dir}"

  # Fix permissions cleanly: directories 0755, files 0644, executables 0755
  find "${extract_dir}" -type d -exec chmod 0755 {} +
  find "${extract_dir}" -type f -exec chmod 0644 {} +
  chmod 0755 "${extract_dir}/bin/codex"
  if [[ -d "${extract_dir}/codex-resources" ]]; then
    find "${extract_dir}/codex-resources" -type f -perm /0111 -exec chmod 0755 {} +
  fi

  mkdir -p "${dest_dir}"
  # Sync package contents (excluding the archive itself)
  cp -a "${extract_dir}/." "${dest_dir}/"
  rm -rf "${tmp_work}"
  trap - EXIT

  local verified_version
  verified_version="$("${dest_dir}/bin/codex" --version)"
  if [[ "${verified_version}" != "codex-cli ${version}" ]]; then
    echo "ERROR: Provisioned Codex ${version} verification failed: got ${verified_version}" >&2
    exit 1
  fi
  echo "Successfully provisioned and verified Codex ${version} at ${dest_dir}"
}

mkdir -p "${REPO_ROOT}/.test-tmp"
provision_package "0.162.1" "${SHA256_162}" "${BASELINE_DIR}"
provision_package "0.166.0" "${SHA256_166}" "${CANDIDATE_DIR}"
