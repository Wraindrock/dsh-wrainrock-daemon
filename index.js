/**
 * @local/dsh-wrainrock-daemon — Host half.
 *
 * Gives DeepSeek Harness three things it does not ship with:
 *
 *  1. **Boot autostart.** A systemd *user* service (`dsh-wrainrock-daemon.service`) runs a
 *     generated supervisor script at login/boot. Enabling it needs no root; for
 *     it to start without an interactive login the user must linger, which this
 *     plugin also arranges (`loginctl enable-linger`).
 *  2. **Crash / corruption self-recovery.** The supervisor validates the composed
 *     profile config before every start (restoring the last known-good snapshot
 *     when it is broken), measures how long each run stayed up, and counts rapid
 *     failures in a rolling window. After `failureThreshold` of them it boots the
 *     pristine safe profile, writes an incident report and notifies the desktop.
 *     systemd adds a second layer: if the supervisor itself keeps dying, the
 *     unit's `OnFailure=` starts `dsh-wrainrock-daemon-safemode.service`.
 *  3. **A manual restart button.** The Client half renders "重启" in the composer
 *     dock and calls this half over HTTP.
 *
 * Everything is plain JavaScript over node builtins: the bundle declares no
 * dependency, so it activates in any profile that installs it.
 *
 * Host entry points (`POST`/`GET /dsh-wrainrock-daemon/...`):
 *   GET  status      full state snapshot (systemd, supervisor, incident, paths)
 *   POST restart     restart now (systemd when managed, detached relaunch else)
 *   POST install     (re)write the supervisor/units, daemon-reload, enable
 *   POST uninstall   disable and remove the units (reports are kept)
 *   POST repair      run the config integrity check/restore immediately
 *   POST reset       clear safe mode (+ optional restart)
 *   POST selftest    prove this session can start/stop a systemd unit
 *   GET  log         text tail of the supervisor log
 *   GET  port        the live port and the requested next-start port
 *   POST port        request the next-start port (optionally restart now)
 *   GET  url         the authenticated url and the stable entry url
 *   GET  enter       exchange this process's token for a cookie, then land on /
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, readlinkSync, lstatSync, unlinkSync, copyFileSync, cpSync, renameSync, statSync, openSync, readSync, closeSync, chmodSync, realpathSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir, userInfo } from 'node:os'
import { spawn, execFileSync } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url))
const PKG_NAME = '@local/dsh-wrainrock-daemon'
const ROUTE_PREFIX = '/dsh-wrainrock-daemon'

const SYSTEMD_DEST = 'org.freedesktop.systemd1'
const MANAGER_PATH = '/org/freedesktop/systemd1'
const MANAGER_IFACE = 'org.freedesktop.systemd1.Manager'
const UNIT_IFACE = 'org.freedesktop.systemd1.Unit'

/** `systemctl --user` is unusable in namespaced/restricted sessions; the same manager answers on D-Bus. */
const BUS_UNREACHABLE = /Failed to connect|Cannot autolaunch|Failed to talk to init daemon|Connection refused|No such file or directory|没有可用的数据|无法连接|拒绝连接/i

/**
 * Every generated file carries one of these markers. The names this project used
 * before are kept so a rename never mistakes its own earlier files for a foreign
 * unit it must not touch — and so those earlier units can be retired on install
 * (see migrateLegacy).
 */
const GENERATED_MARKERS = [
  '@local/dsh-wrainrock-daemon',
  '@local/dsh-ian-daemon',
  '@local/dsh-autostart',
]

/** Filesystem copies that make a profile composable; they are what "corruption" means here. */
const CONFIG_FILES = ['cordis.yml', 'cordis.patch.yml', 'package.json', 'pnpm-workspace.yaml']

// ---------------------------------------------------------------------------
// generic helpers
// ---------------------------------------------------------------------------

/** Run a command, capturing output; never rejects. */
function run(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 15000
  const env = options.env ?? process.env
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env })
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: String(error?.message ?? error), failed: true })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      finish({ code: -2, stdout, stderr: `${stderr}\n[timeout after ${timeoutMs}ms]`, failed: true })
    }, timeoutMs)
    child.stdout?.on('data', (chunk) => { stdout += chunk })
    child.stderr?.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => finish({ code: -1, stdout, stderr: String(error?.message ?? error), failed: true }))
    child.on('close', (code) => finish({ code: code ?? -1, stdout, stderr, failed: false }))
  })
}

function readText(path, fallback = undefined) {
  try { return readFileSync(path, 'utf8') } catch { return fallback }
}

function writeIfChanged(path, content, mode) {
  const current = readText(path)
  if (current === content) return false
  mkdirSync(dirname(path), { recursive: true })
  // Atomic replace. A running supervisor reads this script lazily, so truncating
  // it in place (say, to deploy a new one while the old one still runs) can make
  // bash execute a half-written file; a rename swaps the inode instead.
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, content, 'utf8')
  if (mode !== undefined) {
    try { chmodSync(tmp, mode) } catch { /* best effort on odd filesystems */ }
  }
  try {
    renameSync(tmp, path)
  } catch (error) {
    try { rmSync(tmp, { force: true }) } catch { /* nothing else to clean up */ }
    throw error
  }
  return true
}

function ensureDir(path) {
  try { mkdirSync(path, { recursive: true }) } catch { /* reported by the caller's next write */ }
}

// --- the requested port ------------------------------------------------------
//
// "Which port does it listen on?" has two answers that must not be confused:
// the one serving right now, and the one the next start will use. The second is
// a request, not a setting: it is kept next to the rest of the runtime state
// (`state/port.json`) so the generated supervisor can honour it without being
// rewritten, and so a port that turns out to be wrong can be changed by hand
// while the daemon is down.

/**
 * A user-supplied port, or 0 for "not a port at all".
 *
 * `0` is deliberately not accepted: it already means "let dsh pick one" in the
 * config, so treating it as an override would silently pin nothing.
 */
export function parsePortValue(value) {
  if (value === null || value === undefined) return 0
  if (typeof value === 'number' && !Number.isInteger(value)) return 0
  const text = String(value).trim()
  if (!/^[0-9]{1,5}$/.test(text)) return 0
  const port = Number(text)
  return port >= 1 && port <= 65535 ? port : 0
}

/** Where the next-start port request lives. */
export function portOverridePath(paths) {
  return join(paths.stateDir, 'port.json')
}

/**
 * Read the next-start port request.
 *
 * Anything unreadable is the same as absent — a truncated or hand-edited file
 * must never stop the daemon from starting on the configured port.
 *
 * @returns `{ port, safePort, at, by }` or `null`.
 */
export function readPortOverride(paths, options = {}) {
  const file = options.file ?? portOverridePath(paths)
  const raw = readText(file)
  if (raw === undefined) return null
  let parsed
  try { parsed = JSON.parse(raw) } catch { return null }
  if (parsed === null || typeof parsed !== 'object') return null
  const port = parsePortValue(parsed.port)
  if (port === 0) return null
  const safe = parsePortValue(parsed.safePort)
  return {
    port,
    safePort: safe > 0 ? safe : null,
    at: typeof parsed.at === 'string' ? parsed.at : undefined,
    by: parsed.by === 'cli' || parsed.by === 'ui' ? parsed.by : undefined,
    file,
  }
}

/**
 * The single shape both `/port` and `/status.port` expose, so the page, the CLI
 * and the docs never have to agree on two vocabularies.
 *
 * `current` is what answers requests now, `next` is what the next start will
 * use, and `pending` means "restart to apply". `override` says a request file
 * exists even when it happens to name the port already in use.
 */
export function portSnapshot({ livePort = 0, port = 0, safePort = 0, override = null } = {}) {
  const live = parsePortValue(livePort)
  const configured = parsePortValue(port)
  const requested = override ? parsePortValue(override.port) : 0
  const requestedSafe = override ? parsePortValue(override.safePort) : 0
  const configuredSafe = parsePortValue(safePort)

  const current = live > 0 ? live : configured
  const next = requested > 0 ? requested : configured
  const source = live > 0 ? 'live' : requested > 0 ? 'override' : 'config'
  // Safe mode sits one above whichever port the next start will actually use —
  // including the live one when nothing is configured, which is exactly what
  // resolvedSafePort() does for the generated supervisor.
  const base = next > 0 ? next : current
  const nextSafe = requested > 0
    ? (requestedSafe > 0 ? requestedSafe : base > 0 ? base + 1 : 0)
    : (configuredSafe > 0 ? configuredSafe : base > 0 ? base + 1 : 0)

  return {
    current,
    source,
    next,
    nextSafe,
    // Kept as its own key for readers that only care about safe mode; it is the
    // port the NEXT start uses, never the one running now.
    safePort: nextSafe,
    override: requested > 0,
    pending: requested > 0 && requested !== current,
    requestedAt: override?.at,
    requestedBy: override?.by,
  }
}

// ---------------------------------------------------------------------------
// browser entry: a stable URL that logs the browser in
// ---------------------------------------------------------------------------

/**
 * Why this exists.
 *
 * The web surface authenticates a browser once, with a token minted per process
 * and exchanged for a cookie whose NAME is derived from the authority
 * (host:port). Two consequences follow, and both are visible to a user:
 *
 *  - the URL `dsh web` prints cannot be bookmarked across a restart, because a
 *    new process means a new token;
 *  - after a port change the old cookie is dead, so the plain origin answers
 *    401 until the user finds a token URL again.
 *
 * So the daemon publishes one stable URL of its own — `GET <prefix>/enter` —
 * and performs the token exchange server-side: it asks the local listener for a
 * fresh token URL, keeps the cookie, and hands it to the browser. The address
 * bar then holds a URL with no token in it that only changes when the port does.
 *
 * That route is the one place where a proxied request must not be trusted by
 * default, hence `enterMode`:
 *   loopback  answer only requests that arrived directly on the loopback socket
 *   key       also require `?k=<entryKey>` — what a tunnel needs
 *   open      no check at all (put Cloudflare Access, or a private network, in front)
 */

/** A key only counts when it is long and made of URL-safe characters. */
const ENTRY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,}$/

/** Headers that betray a proxy or tunnel even when the socket itself is local. */
const FORWARDED_HEADERS = ['x-forwarded-for', 'x-real-ip', 'cf-connecting-ip', 'forwarded']

/** Where the generated entry key lives. */
export function entryStatePath(paths) {
  return join(paths.stateDir, 'entry.json')
}

/** A fresh entry key: 32 random bytes, base64url. */
function newEntryKey() {
  return randomBytes(32).toString('base64url')
}

/**
 * The stored entry key, or '' when there is none.
 *
 * The value is re-validated on read: a hand-edited file must not be able to
 * smuggle anything into a URL this plugin prints or serves.
 */
export function entryKeyOf(paths, options = {}) {
  const file = options.file ?? entryStatePath(paths)
  const raw = readText(file)
  if (raw === undefined || raw === '') return ''
  let record
  try { record = JSON.parse(raw) } catch { return '' }
  if (record === null || typeof record !== 'object') return ''
  const key = typeof record.key === 'string' ? record.key : ''
  return ENTRY_KEY_PATTERN.test(key) ? key : ''
}

/** True when the request arrived straight from this machine, with no proxy talk. */
export function peerIsDirectLoopback(req) {
  const address = typeof req?.socket?.remoteAddress === 'string' ? req.socket.remoteAddress : ''
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const headers = req?.headers ?? {}
  for (const name of FORWARDED_HEADERS) {
    const value = headers[name]
    if (value !== undefined && String(value).trim() !== '') return false
  }
  return true
}

/**
 * Decide whether a request may use the entry route.
 *
 * `req` may be left out by an internal caller (a test, the CLI's own path):
 * only the HTTP surface has a socket to judge, so the caller opts out of the
 * peer check by not passing one.
 */
