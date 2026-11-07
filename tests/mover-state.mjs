/**
 * Regression test for the port-move notice service (2026-11-07).
 *
 * Changing the listen port abandons the old one: the old process is gone, the
 * old origin refuses connections, and the cookie minted for `127.0.0.1:A` does
 * not fit `127.0.0.1:B`. So a bookmark or a stale tab just dies with no hint.
 * The daemon therefore leaves a tiny `302`-only service on the abandoned port
 * that sends every old address to the new port's entry. Two pure helpers carry
 * the bookkeeping:
 *
 *   moverRecordPath(paths)                where the records live
 *   readMoverRecords(paths, options)      tolerant reader, never throws
 *   planMovers({records, previousPort, currentPort, enabled})
 *                                         kill / spawn / keep decision
 *
 * Everything runs in a temp dir; the real profile, units and `~/.dsh` are never
 * touched.
 *
 *   node tests/mover-state.mjs
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { moverRecordPath, planMovers, readMoverRecords } from '../index.js'

let failed = 0
const check = (what, expected, actual) => {
  if (String(expected) === String(actual)) {
    console.log(`  ok   ${what}`)
  } else {
    console.log(`  FAIL ${what} (expected ${expected}, got ${actual})`)
    failed = 1
  }
}

const scratch = mkdtempSync(join(tmpdir(), 'dsh-mover-'))
const paths = { stateDir: scratch }
const recordFile = join(scratch, 'movers.json')

/** Call something that must not throw, and report a throw as its own value. */
const noThrow = (fn) => {
  try {
    return JSON.stringify(fn())
  } catch (error) {
    return `threw:${error?.message ?? error}`
  }
}
const write = (text) => writeFileSync(recordFile, text)
const sum = (plan) => {
  const nums = (list) => [...list].sort((a, b) => a - b).join(',')
  const keeps = (list) => list.map((entry) => `${entry.from}:${entry.pid}`).sort().join(',')
  return `kill[${nums(plan.kill)}] spawn[${nums(plan.spawn)}] keep[${keeps(plan.keep)}]`
}
const rec = (from, pid, at = '2026-11-07T00:00:00.000Z') => ({ from, pid, at })

console.log('1. moverRecordPath: the record lives in the state dir')
check('joins stateDir with movers.json', join(scratch, 'movers.json'), moverRecordPath(paths))

console.log('2. readMoverRecords: tolerant of anything on disk')
rmSync(recordFile, { force: true })
check('an absent file -> no records', '[]', noThrow(() => readMoverRecords(paths)))

write(JSON.stringify({ movers: [rec(3080, 11), rec(3081, 12)] }))
{
  const records = readMoverRecords(paths)
  check('two valid records are read', 2, records.length)
  check('their from values survive', '3080,3081', records.map((entry) => entry.from).join(','))
  check('their pid values survive', '11,12', records.map((entry) => entry.pid).join(','))
  check('their at value survives', '2026-11-07T00:00:00.000Z', records[0]?.at)
}

write('{oops not json')
check('malformed JSON -> no records', '[]', noThrow(() => readMoverRecords(paths)))

write('null\n')
check('null JSON -> no records', '[]', noThrow(() => readMoverRecords(paths)))

write('42\n')
check('a number is not a record file', '[]', noThrow(() => readMoverRecords(paths)))

write('"movers"\n')
check('a string is not a record file', '[]', noThrow(() => readMoverRecords(paths)))

write('{}\n')
check('an object without a movers key -> no records', '[]', noThrow(() => readMoverRecords(paths)))

write('{"movers":null}\n')
check('a null movers list -> no records', '[]', noThrow(() => readMoverRecords(paths)))

write('{"movers":"nope"}\n')
check('a string movers list -> no records', '[]', noThrow(() => readMoverRecords(paths)))

write('{"movers":{}}\n')
check('an object movers list -> no records', '[]', noThrow(() => readMoverRecords(paths)))

write('{"movers":[{"from":3080,"pid":11,"at":"a"},{"from":3081,"pid":12,"at":"b"},{"from":3082,"pid":13,"at":"c"}]}\n')
check('three valid records are read', '3080,3081,3082', readMoverRecords(paths).map((entry) => entry.from).join(','))

