#!/usr/bin/env bash
# dwd — point the dsh-wrainrock-daemon at a different port, and restart it.
#
# Installed by @local/dsh-wrainrock-daemon to <state home>/bin/dwd, and linked
# into a directory on PATH as both `dwd` and `dsh-wrainrock-daemon`.
#
#   dwd rp <port>              the port the daemon takes at its NEXT start,
#                              applied right away by restarting it
#                              (alias: dwd report <port>)
#   dwd rp <port> --no-restart only record it; the next start picks it up
#   dwd rp <port> --safe-port <port>
#   dwd status                 what serves now, and what the next start uses
#   dwd restart                restart the daemon
#   dwd help
#
# "Next start port" is a request kept in a file (state/port.json), not a live
# setting: that is what makes this work while the daemon is down, and what lets
# it survive a restart this script did not perform. When the daemon IS running
# the request goes through its HTTP API, which also owns the file, so both paths
# cannot disagree.
#
# The @@...@@ placeholders below are filled in by the host half at install time.
set -uo pipefail

HOME_DIR="${DSH_WRAINROCK_DAEMON_HOME:-@@HOME_DIR@@}"
BAKED_PORT="${DSH_WRAINROCK_DAEMON_PORT:-@@PORT@@}"
BAKED_SAFE_PORT="${DSH_WRAINROCK_DAEMON_SAFE_PORT:-@@SAFE_PORT@@}"
UNIT_NAME="${DSH_WRAINROCK_DAEMON_UNIT:-@@UNIT_NAME@@}"
PROFILE="${DSH_WRAINROCK_DAEMON_PROFILE:-@@PROFILE@@}"
STATE_DIR="${DSH_WRAINROCK_DAEMON_STATE:-${HOME_DIR}/state}"
RUNTIME_FILE="${STATE_DIR}/runtime.json"
PORT_FILE="${STATE_DIR}/port.json"
ROUTE_PREFIX="${DSH_WRAINROCK_DAEMON_ROUTE:-/dsh-wrainrock-daemon}"
TIMEOUT="${DSH_WRAINROCK_DAEMON_TIMEOUT:-5}"

say() { printf '%s\n' "$*"; }
warn() { printf '%s\n' "$*" >&2; }
die() { warn "$*"; exit 1; }

usage() {
  say "dwd — dsh-wrainrock-daemon 控制命令"
  say ""
  say "用法："
  say "  dwd rp <端口>                     设置下次启动端口，并立即重启生效"
  say "  dwd rp <端口> --no-restart        只写入设置，不重启"
  say "  dwd rp <端口> --safe-port <端口>  同时指定安全模式端口"
  say "  dwd status                        查看当前端口与下次启动端口"
  say "  dwd restart                       立即重启守护进程"
  say "  dwd help                          显示本帮助"
  say ""
  say "别名：dwds report、dsh-wrainrock-daemon。"
  say "端口设置保存在 ${PORT_FILE}，守护进程下次启动时生效。"
}

# --- reading json without a json tool ----------------------------------------

# `grep -o` over a single line of JSON is enough for the flat, self-written
# objects this reads. Note that "safePort" does not contain the substring
# "port", so looking a key up by its quoted name can never collide with it.
json_field() { # <key>; JSON on stdin
  grep -o "\"$1\"[[:space:]]*:[[:space:]]*[0-9]\+" 2>/dev/null | grep -o '[0-9]\+' | head -n1
}

json_bool() { # <key>; JSON on stdin
  grep -o "\"$1\"[[:space:]]*:[[:space:]]*\(true\|false\)" 2>/dev/null | grep -o '\(true\|false\)' | head -n1
}

json_number() { # <file> <key>
  [ -r "$1" ] || return 1
  json_field "$2" < "$1"
}

port_valid() { # <value>
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "$1" -ge 1 ] && [ "$1" -le 65535 ]
}

# --- talking to the running daemon -------------------------------------------

live_port() {
  local recorded
  recorded="$(json_number "$RUNTIME_FILE" port)"
  if [ -n "$recorded" ]; then printf '%s\n' "$recorded"; else printf '%s\n' "$BAKED_PORT"; fi
}

http_request() { # <METHOD> <path-with-query>
  local method="$1" path="$2" port url
  port="$(live_port)"
  [ -n "$port" ] || return 1
  url="http://127.0.0.1:${port}${ROUTE_PREFIX}${path}"
  if command -v curl >/dev/null 2>&1; then
    if [ "$method" = 'GET' ]; then
      curl -fsS --max-time "$TIMEOUT" "$url" 2>/dev/null
    else
      curl -fsS --max-time "$TIMEOUT" -X POST -H 'x-dsh-wrainrock-daemon: 1' "$url" 2>/dev/null
    fi
    return $?
  fi
  # curl is not installed everywhere; the daemon runs on node, so node is here.
  node -e '
    const [method, url] = process.argv.slice(1)
    const headers = method === "GET" ? {} : { "x-dsh-wrainrock-daemon": "1" }
    fetch(url, { method, headers }).then(async (res) => {
      process.stdout.write(await res.text())
      process.exit(res.ok ? 0 : 1)
    }).catch(() => process.exit(1))
  ' "$method" "$url" 2>/dev/null
}

