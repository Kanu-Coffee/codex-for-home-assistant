#!/usr/bin/env bash
set -Eeuo pipefail

IMAGE=${1:-codex-for-home-assistant:test}
TEST_ID="codex-ha-smoke-${RANDOM}-$$"
PUBLIC_CONTAINER="${TEST_ID}-public"
DEGRADED_CONTAINER="${TEST_ID}-degraded"
PUBLIC_DATA="${TEST_ID}-public-data"
PUBLIC_CONFIG="${TEST_ID}-public-config"
DEGRADED_DATA="${TEST_ID}-degraded-data"
DEGRADED_CONFIG="${TEST_ID}-degraded-config"
WORK_DIR=$(mktemp -d)

# Git Bash rewrites Linux container paths before invoking native Windows programs.
if [[ "${OSTYPE:-}" == msys* || "${OSTYPE:-}" == cygwin* ]]; then
  docker() {
    MSYS_NO_PATHCONV=1 command docker "$@"
  }
fi

if command -v python3 >/dev/null 2>&1; then
  PYTHON_BIN=python3
else
  PYTHON_BIN=python
fi

cleanup() {
  docker rm -f "${PUBLIC_CONTAINER}" "${DEGRADED_CONTAINER}" >/dev/null 2>&1 || true
  docker volume rm -f \
    "${PUBLIC_DATA}" \
    "${PUBLIC_CONFIG}" \
    "${DEGRADED_DATA}" \
    "${DEGRADED_CONFIG}" >/dev/null 2>&1 || true
  rm -rf -- "${WORK_DIR}"
}
trap cleanup EXIT

fail() {
  printf 'docker smoke: %s\n' "$*" >&2
  docker logs "${PUBLIC_CONTAINER}" 2>/dev/null || true
  docker logs "${DEGRADED_CONTAINER}" 2>/dev/null || true
  exit 1
}