write(JSON.stringify({
  movers: [
    rec(3080, 123),
    { from: 0, pid: 2, at: 'x' },
    { from: 65536, pid: 3, at: 'x' },
    { from: -1, pid: 4, at: 'x' },
    { from: 1.5, pid: 5, at: 'x' },
    { from: null, pid: 6, at: 'x' },
    { from: 'abc', pid: 7, at: 'x' },
    { from: 3082, pid: 0, at: 'x' },
    { from: 3083, pid: -1, at: 'x' },
    { from: 3084, pid: null, at: 'x' },
    { from: 3085, pid: 'junk', at: 'x' },
    null,
    42,
    'junk',
    { pid: 10, at: 'x' },
    { from: 3086, at: 'x' },
  ],
}))
{
  const records = readMoverRecords(paths)
  check('only the one well-formed record survives', 1, records.length)
  check('the survivor keeps its from', 3080, records[0]?.from)
  check('the survivor keeps its pid', 123, records[0]?.pid)
}

// The reader coerces ports and pids with the same `parsePortValue` / `parseInt`
// rules as `state/port.json`, so numeric strings are accepted and a pid is only
// required to be a positive integer — not bounded by 65535. These assertions
// document the code as it stands (reported to the lead as a contract deviation).
write(JSON.stringify({ movers: [{ from: '3081', pid: '6', at: 'x' }] }))
check('a numeric-string from is coerced (deviation: contract said integer)', 3081, readMoverRecords(paths)[0]?.from)
check('a numeric-string pid is coerced (deviation: contract said integer)', 6, readMoverRecords(paths)[0]?.pid)
check('a coerced-record file holds one entry', 1, readMoverRecords(paths).length)

write(JSON.stringify({ movers: [{ from: 3080, pid: 65536, at: 'x' }] }))
check('a pid above 65535 is kept (deviation: contract said drop it)', 1, readMoverRecords(paths).length)
check('its pid is untouched', 65536, readMoverRecords(paths)[0]?.pid)

write(JSON.stringify({ movers: [{ from: 3080, pid: 2.5, at: 'x' }] }))
check('a fractional pid is truncated to its integer part', 2, readMoverRecords(paths)[0]?.pid)

// A top-level array is accepted in addition to the documented `{movers:[…]}`
// wrapper; harmless superset, recorded here so it stays deliberate.
write('[{"from":3081,"pid":13,"at":"x"}]\n')
check('a bare array of records is also accepted (superset)', '3081:13',
  readMoverRecords(paths).map((entry) => `${entry.from}:${entry.pid}`).join(','))

{
  const other = join(scratch, 'other.json')
  writeFileSync(other, JSON.stringify({ movers: [rec(3099, 21)] }))
  check('options.file overrides the default path', '3099:21', readMoverRecords(paths, { file: other }).map((entry) => `${entry.from}:${entry.pid}`).join(','))
  check('a missing options.file -> no records', '[]', noThrow(() => readMoverRecords(paths, { file: join(scratch, 'nope.json') })))
}

// A directory is unreadable as a file; the reader promises to swallow it.
check('reading a directory does not throw', '[]', noThrow(() => readMoverRecords(paths, { file: scratch })))
check('an empty stateDir -> no records', '[]', noThrow(() => readMoverRecords({ stateDir: join(scratch, 'empty') })))

console.log('3. planMovers: who to kill, what to spawn, what to keep')
const plan = (options) => sum(planMovers(options))

check('enabled:false kills everything and keeps nothing', 'kill[11,12] spawn[] keep[]',
  plan({ records: [rec(3080, 11), rec(3081, 12)], previousPort: 3080, currentPort: 3081, enabled: false }))
check('enabled:false with no records still decides nothing', 'kill[] spawn[] keep[]',
  plan({ records: [], previousPort: 3080, currentPort: 3081, enabled: false }))
check('enabled defaults to true', 'kill[] spawn[3080] keep[]',
  plan({ records: [], previousPort: 3080, currentPort: 3081 }))
check('a normal move spawns a mover on the abandoned port', 'kill[] spawn[3080] keep[]',
  plan({ records: [], previousPort: 3080, currentPort: 3081 }))
check('unrelated ports are kept while the abandoned port is spawned', 'kill[] spawn[3080] keep[3070:41]',
  plan({ records: [rec(3070, 41)], previousPort: 3080, currentPort: 3081 }))
