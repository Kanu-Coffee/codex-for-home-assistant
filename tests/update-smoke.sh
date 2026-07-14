#!/usr/bin/env bash
set -Eeuo pipefail

RELEASE_IMAGE=${1:-ghcr.io/kanu-coffee/codex-for-home-assistant:0.2.0}
CANDIDATE_IMAGE=${2:-codex-for-home-assistant:test}
TEST_ID="codex-ha-update-${RANDOM}-$$"
RELEASE_CONTAINER="${TEST_ID}-release"
CANDIDATE_CONTAINER="${TEST_ID}-candidate"
DATA_VOLUME="${TEST_ID}-data"
CONFIG_VOLUME="${TEST_ID}-config"
CONFIG_MARKER="# ${TEST_ID}-user-config-marker"
AGENTS_MARKER="<!-- ${TEST_ID}-agents-marker -->"
AUTH_MARKER="${TEST_ID}-auth-marker-not-a-credential"
HA_CONFIG_MARKER="${TEST_ID}-home-assistant-config-marker"
BROWSER_OPTION_MARKER="${TEST_ID}-browser-option-not-a-credential"

# Git Bash rewrites Linux container paths before invoking native Windows programs.
if [[ "${OSTYPE:-}" == msys* || "${OSTYPE:-}" == cygwin* ]]; then
  docker() {
    MSYS_NO_PATHCONV=1 command docker "$@"
  }
fi