export function entryGate({ mode = 'loopback', key = '', req, url } = {}) {
  const normalized = mode === 'key' || mode === 'open' ? mode : 'loopback'
  if (normalized === 'open') return { ok: true, mode: normalized }
  if (normalized === 'key') {
    if (key === '') return { ok: false, mode: normalized, status: 403, reason: 'key-missing' }
    const match = /[?&]k=([^&#]*)/.exec(String(url ?? req?.url ?? ''))
    let given = ''
    if (match !== null) {
      try { given = decodeURIComponent(match[1]) } catch { given = match[1] }
    }
    if (given !== key) return { ok: false, mode: normalized, status: 403, reason: 'key-invalid' }
    return { ok: true, mode: normalized }
  }
  if (!peerIsDirectLoopback(req)) return { ok: false, mode: normalized, status: 403, reason: 'not-loopback' }
  return { ok: true, mode: normalized }
}

/** The stable entry URL — with `?k=` when the key mode is in force. */
export function buildEntryUrl(origin, { mode = 'loopback', key = '', prefix = ROUTE_PREFIX } = {}) {
  const base = String(origin ?? '').replace(/\/+$/, '')
  const path = `${String(prefix ?? '').replace(/\/+$/, '')}/enter`
  const url = `${base}${path}`
  if (mode !== 'key' || key === '') return url
  return `${url}?k=${encodeURIComponent(key)}`
}

// --- port tombstones ---------------------------------------------------------

/**
 * Where the abandoned ports are recorded.
 *
 * A port change kills the old origin, and a bookmark or an open tab on it says
 * nothing about where the daemon went. The host half therefore leaves one tiny
 * `mover.mjs` on every port it leaves behind; these helpers decide which of
 * them are still wanted. The planning is pure so it can be tested without
 * starting anything.
 */
export function moverRecordPath(paths) {
  return join(paths.stateDir, 'movers.json')
}

/** The recorded tombstones, with anything malformed dropped rather than thrown. */
export function readMoverRecords(paths, options = {}) {
  const file = options.file ?? moverRecordPath(paths)
  const raw = readText(file)
  if (raw === undefined || raw.trim() === '') return []
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.movers) ? parsed.movers : []
  const records = []
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object') continue
    const from = parsePortValue(entry.from)
    const pid = Number.isInteger(entry.pid) ? entry.pid : Number.parseInt(String(entry.pid ?? ''), 10)
    if (from === 0 || !Number.isInteger(pid) || pid <= 0) continue
    records.push({ from, pid, at: typeof entry.at === 'string' ? entry.at : '' })
  }
  return records
}

/**
 * Which tombstones to keep, which to drop, and which port to cover next.
 *
 * `previousPort` is the port this daemon used last time (state/last-port.json):
 * it is the one somebody's browser is still pointing at, so it gets a tombstone
 * unless it is the port we are on now or one is already there.
 */
export function planMovers({ records = [], previousPort = 0, currentPort = 0, enabled = true } = {}) {
  const list = Array.isArray(records) ? records : []
  if (enabled !== true) {
    return { kill: list.map((record) => record.pid), spawn: [], keep: [] }
  }
  const current = parsePortValue(currentPort)
  const previous = parsePortValue(previousPort)
  const kill = []
  const keep = []
  const kept = new Set()
  for (const record of list) {
    const from = parsePortValue(record?.from)
    const pid = Number.isInteger(record?.pid) ? record.pid : 0
    if (pid <= 0) continue
    if (from === 0 || from === current || kept.has(from)) {
      kill.push(pid)
      continue
    }
    kept.add(from)
    keep.push({ from, pid })
  }
  const spawn = []
  if (previous > 0 && previous !== current && !kept.has(previous)) spawn.push(previous)
  return { kill, spawn, keep }
}

/** Replace `@@TOKEN@@` placeholders in a shipped template. */
function render(template, values) {
  return template.replace(/@@([A-Z_]+)@@/g, (match, key) => {
    const value = values[key]
    if (value === undefined) return match
    return String(value).replace(/[\r\n]+/g, ' ')
  })
}

/**
 * Quote one word for a systemd unit file.
 *
 * systemd splits an unquoted `ExecStart=` / `Environment=` value on whitespace,
 * so a home directory that contains a space silently becomes two words: the real
 * 2026-10-31 incident had `$HOME=/var/home/u/Distrobox/deepseek harness`, where
 * `ExecStart=/bin/bash /var/home/u/Distrobox/deepseek harness/.dsh/...` ran
 * `/bin/bash /var/home/u/Distrobox/deepseek`, and the unit died with status 127
 * before the supervisor was ever reached. Double quotes group the word; a
 * backslash or a double quote inside it has to be escaped.
 */
export function unitWord(value) {
  return `"${String(value).replace(/\\/g, () => '\\\\').replace(/"/g, () => '\\"')}"`
}

/**
 * Quote one `ExecStart=` argument. On top of plain word quoting, systemd expands
 * `%` specifiers and `$VAR` references in every argument after the executable,
 * so a literal `%` or `$` in a path must be doubled to survive.
 *
 * (`Environment=` values are *not* specifier-expanded, so they only need
 * `unitWord` — doubling a `%` there would store it literally.)
 */
export function unitExecArg(value) {
  return unitWord(String(value).replace(/%/g, () => '%%').replace(/\$/g, () => '$$'))
}

/** Render the shipped unit templates. Exported so tests can assert the quoting. */
export function renderUnits(values) {
  return {
    main: render(template('units/dsh-wrainrock-daemon.service.in'), values),
    safe: render(template('units/dsh-wrainrock-daemon-safemode.service.in'), values),
  }
}

function template(name) {
  const path = join(PACKAGE_DIR, name)
  const text = readText(path)
  if (text === undefined) throw new Error(`${PKG_NAME}: shipped template is missing: ${path}`)
  return text
}

function expandHome(value, home) {
  const text = String(value)
  if (text === '~') return home
  if (text.startsWith('~/')) return join(home, text.slice(2))
  return text
}

function asString(value, fallback) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

function asNumber(value, fallback) {
  const number = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(number) && number >= 0 ? number : fallback
}

function asBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/** `/proc/self/cgroup` names the unit that owns this process, when systemd owns it. */
function selfCgroup() {
  try { return readFileSync('/proc/self/cgroup', 'utf8') } catch { return '' }
}

let cachedContainerKind

/**
 * What kind of container this machine is ('' / 'none' on a real host).
 *
 * A distrobox/podman setup has *two* systemd user managers for the same uid —
 * the host's and the container's — and both read the same
 * `~/.config/systemd/user`. That is the normal layout, not a broken setting:
 * `systemctl --user` inside the container only ever reaches the container's
 * manager, so a unit that both managers start leaves an instance the plugin
 * cannot see (and the 2026-11-02 restart dead-end came from exactly that).
 * The units are therefore pinned to the container when one is detected.
 */
