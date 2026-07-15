#!/usr/bin/env sh
set -eu

for argument in "$@"; do
  printf 'ARG=<%s>\n' "${argument}"
done
