#!/usr/bin/env bash
set -Eeuo pipefail

IMAGE=${1:-codex-for-home-assistant:test}
TEST_ID="codex-ha-memory-smoke-${RANDOM}-$$"
FIRST_CONTAINER="${TEST_ID}-first"
SECOND_CONTAINER="${TEST_ID}-second"
DATA_VOLUME="${TEST_ID}-data"
UNSAFE_DATA_VOLUME="${TEST_ID}-unsafe-data"
UNSAFE_CONFIG_VOLUME="${TEST_ID}-unsafe-config"
FIXTURE_PATH=/tmp/ha-memory-snapshot.json
ACTIVE_CONTAINER=

# Git Bash rewrites Linux container paths before invoking native Windows programs.
if [[ "${OSTYPE:-}" == msys* || "${OSTYPE:-}" == cygwin* ]]; then
  docker() {
    MSYS_NO_PATHCONV=1 command docker "$@"
  }
fi

cleanup() {
  docker rm -f "${FIRST_CONTAINER}" "${SECOND_CONTAINER}" >/dev/null 2>&1 || true
  docker volume rm -f \
    "${DATA_VOLUME}" \
    "${UNSAFE_DATA_VOLUME}" \
    "${UNSAFE_CONFIG_VOLUME}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

fail() {
  printf 'memory smoke: %s\n' "$*" >&2
  exit 1
}

start_container() {
  local name=$1
  docker run --detach \
    --platform linux/amd64 \
    --name "${name}" \
    --env HA_MEMORY_TEST_MODE=1 \
    --env HA_MEMORY_TEST_FIXTURE="${FIXTURE_PATH}" \
    --volume "${DATA_VOLUME}:/data" \
    --entrypoint /bin/sh \
    "${IMAGE}" \
    -c 'exec sleep infinity' >/dev/null
  ACTIVE_CONTAINER=${name}
}

assert_json() {
  local description=$1
  local filter=$2
  local payload=$3
  printf '%s\n' "${payload}" \
    | docker exec --interactive "${ACTIVE_CONTAINER}" \
      jq --exit-status "${filter}" >/dev/null \
    || fail "${description}"
}

docker image inspect "${IMAGE}" >/dev/null 2>&1 \
  || fail "image not found: ${IMAGE}"
docker volume create "${DATA_VOLUME}" >/dev/null
docker volume create "${UNSAFE_DATA_VOLUME}" >/dev/null
docker volume create "${UNSAFE_CONFIG_VOLUME}" >/dev/null

printf '%s' '{"authorized_keys":[],"web_terminal_auto_start_codex":false,"tmux_session_name":"memory-path-safety","codex_approval_policy":"on-request","codex_sandbox_mode":"danger-full-access","log_level":"info"}' \
  | docker run --rm --interactive \
    --platform linux/amd64 \
    --entrypoint /bin/sh \
    --volume "${UNSAFE_DATA_VOLUME}:/data" \
    "${IMAGE}" \
    -ceu 'cat > /data/options.json; mkdir /data/memory-link-target; chmod 0755 /data/memory-link-target; ln -s /data/memory-link-target /data/codex-ha-memory'
docker run --rm \
  --platform linux/amd64 \
  --volume "${UNSAFE_DATA_VOLUME}:/data" \
  --volume "${UNSAFE_CONFIG_VOLUME}:/config" \
  --entrypoint /bin/sh \
  "${IMAGE}" -c 'mkdir -p /run/s6/container_environment; exec /usr/local/bin/codex-ha-init' >/dev/null \
  || fail 'unsafe memory symlink made the main App init fail'
[[ $(docker run --rm --platform linux/amd64 --entrypoint stat \
  --volume "${UNSAFE_DATA_VOLUME}:/data" "${IMAGE}" \
  -c '%a' /data/memory-link-target) == 755 ]] \
  || fail 'main App init followed or chmodded an unsafe memory symlink'
docker run --rm \
  --platform linux/amd64 \
  --entrypoint /bin/sh \
  --volume "${UNSAFE_DATA_VOLUME}:/data" \
  "${IMAGE}" \
  -ceu 'rm /data/codex-ha-memory; : > /data/codex-ha-memory; chmod 0600 /data/codex-ha-memory'
docker run --rm \
  --platform linux/amd64 \
  --volume "${UNSAFE_DATA_VOLUME}:/data" \
  --volume "${UNSAFE_CONFIG_VOLUME}:/config" \
  --entrypoint /bin/sh \
  "${IMAGE}" -c 'mkdir -p /run/s6/container_environment; exec /usr/local/bin/codex-ha-init' >/dev/null \
  || fail 'unsafe memory file made the main App init fail'

start_container "${FIRST_CONTAINER}"

docker cp tests/fixtures/ha_memory_snapshot.json \
  "${FIRST_CONTAINER}:${FIXTURE_PATH}"
docker cp tests/ha_memory_client_test.mjs \
  "${FIRST_CONTAINER}:/tmp/ha_memory_client_test.mjs"
docker cp tests/ha_memory_test.mjs \
  "${FIRST_CONTAINER}:/tmp/ha_memory_test.mjs"
docker exec \
  --env HA_MEMORY_INSTALLED_TEST=1 \
  --env HA_MEMORY_TEST_FIXTURE= \
  "${FIRST_CONTAINER}" \
  node --test /tmp/ha_memory_client_test.mjs >/dev/null \
  || fail 'Home Assistant WebSocket snapshot completeness tests failed'
docker exec \
  --env HA_MEMORY_INSTALLED_TEST=1 \
  --env HA_MEMORY_TEST_SOURCE_FIXTURE="${FIXTURE_PATH}" \
  --env HA_MEMORY_TEST_FIXTURE= \
  "${FIRST_CONTAINER}" \
  node --test /tmp/ha_memory_test.mjs >/dev/null \
  || fail 'installed Home Assistant memory lifecycle and schema tests failed'

INIT_OUTPUT=$(docker exec "${FIRST_CONTAINER}" ha-memory init) \
  || fail 'ha-memory init failed'
assert_json 'ha-memory init did not create an empty, private store' \
  '.initialized == true
    and .network_accessed == false
    and .catalog_status == "empty"
    and .database_mode == "0600"
    and .integrity == "ok"' \
  "${INIT_OUTPUT}"

REFRESH_OUTPUT=$(docker exec "${FIRST_CONTAINER}" ha-memory refresh --force) \
  || fail 'fixture-backed catalog refresh failed'
assert_json 'catalog refresh did not index the fixture' \
  '.status == "success"
    and .object_count >= 8
    and .relation_count >= 6' \
  "${REFRESH_OUTPUT}"

SEARCH_OUTPUT=$(docker exec "${FIRST_CONTAINER}" ha-memory search 'Kitchen Main') \
  || fail 'catalog search failed'
assert_json 'catalog search did not return the fixture entity within its bound' \
  '.result_count >= 1
    and .result_count <= .bounded.result_limit
    and any(.results[]; .subject == "entity:light.kitchen_main")' \
  "${SEARCH_OUTPUT}"

CANDIDATE_OUTPUT=$(docker exec "${FIRST_CONTAINER}" ha-memory candidate add \
  --subject entity:light.kitchen_main \
  --memory-type alias \
  --key household_name \
  --value-json '"Persistent smoke alias"' \
  --source user_explicit \
  --source-ref memory-smoke-request) \
  || fail 'memory candidate creation failed'
assert_json 'new memory was not kept pending' \
  '.candidate.status == "pending" and .deduplicated == false' \
  "${CANDIDATE_OUTPUT}"
CANDIDATE_ID=$(printf '%s\n' "${CANDIDATE_OUTPUT}" \
  | docker exec --interactive "${FIRST_CONTAINER}" \
    jq --exit-status --raw-output '.candidate.id') \
  || fail 'memory candidate response omitted its ID'
[[ "${CANDIDATE_ID}" =~ ^[1-9][0-9]*$ ]] \
  || fail 'memory candidate returned an invalid ID'

EVIDENCE_OUTPUT=$(docker exec "${FIRST_CONTAINER}" ha-memory candidate evidence \
  "${CANDIDATE_ID}" \
  --evidence-type manual_review \
  --detail memory-smoke-review) \
  || fail 'memory candidate evidence command failed'
assert_json 'candidate evidence was not recorded' \
  '.candidate_id > 0 and .evidence_id > 0' \
  "${EVIDENCE_OUTPUT}"

VERIFY_OUTPUT=$(docker exec "${FIRST_CONTAINER}" ha-memory candidate verify \
  "${CANDIDATE_ID}" --method user_explicit) \
  || fail 'memory candidate verification failed'
assert_json 'candidate did not reach the verified state' \
  '.verified == true and .candidate.status == "verified"' \
  "${VERIFY_OUTPUT}"

APPLY_OUTPUT=$(docker exec "${FIRST_CONTAINER}" ha-memory candidate apply \
  "${CANDIDATE_ID}") \
  || fail 'memory candidate apply failed'
assert_json 'verified candidate did not become applied memory' \
  '.result == "applied" and .candidate.status == "applied"' \
  "${APPLY_OUTPUT}"

STATUS_OUTPUT=$(docker exec "${FIRST_CONTAINER}" ha-memory status) \
  || fail 'ha-memory status failed'
assert_json 'memory status did not report the refreshed, applied store' \
  '.catalog_status == "ready"
    and .last_sync.status == "success"
    and .last_successful_sync.id > 0
    and .memory_counts.applied == 1
    and .database_mode == "0600"
    and .integrity == "ok"' \
  "${STATUS_OUTPUT}"

[[ $(docker exec "${FIRST_CONTAINER}" stat -c '%a' /data/codex-ha-memory) == 700 ]] \
  || fail 'memory directory mode was not 0700'
docker exec "${FIRST_CONTAINER}" /bin/sh -ceu '
  for file in /data/codex-ha-memory/memory.sqlite3*; do
    [ -f "${file}" ] || continue
    [ "$(stat -c "%a" "${file}")" = 600 ]
  done
' || fail 'SQLite database, WAL, or SHM mode was not 0600'

# The catalog may inspect live states and automation bodies, but none of those raw
# fixture values may cross the durable SQLite boundary.
docker exec "${FIRST_CONTAINER}" /bin/sh -ceu '
  for marker in \
    TRANSIENT_STATE_VALUE_4f91c0 \
    TRANSIENT_ATTRIBUTE_VALUE_8ca2d1 \
    TRANSIENT_LAST_CHANGED_3d77e2 \
    TRANSIENT_LAST_UPDATED_68b134 \
    TRANSIENT_SENSOR_SAMPLE_2b9a11 \
    TRANSIENT_LAST_TRIGGERED_f982ad \
    AUTOMATION_RAW_ACTION_93f4b7 \
    98765.4321; do
    for file in /data/codex-ha-memory/memory.sqlite3*; do
      [ -f "${file}" ] || continue
      if grep -aFq -- "${marker}" "${file}"; then
        exit 1
      fi
    done
  done
' || fail 'raw transient fixture data reached durable SQLite bytes'

MCP_OUTPUT=$(
  printf '%s\n' \
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"memory-smoke","version":"1.0.0"}}}' \
    '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
    '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"memory_search","arguments":{"query":"Kitchen Main","limit":3}}}' \
    '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"memory_search","arguments":{"query":"Kitchen Main","unexpected":true}}}' \
    '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"memory_propose","arguments":{"subject":"entity:light.kitchen_main","memory_type":"note","key":"invalid_shape","value":[],"source":"inference","source_ref":"memory-smoke-invalid"}}}' \
    'null' \
    | docker exec --interactive "${FIRST_CONTAINER}" ha-memory-mcp
) || fail 'ha-memory MCP initialize/tools/list exchange failed'
assert_json 'ha-memory MCP did not advertise its bounded memory tools' \
  'length == 6
    and .[0].id == 1
    and .[0].result.serverInfo.name == "codex-ha-memory"
    and .[1].id == 2
    and any(.[1].result.tools[]; .name == "memory_search")
    and any(.[1].result.tools[]; .name == "memory_apply_candidate")
    and any(.[1].result.tools[]; .name == "memory_verify_change")
    and .[2].id == 3
    and .[2].result.isError == false
    and .[2].result.structuredContent.result.result_count >= 1
    and .[2].result.structuredContent.result.result_count <= 3
    and .[3].id == 4
    and .[3].error.code == -32602
    and .[4].id == 5
    and .[4].error.code == -32602
    and .[5].id == null
    and .[5].error.code == -32600' \
  "$(printf '%s\n' "${MCP_OUTPUT}" \
    | docker exec --interactive "${FIRST_CONTAINER}" jq --slurp '.')"

docker rm -f "${FIRST_CONTAINER}" >/dev/null
start_container "${SECOND_CONTAINER}"

PERSISTED_STATUS=$(docker exec "${SECOND_CONTAINER}" ha-memory status) \
  || fail 'persisted memory status failed after container replacement'
assert_json 'catalog or applied memory did not survive container replacement' \
  '.catalog_status == "ready"
    and .memory_counts.applied == 1
    and .last_sync.status == "success"
    and .last_successful_sync.id > 0' \
  "${PERSISTED_STATUS}"

PERSISTED_SEARCH=$(docker exec "${SECOND_CONTAINER}" \
  ha-memory search 'Persistent smoke alias') \
  || fail 'persisted memory search failed after container replacement'
assert_json 'applied memory was not searchable after container replacement' \
  '.result_count >= 1
    and any(.results[];
      .subject == "entity:light.kitchen_main"
      and any(.memories[];
        .key == "household_name"
        and .value == "Persistent smoke alias"
        and .source == "user_explicit"))' \
  "${PERSISTED_SEARCH}"

printf 'Home Assistant memory smoke passed: index, lifecycle, privacy, MCP, persistence\n'
