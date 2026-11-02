/**
 * Regression test for how the generated supervisor treats two systemd user
 * managers.
 *
 * 2026-11-02: two managers for one uid are the normal distrobox/podman host +
 * container layout, so the supervisor must not spam "duplicate managers" (and
 * must not write an env-note into the incident report). The genuine duplicate on
 * a plain host stays warned about.
 *
 *   node tests/supervisor-container.mjs
 */
import { readFileSync, rmSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { containerKind, managerAdvice } from '../index.js'

const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
let failed = 0
const check = (what, expected, actual) => {
  const ok = String(expected) === String(actual)
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : ` (expected ${expected}, got ${actual})`}`)
  if (!ok) failed = 1
}
const has = (text, needle) => String(text ?? '').includes(needle)

console.log('1. the supervisor is container-aware')
const source = readFileSync(join(PLUGIN_DIR, 'supervisor.sh'), 'utf8')
check('bakes CONTAINER from a render token', true, has(source, 'CONTAINER="@@CONTAINER_KIND@@"'))
check('host branch ignores the duplicate when CONTAINER is set', true,
  has(source, '[ "$CONTAINER" = "" ]; then'))
check('container branch logs the normal layout instead of warning', true,
  has(source, 'running inside $CONTAINER: multiple user managers are the normal host+container layout'))

console.log('2. a container render leaves no bare token and no duplicate warning text')
const render = (values) => source
  .replace(/@@HOME_DIR@@|@@NODE_BIN@@|@@DSH_CLI@@|@@DSH_HOME@@|@@PROFILE@@|@@SAFE_PROFILE@@|@@SAFE_TEMPLATE@@|@@APP_ARGS@@|@@SAFE_APP_ARGS@@|@@PORT@@|@@SAFE_PORT@@|@@PORT_GUARD@@|@@UNIT_NAME@@|@@FAIL_WINDOW@@|@@FAIL_THRESHOLD@@|@@HEALTHY_SECONDS@@|@@MAX_BACKOFF@@|@@NOTIFY@@|@@CRASH_DISABLE@@/g, (tok) => values[tok] ?? '')
  .replace(/@@CONTAINER_KIND@@/g, values['@@CONTAINER_KIND@@'] ?? '')
const tokens = {
  '@@HOME_DIR@@': '/tmp/home', '@@NODE_BIN@@': '/bin/bash', '@@DSH_CLI@@': '/tmp/dsh',
  '@@DSH_HOME@@': '/tmp/home/.dsh', '@@PROFILE@@': 'web', '@@SAFE_PROFILE@@': 'dsh-safe',
  '@@SAFE_TEMPLATE@@': 'web', '@@APP_ARGS@@': '--no-open --port 3999', '@@SAFE_APP_ARGS@@': '--no-open --port 4000',
  '@@PORT@@': '3999', '@@SAFE_PORT@@': '4000', '@@PORT_GUARD@@': '1',
  '@@UNIT_NAME@@': 'dsh-wrainrock-daemon.service', '@@FAIL_WINDOW@@': '600',
  '@@FAIL_THRESHOLD@@': '3', '@@HEALTHY_SECONDS@@': '1', '@@MAX_BACKOFF@@': '2', '@@NOTIFY@@': '0',
  '@@CRASH_DISABLE@@': '1',
}
const boxed = render({ ...tokens, '@@CONTAINER_KIND@@': 'podman' })
check('no bare token survives', false, /@@[A-Z_]+@@/.test(boxed))
check('warn branch is gated by an empty CONTAINER', true,
  /\[ "\$CONTAINER" = "" \]/.test(boxed))
check('container render bakes the kind as a non-empty value', true, has(boxed, 'CONTAINER="podman"'))
check('container branch kept', true, has(boxed, 'running inside $CONTAINER'))

const host = render(tokens)
check('host render keeps the duplicate warning branch', true, has(host, 'WARNING: $managers systemd user managers for uid'))

console.log('3. containerKind is a string and managerAdvice mentions the container')
check('containerKind returns a string', 'string', typeof containerKind())
check('advice names the layout', true, has(managerAdvice({ ids: ['a', 'b'], container: 'podman', containerOnly: true }), 'distrobox/podman'))

if (failed === 0) console.log('all supervisor-container tests passed')
else console.log('some supervisor-container tests failed')
process.exit(failed)