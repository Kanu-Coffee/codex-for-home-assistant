#!/usr/bin/env bash
set -Eeuo pipefail

RELEASE_IMAGE=${1:-ghcr.io/kanu-coffee/codex-for-home-assistant:0.5.0}
CANDIDATE_IMAGE=${2:-codex-for-home-assistant:test}
TEST_ID="codex-ha-update-${RANDOM}-$$"
RELEASE_CONTAINER="${TEST_ID}-release"
CANDIDATE_CONTAINER="${TEST_ID}-candidate"
DATA_VOLUME="${TEST_ID}-data"
CONFIG_VOLUME="${TEST_ID}-config"
CONFIG_MARKER="# ${TEST_ID}-user-config-marker"
AGENTS_MARKER="<!-- ${TEST_ID}-agents-marker -->"
AGENTS_OVERRIDE_MARKER="<!-- ${TEST_ID}-agents-override-marker -->"
AUTH_MARKER="${TEST_ID}-auth-marker-not-a-credential"
HA_CONFIG_MARKER="${TEST_ID}-home-assistant-config-marker"
BROWSER_OPTION_MARKER="${TEST_ID}-browser-option-not-a-credential"
GITHUB_CONFIG_MARKER="${TEST_ID}-github-config-marker-not-a-credential"
POST_REFRESH_CONFIG_MARKER="# ${TEST_ID}-post-refresh-config-marker"
POST_REFRESH_AGENTS_MARKER="<!-- ${TEST_ID}-post-refresh-agents-marker -->"

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
  "{\"authorized_keys\":[],\"web_terminal_auto_start_codex\":false,\"tmux_session_name\":\"codex-ha-update-smoke\",\"codex_approval_policy\":\"on-request\",\"codex_sandbox_mode\":\"danger-full-access\",\"codex_user_files_update_mode\":\"preserve\",\"home_assistant_browser_auto_auth\":true,\"home_assistant_browser_token\":\"${BROWSER_OPTION_MARKER}\",\"log_level\":\"info\"}" \
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
docker exec "${RELEASE_CONTAINER}" /bin/sh -c \
  'umask 077; printf "%s\n" "$1" > /data/codex/AGENTS.override.md' \
  sh "${AGENTS_OVERRIDE_MARKER}"
printf '%s\n' "${HA_CONFIG_MARKER}" \
  | docker exec --interactive "${RELEASE_CONTAINER}" /bin/sh -c \
    'umask 077; cat > /config/.codex-ha-update-smoke-marker'
docker exec "${RELEASE_CONTAINER}" /bin/sh -c '
  install -d -m 0700 /data/github-cli
  umask 077
  printf "%s\n" "$1" > /data/github-cli/hosts.yml
' sh "${GITHUB_CONFIG_MARKER}"

docker exec "${RELEASE_CONTAINER}" jq --exit-status \
  --arg marker "${AUTH_MARKER}" \
  '.OPENAI_API_KEY == $marker' /data/codex/auth.json >/dev/null \
  || fail 'released auth.json marker is not valid JSON'
docker exec "${RELEASE_CONTAINER}" grep -Fxq \
  "${CONFIG_MARKER}" /data/codex/config.toml
docker exec "${RELEASE_CONTAINER}" grep -Fxq \
  "${AGENTS_MARKER}" /data/codex/AGENTS.md
docker exec "${RELEASE_CONTAINER}" grep -Fxq \
  "${AGENTS_OVERRIDE_MARKER}" /data/codex/AGENTS.override.md

CONFIG_HASH_BEFORE=$(container_hash \
  "${RELEASE_CONTAINER}" /data/codex/config.toml)
AUTH_HASH_BEFORE=$(container_hash \
  "${RELEASE_CONTAINER}" /data/codex/auth.json)
AGENTS_HASH_BEFORE=$(container_hash \
  "${RELEASE_CONTAINER}" /data/codex/AGENTS.md)
AGENTS_OVERRIDE_HASH_BEFORE=$(container_hash \
  "${RELEASE_CONTAINER}" /data/codex/AGENTS.override.md)
HA_CONFIG_HASH_BEFORE=$(container_hash \
  "${RELEASE_CONTAINER}" /config/.codex-ha-update-smoke-marker)
