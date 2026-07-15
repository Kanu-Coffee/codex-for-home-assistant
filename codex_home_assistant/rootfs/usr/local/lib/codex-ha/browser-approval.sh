#!/usr/bin/env bash

# Keep the policy surface equal to the image-managed Playwright MCP allowlist.
# New tools are not added here automatically and therefore inherit the
# fail-closed server default of prompt until they are explicitly reviewed.
readonly CODEX_HA_PLAYWRIGHT_SAFE_TOOLS=(
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

readonly CODEX_HA_PLAYWRIGHT_INTERACTIVE_TOOLS=(
  browser_click
  browser_fill_form
  browser_press_key
  browser_select_option
  browser_type
)

readonly CODEX_HA_PLAYWRIGHT_TOOLS=(
  "${CODEX_HA_PLAYWRIGHT_SAFE_TOOLS[@]}"
  "${CODEX_HA_PLAYWRIGHT_INTERACTIVE_TOOLS[@]}"
)

codex_ha_browser_approval_policy_validate() {
  case "${1:-}" in
    safe | never | always) return 0 ;;
    *) return 1 ;;
  esac
}

codex_ha_browser_tool_is_safe() {
  local candidate=${1:-}
  local tool

  for tool in "${CODEX_HA_PLAYWRIGHT_SAFE_TOOLS[@]}"; do
    if [[ "${tool}" == "${candidate}" ]]; then
      return 0
    fi
  done
  return 1
}

CODEX_HA_BROWSER_APPROVAL_ARGS=()
codex_ha_browser_build_approval_args() {
  local policy=${1:-}
  local tool
  local approval_mode

  codex_ha_browser_approval_policy_validate "${policy}" || return 2

  CODEX_HA_BROWSER_APPROVAL_ARGS=(
    -c 'mcp_servers.playwright.default_tools_approval_mode="prompt"'
  )
  for tool in "${CODEX_HA_PLAYWRIGHT_TOOLS[@]}"; do
    case "${policy}" in
      never)
        approval_mode=approve
        ;;
      always)
        approval_mode=prompt
        ;;
      safe)
        if codex_ha_browser_tool_is_safe "${tool}"; then
          approval_mode=approve
        else
          approval_mode=prompt
        fi
        ;;
    esac
    CODEX_HA_BROWSER_APPROVAL_ARGS+=(
      -c "mcp_servers.playwright.tools.${tool}.approval_mode=\"${approval_mode}\""
    )
  done
}
