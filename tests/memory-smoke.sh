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

docker exec --detach --env S6_KEEP_ENV=1 "${FIRST_CONTAINER}" \
  /etc/s6-overlay/s6-rc.d/ha-memoryd/run >/dev/null \
  || fail 'first-run memory daemon did not start'
BOOTSTRAP_STATUS=
for _ in $(seq 1 50); do
  BOOTSTRAP_STATUS=$(docker exec "${FIRST_CONTAINER}" ha-memory status) \
    || fail 'ha-memory status failed while waiting for automatic bootstrap'
  if printf '%s\n' "${BOOTSTRAP_STATUS}" \
    | docker exec --interactive "${FIRST_CONTAINER}" \
      jq --exit-status \
        '.catalog_status == "ready"
          and .last_successful_sync.object_count >= 8
          and .last_successful_sync.relation_count >= 6' >/dev/null; then
    break
  fi
  sleep 0.2
done
assert_json 'first-run daemon did not create the catalog without a manual refresh' \
  '.catalog_status == "ready"
    and .last_sync.status == "success"
    and .last_successful_sync.object_count >= 8
    and .last_successful_sync.relation_count >= 6' \
  "${BOOTSTRAP_STATUS}"

if FAILURE_OUTPUT=$(docker exec \
  --env HA_MEMORY_TEST_FIXTURE= \
  --env SUPERVISOR_TOKEN= \
  "${FIRST_CONTAINER}" \
  ha-memory refresh --force 2>&1); then
  fail 'token-less installed refresh unexpectedly succeeded'
fi
assert_json 'installed refresh did not expose the bounded token diagnostic' \
  '.error == "ha_unavailable"
    and .reason == "ha_token_unavailable"
    and (.message | contains("SUPERVISOR_TOKEN"))' \
  "${FAILURE_OUTPUT}"
FAILURE_STATUS=$(docker exec "${FIRST_CONTAINER}" ha-memory status) \
  || fail 'ha-memory status failed after an injected refresh failure'
assert_json 'failed refresh did not preserve and diagnose the last-known-good catalog' \
  '.catalog_status == "stale"
    and .last_sync.status == "failed"
    and .last_sync.error_code == "ha_token_unavailable"
    and .last_successful_sync.id > 0' \
  "${FAILURE_STATUS}"
RECOVERY_OUTPUT=$(docker exec "${FIRST_CONTAINER}" ha-memory refresh --force) \
  || fail 'fixture-backed catalog did not recover after an injected failure'
assert_json 'recovered catalog refresh was not successful' \
  '.status == "success" and .sync_id > 0' \
  "${RECOVERY_OUTPUT}"

SEARCH_OUTPUT=$(docker exec "${FIRST_CONTAINER}" ha-memory search 'Kitchen Main') \
  || fail 'catalog search failed'
assert_json 'catalog search did not return the fixture entity within its bound' \
  '.result_count >= 1
    and .result_count <= .bounded.result_limit
    and any(.results[]; .subject == "entity:light.kitchen_main")' \
  "${SEARCH_OUTPUT}"

CANDIDATE_OUTPUT=$(docker exec "${FIRST_CONTAINER}" ha-memory remember \
  --subject entity:light.kitchen_main \
  --memory-type alias \
  --key household_name \
  --value-json '"Persistent smoke alias"' \
  --source-ref memory-smoke-request) \
  || fail 'explicit memory remember workflow failed'
assert_json 'explicit memory did not complete the audited lifecycle' \
  '.result == "applied"
    and .candidate.status == "applied"
    and .deduplicated == false
    and (.audit_event_ids | length) == 3' \
  "${CANDIDATE_OUTPUT}"
CANDIDATE_ID=$(printf '%s\n' "${CANDIDATE_OUTPUT}" \
  | docker exec --interactive "${FIRST_CONTAINER}" \
    jq --exit-status --raw-output '.candidate.id') \
  || fail 'memory candidate response omitted its ID'
[[ "${CANDIDATE_ID}" =~ ^[1-9][0-9]*$ ]] \
  || fail 'memory candidate returned an invalid ID'

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

PENDING_OUTPUT=$(docker exec "${FIRST_CONTAINER}" ha-memory candidate add \
  --subject entity:light.kitchen_main \
  --memory-type note \
  --key user_note.mcp_follow_up \
  --value-json '"MCP follow-up candidate"' \
  --source observation \
  --source-ref observation:mcp-follow-up-1) \
  || fail 'MCP follow-up candidate creation failed'
PENDING_ID=$(printf '%s\n' "${PENDING_OUTPUT}" \
  | docker exec --interactive "${FIRST_CONTAINER}" \
    jq --exit-status --raw-output '.candidate.id') \
  || fail 'MCP follow-up candidate response omitted its ID'
[[ "${PENDING_ID}" =~ ^[1-9][0-9]*$ ]] \
  || fail 'MCP follow-up candidate returned an invalid ID'

