#!/usr/bin/env sh
set -eu

if [ -n "${SUPERVISOR_TOKEN:-}" ]; then
  exit 93
fi

for argument in "$@"; do
  printf 'ARG=<%s>\n' "${argument}"
done
