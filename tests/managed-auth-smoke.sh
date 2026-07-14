#!/usr/bin/env bash
set -Eeuo pipefail

IMAGE=${1:-codex-for-home-assistant:test}
TEST_ID="codex-ha-managed-auth-${RANDOM}-$$"
APP_CONTAINER="${TEST_ID}-app"
FIXTURE_CONTAINER="${TEST_ID}-fixture"
NETWORK="${TEST_ID}-network"
DATA_VOLUME="${TEST_ID}-data"
CONFIG_VOLUME="${TEST_ID}-config"
WORK_DIR=$(mktemp -d)
SUPERVISOR_TOKEN=managed-auth-smoke-supervisor-token-do-not-use
TOKEN_PREFIX=managedAuthSmokeSecretPrefix

# Git Bash rewrites Linux container paths before invoking native Windows programs.
if [[ "${OSTYPE:-}" == msys* || "${OSTYPE:-}" == cygwin* ]]; then
  docker() {
    MSYS_NO_PATHCONV=1 command docker "$@"
  }
fi

cleanup() {
  docker rm -f "${APP_CONTAINER}" "${FIXTURE_CONTAINER}" >/dev/null 2>&1 || true
  docker volume rm -f "${DATA_VOLUME}" "${CONFIG_VOLUME}" >/dev/null 2>&1 || true
  docker network rm "${NETWORK}" >/dev/null 2>&1 || true
  rm -rf -- "${WORK_DIR}"
  rm -f -- "${WORK_DIR}.secret-scan.log"
}
trap cleanup EXIT

