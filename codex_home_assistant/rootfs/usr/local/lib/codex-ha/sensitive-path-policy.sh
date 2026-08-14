#!/usr/bin/env bash

# Reject filesystem shapes that could alias a protected path through a name
# outside the path-based Codex and AppArmor policies. The caller supplies the
# fixed Home Assistant configuration mount; no protected path or value is
# printed on failure.
codex_ha_sensitive_paths_validate() {
  if (( $# != 1 )); then
    return 64
  fi

  local config_root=${1%/}
  local listing
  local links
  local path
  local storage_root
  local valid=true

  if [[ "${config_root}" != /* || -L "${config_root}" || ! -d "${config_root}" ]]; then
    return 78
  fi

  listing=$(/bin/mktemp /tmp/.codex-ha-sensitive-paths.XXXXXX) || return 78
  /bin/chmod 0600 "${listing}"

  if ! /usr/bin/find -P "${config_root}" \
    -path "${config_root}/.storage" -prune -o \
    -name secrets.yaml -print0 > "${listing}" 2>/dev/null; then
    /bin/rm -f -- "${listing}"
    return 78
  fi
  while IFS= read -r -d '' path; do
    if [[ -L "${path}" || ! -f "${path}" ]]; then
      valid=false
      break
    fi
    links=$(/bin/stat -c '%h' -- "${path}" 2>/dev/null) || {
      valid=false
      break
    }
    if [[ "${links}" != 1 ]]; then
      valid=false
      break
    fi
  done < "${listing}"

  storage_root="${config_root}/.storage"
  if [[ "${valid}" == true && -L "${storage_root}" ]]; then
    valid=false
  elif [[ "${valid}" == true && -e "${storage_root}" ]]; then
    if [[ ! -d "${storage_root}" ]] \
      || ! /usr/bin/find -P "${storage_root}" -mindepth 1 -print0 \
        > "${listing}" 2>/dev/null; then
      valid=false
    else
      while IFS= read -r -d '' path; do
        if [[ -L "${path}" ]]; then
          valid=false
          break
        fi
        if [[ -d "${path}" ]]; then
          continue
        fi
        if [[ ! -f "${path}" ]]; then
          valid=false
          break
        fi
        links=$(/bin/stat -c '%h' -- "${path}" 2>/dev/null) || {
          valid=false
          break
        }
        if [[ "${links}" != 1 ]]; then
          valid=false
          break
        fi
      done < "${listing}"
    fi
  fi

  /bin/rm -f -- "${listing}"
  [[ "${valid}" == true ]]
}