HOST_KEY_BEFORE=$(host_key_fingerprint "${RELEASE_CONTAINER}")
OPTIONS_HASH_BEFORE=$(container_hash \
  "${RELEASE_CONTAINER}" /data/options.json)
GITHUB_CONFIG_HASH_BEFORE=$(container_hash \
  "${RELEASE_CONTAINER}" /data/github-cli/hosts.yml)

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
    "${CANDIDATE_CONTAINER}" /data/codex/AGENTS.override.md) \
  == "${AGENTS_OVERRIDE_HASH_BEFORE}" ]] \
  || fail 'AGENTS.override.md changed during image update'
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
[[ $(container_hash "${CANDIDATE_CONTAINER}" /data/github-cli/hosts.yml) \
  == "${GITHUB_CONFIG_HASH_BEFORE}" ]] \
  || fail 'persistent GitHub CLI configuration changed during image update'
[[ $(docker exec "${CANDIDATE_CONTAINER}" stat -c '%a:%U:%G' \
  /data/github-cli) == 700:root:root ]] \
  || fail 'persistent GitHub CLI directory is not private after update'
[[ $(docker exec "${CANDIDATE_CONTAINER}" stat -c '%a:%U:%G' \
  /data/github-cli/hosts.yml) == 600:root:root ]] \
  || fail 'persistent GitHub CLI file is not private after update'
docker exec "${CANDIDATE_CONTAINER}" jq --exit-status \
  'has("browser_approval_policy") | not' /data/options.json >/dev/null \
  || fail 'update unexpectedly inserted the new browser approval option'

docker exec "${CANDIDATE_CONTAINER}" jq --exit-status \
  --arg marker "${AUTH_MARKER}" \
  '.OPENAI_API_KEY == $marker' /data/codex/auth.json >/dev/null \
  || fail 'auth.json marker was not preserved as valid JSON'
docker exec "${CANDIDATE_CONTAINER}" grep -Fxq \
  "${CONFIG_MARKER}" /data/codex/config.toml
docker exec "${CANDIDATE_CONTAINER}" grep -Fxq \
  "${AGENTS_MARKER}" /data/codex/AGENTS.md
docker exec "${CANDIDATE_CONTAINER}" grep -Fxq \
  "${AGENTS_OVERRIDE_MARKER}" /data/codex/AGENTS.override.md
docker exec "${CANDIDATE_CONTAINER}" test ! -e \
  /data/codex/.user-files-update-state.json \
  || fail 'explicit preserve mode unexpectedly recorded user-file state'
docker exec "${CANDIDATE_CONTAINER}" test ! -e \
  /data/codex/.user-files-update-journal.json
docker exec "${CANDIDATE_CONTAINER}" test ! -e \
  /data/codex/backups/user-files \
  || fail 'default preserve unexpectedly created a user-file backup'
docker exec --workdir /config "${CANDIDATE_CONTAINER}" \
  codex debug prompt-input 'verify the Home Assistant dashboard' \
  | docker exec --interactive "${CANDIDATE_CONTAINER}" jq --exit-status '
      [
        .[]
        | select(.role == "developer")
        | .content[]?
        | select(.type == "input_text")
        | .text
      ]
      | any(
          contains("http://127.0.0.1:8099/")
          and contains("image-managed")
          and contains("another browser skill or plugin")
          and contains("$ha-feedback")
          and contains("/usr/local/bin/ha-feedback")
        )
    ' >/dev/null \
  || fail 'updated image did not expose the canonical 8099 route to Codex'
docker exec "${CANDIDATE_CONTAINER}" test -f \
  /etc/codex/skills/ha-feedback/SKILL.md \
  || fail 'updated image did not add the image-managed ha-feedback Skill'
docker exec "${CANDIDATE_CONTAINER}" test -x /usr/local/bin/ha-feedback \
  || fail 'updated image did not add the ha-feedback helper'
docker exec "${CANDIDATE_CONTAINER}" jq --exit-status \
  --arg marker "${BROWSER_OPTION_MARKER}" \
  '.home_assistant_browser_token == $marker' /data/options.json >/dev/null \
  || fail 'masked browser token option was not preserved'
