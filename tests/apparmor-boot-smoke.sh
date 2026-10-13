#!/usr/bin/env bash
# Boots the real image entrypoint (/init) under the enforced app AppArmor
# profile. This is the regression gate for the dev.6 exit 126 failure where
# s6-rc could not exec /etc/s6-overlay/s6-rc.d/*/run scripts. An unsupported
# or unloaded profile must fail here, never fall back to unconfined.
set -Eeuo pipefail

IMAGE=${1:-codex-for-home-assistant:test}
PROFILE=${CODEX_TEST_APPARMOR:-codex_home_assistant}
DOCKER_PLATFORM=${DOCKER_PLATFORM:-linux/amd64}
BOOT_TIMEOUT=${APPARMOR_BOOT_TIMEOUT:-180}
STOP_TIMEOUT=${APPARMOR_STOP_TIMEOUT:-75}
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
EXPECTED_INGRESS_CODE=200

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

diagnose() {
  local container=$1
  printf -- '--- diagnostics for %s ---\n' "${container}" >&2
  docker inspect --format 'state={{.State.Status}} exit={{.State.ExitCode}} error={{.State.Error}}\n' \
    "${container}" >&2 2>/dev/null || true
  container_logs "${container}" | tail -n 25 >&2 || true
  docker exec "${container}" /bin/sh -c \
    'for s in codex-updater ha-memoryd ttyd ingress sshd; do
       printf "svc %s: " "${s}"; s6-svstat "/run/service/${s}" 2>&1 || true
     done
     curl --disable --silent --output /dev/null --write-out "http=%{http_code}\n" \
       --max-time 5 http://127.0.0.1:7681/ || echo http=unreachable' >&2 2>/dev/null || true
  printf -- '--- end diagnostics ---\n' >&2
}

profile_is_enforced() {
  grep -Fxq "${PROFILE} (enforce)" /sys/kernel/security/apparmor/profiles 2>/dev/null \
    || sudo -n grep -Fxq "${PROFILE} (enforce)" \
      /sys/kernel/security/apparmor/profiles 2>/dev/null
}

