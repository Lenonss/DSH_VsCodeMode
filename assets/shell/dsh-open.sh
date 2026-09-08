#!/usr/bin/env bash
# dsh-open.sh — DSH 文件编辑 shell launcher（Linux/macOS 通用，bash 3.2+）。
# 由 dsh-vscode-mode 设置页注册写入：Nautilus 脚本 / Dolphin 服务菜单 / macOS 快速操作引用本脚本。
# 行为：读同目录 dsh-open.ini 的 base 地址 → curl 探测（可用时，1s 超时）→ 深链打开默认浏览器。
# 深链契约见插件 src/shared/externalOpen.ts（edrvOpen/edrvPaths/edrvLine/edrvColumn）。
# 作者 ddj 2026-09-07
set -u
export LC_ALL=C

case "$0" in */*) ini_dir="${0%/*}" ;; *) ini_dir="." ;; esac
base="http://127.0.0.1:3080"
ini="$ini_dir/dsh-open.ini"
if [ -f "$ini" ]; then
  parsed=$(sed -n 's/^[[:space:]]*[Bb]ase[[:space:]]*=[[:space:]]*//p' "$ini" | head -n 1)
  [ -n "$parsed" ] && base="$parsed"
fi

# 逐字节 percent-encode：LC_ALL=C 下 ${s:i:1} 按字节迭代，多字节字符（中文等）安全；
# unreserved 保留，其余全部 %XX（编码结果不含裸逗号/空白，逗号分隔契约安全）。
urlencode() {
  local s="$1" out="" i c hex
  for ((i = 0; i < ${#s}; i++)); do
    c="${s:i:1}"
    case "$c" in
      [A-Za-z0-9.~_-]) out+="$c" ;;
      *) printf -v hex '%%%02X' "'$c" ; out+="$hex" ;;
    esac
  done
  printf '%s' "$out"
}

alert() {
  local msg="$1"
  if [ "$(uname)" = "Darwin" ]; then
    osascript -e "display dialog \"$msg\" with title \"DSH 文件编辑\"" >/dev/null 2>&1 || true
  elif command -v notify-send >/dev/null 2>&1; then
    notify-send "DSH 文件编辑" "$msg" || true
  elif command -v zenity >/dev/null 2>&1; then
    zenity --info --title "DSH 文件编辑" --text "$msg" >/dev/null 2>&1 || true
  fi
}

# 无参数（如 Nautilus 空选）静默退出
[ $# -gt 0 ] || exit 0

# DSH 未运行提示（curl 缺失时跳过探测直接打开）
if command -v curl >/dev/null 2>&1; then
  if ! curl -s -o /dev/null --max-time 1 "$base"; then
    alert "DSH Web UI 未运行（$base）。请先启动 DSH。"
    exit 1
  fi
fi

# 全部路径编码后合并为一个深链（多选一次打开）
query=""
for p in "$@"; do
  [ -n "$p" ] || continue
  abs=$(cd "$(dirname "$p")" 2>/dev/null && pwd)/$(basename "$p")
  [ -e "$abs" ] || abs="$p"
  seg=$(urlencode "$abs")
  [ -n "$seg" ] || continue
  if [ -z "$query" ]; then query="$seg"; else query="$query,$seg"; fi
done
[ -n "$query" ] || exit 0

url="${base%/}/?edrvOpen=1&edrvPaths=$query"
case "$(uname)" in
  Darwin) exec open "$url" ;;
  *) exec xdg-open "$url" ;;
esac