docker exec "${CANDIDATE_CONTAINER}" test ! -e \
  /data/browser-auth/managed-user.json \
  || fail 'legacy manual browser option unexpectedly created managed user state'
docker exec "${CANDIDATE_CONTAINER}" test ! -e \
  /data/browser-auth/managed-token \
  || fail 'legacy manual browser option unexpectedly created managed token state'
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
docker exec --workdir /config "${CANDIDATE_CONTAINER}" \
  codex mcp get playwright --json >/dev/null \
  || fail 'missing browser approval option did not use the safe fallback'

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

# Model saving refresh_all in the Home Assistant App configuration and then
# restarting the App. The first candidate start above must preserve the
# explicit public setting before the user opts into the candidate refresh.
docker exec "${CANDIDATE_CONTAINER}" /bin/sh -c '
  jq ".codex_user_files_update_mode = \"refresh_all\"" \
    /data/options.json > /data/options.json.tmp
  chmod 0600 /data/options.json.tmp
  mv /data/options.json.tmp /data/options.json
'
docker rm -f "${CANDIDATE_CONTAINER}" >/dev/null
start_app "${CANDIDATE_CONTAINER}" "${CANDIDATE_IMAGE}"

CANDIDATE_VERSION=$(docker image inspect --format \
  '{{index .Config.Labels "io.hass.version"}}' "${CANDIDATE_IMAGE}")
docker exec "${CANDIDATE_CONTAINER}" /bin/sh -c '
  printf '\''approval_policy = "on-request"\nsandbox_mode = "danger-full-access"\ncli_auth_credentials_store = "file"\ncheck_for_update_on_startup = false\n'\'' \
    | cmp -s - /data/codex/config.toml
' || fail 'refresh_all did not install the image default Codex config'
docker exec "${CANDIDATE_CONTAINER}" cmp -s \
  /usr/local/share/codex-ha/AGENTS.md /data/codex/AGENTS.md \
  || fail 'refresh_all did not install the image default AGENTS.md'
docker exec "${CANDIDATE_CONTAINER}" jq --exit-status \
  --arg version "${CANDIDATE_VERSION}" '
    .schema == 1
    and (.applied.config | index($version) != null)
    and (.applied.agents | index($version) != null)
  ' /data/codex/.user-files-update-state.json >/dev/null \
  || fail 'refresh_all did not record both scopes for the candidate version'

BACKUP_DIRS=$(docker exec "${CANDIDATE_CONTAINER}" find \
  /data/codex/backups/user-files \
  -mindepth 1 -maxdepth 1 -type d -name 'refresh-*')
[[ $(wc -l <<< "${BACKUP_DIRS}") -eq 1 ]] \
  || fail 'refresh_all did not create exactly one transaction backup'
BACKUP_DIR=${BACKUP_DIRS}
[[ $(container_hash "${CANDIDATE_CONTAINER}" \
    "${BACKUP_DIR}/config.before") == "${CONFIG_HASH_BEFORE}" ]] \
  || fail 'refresh_all config backup was not byte-exact'
[[ $(container_hash "${CANDIDATE_CONTAINER}" \
    "${BACKUP_DIR}/agents.before") == "${AGENTS_HASH_BEFORE}" ]] \
  || fail 'refresh_all AGENTS backup was not byte-exact'
docker exec "${CANDIDATE_CONTAINER}" /bin/sh -c '
  backup=$1
  test "$(stat -c "%a:%U:%G" /data/codex/backups)" = 700:root:root
  test "$(stat -c "%a:%U:%G" /data/codex/backups/user-files)" \
    = 700:root:root
  test "$(stat -c "%a:%U:%G" "${backup}")" = 700:root:root
  for file in \
    config.before \
    config.image-default \
    agents.before \
    agents.image-default \
    metadata.json; do
    test "$(stat -c "%a:%U:%G" "${backup}/${file}")" = 600:root:root
  done
  test "$(stat -c "%a:%U:%G" /data/codex/.user-files-update-state.json)" \
    = 600:root:root
  test "$(stat -c "%a:%U:%G" /run/codex-ha/user-files-update.lock)" \
    = 600:root:root
  test ! -e /data/codex/.user-files-update-journal.json
