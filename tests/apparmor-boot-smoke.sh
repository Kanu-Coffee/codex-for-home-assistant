#!/usr/bin/env bash
# Boots the real image entrypoint (/init) under the enforced app AppArmor
# profile. This is the regression gate for the dev.6 exit 126 failure where
# s6-rc could not exec /etc/s6-overlay/s6-rc.d/*/run scripts. An unsupported
# or unloaded profile must fail here, never fall back to unconfined.
set -Eeuo pipefail

IMAGE=${1:-codex-for-home-assistant:test}
PROFILE=${CODEX_TEST_APPARMOR:-codex_home_assistant}
DOCKER_PLATFORM=${DOCKER_PLATFORM:-linux/amd64}
BOOT_TIMEOUT=${APPARMOR_BOOT_TIMEOUT:-120}
TEST_ID="codex-ha-apparmor-boot-${RANDOM}-$$"
BOOT_CONTAINER="${TEST_ID}-boot"
DEGRADED_CONTAINER="${TEST_ID}-degraded"
BOOT_DATA="${TEST_ID}-boot-data"
BOOT_CONFIG="${TEST_ID}-boot-config"
DEGRADED_DATA="${TEST_ID}-degraded-data"
DEGRADED_CONFIG="${TEST_ID}-degraded-config"
WORK_DIR=$(mktemp -d)
SUPERVISOR_TOKEN=apparmor-boot-smoke-token-do-not-use
SECRET_MARKER='apparmor-boot-secret-marker-do-not-use'

cleanup() {
  docker rm -f "${BOOT_CONTAINER}" "${DEGRADED_CONTAINER}" >/dev/null 2>&1 || true
  docker volume rm -f \
    "${BOOT_DATA}" "${BOOT_CONFIG}" "${DEGRADED_DATA}" "${DEGRADED_CONFIG}" \
    >/dev/null 2>&1 || true
  rm -rf -- "${WORK_DIR}"
}
trap cleanup EXIT

fail() {
  printf 'apparmor boot smoke: %s\n' "$*" >&2
  exit 1
}

container_logs() {
  docker logs "$1" 2>&1 \
    | sed -e "s/${SUPERVISOR_TOKEN}/[REDACTED_SYNTHETIC_TOKEN]/g" || true
}

profile_is_enforced() {
  grep -Fxq "${PROFILE} (enforce)" /sys/kernel/security/apparmor/profiles 2>/dev/null \
    || sudo -n grep -Fxq "${PROFILE} (enforce)" \
      /sys/kernel/security/apparmor/profiles 2>/dev/null
}

wait_for_boot() {
  local container=$1
  local deadline=$(( SECONDS + BOOT_TIMEOUT ))
  while (( SECONDS < deadline )); do
    if container_logs "${container}" | grep -Fq 'Codex runtime ready:'; then
      return 0
    fi
    local state
    state=$(docker inspect --format '{{.State.Status}}:{{.State.ExitCode}}' "${container}")
    case "${state}" in
      running:*) sleep 1 ;;
      exited:126)
        fail "${container} failed to exec the S6 service scripts under profile ${PROFILE} (exit 126 Permission denied)"
        ;;
      exited:*)
        fail "${container} exited before init completed: state ${state}"
        ;;
      *) sleep 1 ;;
    esac
  done
  fail "timed out waiting for ${container} to log Codex runtime ready under profile ${PROFILE}"
}

require_service_up() {
  local container=$1
  local service=$2
  docker exec "${container}" /bin/sh -c \
    "s6-svstat /run/service/${service} | grep -E '^up \\(pid'" >/dev/null 2>&1 \
    || fail "S6 service ${service} is not up under profile ${PROFILE}: $(container_logs "${container}" | tail -n 20)"
}

require_denied_read() {
  local container=$1
  local target=$2
  if docker exec "${container}" /bin/cat "${target}" >/dev/null 2>&1; then
    fail "protected path ${target} was readable under the enforced profile ${PROFILE}"
  fi
}

