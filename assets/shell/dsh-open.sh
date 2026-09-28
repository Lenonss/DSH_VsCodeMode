#!/usr/bin/env bash
# POSIX launcher; use the interpreter recorded by the selected DSH host.
# @author ddj 2026-09-28
set -eu
[ "$#" -gt 0 ] || exit 0
case "$0" in */*) ini_dir="${0%/*}" ;; *) ini_dir="." ;; esac
ini_dir=$(cd "$ini_dir" && pwd -P)
ini="$ini_dir/dsh-open.ini"
node=""
node_mode=""
helper=""
# Read values as data; never source/eval an INI file.
while IFS='=' read -r key value || [ -n "$key" ]; do
  value=${value%$'\r'}
  case "$key" in
    node) node="$value" ;;
    nodeMode) node_mode="$value" ;;
    helper) helper="$value" ;;
  esac
done < "$ini"
case "$node" in /*) ;; *) printf '%s\n' 'DSH: missing absolute node executable.' >&2; exit 1 ;; esac
case "$helper" in /*) ;; *) printf '%s\n' 'DSH: missing absolute producer helper.' >&2; exit 1 ;; esac
[ -x "$node" ] && [ -f "$helper" ] || { printf '%s\n' 'DSH: configured producer is unavailable.' >&2; exit 1; }
case "$node_mode" in
  electron) export ELECTRON_RUN_AS_NODE=1 ;;
  node) unset ELECTRON_RUN_AS_NODE ;;
  *) printf '%s\n' 'DSH: missing nodeMode.' >&2; exit 1 ;;
esac
exec "$node" "$helper" --config "$ini" -- "$@"
