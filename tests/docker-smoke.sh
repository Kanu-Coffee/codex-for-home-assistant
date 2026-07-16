#!/usr/bin/env bash
set -Eeuo pipefail

IMAGE=${1:-codex-for-home-assistant:test}
TEST_ID="codex-ha-smoke-${RANDOM}-$$"
PUBLIC_CONTAINER="${TEST_ID}-public"
DEGRADED_CONTAINER="${TEST_ID}-degraded"
GATEWAY_FIXTURE="${TEST_ID}-gateway-fixture"
IP_REUSE_CONTAINER="${TEST_ID}-ip-reuse"
GATEWAY_NETWORK="${TEST_ID}-gateway-network"
PUBLIC_DATA="${TEST_ID}-public-data"
PUBLIC_CONFIG="${TEST_ID}-public-config"
DEGRADED_DATA="${TEST_ID}-degraded-data"
DEGRADED_CONFIG="${TEST_ID}-degraded-config"
WORK_DIR=$(mktemp -d)
SUPERVISOR_TOKEN=smoke-supervisor-token-do-not-use
BROWSER_TOKEN=smoke-browser-token-read-only-do-not-use
GATEWAY_MARKER='HA_BROWSER_GATEWAY_AUTHENTICATED:Codex HA fixture'

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
  docker rm -f \
    "${PUBLIC_CONTAINER}" \
    "${DEGRADED_CONTAINER}" \
    "${IP_REUSE_CONTAINER}" \
    "${GATEWAY_FIXTURE}" >/dev/null 2>&1 || true
  docker volume rm -f \
    "${PUBLIC_DATA}" \
    "${PUBLIC_CONFIG}" \
    "${DEGRADED_DATA}" \
    "${DEGRADED_CONFIG}" >/dev/null 2>&1 || true
  docker network rm "${GATEWAY_NETWORK}" >/dev/null 2>&1 || true
  rm -rf -- "${WORK_DIR}"
}
trap cleanup EXIT

fail() {
  printf 'docker smoke: %s\n' "$*" >&2
  for container in \
    "${PUBLIC_CONTAINER}" \
    "${DEGRADED_CONTAINER}" \
    "${GATEWAY_FIXTURE}"; do
    docker logs "${container}" 2>/dev/null \
      | sed \
        -e "s/${SUPERVISOR_TOKEN}/[REDACTED_HOME_ASSISTANT_TOKEN]/g" \
        -e "s/${BROWSER_TOKEN}/[REDACTED_HOME_ASSISTANT_TOKEN]/g" \
      || true
  done
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
[[ $(docker run --rm --platform linux/amd64 --entrypoint stat "${IMAGE}" \
  -c '%a:%U:%G' /usr/local/share/codex-ha/AGENTS.md) == 644:root:root ]] \
  || fail 'image default AGENTS.md has unexpected ownership or mode'

for volume in \
  "${PUBLIC_DATA}" \
  "${PUBLIC_CONFIG}" \
  "${DEGRADED_DATA}" \
  "${DEGRADED_CONFIG}"; do
  docker volume create "${volume}" >/dev/null
done

GATEWAY_SUBNET=''
for (( attempt = 0; attempt < 32; attempt += 1 )); do
  if (( attempt == 0 )); then
    candidate_subnet='10.253.214.0/24'
  else
    candidate_subnet="10.253.$((1 + RANDOM % 254)).0/24"
  fi
  if docker network create \
    --subnet "${candidate_subnet}" \
    "${GATEWAY_NETWORK}" >/dev/null 2>&1; then
    GATEWAY_SUBNET=${candidate_subnet}
    break
  fi
done
[[ -n "${GATEWAY_SUBNET}" ]] \
  || fail 'Unable to allocate a user-configured private subnet for IP reuse testing'
docker create \
  --platform linux/amd64 \
  --name "${GATEWAY_FIXTURE}" \
  --network "${GATEWAY_NETWORK}" \
  --network-alias supervisor \
  --network-alias homeassistant \
  --env GATEWAY_FIXTURE_TOKEN="${SUPERVISOR_TOKEN}" \
  --env GATEWAY_FIXTURE_BROWSER_TOKEN="${BROWSER_TOKEN}" \
  --entrypoint node \
  "${IMAGE}" \
  /tmp/ha_browser_gateway_fixture.mjs >/dev/null
docker cp tests/ha_browser_gateway_fixture.mjs \
  "${GATEWAY_FIXTURE}:/tmp/ha_browser_gateway_fixture.mjs"
docker start "${GATEWAY_FIXTURE}" >/dev/null
wait_for_log "${GATEWAY_FIXTURE}" 'Home Assistant browser gateway fixture ready'

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
    "home_assistant_browser_token": sys.argv[2],
    "log_level": "info",
}))
' "${PUBLIC_KEY}" "${BROWSER_TOKEN}")
DEGRADED_OPTIONS='{"authorized_keys":["ssh-ed25519 AAAA invalid-fixture"],"web_terminal_auto_start_codex":false,"tmux_session_name":"codex-ha-degraded","codex_approval_policy":"on-request","codex_sandbox_mode":"danger-full-access","log_level":"info"}'