docker image inspect "${IMAGE}" >/dev/null 2>&1 || fail "image not found: ${IMAGE}"
[[ "$(cat /sys/module/apparmor/parameters/enabled 2>/dev/null)" == Y ]] \
  || fail 'host kernel AppArmor is disabled; refusing an unconfined fallback'
profile_is_enforced \
  || fail "profile ${PROFILE} is not loaded in enforce mode; load it first with apparmor_parser --replace"

for volume in "${BOOT_DATA}" "${BOOT_CONFIG}" "${DEGRADED_DATA}" "${DEGRADED_CONFIG}"; do
  docker volume create "${volume}" >/dev/null
done

ssh-keygen -q -t ed25519 -N '' -f "${WORK_DIR}/client_key"
BOOT_OPTIONS=$(printf \
  '{"authorized_keys":["%s"],"web_terminal_auto_start_codex":false,"tmux_session_name":"codex-ha-apparmor-boot","codex_approval_policy":"on-request","codex_sandbox_mode":"workspace-write","home_assistant_browser_auto_auth":false,"log_level":"info"}' \
  "$(< "${WORK_DIR}/client_key.pub")")
DEGRADED_OPTIONS='{"authorized_keys":["ssh-ed25519 AAAA invalid-fixture"],"web_terminal_auto_start_codex":false,"tmux_session_name":"codex-ha-apparmor-degraded","codex_approval_policy":"on-request","codex_sandbox_mode":"workspace-write","home_assistant_browser_auto_auth":false,"log_level":"info"}'

# Fixture preparation uses a throwaway unconfined helper; the containers under
# test always run the real /init entrypoint with the enforced profile.
seed_json() {
  printf '%s' "$2" | docker run --rm --interactive \
    --platform "${DOCKER_PLATFORM}" \
    --security-opt apparmor=unconfined \
    --entrypoint /bin/sh \
    --volume "$1:/data" \
    "${IMAGE}" \
    -c 'umask 077; cat > /data/options.json'
}
for pair in "${BOOT_DATA}:${BOOT_OPTIONS}" "${DEGRADED_DATA}:${DEGRADED_OPTIONS}"; do
  seed_json "${pair%%:*}" "${pair#*:}"
done
for config_volume in "${BOOT_CONFIG}" "${DEGRADED_CONFIG}"; do
  docker run --rm --platform "${DOCKER_PLATFORM}" \
    --security-opt apparmor=unconfined \
    --entrypoint /bin/sh --volume "${config_volume}:/config" "${IMAGE}" -c \
    "mkdir -p /config/.storage /config/subdir \
     && printf '%s\n' '${SECRET_MARKER}' > /config/secrets.yaml \
     && printf '%s\n' '${SECRET_MARKER}' > /config/subdir/secrets.yaml \
     && printf '%s\n' '{}' > /config/.storage/fixture \
     && printf '%s\n' 'hue:' > /config/configuration.yaml"
done

docker run -d \
  --platform "${DOCKER_PLATFORM}" \
  --name "${BOOT_CONTAINER}" \
  --security-opt seccomp=unconfined \
  --security-opt "apparmor=${PROFILE}" \
  --env SUPERVISOR_TOKEN="${SUPERVISOR_TOKEN}" \
  --volume "${BOOT_DATA}:/data" \
  --volume "${BOOT_CONFIG}:/config" \
  "${IMAGE}" >/dev/null \
  || fail "${BOOT_CONTAINER} could not start under profile ${PROFILE}: $(docker inspect --format '{{.State.Status}}:{{.State.ExitCode}}' "${BOOT_CONTAINER}" 2>/dev/null || true)"
wait_for_boot "${BOOT_CONTAINER}"

docker exec "${BOOT_CONTAINER}" test -f /run/s6-rc/current.ok \
  || fail 's6-rc did not finish bringing up the current bundle'
for service in codex-updater ha-memoryd ttyd ingress sshd; do
  require_service_up "${BOOT_CONTAINER}" "${service}"
