#!/usr/bin/env bash
# Self-test for the generated supervisor. Runs the whole recovery ladder against
# stub commands in a scratch directory, so it never touches the real profile or
# the real systemd units.
#
#   bash tests/ladder.sh
#
# It covers:
#   1. rapid crash loop  -> safe mode + incident report
#   2. healthy run       -> failure ladder reset
#   3. clean exit        -> supervisor stops (no restart storm)
#   4. broken config     -> quarantine + restore from the known-good snapshot
#   …  13-15. the 2026-10-15 guards: a port owned by a peer instance is waited
#            out, a second supervisor stands by on the lock, and losing the port
#            race never counts as a profile failure (never a false safe mode)
#   17-18.  the 2026-10-17 fix: stopping one supervisor also stops the peer from
#            the other systemd user manager, and the systemd-kill helper stops
#            every supervisor and starts the unit again (restart really restarts)
set -uo pipefail

# The port guards are exercised explicitly in section 13+; every earlier section
# only ever runs stub children on port 3999, which is never really bound.
export DSH_WRAINROCK_DAEMON_PORT_GUARD=0

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRATCH="$PLUGIN_DIR/.selftest"
FAILED=0

render() {
  sed -e "s|@@HOME_DIR@@|$SCRATCH/home|g" \
      -e "s|@@NODE_BIN@@|/bin/bash|g" \
      -e "s|@@DSH_CLI@@|$SCRATCH/stub-cli.sh|g" \
      -e "s|@@DSH_HOME@@|$SCRATCH/dshhome|g" \
      -e "s|@@PROFILE@@|web|g" \
      -e "s|@@SAFE_PROFILE@@|dsh-safe|g" \
      -e "s|@@SAFE_TEMPLATE@@|web|g" \
      -e "s|@@APP_ARGS@@|--no-open --port 3999|g" \
      -e "s|@@SAFE_APP_ARGS@@|--no-open --port 4000|g" \
      -e "s|@@PORT@@|3999|g" \
      -e "s|@@SAFE_PORT@@|4000|g" \
      -e "s|@@PORT_GUARD@@|1|g" \
      -e "s|@@UNIT_NAME@@|dsh-wrainrock-daemon.service|g" \
      -e "s|@@FAIL_WINDOW@@|600|g" \
      -e "s|@@FAIL_THRESHOLD@@|3|g" \
      -e "s|@@HEALTHY_SECONDS@@|1|g" \
      -e "s|@@MAX_BACKOFF@@|2|g" \
      -e "s|@@NOTIFY@@|0|g" \
      -e "s|@@CRASH_DISABLE@@|1|g" \
      -e "s|@@CONTAINER_KIND@@||g" \
      "$PLUGIN_DIR/supervisor.sh"
}

check() { # description expected actual
  if [ "$2" = "$3" ]; then
    printf '  ok   %s\n' "$1"
  else
    printf '  FAIL %s (expected %s, got %s)\n' "$1" "$2" "$3"
    FAILED=1
  fi
}

