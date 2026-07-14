#!/usr/bin/env bash
# Container snippets are single-quoted so their variables expand only inside
# the image under test.
# shellcheck disable=SC2016
set -Eeuo pipefail

IMAGE=${1:-codex-for-home-assistant:test}
TEST_ID="codex-ha-user-files-${RANDOM}-$$"
MAIN_VOLUME="${TEST_ID}-main"
SYMLINK_VOLUME="${TEST_ID}-symlink"
HARDLINK_VOLUME="${TEST_ID}-hardlink"
NONREGULAR_VOLUME="${TEST_ID}-nonregular"
RECOVERY_VOLUME="${TEST_ID}-recovery"
VOLUMES=(
  "${MAIN_VOLUME}"
  "${SYMLINK_VOLUME}"
  "${HARDLINK_VOLUME}"
  "${NONREGULAR_VOLUME}"
  "${RECOVERY_VOLUME}"
)
CONFIG_SECRET="${TEST_ID}-config-secret"
AGENTS_SECRET="${TEST_ID}-agents-secret"
AUTH_SECRET="${TEST_ID}-auth-secret"
OVERRIDE_SECRET="${TEST_ID}-override-secret"
POST_AGENTS_MARKER="${TEST_ID}-post-agents-refresh"
POST_CONFIG_MARKER="${TEST_ID}-post-config-refresh"

# Git Bash rewrites Linux container paths before invoking native Windows programs.
if [[ "${OSTYPE:-}" == msys* || "${OSTYPE:-}" == cygwin* ]]; then
  docker() {
    MSYS_NO_PATHCONV=1 command docker "$@"
  }
fi