done
docker exec "${BOOT_CONTAINER}" /bin/sh -c \
  'pgrep -f codex-updater-daemon >/dev/null' \
  || fail 'updater daemon process is missing under the enforced profile'
INGRESS_CODE=$(docker exec "${BOOT_CONTAINER}" /bin/sh -c \
  'curl --disable --silent --show-error --output /dev/null --write-out "%{http_code}" --max-time 10 http://127.0.0.1:7681/' \
  || true)
[[ "${INGRESS_CODE}" != 000 && -n "${INGRESS_CODE}" ]] \
  || fail 'Ingress did not answer over loopback under the enforced profile'

require_denied_read "${BOOT_CONTAINER}" /config/secrets.yaml
require_denied_read "${BOOT_CONTAINER}" /config/subdir/secrets.yaml
require_denied_read "${BOOT_CONTAINER}" /config/.storage/fixture
docker exec "${BOOT_CONTAINER}" /bin/sh -c \
  'grep -Fq hue /config/configuration.yaml \
   && printf "%s\n" "lovelace:" >> /config/configuration.yaml' \
  || fail 'ordinary /config read-write contract failed under the enforced profile'

docker exec "${BOOT_CONTAINER}" /bin/sh -c \
  'pgrep -x sshd >/dev/null' \
  || fail 'sshd is not running although a valid authorized key was configured'

# The updater performs its first-run release check right after boot and can
# defer shutdown signals while that check is in flight. Let the boot settle so
# the container-under-test shutdown reflects the steady state.
sleep 45
BOOT_STATE=
STOP_DEADLINE=$(( SECONDS + 90 ))
docker stop -t 75 "${BOOT_CONTAINER}" >/dev/null \
  || fail 'explicit stop did not complete under the enforced profile'
while (( SECONDS < STOP_DEADLINE )); do
  BOOT_STATE=$(docker inspect --format '{{.State.Status}}:{{.State.ExitCode}}' "${BOOT_CONTAINER}")
  if [[ "${BOOT_STATE}" == exited:* ]]; then
    break
  fi
  sleep 1
done
[[ "${BOOT_STATE}" == "exited:0" ]] \
  || fail "clean shutdown under profile ${PROFILE} failed: ${BOOT_STATE}"

docker run -d \
  --platform "${DOCKER_PLATFORM}" \
  --name "${DEGRADED_CONTAINER}" \
  --security-opt seccomp=unconfined \
  --security-opt "apparmor=${PROFILE}" \
  --volume "${DEGRADED_DATA}:/data" \
  --volume "${DEGRADED_CONFIG}:/config" \
  "${IMAGE}" >/dev/null \
  || fail "${DEGRADED_CONTAINER} could not start degraded under profile ${PROFILE}"
wait_for_boot "${DEGRADED_CONTAINER}"
docker exec "${DEGRADED_CONTAINER}" test -e /run/codex-ha/ssh-disabled \
  || fail 'degraded boot did not mark SSH disabled'
if docker exec "${DEGRADED_CONTAINER}" /bin/sh -c \
  'pgrep -x sshd >/dev/null'; then
  fail 'sshd is running without a valid authorized key'
fi
for service in codex-updater ha-memoryd ttyd ingress; do
  require_service_up "${DEGRADED_CONTAINER}" "${service}"
done
DEGRADED_CODE=$(docker exec "${DEGRADED_CONTAINER}" /bin/sh -c \
  'curl --disable --silent --show-error --output /dev/null --write-out "%{http_code}" --max-time 10 http://127.0.0.1:7681/' \
  || true)
[[ "${DEGRADED_CODE}" != 000 && -n "${DEGRADED_CODE}" ]] \
  || fail 'Ingress did not answer the degraded boot under the enforced profile'
sleep 45
docker stop -t 75 "${DEGRADED_CONTAINER}" >/dev/null \
  || fail 'degraded container did not stop cleanly'

printf 'AppArmor enforced boot smoke passed for %s (%s enforce)\n' \
  "${IMAGE}" "${PROFILE}"