# --- writing the request by hand ---------------------------------------------

write_port_file() { # <port> [safePort]
  local port="$1" safe="${2:-}" safejson tmp
  safejson='null'
  [ -n "$safe" ] && safejson="$safe"
  mkdir -p "$STATE_DIR" || return 1
  tmp="${PORT_FILE}.tmp-$$"
  # Same atomic replace the host half uses: a half-written file must never be
  # what the supervisor reads on its way up.
  if ! printf '{\n  "port": %s,\n  "safePort": %s,\n  "at": "%s",\n  "by": "cli"\n}\n' \
      "$port" "$safejson" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  mv -f "$tmp" "$PORT_FILE"
}

do_restart() {
  if http_request POST '/restart' >/dev/null; then
    say "已请求重启（当前端口 $(live_port)）。"
    return 0
  fi
  if command -v systemctl >/dev/null 2>&1 && systemctl --user restart "$UNIT_NAME" 2>/dev/null; then
    say "已通过 systemd 重启 ${UNIT_NAME}。"
    return 0
  fi
  warn "无法自动重启：守护进程没有响应，systemctl 也不可用。"
  warn "请手动重启：systemctl --user restart ${UNIT_NAME}"
  return 1
}

# --- commands ----------------------------------------------------------------

cmd_rp() {
  local restart=1 port='' safe=''
  while [ $# -gt 0 ]; do
    case "$1" in
      --no-restart) restart=0 ;;
      --restart) restart=1 ;;
      --safe-port) shift; safe="${1:-}" ;;
      --safe-port=*) safe="${1#*=}" ;;
      -h|--help) usage; return 0 ;;
      -*) die "未知参数：$1（运行 dwd help 查看用法）" ;;
      *) if [ -z "$port" ]; then port="$1"; else die "多余参数：$1"; fi ;;
    esac
    shift
  done
  [ -n "$port" ] || die "缺少端口号。用法：dwd rp <端口>"
  port_valid "$port" || die "无效端口：$port（应为 1..65535 的整数）"
  if [ -n "$safe" ] && ! port_valid "$safe"; then
    die "无效的安全模式端口：$safe（应为 1..65535 的整数）"
  fi

  local query="/port?port=${port}&by=cli"
  [ -n "$safe" ] && query="${query}&safePort=${safe}"
  [ "$restart" = 1 ] && query="${query}&restart=1"

  local body
  if body="$(http_request POST "$query")" && [ -n "$body" ]; then
    say "下次启动端口已设为 ${port}。"
    if [ "$restart" = 1 ]; then
      say "正在重启以生效（当前端口 $(live_port)）…"
    else
      say "尚未重启；运行 dwd restart 可立即应用。"
    fi
    return 0
  fi

  # Nothing is listening on the recorded port (or there is no record at all):
  # write the same file the API would have written and let the next start — or
  # the systemd unit, just below — pick it up.
  write_port_file "$port" "$safe" || die "无法写入 ${PORT_FILE}"
  say "下次启动端口已设为 ${port}（已写入 ${PORT_FILE}）。"
  if [ "$restart" = 1 ]; then
    do_restart || say "设置已保存，下次启动生效。"
  else
    say "尚未重启；运行 dwd restart 可立即应用。"
  fi
}

cmd_status() {
  local body current next safe pending source
  body="$(http_request GET '/port')"
  if [ -n "$body" ]; then
    current="$(printf '%s\n' "$body" | json_field current)"
    next="$(printf '%s\n' "$body" | json_field next)"
    safe="$(printf '%s\n' "$body" | json_field safePort)"
    pending="$(printf '%s\n' "$body" | json_bool pending)"
    source="$(printf '%s\n' "$body" | grep -o '"source"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"\([^"]*\)"$/\1/')"
  else
    current="$(json_number "$RUNTIME_FILE" port)"
    [ -n "$current" ] || current="$BAKED_PORT"
    next="$(json_number "$PORT_FILE" port)"
    safe="$(json_number "$PORT_FILE" safePort)"
    [ -n "$next" ] || next="$BAKED_PORT"
    if [ "$next" != "$current" ]; then pending=true; else pending=false; fi
    source='offline'
  fi

  say "dsh-wrainrock-daemon（profile ${PROFILE}）"
  say "  当前端口    ${current:-未知}"
  if [ "$pending" = 'true' ]; then
    say "  下次启动    ${next}（重启后生效）"
  else
    say "  下次启动    ${next}"
  fi
  [ -n "$safe" ] && say "  安全模式    ${safe}"
  say "  端口来源    ${source:-未知}"
  say "  服务单元    ${UNIT_NAME}"
  say "  状态目录    ${STATE_DIR}"
}

cmd_restart() { do_restart; }

# --- dispatch ----------------------------------------------------------------

command="${1:-help}"
shift 2>/dev/null || true
case "$command" in
  rp|report|port) cmd_rp "$@" ;;
  status|st) cmd_status ;;
  restart|rs) cmd_restart ;;
  help|-h|--help) usage ;;
  *) warn "未知命令：${command}"; usage >&2; exit 2 ;;
esac
