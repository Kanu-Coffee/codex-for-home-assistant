#!/usr/bin/env bash

# Reject filesystem shapes that could alias a protected path through a name
# outside the path-based Codex and AppArmor policies. The caller supplies the
# fixed Home Assistant configuration mount; no protected path or value is
# printed on failure.
# Return codes:
#   0  - Verification passed: protected paths are regular files / directories without aliases
#   1  - Unsafe shape detected: symlink, hardlink alias (>1 link), or special file (FIFO/socket/device)
#   64 - Usage error: invalid number of arguments
#   73 - Preparation failed: unable to allocate temporary storage
#   78 - Traversal / inspection incomplete: invalid root, unreadable path, or permission denied
codex_ha_sensitive_paths_validate() {
  if (( $# != 1 )); then
    return 64
  fi

  local config_root=${1%/}
  local listing
  local links
  local path
  local storage_root
  local rc=0

  # Check if config_root itself is a symlink or unsafe special/regular file shape
  if [[ -L "${config_root}" || -f "${config_root}" || -p "${config_root}" || -S "${config_root}" || -b "${config_root}" || -c "${config_root}" ]]; then
    return 1
  fi

  # Check if config_root is missing, not absolute, or cannot be accessed/traversed as a directory
  if [[ "${config_root}" != /* || ! -d "${config_root}" ]]; then
    return 78
  fi

  listing=$(/bin/mktemp /tmp/.codex-ha-sensitive-paths.XXXXXX 2>/dev/null) || return 73
  /bin/chmod 0600 "${listing}" 2>/dev/null || {
    /bin/rm -f -- "${listing}"
    return 73
  }

  # 1. Search for secrets.yaml anywhere under config_root (pruning .storage for dedicated check)
  if ! /usr/bin/find -P "${config_root}" \
    -path "${config_root}/.storage" -prune -o \
    -name secrets.yaml -print0 > "${listing}" 2>/dev/null; then
    /bin/rm -f -- "${listing}"
    return 78
  fi

  rc=0
  while IFS= read -r -d '' path; do
    if [[ -L "${path}" ]]; then
      rc=1
      break
    fi
    if [[ ! -e "${path}" ]]; then
      rc=78
      break
    fi
    if [[ ! -f "${path}" ]]; then
      rc=1
      break
    fi
    links=$(/bin/stat -c '%h' -- "${path}" 2>/dev/null) || {
      rc=78
      break
    }
    if [[ "${links}" != 1 ]]; then
      rc=1
      break
    fi
  done < "${listing}"

  if [[ ${rc} -ne 0 ]]; then
    /bin/rm -f -- "${listing}"
    return "${rc}"
  fi

  # 2. Inspect .storage tree
  storage_root="${config_root}/.storage"
  if [[ -L "${storage_root}" ]]; then
    /bin/rm -f -- "${listing}"
    return 1
  fi

  if [[ -e "${storage_root}" ]]; then
    if [[ ! -d "${storage_root}" ]]; then
      /bin/rm -f -- "${listing}"
      return 1
    fi

    if ! /usr/bin/find -P "${storage_root}" -mindepth 1 -print0 \
      > "${listing}" 2>/dev/null; then
      /bin/rm -f -- "${listing}"
      return 78
    fi

    rc=0
    while IFS= read -r -d '' path; do
      if [[ -L "${path}" ]]; then
        rc=1
        break
      fi
      if [[ -d "${path}" ]]; then
        continue
      fi
      if [[ ! -e "${path}" ]]; then
        rc=78
        break
      fi
      if [[ ! -f "${path}" ]]; then
        rc=1
        break
      fi
      links=$(/bin/stat -c '%h' -- "${path}" 2>/dev/null) || {
        rc=78
        break
      }
      if [[ "${links}" != 1 ]]; then
        rc=1
        break
      fi
    done < "${listing}"

    if [[ ${rc} -ne 0 ]]; then
      /bin/rm -f -- "${listing}"
      return "${rc}"
    fi
  fi

  /bin/rm -f -- "${listing}"
  return 0
}

# Shared enforcement helper for entrypoint callers (codex wrapper and codex-ha-init).
# Validates sensitive path integrity and exits fail-closed with appropriate error messages.
codex_ha_sensitive_paths_enforce() {
  local config_root="${1:-/config}"
  local caller="${2:-codex}"
  local code=0

  codex_ha_sensitive_paths_validate "${config_root}" || code=$?
  if (( code == 0 )); then
    return 0
  fi

  case "${caller}" in
    init)
      case "${code}" in
        1)
          bashio::log.fatal \
            'Protected Home Assistant paths have an unsafe link or file type; remove aliases before starting this App'
          ;;
        78)
          bashio::log.fatal \
            'Cannot verify protected Home Assistant path integrity (access or traversal restricted); ensure permissions allow inspection'
          ;;
        73)
          bashio::log.fatal \
            'Failed to prepare temporary storage for path integrity verification; Codex will not start'
          ;;
        *)
          bashio::log.fatal \
            'Protected Home Assistant path integrity check failed; Codex will not start'
          ;;
      esac
      exit 1
      ;;
    codex|*)
      case "${code}" in
        1)
          printf '%s\n' \
            'codex: protected Home Assistant paths have an unsafe link or file type; Codex will not start' >&2
          ;;
        78)
          printf '%s\n' \
            'codex: cannot verify protected Home Assistant path integrity (access or traversal restricted); Codex will not start' >&2
          ;;
        73)
          printf '%s\n' \
            'codex: failed to prepare temporary storage for path integrity verification; Codex will not start' >&2
          ;;
        *)
          printf '%s\n' \
            'codex: protected Home Assistant path verification failed; Codex will not start' >&2
          ;;
      esac
      exit 78
      ;;
  esac
}