seed_options "${PUBLIC_DATA}" "${PUBLIC_OPTIONS}"
seed_options "${DEGRADED_DATA}" "${DEGRADED_OPTIONS}"
docker run --rm \
  --platform linux/amd64 \
  --entrypoint /bin/sh \
  --volume "${DEGRADED_DATA}:/data" \
  "${IMAGE}" \
  -c 'mkdir -p /data/ssh /data/codex && : > /data/ssh/ssh_host_ed25519_key && printf "%s\n" "# user override" > /data/codex/AGENTS.override.md && chmod 0600 /data/codex/AGENTS.override.md'

docker run --detach \
  --platform linux/amd64 \
  --name "${PUBLIC_CONTAINER}" \
  --network "${GATEWAY_NETWORK}" \
  --env SUPERVISOR_TOKEN="${SUPERVISOR_TOKEN}" \
  --publish 127.0.0.1::22 \
  --publish 127.0.0.1::17682 \
  --volume "${PUBLIC_DATA}:/data" \
  --volume "${PUBLIC_CONFIG}:/config" \
  "${IMAGE}" >/dev/null

wait_for_log "${PUBLIC_CONTAINER}" 'Codex runtime ready:'
wait_for_log "${GATEWAY_FIXTURE}" \
  'Gateway fixture accepted authenticated /core/info'
wait_for_log "${GATEWAY_FIXTURE}" \
  'Core WebSocket fixture accepted browser auth/current_user'
wait_for_log "${GATEWAY_FIXTURE}" \
  'Supervisor WebSocket fixture accepted Supervisor config/auth/list'
wait_for_process "${PUBLIC_CONTAINER}" '/usr/sbin/sshd'
wait_for_process "${PUBLIC_CONTAINER}" 'ttyd'
wait_for_process "${PUBLIC_CONTAINER}" 'nginx'

docker exec "${PUBLIC_CONTAINER}" /bin/sh -c '
  ha-browser-auth-status | jq --exit-status '\''
    .status == "ready"
    and .source == "manual"
    and .user.group_ids == ["system-read-only"]
    and .user.local_only == true
    and .user.is_admin == false
  '\'' >/dev/null
' || fail 'Dedicated Home Assistant browser user validation was not ready'
docker exec "${PUBLIC_CONTAINER}" test ! -e /data/browser-auth/managed-user.json \
  || fail 'manual browser token unexpectedly created a managed user state'
docker exec "${PUBLIC_CONTAINER}" test ! -e /data/browser-auth/managed-token \
  || fail 'manual browser token unexpectedly created a managed token'