fail() {
  printf 'managed auth smoke: %s\n' "$*" >&2
  if compgen -G "${WORK_DIR}/*.log" >/dev/null; then
    sed \
      -e "s/${SUPERVISOR_TOKEN}/[REDACTED_SUPERVISOR_TOKEN]/g" \
      -e "s/${TOKEN_PREFIX}/[REDACTED_MANAGED_TOKEN]/g" \
      "${WORK_DIR}"/*.log >&2 || true
  fi
  for container in "${APP_CONTAINER}" "${FIXTURE_CONTAINER}"; do
    docker logs "${container}" 2>/dev/null \
      | sed \
        -e "s/${SUPERVISOR_TOKEN}/[REDACTED_SUPERVISOR_TOKEN]/g" \
        -e "s/${TOKEN_PREFIX}/[REDACTED_MANAGED_TOKEN]/g" \
      >&2 || true
  done
  exit 1
}

wait_for_log() {
  local container=$1
  local pattern=$2
  local _
  for _ in $(seq 1 90); do
    if docker logs "${container}" 2>&1 | grep -Fq "${pattern}"; then
      return 0
    fi
    if [[ $(docker inspect --format '{{.State.Running}}' "${container}") != true ]]; then
      fail "${container} exited before logging: ${pattern}"
    fi
    sleep 1
  done
  fail "timed out waiting for ${container} log: ${pattern}"
}

start_app() {
  docker run --detach \
    --platform linux/amd64 \
    --name "${APP_CONTAINER}" \
    --network "${NETWORK}" \
    --env SUPERVISOR_TOKEN="${SUPERVISOR_TOKEN}" \
    --volume "${DATA_VOLUME}:/data" \
    --volume "${CONFIG_VOLUME}:/config" \
    "${IMAGE}" >/dev/null
  wait_for_log "${APP_CONTAINER}" 'Codex runtime ready:'
}

fixture_state() {
  docker exec "${APP_CONTAINER}" curl \
    --fail --silent --show-error http://supervisor/__fixture/state
}

assert_fixture_state() {
  local filter=$1
  local label=$2
  local fixture_json
  fixture_json=$(fixture_state)
  if ! printf '%s' "${fixture_json}" \
    | docker exec --interactive "${APP_CONTAINER}" jq --exit-status "${filter}" \
      >/dev/null; then
    printf '%s\n' "${fixture_json}" >&2
    fail "fixture state mismatch: ${label}"
  fi
}

mutate_fixture() {
  local mutation=$1
  printf '%s' "${mutation}" \
    | docker exec --interactive "${APP_CONTAINER}" curl \
      --fail --silent --show-error \
      --header 'Content-Type: application/json' \
      --data-binary @- \
      http://supervisor/__fixture/mutate >/dev/null
}

write_options() {
  local options_json=$1
  printf '%s' "${options_json}" \
    | docker run --rm --interactive \
      --platform linux/amd64 \
      --entrypoint /bin/sh \
      --volume "${DATA_VOLUME}:/data" \
      "${IMAGE}" \
      -c 'umask 077; cat > /data/options.json'
}

set_auto_auth() {
  local value=$1
  [[ "${value}" == true || "${value}" == false ]] \
    || fail "invalid automatic authentication test value: ${value}"
  docker exec "${APP_CONTAINER}" /bin/sh -c '
    set -eu
    umask 077
    jq --argjson value "$1" ".home_assistant_browser_auto_auth = \$value" \
      /data/options.json > /data/options.json.tmp
    chmod 0600 /data/options.json.tmp
    mv /data/options.json.tmp /data/options.json
  ' sh "${value}"
}

docker image inspect "${IMAGE}" >/dev/null 2>&1 || fail "image not found: ${IMAGE}"
docker network create "${NETWORK}" >/dev/null
docker volume create "${DATA_VOLUME}" >/dev/null
docker volume create "${CONFIG_VOLUME}" >/dev/null

docker create \
  --platform linux/amd64 \
  --name "${FIXTURE_CONTAINER}" \
  --network "${NETWORK}" \
  --network-alias supervisor \
  --network-alias homeassistant \
  --env AUTO_SETUP_FIXTURE_SUPERVISOR_TOKEN="${SUPERVISOR_TOKEN}" \
  --env AUTO_SETUP_FIXTURE_TOKEN_PREFIX="${TOKEN_PREFIX}" \
  --entrypoint node \
  "${IMAGE}" \
  /tmp/ha_browser_auto_setup_fixture.mjs >/dev/null
docker cp tests/ha_browser_auto_setup_fixture.mjs \
  "${FIXTURE_CONTAINER}:/tmp/ha_browser_auto_setup_fixture.mjs"
docker start "${FIXTURE_CONTAINER}" >/dev/null
wait_for_log "${FIXTURE_CONTAINER}" \
  'Home Assistant browser auto-setup fixture ready'

# A missing new option must use the manifest default (true) for both fresh
# installs and upgrades whose existing options.json predates the option.
write_options \
  '{"authorized_keys":[],"web_terminal_auto_start_codex":false,"tmux_session_name":"codex-ha-auto-auth","codex_approval_policy":"on-request","codex_sandbox_mode":"danger-full-access","log_level":"info"}'
start_app
docker exec "${APP_CONTAINER}" ha-browser-auth-status \
  | docker exec --interactive "${APP_CONTAINER}" jq --exit-status \
    '.status == "ready" and .source == "managed"' >/dev/null \
  || fail 'default-ON fresh install did not configure managed authentication'
AUTO_USER_ID=$(docker exec "${APP_CONTAINER}" jq --exit-status --raw-output \
  '.user.id' /run/codex-ha/browser-auth-status.json)
AUTO_TOKEN_HASH=$(docker exec "${APP_CONTAINER}" sha256sum \
  /data/browser-auth/managed-token | awk '{print $1}')
assert_fixture_state '
  (.users | length) == 1
  and .users[0].credential_configured == false
  and .long_lived.issued == 1
  and .long_lived.active == 1
  and .active_refresh_tokens_total == 1
' 'default-ON automatic setup'

docker rm -f "${APP_CONTAINER}" >/dev/null
start_app
[[ $(docker exec "${APP_CONTAINER}" sha256sum \
  /data/browser-auth/managed-token | awk '{print $1}') == "${AUTO_TOKEN_HASH}" ]] \
  || fail 'automatic authentication did not reuse its token after restart'
docker exec "${APP_CONTAINER}" jq --exit-status --arg user_id "${AUTO_USER_ID}" '
  .status == "ready"
  and .source == "managed"
  and .user.id == $user_id
' /run/codex-ha/browser-auth-status.json >/dev/null \
  || fail 'automatic authentication did not reuse its user after restart'
assert_fixture_state '
  (.users | length) == 1
  and .long_lived.issued == 1
  and .long_lived.active == 1
' 'automatic restart reuse'

set_auto_auth false
docker rm -f "${APP_CONTAINER}" >/dev/null
start_app
docker exec "${APP_CONTAINER}" jq --exit-status '
  .status == "disabled" and .reason == "option_disabled"
' /run/codex-ha/browser-auth-status.json >/dev/null \
  || fail 'automatic authentication OFF did not produce disabled status'
docker exec "${APP_CONTAINER}" test ! -e \
  /run/codex-ha/home-assistant-browser.token \
  || fail 'automatic authentication OFF left a runtime browser token'
docker exec "${APP_CONTAINER}" test -f /data/browser-auth/managed-token \
  || fail 'automatic authentication OFF deleted the recoverable managed token'
[[ $(docker exec "${APP_CONTAINER}" sha256sum \
  /data/browser-auth/managed-token | awk '{print $1}') == "${AUTO_TOKEN_HASH}" ]] \
  || fail 'automatic authentication OFF changed the preserved managed token'
assert_fixture_state '
  (.users | length) == 1
  and .long_lived.issued == 1
  and .long_lived.active == 1
' 'automatic authentication OFF preserves identity'

set_auto_auth true
docker rm -f "${APP_CONTAINER}" >/dev/null
start_app
docker exec "${APP_CONTAINER}" jq --exit-status --arg user_id "${AUTO_USER_ID}" '
  .status == "ready"
  and .source == "managed"
  and .user.id == $user_id
' /run/codex-ha/browser-auth-status.json >/dev/null \
  || fail 'automatic authentication ON did not reactivate the preserved identity'
[[ $(docker exec "${APP_CONTAINER}" sha256sum \
  /data/browser-auth/managed-token | awk '{print $1}') == "${AUTO_TOKEN_HASH}" ]] \
  || fail 'automatic authentication ON rotated the preserved token unexpectedly'
set_auto_auth false
docker rm -f "${APP_CONTAINER}" >/dev/null
start_app
docker exec "${APP_CONTAINER}" jq --exit-status \
  '.status == "disabled" and .reason == "option_disabled"' \
  /run/codex-ha/browser-auth-status.json >/dev/null \
  || fail 'automatic authentication was not disabled before identity removal'
docker exec "${APP_CONTAINER}" ha-browser-auth-remove \
  > "${WORK_DIR}/auto-remove.log" 2>&1 \
  || fail 'OFF-state automatic authentication identity cleanup failed'
assert_fixture_state '
  (.users | length) == 0
  and .long_lived.active == 0
' 'automatic authentication cleanup'
docker exec "${APP_CONTAINER}" curl --fail --silent --show-error \
  --request POST http://supervisor/__fixture/reset >/dev/null

docker rm -f "${APP_CONTAINER}" >/dev/null
docker volume rm -f "${DATA_VOLUME}" "${CONFIG_VOLUME}" >/dev/null
docker volume create "${DATA_VOLUME}" >/dev/null
docker volume create "${CONFIG_VOLUME}" >/dev/null
write_options \
  '{"authorized_keys":[],"web_terminal_auto_start_codex":false,"tmux_session_name":"codex-ha-managed-auth","codex_approval_policy":"on-request","codex_sandbox_mode":"danger-full-access","home_assistant_browser_auto_auth":false,"log_level":"info"}'
start_app
docker exec "${APP_CONTAINER}" ha-browser-auth-status \
  | docker exec --interactive "${APP_CONTAINER}" jq --exit-status \
    '.status == "disabled" and .reason == "option_disabled"' >/dev/null \
  || fail 'explicitly disabled authentication did not stay disabled'
DISABLED_SETUP_OUTPUT="${WORK_DIR}/disabled-setup.log"
if docker exec "${APP_CONTAINER}" ha-browser-auth-setup \
  > "${DISABLED_SETUP_OUTPUT}" 2>&1; then
  fail 'manual managed setup ignored the disabled automatic authentication option'
fi
grep -Fq 'Enable the home_assistant_browser_auto_auth App option' \
  "${DISABLED_SETUP_OUTPUT}" \
  || fail 'disabled managed setup did not explain how to enable the option'
set_auto_auth true

LOCK_HOLDER_OUTPUT="${WORK_DIR}/lock-holder.log"
docker exec "${APP_CONTAINER}" /bin/bash -c '
  set -Eeuo pipefail
  install -d -m 0700 /data/browser-auth
  exec 9>> /data/browser-auth/operation.lock
  chmod 0600 /data/browser-auth/operation.lock
  flock -n 9
  printf "locked\n"
  sleep 8
' > "${LOCK_HOLDER_OUTPUT}" 2>&1 &
LOCK_HOLDER_PID=$!
for _ in $(seq 1 40); do
  grep -Fq 'locked' "${LOCK_HOLDER_OUTPUT}" && break
  sleep 0.1
done
grep -Fq 'locked' "${LOCK_HOLDER_OUTPUT}" \
  || fail 'managed authentication lock holder did not start'
LOCK_REJECTION_OUTPUT="${WORK_DIR}/lock-rejection.log"
if docker exec "${APP_CONTAINER}" ha-browser-auth-setup \
  > "${LOCK_REJECTION_OUTPUT}" 2>&1; then
  fail 'concurrent managed setup bypassed the kernel lock'
fi
grep -Fq 'Another managed browser authentication operation is running' \
  "${LOCK_REJECTION_OUTPUT}" \
  || fail 'concurrent managed setup did not report the lock conflict'
set +e
docker exec "${APP_CONTAINER}" timeout 2 \
  ha-browser-auth-refresh --quiet \
  > "${WORK_DIR}/lock-refresh.log" 2>&1
LOCK_REFRESH_RC=$?
set -e
[[ ${LOCK_REFRESH_RC} -ne 124 ]] \
  || fail 'runtime refresh blocked behind the managed operation lock'
wait "${LOCK_HOLDER_PID}"

FIRST_SETUP_OUTPUT="${WORK_DIR}/first-setup.log"
docker exec "${APP_CONTAINER}" ha-browser-auth-setup \
  > "${FIRST_SETUP_OUTPUT}" 2>&1 \
  || fail 'first managed setup failed'
grep -Fq 'Managed browser authentication is ready.' "${FIRST_SETUP_OUTPUT}" \
  || fail 'first setup did not report a sanitized ready result'
grep -Fq 'Reused existing setup: false' "${FIRST_SETUP_OUTPUT}" \
  || fail 'first setup unexpectedly reused an existing identity'

docker exec "${APP_CONTAINER}" ha-browser-auth-status \
  | docker exec --interactive "${APP_CONTAINER}" jq --exit-status '
      .status == "ready"
      and .source == "managed"
      and .user.group_ids == ["system-read-only"]
      and .user.local_only == true
      and .user.is_admin == false
    ' >/dev/null \
  || fail 'managed authentication was not activated with exact read-only policy'
[[ $(docker exec "${APP_CONTAINER}" stat -c '%a' /data/browser-auth) == 700 ]] \
  || fail 'managed authentication directory mode is not 0700'
for file in managed-user.json managed-token; do
  [[ $(docker exec "${APP_CONTAINER}" stat -c '%a' "/data/browser-auth/${file}") == 600 ]] \
    || fail "managed authentication ${file} mode is not 0600"
done
docker exec "${APP_CONTAINER}" test -f /data/browser-auth/operation.lock \
  || fail 'managed authentication kernel lock is not a regular file'
docker exec "${APP_CONTAINER}" test ! -L /data/browser-auth/operation.lock \
  || fail 'managed authentication kernel lock is a symbolic link'
[[ $(docker exec "${APP_CONTAINER}" stat -c '%a' \
  /data/browser-auth/operation.lock) == 600 ]] \
  || fail 'managed authentication kernel lock mode is not 0600'

docker exec "${APP_CONTAINER}" cp \
  /data/browser-auth/managed-token \
  /data/browser-auth/.AAAAAAAAAAAAAAAA.tmp
docker exec "${APP_CONTAINER}" chmod 0600 \
  /data/browser-auth/.AAAAAAAAAAAAAAAA.tmp
docker exec "${APP_CONTAINER}" ha-browser-auth-refresh --quiet \
  || fail 'runtime refresh did not clean a private crash temporary file'
docker exec "${APP_CONTAINER}" test ! -e \
  /data/browser-auth/.AAAAAAAAAAAAAAAA.tmp \
  || fail 'private crash temporary file survived runtime refresh'

docker exec "${APP_CONTAINER}" cp \
  /data/browser-auth/managed-token \
  /data/browser-auth/.CCCCCCCCCCCCCCCC.tmp
docker exec "${APP_CONTAINER}" chmod 0600 \
  /data/browser-auth/.CCCCCCCCCCCCCCCC.tmp
docker exec --env SUPERVISOR_TOKEN= "${APP_CONTAINER}" node \
  /usr/local/share/codex-ha/browser-user-admin.mjs cleanup-temp \
  || fail 'cleanup-only helper unexpectedly required Supervisor authentication'
docker exec "${APP_CONTAINER}" test ! -e \
  /data/browser-auth/.CCCCCCCCCCCCCCCC.tmp \
  || fail 'cleanup-only helper left a private crash temporary file'

docker exec "${APP_CONTAINER}" ln -s managed-token \
  /data/browser-auth/.BBBBBBBBBBBBBBBB.tmp
if docker exec "${APP_CONTAINER}" ha-browser-auth-refresh --quiet \
  > "${WORK_DIR}/unsafe-temp-rejection.log" 2>&1; then
  fail 'runtime refresh deleted or accepted an unsafe temporary symlink'
fi
docker exec "${APP_CONTAINER}" test -L \
  /data/browser-auth/.BBBBBBBBBBBBBBBB.tmp \
  || fail 'unsafe temporary symlink was modified instead of rejected'
docker exec "${APP_CONTAINER}" rm -f \
  /data/browser-auth/.BBBBBBBBBBBBBBBB.tmp
docker exec "${APP_CONTAINER}" ha-browser-auth-refresh --quiet \
  || fail 'runtime refresh did not recover after unsafe temporary cleanup'

assert_fixture_state '
  (.users | length) == 1
  and .users[0].group_ids == ["system-read-only"]
  and .users[0].local_only == true
  and .users[0].is_owner == false
  and .users[0].credential_configured == false
  and .oauth.active_access_tokens == 0
  and .oauth.active_refresh_tokens == 0
  and .oauth.revoked_refresh_tokens == 0
  and .long_lived.issued == 1
  and .long_lived.active == 1
  and .long_lived.deleted == 1
  and .active_refresh_tokens_total == 1
  and (.calls["auth/revoke"] // 0) == 0
  and .calls["core/websocket"] >= 1
  and .calls["supervisor/websocket"] >= 1
' 'first setup cleanup and direct Core session'

SECOND_SETUP_OUTPUT="${WORK_DIR}/second-setup.log"
docker exec "${APP_CONTAINER}" ha-browser-auth-setup \
  > "${SECOND_SETUP_OUTPUT}" 2>&1 \
  || fail 'idempotent managed setup failed'
grep -Fq 'Reused existing setup: true' "${SECOND_SETUP_OUTPUT}" \
  || fail 'second setup did not reuse the managed identity'
assert_fixture_state '
  (.users | length) == 1
  and .users[0].credential_configured == false
  and .oauth.revoked_refresh_tokens == 0
  and .long_lived.issued == 1
  and .long_lived.active == 1
  and .active_refresh_tokens_total == 1
' 'idempotent setup'
REMOVE_WHILE_ON_OUTPUT="${WORK_DIR}/remove-while-on-rejection.log"
if docker exec "${APP_CONTAINER}" ha-browser-auth-remove \
  > "${REMOVE_WHILE_ON_OUTPUT}" 2>&1; then
  fail 'managed identity removal was allowed while automatic authentication was enabled'
fi
grep -Fq 'Disable home_assistant_browser_auto_auth' \
  "${REMOVE_WHILE_ON_OUTPUT}" \
  || fail 'ON-state removal refusal did not explain the persistent deletion workflow'
assert_fixture_state '
  (.users | length) == 1
  and .long_lived.active == 1
  and .active_refresh_tokens_total == 1
' 'ON-state removal refusal preserves identity'

TOKEN_HASH_BEFORE_LOCAL_ONLY_REJECTION=$(docker exec "${APP_CONTAINER}" \
  sha256sum /data/browser-auth/managed-token | awk '{print $1}')
mutate_fixture \
  '{"user_auth_invalid_message":"User cannot authenticate remotely"}'
LOCAL_ONLY_OUTPUT="${WORK_DIR}/local-only-rejection.log"
if docker exec "${APP_CONTAINER}" ha-browser-auth-setup \
  > "${LOCAL_ONLY_OUTPUT}" 2>&1; then
  fail 'local-only source rejection unexpectedly rotated or accepted the token'
fi
grep -Fq 'stored credential was preserved' "${LOCAL_ONLY_OUTPUT}" \
  || fail 'local-only source rejection was not treated as ambiguous'
[[ $(docker exec "${APP_CONTAINER}" sha256sum \
  /data/browser-auth/managed-token | awk '{print $1}') \
  == "${TOKEN_HASH_BEFORE_LOCAL_ONLY_REJECTION}" ]] \
  || fail 'local-only source rejection destroyed the stored token'
docker exec "${APP_CONTAINER}" jq --exit-status \
  '.phase == "ready"' /data/browser-auth/managed-user.json >/dev/null \
  || fail 'local-only source rejection destroyed ready state'
docker exec "${APP_CONTAINER}" test ! -e \
  /run/codex-ha/home-assistant-browser.token \
  || fail 'local-only source rejection left runtime authentication active'
mutate_fixture '{"user_auth_invalid_message":null}'
docker exec "${APP_CONTAINER}" ha-browser-auth-setup \
  > "${WORK_DIR}/local-only-recovery.log" 2>&1 \
  || fail 'managed setup did not recover after local-only rejection cleared'
[[ $(docker exec "${APP_CONTAINER}" sha256sum \
  /data/browser-auth/managed-token | awk '{print $1}') \
  == "${TOKEN_HASH_BEFORE_LOCAL_ONLY_REJECTION}" ]] \
  || fail 'local-only recovery rotated a preserved valid token'

TOKEN_HASH_BEFORE_ORPHAN=$(docker exec "${APP_CONTAINER}" \
  sha256sum /data/browser-auth/managed-token | awk '{print $1}')
mutate_fixture '{"seed_normal_refresh":true}'
assert_fixture_state '
  .oauth.active_refresh_tokens == 1
  and .long_lived.active == 1
  and .active_refresh_tokens_total == 2
' 'orphan normal token injection'
mutate_fixture '{"fail_next":"auth/providers"}'
ORPHAN_PROVIDER_OUTPUT="${WORK_DIR}/orphan-provider-rejection.log"
if docker exec "${APP_CONTAINER}" ha-browser-auth-setup \
  > "${ORPHAN_PROVIDER_OUTPUT}" 2>&1; then
  fail 'orphan-token recovery unexpectedly survived provider preflight failure'
fi
[[ $(docker exec "${APP_CONTAINER}" sha256sum \
  /data/browser-auth/managed-token | awk '{print $1}') \
  == "${TOKEN_HASH_BEFORE_ORPHAN}" ]] \
  || fail 'provider preflight failure changed the stored managed token'
docker exec "${APP_CONTAINER}" jq --exit-status \
  '.phase == "ready"' /data/browser-auth/managed-user.json >/dev/null \
  || fail 'provider preflight failure changed the ready state'
docker exec "${APP_CONTAINER}" test ! -e \
  /run/codex-ha/home-assistant-browser.token \
  || fail 'rejected orphan-token recovery left runtime authentication active'
assert_fixture_state '
  .oauth.active_refresh_tokens == 1
  and .long_lived.active == 1
  and .active_refresh_tokens_total == 2
' 'provider preflight failure preserves the owned LLAT for retry'
ORPHAN_RECOVERY_OUTPUT="${WORK_DIR}/orphan-recovery.log"
docker exec "${APP_CONTAINER}" ha-browser-auth-setup \
  > "${ORPHAN_RECOVERY_OUTPUT}" 2>&1 \
  || fail 'orphan refresh token recovery failed'
TOKEN_HASH_BEFORE=$(docker exec "${APP_CONTAINER}" \
  sha256sum /data/browser-auth/managed-token | awk '{print $1}')
[[ "${TOKEN_HASH_BEFORE}" != "${TOKEN_HASH_BEFORE_ORPHAN}" ]] \
  || fail 'orphan refresh token recovery did not rotate the managed token'
assert_fixture_state '
  .oauth.active_refresh_tokens == 0
  and .oauth.revoked_refresh_tokens == 0
  and .long_lived.issued == 2
  and .long_lived.active == 1
  and .active_refresh_tokens_total == 1
' 'single managed token invariant recovery'

docker rm -f "${APP_CONTAINER}" >/dev/null
start_app
TOKEN_HASH_AFTER_RESTART=$(docker exec "${APP_CONTAINER}" \
  sha256sum /data/browser-auth/managed-token | awk '{print $1}')
[[ "${TOKEN_HASH_AFTER_RESTART}" == "${TOKEN_HASH_BEFORE}" ]] \
  || fail 'managed token changed during a normal container replacement'
docker exec "${APP_CONTAINER}" ha-browser-auth-status \
  | docker exec --interactive "${APP_CONTAINER}" jq --exit-status \
    '.status == "ready" and .source == "managed"' >/dev/null \
  || fail 'managed authentication was not restored after container replacement'
assert_fixture_state '
  (.users | length) == 1
  and .long_lived.issued == 2
  and .long_lived.active == 1
  and .active_refresh_tokens_total == 1
' 'container replacement preservation'

mutate_fixture '{"core_info":{"port":65534}}'
TRANSIENT_OUTPUT="${WORK_DIR}/transient-core-rejection.log"
if docker exec "${APP_CONTAINER}" ha-browser-auth-setup \
  > "${TRANSIENT_OUTPUT}" 2>&1; then
  fail 'managed setup unexpectedly succeeded while direct Core was unavailable'
fi
grep -Fq 'stored credential was preserved' "${TRANSIENT_OUTPUT}" \
  || fail 'transient Core failure did not report credential preservation'
[[ $(docker exec "${APP_CONTAINER}" sha256sum \
  /data/browser-auth/managed-token | awk '{print $1}') == "${TOKEN_HASH_BEFORE}" ]] \
  || fail 'transient Core failure destroyed or changed the managed token'
docker exec "${APP_CONTAINER}" jq --exit-status \
  '.phase == "ready"' /data/browser-auth/managed-user.json >/dev/null \
  || fail 'transient Core failure changed ready managed state'
docker exec "${APP_CONTAINER}" test ! -e \
  /run/codex-ha/home-assistant-browser.token \
  || fail 'transient Core failure left browser authentication active'
mutate_fixture '{"core_info":{"port":8123}}'
docker exec "${APP_CONTAINER}" ha-browser-auth-setup \
  > "${WORK_DIR}/transient-core-recovery.log" 2>&1 \
  || fail 'managed setup did not recover after direct Core returned'
[[ $(docker exec "${APP_CONTAINER}" sha256sum \
  /data/browser-auth/managed-token | awk '{print $1}') == "${TOKEN_HASH_BEFORE}" ]] \
  || fail 'transient Core recovery rotated a preserved valid token'

mutate_fixture '{"revoke":"long_lived"}'
if docker exec "${APP_CONTAINER}" ha-browser-auth-refresh --quiet; then
  fail 'revoked managed token unexpectedly passed runtime refresh'
fi
docker exec "${APP_CONTAINER}" test ! -e \
  /run/codex-ha/home-assistant-browser.token \
  || fail 'revoked managed token remained activated in runtime'
docker exec "${APP_CONTAINER}" ha-browser-auth-status \
  | docker exec --interactive "${APP_CONTAINER}" jq --exit-status \
    '.status == "rejected" and .reason == "user_or_token_validation_failed"' \
    >/dev/null \
  || fail 'revoked token did not produce a fail-closed status'

REPAIR_OUTPUT="${WORK_DIR}/repair-setup.log"
docker exec "${APP_CONTAINER}" ha-browser-auth-setup \
  > "${REPAIR_OUTPUT}" 2>&1 \
  || fail 'managed token repair failed'
TOKEN_HASH_AFTER_REPAIR=$(docker exec "${APP_CONTAINER}" \
  sha256sum /data/browser-auth/managed-token | awk '{print $1}')
[[ "${TOKEN_HASH_AFTER_REPAIR}" != "${TOKEN_HASH_BEFORE}" ]] \
  || fail 'managed token repair did not rotate the revoked credential'
assert_fixture_state '
  (.users | length) == 1
  and .users[0].credential_configured == false
  and .oauth.active_refresh_tokens == 0
  and .oauth.revoked_refresh_tokens == 0
  and .long_lived.issued == 3
  and .long_lived.active == 1
  and .active_refresh_tokens_total == 1
' 'revoked token repair'

USER_ID=$(fixture_state \
  | docker exec --interactive "${APP_CONTAINER}" jq --exit-status --raw-output \
    '.users[0].id')
POLICY_MUTATION=$(docker exec "${APP_CONTAINER}" jq --null-input --compact-output \
  --arg user_id "${USER_ID}" \
  '{user_id: $user_id, user_patch: {group_ids: ["system-read-only", "system-admin"]}}')
mutate_fixture "${POLICY_MUTATION}"
TOKEN_HASH_BEFORE_POLICY_REJECTION=$(docker exec "${APP_CONTAINER}" \
  sha256sum /data/browser-auth/managed-token | awk '{print $1}')
set_auto_auth false
mutate_fixture '{"core_info":{"port":65534}}'
POLICY_TRANSIENT_OUTPUT="${WORK_DIR}/policy-transient-rejection.log"
if docker exec "${APP_CONTAINER}" ha-browser-auth-remove \
  > "${POLICY_TRANSIENT_OUTPUT}" 2>&1; then
  fail 'policy-mutated managed user was removed while Core was unavailable'
fi
[[ $(docker exec "${APP_CONTAINER}" sha256sum \
  /data/browser-auth/managed-token | awk '{print $1}') \
  == "${TOKEN_HASH_BEFORE_POLICY_REJECTION}" ]] \
  || fail 'Core outage during policy rejection destroyed the stored token'
docker exec "${APP_CONTAINER}" jq --exit-status \
  '.phase == "ready"' /data/browser-auth/managed-user.json >/dev/null \
  || fail 'Core outage during policy rejection destroyed ready state'
docker exec "${APP_CONTAINER}" test ! -e \
  /run/codex-ha/home-assistant-browser.token \
  || fail 'Core outage during policy rejection left runtime authentication active'
assert_fixture_state '
  (.users | length) == 1
  and .users[0].group_ids == ["system-read-only", "system-admin"]
  and .long_lived.active == 1
  and .active_refresh_tokens_total == 1
' 'policy mutation with unavailable Core preserves revocation material'
mutate_fixture '{"core_info":{"port":8123}}'
POLICY_OUTPUT="${WORK_DIR}/policy-rejection.log"
if docker exec "${APP_CONTAINER}" ha-browser-auth-remove \
  > "${POLICY_OUTPUT}" 2>&1; then
  fail 'over-privileged managed user was automatically deleted'
fi
grep -Fq 'automatic deletion is disabled' "${POLICY_OUTPUT}" \
  || fail 'policy mutation did not report explicit deletion refusal'
docker exec "${APP_CONTAINER}" test ! -e \
  /run/codex-ha/home-assistant-browser.token \
  || fail 'policy-mutated credential remained activated in runtime'
docker exec "${APP_CONTAINER}" test ! -e /data/browser-auth/managed-token \
  || fail 'policy-mutated managed token remained stored locally'
assert_fixture_state '
  (.users | length) == 1
  and .users[0].group_ids == ["system-read-only", "system-admin"]
  and .users[0].credential_configured == false
  and .long_lived.active == 0
  and .active_refresh_tokens_total == 0
' 'policy mutation refusal and owned-token revocation'

RESTORE_MUTATION=$(docker exec "${APP_CONTAINER}" jq --null-input --compact-output \
  --arg user_id "${USER_ID}" \
  '{user_id: $user_id, user_patch: {group_ids: ["system-read-only"]}}')
mutate_fixture "${RESTORE_MUTATION}"
REMOVE_OUTPUT="${WORK_DIR}/remove.log"
docker exec "${APP_CONTAINER}" ha-browser-auth-remove \
  > "${REMOVE_OUTPUT}" 2>&1 \
  || fail 'managed browser identity removal failed after policy restoration'
assert_fixture_state '
  (.users | length) == 0
  and .long_lived.active == 0
' 'managed identity removal'
docker exec "${APP_CONTAINER}" test ! -e /data/browser-auth/managed-user.json
docker exec "${APP_CONTAINER}" test ! -e /data/browser-auth/managed-token

set_auto_auth true
docker exec "${APP_CONTAINER}" ha-browser-auth-setup \
  > "${WORK_DIR}/definitive-rejection-base.log" 2>&1 \
  || fail 'managed setup for definitive auth rejection failed'
DEFINITIVE_USER_ID=$(fixture_state \
  | docker exec --interactive "${APP_CONTAINER}" jq --exit-status --raw-output \
    '.users[0].id')
DEFINITIVE_POLICY_MUTATION=$(docker exec "${APP_CONTAINER}" jq \
  --null-input --compact-output --arg user_id "${DEFINITIVE_USER_ID}" \
  '{user_id: $user_id, user_patch: {group_ids: ["system-read-only", "system-admin"]}}')
mutate_fixture "${DEFINITIVE_POLICY_MUTATION}"
mutate_fixture '{"revoke":"long_lived"}'
set_auto_auth false
DEFINITIVE_OUTPUT="${WORK_DIR}/definitive-auth-rejection.log"
if docker exec "${APP_CONTAINER}" ha-browser-auth-remove \
  > "${DEFINITIVE_OUTPUT}" 2>&1; then
  fail 'policy-mutated user with an invalid token was automatically deleted'
fi
docker exec "${APP_CONTAINER}" test ! -e /data/browser-auth/managed-token \
  || fail 'definitively invalid managed token was not removed locally'
DEFINITIVE_RESTORE=$(docker exec "${APP_CONTAINER}" jq \
  --null-input --compact-output --arg user_id "${DEFINITIVE_USER_ID}" \
  '{user_id: $user_id, user_patch: {group_ids: ["system-read-only"]}}')
mutate_fixture "${DEFINITIVE_RESTORE}"
docker exec "${APP_CONTAINER}" ha-browser-auth-remove \
  > "${WORK_DIR}/definitive-auth-cleanup.log" 2>&1 \
  || fail 'managed identity cleanup after definitive auth rejection failed'

set_auto_auth true
docker exec "${APP_CONTAINER}" ha-browser-auth-setup \
  > "${WORK_DIR}/persistent-cleanup-base.log" 2>&1 \
  || fail 'managed setup for persistent cleanup failure failed'
mutate_fixture '{"revoke":"long_lived"}'
mutate_fixture \
  '{"fail_always":["auth/delete_refresh_token","auth/revoke"]}'
PERSISTENT_CLEANUP_OUTPUT="${WORK_DIR}/persistent-cleanup-rejection.log"
if docker exec "${APP_CONTAINER}" ha-browser-auth-setup \
  > "${PERSISTENT_CLEANUP_OUTPUT}" 2>&1; then
  fail 'managed setup unexpectedly ignored persistent token cleanup failures'
fi
grep -Fq 'rollback needs review' "${PERSISTENT_CLEANUP_OUTPUT}" \
  || fail 'persistent token cleanup failure was not reported explicitly'
docker exec "${APP_CONTAINER}" jq --exit-status '
  .phase == "provisioning"
  and (.temporary_username | type == "string")
' /data/browser-auth/managed-user.json >/dev/null \
  || fail 'unconfirmed temporary token cleanup did not preserve its journal'
docker exec "${APP_CONTAINER}" test -f /data/browser-auth/managed-token \
  || fail 'uncertain managed LLAT was not preserved for recovery'
docker exec "${APP_CONTAINER}" test ! -e \
  /run/codex-ha/home-assistant-browser.token \
  || fail 'incomplete token cleanup left runtime authentication active'
assert_fixture_state '
  (.users | length) == 1
  and .users[0].credential_configured == false
  and .oauth.active_refresh_tokens == 1
  and .long_lived.active == 1
  and .active_refresh_tokens_total == 2
' 'persistent cleanup failure keeps an explicit recoverable journal'
mutate_fixture '{"clear_failures":true}'
docker exec "${APP_CONTAINER}" ha-browser-auth-setup \
  > "${WORK_DIR}/persistent-cleanup-recovery.log" 2>&1 \
  || fail 'managed setup did not recover journaled uncertain tokens'
docker exec "${APP_CONTAINER}" jq --exit-status '
  .phase == "ready" and (has("temporary_username") | not)
' /data/browser-auth/managed-user.json >/dev/null \
  || fail 'token cleanup recovery did not clear the completed journal'
assert_fixture_state '
  (.users | length) == 1
  and .users[0].credential_configured == false
  and .oauth.active_refresh_tokens == 0
  and .long_lived.active == 1
  and .active_refresh_tokens_total == 1
' 'journaled uncertain token recovery'
set_auto_auth false
docker exec "${APP_CONTAINER}" ha-browser-auth-remove \
  > "${WORK_DIR}/persistent-cleanup-remove.log" 2>&1 \
  || fail 'managed identity removal after cleanup recovery failed'

set_auto_auth true
mutate_fixture \
  '{"fail_next":"auth/long_lived_access_token_after_create"}'
AMBIGUOUS_LLAT_OUTPUT="${WORK_DIR}/ambiguous-llat-rejection.log"
if docker exec "${APP_CONTAINER}" ha-browser-auth-setup \
  > "${AMBIGUOUS_LLAT_OUTPUT}" 2>&1; then
  fail 'managed setup unexpectedly accepted an ambiguous LLAT response'
fi
assert_fixture_state '
  (.users | length) == 0
  and .oauth.active_refresh_tokens == 0
  and .long_lived.active == 0
  and .active_refresh_tokens_total == 0
' 'ambiguous LLAT response cleanup'
docker exec "${APP_CONTAINER}" test ! -e /data/browser-auth/managed-user.json \
  || fail 'ambiguous LLAT response left managed state behind'
docker exec "${APP_CONTAINER}" test ! -e /data/browser-auth/managed-token \
  || fail 'ambiguous LLAT response left recovery material behind'

mutate_fixture \
  '{"fail_next":"config/auth_provider/homeassistant/create_after_auth"}'
PARTIAL_CREDENTIAL_OUTPUT="${WORK_DIR}/partial-credential-rejection.log"
if docker exec "${APP_CONTAINER}" ha-browser-auth-setup \
  > "${PARTIAL_CREDENTIAL_OUTPUT}" 2>&1; then
  fail 'managed setup unexpectedly survived an injected partial credential failure'
fi
assert_fixture_state '
  (.users | length) == 0
  and .oauth.active_refresh_tokens == 0
  and .long_lived.active == 0
' 'partial credential creation rollback'
docker exec "${APP_CONTAINER}" test ! -e /data/browser-auth/managed-user.json \
  || fail 'partial credential failure left managed state behind'

mutate_fixture '{"provider_available":false}'
PROVIDER_OUTPUT="${WORK_DIR}/provider-rejection.log"
if docker exec "${APP_CONTAINER}" ha-browser-auth-setup \
  > "${PROVIDER_OUTPUT}" 2>&1; then
  fail 'managed setup unexpectedly succeeded without the homeassistant provider'
fi
assert_fixture_state '
  (.users | length) == 0
  and .oauth.active_refresh_tokens == 0
  and .long_lived.active == 0
' 'missing provider rollback'
docker exec "${APP_CONTAINER}" test ! -e /data/browser-auth/managed-user.json \
  || fail 'failed first setup left managed state behind'
docker exec "${APP_CONTAINER}" test ! -e /data/browser-auth/managed-token \
  || fail 'failed first setup left a managed token behind'

SECRET_SCAN="${WORK_DIR}.secret-scan.log"
{
  for log_file in "${WORK_DIR}"/*.log; do
    cat "${log_file}"
  done
  docker logs "${APP_CONTAINER}" 2>&1
  docker logs "${FIXTURE_CONTAINER}" 2>&1
} > "${SECRET_SCAN}"
if grep -Fq "${SUPERVISOR_TOKEN}" "${SECRET_SCAN}" \
  || grep -Fq "${TOKEN_PREFIX}" "${SECRET_SCAN}"; then
  fail 'managed authentication output or logs disclosed a fixture credential'
fi

printf 'Managed browser authentication smoke passed: setup, reuse, restart, rotation, fail-closed policy, removal, rollback\n'