# Wait until a shell condition holds (or the deadline passes). The recovery
# ladder is driven by backoff timers, so asserting after a fixed sleep is flaky.
await() { # shell-condition seconds
  local deadline=$(( $(date +%s) + $2 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    eval "$1" && return 0
    sleep 0.25
  done
  return 1
}

# Wait until a pid is really gone. A zombie still answers kill -0, so look at
# /proc/PID/stat state instead (a child of this script becomes a zombie first).
await_exit() { # pid seconds
  local pid="$1" deadline=$(( $(date +%s) + $2 )) st
  while [ "$(date +%s)" -lt "$deadline" ]; do
    st="$(awk '{print $3}' "/proc/$pid/stat" 2>/dev/null)" || st=''
    case "$st" in ''|Z) return 0 ;; esac
    sleep 0.2
  done
  return 1
}

prepare() {  rm -rf "$SCRATCH"
  mkdir -p "$SCRATCH/home" "$SCRATCH/home/state" "$SCRATCH/dshhome/profiles/web"
  printf '#!/bin/bash\nsleep 0.2\nexit 1\n' >"$SCRATCH/fail.sh"
  printf '#!/bin/bash\nsleep 2\nexit 1\n' >"$SCRATCH/healthy.sh"
  printf '#!/bin/bash\nsleep 2\nexit 0\n' >"$SCRATCH/clean.sh"
  cat >"$SCRATCH/stub-cli.sh" <<EOF
#!/bin/bash
if grep -q BROKEN "$SCRATCH/dshhome/profiles/web/cordis.patch.yml" 2>/dev/null; then
  echo "stub-cli: YAMLException: broken profile config" >&2
  exit 1
fi
echo "[]"
exit 0
EOF
  chmod +x "$SCRATCH"/*.sh
  render >"$SCRATCH/supervisor.sh"
}

echo "1. rapid crash loop escalates to safe mode"
prepare
DSH_WRAINROCK_DAEMON_EXEC="$SCRATCH/fail.sh" DSH_WRAINROCK_DAEMON_SKIP_PREFLIGHT=1 DSH_WRAINROCK_DAEMON_SKIP_SAFE_PROFILE=1 \
  bash "$SCRATCH/supervisor.sh" >/dev/null 2>&1 &
SUP=$!
await '[ "$(cat "$SCRATCH/home/state/mode" 2>/dev/null)" = safe ]' 30
kill -TERM "$SUP" 2>/dev/null
wait "$SUP" 2>/dev/null
check "mode file says safe" "safe" "$(cat "$SCRATCH/home/state/mode" 2>/dev/null)"
check "an incident was recorded" "safe-mode" "$(grep -o '"kind":"[a-z-]*"' "$SCRATCH/home/state/incident.json" 2>/dev/null | cut -d'"' -f4)"
check "a report file exists" "1" "$(ls -1 "$SCRATCH/home/reports"/incident-*.md 2>/dev/null | wc -l)"

echo "2. a healthy run clears the failure ladder"
prepare
printf '2' >"$SCRATCH/home/state/failures"
printf '%s' "$(date +%s)" >"$SCRATCH/home/state/window_start"
printf 'normal' >"$SCRATCH/home/state/mode"
DSH_WRAINROCK_DAEMON_EXEC="$SCRATCH/healthy.sh" DSH_WRAINROCK_DAEMON_SKIP_PREFLIGHT=1 DSH_WRAINROCK_DAEMON_SKIP_SAFE_PROFILE=1 \
  bash "$SCRATCH/supervisor.sh" >/dev/null 2>&1 &
SUP=$!
await '[ "$(cat "$SCRATCH/home/state/failures" 2>/dev/null)" = 0 ]' 20
kill -TERM "$SUP" 2>/dev/null
wait "$SUP" 2>/dev/null
check "failures reset" "0" "$(cat "$SCRATCH/home/state/failures" 2>/dev/null)"

echo "3. a clean exit is restarted, never treated as a stop"
prepare
DSH_WRAINROCK_DAEMON_EXEC="$SCRATCH/clean.sh" DSH_WRAINROCK_DAEMON_SKIP_PREFLIGHT=1 DSH_WRAINROCK_DAEMON_SKIP_SAFE_PROFILE=1 \
  timeout -s TERM 8 bash "$SCRATCH/supervisor.sh" >/dev/null 2>&1
check "supervisor kept running until the timeout" "124" "$?"
check "it restarted instead of stopping" "yes" \
  "$(grep -q 'restarting anyway' "$SCRATCH/home/logs/supervisor.log" 2>/dev/null && echo yes || echo no)"

echo "4. a broken config is quarantined and restored"
prepare
mkdir -p "$SCRATCH/home/backup"
printf 'good-config\n' >"$SCRATCH/home/backup/cordis.patch.yml"
printf 'BROKEN-CONFIG\n' >"$SCRATCH/dshhome/profiles/web/cordis.patch.yml"
DSH_WRAINROCK_DAEMON_EXEC="$SCRATCH/clean.sh" timeout -s TERM 8 bash "$SCRATCH/supervisor.sh" >/dev/null 2>&1
check "profile config restored" "good-config" "$(cat "$SCRATCH/dshhome/profiles/web/cordis.patch.yml" 2>/dev/null)"
check "broken config quarantined" "1" "$(ls -1d "$SCRATCH/home/reports"/broken-* 2>/dev/null | wc -l)"

echo "5. the relaunch helper waits for the old pid and re-executes"
prepare
( sleep 0.4 ) & old_pid=$!
DSH_RELAUNCH_LOG="$SCRATCH/relaunch.log" \
  bash "$PLUGIN_DIR/relaunch.sh" "$old_pid" exec "" "$SCRATCH" /bin/bash -c "echo relaunched >'$SCRATCH/relaunch-ok'"
check "helper exit code" "0" "$?"
check "command was re-executed" "relaunched" "$(cat "$SCRATCH/relaunch-ok" 2>/dev/null)"
check "helper left a log behind" "yes" \
  "$(grep -q 'start mode=exec' "$SCRATCH/relaunch.log" 2>/dev/null && echo yes || echo no)"

echo "6. the relaunch helper fails fast when systemd cannot restart the unit"
DSH_RELAUNCH_LOG="$SCRATCH/relaunch.log" \
  bash "$PLUGIN_DIR/relaunch.sh" 1 systemd dsh-wrainrock-daemon-does-not-exist.service "" /bin/true
check "helper exit code" "1" "$?"
check "helper logged the failure" "yes" \
  "$(grep -q 'could not restart' "$SCRATCH/relaunch.log" 2>/dev/null && echo yes || echo no)"

echo "7. an instant exit 0 is a failed start, not a clean stop"
prepare
printf '#!/bin/bash\nsleep 0.2\nexit 0\n' >"$SCRATCH/exit0.sh"
chmod +x "$SCRATCH/exit0.sh"
DSH_WRAINROCK_DAEMON_EXEC="$SCRATCH/exit0.sh" DSH_WRAINROCK_DAEMON_HEALTHY_SECONDS=5 \
  DSH_WRAINROCK_DAEMON_SKIP_PREFLIGHT=1 DSH_WRAINROCK_DAEMON_SKIP_SAFE_PROFILE=1 \
  bash "$SCRATCH/supervisor.sh" >/dev/null 2>&1 &
SUP=$!
await '[ "$(cat "$SCRATCH/home/state/mode" 2>/dev/null)" = safe ]' 30
kill -TERM "$SUP" 2>/dev/null
wait "$SUP" 2>/dev/null
RETRIES="$(grep -c 'treated as a failed start' "$SCRATCH/home/logs/supervisor.log" 2>/dev/null | head -1)"
check "kept retrying instead of stopping" "yes" "$([ "${RETRIES:-0}" -ge 1 ] && echo yes || echo no)"
check "escalated to safe mode" "safe" "$(cat "$SCRATCH/home/state/mode" 2>/dev/null)"
check "incident kind" "safe-mode" \
  "$(grep -o '"kind":"[a-z-]*"' "$SCRATCH/home/state/incident.json" 2>/dev/null | cut -d'"' -f4)"

echo "8. an unusable generated command line is reported and never launched"
prepare
HOME="$SCRATCH/nohome" PATH=/usr/bin:/bin \
  DSH_WRAINROCK_DAEMON_NODE=/nonexistent/node DSH_WRAINROCK_DAEMON_CLI=/nonexistent/bin.js \
  DSH_WRAINROCK_DAEMON_NOTIFY=0 DSH_WRAINROCK_DAEMON_MAX_BACKOFF=1 \
  timeout -s TERM 5 bash "$SCRATCH/supervisor.sh" >/dev/null 2>&1
LAUNCHED="$(grep -c 'start mode=' "$SCRATCH/home/logs/dsh.out.log" 2>/dev/null | head -1)"
check "nothing was launched" "0" "${LAUNCHED:-0}"
check "runtime-missing incident written" "runtime-missing" \
  "$(grep -o '"kind":"[a-z-]*"' "$SCRATCH/home/state/incident.json" 2>/dev/null | cut -d'"' -f4)"

echo "9. a stale generated command line is repaired from an installed layout"
prepare
FAKE="$SCRATCH/fakehome/.local/share/fnm/node-versions/v9.9.9/installation"
mkdir -p "$FAKE/bin" "$FAKE/lib/node_modules/@deepseek-ai/dsh/lib"
printf '#!/bin/bash\nexec /bin/bash "$@"\n' >"$FAKE/bin/node"
printf '#!/bin/bash\necho "fake dsh cli ran: $*" >>"%s"\nexit 0\n' "$SCRATCH/cli-ran.txt" >"$FAKE/lib/node_modules/@deepseek-ai/dsh/lib/bin.js"
chmod +x "$FAKE/bin/node" "$FAKE/lib/node_modules/@deepseek-ai/dsh/lib/bin.js"
HOME="$SCRATCH/fakehome" PATH=/usr/bin:/bin \
  DSH_WRAINROCK_DAEMON_NODE=/nonexistent/node DSH_WRAINROCK_DAEMON_CLI=/nonexistent/bin.js \
  DSH_WRAINROCK_DAEMON_SKIP_PREFLIGHT=1 DSH_WRAINROCK_DAEMON_SKIP_SAFE_PROFILE=1 DSH_WRAINROCK_DAEMON_HEALTHY_SECONDS=0 \
  timeout -s TERM 5 bash "$SCRATCH/supervisor.sh" >/dev/null 2>&1
check "repaired from the installed layout" "yes" \
  "$(grep -q 'runtime repaired' "$SCRATCH/home/logs/supervisor.log" 2>/dev/null && echo yes || echo no)"
check "the repaired command really ran" "yes" \
  "$(grep -q 'fake dsh cli ran' "$SCRATCH/cli-ran.txt" 2>/dev/null && echo yes || echo no)"

echo "10. a stop signal (systemctl stop) ends the supervisor promptly"
prepare
DSH_WRAINROCK_DAEMON_EXEC="sleep 30" DSH_WRAINROCK_DAEMON_SKIP_PREFLIGHT=1 DSH_WRAINROCK_DAEMON_SKIP_SAFE_PROFILE=1 \
  bash "$SCRATCH/supervisor.sh" >/dev/null 2>&1 &
SUP=$!
sleep 1
kill -TERM "$SUP"
wait "$SUP"
check "supervisor exit code" "0" "$?"
check "logged the stop" "yes" \
  "$(grep -q 'stop requested\|stopped by signal' "$SCRATCH/home/logs/supervisor.log" 2>/dev/null && echo yes || echo no)"

echo "11. rename migration (a legacy dsh-autostart install -> dsh-wrainrock-daemon)"
if command -v node >/dev/null 2>&1; then
  if node "$PLUGIN_DIR/tests/migration.mjs" >"$SCRATCH/migration.log" 2>&1; then
    check "migration test" "passed" "passed"
  else
    check "migration test" "passed" "failed (see $SCRATCH/migration.log)"
  fi
else
  echo "  skip (node not on PATH)"
fi

echo "12. client restart lifecycle (regression: page left dead after a restart)"
if command -v node >/dev/null 2>&1; then
  if node "$PLUGIN_DIR/tests/restart-flow.mjs" >"$SCRATCH/restart-flow.log" 2>&1; then
    check "restart flow test" "passed" "passed"
  else
    check "restart flow test" "passed" "failed (see $SCRATCH/restart-flow.log)"
  fi
else
  echo "  skip (node not on PATH)"
fi

echo "13. a port owned by a peer instance is waited out, never escalated"
if command -v node >/dev/null 2>&1; then
  prepare
  node -e 'require("net").createServer().listen(3999,"127.0.0.1")' &
  LISTENER=$!
  mkdir -p "$SCRATCH/peer"
  printf '#!/bin/bash\nsleep 60\n' >"$SCRATCH/peer/bin.js"
  bash "$SCRATCH/peer/bin.js" --port 3999 &
  PEER=$!
  await 'ss -ltnH "sport = :3999" 2>/dev/null | grep -q .' 5
  DSH_WRAINROCK_DAEMON_PORT_GUARD=1 DSH_WRAINROCK_DAEMON_SKIP_PREFLIGHT=1 DSH_WRAINROCK_DAEMON_SKIP_SAFE_PROFILE=1 \
    DSH_WRAINROCK_DAEMON_STANDBY_POLL=1 bash "$SCRATCH/supervisor.sh" >/dev/null 2>&1 &
  SUP=$!
  await 'grep -q "peer instance owns port" "$SCRATCH/home/logs/supervisor.log" 2>/dev/null' 15
  kill -TERM "$SUP" 2>/dev/null; wait "$SUP" 2>/dev/null
  kill -TERM "$LISTENER" "$PEER" 2>/dev/null; wait "$LISTENER" "$PEER" 2>/dev/null
  check "waited for the peer" "yes" \
    "$(grep -q 'peer instance owns port 3999' "$SCRATCH/home/logs/supervisor.log" 2>/dev/null && echo yes || echo no)"
  check "no safe mode was entered" "normal" "$(cat "$SCRATCH/home/state/mode" 2>/dev/null || echo normal)"
  check "no failure was counted" "0" "$(cat "$SCRATCH/home/state/failures" 2>/dev/null || echo 0)"
  check "incident kind" "peer-port" \
    "$(grep -o '"kind":"[a-z-]*"' "$SCRATCH/home/state/incident.json" 2>/dev/null | cut -d'"' -f4)"
  LAUNCHED="$(grep -c 'start mode=' "$SCRATCH/home/logs/dsh.out.log" 2>/dev/null | head -1)"
  check "nothing was launched" "0" "${LAUNCHED:-0}"
else
  echo "  skip (node not on PATH)"
fi

echo "14. a second supervisor on the same profile+port stands by on the lock"
prepare
DSH_WRAINROCK_DAEMON_EXEC="sleep 30" DSH_WRAINROCK_DAEMON_SKIP_PREFLIGHT=1 DSH_WRAINROCK_DAEMON_SKIP_SAFE_PROFILE=1 \
  bash "$SCRATCH/supervisor.sh" >/dev/null 2>&1 &
SUP1=$!
await 'grep -q "supervisor started" "$SCRATCH/home/logs/supervisor.log" 2>/dev/null' 15
DSH_WRAINROCK_DAEMON_EXEC="sleep 30" DSH_WRAINROCK_DAEMON_SKIP_PREFLIGHT=1 DSH_WRAINROCK_DAEMON_SKIP_SAFE_PROFILE=1 \
  DSH_WRAINROCK_DAEMON_STANDBY_POLL=1 bash "$SCRATCH/supervisor.sh" >/dev/null 2>&1 &
SUP2=$!
await 'grep -q "standby: another supervisor" "$SCRATCH/home/logs/supervisor.log" 2>/dev/null' 15
STARTS="$(grep -c 'start mode=' "$SCRATCH/home/logs/dsh.out.log" 2>/dev/null | head -1)"
kill -TERM "$SUP2" 2>/dev/null
kill -TERM "$SUP1" 2>/dev/null
wait "$SUP2" 2>/dev/null
wait "$SUP1" 2>/dev/null
check "the second supervisor stood by" "yes" \
  "$(grep -q 'standby: another supervisor' "$SCRATCH/home/logs/supervisor.log" 2>/dev/null && echo yes || echo no)"
check "only the lock holder launched a child" "1" "${STARTS:-0}"

echo "15. losing the port race to a peer is not a profile failure"
if command -v node >/dev/null 2>&1; then
  prepare
  printf '#!/bin/bash\necho "listen EADDRINUSE: address already in use 127.0.0.1:3999" >&2\nexit 1\n' >"$SCRATCH/eaddrinuse.sh"
  chmod +x "$SCRATCH/eaddrinuse.sh"
  node -e 'require("net").createServer().listen(3999,"127.0.0.1")' &
  LISTENER=$!
  mkdir -p "$SCRATCH/peer"
  printf '#!/bin/bash\nsleep 60\n' >"$SCRATCH/peer/bin.js"
  bash "$SCRATCH/peer/bin.js" --port 3999 &
  PEER=$!
  await 'ss -ltnH "sport = :3999" 2>/dev/null | grep -q .' 5
  DSH_WRAINROCK_DAEMON_EXEC="$SCRATCH/eaddrinuse.sh" DSH_WRAINROCK_DAEMON_HEALTHY_SECONDS=5 \
    DSH_WRAINROCK_DAEMON_SKIP_PREFLIGHT=1 DSH_WRAINROCK_DAEMON_SKIP_SAFE_PROFILE=1 DSH_WRAINROCK_DAEMON_STANDBY_POLL=1 \
    bash "$SCRATCH/supervisor.sh" >/dev/null 2>&1 &
  SUP=$!
  await 'grep -q "not counted as a profile failure" "$SCRATCH/home/logs/supervisor.log" 2>/dev/null' 20
  kill -TERM "$SUP" 2>/dev/null; wait "$SUP" 2>/dev/null
  kill -TERM "$LISTENER" "$PEER" 2>/dev/null; wait "$LISTENER" "$PEER" 2>/dev/null
  check "the port race was not counted" "yes" \
    "$(grep -q 'not counted as a profile failure' "$SCRATCH/home/logs/supervisor.log" 2>/dev/null && echo yes || echo no)"
  check "still in normal mode" "normal" "$(cat "$SCRATCH/home/state/mode" 2>/dev/null || echo normal)"
  check "failure counter untouched" "0" "$(cat "$SCRATCH/home/state/failures" 2>/dev/null || echo 0)"
else
  echo "  skip (node not on PATH)"
fi

echo "16. safe mode boots on its own port, never on the profile's port"
prepare
printf 'safe\n' >"$SCRATCH/home/state/mode"
mkdir -p "$SCRATCH/dshhome/profiles/dsh-safe"
printf '{}' >"$SCRATCH/dshhome/profiles/dsh-safe/package.json"
DSH_WRAINROCK_DAEMON_EXEC="sleep 30" DSH_WRAINROCK_DAEMON_SKIP_PREFLIGHT=1 \
  bash "$SCRATCH/supervisor.sh" >/dev/null 2>&1 &
SUP=$!
await 'grep -q "start mode=safe" "$SCRATCH/home/logs/dsh.out.log" 2>/dev/null' 15
kill -TERM "$SUP" 2>/dev/null
wait "$SUP" 2>/dev/null
SAFE_LINE="$(grep 'start mode=safe' "$SCRATCH/home/logs/dsh.out.log" 2>/dev/null | head -1)"
check "safe mode used profile dsh-safe" "yes" \
  "$(printf '%s' "$SAFE_LINE" | grep -q 'dsh-safe' && echo yes || echo no)"
check "safe mode used the dedicated safe port" "yes" \
  "$(printf '%s' "$SAFE_LINE" | grep -q -- '--port 4000' && echo yes || echo no)"
check "safe mode did not reuse the main port" "yes" \
  "$(printf '%s' "$SAFE_LINE" | grep -q -- '--port 3999' && echo no || echo yes)"

echo "17. stopping one supervisor also stops the peer from the other user manager"
prepare
DSH_WRAINROCK_DAEMON_EXEC="sleep 30" DSH_WRAINROCK_DAEMON_SKIP_PREFLIGHT=1 DSH_WRAINROCK_DAEMON_SKIP_SAFE_PROFILE=1 \
  bash "$SCRATCH/supervisor.sh" >/dev/null 2>&1 &
SUP1=$!
await 'grep -q "supervisor started" "$SCRATCH/home/logs/supervisor.log" 2>/dev/null' 15
DSH_WRAINROCK_DAEMON_EXEC="sleep 30" DSH_WRAINROCK_DAEMON_SKIP_PREFLIGHT=1 DSH_WRAINROCK_DAEMON_SKIP_SAFE_PROFILE=1 \
  DSH_WRAINROCK_DAEMON_STANDBY_POLL=1 bash "$SCRATCH/supervisor.sh" >/dev/null 2>&1 &
SUP2=$!
await 'grep -q "standby: another supervisor" "$SCRATCH/home/logs/supervisor.log" 2>/dev/null' 15
# `systemctl --user stop` only reaches the manager that owns the bus, i.e. the
# standby instance here; the serving peer has to go down by itself.
kill -TERM "$SUP2" 2>/dev/null
await_exit "$SUP1" 10
check "the serving peer stopped as well" "yes" "$(await_exit "$SUP1" 1 && echo yes || echo no)"
check "the peer stop was logged" "yes" \
  "$(grep -q 'other supervisor(s) of this install to exit' "$SCRATCH/home/logs/supervisor.log" 2>/dev/null && echo yes || echo no)"
kill -TERM "$SUP1" "$SUP2" 2>/dev/null
wait "$SUP1" 2>/dev/null; wait "$SUP2" 2>/dev/null

echo "18. the systemd-kill helper stops every supervisor and starts the unit again"
prepare
mkdir -p "$SCRATCH/fakebin" "$SCRATCH/fake-sup"
printf '#!/bin/bash\ntrap "kill $! 2>/dev/null; exit 0" TERM INT\nsleep 300 &\nwait\n' >"$SCRATCH/fake-sup/supervisor.sh"
chmod +x "$SCRATCH/fake-sup/supervisor.sh"
bash "$SCRATCH/fake-sup/supervisor.sh" >/dev/null 2>&1 &
FAKE1=$!
bash "$SCRATCH/fake-sup/supervisor.sh" >/dev/null 2>&1 &
FAKE2=$!
cat >"$SCRATCH/fakebin/systemctl" <<EOF
#!/bin/bash
printf '%s\n' "\$*" >>"$SCRATCH/systemctl.log"
case "\$*" in
  *show*) printf '{ path=/bin/bash ; argv[]=/bin/bash %s ; ignore_errors=no }\n' "$SCRATCH/fake-sup/supervisor.sh" ;;
esac
exit 0
EOF
chmod +x "$SCRATCH/fakebin/systemctl"
# The helper re-executes itself inside a transient scope before tearing the unit
# down; run the command directly here and let it report that it did so.
cat >"$SCRATCH/fakebin/systemd-run" <<'EOF'
#!/bin/bash
while [ $# -gt 0 ] && [ "${1#-}" != "$1" ]; do shift; done
exec "$@"
EOF
chmod +x "$SCRATCH/fakebin/systemd-run"
sleep 0.3
# In a real install relaunch.sh sits next to supervisor.sh (both are written into
# <home>/bin), and that sibling is what the helper trusts — parsing systemd's
# ExecStart display cannot survive a path containing a space.
cp "$PLUGIN_DIR/relaunch.sh" "$SCRATCH/fake-sup/relaunch.sh"
PATH="$SCRATCH/fakebin:$PATH" DSH_RESTART_PORT=0 DSH_RELAUNCH_LOG="$SCRATCH/relaunch.log" \
  bash "$SCRATCH/fake-sup/relaunch.sh" "$FAKE1" systemd-kill dsh-wrainrock-daemon.service "$SCRATCH" /bin/true
check "the helper exited cleanly" "0" "$?"
check "the helper escaped the unit cgroup before stopping it" "yes" \
  "$(grep -q 're-executing in a transient scope' "$SCRATCH/relaunch.log" 2>/dev/null && echo yes || echo no)"
check "the unit was started again" "yes" \
  "$(grep -q -- '--user start dsh-wrainrock-daemon.service' "$SCRATCH/systemctl.log" 2>/dev/null && echo yes || echo no)"
check "the unit was verified active" "yes" \
  "$(grep -q -- '--user is-active' "$SCRATCH/systemctl.log" 2>/dev/null && echo yes || echo no)"
check "the other supervisor was stopped too" "yes" \
  "$(await_exit "$FAKE2" 5 && echo yes || echo no)"
kill -TERM "$FAKE1" "$FAKE2" 2>/dev/null
wait "$FAKE1" 2>/dev/null; wait "$FAKE2" 2>/dev/null

echo "19. a helper without a sibling still finds the supervisor through systemd"
prepare
mkdir -p "$SCRATCH/fakebin" "$SCRATCH/lonely" "$SCRATCH/other-sup"
printf '#!/bin/bash\ntrap "exit 0" TERM INT\nsleep 300 &\nwait\n' >"$SCRATCH/other-sup/supervisor.sh"
chmod +x "$SCRATCH/other-sup/supervisor.sh"
bash "$SCRATCH/other-sup/supervisor.sh" >/dev/null 2>&1 &
FAKE3=$!
cat >"$SCRATCH/fakebin/systemctl" <<EOF
#!/bin/bash
case "\$*" in
  *show*) printf '{ path=/bin/bash ; argv[]=/bin/bash %s ; ignore_errors=no }\n' "$SCRATCH/other-sup/supervisor.sh" ;;
esac
exit 0
EOF
chmod +x "$SCRATCH/fakebin/systemctl"
printf '#!/bin/bash\nwhile [ $# -gt 0 ] && [ "${1#-}" != "$1" ]; do shift; done\nexec "$@"\n' >"$SCRATCH/fakebin/systemd-run"
chmod +x "$SCRATCH/fakebin/systemd-run"
sleep 0.3
cp "$PLUGIN_DIR/relaunch.sh" "$SCRATCH/lonely/relaunch.sh"
PATH="$SCRATCH/fakebin:$PATH" DSH_RESTART_PORT=0 \
  bash "$SCRATCH/lonely/relaunch.sh" "$FAKE3" systemd-kill dsh-wrainrock-daemon.service "$SCRATCH" /bin/true
check "the fallback helper exited cleanly" "0" "$?"
check "the fallback found the supervisor through systemd" "yes" \
  "$(await_exit "$FAKE3" 5 && echo yes || echo no)"
kill -TERM "$FAKE3" 2>/dev/null; wait "$FAKE3" 2>/dev/null

echo "20. a single-plugin crash retries the profile with that plugin temporarily disabled"
prepare
# Fails with the 2026-11-02 inspector signature until the temporary overlay
# exists; once it does, the run is healthy and the supervisor must remove it.
cat >"$SCRATCH/crash-stub.sh" <<EOF
#!/bin/bash
if [ -s "$SCRATCH/home/state/recovery-override.yml" ]; then
  sleep 2
  exit 0
fi
echo "dsh: fatal uncaught exception: Error: inspector: Host source is closed" >&2
exit 1
EOF
chmod +x "$SCRATCH/crash-stub.sh"
DSH_WRAINROCK_DAEMON_EXEC="$SCRATCH/crash-stub.sh" DSH_WRAINROCK_DAEMON_SKIP_PREFLIGHT=1 DSH_WRAINROCK_DAEMON_SKIP_SAFE_PROFILE=1 \
  bash "$SCRATCH/supervisor.sh" >/dev/null 2>&1 &
SUP=$!
await '[ -s "$SCRATCH/home/state/recovery-override.yml" ]' 30
check "a temporary overlay was written" "yes" \
  "$(grep -q 'crash override applied' "$SCRATCH/home/logs/supervisor.log" 2>/dev/null && echo yes || echo no)"
check "the overlay disables the plugin named by the crash" "yes" \
  "$(grep -q 'id: experimental-inspector' "$SCRATCH/home/state/recovery-override.yml" 2>/dev/null && echo yes || echo no)"
# The retry itself starts after the supervisor's short pause, so wait for the
# `--patch` command line to land in the child log instead of racing it.
await 'grep -q -- "--patch .*recovery-override.yml" "$SCRATCH/home/logs/dsh.out.log"' 20
check "the normal profile was retried with --patch" "yes" \
  "$(grep -q -- '--patch .*recovery-override.yml' "$SCRATCH/home/logs/dsh.out.log" 2>/dev/null && echo yes || echo no)"
check "safe mode was not needed" "no" \
  "$(grep -q safe "$SCRATCH/home/state/mode" 2>/dev/null && echo yes || echo no)"
await '[ ! -s "$SCRATCH/home/state/recovery-override.yml" ]' 30
check "the overlay was removed again after a healthy run" "yes" \
  "$(grep -q 'crash override removed (healthy run)' "$SCRATCH/home/logs/supervisor.log" 2>/dev/null && echo yes || echo no)"
kill -TERM "$SUP" 2>/dev/null; wait "$SUP" 2>/dev/null

if [ "$FAILED" = "0" ]; then
  echo "all supervisor ladder tests passed"
  rm -rf "$SCRATCH"
else
  echo "some supervisor ladder tests failed (scratch kept in $SCRATCH)"
fi
exit "$FAILED"