check('a record on the port we now use is killed', 'kill[21] spawn[3080] keep[]',
  plan({ records: [rec(3081, 21)], previousPort: 3080, currentPort: 3081 }))
check('every record on the current port is killed', 'kill[111,112] spawn[3080] keep[]',
  plan({ records: [rec(3081, 111), rec(3081, 112)], previousPort: 3080, currentPort: 3081 }))
check('a record on the abandoned port is kept, not spawned twice', 'kill[] spawn[] keep[3080:51]',
  plan({ records: [rec(3080, 51)], previousPort: 3080, currentPort: 3081 }))
check('kills and keeps coexist on a mixed move', 'kill[81] spawn[] keep[3080:82]',
  plan({ records: [rec(3081, 81), rec(3080, 82)], previousPort: 3080, currentPort: 3081 }))
check('two unrelated ports are kept', 'kill[] spawn[3080] keep[3070:91,3090:92]',
  plan({ records: [rec(3070, 91), rec(3090, 92)], previousPort: 3080, currentPort: 3081 }))

check('previousPort 0 is not a port', 'kill[] spawn[] keep[]',
  plan({ records: [], previousPort: 0, currentPort: 3081 }))
check('previousPort 65536 is out of range', 'kill[] spawn[] keep[]',
  plan({ records: [], previousPort: 65536, currentPort: 3081 }))
check('previousPort -1 is not a port', 'kill[] spawn[] keep[]',
  plan({ records: [], previousPort: -1, currentPort: 3081 }))
check('previousPort 1.5 is not an integer port', 'kill[] spawn[] keep[]',
  plan({ records: [], previousPort: 1.5, currentPort: 3081 }))
check("previousPort 'abc' is not a port", 'kill[] spawn[] keep[]',
  plan({ records: [], previousPort: 'abc', currentPort: 3081 }))
check("previousPort '3080' is coerced and spawned (deviation: contract said not a port)", 'kill[] spawn[3080] keep[]',
  plan({ records: [], previousPort: '3080', currentPort: 3081 }))
check('a missing previousPort spawns nothing', 'kill[] spawn[] keep[]',
  plan({ records: [], previousPort: undefined, currentPort: 3081 }))
check('previousPort === currentPort spawns nothing', 'kill[] spawn[] keep[]',
  plan({ records: [], previousPort: 3081, currentPort: 3081 }))
check('a record on the current port is still killed when both ports match', 'kill[61] spawn[] keep[]',
  plan({ records: [rec(3081, 61)], previousPort: 3081, currentPort: 3081 }))

{
  const p = planMovers({ records: [rec(3080, 71), rec(3080, 72)], previousPort: 3080, currentPort: 3081 })
  check('one of two duplicates is killed', 1, p.kill.length)
  check('the other duplicate is kept', 1, p.keep.length)
  check('both duplicate pids are accounted for', '71,72',
    [...p.kill, ...p.keep.map((entry) => entry.pid)].sort((a, b) => a - b).join(','))
  check('a port already kept is not spawned again', 0, p.spawn.length)
}

{
  const p = planMovers({ records: [rec(3080, 73), rec(3080, 74), rec(3080, 75)], previousPort: 3080, currentPort: 3081 })
  check('two of three duplicates are killed', 2, p.kill.length)
  check('exactly one duplicate survives', 1, p.keep.length)
  check('all three duplicate pids are accounted for', '73,74,75',
    [...p.kill, ...p.keep.map((entry) => entry.pid)].sort((a, b) => a - b).join(','))
}

{
  const p = planMovers({ records: [rec(3080, 81)], previousPort: 3080, currentPort: 3081 })
  check('kill is an array', true, Array.isArray(p.kill))
  check('spawn is an array', true, Array.isArray(p.spawn))
  check('keep is an array', true, Array.isArray(p.keep))
  check('keep entries carry from and pid', '3080:81', `${p.keep[0]?.from}:${p.keep[0]?.pid}`)
}

check('an empty record list with an invalid previousPort is a no-op', 'kill[] spawn[] keep[]',
  plan({ records: [], previousPort: 0, currentPort: 0 }))

rmSync(scratch, { recursive: true, force: true })

if (failed === 0) {
  console.log('all mover-state assertions passed')
} else {
  console.log('some mover-state assertions failed')
}
process.exit(failed)