# One bounded deadline covers the container running, the oneshot init log, the
# committed s6-rc bundle, every required service up, and a healthy ingress
# response. Services start after the init log, so late readiness is retried
# until the deadline; an early exit fails immediately with its real code.
wait_for_ready() {
  local container=$1
  shift
  local services=("$@")
  local deadline=$(( SECONDS + BOOT_TIMEOUT ))
  local last_state='unknown'
  local last_reason='waiting'
  local state http_code service
  while (( SECONDS < deadline )); do
    state=$(docker inspect --format '{{.State.Status}}:{{.State.ExitCode}}' "${container}")
    last_state="${state}"
    case "${state}" in
      running:*) ;;
      exited:126)
        diagnose "${container}"
        fail "${container} could not exec S6 service scripts under profile ${PROFILE} (exit 126 Permission denied)"
        ;;
      exited:*)
        diagnose "${container}"
        fail "${container} exited before boot was ready under profile ${PROFILE}: ${state}"
        ;;
      *)
        last_reason='container not running yet'
        sleep 1
        continue
        ;;
    esac
    if ! container_logs "${container}" | grep -Fq 'Codex runtime ready:'; then
      last_reason='init completion log missing'
      sleep 1
      continue
    fi
    local services_down=()
    for service in "${services[@]}"; do
      if ! docker exec "${container}" /bin/sh -c \
        "s6-svstat /run/service/${service} 2>/dev/null | grep -E '^up \\(pid' >/dev/null"; then
        services_down+=("${service}")
      fi
    done
    if (( ${#services_down[@]} > 0 )); then
      last_reason="services not up: ${services_down[*]}"
      sleep 1
      continue
    fi
    http_code=$(docker exec "${container}" /bin/sh -c \
      'curl --disable --silent --show-error --output /dev/null --write-out "%{http_code}" \
       --max-time 10 http://127.0.0.1:7681/' 2>/dev/null || true)
    if [[ "${http_code}" != "${EXPECTED_INGRESS_CODE}" ]]; then
      last_reason="ingress returned http=${http_code:-unreachable}, expected ${EXPECTED_INGRESS_CODE}"
      sleep 1
      continue
    fi
    return 0
  done
  diagnose "${container}"
  fail "boot not ready within ${BOOT_TIMEOUT}s (state=${last_state}, last condition: ${last_reason})"
}

# pgrep flags are passed directly to docker exec: busybox pgrep matches the
# whole command line, and wrapping in sh -c would let the probe match the
# shell that carries the pattern.
require_process() {
  local container=$1
  local label=$2
  shift 2
  if ! docker exec "${container}" pgrep "$@" >/dev/null 2>&1; then
    diagnose "${container}"
    fail "${label} process missing under profile ${PROFILE}"
  fi
}

require_no_process() {
  local container=$1
  local message=$2
  shift 2
  if docker exec "${container}" pgrep "$@" >/dev/null 2>&1; then
    diagnose "${container}"
    fail "${message}"
  fi
}

require_denied_read() {
  local container=$1
  local target=$2
  if docker exec "${container}" /bin/cat "${target}" >/dev/null 2>&1; then
    fail "protected path ${target} was readable under the enforced profile ${PROFILE}"
  fi
}

require_clean_stop() {
  local container=$1
  if ! docker stop -t "${STOP_TIMEOUT}" "${container}" >/dev/null; then
    diagnose "${container}"
    fail "docker stop failed for ${container} under profile ${PROFILE}"
  fi
  local deadline=$(( SECONDS + STOP_TIMEOUT + 15 ))
  local state=''
  while (( SECONDS < deadline )); do
    state=$(docker inspect --format '{{.State.Status}}:{{.State.ExitCode}}' "${container}")
    if [[ "${state}" == exited:* ]]; then
      break
    fi
    sleep 1
  done
  if [[ "${state}" != "exited:0" ]]; then
    diagnose "${container}"
    fail "expected clean shutdown exited:0 for ${container} under profile ${PROFILE}, got ${state:-timeout}"
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
# codex_auto_update stays OFF so the boot smoke does not race an external
# GitHub release check during shutdown; updater process presence is still
# required, and real network update behaviour belongs to the updater smoke.
BOOT_OPTIONS=$(printf \
  '{"authorized_keys":["%s"],"web_terminal_auto_start_codex":false,"tmux_session_name":"codex-ha-apparmor-boot","codex_approval_policy":"on-request","codex_sandbox_mode":"workspace-write","home_assistant_browser_auto_auth":false,"codex_auto_update":false,"log_level":"info"}' \
  "$(< "${WORK_DIR}/client_key.pub")")
DEGRADED_OPTIONS='{"authorized_keys":["ssh-ed25519 AAAA invalid-fixture"],"web_terminal_auto_start_codex":false,"tmux_session_name":"codex-ha-apparmor-degraded","codex_approval_policy":"on-request","codex_sandbox_mode":"workspace-write","home_assistant_browser_auto_auth":false,"codex_auto_update":false,"log_level":"info"}'

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
  || { diagnose "${BOOT_CONTAINER}" 2>/dev/null || true; fail "${BOOT_CONTAINER} could not start under profile ${PROFILE}"; }
wait_for_ready "${BOOT_CONTAINER}" \
  codex-updater ha-memoryd ttyd ingress sshd
require_process "${BOOT_CONTAINER}" 'updater daemon' -f codex-updater-daemon
require_process "${BOOT_CONTAINER}" 'sshd with a configured authorized key' -f /usr/sbin/sshd

require_denied_read "${BOOT_CONTAINER}" /config/secrets.yaml
require_denied_read "${BOOT_CONTAINER}" /config/subdir/secrets.yaml
require_denied_read "${BOOT_CONTAINER}" /config/.storage/fixture
docker exec "${BOOT_CONTAINER}" /bin/sh -c \
  'grep -Fq hue /config/configuration.yaml \
   && printf "%s\n" "lovelace:" >> /config/configuration.yaml' \
  || fail 'ordinary /config read-write contract failed under the enforced profile'

require_clean_stop "${BOOT_CONTAINER}"

docker run -d \
  --platform "${DOCKER_PLATFORM}" \
  --name "${DEGRADED_CONTAINER}" \
  --security-opt seccomp=unconfined \
  --security-opt "apparmor=${PROFILE}" \
  --volume "${DEGRADED_DATA}:/data" \
  --volume "${DEGRADED_CONFIG}:/config" \
  "${IMAGE}" >/dev/null \
  || { diagnose "${DEGRADED_CONTAINER}" 2>/dev/null || true; fail "${DEGRADED_CONTAINER} could not start degraded under profile ${PROFILE}"; }
wait_for_ready "${DEGRADED_CONTAINER}" \
  codex-updater ha-memoryd ttyd ingress
docker exec "${DEGRADED_CONTAINER}" test -e /run/codex-ha/ssh-disabled \
  || fail 'degraded boot did not mark SSH disabled'
require_no_process "${DEGRADED_CONTAINER}" 'sshd is running without a valid authorized key' -f /usr/sbin/sshd
require_process "${DEGRADED_CONTAINER}" 'updater daemon (degraded)' -f codex-updater-daemon
require_clean_stop "${DEGRADED_CONTAINER}"

printf 'AppArmor enforced boot smoke passed for %s (%s enforce)\n' \
  "${IMAGE}" "${PROFILE}"
