#!/usr/bin/env bash
set -Eeuo pipefail

IMAGE=${1:-codex-for-home-assistant:test}
TEST_ID="codex-ha-browser-approval-${RANDOM}-$$"
CONTAINERS=()

SAFE_TOOLS=(
  browser_close
  browser_console_messages
  browser_hover
  browser_navigate
  browser_navigate_back
  browser_network_requests
  browser_resize
  browser_snapshot
  browser_tabs
  browser_take_screenshot
  browser_wait_for
)
INTERACTIVE_TOOLS=(
  browser_click
  browser_fill_form
  browser_press_key
  browser_select_option
  browser_type
)
ALL_TOOLS=("${SAFE_TOOLS[@]}" "${INTERACTIVE_TOOLS[@]}")
PROBE_OUTPUT=''

# Git Bash rewrites Linux container paths before invoking native Windows programs.
if [[ "${OSTYPE:-}" == msys* || "${OSTYPE:-}" == cygwin* ]]; then
  docker() {
    MSYS_NO_PATHCONV=1 command docker "$@"
  }
fi

cleanup() {
  if (( ${#CONTAINERS[@]} > 0 )); then
    docker rm -f "${CONTAINERS[@]}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

fail() {
  printf 'browser approval smoke: %s\n' "$*" >&2
  exit 1
}

start_probe() {
  local name=$1
  local options_json=$2

  docker create \
    --platform linux/amd64 \
    --name "${name}" \
    --entrypoint /bin/sleep \
    "${IMAGE}" infinity >/dev/null
  CONTAINERS+=("${name}")
  docker start "${name}" >/dev/null
  docker exec "${name}" mkdir -p /data/home /data/codex /data/tmux /config
  printf '%s' "${options_json}" \
    | docker exec --interactive "${name}" /bin/sh -c \
      'umask 077; cat > /data/options.json'
}

assert_config_once() {
  local output=$1
  local config_value=$2
  local count

  count=$(grep -Fxc "ARG=<${config_value}>" <<< "${output}" || true)
  [[ "${count}" -eq 1 ]] \
    || fail "expected one config override: ${config_value}; got ${count}"
}

probe_policy() {
  local policy=$1
  local effective_policy=$2
  local options_json
  local name="${TEST_ID}-${policy}"
  local output
  local tool
  local safe_tool
  local expected_mode

  if [[ "${policy}" == missing ]]; then
    options_json='{}'
  else
    options_json="{\"browser_approval_policy\":\"${policy}\"}"
  fi
  start_probe "${name}" "${options_json}"

  docker exec --workdir /config "${name}" \
    codex mcp get playwright --json >/dev/null \
    || fail "pinned Codex rejected ${policy} policy overrides"

  docker cp tests/fake-codex-real.sh \
    "${name}:/usr/local/libexec/codex-real" >/dev/null
  docker exec "${name}" chmod 0755 /usr/local/libexec/codex-real
  output=$(docker exec --workdir /config "${name}" \
    codex __probe__ passthrough-value)

  [[ $(grep -Fxc 'ARG=<-c>' <<< "${output}" || true) -eq 19 ]] \
    || fail "${policy} did not emit exactly 19 -c arguments"
  assert_config_once "${output}" 'approval_policy="on-request"'
  assert_config_once "${output}" 'sandbox_mode="danger-full-access"'
  assert_config_once "${output}" \
    'mcp_servers.playwright.default_tools_approval_mode="prompt"'
  [[ $(grep -Fxc 'ARG=<__probe__>' <<< "${output}" || true) -eq 1 ]]
  [[ $(grep -Fxc 'ARG=<passthrough-value>' <<< "${output}" || true) -eq 1 ]]

  for tool in "${ALL_TOOLS[@]}"; do
    case "${effective_policy}" in
      never)
        expected_mode=approve
        ;;
      always)
        expected_mode=prompt
        ;;
      safe)
        expected_mode=prompt
        for safe_tool in "${SAFE_TOOLS[@]}"; do
          if [[ "${safe_tool}" == "${tool}" ]]; then
            expected_mode=approve
            break
          fi
        done
        ;;
    esac
    assert_config_once "${output}" \
      "mcp_servers.playwright.tools.${tool}.approval_mode=\"${expected_mode}\""
  done

  PROBE_OUTPUT=${output}
}

assert_invalid_policy() {
  local suffix=$1
  local options_json=$2
  local name="${TEST_ID}-${suffix}"
  local status

  start_probe "${name}" "${options_json}"
  set +e
  docker exec --workdir /config "${name}" codex __probe__ \
    >/dev/null 2>&1
  status=$?
  set -e
  [[ "${status}" -eq 78 ]] \
    || fail "${suffix} returned ${status}, expected 78"
}

probe_policy missing safe
MISSING_OUTPUT=${PROBE_OUTPUT}
probe_policy safe safe
SAFE_OUTPUT=${PROBE_OUTPUT}
[[ "${MISSING_OUTPUT}" == "${SAFE_OUTPUT}" ]] \
  || fail 'missing policy did not match the explicit safe policy'
probe_policy never never
probe_policy always always
assert_invalid_policy invalid-enum \
  '{"browser_approval_policy":"unexpected"}'
assert_invalid_policy invalid-type \
  '{"browser_approval_policy":42}'

printf 'Browser approval policy smoke passed: %s\n' "${IMAGE}"
