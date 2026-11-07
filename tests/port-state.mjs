/**
 * Regression test for the "next start port" plumbing behind `dwd rp <port>` and
 * the Daemon settings page (2026-11-07).
 *
 * Three pure-ish helpers carry it: `parsePortValue` (what counts as a port),
 * `readPortOverride` (the `state/port.json` request, which must never stop the
 * daemon from starting on its configured port), and `portSnapshot` (the one
 * shape `/status.port`, `GET /port` and `POST /port` all expose, with the
 * precedence live > override > config).
 *
 * Everything runs in a temp dir; the real profile, units and `~/.dsh` are never
 * touched.
 *
 *   node tests/port-state.mjs
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parsePortValue, portOverridePath, readPortOverride, portSnapshot } from '../index.js'

let failed = 0
const check = (what, expected, actual) => {
  if (String(expected) === String(actual)) {
    console.log(`  ok   ${what}`)
  } else {
    console.log(`  FAIL ${what} (expected ${expected}, got ${actual})`)
    failed = 1
  }
}

console.log('1. parsePortValue: only an integer 1..65535 is a port')
check('0 is not a port (it means "let dsh pick one")', 0, parsePortValue(0))
check('65536 is out of range', 0, parsePortValue(65536))
check('-1 is out of range', 0, parsePortValue(-1))
check("'abc' is not a number", 0, parsePortValue('abc'))
check("'' is not a port", 0, parsePortValue(''))
check('null is not a port', 0, parsePortValue(null))
check('undefined is not a port', 0, parsePortValue(undefined))
check('3080 the number is a port', 3080, parsePortValue(3080))
check("'3080' the string is a port", 3080, parsePortValue('3080'))
check("' 3080 ' is trimmed", 3080, parsePortValue(' 3080 '))
check("'3080.5' is not an integer port", 0, parsePortValue('3080.5'))
check('3080.5 the number is not an integer port', 0, parsePortValue(3080.5))
check("'1e3' is not accepted", 0, parsePortValue('1e3'))
check('1 is the lowest port', 1, parsePortValue(1))
check('65535 is the highest port', 65535, parsePortValue(65535))

const scratch = mkdtempSync(join(tmpdir(), 'dsh-port-'))
const paths = { stateDir: scratch }
const portFile = join(scratch, 'port.json')

console.log('2. portOverridePath: state/port.json under stateDir')
check('override path', join(scratch, 'port.json'), portOverridePath(paths))

console.log('3. readPortOverride: a bad request is the same as no request')
rmSync(portFile, { force: true })
check('absent file -> null', null, readPortOverride(paths))

writeFileSync(portFile, '{"port":3080,"safePort":3081,"at":"2026-11-07T00:00:00.000Z","by":"cli"}\n')
{
  const override = readPortOverride(paths)
  check('valid file -> port', 3080, override?.port)
  check('valid file -> safePort', 3081, override?.safePort)
  check('valid file -> at', '2026-11-07T00:00:00.000Z', override?.at)
  check('valid file -> by', 'cli', override?.by)
  check('valid file -> file', portFile, override?.file)
}

writeFileSync(portFile, '{"port":3080,"safePort":null,"by":"ui"}\n')
{
  const override = readPortOverride(paths)
  check('safePort:null is kept as null', null, override?.safePort)
  check('an absent at stays undefined', 'undefined', String(override?.at))
  check('by:ui is kept', 'ui', override?.by)
}

writeFileSync(portFile, '{"port":3080,"safePort":"abc"}\n')
check('an invalid safePort is coerced to null', null, readPortOverride(paths)?.safePort)

writeFileSync(portFile, '{oops not json')
check('malformed JSON -> null', null, readPortOverride(paths))

writeFileSync(portFile, '"3080"\n')
check('non-object JSON (string) -> null', null, readPortOverride(paths))

writeFileSync(portFile, 'null\n')
check('non-object JSON (null) -> null', null, readPortOverride(paths))

writeFileSync(portFile, '{"safePort":3081}\n')
check('a file without a port -> null', null, readPortOverride(paths))

writeFileSync(portFile, '{"port":0}\n')
check('port 0 -> null', null, readPortOverride(paths))

writeFileSync(portFile, '{"port":65536}\n')
check('out-of-range port -> null', null, readPortOverride(paths))

writeFileSync(portFile, '{"port":"3081"}\n')
check('a string port is accepted as a number', 3081, readPortOverride(paths)?.port)

console.log('4. portSnapshot: live > override > config, and pending means "restart to apply"')
{
  const snapshot = portSnapshot({ port: 3000, safePort: 3001 })
  check('config only -> current', 3000, snapshot.current)
  check('config only -> source', 'config', snapshot.source)
  check('config only -> next', 3000, snapshot.next)
  check('config only -> nextSafe keeps the configured safe port', 3001, snapshot.nextSafe)
  check('config only -> safePort mirrors nextSafe', 3001, snapshot.safePort)
  check('config only -> no override', false, snapshot.override)
  check('config only -> nothing pending', false, snapshot.pending)
}

{
  const snapshot = portSnapshot({ livePort: 3080, port: 3000, safePort: 3001 })
  check('live wins as current', 3080, snapshot.current)
  check('live wins as source', 'live', snapshot.source)
  check('live does not change next', 3000, snapshot.next)
  check('live keeps the configured safe port', 3001, snapshot.nextSafe)
}

{
  const override = { port: 3081, safePort: null, at: '2026-11-07T01:02:03.000Z', by: 'ui' }
  const snapshot = portSnapshot({ livePort: 3080, port: 3080, override })
  check('live wins as current', 3080, snapshot.current)
  check('live wins as source', 'live', snapshot.source)
  check('override wins as next', 3081, snapshot.next)
  check('an override without safePort derives next = port + 1', 3082, snapshot.nextSafe)
  check('override flag is set', true, snapshot.override)
  check('override differs from current -> pending', true, snapshot.pending)
  check('requestedAt is carried through', '2026-11-07T01:02:03.000Z', snapshot.requestedAt)
  check('requestedBy is carried through', 'ui', snapshot.requestedBy)
}

{
  const override = { port: 3081, safePort: 3099, by: 'cli' }
  const snapshot = portSnapshot({ port: 3000, override })
  check('no live port -> current from config', 3000, snapshot.current)
  check('no live port -> source is override', 'override', snapshot.source)
  check('override -> next', 3081, snapshot.next)
  check('an explicit override safePort wins', 3099, snapshot.nextSafe)
}

{
  const snapshot = portSnapshot({ port: 3000, override: { port: 3000 } })
  check('an override equal to config keeps next', 3000, snapshot.next)
  check('an override equal to current is still an override', true, snapshot.override)
  check('override equal to current -> not pending', false, snapshot.pending)
  check('override with no safePort -> next + 1', 3001, snapshot.nextSafe)
}

{
  const snapshot = portSnapshot()
  check('nothing at all -> current 0', 0, snapshot.current)
  check('nothing at all -> next 0', 0, snapshot.next)
  check('nothing at all -> nextSafe 0', 0, snapshot.nextSafe)
  check('nothing at all -> source config', 'config', snapshot.source)
  check('nothing at all -> not pending', false, snapshot.pending)
}

console.log('5. portSnapshot from a file read on disk')
writeFileSync(portFile, '{"port":3123,"safePort":null,"by":"cli"}\n')
{
  const snapshot = portSnapshot({ livePort: 3080, port: 3080, override: readPortOverride(paths) })
  check('disk override -> next', 3123, snapshot.next)
  check('disk override -> pending', true, snapshot.pending)
  check('disk override -> nextSafe', 3124, snapshot.nextSafe)
}

rmSync(scratch, { recursive: true, force: true })

if (failed === 0) {
  console.log('all port-state tests passed')
} else {
  console.log('some port-state tests failed')
}
process.exit(failed)