cleanup() {
  docker volume rm -f "${VOLUMES[@]}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

fail() {
  printf 'user-files update smoke: %s\n' "$*" >&2
  exit 1
}

run_volume() {
  local volume=$1
  shift
  docker run --rm \
    --platform linux/amd64 \
    --entrypoint /bin/sh \
    --volume "${volume}:/data" \
    "${IMAGE}" "$@"
}

run_helper() {
  local volume=$1
  run_volume "${volume}" -c '
    install -d -m 0700 /run/codex-ha
    exec /usr/local/bin/codex-user-files-update
  '
}

path_hash() {
  local volume=$1
  local path=$2
  run_volume "${volume}" -c 'sha256sum "$1" | awk '\''{print $1}'\''' sh "${path}"
}

assert_json() {
  local value=$1
  local expression=$2
  printf '%s\n' "${value}" | docker run --rm --interactive \
    --platform linux/amd64 \
    --entrypoint jq \
    "${IMAGE}" --exit-status "${expression}" >/dev/null \
    || fail "JSON assertion failed: ${expression}"
}

json_value() {
  local value=$1
  local expression=$2
  printf '%s\n' "${value}" | docker run --rm --interactive \
    --platform linux/amd64 \
    --entrypoint jq \
    "${IMAGE}" --raw-output "${expression}"
}

backup_count() {
  local volume=$1
  run_volume "${volume}" -c '
    if [[ -d /data/codex/backups/user-files ]]; then
      find /data/codex/backups/user-files -mindepth 1 -maxdepth 1 -type d \
        | wc -l | tr -d " "
    else
      printf "0\n"
    fi
  '
}

assert_output_is_sanitized() {
  local output=$1
  local secret
  for secret in \
    "${CONFIG_SECRET}" \
    "${AGENTS_SECRET}" \
    "${AUTH_SECRET}" \
    "${OVERRIDE_SECRET}"; do
    if grep -Fq -- "${secret}" <<< "${output}"; then
      fail 'user file content appeared in helper output'
    fi
  done
}

docker image inspect "${IMAGE}" >/dev/null 2>&1 \
  || fail "image not found: ${IMAGE}"
for volume in "${VOLUMES[@]}"; do
  docker volume create "${volume}" >/dev/null
done

APP_VERSION=$(docker run --rm --platform linux/amd64 --entrypoint /bin/sh \
  "${IMAGE}" -c 'cat /usr/local/share/codex-ha/app-version')
IMAGE_VERSION=$(docker image inspect --format \
  '{{index .Config.Labels "io.hass.version"}}' "${IMAGE}")
[[ "${APP_VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
[[ "${APP_VERSION}" == "${IMAGE_VERSION}" ]] \
  || fail 'baked App version does not match the image label'
[[ $(docker run --rm --platform linux/amd64 --entrypoint stat "${IMAGE}" \
  -c '%a:%U:%G' /usr/local/share/codex-ha/app-version) == 644:root:root ]]
[[ $(docker run --rm --platform linux/amd64 --entrypoint stat "${IMAGE}" \
  -c '%a:%U:%G' /usr/local/share/codex-ha/user-files-update.mjs) == 644:root:root ]]

docker run --rm \
  --platform linux/amd64 \
  --entrypoint /usr/local/bin/codex-user-files-update \
  "${IMAGE}" unexpected-argument >/dev/null 2>&1 \
  && fail 'user-file update wrapper accepted an argument'

# Missing codex_user_files_update_mode must preserve every existing user file.
docker run --rm \
  --platform linux/amd64 \
  --entrypoint /bin/sh \
  --volume "${MAIN_VOLUME}:/data" \
  --env CONFIG_SECRET="${CONFIG_SECRET}" \
  --env AGENTS_SECRET="${AGENTS_SECRET}" \
  --env AUTH_SECRET="${AUTH_SECRET}" \
  --env OVERRIDE_SECRET="${OVERRIDE_SECRET}" \
  "${IMAGE}" -c '
    set -eu
    umask 077
    mkdir -p /data/codex
    printf "%s\n" \
      "{\"codex_approval_policy\":\"never\",\"codex_sandbox_mode\":\"workspace-write\"}" \
      > /data/options.json
    printf "# %s\n" "${CONFIG_SECRET}" > /data/codex/config.toml
    printf "<!-- %s -->\n" "${AGENTS_SECRET}" > /data/codex/AGENTS.md
    printf "{\"token\":\"%s\"}\n" "${AUTH_SECRET}" > /data/codex/auth.json
    printf "<!-- %s -->\n" "${OVERRIDE_SECRET}" \
      > /data/codex/AGENTS.override.md
    chmod 0600 /data/options.json /data/codex/config.toml \
      /data/codex/auth.json /data/codex/AGENTS.override.md
    chmod 0644 /data/codex/AGENTS.md
  '

CONFIG_HASH_BEFORE=$(path_hash "${MAIN_VOLUME}" /data/codex/config.toml)
AGENTS_HASH_BEFORE=$(path_hash "${MAIN_VOLUME}" /data/codex/AGENTS.md)
AUTH_HASH_BEFORE=$(path_hash "${MAIN_VOLUME}" /data/codex/auth.json)
OVERRIDE_HASH_BEFORE=$(path_hash \
  "${MAIN_VOLUME}" /data/codex/AGENTS.override.md)

PRESERVE_OUTPUT=$(run_helper "${MAIN_VOLUME}") \
  || fail 'default preserve helper run failed'
assert_json "${PRESERVE_OUTPUT}" \
  '.mode == "preserve" and .refreshed == [] and .backup_directory == null and .created == []'
assert_output_is_sanitized "${PRESERVE_OUTPUT}"
[[ $(path_hash "${MAIN_VOLUME}" /data/codex/config.toml) \
  == "${CONFIG_HASH_BEFORE}" ]]
[[ $(path_hash "${MAIN_VOLUME}" /data/codex/AGENTS.md) \
  == "${AGENTS_HASH_BEFORE}" ]]
[[ $(path_hash "${MAIN_VOLUME}" /data/codex/auth.json) \
  == "${AUTH_HASH_BEFORE}" ]]
[[ $(path_hash "${MAIN_VOLUME}" /data/codex/AGENTS.override.md) \
  == "${OVERRIDE_HASH_BEFORE}" ]]
run_volume "${MAIN_VOLUME}" -c '
  test ! -e /data/codex/.user-files-update-state.json
  test ! -e /data/codex/.user-files-update-journal.json
  test ! -e /data/codex/backups/user-files
'

# AGENTS-only refresh creates a private exact backup and marks only that scope.
run_volume "${MAIN_VOLUME}" -c '
  jq ".codex_user_files_update_mode = \"refresh_agents\"" \
    /data/options.json > /data/options.json.tmp
  chmod 0600 /data/options.json.tmp
  mv /data/options.json.tmp /data/options.json
'
AGENTS_OUTPUT=$(run_helper "${MAIN_VOLUME}") \
  || fail 'AGENTS-only refresh failed'
assert_json "${AGENTS_OUTPUT}" \
  '.mode == "refresh_agents" and .refreshed == ["agents"] and (.backup_directory | type == "string")'
assert_output_is_sanitized "${AGENTS_OUTPUT}"
AGENTS_BACKUP=$(json_value "${AGENTS_OUTPUT}" '.backup_directory')
case "${AGENTS_BACKUP}" in
  /data/codex/backups/user-files/refresh-*) ;;
  *) fail "unexpected AGENTS backup path: ${AGENTS_BACKUP}" ;;
esac
run_volume "${MAIN_VOLUME}" -c '
  backup=$1
  version=$2
  test "$(stat -c "%a:%U:%G" "${backup}")" = 700:root:root
  test "$(stat -c "%a:%U:%G" "${backup}/agents.before")" = 600:root:root
  test "$(stat -c "%a:%U:%G" "${backup}/agents.image-default")" = 600:root:root
  test "$(stat -c "%a:%U:%G" "${backup}/metadata.json")" = 600:root:root
  test ! -e "${backup}/config.before"
  test ! -e "${backup}/config.image-default"
  test "$(stat -c "%a:%U:%G" /data/codex/.user-files-update-state.json)" \
    = 600:root:root
  test "$(stat -c "%a:%U:%G" /data/codex/AGENTS.md)" = 644:root:root
  test ! -e /data/codex/.user-files-update-journal.json
  cmp -s /usr/local/share/codex-ha/AGENTS.md /data/codex/AGENTS.md
  jq --exit-status --arg version "${version}" '\''
    .schema == 1
    and (.applied.agents | index($version) != null)
    and (.applied.config | index($version) == null)
  '\'' /data/codex/.user-files-update-state.json >/dev/null
' sh "${AGENTS_BACKUP}" "${APP_VERSION}"
[[ $(path_hash "${MAIN_VOLUME}" "${AGENTS_BACKUP}/agents.before") \
  == "${AGENTS_HASH_BEFORE}" ]]
[[ $(path_hash "${MAIN_VOLUME}" /data/codex/config.toml) \
  == "${CONFIG_HASH_BEFORE}" ]]
[[ $(path_hash "${MAIN_VOLUME}" /data/codex/auth.json) \
  == "${AUTH_HASH_BEFORE}" ]]
[[ $(path_hash "${MAIN_VOLUME}" /data/codex/AGENTS.override.md) \
  == "${OVERRIDE_HASH_BEFORE}" ]]

BACKUP_COUNT_AFTER_AGENTS=$(backup_count "${MAIN_VOLUME}")
run_volume "${MAIN_VOLUME}" -c \
  'printf "\n<!-- %s -->\n" "$1" >> /data/codex/AGENTS.md' \
  sh "${POST_AGENTS_MARKER}"
AGENTS_REPEAT_OUTPUT=$(run_helper "${MAIN_VOLUME}") \
  || fail 'same-version AGENTS repeat failed'
assert_json "${AGENTS_REPEAT_OUTPUT}" \
  '.refreshed == [] and .backup_directory == null'
run_volume "${MAIN_VOLUME}" -c \
  'grep -Fq -- "$1" /data/codex/AGENTS.md' sh "${POST_AGENTS_MARKER}"
[[ $(backup_count "${MAIN_VOLUME}") == "${BACKUP_COUNT_AFTER_AGENTS}" ]] \
  || fail 'same-version AGENTS refresh created another backup'

# Moving to refresh_all in the same image version refreshes only the unmarked scope.
run_volume "${MAIN_VOLUME}" -c '
  jq ".codex_user_files_update_mode = \"refresh_all\"" \
    /data/options.json > /data/options.json.tmp
  chmod 0600 /data/options.json.tmp
  mv /data/options.json.tmp /data/options.json
'
CONFIG_OUTPUT=$(run_helper "${MAIN_VOLUME}") \
  || fail 'refresh_all did not refresh the remaining config scope'
assert_json "${CONFIG_OUTPUT}" \
  '.mode == "refresh_all" and .refreshed == ["config"] and (.backup_directory | type == "string")'
assert_output_is_sanitized "${CONFIG_OUTPUT}"
CONFIG_BACKUP=$(json_value "${CONFIG_OUTPUT}" '.backup_directory')
run_volume "${MAIN_VOLUME}" -c '
  backup=$1
  version=$2
  test "$(stat -c "%a:%U:%G" "${backup}")" = 700:root:root
  test "$(stat -c "%a:%U:%G" "${backup}/config.before")" = 600:root:root
  test "$(stat -c "%a:%U:%G" "${backup}/config.image-default")" = 600:root:root
  test "$(stat -c "%a:%U:%G" "${backup}/metadata.json")" = 600:root:root
  test ! -e "${backup}/agents.before"
  test ! -e "${backup}/agents.image-default"
  printf '\''approval_policy = "never"\nsandbox_mode = "workspace-write"\ncli_auth_credentials_store = "file"\ncheck_for_update_on_startup = false\n'\'' \
    | cmp -s - /data/codex/config.toml
  test "$(stat -c "%a:%U:%G" /data/codex/config.toml)" = 600:root:root
  jq --exit-status --arg version "${version}" '\''
    (.applied.agents | index($version) != null)
    and (.applied.config | index($version) != null)
  '\'' /data/codex/.user-files-update-state.json >/dev/null
' sh "${CONFIG_BACKUP}" "${APP_VERSION}"
[[ $(path_hash "${MAIN_VOLUME}" "${CONFIG_BACKUP}/config.before") \
  == "${CONFIG_HASH_BEFORE}" ]]
run_volume "${MAIN_VOLUME}" -c \
  'grep -Fq -- "$1" /data/codex/AGENTS.md' sh "${POST_AGENTS_MARKER}"
[[ $(path_hash "${MAIN_VOLUME}" /data/codex/auth.json) \
  == "${AUTH_HASH_BEFORE}" ]]
[[ $(path_hash "${MAIN_VOLUME}" /data/codex/AGENTS.override.md) \
  == "${OVERRIDE_HASH_BEFORE}" ]]

BACKUP_COUNT_AFTER_ALL=$(backup_count "${MAIN_VOLUME}")
[[ "${BACKUP_COUNT_AFTER_ALL}" == 2 ]]
run_volume "${MAIN_VOLUME}" -c \
  'printf "\n# %s\n" "$1" >> /data/codex/config.toml' \
  sh "${POST_CONFIG_MARKER}"
CONFIG_REPEAT_OUTPUT=$(run_helper "${MAIN_VOLUME}") \
  || fail 'same-version refresh_all repeat failed'
assert_json "${CONFIG_REPEAT_OUTPUT}" \
  '.refreshed == [] and .backup_directory == null'
run_volume "${MAIN_VOLUME}" -c \
  'grep -Fq -- "$1" /data/codex/config.toml' sh "${POST_CONFIG_MARKER}"
[[ $(backup_count "${MAIN_VOLUME}") == "${BACKUP_COUNT_AFTER_ALL}" ]] \
  || fail 'same-version refresh_all created another backup'

# A retained refresh_all selection is intentionally eligible once again when
# the App version advances. Simulate state written by public 0.2.3, then prove
# that the current image refreshes both targets exactly once and records both
# the previous and current versions.
PREVIOUS_APP_VERSION=0.2.3
[[ "${APP_VERSION}" != "${PREVIOUS_APP_VERSION}" ]] \
  || fail 'cross-version fixture must use a previous App version'
run_volume "${MAIN_VOLUME}" -c '
  previous=$1
  jq --arg previous "${previous}" '\''
    .applied.config = [$previous]
    | .applied.agents = [$previous]
  '\'' /data/codex/.user-files-update-state.json \
    > /data/codex/.user-files-update-state.json.tmp
  chmod 0600 /data/codex/.user-files-update-state.json.tmp
  mv /data/codex/.user-files-update-state.json.tmp \
    /data/codex/.user-files-update-state.json
' sh "${PREVIOUS_APP_VERSION}"
CROSS_VERSION_OUTPUT=$(run_helper "${MAIN_VOLUME}") \
  || fail 'retained refresh_all did not apply for the new App version'
assert_json "${CROSS_VERSION_OUTPUT}" '
  (.refreshed | sort) == ["agents", "config"]
  and (.backup_directory | type == "string")
'
run_volume "${MAIN_VOLUME}" -c '
  previous=$1
  current=$2
  cmp -s /usr/local/share/codex-ha/AGENTS.md /data/codex/AGENTS.md
  printf '\''approval_policy = "never"\nsandbox_mode = "workspace-write"\ncli_auth_credentials_store = "file"\ncheck_for_update_on_startup = false\n'\'' \
    | cmp -s - /data/codex/config.toml
  jq --exit-status --arg previous "${previous}" --arg current "${current}" '\''
    (.applied.agents | index($previous) != null)
    and (.applied.agents | index($current) != null)
    and (.applied.config | index($previous) != null)
    and (.applied.config | index($current) != null)
  '\'' /data/codex/.user-files-update-state.json >/dev/null
' sh "${PREVIOUS_APP_VERSION}" "${APP_VERSION}"
[[ $(backup_count "${MAIN_VOLUME}") -eq $((BACKUP_COUNT_AFTER_ALL + 1)) ]] \
  || fail 'cross-version refresh did not create exactly one new backup'
run_volume "${MAIN_VOLUME}" -c \
  'printf "\n# %s\n" "$1" >> /data/codex/config.toml' \
  sh "${POST_CONFIG_MARKER}"
CROSS_VERSION_REPEAT_OUTPUT=$(run_helper "${MAIN_VOLUME}") \
  || fail 'same-version repeat after cross-version refresh failed'
assert_json "${CROSS_VERSION_REPEAT_OUTPUT}" \
  '.refreshed == [] and .backup_directory == null'
run_volume "${MAIN_VOLUME}" -c \
  'grep -Fq -- "$1" /data/codex/config.toml' sh "${POST_CONFIG_MARKER}"
[[ $(backup_count "${MAIN_VOLUME}") -eq $((BACKUP_COUNT_AFTER_ALL + 1)) ]] \
  || fail 'same-version repeat after cross-version refresh created a backup'

# Recreate journals from a real completed transaction. A committed stale
# journal is cleanup-only and preserves a later user edit. The same generated
# transaction with its state marker removed is uncommitted and rolls back to
# the exact original while preserve mode prevents an immediate re-refresh.
docker run --rm \
  --platform linux/amd64 \
  --entrypoint /bin/sh \
  --volume "${RECOVERY_VOLUME}:/data" \
  --env AGENTS_SECRET="${AGENTS_SECRET}" \
  "${IMAGE}" -c '
    set -eu
    umask 077
    mkdir -p /data/codex
    printf "%s\n" '\''{"codex_user_files_update_mode":"refresh_agents"}'\'' \
      > /data/options.json
    printf "<!-- %s -->\n" "${AGENTS_SECRET}" > /data/codex/AGENTS.md
    chmod 0644 /data/codex/AGENTS.md
  '
RECOVERY_ORIGINAL_HASH=$(path_hash \
  "${RECOVERY_VOLUME}" /data/codex/AGENTS.md)
RECOVERY_INITIAL_OUTPUT=$(run_helper "${RECOVERY_VOLUME}") \
  || fail 'recovery fixture transaction could not be generated'
assert_json "${RECOVERY_INITIAL_OUTPUT}" \
  '.refreshed == ["agents"] and (.backup_directory | type == "string")'
RECOVERY_BACKUP=$(json_value \
  "${RECOVERY_INITIAL_OUTPUT}" '.backup_directory')
RECOVERY_TRANSACTION=${RECOVERY_BACKUP##*/}
[[ $(path_hash "${RECOVERY_VOLUME}" \
    "${RECOVERY_BACKUP}/agents.before") == "${RECOVERY_ORIGINAL_HASH}" ]]

run_volume "${RECOVERY_VOLUME}" -c '
  version=$1
  transaction=$2
  printf "\n<!-- committed-user-edit -->\n" >> /data/codex/AGENTS.md
  jq --null-input --arg version "${version}" --arg transaction "${transaction}" '\''
    {
      schema: 1,
      app_version: $version,
      scopes: ["agents"],
      transaction: $transaction
    }
  '\'' > /data/codex/.user-files-update-journal.json
  chmod 0600 /data/codex/.user-files-update-journal.json
' sh "${APP_VERSION}" "${RECOVERY_TRANSACTION}"
COMMITTED_EDIT_HASH=$(path_hash \
  "${RECOVERY_VOLUME}" /data/codex/AGENTS.md)
COMMITTED_RECOVERY_OUTPUT=$(run_helper "${RECOVERY_VOLUME}") \
  || fail 'committed stale-journal cleanup failed'
assert_json "${COMMITTED_RECOVERY_OUTPUT}" \
  '.recovered == true and .refreshed == [] and .backup_directory == null'
[[ $(path_hash "${RECOVERY_VOLUME}" /data/codex/AGENTS.md) \
  == "${COMMITTED_EDIT_HASH}" ]] \
  || fail 'committed stale-journal cleanup changed a later user edit'
run_volume "${RECOVERY_VOLUME}" -c '
  test ! -e /data/codex/.user-files-update-journal.json
  grep -Fq committed-user-edit /data/codex/AGENTS.md
'
[[ $(backup_count "${RECOVERY_VOLUME}") == 1 ]] \
  || fail 'committed stale-journal cleanup created another backup'

run_volume "${RECOVERY_VOLUME}" -c '
  backup=$1
  version=$2
  transaction=$3
  cp "${backup}/agents.image-default" /data/codex/AGENTS.md
  chmod 0644 /data/codex/AGENTS.md
  jq --arg version "${version}" \
    '\''.applied.agents |= map(select(. != $version))'\'' \
    /data/codex/.user-files-update-state.json \
    > /data/codex/.user-files-update-state.json.tmp
  chmod 0600 /data/codex/.user-files-update-state.json.tmp
  mv /data/codex/.user-files-update-state.json.tmp \
    /data/codex/.user-files-update-state.json
  jq '\''.codex_user_files_update_mode = "preserve"'\'' \
    /data/options.json > /data/options.json.tmp
  chmod 0600 /data/options.json.tmp
  mv /data/options.json.tmp /data/options.json
  jq --null-input --arg version "${version}" --arg transaction "${transaction}" '\''
    {
      schema: 1,
      app_version: $version,
      scopes: ["agents"],
      transaction: $transaction
    }
  '\'' > /data/codex/.user-files-update-journal.json
  chmod 0600 /data/codex/.user-files-update-journal.json
' sh "${RECOVERY_BACKUP}" "${APP_VERSION}" "${RECOVERY_TRANSACTION}"
UNCOMMITTED_RECOVERY_OUTPUT=$(run_helper "${RECOVERY_VOLUME}") \
  || fail 'uncommitted transaction rollback failed'
assert_json "${UNCOMMITTED_RECOVERY_OUTPUT}" \
  '.mode == "preserve" and .recovered == true and .refreshed == []'
[[ $(path_hash "${RECOVERY_VOLUME}" /data/codex/AGENTS.md) \
  == "${RECOVERY_ORIGINAL_HASH}" ]] \
  || fail 'uncommitted journal did not restore the exact original AGENTS.md'
run_volume "${RECOVERY_VOLUME}" -c '
  version=$1
  test ! -e /data/codex/.user-files-update-journal.json
  jq --exit-status --arg version "${version}" \
    '\''(.applied.agents | index($version)) == null'\'' \
    /data/codex/.user-files-update-state.json >/dev/null
' sh "${APP_VERSION}"
[[ $(backup_count "${RECOVERY_VOLUME}") == 1 ]] \
  || fail 'uncommitted recovery created another backup in preserve mode'

# A linked AGENTS target rejects refresh_all before config.toml is changed.
docker run --rm \
  --platform linux/amd64 \
  --entrypoint /bin/sh \
  --volume "${SYMLINK_VOLUME}:/data" \
  --env CONFIG_SECRET="${CONFIG_SECRET}" \
  --env AGENTS_SECRET="${AGENTS_SECRET}" \
  "${IMAGE}" -c '
    set -eu
    umask 077
    mkdir -p /data/codex
    printf "%s\n" '\''{"codex_user_files_update_mode":"refresh_all"}'\'' \
      > /data/options.json
    printf "# %s\n" "${CONFIG_SECRET}" > /data/codex/config.toml
    printf "<!-- %s -->\n" "${AGENTS_SECRET}" > /data/codex/real-agents
    ln -s real-agents /data/codex/AGENTS.md
  '
SYMLINK_CONFIG_HASH=$(path_hash \
  "${SYMLINK_VOLUME}" /data/codex/config.toml)
set +e
SYMLINK_OUTPUT=$(run_helper "${SYMLINK_VOLUME}" 2>&1)
SYMLINK_RC=$?
set -e
[[ ${SYMLINK_RC} -eq 20 ]] \
  || fail "symlink refresh returned ${SYMLINK_RC}, expected 20"
assert_output_is_sanitized "${SYMLINK_OUTPUT}"
[[ $(path_hash "${SYMLINK_VOLUME}" /data/codex/config.toml) \
  == "${SYMLINK_CONFIG_HASH}" ]]
run_volume "${SYMLINK_VOLUME}" -c '
  test -L /data/codex/AGENTS.md
  test "$(readlink /data/codex/AGENTS.md)" = real-agents
  test ! -e /data/codex/.user-files-update-state.json
  test ! -e /data/codex/.user-files-update-journal.json
  test ! -e /data/codex/backups/user-files
'

# A multiply linked config.toml is rejected without changing AGENTS.md.
docker run --rm \
  --platform linux/amd64 \
  --entrypoint /bin/sh \
  --volume "${HARDLINK_VOLUME}:/data" \
  --env CONFIG_SECRET="${CONFIG_SECRET}" \
  --env AGENTS_SECRET="${AGENTS_SECRET}" \
  "${IMAGE}" -c '
    set -eu
    umask 077
    mkdir -p /data/codex
    printf "%s\n" '\''{"codex_user_files_update_mode":"refresh_all"}'\'' \
      > /data/options.json
    printf "# %s\n" "${CONFIG_SECRET}" > /data/codex/config.toml
    ln /data/codex/config.toml /data/codex/config-peer
    printf "<!-- %s -->\n" "${AGENTS_SECRET}" > /data/codex/AGENTS.md
  '
HARDLINK_CONFIG_HASH=$(path_hash \
  "${HARDLINK_VOLUME}" /data/codex/config.toml)
HARDLINK_AGENTS_HASH=$(path_hash \
  "${HARDLINK_VOLUME}" /data/codex/AGENTS.md)
set +e
HARDLINK_OUTPUT=$(run_helper "${HARDLINK_VOLUME}" 2>&1)
HARDLINK_RC=$?
set -e
[[ ${HARDLINK_RC} -eq 20 ]] \
  || fail "hardlink refresh returned ${HARDLINK_RC}, expected 20"
assert_output_is_sanitized "${HARDLINK_OUTPUT}"
[[ $(path_hash "${HARDLINK_VOLUME}" /data/codex/config.toml) \
  == "${HARDLINK_CONFIG_HASH}" ]]
[[ $(path_hash "${HARDLINK_VOLUME}" /data/codex/AGENTS.md) \
  == "${HARDLINK_AGENTS_HASH}" ]]
run_volume "${HARDLINK_VOLUME}" -c '
  test "$(stat -c "%h" /data/codex/config.toml)" = 2
  test ! -e /data/codex/.user-files-update-state.json
  test ! -e /data/codex/.user-files-update-journal.json
  test ! -e /data/codex/backups/user-files
'

# A FIFO target and a multiply linked runtime lock are both fail-closed.
run_volume "${NONREGULAR_VOLUME}" -c '
  set -eu
  umask 077
  mkdir -p /data/codex
  printf "%s\n" '\''{"codex_user_files_update_mode":"refresh_agents"}'\'' \
    > /data/options.json
  mkfifo /data/codex/AGENTS.md
'
set +e
NONREGULAR_OUTPUT=$(run_helper "${NONREGULAR_VOLUME}" 2>&1)
NONREGULAR_RC=$?
set -e
[[ ${NONREGULAR_RC} -eq 20 ]] \
  || fail "non-regular refresh returned ${NONREGULAR_RC}, expected 20"
assert_output_is_sanitized "${NONREGULAR_OUTPUT}"
run_volume "${NONREGULAR_VOLUME}" -c '
  test -p /data/codex/AGENTS.md
  test ! -e /data/codex/.user-files-update-state.json
  test ! -e /data/codex/.user-files-update-journal.json
  test ! -e /data/codex/backups/user-files
'
set +e
LOCK_OUTPUT=$(run_volume "${NONREGULAR_VOLUME}" -c '
  install -d -m 0700 /run/codex-ha
  : > /run/codex-ha/hardlink-victim
  chmod 0644 /run/codex-ha/hardlink-victim
  ln /run/codex-ha/hardlink-victim /run/codex-ha/user-files-update.lock
  set +e
  /usr/local/bin/codex-user-files-update > /tmp/lock-output 2>&1
  status=$?
  set -e
  if [[ $(stat -c "%a" /run/codex-ha/hardlink-victim) != 644 ]]; then
    printf "runtime lock validation changed the hardlink victim mode\n" >&2
    exit 99
  fi
  cat /tmp/lock-output >&2
  exit "${status}"
' 2>&1)
LOCK_RC=$?
set -e
[[ ${LOCK_RC} -eq 30 ]] \
  || fail "multiply linked runtime lock returned ${LOCK_RC}, expected 30"
[[ "${LOCK_OUTPUT}" == *'ownership or link count is unsafe'* ]] \
  || fail 'unsafe runtime lock did not produce the sanitized diagnostic'

printf 'User-files update smoke passed for %s (App %s)\n' \
  "${IMAGE}" "${APP_VERSION}"
