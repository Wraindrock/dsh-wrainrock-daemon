#!/bin/bash
# The port tombstone, live.
#
# Two halves that only real processes can prove:
#   * a tombstone left on the abandoned port really redirects to the new entry
#   * the supervisor takes that port back when the daemon returns to it, and
#     never kills a process that a damaged state/movers.json happens to name
#
# Requires bash, node, curl. Run: bash tests/tombstone-supervisor.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
T="$ROOT/.selftest/tombstone"

if ! command -v curl >/dev/null 2>&1; then
  echo "skipped: curl is not installed"
  exit 0
fi
rm -rf "$T"; mkdir -p "$T/home/state" "$T/home/bin" "$T/home/logs" "$T/home/reports" "$T/home/backup" "$T/units" "$T/cli"

cat > "$T/stub-cli.sh" <<'STUB'
#!/bin/bash
# A stand-in for `dsh`: answers --dump-config (the preflight asks for it with the
# profile name first) and otherwise records its command line and stays alive.
case " $* " in *" --dump-config "*) exit 0 ;; esac
printf '%s\n' "$*" >> "${STUB_ARGS:-/dev/null}"
exec sleep 300
STUB
chmod 755 "$T/stub-cli.sh"

node - "$T" <<'NODE'
import { createManager } from './index.js'
const T = process.argv[2]
const ctx = { get: () => undefined, logger: { info() {}, warn() {}, error() {} } }
const manager = createManager(ctx, {
  homeDir: `${T}/home`, dshHome: `${T}/dsh`, unitDir: `${T}/units`, cliDir: `${T}/cli`,
  unitName: 'dwd-alive-nonexistent.service', installOnActivate: false, startAtBoot: false,
  enableLinger: false, notify: false, port: 3999, safePort: 4000,
  cliPath: `${T}/stub-cli.sh`, nodeBin: '/bin/bash',
})
const result = await manager.install()
console.log('install ok=' + result.ok + ' changed=' + JSON.stringify(result.changed))
NODE

SUP="$T/home/bin/supervisor.sh"
MOVERS="$T/home/state/movers.json"
LOG="$T/home/logs/supervisor.log"
ARGS="$T/home/stub-args.txt"
ok=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; ok=$((ok+1)); else echo "FAIL $1 (expected $2, got $3)"; fail=$((fail+1)); fi }
start_supervisor() { # port
  : > "$ARGS"
  STUB_ARGS="$ARGS" setsid env DSH_WRAINROCK_DAEMON_PORT="$1" DSH_WRAINROCK_DAEMON_SAFE_PORT="$(( $1 + 1 ))" \
    "$SUP" > "$T/supervisor-$1.stdout" 2>&1 &
  SUP_PID=$!
}
stop_supervisor() { kill -9 -"$SUP_PID" 2>/dev/null; wait "$SUP_PID" 2>/dev/null; }
http_code() { curl -s -o /dev/null -w '%{http_code}' -m 2 "http://127.0.0.1:$1/" 2>/dev/null; }

P=4571; Q=4572
printf '{"port":%s,"safePort":null,"at":"2026-11-07T13:00:00.000Z","by":"cli"}\n' "$Q" > "$T/home/state/runtime.json"
setsid node "$T/home/bin/mover.mjs" --from "$P" --to "$Q" --home "$T/home" >/dev/null 2>&1 &
MPID=$!
for _ in $(seq 1 40); do [ "$(http_code "$P")" = "302" ] && break; sleep 0.1; done
printf '{"movers":[{"from":%s,"pid":%s,"at":"2026-11-07T13:00:00.000Z"}]}\n' "$P" "$MPID" > "$MOVERS"
check "the tombstone redirects $P to the current port" "302" "$(http_code "$P")"

start_supervisor "$P"
for _ in $(seq 1 60); do grep -q 'port tombstone' "$LOG" 2>/dev/null && break; sleep 0.2; done
check "the supervisor gave way to the port it wants" "yes" "$(grep -q "port tombstone on $P" "$LOG" && echo yes || echo no)"
check "the tombstone process is gone" "no" "$(kill -0 "$MPID" 2>/dev/null && echo yes || echo no)"
check "the abandoned port is free again" "000" "$(http_code "$P")"
for _ in $(seq 1 60); do [ -s "$ARGS" ] && break; sleep 0.2; done
check "the launch really happened" "yes" "$(grep -q -- '--port '"$P" "$ARGS" && echo yes || echo no)"
check "and it used the port the override asked for" "yes" "$(grep -q "port override: port=$P (env)" "$LOG" && echo yes || echo no)"
stop_supervisor

# A damaged file must not get a stranger killed.
sleep 300 & BYSTANDER=$!
printf '{"movers":[{"from":%s,"pid":%s,"at":null}]}\n' "$P" "$BYSTANDER" > "$MOVERS"
BEFORE=$(wc -l < "$LOG")
start_supervisor "$P"
sleep 2
check "a stranger named by the file survives" "yes" "$(kill -0 "$BYSTANDER" 2>/dev/null && echo yes || echo no)"
check "no tombstone was claimed to be stopped" "no" "$(tail -n "+$((BEFORE + 1))" "$LOG" | grep -q 'port tombstone' && echo yes || echo no)"
stop_supervisor

# The daemon comes back to the port it left: the tombstone must not fight it.
printf '{"movers":[]}\n' > "$MOVERS"
check "nothing lingers on $P" "000" "$(http_code "$P")"

exec 2>/dev/null   # the shell announces the killed sleep(1); it is expected
kill -9 "$BYSTANDER" 2>/dev/null
pkill -9 -f "$T/home/bin/mover.mjs" 2>/dev/null
pkill -9 -f "$T/stub-cli.sh" 2>/dev/null
sleep 0.3
echo "alive: ok=$ok fail=$fail"
rm -rf "$T"
exit $(( fail > 0 ? 1 : 0 ))
