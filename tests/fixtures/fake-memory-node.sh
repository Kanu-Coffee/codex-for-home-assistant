#!/usr/bin/env bash
set -Eeuo pipefail

readonly EXPECTED_TOKEN_SHA256=9e6f1646cc8cd125adc78893822c0db4648eadcf6787e520a0bd2a69a9da836c

actual_token_sha256=$(printf '%s' "${SUPERVISOR_TOKEN:-}" | sha256sum \
  | awk '{print $1}')
[[ "${actual_token_sha256}" == "${EXPECTED_TOKEN_SHA256}" ]] || exit 91

for forbidden_name in \
  BASH_ENV \
  ENV \
  HA_MEMORY_TEST_FIXTURE \
  HA_MEMORY_TEST_MODE \
  NODE_OPTIONS \
  NODE_PATH \
  GH_TOKEN \
  GITHUB_TOKEN; do
  [[ -z "${!forbidden_name:-}" ]] || exit 92
done
[[ "${HOME:-}" == /data/home ]] || exit 93

case "${1:-}" in
  /usr/local/share/codex-ha/ha-memory.mjs)
    [[ "${2:-}" == token-probe ]] || exit 94
    printf 'HA_MEMORY_TOKEN_BOUNDARY_OK\n'
    ;;
  /usr/local/share/codex-ha/ha-memory-mcp.mjs)
    (( $# == 1 )) || exit 95
    printf 'HA_MEMORY_MCP_TOKEN_BOUNDARY_OK\n'
    ;;
  *)
    exit 96
    ;;
esac
