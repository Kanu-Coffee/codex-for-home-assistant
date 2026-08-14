#!/usr/bin/env bash

# Load the Supervisor token for a narrowly scoped helper. Callers must pass the
# image-managed runtime path explicitly; ambient credentials are discarded.
codex_ha_load_supervisor_credential() {
  if (( $# != 1 )); then
    return 64
  fi

  local credential_file=$1
  local expected_uid
  local metadata

  unset SUPERVISOR_TOKEN
  if [[ -L "${credential_file}" || ! -f "${credential_file}" || ! -r "${credential_file}" ]]; then
    return 78
  fi

  expected_uid=$(id -u)
  if ! metadata=$(stat -c '%u:%a:%h' -- "${credential_file}" 2>/dev/null); then
    return 78
  fi
  if [[ "${metadata}" != "${expected_uid}:600:1" ]]; then
    return 78
  fi

  # This file is created atomically by codex-ha-init with shell-escaped values.
  # shellcheck source=/dev/null
  . "${credential_file}"
  if [[ -z "${SUPERVISOR_TOKEN:-}" ]]; then
    unset SUPERVISOR_TOKEN
    return 78
  fi

  # curl receives the credential only through its private header file. Do not
  # copy the token into the child process environment.
  export -n SUPERVISOR_TOKEN
}