docker exec --workdir /config "${PUBLIC_CONTAINER}" \
  codex debug prompt-input 'verify the Home Assistant dashboard' \
  | docker exec --interactive "${PUBLIC_CONTAINER}" jq --exit-status '
      [
        .[]
        | select(.role == "developer")
        | .content[]?
        | select(.type == "input_text")
        | .text
      ]
      | join(" ")
      | contains("http://127.0.0.1:8099/")
        and contains("image-managed")
        and contains("another browser skill or plugin")
        and contains("memory_search")
        and contains("memory_remember_explicit")
        and contains("memory_begin_change")
        and contains("memory_verify_change")
        and contains("AGENTS.override.md")
        and contains("empty")
        and contains("degraded")
        and contains("stale")
    ' >/dev/null \
  || fail 'Codex model-visible instructions did not contain the browser and memory user-flow contracts'

NETWORK_INFO=$(docker exec "${PUBLIC_CONTAINER}" ha-browser-network-info) \
  || fail 'Home Assistant browser network diagnostics failed'
PUBLIC_APP_IP=$(docker inspect --format \
  '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' \
  "${PUBLIC_CONTAINER}")
SOCKET_SOURCE_IP=$("${PYTHON_BIN}" -c \
  'import json, sys; print(json.load(sys.stdin)["socket_source_ip"])' \
  <<< "${NETWORK_INFO}")
SUPERVISOR_REPORTED_IP=$("${PYTHON_BIN}" -c \
  'import json, sys; print(json.load(sys.stdin)["supervisor_reported_app_ip"])' \
  <<< "${NETWORK_INFO}")
NETWORK_POLICY=$("${PYTHON_BIN}" -c \
  'import json, sys; value=json.load(sys.stdin); print(str(value["safe_for_persistent_trusted_networks"]).lower())' \
  <<< "${NETWORK_INFO}")
[[ -n "${PUBLIC_APP_IP}" && "${PUBLIC_APP_IP}" == "${SOCKET_SOURCE_IP}" ]] \
  || fail "Docker App IP ${PUBLIC_APP_IP} did not match socket source ${SOCKET_SOURCE_IP}"
[[ "${PUBLIC_APP_IP}" == "${SUPERVISOR_REPORTED_IP}" ]] \
  || fail "Supervisor-reported App IP ${SUPERVISOR_REPORTED_IP} did not match ${PUBLIC_APP_IP}"
[[ "${NETWORK_POLICY}" == false ]] \
  || fail 'Dynamic App address was incorrectly declared safe for persistent trusted_networks'
wait_for_log "${GATEWAY_FIXTURE}" \
  "Core fixture observed /auth/providers from ${PUBLIC_APP_IP}"