wait_for_log() {
  local container=$1
  local pattern=$2
  local _
  for _ in $(seq 1 60); do
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

wait_for_process() {
  local container=$1
  local pattern=$2
  local _
  for _ in $(seq 1 30); do
    if docker exec "${container}" pgrep -f "${pattern}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  fail "timed out waiting for ${container} process: ${pattern}"
}

seed_options() {
  local volume=$1
  local options_json=$2
  printf '%s' "${options_json}" | docker run --rm --interactive \
    --platform linux/amd64 \
    --entrypoint /bin/sh \
    --volume "${volume}:/data" \
    "${IMAGE}" \
    -c 'umask 077; cat > /data/options.json'
}

docker image inspect "${IMAGE}" >/dev/null 2>&1 || fail "image not found: ${IMAGE}"

for volume in \
  "${PUBLIC_DATA}" \
  "${PUBLIC_CONFIG}" \
  "${DEGRADED_DATA}" \
  "${DEGRADED_CONFIG}"; do
  docker volume create "${volume}" >/dev/null
done

ssh-keygen -q -t ed25519 -N '' -f "${WORK_DIR}/client_key"
PUBLIC_KEY=$(< "${WORK_DIR}/client_key.pub")
PUBLIC_OPTIONS=$("${PYTHON_BIN}" -c '
import json, sys
print(json.dumps({
    "authorized_keys": [sys.argv[1]],
    "web_terminal_auto_start_codex": False,
    "tmux_session_name": "codex-ha-smoke",
    "codex_approval_policy": "on-request",
    "codex_sandbox_mode": "danger-full-access",
    "log_level": "info",
}))
' "${PUBLIC_KEY}")
DEGRADED_OPTIONS='{"authorized_keys":["ssh-ed25519 AAAA invalid-fixture"],"web_terminal_auto_start_codex":false,"tmux_session_name":"codex-ha-degraded","codex_approval_policy":"on-request","codex_sandbox_mode":"danger-full-access","log_level":"info"}'

seed_options "${PUBLIC_DATA}" "${PUBLIC_OPTIONS}"
seed_options "${DEGRADED_DATA}" "${DEGRADED_OPTIONS}"
docker run --rm \
  --platform linux/amd64 \
  --entrypoint /bin/sh \
  --volume "${DEGRADED_DATA}:/data" \
  "${IMAGE}" \
  -c 'mkdir -p /data/ssh && : > /data/ssh/ssh_host_ed25519_key'

docker run --detach \
  --platform linux/amd64 \
  --name "${PUBLIC_CONTAINER}" \
  --env SUPERVISOR_TOKEN=smoke-supervisor-token-do-not-use \
  --publish 127.0.0.1::22 \
  --volume "${PUBLIC_DATA}:/data" \
  --volume "${PUBLIC_CONFIG}:/config" \
  "${IMAGE}" >/dev/null

wait_for_log "${PUBLIC_CONTAINER}" 'Codex runtime ready:'
wait_for_process "${PUBLIC_CONTAINER}" '/usr/sbin/sshd'
wait_for_process "${PUBLIC_CONTAINER}" 'ttyd'
wait_for_process "${PUBLIC_CONTAINER}" 'nginx'

EXPECTED_CODEX_VERSION=$(docker image inspect \
  --format '{{index .Config.Labels "io.hass.version"}}' "${IMAGE}")
CODEX_OUTPUT=$(docker exec "${PUBLIC_CONTAINER}" codex --version)
[[ "${CODEX_OUTPUT}" =~ ^codex-cli\ [0-9]+\.[0-9]+\.[0-9]+$ ]] \
  || fail "unexpected Codex version output: ${CODEX_OUTPUT} (image ${EXPECTED_CODEX_VERSION})"

docker exec "${PUBLIC_CONTAINER}" sshd -t -f /etc/ssh/sshd_config
docker exec "${PUBLIC_CONTAINER}" nginx -t -c /etc/nginx/nginx.conf
docker exec "${PUBLIC_CONTAINER}" test -w /config
docker exec "${PUBLIC_CONTAINER}" test ! -e /run/codex-ha/ssh-disabled

docker exec "${PUBLIC_CONTAINER}" env TMUX_TMPDIR=/data/tmux \
  tmux -L smoke-false new-session -d -s smoke-false -c /config \
  /usr/local/bin/tmux-session-shell
[[ $(docker exec "${PUBLIC_CONTAINER}" env TMUX_TMPDIR=/data/tmux \
  tmux -L smoke-false display-message -p -t smoke-false:0.0 \
  '#{pane_current_path}:#{pane_current_command}') == '/config:bash' ]]
docker exec "${PUBLIC_CONTAINER}" test ! -e /tmp/codex-auto-started
docker exec "${PUBLIC_CONTAINER}" env TMUX_TMPDIR=/data/tmux \
  tmux -L smoke-false kill-server

docker cp tests/fixtures/fake-codex.sh \
  "${PUBLIC_CONTAINER}:/tmp/fake-codex"
docker exec "${PUBLIC_CONTAINER}" chmod 0755 /tmp/fake-codex
docker exec "${PUBLIC_CONTAINER}" /bin/sh -c \
  'jq ".web_terminal_auto_start_codex = true" /data/options.json > /data/options.json.tmp && mv /data/options.json.tmp /data/options.json'
docker exec "${PUBLIC_CONTAINER}" /bin/sh -c \
  'printf "export CODEX_BIN=/tmp/fake-codex\n" >> /run/codex-ha/runtime.env'
docker exec "${PUBLIC_CONTAINER}" env \
  TMUX_TMPDIR=/data/tmux \
  tmux -L smoke-true new-session -d -s smoke-true -c /config \
  /usr/local/bin/tmux-session-shell
for _ in $(seq 1 20); do
  if docker exec "${PUBLIC_CONTAINER}" test -e /tmp/codex-auto-started; then
    break
  fi
  sleep 0.1
done
docker exec "${PUBLIC_CONTAINER}" test -e /tmp/codex-auto-started
[[ $(docker exec "${PUBLIC_CONTAINER}" env TMUX_TMPDIR=/data/tmux \
  tmux -L smoke-true display-message -p -t smoke-true:0.0 \
  '#{pane_current_path}:#{pane_current_command}') == '/config:bash' ]]
docker exec "${PUBLIC_CONTAINER}" env TMUX_TMPDIR=/data/tmux \
  tmux -L smoke-true kill-server

for executable in \
  /etc/s6-overlay/s6-rc.d/codex-ha-init/run \
  /etc/s6-overlay/s6-rc.d/ingress/run \
  /etc/s6-overlay/s6-rc.d/sshd/run \
  /etc/s6-overlay/s6-rc.d/ttyd/run \
  /usr/local/bin/codex-ha-init \
  /usr/local/bin/ha-api \
  /usr/local/bin/supervisor-api \
  /usr/local/bin/web-terminal-entrypoint; do
  docker exec "${PUBLIC_CONTAINER}" test -x "${executable}"
done

[[ $(docker exec "${PUBLIC_CONTAINER}" stat -c '%a' /data/ssh/authorized_keys) == 600 ]]
[[ $(docker exec "${PUBLIC_CONTAINER}" stat -c '%a' /data/ssh/ssh_host_ed25519_key) == 600 ]]
[[ $(docker exec "${PUBLIC_CONTAINER}" stat -c '%a' /data/ssh/ssh_host_ed25519_key.pub) == 644 ]]
[[ $(docker exec "${PUBLIC_CONTAINER}" stat -c '%a' /run/codex-ha/runtime.env) == 600 ]]
[[ $(docker exec "${PUBLIC_CONTAINER}" stat -c '%a' /root/.ssh/environment) == 600 ]]

PORT=$(docker port "${PUBLIC_CONTAINER}" 22/tcp | head -n1 | sed 's/.*://')
SSH_OPTIONS=(
  -i "${WORK_DIR}/client_key"
  -p "${PORT}"
  -o BatchMode=yes
  -o ConnectTimeout=5
  -o IdentitiesOnly=yes
  -o StrictHostKeyChecking=yes
  -o UserKnownHostsFile="${WORK_DIR}/known_hosts"
)
ssh-keyscan -p "${PORT}" 127.0.0.1 > "${WORK_DIR}/known_hosts" 2>/dev/null

SSH_OUTPUT=$(ssh "${SSH_OPTIONS[@]}" root@127.0.0.1 \
  'printf "%s\n" "$CODEX_HOME" "$LANG"; command -v codex; codex --version')
grep -Fxq '/data/codex' <<< "${SSH_OUTPUT}"
grep -Fxq 'C.UTF-8' <<< "${SSH_OUTPUT}"
grep -Fxq '/usr/local/bin/codex' <<< "${SSH_OUTPUT}"
grep -Fxq "${CODEX_OUTPUT}" <<< "${SSH_OUTPUT}"

LOGIN_OUTPUT=$(printf 'pwd\nexit\n' | ssh -tt "${SSH_OPTIONS[@]}" root@127.0.0.1 2>&1)
grep -Fq '/config' <<< "${LOGIN_OUTPUT}"

if ssh \
  -p "${PORT}" \
  -o BatchMode=yes \
  -o ConnectTimeout=5 \
  -o PubkeyAuthentication=no \
  -o PasswordAuthentication=yes \
  -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile="${WORK_DIR}/known_hosts" \
  root@127.0.0.1 true >/dev/null 2>&1; then
  fail 'password-only SSH unexpectedly succeeded'
fi

HOST_KEY_BEFORE=$(docker exec "${PUBLIC_CONTAINER}" \
  ssh-keygen -lf /data/ssh/ssh_host_ed25519_key.pub)
docker exec "${PUBLIC_CONTAINER}" /bin/sh -c \
  'printf "\n# preserved-smoke-marker\n" >> /data/codex/config.toml'
docker exec "${PUBLIC_CONTAINER}" rm -f /data/ssh/ssh_host_rsa_key.pub
docker exec "${PUBLIC_CONTAINER}" codex-ha-init >/dev/null
docker exec "${PUBLIC_CONTAINER}" grep -Fq '# preserved-smoke-marker' /data/codex/config.toml
docker exec "${PUBLIC_CONTAINER}" test -s /data/ssh/ssh_host_rsa_key.pub
[[ $(docker exec "${PUBLIC_CONTAINER}" stat -c '%a' /data/codex/config.toml) == 600 ]]

if docker logs "${PUBLIC_CONTAINER}" 2>&1 | grep -Fq 'smoke-supervisor-token-do-not-use'; then
  fail 'Supervisor token appeared in container logs'
fi

docker rm -f "${PUBLIC_CONTAINER}" >/dev/null
docker run --detach \
  --platform linux/amd64 \
  --name "${PUBLIC_CONTAINER}" \
  --env SUPERVISOR_TOKEN=smoke-supervisor-token-do-not-use \
  --volume "${PUBLIC_DATA}:/data" \
  --volume "${PUBLIC_CONFIG}:/config" \
  "${IMAGE}" >/dev/null
wait_for_log "${PUBLIC_CONTAINER}" 'Codex runtime ready:'
HOST_KEY_AFTER=$(docker exec "${PUBLIC_CONTAINER}" \
  ssh-keygen -lf /data/ssh/ssh_host_ed25519_key.pub)
[[ "${HOST_KEY_BEFORE}" == "${HOST_KEY_AFTER}" ]] \
  || fail 'SSH host key changed after container replacement'
docker exec "${PUBLIC_CONTAINER}" grep -Fq '# preserved-smoke-marker' /data/codex/config.toml

docker run --detach \
  --platform linux/amd64 \
  --name "${DEGRADED_CONTAINER}" \
  --volume "${DEGRADED_DATA}:/data" \
  --volume "${DEGRADED_CONFIG}:/config" \
  "${IMAGE}" >/dev/null
wait_for_log "${DEGRADED_CONTAINER}" 'Codex runtime ready:'
wait_for_log "${DEGRADED_CONTAINER}" 'Ignored 1 invalid SSH public key(s)'
wait_for_log "${DEGRADED_CONTAINER}" 'SSH service is disabled'
wait_for_process "${DEGRADED_CONTAINER}" 'ttyd'
wait_for_process "${DEGRADED_CONTAINER}" 'nginx'

docker exec "${DEGRADED_CONTAINER}" test -e /run/codex-ha/ssh-disabled
docker exec "${DEGRADED_CONTAINER}" test -s /data/ssh/ssh_host_ed25519_key
if docker exec "${DEGRADED_CONTAINER}" pgrep -f '/usr/sbin/sshd' >/dev/null 2>&1; then
  fail 'sshd is running without an authorized key'
fi
docker exec "${DEGRADED_CONTAINER}" curl --fail --silent --show-error \
  http://127.0.0.1:7681/ >/dev/null

printf 'Docker smoke tests passed for %s (%s)\n' "${IMAGE}" "${CODEX_OUTPUT}"