' sh "${BACKUP_DIR}"
[[ $(container_hash "${CANDIDATE_CONTAINER}" /data/codex/auth.json) \
  == "${AUTH_HASH_BEFORE}" ]] \
  || fail 'refresh_all changed auth.json'
[[ $(container_hash \
    "${CANDIDATE_CONTAINER}" /data/codex/AGENTS.override.md) \
  == "${AGENTS_OVERRIDE_HASH_BEFORE}" ]] \
  || fail 'refresh_all changed AGENTS.override.md'
[[ $(container_hash \
    "${CANDIDATE_CONTAINER}" /config/.codex-ha-update-smoke-marker) \
  == "${HA_CONFIG_HASH_BEFORE}" ]] \
  || fail 'refresh_all changed Home Assistant configuration data'
[[ $(host_key_fingerprint "${CANDIDATE_CONTAINER}") \
  == "${HOST_KEY_BEFORE}" ]] \
  || fail 'refresh_all changed the SSH host identity'
[[ $(container_hash "${CANDIDATE_CONTAINER}" /data/github-cli/hosts.yml) \
  == "${GITHUB_CONFIG_HASH_BEFORE}" ]] \
  || fail 'refresh_all changed the GitHub CLI configuration'
docker exec "${CANDIDATE_CONTAINER}" jq --exit-status \
  --arg marker "${BROWSER_OPTION_MARKER}" '
    .codex_user_files_update_mode == "refresh_all"
    and .home_assistant_browser_token == $marker
  ' /data/options.json >/dev/null \
  || fail 'refresh_all changed an unrelated Home Assistant App option'

# A normal restart in the same App version must not repeat a persisted refresh.
docker exec "${CANDIDATE_CONTAINER}" /bin/sh -c \
  'printf "\n%s\n" "$1" >> /data/codex/config.toml' \
  sh "${POST_REFRESH_CONFIG_MARKER}"
docker exec "${CANDIDATE_CONTAINER}" /bin/sh -c \
  'printf "\n%s\n" "$1" >> /data/codex/AGENTS.md' \
  sh "${POST_REFRESH_AGENTS_MARKER}"
BACKUP_COUNT_BEFORE_RESTART=$(docker exec "${CANDIDATE_CONTAINER}" find \
  /data/codex/backups/user-files \
  -mindepth 1 -maxdepth 1 -type d -name 'refresh-*' | wc -l)
docker rm -f "${CANDIDATE_CONTAINER}" >/dev/null
start_app "${CANDIDATE_CONTAINER}" "${CANDIDATE_IMAGE}"
docker exec "${CANDIDATE_CONTAINER}" grep -Fxq \
  "${POST_REFRESH_CONFIG_MARKER}" /data/codex/config.toml \
  || fail 'same-version restart repeated the config refresh'
docker exec "${CANDIDATE_CONTAINER}" grep -Fxq \
  "${POST_REFRESH_AGENTS_MARKER}" /data/codex/AGENTS.md \
  || fail 'same-version restart repeated the AGENTS refresh'
BACKUP_COUNT_AFTER_RESTART=$(docker exec "${CANDIDATE_CONTAINER}" find \
  /data/codex/backups/user-files \
  -mindepth 1 -maxdepth 1 -type d -name 'refresh-*' | wc -l)
[[ "${BACKUP_COUNT_AFTER_RESTART}" -eq "${BACKUP_COUNT_BEFORE_RESTART}" ]] \
  || fail 'same-version restart created a second refresh backup'
[[ $(container_hash "${CANDIDATE_CONTAINER}" /data/codex/auth.json) \
  == "${AUTH_HASH_BEFORE}" ]]
[[ $(container_hash \
    "${CANDIDATE_CONTAINER}" /data/codex/AGENTS.override.md) \
  == "${AGENTS_OVERRIDE_HASH_BEFORE}" ]]
[[ $(container_hash "${CANDIDATE_CONTAINER}" /data/github-cli/hosts.yml) \
  == "${GITHUB_CONFIG_HASH_BEFORE}" ]]

printf 'Update smoke passed: %s -> %s\n' \
  "${RELEASE_IMAGE}" "${CANDIDATE_IMAGE}"