cleanup() {
  docker rm -f \
    "${RELEASE_CONTAINER}" \
    "${CANDIDATE_CONTAINER}" >/dev/null 2>&1 || true
  docker volume rm -f \
    "${DATA_VOLUME}" \
    "${CONFIG_VOLUME}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

fail() {
  printf 'update smoke: %s\n' "$*" >&2
  exit 1
}

ensure_image() {
  local image=$1
  local allow_pull=$2

  if docker image inspect "${image}" >/dev/null 2>&1; then
    return 0
  fi
  if [[ "${allow_pull}" == true ]]; then
    docker pull --platform linux/amd64 "${image}" >/dev/null \
      || fail "could not pull released image: ${image}"
    return 0
  fi
  fail "candidate image not found: ${image}"
}

wait_for_ready() {
  local container=$1
  local _

  for _ in $(seq 1 90); do
    if docker logs "${container}" 2>&1 \
      | grep -Fq 'Codex runtime ready:'; then
      return 0
    fi
    if [[ $(docker inspect --format '{{.State.Running}}' "${container}") != true ]]; then
      fail "${container} exited before becoming ready"
    fi
    sleep 1
  done
  fail "timed out waiting for ${container}"
}

assert_named_mount() {
  local container=$1
  local destination=$2
  local expected_volume=$3
  local actual_volume

  actual_volume=$(docker inspect --format \
    "{{range .Mounts}}{{if eq .Destination \"${destination}\"}}{{.Name}}{{end}}{{end}}" \
    "${container}")
  [[ "${actual_volume}" == "${expected_volume}" ]] \
    || fail "${container} did not mount ${expected_volume} at ${destination}"
}

container_hash() {
  local container=$1
  local path=$2

  docker exec "${container}" sha256sum "${path}" | awk '{print $1}'
}

host_key_fingerprint() {
  local container=$1

  docker exec "${container}" ssh-keygen -E sha256 -lf \
    /data/ssh/ssh_host_ed25519_key.pub | awk '{print $2}'
}

start_app() {
  local container=$1
  local image=$2

  docker run --detach \
    --platform linux/amd64 \
    --name "${container}" \
    --volume "${DATA_VOLUME}:/data" \
    --volume "${CONFIG_VOLUME}:/config" \
    "${image}" >/dev/null
  wait_for_ready "${container}"
  assert_named_mount "${container}" /data "${DATA_VOLUME}"
  assert_named_mount "${container}" /config "${CONFIG_VOLUME}"
}

ensure_image "${RELEASE_IMAGE}" true
ensure_image "${CANDIDATE_IMAGE}" false

docker volume create "${DATA_VOLUME}" >/dev/null
docker volume create "${CONFIG_VOLUME}" >/dev/null

printf '%s' \
  "{\"authorized_keys\":[],\"web_terminal_auto_start_codex\":false,\"tmux_session_name\":\"codex-ha-update-smoke\",\"codex_approval_policy\":\"on-request\",\"codex_sandbox_mode\":\"danger-full-access\",\"home_assistant_browser_token\":\"${BROWSER_OPTION_MARKER}\",\"log_level\":\"info\"}" \
  | docker run --rm --interactive \
    --platform linux/amd64 \
    --entrypoint /bin/sh \
    --volume "${DATA_VOLUME}:/data" \
    "${RELEASE_IMAGE}" \
    -c 'umask 077; cat > /data/options.json'

start_app "${RELEASE_CONTAINER}" "${RELEASE_IMAGE}"

docker exec "${RELEASE_CONTAINER}" cmp -s \
  /usr/local/share/codex-ha/AGENTS.md /data/codex/AGENTS.md \
  || fail 'released image did not seed its default AGENTS.md'

printf '%s\n' "${AUTH_MARKER}" \
  | docker exec --interactive "${RELEASE_CONTAINER}" /bin/sh -c '
      umask 077
      marker=$(cat)
      jq --null-input --arg marker "${marker}" \
        '\''{OPENAI_API_KEY: $marker}'\'' > /data/codex/auth.json
    '
docker exec "${RELEASE_CONTAINER}" /bin/sh -c \
  'printf "\n%s\n" "$1" >> /data/codex/config.toml' sh "${CONFIG_MARKER}"
docker exec "${RELEASE_CONTAINER}" /bin/sh -c \
  'printf "\n%s\n" "$1" >> /data/codex/AGENTS.md' sh "${AGENTS_MARKER}"
printf '%s\n' "${HA_CONFIG_MARKER}" \
  | docker exec --interactive "${RELEASE_CONTAINER}" /bin/sh -c \
    'umask 077; cat > /config/.codex-ha-update-smoke-marker'

docker exec "${RELEASE_CONTAINER}" jq --exit-status \
  --arg marker "${AUTH_MARKER}" \
  '.OPENAI_API_KEY == $marker' /data/codex/auth.json >/dev/null \
  || fail 'released auth.json marker is not valid JSON'
docker exec "${RELEASE_CONTAINER}" grep -Fxq \
  "${CONFIG_MARKER}" /data/codex/config.toml
docker exec "${RELEASE_CONTAINER}" grep -Fxq \
  "${AGENTS_MARKER}" /data/codex/AGENTS.md

CONFIG_HASH_BEFORE=$(container_hash \
  "${RELEASE_CONTAINER}" /data/codex/config.toml)
AUTH_HASH_BEFORE=$(container_hash \
  "${RELEASE_CONTAINER}" /data/codex/auth.json)
AGENTS_HASH_BEFORE=$(container_hash \
  "${RELEASE_CONTAINER}" /data/codex/AGENTS.md)
HA_CONFIG_HASH_BEFORE=$(container_hash \
  "${RELEASE_CONTAINER}" /config/.codex-ha-update-smoke-marker)
HOST_KEY_BEFORE=$(host_key_fingerprint "${RELEASE_CONTAINER}")
OPTIONS_HASH_BEFORE=$(container_hash \
  "${RELEASE_CONTAINER}" /data/options.json)

# Model a Home Assistant App update: replace only the container. The two named
# volumes are not removed, reset, copied, or recreated between image versions.
docker rm -f "${RELEASE_CONTAINER}" >/dev/null
start_app "${CANDIDATE_CONTAINER}" "${CANDIDATE_IMAGE}"

[[ $(container_hash "${CANDIDATE_CONTAINER}" /data/codex/config.toml) \
  == "${CONFIG_HASH_BEFORE}" ]] \
  || fail 'user Codex config changed during image update'
[[ $(container_hash "${CANDIDATE_CONTAINER}" /data/codex/auth.json) \
  == "${AUTH_HASH_BEFORE}" ]] \
  || fail 'auth.json changed during image update'
[[ $(container_hash "${CANDIDATE_CONTAINER}" /data/codex/AGENTS.md) \
  == "${AGENTS_HASH_BEFORE}" ]] \
  || fail 'persistent AGENTS.md changed during image update'
[[ $(container_hash \
    "${CANDIDATE_CONTAINER}" /config/.codex-ha-update-smoke-marker) \
  == "${HA_CONFIG_HASH_BEFORE}" ]] \
  || fail '/config content changed during image update'
[[ $(host_key_fingerprint "${CANDIDATE_CONTAINER}") \
  == "${HOST_KEY_BEFORE}" ]] \
  || fail 'SSH host key fingerprint changed during image update'
[[ $(container_hash "${CANDIDATE_CONTAINER}" /data/options.json) \
  == "${OPTIONS_HASH_BEFORE}" ]] \
  || fail 'Home Assistant App options changed during image update'

docker exec "${CANDIDATE_CONTAINER}" jq --exit-status \
  --arg marker "${AUTH_MARKER}" \
  '.OPENAI_API_KEY == $marker' /data/codex/auth.json >/dev/null \
  || fail 'auth.json marker was not preserved as valid JSON'
docker exec "${CANDIDATE_CONTAINER}" grep -Fxq \
  "${CONFIG_MARKER}" /data/codex/config.toml
docker exec "${CANDIDATE_CONTAINER}" grep -Fxq \
  "${AGENTS_MARKER}" /data/codex/AGENTS.md
docker exec "${CANDIDATE_CONTAINER}" jq --exit-status \
  --arg marker "${BROWSER_OPTION_MARKER}" \
  '.home_assistant_browser_token == $marker' /data/options.json >/dev/null \
  || fail 'masked browser token option was not preserved'
[[ $(docker exec "${CANDIDATE_CONTAINER}" stat -c '%a' \
  /data/codex/config.toml) == 600 ]]
[[ $(docker exec "${CANDIDATE_CONTAINER}" stat -c '%a' \
  /data/codex/auth.json) == 600 ]]
[[ $(docker exec "${CANDIDATE_CONTAINER}" stat -c '%a' \
  /data/codex/AGENTS.md) == 644 ]]

docker exec "${CANDIDATE_CONTAINER}" /bin/sh -c '
  codex mcp list --json | jq --exit-status '\''
    any(.[];
      .name == "playwright"
      and .enabled == true
      and .transport.type == "stdio"
      and .transport.command == "/usr/bin/env"
      and .transport.cwd == "/config"
      and .transport.args[-1] == "/usr/local/bin/ha-playwright-mcp"
    )
  '\'' >/dev/null
' || fail 'updated image did not expose the image-managed Playwright MCP'

docker cp tests/playwright_mcp_smoke.mjs \
  "${CANDIDATE_CONTAINER}:/tmp/playwright_mcp_smoke.mjs"
docker exec --workdir /config "${CANDIDATE_CONTAINER}" \
  node /tmp/playwright_mcp_smoke.mjs \
    /usr/bin/env -i \
    HOME=/run/codex-ha/playwright-home \
    LANG=C.UTF-8 \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    /usr/local/bin/ha-playwright-mcp \
  || fail 'Playwright MCP failed after released-image update'

printf 'Update smoke passed: %s -> %s\n' \
  "${RELEASE_IMAGE}" "${CANDIDATE_IMAGE}"
