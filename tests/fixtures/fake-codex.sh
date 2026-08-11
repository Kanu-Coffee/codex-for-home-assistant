#!/usr/bin/env sh
set -eu

if [ -n "${SUPERVISOR_TOKEN:-}" ]; then
  exit 93
fi

: > /tmp/codex-auto-started
