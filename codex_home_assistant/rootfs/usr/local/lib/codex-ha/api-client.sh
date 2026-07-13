#!/usr/bin/env bash
set -Eeuo pipefail

api_usage() {
  printf 'Usage: %s [--raw] METHOD /path [JSON_BODY|-]\n' "${API_PROGRAM_NAME}" >&2
}

redact_stream() {
  local line
  while IFS= read -r line || [[ -n "${line}" ]]; do
    if [[ -n "${SUPERVISOR_TOKEN:-}" ]]; then
      line=${line//"${SUPERVISOR_TOKEN}"/[REDACTED]}
    fi
    printf '%s\n' "${line}"
  done
}

render_body() {
  local body_file=$1
  local raw=$2
  if [[ "${raw}" == true ]] || ! jq --exit-status . "${body_file}" >/dev/null 2>&1; then
    redact_stream < "${body_file}"
  else
    jq . "${body_file}" | redact_stream
  fi
}

api_main() {
  local raw=false
  local method
  local path
  local body=''
  local has_body=false
  local request_dir
  local header_file
  local response_file
  local http_status
  local curl_status
  local curl_bin=${CURL_BIN:-curl}
  local -a curl_args

  if [[ "${1:-}" == --raw ]]; then
    raw=true
    shift
  fi

  if (( $# < 2 || $# > 3 )); then
    api_usage
    return 64
  fi

  method=${1^^}
  path=$2
  if [[ ! "${method}" =~ ^[A-Z]+$ ]]; then
    printf '%s: invalid HTTP method\n' "${API_PROGRAM_NAME}" >&2
    return 64
  fi
  if [[ "${path}" != /* || "${path}" == //* || "${path}" =~ [[:space:]] ]]; then
    printf '%s: path must be a relative API path beginning with one slash\n' "${API_PROGRAM_NAME}" >&2
    return 64
  fi

  if (( $# == 3 )); then
    has_body=true
    if [[ "$3" == - ]]; then
      body=$(cat)
    else
      body=$3
    fi
    if ! jq --exit-status . >/dev/null 2>&1 <<< "${body}"; then
      printf '%s: request body is not valid JSON\n' "${API_PROGRAM_NAME}" >&2
      return 65
    fi
  fi

  if [[ -z "${SUPERVISOR_TOKEN:-}" ]]; then
    printf '%s: SUPERVISOR_TOKEN is unavailable; run inside the Home Assistant App\n' "${API_PROGRAM_NAME}" >&2
    return 78
  fi

  request_dir=$(mktemp -d)
  chmod 0700 "${request_dir}"
  header_file="${request_dir}/headers"
  response_file="${request_dir}/response"
  trap 'rm -rf -- "${request_dir}"' RETURN
  printf 'Authorization: Bearer %s\n' "${SUPERVISOR_TOKEN}" > "${header_file}"
  chmod 0600 "${header_file}"

  curl_args=(
    --silent
    --show-error
    --request "${method}"
    --header "@${header_file}"
    --header 'Accept: application/json'
    --output "${response_file}"
    --write-out '%{http_code}'
    --connect-timeout 10
    --max-time 300
  )
  if [[ "${has_body}" == true ]]; then
    curl_args+=(--header 'Content-Type: application/json' --data "${body}")
  fi
  curl_args+=("${API_BASE_URL%/}${path}")

  set +e
  http_status=$("${curl_bin}" "${curl_args[@]}")
  curl_status=$?
  set -e

  if (( curl_status != 0 )); then
    printf '%s: request transport failed (curl exit %d)\n' "${API_PROGRAM_NAME}" "${curl_status}" >&2
    return 69
  fi
  if [[ ! "${http_status}" =~ ^[0-9]{3}$ ]]; then
    printf '%s: request returned an invalid HTTP status\n' "${API_PROGRAM_NAME}" >&2
    return 69
  fi

  if (( http_status < 200 || http_status >= 300 )); then
    printf '%s: HTTP %s\n' "${API_PROGRAM_NAME}" "${http_status}" >&2
    render_body "${response_file}" "${raw}" >&2
    return 1
  fi

  if [[ "${API_CHECK_RESULT}" == true ]]; then
    if jq --exit-status 'type == "object" and has("result")' \
      "${response_file}" >/dev/null 2>&1; then
      if jq --exit-status '.result != "ok"' "${response_file}" >/dev/null 2>&1; then
        printf '%s: Supervisor result was not ok\n' "${API_PROGRAM_NAME}" >&2
        render_body "${response_file}" "${raw}" >&2
        return 1
      fi
    elif [[ "${raw}" != true ]]; then
      printf '%s: Supervisor response is missing the result field\n' "${API_PROGRAM_NAME}" >&2
      render_body "${response_file}" "${raw}" >&2
      return 1
    fi
  fi

  render_body "${response_file}" "${raw}"
}
