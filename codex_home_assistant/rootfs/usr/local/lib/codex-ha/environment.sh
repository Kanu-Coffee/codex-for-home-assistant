#!/bin/sh

export HOME=/data/home
export CODEX_HOME=/data/codex
export HA_URL="${HA_URL:-http://supervisor/core/api}"
export SUPERVISOR_URL="${SUPERVISOR_URL:-http://supervisor}"
export HISTFILE=/data/home/.bash_history
export PATH="/usr/local/bin:${PATH}"
export TMUX_TMPDIR=/data/tmux
export LANG=C.UTF-8
export LC_ALL=C.UTF-8

if [ -r /run/codex-ha/runtime.env ]; then
  # shellcheck disable=SC1091
  . /run/codex-ha/runtime.env
fi
