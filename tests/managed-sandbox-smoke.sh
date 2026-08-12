#!/usr/bin/env bash
set -Eeuo pipefail

IMAGE=${1:-codex-for-home-assistant:test}
DOCKER_PLATFORM=${DOCKER_PLATFORM:-linux/amd64}
TEST_ID="codex-ha-managed-sandbox-${RANDOM}-$$"
CONTAINER="${TEST_ID}-container"
ROOT_MARKER="${TEST_ID}-root-value"
NESTED_MARKER="${TEST_ID}-nested-value"
STORAGE_MARKER="${TEST_ID}-storage-value"
LAST_OUTPUT=

# This probes Codex's image-managed sandbox policy inside a Supervisor-like
# outer container. It is not a substitute for loading the AppArmor profile on
# a real Home Assistant OS host.

# Git Bash rewrites Linux container paths before invoking native Windows programs.
if [[ "${OSTYPE:-}" == msys* || "${OSTYPE:-}" == cygwin* ]]; then
  docker() {
    MSYS_NO_PATHCONV=1 command docker "$@"
  }
fi

cleanup() {
  docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

redact_output() {
  local output=${1:-}
  output=${output//"${ROOT_MARKER}"/[REDACTED_ROOT_VALUE]}
  output=${output//"${NESTED_MARKER}"/[REDACTED_NESTED_VALUE]}
  output=${output//"${STORAGE_MARKER}"/[REDACTED_STORAGE_VALUE]}
  printf '%s' "${output}"
}

fail() {
  printf 'managed sandbox smoke: %s\n' "$*" >&2
  if [[ -n "${LAST_OUTPUT}" ]]; then
    redact_output "${LAST_OUTPUT}" >&2
    printf '\n' >&2
  fi
  exit 1
}

docker image inspect "${IMAGE}" >/dev/null 2>&1 \
  || fail "image not found: ${IMAGE}"

SECURITY_OPTIONS=(--security-opt seccomp=unconfined)
if docker info --format '{{json .SecurityOptions}}' 2>/dev/null \
  | grep -Fq 'name=apparmor'; then
  SECURITY_OPTIONS+=(--security-opt apparmor=unconfined)
fi

docker create \
  --platform "${DOCKER_PLATFORM}" \
  "${SECURITY_OPTIONS[@]}" \
  --name "${CONTAINER}" \
  --add-host homeassistant:127.0.0.1 \
  --add-host supervisor:127.0.0.1 \
  --env HOME=/data/home \
  --tmpfs /config:rw,nosuid,nodev,size=16m \
  --entrypoint /bin/sleep \
  "${IMAGE}" infinity >/dev/null
docker start "${CONTAINER}" >/dev/null

docker cp tests/fixtures/fake-gh \
  "${CONTAINER}:/tmp/managed-sandbox-fake-gh"
docker cp tests/fixtures/ha_feedback_bug.json \
  "${CONTAINER}:/tmp/managed-sandbox-feedback.json"
docker cp tests/fixtures/fake-memory-node.sh \
  "${CONTAINER}:/tmp/managed-sandbox-fake-memory-node"
docker exec "${CONTAINER}" install -m 0755 \
  /tmp/managed-sandbox-fake-gh /usr/local/bin/gh
docker exec "${CONTAINER}" chown 0:0 \
  /tmp/managed-sandbox-feedback.json
docker exec "${CONTAINER}" chmod 0600 \
  /tmp/managed-sandbox-feedback.json
FEEDBACK_STORAGE_INIT=$(docker exec "${CONTAINER}" \
  ha-feedback github storage-init)
printf '%s\n' "${FEEDBACK_STORAGE_INIT}" \
  | docker exec --interactive "${CONTAINER}" jq --exit-status \
    '.prepared == true and .config_directory == "/data/github-cli"' \
    >/dev/null \
  || fail 'feedback storage initializer did not prepare its bounded directory'
unset FEEDBACK_STORAGE_INIT

docker exec "${CONTAINER}" /bin/bash -Eeuo pipefail -c '
  install -d -m 0755 /config/nested /config/.storage
  install -d -m 0700 /run/codex-ha
  umask 077
  printf "%s\n" "$1" > /config/secrets.yaml
  printf "%s\n" "$2" > /config/nested/secrets.yaml
  printf "%s\n" "$3" > /config/.storage/core.config_entries
  printf "%s\n" "SUPERVISOR_TOKEN=$4" > /run/codex-ha/runtime.env
  printf "%s\n" "$5" > /run/codex-ha/home-assistant-render-upstream.conf
  printf "%s\n" "fake authenticated state; not a credential" \
    > /data/github-cli/hosts.yml
  chmod 0600 \
    /run/codex-ha/runtime.env \
    /run/codex-ha/home-assistant-render-upstream.conf \
    /data/github-cli/hosts.yml
  ln -s /config/secrets.yaml /config/root-secret-alias
  ln -s /config/nested/secrets.yaml /config/nested-secret-alias
  ln -s /config/.storage/core.config_entries /config/storage-secret-alias
' bash \
  "${ROOT_MARKER}" \
  "${NESTED_MARKER}" \
  "${STORAGE_MARKER}" \
  managed-sandbox-supervisor-token-do-not-use \
  'set $ha_frontend_upstream "http://homeassistant:8123";'

docker exec "${CONTAINER}" mv /usr/bin/node /usr/bin/node.real
docker exec "${CONTAINER}" install -m 0755 \
  /tmp/managed-sandbox-fake-memory-node /usr/bin/node
MEMORY_TOKEN_PROBE=$(docker exec \
  --env BASH_ENV=/tmp/ambient-bash-env-must-not-load \
  --env GH_TOKEN=ambient-gh-token-must-not-pass \
  --env HA_MEMORY_TEST_FIXTURE=/tmp/hostile-memory-fixture-must-not-pass \
  --env HA_MEMORY_TEST_MODE=1 \
  --env NODE_OPTIONS=--require=/tmp/ambient-node-module-must-not-load \
  --env SUPERVISOR_TOKEN=ambient-supervisor-token-must-not-pass \
  "${CONTAINER}" ha-memory token-probe)
[[ "${MEMORY_TOKEN_PROBE}" == HA_MEMORY_TOKEN_BOUNDARY_OK ]] \
  || fail 'ha-memory did not pass only the validated runtime credential to Node'
MEMORY_MCP_TOKEN_PROBE=$(docker exec \
  --env BASH_ENV=/tmp/ambient-bash-env-must-not-load \
  --env GH_TOKEN=ambient-gh-token-must-not-pass \
  --env HA_MEMORY_TEST_FIXTURE=/tmp/hostile-memory-fixture-must-not-pass \
  --env HA_MEMORY_TEST_MODE=1 \
  --env NODE_OPTIONS=--require=/tmp/ambient-node-module-must-not-load \
  --env SUPERVISOR_TOKEN=ambient-supervisor-token-must-not-pass \
  "${CONTAINER}" ha-memory-mcp)
[[ "${MEMORY_MCP_TOKEN_PROBE}" == HA_MEMORY_MCP_TOKEN_BOUNDARY_OK ]] \
  || fail 'ha-memory-mcp did not pass only the validated runtime credential to Node'
docker exec "${CONTAINER}" mv -f /usr/bin/node.real /usr/bin/node

docker exec "${CONTAINER}" ha-memory init >/dev/null \
  || fail 'memory store could not be initialized before sandbox entry'
PROMPT_INPUT=$(docker exec --workdir /config "${CONTAINER}" \
  /usr/local/bin/codex debug prompt-input managed-sandbox-prompt-probe)
printf '%s\n' "${PROMPT_INPUT}" \
  | docker exec --interactive "${CONTAINER}" jq --exit-status '
      [ .[] | .content[]? | .text? // empty ] | join("\n") |
      contains("<root>/config</root><root>/data/codex-ha-memory</root>")
      and contains("<entry access=\"write\"><path>/data/codex-ha-memory</path></entry>")
      and contains("<path>/config/secrets.yaml</path>")
      and contains("<path>/config/.storage</path>")
      and contains("Network access is enabled.")
    ' >/dev/null \
  || fail 'Codex prompt input omitted a managed root, deny, or network policy'
unset PROMPT_INPUT

docker exec --detach "${CONTAINER}" node -e '
  const http = require("http");
  const json = (response, value) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  };
  http.createServer((request, response) => {
    if (request.url === "/core/api/states") return json(response, []);
    if (request.url === "/apps/self/info" || request.url === "/addons/self/info") {
      return json(response, {
        result: "ok",
        data: { ip_address: "127.0.0.1" },
      });
    }
    response.writeHead(404);
    response.end();
  }).listen(80, "127.0.0.1");
  http.createServer((_request, response) => json(response, [])).listen(
    8123,
    "127.0.0.1",
  );
  http.createServer((_request, response) => response.end("loopback-ok")).listen(
    18080,
    "127.0.0.1",
  );
'
LOOPBACK_READY=false
for _ in $(seq 1 50); do
  if docker exec "${CONTAINER}" curl --fail --silent \
    http://127.0.0.1:18080/ >/dev/null 2>&1; then
    LOOPBACK_READY=true
    break
  fi
  sleep 0.1
done
[[ "${LOOPBACK_READY}" == true ]] || fail 'loopback fixture did not start'

set +e
LAST_OUTPUT=$(docker exec "${CONTAINER}" \
  /usr/local/bin/codex sandbox \
  --include-managed-config \
  -c 'permissions.managed-smoke={ extends = ":workspace", workspace_roots = { "/data/codex-ha-memory" = true }, network = { enabled = true } }' \
  --permission-profile managed-smoke \
  --cd /config \
  /bin/bash -Eeuo pipefail -c '
    output=/config/.managed-sandbox-probe-output
    printf "%s\n" ordinary-write > /config/ordinary.yaml
    [[ $(cat /config/ordinary.yaml) == ordinary-write ]] || exit 40
    [[ $(curl --fail --silent http://127.0.0.1:18080/) == loopback-ok ]] \
      || exit 41

    ha-memory status > /config/.managed-sandbox-memory-status.json
    jq --exit-status ".database_mode == \"0600\" and .integrity == \"ok\"" \
      /config/.managed-sandbox-memory-status.json >/dev/null || exit 47
    rm -f -- \
      /data/codex-ha-memory/memory.sqlite3 \
      /data/codex-ha-memory/memory.sqlite3-shm \
      /data/codex-ha-memory/memory.sqlite3-wal
    ha-memory init > /config/.managed-sandbox-memory-init.json
    jq --exit-status ".initialized == true and .network_accessed == false" \
      /config/.managed-sandbox-memory-init.json >/dev/null || exit 46

    ha-api --raw GET /states > /config/.managed-sandbox-api.json
    jq --exit-status "type == \"array\" and length == 0" \
      /config/.managed-sandbox-api.json >/dev/null || exit 48
    ha-browser-network-info > /config/.managed-sandbox-network.json
    jq --exit-status \
      ".http_status == 200 and .supervisor_reported_app_ip == \"127.0.0.1\"" \
      /config/.managed-sandbox-network.json >/dev/null || exit 49

    feedback_collect=$(ha-feedback collect bug \
      --input /tmp/managed-sandbox-feedback.json) || exit 54
    feedback_directory=$(jq --exit-status --raw-output ".report_directory" \
      <<< "${feedback_collect}") || exit 55
    ha-feedback render "${feedback_directory}" >/dev/null || exit 56
    feedback_preview=$(ha-feedback github submit "${feedback_directory}") \
      || exit 57
    jq --exit-status ".action == \"confirmation_required\"" \
      <<< "${feedback_preview}" >/dev/null || exit 50
    [[ $(stat -c "%a" /tmp/codex-ha-feedback-previews) == 700 ]] \
      || exit 51
    preview_state=$(find /tmp/codex-ha-feedback-previews \
      -mindepth 1 -maxdepth 1 -type f -name "*.json" -print -quit)
    [[ -n "${preview_state}" && $(stat -c "%a" "${preview_state}") == 600 ]] \
      || exit 52

    assert_unreadable() {
      : > "${output}"
      if cat -- "$1" > "${output}" 2>/dev/null; then
        exit 42
      fi
      [[ ! -s "${output}" ]] || exit 43
    }

    assert_unreadable /config/secrets.yaml
    assert_unreadable /config/nested/secrets.yaml
    assert_unreadable /config/.storage/core.config_entries
    assert_unreadable /config/root-secret-alias
    assert_unreadable /config/nested-secret-alias
    assert_unreadable /config/storage-secret-alias

    : > "${output}"
    if ls -1 /config/.storage > "${output}" 2>/dev/null; then
      exit 44
    fi
    [[ ! -s "${output}" ]] || exit 45
    rm -f -- "${output}"
    printf "MANAGED_SANDBOX_OK\n"
  ' 2>&1)
SANDBOX_STATUS=$?
set -e

for marker in "${ROOT_MARKER}" "${NESTED_MARKER}" "${STORAGE_MARKER}"; do
  [[ "${LAST_OUTPUT}" != *"${marker}"* ]] \
    || fail 'managed sandbox output exposed a protected fixture value'
done
[[ "${SANDBOX_STATUS}" -eq 0 ]] \
  || fail "managed sandbox probe exited ${SANDBOX_STATUS}"
grep -Fxq 'MANAGED_SANDBOX_OK' <<< "${LAST_OUTPUT}" \
  || fail 'managed sandbox probe did not complete'

docker exec "${CONTAINER}" ln \
  /config/secrets.yaml /config/pre-existing-hardlink
set +e
LAST_OUTPUT=$(docker exec "${CONTAINER}" /usr/local/bin/codex --version 2>&1)
HARDLINK_STATUS=$?
set -e

for marker in "${ROOT_MARKER}" "${NESTED_MARKER}" "${STORAGE_MARKER}"; do
  [[ "${LAST_OUTPUT}" != *"${marker}"* ]] \
    || fail 'hardlink rejection output exposed a protected fixture value'
done
[[ "${HARDLINK_STATUS}" -eq 78 ]] \
  || fail "pre-existing hardlink exited ${HARDLINK_STATUS}, expected 78"
grep -Fq 'unsafe link or file type' <<< "${LAST_OUTPUT}" \
  || fail 'pre-existing hardlink did not report the fail-closed policy'

LAST_OUTPUT=
printf 'Managed Codex sandbox smoke passed: %s (%s)\n' \
  "${IMAGE}" "${DOCKER_PLATFORM}"
