#!/usr/bin/env bash

readonly CODEX_HA_OPTIONS_FILE=${CODEX_HA_OPTIONS_FILE:-/data/options.json}

codex_ha_config_validate() {
  [[ -r "${CODEX_HA_OPTIONS_FILE}" ]] \
    && jq --exit-status 'type == "object"' "${CODEX_HA_OPTIONS_FILE}" >/dev/null
}

codex_ha_config_string() {
  local key=$1
  local default_value=$2
  jq --exit-status --raw-output \
    --arg key "${key}" \
    --arg default_value "${default_value}" \
    'if has($key) then .[$key] else $default_value end
      | if type == "string" then . else error("option is not a string") end' \
    "${CODEX_HA_OPTIONS_FILE}"
}

codex_ha_config_true() {
  local key=$1
  jq --exit-status --arg key "${key}" \
    'has($key) and .[$key] == true' "${CODEX_HA_OPTIONS_FILE}" >/dev/null
}

codex_ha_config_bool() {
  local key=$1
  local default_value=$2
  if [[ "${default_value}" != true && "${default_value}" != false ]]; then
    return 2
  fi
  jq --raw-output \
    --arg key "${key}" \
    --argjson default_value "${default_value}" \
    'if has($key) then .[$key] else $default_value end
      | if type == "boolean" then . else error("option is not a boolean") end' \
    "${CODEX_HA_OPTIONS_FILE}"
}

codex_ha_config_json() {
  local key=$1
  local default_json=$2
  jq --compact-output \
    --arg key "${key}" \
    --argjson default_json "${default_json}" \
    'if has($key) then .[$key] else $default_json end' \
    "${CODEX_HA_OPTIONS_FILE}"
}