CORE_CONFIG=$(docker exec "${PUBLIC_CONTAINER}" curl \
  --fail \
  --silent \
  --show-error \
  --header "Authorization: Bearer ${BROWSER_TOKEN}" \
  http://homeassistant:8123/api/config) \
  || fail 'Dedicated browser token could not call Core /api/config directly'
CORE_OBSERVED_IP=$("${PYTHON_BIN}" -c \
  'import json, sys; print(json.load(sys.stdin)["request_source_ip"])' \
  <<< "${CORE_CONFIG}")
[[ "${CORE_OBSERVED_IP}" == "${PUBLIC_APP_IP}" ]] \
  || fail "Core observed ${CORE_OBSERVED_IP}, expected App IP ${PUBLIC_APP_IP}"
if docker exec "${PUBLIC_CONTAINER}" curl \
  --fail \
  --silent \
  --output /dev/null \
  --header "Authorization: Bearer ${SUPERVISOR_TOKEN}" \
  http://homeassistant:8123/api/config; then
  fail 'Supervisor token unexpectedly authorized a direct Core browser request'
fi

docker exec "${PUBLIC_CONTAINER}" /bin/sh -c '
  codex mcp list --json | jq --exit-status '\''
    any(.[];
      .name == "playwright"
      and .enabled == true
      and .transport.type == "stdio"
      and .transport.command == "/usr/bin/env"
      and .transport.cwd == "/config"
      and .transport.args == [
        "-i",
        "HOME=/run/codex-ha/playwright-home",
        "LANG=C.UTF-8",
        "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "/usr/local/bin/ha-playwright-mcp"
      ]
    )
  '\'' >/dev/null
' || fail 'Codex did not discover the image-managed Playwright stdio MCP'
if docker exec "${PUBLIC_CONTAINER}" \
  /usr/local/bin/ha-playwright-mcp --port 8931 >/dev/null 2>&1; then
  fail 'Playwright wrapper accepted a transport-changing command-line argument'
fi

docker cp tests/playwright_mcp_smoke.mjs \
  "${PUBLIC_CONTAINER}:/tmp/playwright_mcp_smoke.mjs"
docker cp tests/ha_browser_gateway_fixture.mjs \
  "${PUBLIC_CONTAINER}:/tmp/ha_browser_gateway_fixture.mjs"
MCP_OUTPUT_FILE="${WORK_DIR}/playwright-mcp-smoke.log"
if ! docker exec \
  --workdir /config \
  --env PLAYWRIGHT_MCP_SMOKE_URL=http://127.0.0.1:8099/ \
  --env PLAYWRIGHT_MCP_SMOKE_EXPECT_TEXT="${GATEWAY_MARKER}" \
  --env PLAYWRIGHT_MCP_SMOKE_EXPECT_SOURCE_IP="${PUBLIC_APP_IP}" \
  --env PLAYWRIGHT_MCP_SMOKE_SCREENSHOT_DIR=/tmp/codex-ha-browser-evidence \
  --env PLAYWRIGHT_MCP_SMOKE_CHILD_ENV='{"NODE_OPTIONS":"--require=/tmp/codex-ha-missing-node-options.cjs","NODE_PATH":"/tmp/codex-ha-node-path","PLAYWRIGHT_MCP_INIT_PAGE":"/tmp/codex-ha-missing-init-page.mjs","PLAYWRIGHT_MCP_SECRETS_FILE":"/tmp/codex-ha-missing-secrets.env","PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS":"true"}' \
  "${PUBLIC_CONTAINER}" \
  node /tmp/playwright_mcp_smoke.mjs \
    /usr/bin/env -i \
    HOME=/run/codex-ha/playwright-home \
    LANG=C.UTF-8 \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    /usr/local/bin/ha-playwright-mcp \
  > "${MCP_OUTPUT_FILE}" 2>&1; then
  fail 'Playwright MCP browser smoke failed'
fi
if grep -Fq -- "${SUPERVISOR_TOKEN}" "${MCP_OUTPUT_FILE}" || \
  grep -Fq -- "${BROWSER_TOKEN}" "${MCP_OUTPUT_FILE}"; then
  fail 'Playwright MCP output disclosed a Home Assistant credential'
fi
cat "${MCP_OUTPUT_FILE}"
for screenshot in \
  home-assistant-internal-desktop.png \
  home-assistant-internal-mobile.png; do
  docker exec "${PUBLIC_CONTAINER}" test -s \
    "/tmp/codex-ha-browser-evidence/${screenshot}" \
    || fail "Internal Home Assistant screenshot was not captured: ${screenshot}"
done
if [[ -n "${CODEX_HA_SMOKE_ARTIFACT_DIR:-}" ]]; then
  mkdir -p "${CODEX_HA_SMOKE_ARTIFACT_DIR}"
  for screenshot in \
    home-assistant-internal-desktop.png \
    home-assistant-internal-mobile.png; do
    docker exec "${PUBLIC_CONTAINER}" base64 \
      "/tmp/codex-ha-browser-evidence/${screenshot}" \
      | base64 --decode \
      > "${CODEX_HA_SMOKE_ARTIFACT_DIR}/${screenshot}"
  done
fi
wait_for_log "${GATEWAY_FIXTURE}" \
  "Core fixture accepted browser /api/config from ${PUBLIC_APP_IP}"
docker exec "${PUBLIC_CONTAINER}" \
  node /tmp/ha_browser_gateway_fixture.mjs \
  --probe-websocket ws://127.0.0.1:8099/api/websocket "${BROWSER_TOKEN}" \
  || fail 'Home Assistant gateway authenticated Core WebSocket failed'
wait_for_log "${GATEWAY_FIXTURE}" \
  'Core WebSocket fixture accepted browser auth/current_user'
docker exec "${GATEWAY_FIXTURE}" curl \
  --silent \
  --connect-timeout 1 \
  --max-time 2 \
  "http://${PUBLIC_CONTAINER}:7681/" >/dev/null \
  || fail 'Gateway fixture could not reach the app container network address'
if docker exec "${GATEWAY_FIXTURE}" curl \
  --silent \
  --connect-timeout 1 \
  --max-time 2 \
  "http://${PUBLIC_CONTAINER}:8099/" >/dev/null 2>&1; then
  fail 'Home Assistant browser gateway was reachable outside app loopback'
fi

docker exec --detach "${PUBLIC_CONTAINER}" \
  ttyd \
  --interface 0.0.0.0 \
  --port 17682 \
  --writable \
  --debug 1 \
  /usr/local/bin/web-terminal-entrypoint
wait_for_process "${PUBLIC_CONTAINER}" 'ttyd.*--port 17682'
TTYD_PORT=$(docker port "${PUBLIC_CONTAINER}" 17682/tcp | head -n1 | sed 's/.*://')
"${PYTHON_BIN}" tests/ttyd_websocket_smoke.py \
  "ws://127.0.0.1:${TTYD_PORT}/ws" \
  || fail 'ttyd WebSocket shell did not stay connected'

EXPECTED_APP_VERSION=$(docker image inspect \
  --format '{{index .Config.Labels "io.hass.version"}}' "${IMAGE}")
APP_VERSION=$(sed -n 's/^version: "\([^"]*\)"/\1/p' codex_home_assistant/config.yaml)
[[ -n "${APP_VERSION}" && "${EXPECTED_APP_VERSION}" == "${APP_VERSION}" ]] \
  || fail "image label version ${EXPECTED_APP_VERSION} does not match App version ${APP_VERSION}"
CODEX_OUTPUT=$(docker exec "${PUBLIC_CONTAINER}" codex --version)
[[ "${CODEX_OUTPUT}" =~ ^codex-cli\ [0-9]+\.[0-9]+\.[0-9]+$ ]] \
  || fail "unexpected Codex version output: ${CODEX_OUTPUT} (App ${EXPECTED_APP_VERSION})"

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
  /usr/local/bin/ha-browser-auth-status \
  /usr/local/bin/ha-browser-network-info \
  /usr/local/bin/supervisor-api \
  /usr/local/bin/web-terminal-entrypoint; do
  docker exec "${PUBLIC_CONTAINER}" test -x "${executable}"
done

[[ $(docker exec "${PUBLIC_CONTAINER}" stat -c '%a' /data/ssh/authorized_keys) == 600 ]]
[[ $(docker exec "${PUBLIC_CONTAINER}" stat -c '%a' /data/ssh/ssh_host_ed25519_key) == 600 ]]
[[ $(docker exec "${PUBLIC_CONTAINER}" stat -c '%a' /data/ssh/ssh_host_ed25519_key.pub) == 644 ]]
[[ $(docker exec "${PUBLIC_CONTAINER}" stat -c '%a' /run/codex-ha/runtime.env) == 600 ]]
[[ $(docker exec "${PUBLIC_CONTAINER}" stat -c '%a' /run/codex-ha/browser-auth-status.json) == 600 ]]
[[ $(docker exec "${PUBLIC_CONTAINER}" stat -c '%a' /run/codex-ha/browser-network-info.json) == 600 ]]
[[ $(docker exec "${PUBLIC_CONTAINER}" stat -c '%a' /run/codex-ha/home-assistant-browser.token) == 600 ]]
[[ $(docker exec "${PUBLIC_CONTAINER}" stat -c '%a' /root/.ssh/environment) == 600 ]]
[[ $(docker exec "${PUBLIC_CONTAINER}" stat -c '%a' /data/codex/AGENTS.md) == 644 ]]
[[ $(docker exec "${PUBLIC_CONTAINER}" stat -c '%U:%G' /data/codex/AGENTS.md) == root:root ]]
docker exec "${PUBLIC_CONTAINER}" test -f /data/codex/AGENTS.md
docker exec "${PUBLIC_CONTAINER}" cmp -s \
  /usr/local/share/codex-ha/AGENTS.md /data/codex/AGENTS.md
docker exec "${PUBLIC_CONTAINER}" grep -Fq 'Run `ha-config-check`' /data/codex/AGENTS.md
docker exec "${PUBLIC_CONTAINER}" test ! -e \
  /run/codex-ha/playwright-secrets.env
if docker exec "${PUBLIC_CONTAINER}" grep -Fq -- '"--secrets"' \
  /usr/local/share/codex-ha/playwright-mcp-proxy.mjs; then
  fail 'Playwright MCP secret substitution remained enabled'
fi

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
docker exec "${PUBLIC_CONTAINER}" /bin/sh -c \
  'printf "\n# preserved-agents-smoke-marker\n" >> /data/codex/AGENTS.md'
docker exec "${PUBLIC_CONTAINER}" /bin/sh -c \
  'printf "%s\n" sentinel > /run/codex-ha/playwright-output/init-sentinel'
docker exec "${PUBLIC_CONTAINER}" rm -f /data/ssh/ssh_host_rsa_key.pub
docker exec "${PUBLIC_CONTAINER}" codex-ha-init >/dev/null
docker exec "${PUBLIC_CONTAINER}" test ! -e \
  /run/codex-ha/playwright-output/init-sentinel
[[ $(docker exec "${PUBLIC_CONTAINER}" stat -c '%a' \
  /run/codex-ha/playwright-output) == 700 ]]
docker exec "${PUBLIC_CONTAINER}" grep -Fq '# preserved-smoke-marker' /data/codex/config.toml
docker exec "${PUBLIC_CONTAINER}" grep -Fq '# preserved-agents-smoke-marker' /data/codex/AGENTS.md
docker exec "${PUBLIC_CONTAINER}" test -s /data/ssh/ssh_host_rsa_key.pub
[[ $(docker exec "${PUBLIC_CONTAINER}" stat -c '%a' /data/codex/config.toml) == 600 ]]

RUNTIME_LOGS_FILE="${WORK_DIR}/runtime.log"
{
  docker logs "${PUBLIC_CONTAINER}"
  docker logs "${GATEWAY_FIXTURE}"
} > "${RUNTIME_LOGS_FILE}" 2>&1
for secret in "${SUPERVISOR_TOKEN}" "${BROWSER_TOKEN}"; do
  if grep -Fq -- "${secret}" "${RUNTIME_LOGS_FILE}"; then
    fail 'A Home Assistant credential appeared in container logs'
  fi
done

docker rm -f "${PUBLIC_CONTAINER}" >/dev/null
docker create \
  --platform linux/amd64 \
  --name "${IP_REUSE_CONTAINER}" \
  --network "${GATEWAY_NETWORK}" \
  --ip "${PUBLIC_APP_IP}" \
  --entrypoint /bin/sh \
  "${IMAGE}" \
  -c 'sleep 30' >/dev/null \
  || fail "Docker could not reassign the released App address ${PUBLIC_APP_IP}"
docker start "${IP_REUSE_CONTAINER}" >/dev/null
REUSED_APP_IP=$(docker inspect --format \
  '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' \
  "${IP_REUSE_CONTAINER}")
[[ "${REUSED_APP_IP}" == "${PUBLIC_APP_IP}" ]] \
  || fail "Docker did not reuse the released App address ${PUBLIC_APP_IP}"
if docker exec "${IP_REUSE_CONTAINER}" curl \
  --fail \
  --silent \
  --output /dev/null \
  http://homeassistant:8123/api/config; then
  fail 'A replacement container inherited browser access from the stale App IP'
fi
if docker exec "${IP_REUSE_CONTAINER}" curl \
  --fail \
  --silent \
  --output /dev/null \
  --header "Authorization: Bearer ${SUPERVISOR_TOKEN}" \
  http://homeassistant:8123/api/config; then
  fail 'A replacement container used the Supervisor token as a browser credential'
fi
docker rm -f "${IP_REUSE_CONTAINER}" >/dev/null

docker run --detach \
  --platform linux/amd64 \
  --name "${PUBLIC_CONTAINER}" \
  --network "${GATEWAY_NETWORK}" \
  --env SUPERVISOR_TOKEN="${SUPERVISOR_TOKEN}" \
  --volume "${PUBLIC_DATA}:/data" \
  --volume "${PUBLIC_CONFIG}:/config" \
  "${IMAGE}" >/dev/null
wait_for_log "${PUBLIC_CONTAINER}" 'Codex runtime ready:'
docker exec "${PUBLIC_CONTAINER}" /bin/sh -c \
  'ha-browser-auth-status | jq --exit-status '\''.status == "ready"'\'' >/dev/null' \
  || fail 'Dedicated browser authentication was not restored after replacement'
HOST_KEY_AFTER=$(docker exec "${PUBLIC_CONTAINER}" \
  ssh-keygen -lf /data/ssh/ssh_host_ed25519_key.pub)
[[ "${HOST_KEY_BEFORE}" == "${HOST_KEY_AFTER}" ]] \
  || fail 'SSH host key changed after container replacement'
docker exec "${PUBLIC_CONTAINER}" grep -Fq '# preserved-smoke-marker' /data/codex/config.toml
docker exec "${PUBLIC_CONTAINER}" grep -Fq '# preserved-agents-smoke-marker' /data/codex/AGENTS.md
docker exec "${PUBLIC_CONTAINER}" /bin/sh -c \
  'jq ".home_assistant_browser_auto_auth = false" /data/options.json > /data/options.json.tmp && mv /data/options.json.tmp /data/options.json'
docker exec "${PUBLIC_CONTAINER}" ha-browser-auth-refresh --quiet \
  || fail 'manual browser override did not accept automatic authentication OFF'
docker exec "${PUBLIC_CONTAINER}" jq --exit-status \
  '.status == "disabled" and .reason == "option_disabled"' \
  /run/codex-ha/browser-auth-status.json >/dev/null \
  || fail 'manual browser override was not suppressed while automatic authentication was OFF'
docker exec "${PUBLIC_CONTAINER}" test ! -e \
  /run/codex-ha/home-assistant-browser.token \
  || fail 'manual browser override left a runtime token while automatic authentication was OFF'
docker exec "${PUBLIC_CONTAINER}" /bin/sh -c \
  'jq ".home_assistant_browser_auto_auth = true" /data/options.json > /data/options.json.tmp && mv /data/options.json.tmp /data/options.json'
docker exec "${PUBLIC_CONTAINER}" ha-browser-auth-ensure --quiet \
  || fail 'manual browser override did not reactivate after automatic authentication was enabled'
docker exec "${PUBLIC_CONTAINER}" jq --exit-status \
  '.status == "ready" and .source == "manual"' \
  /run/codex-ha/browser-auth-status.json >/dev/null \
  || fail 'manual browser override did not return after automatic authentication was enabled'

docker run --detach \
  --platform linux/amd64 \
  --name "${DEGRADED_CONTAINER}" \
  --network "${GATEWAY_NETWORK}" \
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
docker exec "${DEGRADED_CONTAINER}" /bin/sh -c \
  'ha-browser-auth-status | jq --exit-status '\''.status == "unconfigured"'\'' >/dev/null' \
  || fail 'Missing browser token did not fail closed as unconfigured'
docker exec "${DEGRADED_CONTAINER}" test ! -e \
  /run/codex-ha/home-assistant-browser.token
docker exec "${DEGRADED_CONTAINER}" test ! -e \
  /run/codex-ha/playwright-secrets.env
docker cp tests/playwright_mcp_smoke.mjs \
  "${DEGRADED_CONTAINER}:/tmp/playwright_mcp_smoke.mjs"
DEGRADED_MCP_OUTPUT_FILE="${WORK_DIR}/playwright-mcp-degraded.log"
if ! docker exec \
  --workdir /config \
  --env HA_BROWSER_TOKEN="${BROWSER_TOKEN}" \
  --env PLAYWRIGHT_MCP_SMOKE_URL=http://127.0.0.1:8099/ \
  --env PLAYWRIGHT_MCP_SMOKE_EXPECT_TEXT=HA_BROWSER_GATEWAY_FAILED \
  --env PLAYWRIGHT_MCP_SMOKE_EXPECT_UNAUTHENTICATED=1 \
  "${DEGRADED_CONTAINER}" \
  node /tmp/playwright_mcp_smoke.mjs /usr/local/bin/ha-playwright-mcp \
  > "${DEGRADED_MCP_OUTPUT_FILE}" 2>&1; then
  fail 'Inherited HA_BROWSER_TOKEN did not fail closed without a validated token file'
fi
if grep -Fq -- "${BROWSER_TOKEN}" "${DEGRADED_MCP_OUTPUT_FILE}"; then
  fail 'Fail-closed Playwright MCP output disclosed the inherited browser token'
fi
docker exec "${DEGRADED_CONTAINER}" test ! -e /data/codex/AGENTS.md
docker exec "${DEGRADED_CONTAINER}" grep -Fxq '# user override' /data/codex/AGENTS.override.md
[[ $(docker exec "${DEGRADED_CONTAINER}" stat -c '%a' /data/codex/AGENTS.override.md) == 600 ]]

docker exec "${DEGRADED_CONTAINER}" rm -f /data/codex/AGENTS.override.md
docker exec "${DEGRADED_CONTAINER}" ln -s missing-user-guidance /data/codex/AGENTS.md
docker exec "${DEGRADED_CONTAINER}" codex-ha-init >/dev/null
docker exec "${DEGRADED_CONTAINER}" test -L /data/codex/AGENTS.md
[[ $(docker exec "${DEGRADED_CONTAINER}" readlink /data/codex/AGENTS.md) == missing-user-guidance ]]

docker exec "${DEGRADED_CONTAINER}" rm -f /data/codex/AGENTS.md
docker exec "${DEGRADED_CONTAINER}" install -m 0600 /dev/null /data/codex/AGENTS.md
docker exec "${DEGRADED_CONTAINER}" codex-ha-init >/dev/null
docker exec "${DEGRADED_CONTAINER}" test ! -s /data/codex/AGENTS.md
[[ $(docker exec "${DEGRADED_CONTAINER}" stat -c '%a' /data/codex/AGENTS.md) == 600 ]]

docker exec "${DEGRADED_CONTAINER}" /bin/sh -c \
  'printf "%s\n" "# existing user guidance" > /data/codex/AGENTS.md && chmod 0600 /data/codex/AGENTS.md'
USER_GUIDANCE_HASH_BEFORE=$(docker exec "${DEGRADED_CONTAINER}" sha256sum /data/codex/AGENTS.md)
docker exec "${DEGRADED_CONTAINER}" codex-ha-init >/dev/null
USER_GUIDANCE_HASH_AFTER=$(docker exec "${DEGRADED_CONTAINER}" sha256sum /data/codex/AGENTS.md)
[[ "${USER_GUIDANCE_HASH_BEFORE}" == "${USER_GUIDANCE_HASH_AFTER}" ]]
[[ $(docker exec "${DEGRADED_CONTAINER}" stat -c '%a' /data/codex/AGENTS.md) == 600 ]]
if docker exec "${DEGRADED_CONTAINER}" pgrep -f '/usr/sbin/sshd' >/dev/null 2>&1; then
  fail 'sshd is running without an authorized key'
fi
docker exec "${DEGRADED_CONTAINER}" curl --fail --silent --show-error \
  http://127.0.0.1:7681/ >/dev/null

{
  docker logs "${PUBLIC_CONTAINER}"
  docker logs "${DEGRADED_CONTAINER}"
  docker logs "${GATEWAY_FIXTURE}"
} > "${RUNTIME_LOGS_FILE}" 2>&1
for secret in "${SUPERVISOR_TOKEN}" "${BROWSER_TOKEN}"; do
  if grep -Fq -- "${secret}" "${RUNTIME_LOGS_FILE}"; then
    fail 'A Home Assistant credential appeared in final container logs'
  fi
done

printf 'Docker smoke tests passed for %s (%s)\n' "${IMAGE}" "${CODEX_OUTPUT}"