export function containerKind() {
  if (cachedContainerKind !== undefined) return cachedContainerKind
  try {
    const out = execFileSync('systemd-detect-virt', ['--container'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    cachedContainerKind = out === '' ? 'none' : out
  } catch {
    cachedContainerKind = 'none'
  }
  return cachedContainerKind
}

/**
 * What to say about more than one systemd user manager for this account.
 * Pure so the wording can be tested: the host+container split must not be
 * reported as something to "clean up".
 */
export function managerAdvice({ ids = [], container = 'none', unitName = 'dsh-wrainrock-daemon.service', port = 0, containerOnly = false } = {}) {
  if (ids.length <= 1) return undefined
  const list = ids.join(', ')
  if (container !== 'none') {
    const pin = containerOnly
      ? `The unit is pinned to the container (ConditionVirtualization=container), so the host's manager skips it; `
      : `Both managers see the same enabled unit, so both may start a supervisor; `
    return `${ids.length} systemd user managers exist for this account (${list}): the host and the ${container} container each run one. That is the normal distrobox/podman layout, not a misconfiguration to clean up. ${pin}the supervisor lock and the peer-port guard make the second instance wait instead of fighting it.`
  }
  return `${ids.length} systemd user managers exist for this account (${list}). Each one starts ${unitName}, so they race for port ${port}; the supervisor lock and the peer-port guard prevent a false safe mode, but stopping the extra manager is still worth doing.`
}

/**
 * Locate the `dsh` entry script to bake into the generated unit.
 *
 * The launcher is often a shim (`dsh`, or an fnm multishell symlink under
 * `/run/user/...`) whose target is what survives a reboot, so symlinks are
 * resolved first; a plain path is accepted when nothing resolved to `bin.js`.
 * Exported because this is the one piece of the plugin that depends on how the
 * running Harness was launched, and it is worth unit-testing.
 *
 * @param {string[]} argv - a `process.argv`-shaped array.
 * @param {string} [explicitPath] - the configured `cliPath`, used first and as the last resort.
 * @returns {string} an existing path, or the explicit value when nothing resolved.
 */
export function resolveDshCli(argv, explicitPath = '') {
  if (typeof explicitPath === 'string' && explicitPath !== '' && existsSync(explicitPath)) return explicitPath
  const resolved = []
  for (const candidate of (Array.isArray(argv) ? argv : []).slice(1)) {
    if (typeof candidate !== 'string' || candidate === '' || !candidate.includes('/')) continue
    try { resolved.push(realpathSync(candidate)) } catch { resolved.push(candidate) }
  }
  for (const candidate of resolved) {
    if (/(^|[/\\])bin\.js$/.test(candidate) && existsSync(candidate)) return candidate
  }
  for (const candidate of resolved) {
    if (/(^|[/\\])(dsh|dsh\.js)$/.test(candidate) && existsSync(candidate)) return candidate
  }
  return typeof explicitPath === 'string' ? explicitPath : ''
}

/**
 * Pure policy for the "重启" action, exported so the tests can drive the exact
 * decision that used to fail silently.
 *
 * `systemctl --user` talks to exactly one systemd user manager. When an account
 * has two of them (user@1000.service and user@ian.service both start the unit),
 * the unit's MainPID belongs to the *other* manager: a plain restart restarts
 * the idle standby instance, the serving process keeps the port, and the panel
 * reports "ok" while nothing restarts. In that case the helper has to stop the
 * supervisors itself and start the unit again.
 *
 * @param {{managed:boolean, enabled:boolean, unitMainPid:number, supervisorPid:number}} input
 * @returns {{action:'systemd'|'systemd-kill'|'systemd-handoff'|'relaunch', reason?:string}}
 */
export function decideRestartPlan({ managed, enabled, unitMainPid, supervisorPid }) {
  const main = Number(unitMainPid)
  const sup = Number(supervisorPid)
  if (managed) {
    if (Number.isFinite(main) && main > 0 && Number.isFinite(sup) && sup > 0 && main !== sup) {
      return {
        action: 'systemd-kill',
        reason: 'the unit runs under another systemd user manager: a plain restart would only restart the idle standby instance',
      }
    }
    return { action: 'systemd' }
  }
  if (enabled) return { action: 'systemd-handoff' }
  return { action: 'relaunch' }
}

function tailFile(path, lines, maxBytes = 128 * 1024) {
  try {
    const size = statSync(path).size
    const length = Math.min(size, maxBytes)
    const buffer = Buffer.alloc(length)
    const fd = openSync(path, 'r')
    try { readSync(fd, buffer, 0, length, size - length) } finally { closeSync(fd) }
    const text = buffer.toString('utf8')
    const parts = text.split('\n')
    return parts.slice(Math.max(0, parts.length - lines - 1)).join('\n')
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// systemd access: `systemctl --user` first, D-Bus (`busctl --user`) as fallback
// ---------------------------------------------------------------------------

/**
 * Run `systemctl --user ...`; resolves to `null` when the tool exists but the
 * user manager cannot be reached over the local transport, which is the signal
 * to retry the same operation on D-Bus.
 */
async function systemctl(args) {
  const result = await run('systemctl', ['--user', ...args])
  if (result.failed || BUS_UNREACHABLE.test(result.stderr)) return null
  return result
}

/** `busctl --user call <manager> <method> [signature args...]`. */
async function managerCall(method, signature = '', args = []) {
  const argv = ['--user', 'call', SYSTEMD_DEST, MANAGER_PATH, MANAGER_IFACE, method]
  if (signature !== '') argv.push(signature, ...args)
  return await run('busctl', argv)
}

async function busProperty(objectPath, iface, property) {
  return await run('busctl', ['--user', 'get-property', SYSTEMD_DEST, objectPath, iface, property])
}

/** Pull the first `"quoted"` value (string or object path) out of busctl output. */
function busString(text) {
  const match = /"([^"]*)"/.exec(String(text ?? ''))
  return match === null ? undefined : match[1]
}

function busBoolean(text) {
  const match = /\b(true|false|yes|no)\b/.exec(String(text ?? ''))
  return match === null ? undefined : match[1] === 'true' || match[1] === 'yes'
}

/** Unit object path on the manager (`dsh-wrainrock-daemon.service` → `/org/.../unit/dsh_2dharness_2eservice`). */
async function unitObjectPath(unit) {
  const reply = await managerCall('GetUnit', 's', [unit])
  if (reply.code !== 0) return undefined
  return busString(reply.stdout)
}

// ---------------------------------------------------------------------------
// manager
// ---------------------------------------------------------------------------

export function createManager(ctx, rawConfig) {
  const config = rawConfig && typeof rawConfig === 'object' ? rawConfig : {}
  const home = homedir()
  const dshHome = expandHome(asString(config.dshHome, process.env.DSH_HOME || join(home, '.dsh')), home)
  const homeDir = expandHome(asString(config.homeDir, ''), home) || join(dshHome, 'wrainrock-daemon')
  const userName = (() => { try { return userInfo().username } catch { return process.env.USER || '' } })()

  const settings = {
    unitName: asString(config.unitName, 'dsh-wrainrock-daemon.service'),
    safeUnitName: asString(config.safeUnitName, 'dsh-wrainrock-daemon-safemode.service'),
    selfTestUnit: asString(config.selfTestUnit, 'dsh-wrainrock-daemon-selftest.service'),
    profile: asString(config.profile, process.env.DSH_PROFILE || 'web'),
    safeProfile: asString(config.safeProfile, 'dsh-safe'),
    safeTemplate: asString(config.safeTemplate, process.env.DSH_PROFILE || 'web'),
    unitDir: expandHome(asString(config.unitDir, join(home, '.config', 'systemd', 'user')), home),
    port: asNumber(config.port, 0),
    // Safe mode listens on its own port by default (port+1 when the main port is
    // known): the old layout reused the main port, so a safe boot could not come
    // up while a peer still held it — the dead-lock behind the 2026-10-15 incident.
    safePort: asNumber(config.safePort, 0),
    portGuard: asBoolean(config.portGuard, true),
    host: asString(config.host, ''),
    extraAppArgs: Array.isArray(config.extraAppArgs) ? config.extraAppArgs.map(String) : [],
    failureWindowSeconds: asNumber(config.failureWindowSeconds, 600),
    failureThreshold: Math.max(2, asNumber(config.failureThreshold, 3)),
    healthySeconds: asNumber(config.healthySeconds, 120),
    maxBackoffSeconds: asNumber(config.maxBackoffSeconds, 120),
    installOnActivate: asBoolean(config.installOnActivate, true),
    // When a crash names one plugin, retry the normal profile once with just
    // that plugin temporarily disabled (a `--patch` overlay in the state dir,
    // removed again after a healthy boot) instead of falling straight to safe
    // mode and dropping the whole plugin set.
    crashDisable: asBoolean(config.crashDisable, true),
    // In a distrobox/podman setup the host's and the container's user managers
    // both read this unit file. Pinning it to the container leaves exactly one
    // instance, and that instance is the one `systemctl --user` here can reach.
    containerOnly: asBoolean(config.containerOnly, containerKind() !== 'none'),
    startAtBoot: asBoolean(config.startAtBoot, true),
    enableLinger: asBoolean(config.enableLinger, true),
    notify: asBoolean(config.notify, true),
    nodeBin: asString(config.nodeBin, process.execPath),
    cliPath: expandHome(asString(config.cliPath, ''), home),
    // Where the `dwd` shim is linked so a plain shell can find it. `$HOME/bin`
    // is first on PATH on the machines this was built for; an explicit empty
    // value falls back to it, and a symlink is never written over a real file.
    cliDir: expandHome(asString(config.cliDir, ''), home),
    // Who may use the stable entry route (GET <prefix>/enter): "loopback"
    // answers only a direct local request, "key" additionally requires
    // ?k=<entryKey> and is what a tunnel needs, "open" drops both checks.
    enterMode: (() => {
      const value = asString(config.enterMode, 'loopback')
      return value === 'key' || value === 'open' ? value : 'loopback'
    })(),
    // Explicit key; when empty, key mode generates one into state/entry.json.
    entryKey: asString(config.entryKey, ''),
    // Leave a redirect on a port this daemon abandons, so a tab or a bookmark
    // pointing at the old port is carried to the new one instead of dying.
    moverOnPortChange: asBoolean(config.moverOnPortChange, true),
    // Names this project used before it was called dsh-wrainrock-daemon. An
    // install made under any of them migrates itself on the first install()
    // (see migrateLegacy), so upgrading machines need no manual step.
    legacyUnitNames: Array.isArray(config.legacyUnitNames)
      ? config.legacyUnitNames.map(String)
      : [
          'dsh-ian-daemon.service',
          'dsh-ian-daemon-safemode.service',
          'dsh-ian-daemon-selftest.service',
          'dsh-harness.service',
          'dsh-harness-safemode.service',
          'dsh-autostart-selftest.service',
        ],
    // Newest former name first, and `config.legacyHomeDir` (singular) still wins
    // as an explicit override. Only the first directory that exists is carried
    // over, and only while the current home directory does not exist yet.
    legacyHomeDirs: (Array.isArray(config.legacyHomeDirs)
      ? config.legacyHomeDirs.map(String)
      : [asString(config.legacyHomeDir, ''), join(dshHome, 'ian-daemon'), join(dshHome, 'autostart')]
    ).map((value) => expandHome(value, home)).filter((value) => value !== '' && value !== homeDir),
  }

  const paths = {
    homeDir,
    binDir: join(homeDir, 'bin'),
    supervisor: join(homeDir, 'bin', 'supervisor.sh'),
    relaunch: join(homeDir, 'bin', 'relaunch.sh'),
    cli: join(homeDir, 'bin', 'dwd'),
    mover: join(homeDir, 'bin', 'mover.mjs'),
    entry: join(homeDir, 'state', 'entry.json'),
    lastPort: join(homeDir, 'state', 'last-port.json'),
    stateDir: join(homeDir, 'state'),
    reportDir: join(homeDir, 'reports'),
    logDir: join(homeDir, 'logs'),
    backupDir: join(homeDir, 'backup'),
    supervisorLog: join(homeDir, 'logs', 'supervisor.log'),
    dshLog: join(homeDir, 'logs', 'dsh.out.log'),
    profileDir: join(dshHome, 'profiles', settings.profile),
  }

  /** Resolved by the launcher only after the whole tree mounted: the shell's
   * `/api` route is registered after that, so a reload before it cannot connect. */
  let readiness = { ready: false, at: undefined }

  function watchReadiness() {
    const service = typeof ctx.get === 'function' ? ctx.get('appReady') : undefined
    if (service === undefined || typeof service.onReady !== 'function') {
      readiness = { ready: true, at: new Date().toISOString(), absent: true }
      return
    }
    try {
      service.onReady(() => { readiness = { ready: true, at: new Date().toISOString() } })
    } catch (error) {
      readiness = { ready: true, at: new Date().toISOString(), error: String(error?.message ?? error) }
    }
  }

  const logger = ctx.logger ?? console
  let activated = false
  let disposed = false
  let livePort = 0
  let cachedBackend

  function info(message) {
    try { logger.info?.(`${PKG_NAME}: ${message}`) } catch { /* logging must never break the plugin */ }
  }

  function warn(message) {
    try { logger.warn?.(`${PKG_NAME}: ${message}`) } catch { /* ignore */ }
  }

  // --- command lines -------------------------------------------------------

  function resolveCliPath() {
    // The launcher may be a shim (`dsh`) symlinking to lib/bin.js, and an fnm
    // multishell symlink disappears with its shell: resolve the real target.
    return resolveDshCli(process.argv, settings.cliPath)
  }

  /** The port this instance actually serves; 0 means "let dsh pick one". */
  function resolvedPort() {
    const port = livePort || settings.port
    return Number.isFinite(port) && port > 0 ? port : 0
  }

  /** Safe mode must be able to start even while a peer still holds the main port. */
  function resolvedSafePort() {
    const configured = Number.isFinite(settings.safePort) && settings.safePort > 0 ? settings.safePort : 0
    if (configured > 0) return configured
    const port = resolvedPort()
    return port > 0 ? port + 1 : 0
  }

  /** The next-start port request as it was stored, or null. */
  function portOverride() { return readPortOverride(paths) }

  /**
   * The one shape `/port` and `/status` expose (see portSnapshot).
   *
   * "next" is what a freshly generated supervisor would carry, which is exactly
   * resolvedPort(): the live port when nothing is configured, because install()
   * bakes the live port. Passing settings.port here instead would report 0
   * ("let dsh pick") on a machine whose supervisor is in fact pinned to 3080.
   */
  function portState() {
    return portSnapshot({
      livePort,
      port: resolvedPort(),
      safePort: resolvedSafePort(),
      override: portOverride(),
    })
  }

  /**
   * Record the port the NEXT start should use.
   *
   * This writes a file rather than a setting: the generated supervisor reads it
   * on its way up, so the request works while the daemon is down, applies to a
   * restart nobody here performed, and can be undone by deleting one file.
   */
  function setNextPort(next, { safePort = null, by = 'ui' } = {}) {
    const port = parsePortValue(next)
    if (port === 0) {
      return { ok: false, error: 'invalid-port', message: `not a port: ${String(next).slice(0, 24)}; expected an integer 1..65535` }
    }
    const safeRaw = safePort === null || safePort === undefined ? '' : String(safePort).trim()
    const safe = parsePortValue(safeRaw)
    if (safeRaw !== '' && safe === 0) {
      return { ok: false, error: 'invalid-safe-port', message: `not a port: ${safeRaw.slice(0, 24)}; expected an integer 1..65535`, value: safeRaw }
    }
    const record = { port, safePort: safe > 0 ? safe : null, at: new Date().toISOString(), by: by === 'cli' ? 'cli' : 'ui' }
    const changed = []
    try {
      ensureDir(paths.stateDir)
      if (writeIfChanged(portOverridePath(paths), `${JSON.stringify(record, null, 2)}\n`, 0o644)) changed.push('port.json')
    } catch (error) {
      return { ok: false, error: 'write-failed', message: `cannot write ${portOverridePath(paths)}: ${error?.message ?? error}` }
    }
    recordEvent('host', 'port:set', { port, safePort: record.safePort, by: record.by })
    writeRuntime()
    info(`next start port: ${port}${record.safePort === null ? '' : ` (safe ${record.safePort})`} requested by ${record.by}`)
    return { ok: true, changed, record }
  }

  /**
   * Describe the running instance for the `dwd` CLI, so it can reach this port
   * without guessing, scanning `ps`, or parsing the supervisor log.
   */
  function writeRuntime() {
    try {
      const state = portState()
      ensureDir(paths.stateDir)
      const record = {
        pid: process.pid,
        port: state.current,
        safePort: state.nextSafe,
        unit: settings.unitName,
        profile: settings.profile,
        at: new Date().toISOString(),
      }
      writeFileSync(join(paths.stateDir, 'runtime.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    } catch { /* the CLI falls back to systemd when this is missing */ }
  }

  // --- the port we came from ------------------------------------------------

  /** The port this daemon ran on last time, or null when that is not known. */
  function readLastPort() {
    const raw = readText(paths.lastPort)
    if (raw === undefined || raw.trim() === '') return null
    try {
      const parsed = JSON.parse(raw)
      const port = parsePortValue(parsed?.port)
      if (port === 0) return null
      return { port, at: typeof parsed.at === 'string' ? parsed.at : '' }
    } catch {
      return null
    }
  }

  function writeLastPort(port) {
    try {
      ensureDir(paths.stateDir)
      writeFileSync(paths.lastPort, `${JSON.stringify({ port, at: new Date().toISOString() }, null, 2)}\n`, 'utf8')
    } catch { /* the next start simply does not know where it came from */ }
  }

  /**
   * Whether this pid is one of our tombstones.
   *
   * `state/movers.json` is a plain file in a state directory, so it can hold a
   * pid that was never ours: the script name in `/proc/<pid>/cmdline` is the
   * only thing that makes killing it safe. Everything here errs towards "no".
   */
  function moverAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0 || pid > 4194304) return false
    try {
      process.kill(pid, 0)
    } catch (error) {
      if (error?.code !== 'EPERM') return false
    }
    try {
      return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('mover.mjs')
    } catch {
      return false
    }
  }

  function writeMoverRecords(list) {
    try {
      ensureDir(paths.stateDir)
      writeIfChanged(moverRecordPath(paths), `${JSON.stringify({ movers: list }, null, 2)}\n`, 0o644)
    } catch (error) {
      warn(`could not record the port tombstones: ${error?.message ?? error}`)
    }
  }

  function stopMover(pid) {
    try {
      process.kill(pid, 'SIGTERM')
      return true
    } catch {
      return false
    }
  }

  function startMover(from, to) {
    try {
      ensureDir(paths.binDir)
      // install() writes this too; a machine with installOnActivate=false has
      // still earned a working tombstone.
      writeIfChanged(paths.mover, template('mover.mjs'), 0o644)
      const child = spawn(
        nodeBin(),
        [paths.mover, '--from', String(from), '--to', String(to), '--home', homeDir, '--prefix', ROUTE_PREFIX],
        { detached: true, stdio: 'ignore' },
      )
      child.unref()
      return Number.isInteger(child.pid) ? child.pid : 0
    } catch (error) {
      warn(`could not leave a redirect on port ${from}: ${error?.message ?? error}`)
      return 0
    }
  }

  function stopAllMovers(reason) {
    const records = readMoverRecords(paths).filter((record) => moverAlive(record.pid))
    let stopped = 0
    for (const record of records) if (stopMover(record.pid)) stopped += 1
    if (records.length > 0 || readText(moverRecordPath(paths)) !== undefined) writeMoverRecords([])
    if (stopped > 0) info(`port tombstones stopped (${reason}): ${stopped}`)
    return stopped
  }

  /**
   * Keep one redirect alive per port this daemon has abandoned.
   *
   * Called on activation, once the live port is known: the port we used last
   * time is exactly the one somebody's browser is still pointing at.
   */
  function syncMovers() {
    const previous = readLastPort()
    const current = portState().current
    if (current > 0) writeLastPort(current)
    if (current <= 0) {
      stopAllMovers('no live port')
      return { spawn: [], kill: [], keep: [] }
    }
    const enabled = settings.moverOnPortChange === true
    const alive = readMoverRecords(paths).filter((record) => moverAlive(record.pid))
    const plan = planMovers({ records: alive, previousPort: previous?.port ?? 0, currentPort: current, enabled })
    for (const pid of plan.kill) stopMover(pid)
    const records = plan.keep.map((record) => ({ from: record.from, pid: record.pid, at: '' }))
    for (const from of plan.spawn) {
      const pid = startMover(from, current)
      if (pid > 0) records.push({ from, pid, at: new Date().toISOString() })
    }
    writeMoverRecords(
      records.map((record) => ({
        from: record.from,
        pid: record.pid,
        at: record.at === '' ? new Date().toISOString() : record.at,
      })),
    )
    if (plan.spawn.length > 0 || plan.kill.length > 0) {
      recordEvent('host', 'mover', { spawn: plan.spawn, kill: plan.kill, keep: records.map((record) => record.from) })
    }
    if (plan.spawn.length > 0 && records.length > 0) {
      info(`port tombstones: ${records.map((record) => record.from).join(', ')} -> ${current}`)
    }
    return plan
  }

  // --- browser entry ---------------------------------------------------------

  /** The entry key in force: the config value first, then state/entry.json. */
  function resolvedEntryKey() {
    return settings.entryKey !== '' ? settings.entryKey : entryKeyOf(paths)
  }

  /**
   * Make sure a key exists while the key mode is on.
   *
   * Generated once and then kept, because it is part of a URL people bookmark:
   * a key that changed on every startup would make the bookmark useless.
   */
  function ensureEntryKey() {
    if (settings.entryKey !== '') return settings.entryKey
    const existing = entryKeyOf(paths)
    if (existing !== '') return existing
    const key = newEntryKey()
    try {
      ensureDir(paths.stateDir)
      writeIfChanged(paths.entry, `${JSON.stringify({ key, at: new Date().toISOString() }, null, 2)}\n`, 0o600)
    } catch (error) {
      warn(`could not store an entry key in ${paths.entry}: ${error?.message ?? error}`)
      return ''
    }
    return key
  }

  /**
   * The origin a browser should use: the advertised one when the app publishes
   * it (that is where `publicUrl` shows up), else the bound listener, else the
   * live port.
   */
  function runtimeOrigin() {
    const app = typeof ctx.get === 'function' ? ctx.get('webApp') : undefined
    if (app !== undefined && app !== null && typeof app.getAdvertisedUrl === 'function') {
      try {
        const advertised = app.getAdvertisedUrl()
        if (typeof advertised === 'string' && advertised !== '') return advertised.replace(/\/+$/, '')
      } catch { /* fall through to the bound origin */ }
    }
    const server = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
    if (server !== undefined && server !== null && typeof server.getOrigin === 'function') {
      try {
        const origin = server.getOrigin()
        if (typeof origin === 'string' && origin !== '') return origin.replace(/\/+$/, '')
      } catch { /* not bound yet */ }
    }
    const live = portState().current
    return live > 0 ? `http://127.0.0.1:${live}` : ''
  }

  /**
   * The token URL of this very process.
   *
   * The connection service owns the token, so it is asked first; the log is the
   * fallback for a profile where that service is not injectable (the supervisor
   * redirects the child's stdout there, so the same URL is in our own log).
   */
  function authenticatedUrl(origin) {
    return authenticatedTarget(origin).url
  }

  /**
   * The same URL, plus where it came from.
   *
   * `source` matters because the two differ in lifetime: a token from the
   * connection service belongs to this process, while one recovered from the
   * log may belong to a process that has already restarted — it is a hint, not
   * a guarantee. The stable entry URL (GET <prefix>/enter) is the one to hand
   * to a person.
   */
  function authenticatedTarget(origin) {
    if (origin === '') return { url: null, source: null }
    const base = `${origin}/`
    const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
    for (const candidate of [connection, connection?.browserAuth]) {
      if (candidate === undefined || candidate === null) continue
      if (typeof candidate.authenticatedUrl !== 'function') continue
      try {
        const url = candidate.authenticatedUrl(base)
        if (typeof url === 'string' && url !== '') return { url, source: 'connection' }
      } catch (error) {
        warn(`the authentication url is unavailable: ${error?.message ?? error}`)
      }
    }
    const fromLog = tokenUrlFromLog(origin)
    return { url: fromLog, source: fromLog === null ? null : 'log' }
  }

  /**
   * The `dsh web: <url>` line the child printed on its way up.
   *
   * Only a line for the port we are actually on counts: the log keeps every
   * start, and a token from a previous process is already dead. Among those,
   * the last one wins — that is the newest start of this port.
   */
  function tokenUrlFromLog(origin) {
    const text = tailFile(paths.dshLog, 400)
    if (text === '') return null
    const matches = [...text.matchAll(/dsh web:\s*https?:\/\/127\.0\.0\.1:([0-9]+)\/\?token=([A-Za-z0-9_-]+)/g)]
    if (matches.length === 0) return null
    const live = portState().current
    const mine = matches.filter((match) => Number(match[1]) === live)
    const pool = mine.length > 0 ? mine : matches
    const chosen = pool[pool.length - 1]
    return `${origin}/?token=${chosen[2]}`
  }

  /** What `/url` and `status.url` report. */
  function urlState(req) {
    const origin = runtimeOrigin()
    const mode = settings.enterMode
    const key = resolvedEntryKey()
    // No request object means an internal caller: there is no socket to judge,
    // so the peer check is skipped rather than failed.
    const gate = req === undefined ? { ok: true, mode } : entryGate({ mode, key, req })
    const target = gate.ok ? authenticatedTarget(origin) : { url: null, source: null }
    return {
      current: origin === '' ? '' : `${origin}/`,
      authenticated: target.url,
      // "connection" is this process's own token; "log" is recovered from a
      // start that may already be gone, so a caller should not treat it as
      // durable.
      authenticatedSource: target.source,
      entry: buildEntryUrl(origin, { mode, key }),
      mode,
      port: portState().current,
      gate: gate.ok ? 'ok' : gate.reason,
    }
  }

  function entryRefusal(reason) {
    if (reason === 'not-loopback') return 'this entry route answers loopback requests only; use enterMode=key (with entryKey) or enterMode=open behind a proxy\n'
    if (reason === 'key-missing') return 'this entry route needs a key, but none is configured; set entryKey, or install once to generate one\n'
    return 'the entry key does not match\n'
  }

  /**
   * Perform the token exchange on the browser's behalf.
   *
   * The inner request deliberately carries the browser's own Host header: the
   * cookie name is derived from the authority, so a request that claimed a
   * different host would mint a cookie this browser could not use.
   */
  function exchangeToken(req, target) {
    let parsed
    try { parsed = new URL(target) } catch { return Promise.resolve({ ok: false, reason: 'bad-url', target }) }
    // A TLS listener is left to the browser: the redirect below is the fallback.
    if (parsed.protocol !== 'http:') return Promise.resolve({ ok: false, reason: 'not-plain-http', target })
    const connectHost = parsed.hostname === '0.0.0.0' || parsed.hostname === '::' || parsed.hostname === '[::]' ? '127.0.0.1' : parsed.hostname
    const host = typeof req?.headers?.host === 'string' && req.headers.host !== '' ? req.headers.host : parsed.host
    // The app only exchanges the token on the root path, so a caller that built
    // its URL as `origin + '/'` (one slash too many) is normalised here rather
    // than silently falling through to the redirect.
    const pathname = parsed.pathname === '' || parsed.pathname.startsWith('//') ? '/' : parsed.pathname
    return new Promise((resolve) => {
      let settled = false
      const done = (value) => { if (!settled) { settled = true; resolve(value) } }
      const inner = httpRequest({
        host: connectHost,
        port: Number(parsed.port) || 80,
        method: 'GET',
        path: `${pathname}${parsed.search}`,
        headers: { host, accept: 'text/html' },
        timeout: 5000,
      }, (response) => {
        const raw = response.headers['set-cookie']
        const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [String(raw)]
        const cookie = list
          .map((entry) => String(entry).split(';')[0])
          .find((entry) => entry.startsWith('dsh-auth-') && entry.includes('='))
        response.resume()
        if (cookie === undefined) done({ ok: false, reason: `no-cookie-${String(response.statusCode)}`, target })
        else done({ ok: true, cookie, target })
      })
      inner.on('timeout', () => { inner.destroy(); done({ ok: false, reason: 'timeout', target }) })
      inner.on('error', (error) => done({ ok: false, reason: error?.message ?? String(error), target }))
      inner.end()
    })
  }

  /** The stable entry route: log the browser in, then land it on the app. */
  async function handleEnter(req, res) {
    if (req.method !== 'GET') {
      res.writeHead(405, { allow: 'GET', 'cache-control': 'no-store' })
      res.end()
      return
    }
    const mode = settings.enterMode
    const gate = entryGate({ mode, key: resolvedEntryKey(), req })
    if (!gate.ok) {
      info(`entry refused (${mode}): ${gate.reason}`)
      sendText(res, gate.status ?? 403, entryRefusal(gate.reason))
      return
    }
    const target = authenticatedUrl(runtimeOrigin())
    if (target === null) {
      sendText(res, 503, 'no browser authentication is available yet; open the URL printed by dsh web, or retry once the web app is up\n')
      return
    }
    const exchanged = await exchangeToken(req, target)
    if (exchanged.ok) {
      // The cookie the app itself would have set, but the address bar keeps this
      // stable URL instead of the one-time token.
      res.writeHead(303, {
        location: '/',
        'set-cookie': exchanged.cookie,
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
      })
      res.end()
      return
    }
    warn(`entry: token exchange failed (${exchanged.reason}); redirecting to the token url`)
    res.writeHead(302, { location: target, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
    res.end()
  }

  function appArgsFor(port) {
    const args = ['--no-open']
    if (port > 0) args.push('--port', String(port))
    if (settings.host !== '') args.push('--host', settings.host)
    args.push(...settings.extraAppArgs)
    return args
  }

  function appArgs() { return appArgsFor(resolvedPort()) }

  function safeAppArgs() { return appArgsFor(resolvedSafePort()) }

  function nodeBin() {
    if (existsSync(settings.nodeBin)) return settings.nodeBin
    // The fnm-installed node path is version-pinned; survive an upgrade by
    // falling back to another installed version before any system node.
    const candidates = []
    try {
      const root = join(home, '.local', 'share', 'fnm', 'node-versions')
      for (const entry of readdirSync(root).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) {
        candidates.push(join(root, entry, 'installation', 'bin', 'node'))
      }
    } catch { /* fnm is not installed */ }
    candidates.push('/usr/bin/node', '/usr/local/bin/node')
    for (const candidate of candidates) if (existsSync(candidate)) return candidate
    return settings.nodeBin
  }

  function templateValues() {
    return {
      HOME_DIR: paths.homeDir,
      NODE_BIN: nodeBin(),
      DSH_CLI: resolveCliPath(),
      DSH_HOME: dshHome,
      PROFILE: settings.profile,
      SAFE_PROFILE: settings.safeProfile,
      SAFE_TEMPLATE: settings.safeTemplate,
      APP_ARGS: appArgs().join(' '),
      SAFE_APP_ARGS: safeAppArgs().join(' '),
      PORT: resolvedPort(),
      SAFE_PORT: resolvedSafePort(),
      PORT_GUARD: settings.portGuard ? 1 : 0,
      UNIT_NAME: settings.unitName,
      SAFE_UNIT: settings.safeUnitName,
      MAIN_UNIT: settings.unitName,
      FAIL_WINDOW: settings.failureWindowSeconds,
      FAIL_THRESHOLD: settings.failureThreshold,
      HEALTHY_SECONDS: settings.healthySeconds,
      MAX_BACKOFF: settings.maxBackoffSeconds,
      NOTIFY: settings.notify ? 1 : 0,
      // Unit files are not shell scripts: every value that may contain a space
      // has to be quoted here, or systemd splits it into separate words.
      SUPERVISOR_EXEC: `/bin/bash ${unitExecArg(paths.supervisor)}`,
      SAFE_SUPERVISOR_EXEC: `/bin/bash ${unitExecArg(paths.supervisor)} --force-safe`,
      ENV_DSH_HOME: unitWord(`DSH_HOME=${dshHome}`),
      ENV_PATH: unitWord(`PATH=${dirname(nodeBin())}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`),
      // Empty on a real host; inside distrobox/podman this keeps the host's
      // user manager from starting a second instance of the same unit.
      CONDITION: settings.containerOnly ? 'ConditionVirtualization=container' : '',
      CRASH_DISABLE: settings.crashDisable ? 1 : 0,
      // `containerKind()` returns 'none' on a real host; the shell-side guard
      // keys on the empty string, so map host to ''.
      CONTAINER_KIND: containerKind() === 'none' ? '' : containerKind(),
    }
  }

  // --- systemd operations --------------------------------------------------

  async function backend() {
    if (cachedBackend !== undefined) return cachedBackend
    const probe = await systemctl(['is-system-running'])
    if (probe !== null) {
      cachedBackend = 'systemctl'
      return cachedBackend
    }
    const bus = await run('busctl', ['--user', 'get-property', SYSTEMD_DEST, MANAGER_PATH, MANAGER_IFACE, 'Version'])
    cachedBackend = bus.code === 0 ? 'busctl' : 'none'
    return cachedBackend
  }

  async function daemonReload() {
    const direct = await systemctl(['daemon-reload'])
    if (direct !== null && direct.code === 0) return { ok: true, via: 'systemctl' }
    const bus = await managerCall('Reload')
    if (bus.code === 0) return { ok: true, via: 'busctl' }
    return { ok: false, via: 'none', error: (direct?.stderr || bus.stderr || '').trim() }
  }

  async function unitVerb(verb, unit) {
    const direct = await systemctl([verb === 'StartUnit' ? 'start' : verb === 'StopUnit' ? 'stop' : 'restart', unit])
    if (direct !== null) {
      return { ok: direct.code === 0, via: 'systemctl', error: direct.stderr.trim() }
    }
    const bus = await managerCall(verb, 'ss', [unit, 'replace'])
    return { ok: bus.code === 0, via: 'busctl', error: bus.stderr.trim() }
  }

  async function activeState(unit) {
    const direct = await systemctl(['is-active', unit])
    if (direct !== null) {
      const state = direct.stdout.trim() || (direct.code === 0 ? 'active' : 'inactive')
      return { state, via: 'systemctl' }
    }
    const objectPath = await unitObjectPath(unit)
    if (objectPath === undefined) return { state: 'unknown', via: 'busctl' }
    const reply = await busProperty(objectPath, UNIT_IFACE, 'ActiveState')
    return { state: busString(reply.stdout) ?? 'unknown', via: 'busctl' }
  }

  async function mainPid(unit) {
    const direct = await systemctl(['show', unit, '-p', 'MainPID'])
    if (direct !== null) {
      const match = /MainPID=(\d+)/.exec(direct.stdout)
      return match === null ? undefined : Number.parseInt(match[1], 10)
    }
    const objectPath = await unitObjectPath(unit)
    if (objectPath === undefined) return undefined
    const reply = await busProperty(objectPath, UNIT_IFACE, 'MainPID')
    const match = /(\d+)/.exec(reply.stdout)
    return match === null ? undefined : Number.parseInt(match[1], 10)
  }

  function unitPath(unit) { return join(settings.unitDir, unit) }

  function wantsPath(unit) { return join(settings.unitDir, 'default.target.wants', unit) }

  function isInstalled(unit) { return existsSync(unitPath(unit)) }

  function isEnabled(unit) {
    try { return lstatSync(wantsPath(unit)).isSymbolicLink() } catch { return false }
  }

  function enable(unit) {
    ensureDir(dirname(wantsPath(unit)))
    if (isEnabled(unit)) return false
    try {
      symlinkSync(join('..', unit), wantsPath(unit))
      return true
    } catch (error) {
      warn(`could not create ${wantsPath(unit)}: ${error?.message ?? error}`)
      return false
    }
  }

  function disable(unit) {
    try {
      if (isEnabled(unit)) { unlinkSync(wantsPath(unit)); return true }
    } catch (error) {
      warn(`could not remove ${wantsPath(unit)}: ${error?.message ?? error}`)
    }
    return false
  }

  async function lingerEnabled() {
    const result = await run('loginctl', ['show-user', userName, '-p', 'Linger'])
    if (result.code !== 0) return undefined
    return /Linger=yes/.test(result.stdout)
  }

  async function enableLinger() {
    const current = await lingerEnabled()
    if (current === true) return { ok: true, changed: false }
    const result = await run('loginctl', ['enable-linger', userName])
    const after = await lingerEnabled()
    return {
      ok: after === true,
      changed: after === true,
      error: result.code === 0 ? undefined : (result.stderr || result.stdout).trim(),
    }
  }

  /**
   * systemd starts a `user@.service` instance per login — and a lingering user
   * can get one as well, so some machines end up with both a UID instance
   * (`user@1000.service`) and a name instance (`user@ian.service`) at once.
   * Every manager starts this unit, so N managers means N supervisors racing for
   * one port. Detecting that turns an invisible environment fault into a
   * reportable one (the supervisor also guards against it at runtime).
   */
  async function userManagers() {
    const uid = String(typeof process.getuid === 'function' ? process.getuid() : '')
    const ids = []
    // Preferred source: the user manager units systemd itself reports. This also
    // catches a manager that never registered a logind session.
    const units = await run('systemctl', ['list-units', '--all', '--no-legend', '--plain', '--no-pager', 'user@*.service'])
    if (units.code === 0) {
      for (const line of units.stdout.split('\n')) {
        const name = line.trim().split(/\s+/)[0] ?? ''
        const instance = /^user@(.+)\.service$/.exec(name)?.[1]
        if (instance !== undefined && (instance === uid || instance === userName)) ids.push(name)
      }
    }
    if (ids.length === 0) {
      // Fallback: manager *sessions*. `loginctl list-sessions` has no --class
      // option (systemd 262 rejects it), so its CLASS column is matched instead.
      const sessions = await run('loginctl', ['list-sessions', '--no-legend'])
      if (sessions.code !== 0) return { known: false, count: 0, ids: [], duplicate: false }
      for (const line of sessions.stdout.split('\n')) {
        const fields = line.trim().split(/\s+/)
        if (fields.length < 4 || fields[0] === '') continue
        if (!fields.includes('manager')) continue
        if (fields[1] === uid || fields[2] === userName) ids.push(fields[0])
      }
    }
    return {
      known: true,
      count: ids.length,
      ids,
      duplicate: ids.length > 1,
      container: containerKind(),
      advice: managerAdvice({
        ids,
        container: containerKind(),
        unitName: settings.unitName,
        port: resolvedPort(),
        containerOnly: settings.containerOnly,
      }),
    }
  }

  // --- install / uninstall -------------------------------------------------

  function writeSupervisor() {
    const values = templateValues()
    const script = render(template('supervisor.sh'), values)
    const helper = template('relaunch.sh')
    const changed = []
    if (writeIfChanged(paths.supervisor, script, 0o755)) changed.push('supervisor.sh')
    if (writeIfChanged(paths.relaunch, helper, 0o755)) changed.push('relaunch.sh')
    return changed
  }

  function writeUnits() {
    const values = templateValues()
    const changed = []
    const { main, safe } = renderUnits(values)
    if (writeIfChanged(unitPath(settings.unitName), main, 0o644)) changed.push(settings.unitName)
    if (writeIfChanged(unitPath(settings.safeUnitName), safe, 0o644)) changed.push(settings.safeUnitName)
    return changed
  }

  /** Where `dwd` is linked; `$HOME/bin` is the first entry of PATH here. */
  function cliDir() {
    return settings.cliDir !== '' ? settings.cliDir : join(home, 'bin')
  }

  /**
   * Install the `dwd` command: the script itself under bin/, plus `dwd` and
   * `dsh-wrainrock-daemon` names in a directory that is already on PATH.
   *
   * A path that already holds something that is not our symlink is left alone —
   * a command shim must never delete a file the user put there.
   */
  function writeCli() {
    const changed = []
    const warnings = []
    const values = templateValues()
    if (writeIfChanged(paths.cli, render(template('dwd.sh'), values), 0o755)) changed.push('dwd')
    // The tombstone server is shipped as-is: it takes its ports on the command
    // line, so it needs no rendering.
    if (writeIfChanged(paths.mover, template('mover.mjs'), 0o644)) changed.push('mover.mjs')
    const dir = cliDir()
    for (const name of ['dwd', 'dsh-wrainrock-daemon']) {
      const link = join(dir, name)
      try {
        let existing
        try { existing = lstatSync(link) } catch { existing = undefined }
        if (existing !== undefined) {
          if (existing.isSymbolicLink() && readlinkSync(link) === paths.cli) continue
          if (!existing.isSymbolicLink()) {
            warnings.push(`${link} already exists and was left alone; run ${paths.cli} directly`)
            continue
          }
          unlinkSync(link)
        }
        ensureDir(dir)
        symlinkSync(paths.cli, link)
        changed.push(`${name} (link)`)
      } catch (error) {
        warnings.push(`could not link ${link}: ${error?.message ?? error}`)
      }
    }
    const onPath = String(process.env.PATH ?? '').split(':').includes(dir)
    if (!onPath && changed.length > 0) {
      warnings.push(`${dir} is not on PATH; add it, or call ${paths.cli} directly`)
    }
    return { changed, warnings }
  }

  function isGeneratedUnit(unit) {
    const text = readText(unitPath(unit))
    return text !== undefined && GENERATED_MARKERS.some((marker) => text.includes(marker))
  }

  function migrateForeignUnit() {
    // Never silently adopt a unit this plugin did not write.
    const existing = readText(unitPath(settings.unitName))
    if (existing === undefined) return []
    if (GENERATED_MARKERS.some((marker) => existing.includes(marker))) return []
    const suffix = '.pre-dsh-wrainrock-daemon'
    if (existsSync(`${unitPath(settings.unitName)}${suffix}`)) return []
    try {
      copyFileSync(unitPath(settings.unitName), `${unitPath(settings.unitName)}${suffix}`)
      return [`a unit file already existed and was kept as ${settings.unitName}${suffix}`]
    } catch (error) {
      return [`a foreign ${settings.unitName} exists and could not be backed up: ${error?.message ?? error}`]
    }
  }

  /**
   * One-shot migration from the project's former name: carry the data directory
   * over and retire the units it used to install. Only units this project wrote
   * (marker check) are touched, and the new unit is written and enabled by
   * install() around this call, so no boot is ever left without an owner.
   */
  function migrateLegacy() {
    const done = []
    // Newest former name first, and only the first one that exists. A current
    // home directory is never overwritten, so this is a no-op after the first
    // successful migration and on a fresh install.
    for (const legacy of settings.legacyHomeDirs) {
      if (existsSync(homeDir) || !existsSync(legacy)) continue
      try {
        try {
          renameSync(legacy, homeDir)
        } catch (error) {
          // rename() cannot cross filesystems; copy+delete is the fallback.
          if (existsSync(homeDir)) throw error
          cpSync(legacy, homeDir, { recursive: true })
          rmSync(legacy, { recursive: true, force: true })
        }
        done.push(`moved ${legacy} -> ${homeDir}`)
      } catch (error) {
        warn(`could not move ${legacy} to ${homeDir}: ${error?.message ?? error}`)
      }
      break
    }
    for (const unit of settings.legacyUnitNames) {
      if (unit === settings.unitName || unit === settings.safeUnitName) continue
      try {
        if (!isInstalled(unit)) continue
        if (!isGeneratedUnit(unit)) {
          done.push(`left ${unit} alone (not written by this project)`)
          continue
        }
        if (isEnabled(unit)) {
          disable(unit)
          done.push(`disabled ${unit}`)
        }
        rmSync(unitPath(unit))
        done.push(`removed ${unit}`)
      } catch (error) {
        warn(`could not retire ${unit}: ${error?.message ?? error}`)
      }
    }
    if (done.length > 0) info(`migrated from the former name: ${done.join('; ')}`)
    return done
  }

  async function install({ start = false, linger = true } = {}) {
    const result = { ok: true, backend: await backend(), changed: [], warnings: [], steps: [] }
    const finish = (value) => {
      // Keep the last outcome so /status can explain why autostart is not ready.
      try {
        ensureDir(paths.stateDir)
        writeFileSync(join(paths.stateDir, 'install.json'), `${JSON.stringify({
          at: new Date().toISOString(),
          ok: value.ok === true,
          error: value.error,
          changed: value.changed,
          backend: value.backend,
        }, null, 2)}\n`, 'utf8')
      } catch { /* reporting is best effort */ }
      return value
    }
    // Retire the names this project used before it was renamed. This runs
    // BEFORE any directory is created, otherwise the new home would already
    // exist and the legacy data could not be moved into it.
    result.migrated = migrateLegacy()
    try {
      ensureDir(paths.binDir)
      ensureDir(paths.stateDir)
      ensureDir(paths.reportDir)
      ensureDir(paths.logDir)
      ensureDir(paths.backupDir)
      ensureDir(settings.unitDir)
    } catch (error) {
      return finish({ ok: false, error: `cannot create the autostart directories: ${error?.message ?? error}` })
    }

    result.warnings.push(...migrateForeignUnit())
    // A unit whose ExecStart expands to nothing LOOKS installed while never
    // starting (`node ""` even exits 0), so refuse to write one.
    if (resolveCliPath() === '') {
      return finish({ ok: false, error: 'the dsh CLI path could not be resolved; set config.cliPath explicitly' })
    }
    if (!existsSync(nodeBin())) {
      return finish({ ok: false, error: `the node binary does not exist: ${nodeBin()}; set config.nodeBin explicitly` })
    }
    try {
      result.changed.push(...writeSupervisor(), ...writeUnits())
      // The CLI is best effort: a machine where $HOME/bin cannot be written must
      // still get its supervisor, so its failure is a warning, not an error.
      const cli = writeCli()
      result.changed.push(...cli.changed)
      result.warnings.push(...cli.warnings)
      // The entry key is a bookmark ingredient, so it is written once and kept;
      // without it the key mode would answer 403 on the URL people saved.
      if (settings.enterMode === 'key') {
        const before = entryKeyOf(paths)
        const key = ensureEntryKey()
        if (key !== '' && before === '') result.changed.push('entry.json')
        if (key === '') result.warnings.push(`enterMode=key but no entry key could be stored in ${paths.entry}`)
      }
    } catch (error) {
      return finish({ ok: false, error: `cannot write the supervisor/units: ${error?.message ?? error}` })
    }

    if (result.changed.length > 0 || result.migrated.length > 0) {
      const reload = await daemonReload()
      result.steps.push({ step: 'daemon-reload', ...reload })
      if (!reload.ok) {
        result.ok = false
        result.warnings.push(`systemd did not reload its units: ${reload.error || 'unknown error'}`)
      }
    }

    if (settings.startAtBoot) {
      if (enable(settings.unitName)) result.steps.push({ step: 'enable', unit: settings.unitName, ok: true })
      result.enabled = isEnabled(settings.unitName)
    } else {
      result.enabled = false
    }

    if (linger && settings.enableLinger) {
      const lingerResult = await enableLinger()
      result.steps.push({ step: 'linger', ...lingerResult })
      result.linger = lingerResult.ok
      if (!lingerResult.ok) {
        result.warnings.push('loginctl could not enable lingering, so the service starts at login rather than at boot')
      }
    }

    if (start && !isManagedByUnit()) {
      const started = await unitVerb('StartUnit', settings.unitName)
      result.steps.push({ step: 'start', unit: settings.unitName, ...started })
      if (!started.ok) result.ok = false
    }

    const managers = await userManagers()
    result.managers = managers
    if (managers.duplicate) result.warnings.push(managers.advice)

    result.paths = { ...paths, unit: unitPath(settings.unitName), safeUnit: unitPath(settings.safeUnitName) }
    result.health = healthStatus()
    return finish(result)
  }

  async function uninstall({ purge = false } = {}) {
    const result = { ok: true, warnings: [], steps: [] }
    // Tombstones are ours and hold ports: nothing else in this plugin can
    // still be wanted once the daemon is going away.
    const stopped = stopAllMovers('uninstall')
    if (stopped > 0) result.steps.push({ step: 'stop-movers', count: stopped, ok: true })
    if (isManagedByUnit()) {
      result.warnings.push('this process is the running service; it keeps running until it exits or the unit is stopped')
    }
    if (isEnabled(settings.unitName)) {
      disable(settings.unitName)
      result.steps.push({ step: 'disable', unit: settings.unitName, ok: true })
    }
    for (const unit of [settings.unitName, settings.safeUnitName, settings.selfTestUnit]) {
      try {
        if (isInstalled(unit)) { rmSync(unitPath(unit)); result.steps.push({ step: 'remove', unit, ok: true }) }
      } catch (error) {
        result.ok = false
        result.warnings.push(`could not remove ${unit}: ${error?.message ?? error}`)
      }
    }
    const reload = await daemonReload()
    result.steps.push({ step: 'daemon-reload', ...reload })
    if (!reload.ok) result.ok = false
    if (purge) {
      try {
        rmSync(join(homeDir, 'bin'), { recursive: true, force: true })
        result.steps.push({ step: 'purge-scripts', ok: true })
      } catch (error) {
        result.warnings.push(`could not remove ${join(homeDir, 'bin')}: ${error?.message ?? error}`)
      }
    }
    result.paths = paths
    return result
  }

  // --- integrity check / repair -------------------------------------------

  async function composeCheck() {
    const cli = resolveCliPath()
    if (cli === '') return { ok: false, error: 'the dsh CLI path could not be resolved; set config.cliPath' }
    const result = await run(nodeBin(), [cli, '--profile', settings.profile, '--dump-config'], { timeoutMs: 60000 })
    return { ok: result.code === 0, error: result.code === 0 ? undefined : tailText(result.stderr, 400) }
  }

  function tailText(text, length) {
    const value = String(text ?? '').trim()
    return value.length > length ? `…${value.slice(-length)}` : value
  }

  function snapshotConfig() {
    ensureDir(paths.backupDir)
    const copied = []
    for (const file of CONFIG_FILES) {
      const source = join(paths.profileDir, file)
      if (!existsSync(source)) continue
      try {
        copyFileSync(source, join(paths.backupDir, file))
        copied.push(file)
      } catch { /* a single unreadable file must not abort the rest */ }
    }
    if (copied.length > 0) {
      try { writeFileSync(join(paths.backupDir, '.snapshot-at'), new Date().toISOString(), 'utf8') } catch { /* ignore */ }
    }
    return copied
  }

  function restoreConfig() {
    const restored = []
    for (const file of CONFIG_FILES) {
      const backup = join(paths.backupDir, file)
      if (!existsSync(backup)) continue
      try {
        copyFileSync(backup, join(paths.profileDir, file))
        restored.push(file)
      } catch { /* ignore */ }
    }
    return restored
  }

  function quarantineConfig() {
    const dir = join(paths.reportDir, `broken-${new Date().toISOString().replace(/[:.]/g, '-')}`)
    ensureDir(dir)
    const kept = []
    for (const file of CONFIG_FILES) {
      const source = join(paths.profileDir, file)
      if (!existsSync(source)) continue
      try {
        copyFileSync(source, join(dir, file))
        kept.push(file)
      } catch { /* ignore */ }
    }
    return { dir, kept }
  }

  /** Validate the profile config; restore the last known-good snapshot when it is broken. */
  async function repair({ fix = true } = {}) {
    const first = await composeCheck()
    if (first.ok) {
      const copied = snapshotConfig()
      return { ok: true, action: 'none', message: `profile '${settings.profile}' composes correctly`, snapshot: copied }
    }

    if (!fix) return { ok: false, action: 'none', detail: first.error }

    const hasBackup = existsSync(join(paths.backupDir, 'cordis.patch.yml'))
    if (!hasBackup) {
      return { ok: false, action: 'none', detail: first.error, message: 'no known-good snapshot to restore; safe mode will be used' }
    }

    const kept = quarantineConfig()
    const restored = restoreConfig()
    const second = await composeCheck()
    if (second.ok) {
      return {
        ok: true,
        action: 'restored',
        restored,
        quarantine: kept.dir,
        detail: first.error,
        message: `the profile config was invalid and has been restored from the last known-good snapshot (broken copies kept in ${kept.dir})`,
      }
    }
    return { ok: false, action: 'failed', restored, quarantine: kept.dir, detail: second.error, message: 'restoring the snapshot did not make the profile composable; safe mode is required' }
  }

  // --- supervisor state ----------------------------------------------------

  function readStateFile(name, fallback = '') {
    return readText(join(paths.stateDir, name), fallback)?.trim() ?? fallback
  }

  function supervisorState() {
    const numeric = (name) => {
      const value = Number.parseInt(readStateFile(name, ''), 10)
      return Number.isFinite(value) ? value : undefined
    }
    let incident = null
    const raw = readText(join(paths.stateDir, 'incident.json'))
    if (raw !== undefined && raw.trim() !== '') {
      try { incident = JSON.parse(raw) } catch { incident = { at: undefined, kind: 'unknown', message: raw.slice(0, 400) } }
    }
    return {
      installed: existsSync(paths.supervisor),
      mode: readStateFile('mode', 'normal') === 'safe' ? 'safe' : 'normal',
      failures: numeric('failures') ?? 0,
      lastStart: numeric('last_start'),
      lastExit: numeric('last_exit'),
      incident,
      previousIncident: existsSync(join(paths.reportDir, 'latest.md')),
      // Set only while a temporary crash-recovery overlay is in force: the id
      // listed here is disabled for this boot only and is re-enabled by the
      // supervisor as soon as a run stays healthy.
      recovery: readJson(join(paths.stateDir, 'recovery.json')) ?? undefined,
      recoveryOverlay: existsSync(join(paths.stateDir, 'recovery-override.yml')) || undefined,
    }
  }

  /**
   * Inspect the GENERATED supervisor, not just the files' existence: an
   * autostart that looks installed while its baked node/cli paths are gone is
   * exactly the failure that once made the service stop silently.
   */
  function healthStatus() {
    const script = readText(paths.supervisor)
    const read = (key, env) => {
      if (script === undefined) return undefined
      const match = new RegExp(`${key}="\\$\\{${env}:-([^}]*)\\}"`).exec(script)
      return match === null ? undefined : match[1]
    }
    const node = read('NODE_BIN', 'DSH_WRAINROCK_DAEMON_NODE')
    const cli = read('DSH_CLI', 'DSH_WRAINROCK_DAEMON_CLI')
    const appArgs = read('APP_ARGS', 'DSH_WRAINROCK_DAEMON_APP_ARGS')
    const nodeExists = typeof node === 'string' && node !== '' && existsSync(node)
    const cliExists = typeof cli === 'string' && cli !== '' && existsSync(cli)
    return {
      ok: script !== undefined && nodeExists && cliExists && isInstalled(settings.unitName),
      script: script !== undefined,
      unitInstalled: isInstalled(settings.unitName),
      generated: { node, cli, appArgs },
      nodeExists,
      cliExists,
    }
  }

  /** Proof, reported by the browser, that the restart control really rendered. */
  function clientState() {
    const raw = readText(join(paths.stateDir, 'client.json'))
    if (raw === undefined || raw.trim() === '') return { mounted: false }
    try { return { mounted: true, ...JSON.parse(raw) } } catch { return { mounted: false } }
  }

  /** One line per restart-lifecycle step, from both the page and this half. */
  const CLIENT_EVENTS_FILE = 'client-events.jsonl'
  const CLIENT_EVENTS_MAX = 200

  function recordEvent(source, event, data) {
    try {
      ensureDir(paths.stateDir)
      const file = join(paths.stateDir, CLIENT_EVENTS_FILE)
      const line = `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, source, event, data })}\n`
      let text = `${readText(file, '') ?? ''}${line}`
      const lines = text.split('\n').filter((entry) => entry !== '')
      if (lines.length > CLIENT_EVENTS_MAX) text = `${lines.slice(-CLIENT_EVENTS_MAX).join('\n')}\n`
      writeFileSync(file, text, 'utf8')
    } catch { /* diagnostics are best effort */ }
  }

  /** At most one heartbeat per 20s: proves the page is still polling. */
  function recordHeartbeat() {
    try {
      const file = join(paths.stateDir, 'client-heartbeat.json')
      const previous = readJson(file)
      const last = typeof previous?.at === 'string' ? Date.parse(previous.at) : 0
      if (Number.isFinite(last) && Date.now() - last < 20000) return
      ensureDir(paths.stateDir)
      writeFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid }, null, 2)}\n`, 'utf8')
    } catch { /* diagnostics are best effort */ }
  }

  function clientHeartbeat() {
    return readJson(join(paths.stateDir, 'client-heartbeat.json')) ?? null
  }

  function clientEvents(limit = 10) {
    const text = readText(join(paths.stateDir, CLIENT_EVENTS_FILE), '')
    const lines = (text ?? '').split('\n').filter((entry) => entry !== '')
    return lines.slice(-limit).map((line) => {
      try { return JSON.parse(line) } catch { return { raw: line.slice(0, 200) } }
    })
  }

  function clearSafeMode() {
    const removed = []
    for (const name of ['mode', 'failures', 'window_start', 'incident.json']) {
      const path = join(paths.stateDir, name)
      try {
        if (existsSync(path)) { rmSync(path); removed.push(name) }
      } catch { /* ignore */ }
    }
    return removed
  }

  // --- restart -------------------------------------------------------------

  function isManagedByUnit() {
    // cgroup v2 writes `0::/user.slice/…/dsh-wrainrock-daemon.service` while the unit runs us.
    return selfCgroup().includes(settings.unitName)
  }

  function capturedArgv() {
    const argv = process.argv.slice(1).filter((arg) => typeof arg === 'string')
    if (argv.length > 0 && /(^|[/\\])bin\.js$/.test(argv[0])) return argv
    const cli = resolveCliPath()
    return cli === '' ? [] : [cli, settings.profile, ...appArgs()]
  }

  /** MainPID of the unit instance `systemctl --user` talks to (0 when unknown). */
  async function unitMainPid() {
    const res = await systemctl(['show', settings.unitName, '-p', 'MainPID', '--value'])
    if (res === null || res.code !== 0) return 0
    const pid = Number(String(res.stdout).trim())
    return Number.isInteger(pid) && pid > 0 ? pid : 0
  }

  /**
   * Spawn the relaunch helper. The helper itself moves into a transient scope
   * when it has to stop the unit (see relaunch.sh): started from inside
   * `dsh-wrainrock-daemon.service` it inherits that unit's cgroup, and systemd
   * reaps the cgroup (`KillMode=control-group`) the moment the supervisor dies
   * — before the helper could start the unit again (2026-11-02 incident).
   */
  function spawnRelaunch({ useSystemd, mode = useSystemd ? 'systemd' : 'exec', pid = process.pid }) {
    const command = [nodeBin(), ...capturedArgv()]
    const args = [
      paths.relaunch,
      String(pid),
      mode,
      settings.unitName,
      process.cwd(),
      ...command,
    ]
    const env = {
      ...process.env,
      // The helper waits for this port to free before it starts the unit again.
      DSH_RESTART_PORT: String(Number(settings.port) || 0),
      // The page is gone by the time the helper can fail: keep its output.
      DSH_RELAUNCH_LOG: join(paths.logDir, 'relaunch.log'),
    }
    const child = spawn('/bin/bash', args, { detached: true, stdio: 'ignore', env })
    child.on('error', () => {})
    child.unref()
    return { pid: child.pid, mode, command: command.join(' ') }
  }

  async function planRestart() {
    const managed = isManagedByUnit()
    const decision = decideRestartPlan({
      managed,
      enabled: managed ? true : isEnabled(settings.unitName),
      unitMainPid: managed ? await unitMainPid() : 0,
      supervisorPid: managed ? process.ppid : 0,
    })
    if (decision.action === 'systemd') {
      return { action: 'systemd', unit: settings.unitName, backend: await backend(), message: `restarting ${settings.unitName} through systemd` }
    }
    if (decision.action === 'systemd-kill') {
      // Two user managers each run the unit: `systemctl --user` only sees the
      // other one, so the helper stops every supervisor and starts the unit.
      const spawned = spawnRelaunch({ useSystemd: true, mode: 'systemd-kill', pid: process.ppid })
      return {
        action: 'systemd-kill',
        unit: settings.unitName,
        helperPid: spawned.pid,
        supervisorPid: process.ppid,
        reason: decision.reason,
        message: `两个 systemd 用户管理器各跑一份 ${settings.unitName}：systemctl 只会重启另一份，改由 helper 结束本实例并重新拉起`,
      }
    }
    const spawned = spawnRelaunch({ useSystemd: decision.action === 'systemd-handoff' })
    return {
      action: decision.action,
      helperPid: spawned.pid,
      message: decision.action === 'systemd-handoff'
        ? `autostart is enabled: exiting now and letting ${settings.unitName} take over`
        : 'autostart is not enabled: relaunching the same command line detached',
    }
  }

  async function performRestart(plan) {
    recordEvent('host', 'restart:perform', { action: plan.action, unit: settings.unitName, managed: isManagedByUnit() })
    if (plan.action === 'systemd-kill') {
      // The helper kills this supervisor (and us with it); nothing else to do.
      const result = { ok: true, via: 'relaunch', action: plan.action }
      recordEvent('host', 'restart:result', result)
      info(`handing over to ${paths.relaunch} (${plan.action})`)
      return result
    }
    if (plan.action === 'systemd') {
      const result = await (async () => {
        const direct = await systemctl(['restart', settings.unitName])
        if (direct !== null) return { ok: direct.code === 0, via: 'systemctl', error: direct.stderr.trim() }
        const bus = await managerCall('RestartUnit', 'ss', [settings.unitName, 'replace'])
        return { ok: bus.code === 0, via: 'busctl', error: bus.stderr.trim() }
      })()
      recordEvent('host', 'restart:result', result)
      if (!result.ok) {
        warn(`restart failed (${result.via}): ${result.error || 'unknown error'}`)
        return result
      }
      return result
    }
    info(`handing over to ${paths.relaunch} (${plan.action})`)
    recordEvent('host', 'restart:handover', { helper: paths.relaunch })
    const force = setTimeout(() => process.exit(0), 8000)
    force.unref?.()
    process.kill(process.pid, 'SIGTERM')
    return { ok: true, via: 'relaunch' }
  }

  // --- selftest ------------------------------------------------------------

  /** Prove that this session can actually load, start and stop a systemd user unit. */
  async function selftest() {
    const unit = settings.selfTestUnit
    const steps = []
    const record = (step, detail) => steps.push({ step, ...detail })
    const back = await backend()
    record('backend', { ok: back !== 'none', via: back })
    if (back === 'none') return { ok: false, steps, message: 'neither systemctl --user nor the systemd D-Bus manager can be reached' }

    try {
      writeIfChanged(unitPath(unit), template('units/dsh-wrainrock-daemon-selftest.service.in'), 0o644)
      record('write-unit', { ok: true, path: unitPath(unit) })
    } catch (error) {
      return { ok: false, steps, message: `cannot write the selftest unit: ${error?.message ?? error}` }
    }

    record('daemon-reload', await daemonReload())
    const started = await unitVerb('StartUnit', unit)
    record('start', started)
    if (!started.ok) {
      record('cleanup', await cleanupSelfTest(unit))
      return { ok: false, steps, message: `systemd refused to start the selftest unit: ${started.error || 'unknown error'}` }
    }

    let state = 'unknown'
    for (let attempt = 0; attempt < 10; attempt += 1) {
      state = (await activeState(unit)).state
      if (state === 'active') break
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    record('active', { ok: state === 'active', state })

    const stopped = await unitVerb('StopUnit', unit)
    record('stop', stopped)
    record('cleanup', await cleanupSelfTest(unit))
    return { ok: state === 'active' && stopped.ok, steps, message: state === 'active' ? 'systemd user units can be started and stopped from this session' : `the selftest unit never became active (state ${state})` }
  }

  async function cleanupSelfTest(unit) {
    try { if (isInstalled(unit)) rmSync(unitPath(unit)) } catch { /* ignore */ }
    const reload = await daemonReload()
    return { ok: reload.ok, via: reload.via }
  }

  // --- status --------------------------------------------------------------

  async function status(req) {
    const back = await backend()
    const unit = settings.unitName
    const installed = isInstalled(unit)
    const enabled = isEnabled(unit)
    let active = { state: 'unknown', via: back }
    let pid
    if (installed) {
      active = await activeState(unit)
      pid = await mainPid(unit)
    }
    const linger = settings.enableLinger ? await lingerEnabled() : undefined
    return {
      ok: true,
      plugin: PKG_NAME,
      version: readJson(join(PACKAGE_DIR, 'package.json'))?.version,
      time: new Date().toISOString(),
      process: {
        pid: process.pid,
        ppid: process.ppid,
        cwd: process.cwd(),
        execPath: process.execPath,
        cgroup: selfCgroup().trim(),
        managedByUnit: isManagedByUnit(),
        argv: process.argv.slice(1).filter((arg) => typeof arg === 'string'),
      },
      systemd: {
        backend: back,
        available: back !== 'none',
        unitDir: settings.unitDir,
        unit,
        installed,
        enabled,
        activeState: active.state,
        activeVia: active.via,
        mainPid: pid,
        safeUnit: settings.safeUnitName,
        safeUnitInstalled: isInstalled(settings.safeUnitName),
      },
      linger,
      managers: await userManagers(),
      profile: settings.profile,
      safeProfile: settings.safeProfile,
      appArgs: appArgs(),
      port: portState(),
      url: urlState(req),
      mover: {
        enabled: settings.moverOnPortChange === true,
        previousPort: readLastPort()?.port ?? 0,
        records: readMoverRecords(paths).map((record) => ({ from: record.from, pid: record.pid })),
      },
      supervisor: supervisorState(),
      client: clientState(),
      clientHeartbeat: clientHeartbeat(),
      clientEvents: clientEvents(),
      ready: readiness.ready,
      readyAt: readiness.at,
      health: healthStatus(),
      lastInstall: readJson(join(paths.stateDir, 'install.json')),
      paths,
      config: {
        failureThreshold: settings.failureThreshold,
        failureWindowSeconds: settings.failureWindowSeconds,
        healthySeconds: settings.healthySeconds,
        installOnActivate: settings.installOnActivate,
        startAtBoot: settings.startAtBoot,
        port: resolvedPort(),
        safePort: resolvedSafePort(),
        portGuard: settings.portGuard,
        enterMode: settings.enterMode,
        entryKeySet: resolvedEntryKey() !== '',
        moverOnPortChange: settings.moverOnPortChange === true,
      },
    }
  }

  function readJson(path) {
    const raw = readText(path)
    if (raw === undefined) return undefined
    try { return JSON.parse(raw) } catch { return undefined }
  }

  // --- http ------------------------------------------------------------------

  function sendJson(res, code, body) {
    const text = `${JSON.stringify(body, null, 2)}\n`
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(text),
    })
    res.end(text)
  }

  function sendText(res, code, text) {
    res.writeHead(code, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(text),
    })
    res.end(text)
  }

  function mutating(req, res) {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method-not-allowed', expected: 'POST' })
      return false
    }
    // A custom header keeps a stray cross-site form/img from restarting the app.
    if (String(req.headers['x-dsh-wrainrock-daemon'] ?? '') !== '1') {
      sendJson(res, 403, { ok: false, error: 'missing-x-dsh-wrainrock-daemon-header' })
      return false
    }
    return true
  }

  function query(req) {
    try { return new URL(req.url ?? '/', 'http://127.0.0.1') } catch { return new URL(`${ROUTE_PREFIX}/status`, 'http://127.0.0.1') }
  }

  function routes() {
    return [
      {
        kind: 'exact',
        path: `${ROUTE_PREFIX}/status`,
        handler: async (req, res) => {
          try {
            // The page polls with hb=1; curl/agents do not, so only real pages
            // move the liveness timestamp.
            if (query(req).searchParams.get('hb') === '1') recordHeartbeat()
            sendJson(res, 200, await status(req))
          } catch (error) { sendJson(res, 500, { ok: false, error: String(error?.message ?? error) }) }
        },
      },
      {
        kind: 'exact',
        path: `${ROUTE_PREFIX}/port`,
        handler: async (req, res) => {
          const params = query(req).searchParams
          if (req.method === 'GET') {
            try {
              sendJson(res, 200, { ok: true, ...portState() })
            } catch (error) { sendJson(res, 500, { ok: false, error: String(error?.message ?? error) }) }
            return
          }
          if (!mutating(req, res)) return
          try {
            const requested = params.get('port')
            const result = setNextPort(requested, {
              safePort: params.get('safePort'),
              by: params.get('by') === 'cli' ? 'cli' : 'ui',
            })
            if (!result.ok) {
              // A bad port is the caller's mistake, not a broken daemon: no file
              // was touched, so nothing here needs repairing.
              sendJson(res, result.error === 'write-failed' ? 500 : 400, { ok: false, error: result.error, message: result.message, value: result.value ?? requested })
              return
            }
            const body = { ok: true, ...portState(), changed: result.changed }
            if (params.get('restart') !== '1') {
              sendJson(res, 200, body)
              return
            }
            const plan = await planRestart()
            recordEvent('host', 'port:restart', { port: result.record.port, action: plan.action })
            sendJson(res, 202, { ...body, plan, note: 'the new port takes effect once the process is back' })
            // Same 250ms as /restart: long enough for the 202 to reach the
            // caller on loopback, short enough not to be felt.
            setTimeout(() => { performRestart(plan).catch((error) => warn(`restart for a new port failed: ${error?.message ?? error}`)) }, 250)
          } catch (error) {
            sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
          }
        },
      },
      {
        kind: 'exact',
        path: `${ROUTE_PREFIX}/url`,
        handler: (req, res) => {
          if (req.method !== 'GET') {
            sendJson(res, 405, { ok: false, error: 'method-not-allowed', expected: 'GET' })
            return
          }
          try { sendJson(res, 200, { ok: true, ...urlState(req) }) } catch (error) { sendJson(res, 500, { ok: false, error: String(error?.message ?? error) }) }
        },
      },
      {
        kind: 'exact',
        path: `${ROUTE_PREFIX}/enter`,
        handler: (req, res) => {
          handleEnter(req, res).catch((error) => {
            try { sendText(res, 500, `the entry route failed: ${error?.message ?? error}\n`) } catch { /* the socket is gone */ }
          })
        },
      },
      {
        kind: 'exact',
        path: `${ROUTE_PREFIX}/log`,
        handler: (req, res) => {
          const lines = Math.min(2000, Math.max(1, asNumber(query(req).searchParams.get('lines'), 200)))
          const source = query(req).searchParams.get('source') === 'dsh' ? paths.dshLog : paths.supervisorLog
          sendText(res, 200, tailFile(source, lines) || `${source} is empty\n`)
        },
      },
      {
        kind: 'exact',
        path: `${ROUTE_PREFIX}/mounted`,
        handler: (req, res) => {
          if (!mutating(req, res)) return
          let body = ''
          req.on('data', (chunk) => { if (body.length < 120) body += chunk })
          req.on('end', () => {
            let previous = 0
            try { previous = Number(clientState().count) || 0 } catch { previous = 0 }
            const record = { at: new Date().toISOString(), where: String(body).slice(0, 40), count: previous + 1, pid: process.pid }
            try {
              ensureDir(paths.stateDir)
              writeFileSync(join(paths.stateDir, 'client.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
            } catch { /* the beacon is best effort */ }
            sendJson(res, 200, { ok: true, recorded: record })
          })
        },
      },
      {
        kind: 'exact',
        path: `${ROUTE_PREFIX}/event`,
        handler: (req, res) => {
          if (!mutating(req, res)) return
          let body = ''
          req.on('data', (chunk) => { if (body.length < 400) body += chunk })
          req.on('end', () => {
            const text = String(body)
            const space = text.indexOf(' ')
            const event = (space === -1 ? text : text.slice(0, space)).slice(0, 60) || 'unknown'
            let data
            if (space !== -1) {
              try { data = JSON.parse(text.slice(space + 1)) } catch { data = { raw: text.slice(space + 1, 200) } }
            }
            recordEvent('client', event, data)
            sendJson(res, 200, { ok: true })
          })
        },
      },
      {
        kind: 'exact',
        path: `${ROUTE_PREFIX}/restart`,
        handler: async (req, res) => {
          if (!mutating(req, res)) return
          try {
            const plan = await planRestart()
            recordEvent('host', 'restart:plan', {
              action: plan.action,
              unit: settings.unitName,
              managed: isManagedByUnit(),
              supervisorPid: process.ppid,
              helperPid: plan.helperPid ?? 0,
            })
            sendJson(res, 202, { ok: true, plan, note: 'the page will answer again once the new process is up' })
            // Long enough for the 202 to reach the browser on loopback, short
            // enough not to be felt: the earlier 700ms was pure added latency.
            setTimeout(() => { performRestart(plan).catch((error) => warn(`restart failed: ${error?.message ?? error}`)) }, 250)
          } catch (error) {
            sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
          }
        },
      },
      {
        kind: 'exact',
        path: `${ROUTE_PREFIX}/install`,
        handler: async (req, res) => {
          if (!mutating(req, res)) return
          try { sendJson(res, 200, await install({ start: false })) } catch (error) { sendJson(res, 500, { ok: false, error: String(error?.message ?? error) }) }
        },
      },
      {
        kind: 'exact',
        path: `${ROUTE_PREFIX}/uninstall`,
        handler: async (req, res) => {
          if (!mutating(req, res)) return
          try { sendJson(res, 200, await uninstall({ purge: query(req).searchParams.get('purge') === '1' })) } catch (error) { sendJson(res, 500, { ok: false, error: String(error?.message ?? error) }) }
        },
      },
      {
        kind: 'exact',
        path: `${ROUTE_PREFIX}/repair`,
        handler: async (req, res) => {
          if (!mutating(req, res)) return
          try { sendJson(res, 200, await repair({ fix: true })) } catch (error) { sendJson(res, 500, { ok: false, error: String(error?.message ?? error) }) }
        },
      },
      {
        kind: 'exact',
        path: `${ROUTE_PREFIX}/reset`,
        handler: async (req, res) => {
          if (!mutating(req, res)) return
          try {
            const removed = clearSafeMode()
            const restart = query(req).searchParams.get('restart') === '1'
            const plan = restart ? await planRestart() : undefined
            sendJson(res, restart ? 202 : 200, { ok: true, cleared: removed, plan })
            if (plan !== undefined) {
              // Long enough for the 202 to reach the browser on loopback, short
            // enough not to be felt: the earlier 700ms was pure added latency.
            setTimeout(() => { performRestart(plan).catch((error) => warn(`restart failed: ${error?.message ?? error}`)) }, 250)
            }
          } catch (error) {
            sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
          }
        },
      },
      {
        kind: 'exact',
        path: `${ROUTE_PREFIX}/selftest`,
        handler: async (req, res) => {
          if (!mutating(req, res)) return
          try { sendJson(res, 200, await selftest()) } catch (error) { sendJson(res, 500, { ok: false, error: String(error?.message ?? error) }) }
        },
      },
    ]
  }

  // --- lifecycle -----------------------------------------------------------

  function bindPort(port) {
    if (Number.isFinite(port) && port > 0) livePort = port
    // Publish the live port for the CLI as soon as it is known: before this the
    // only way to reach the daemon was to guess from the state directory's lock
    // file name.
    if (livePort > 0) writeRuntime()
  }

  async function activate() {
    if (activated || disposed) return
    activated = true
    watchReadiness()
    writeRuntime()
    // Before anything else that can fail: a browser still sitting on the port
    // this process came from has nowhere else to go.
    try {
      syncMovers()
    } catch (error) {
      warn(`could not leave a redirect on the previous port: ${error?.message ?? error}`)
    }
    if (!settings.installOnActivate) {
      info('activation: installOnActivate=false, only reporting status')
      return
    }
    const result = await install({ start: false })
    if (result.managers?.duplicate) warn(`autostart: ${result.managers.advice}`)
    if (result.ok) {
      info(`autostart ready: unit=${settings.unitName} enabled=${result.enabled === true} linger=${result.linger ?? 'unchanged'} changed=[${(result.changed ?? []).join(', ')}]`)
    } else {
      warn(`autostart install incomplete: ${result.error ?? (result.warnings ?? []).join('; ')}`)
    }

    // An enabled unit that is not running means nothing is supervising this
    // process: the last restart did not come back, or the web was started by
    // hand after the unit died. Nothing else would ever re-arm it — the unit
    // was left "enabled but stopped" for hours on 2026-11-02. Starting it now
    // is safe: the supervisor sees this process holding the port, reports a
    // peer, and stands by until this process exits.
    if (result.ok && result.enabled === true && !isManagedByUnit()) {
      const state = await activeState(settings.unitName)
      if (state.state !== 'active' && state.state !== 'activating') {
        // A unit that hit StartLimitBurst stays refused until the counter is
        // cleared, and re-arming would look like it worked while nothing ran.
        if (state.state === 'failed') await systemctl(['reset-failed', settings.unitName])
        const started = await unitVerb('StartUnit', settings.unitName)
        if (started.ok) info(`autostart re-armed: ${settings.unitName} was enabled but not running (was ${state.state})`)
        else warn(`autostart re-arm failed (${started.via}): ${started.error || 'unknown error'}`)
      }
    }
  }

  function dispose() {
    disposed = true
    activated = false
  }

  return { bindPort, activate, dispose, routes, status, install, uninstall, repair, selftest, planRestart, performRestart, clearSafeMode, setNextPort, portState, urlState, syncMovers, settings, paths }
}

// ---------------------------------------------------------------------------
// cordis plugin face
// ---------------------------------------------------------------------------

export const name = PKG_NAME

export function apply(ctx, config) {
  const manager = createManager(ctx, config)
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      manager.bindPort(webCtx.webServer?.port)
      manager.activate().catch((error) => {
        try { webCtx.logger?.warn?.(`${PKG_NAME}: activation failed: ${error?.message ?? error}`) } catch { /* ignore */ }
      })
      return () => manager.dispose()
    }, 'dsh-wrainrock-daemon: activation')

    webCtx.effect(() => {
      const disposers = manager.routes().map((route) => webCtx.webServer.register(route))
      return () => { for (const dispose of disposers.reverse()) dispose() }
    }, 'dsh-wrainrock-daemon: http routes')
  })
}