MCP_OUTPUT=$(
  printf '%s\n' \
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"memory-smoke","version":"1.0.0"}}}' \
    '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
    '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"memory_search","arguments":{"query":"Kitchen Main","limit":3}}}' \
    '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"memory_search","arguments":{"query":"Kitchen Main","unexpected":true}}}' \
    '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"memory_propose","arguments":{"subject":"entity:light.kitchen_main","memory_type":"note","key":"invalid_shape","value":[],"source":"inference","source_ref":"memory-smoke-invalid"}}}' \
    '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"memory_list_candidates","arguments":{"status":"pending","subject":"entity:light.kitchen_main","limit":5}}}' \
    "{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"tools/call\",\"params\":{\"name\":\"memory_reject_candidate\",\"arguments\":{\"candidate_id\":\"${PENDING_ID}\",\"reason\":\"user_withdrew_candidate\"}}}" \
    '{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"memory_list_candidates","arguments":{"status":"pending","subject":"entity:light.kitchen_main","limit":5}}}' \
    '{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"memory_remember_explicit","arguments":{"subject":"home:household","memory_type":"preference","key":"user_preference.mcp_smoke","value":"Keep the MCP smoke preference","source_ref":"user-request:mcp-smoke"}}}' \
    'null' \
    | docker exec --interactive "${FIRST_CONTAINER}" ha-memory-mcp
) || fail 'ha-memory MCP initialize/tools/list exchange failed'
assert_json 'ha-memory MCP did not advertise its bounded memory tools' \
  'length == 10
    and .[0].id == 1
    and .[0].result.serverInfo.name == "codex-ha-memory"
    and .[0].result.serverInfo.version == "1.1.0"
    and .[1].id == 2
    and any(.[1].result.tools[]; .name == "memory_search")
    and any(.[1].result.tools[]; .name == "memory_remember_explicit")
    and any(.[1].result.tools[]; .name == "memory_list_candidates")
    and any(.[1].result.tools[]; .name == "memory_reject_candidate")
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
    and .[5].id == 6
    and .[5].result.isError == false
    and (.[5].result.structuredContent.result.candidates | length) == 1
    and .[5].result.structuredContent.result.candidates[0].id > 0
    and .[6].id == 7
    and .[6].result.isError == false
    and .[6].result.structuredContent.result.candidate.status == "rejected"
    and .[7].id == 8
    and .[7].result.isError == false
    and (.[7].result.structuredContent.result.candidates | length) == 0
    and .[8].id == 9
    and .[8].result.isError == false
    and .[8].result.structuredContent.result.result == "applied"
    and .[8].result.structuredContent.result.candidate.status == "applied"
    and (.[8].result.structuredContent.result.audit_event_ids | length) == 3
    and .[9].id == null
    and .[9].error.code == -32600' \
  "$(printf '%s\n' "${MCP_OUTPUT}" \
    | docker exec --interactive "${FIRST_CONTAINER}" jq --slurp '.')"

docker rm -f "${FIRST_CONTAINER}" >/dev/null
start_container "${SECOND_CONTAINER}"

PERSISTED_STATUS=$(docker exec "${SECOND_CONTAINER}" ha-memory status) \
  || fail 'persisted memory status failed after container replacement'
assert_json 'catalog or applied memory did not survive container replacement' \
  '.catalog_status == "ready"
    and .memory_counts.applied == 2
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

PERSISTED_MCP_SEARCH=$(docker exec "${SECOND_CONTAINER}" \
  ha-memory search 'Keep the MCP smoke preference') \
  || fail 'persisted MCP memory search failed after container replacement'
assert_json 'MCP-applied memory was not searchable after container replacement' \
  '.result_count >= 1
    and any(.results[];
      .subject == "home:household"
      and any(.memories[];
        .key == "user_preference.mcp_smoke"
        and .value == "Keep the MCP smoke preference"
        and .source == "user_explicit"))' \
  "${PERSISTED_MCP_SEARCH}"

PERSISTED_MCP_RECALL=$(
  printf '%s\n' \
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"memory-restart-smoke","version":"1.0.0"}}}' \
    '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"memory_search","arguments":{"query":"Keep the MCP smoke preference","subject":"home:household","limit":3}}}' \
    'null' \
    | docker exec --interactive "${SECOND_CONTAINER}" ha-memory-mcp
) || fail 'new MCP process could not recall persisted memory'
assert_json 'new MCP process did not recall the MCP-applied fact' \
  'length == 3
    and .[0].id == 1
    and .[1].id == 2
    and .[1].result.isError == false
    and any(.[1].result.structuredContent.result.results[];
      .subject == "home:household"
      and any(.memories[];
        .key == "user_preference.mcp_smoke"
        and .value == "Keep the MCP smoke preference"
        and .source == "user_explicit"))
    and .[2].id == null
    and .[2].error.code == -32600' \
  "$(printf '%s\n' "${PERSISTED_MCP_RECALL}" \
    | docker exec --interactive "${SECOND_CONTAINER}" jq --slurp '.')"

printf 'Home Assistant memory smoke passed: index, lifecycle, privacy, MCP, persistence\n'
