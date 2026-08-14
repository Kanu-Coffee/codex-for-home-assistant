#!/bin/sh

# Interactive shells and Codex processes must never inherit the Supervisor
# credential from the container or an SSH/ttyd parent. Privileged helpers load
# it from the root-only runtime file only for the duration of an API call.
unset SUPERVISOR_TOKEN

export HOME=/data/home
export CODEX_HOME=/data/codex
export HA_URL=http://supervisor/core/api
export SUPERVISOR_URL=http://supervisor
export HISTFILE=/data/home/.bash_history
export PATH="/usr/local/bin:${PATH}"
export TMUX_TMPDIR=/data/tmux
export LANG=C.UTF-8
export LC_ALL=C.UTF-8
