/**
 * Regression test for generated systemd units on a home directory that contains
 * a space.
 *
 * The reported bug (2026-10-31, `$HOME=/var/home/u/Distrobox/deepseek harness`):
 * the units were rendered without quoting, so systemd split
 *
 *   ExecStart=/bin/bash /var/home/u/Distrobox/deepseek harness/.dsh/.../supervisor.sh
 *
 * into two words and ran `/bin/bash /var/home/u/Distrobox/deepseek`, which exits
 * 127. The supervisor was never reached, five rapid failures tripped
 * `StartLimitBurst`, and the `OnFailure=` safe-mode unit failed the same way
 * every 15s — autostart, crash recovery and the 重启 button were all dead.
 *
 *   node tests/unit-quoting.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { unitWord, unitExecArg, renderUnits } from '../index.js'

const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
let failed = 0

const check = (what, expected, actual) => {
  const ok = String(expected) === String(actual)
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : ` (expected ${expected}, got ${actual})`}`)
  if (!ok) failed = 1
}

console.log('1. unitWord groups one word and survives quotes/backslashes')
check('plain', '"a b"', unitWord('a b'))
check('quote', '"a \\"b\\""', unitWord('a "b"'))
check('backslash', '"a \\\\b"', unitWord('a \\b'))

console.log('2. unitExecArg also neutralises % specifiers and $ variables')
check('percent', '"100%% done"', unitExecArg('100% done'))
check('dollar', '"$$HOME"', unitExecArg('$HOME'))

// The exact shape the incident had: a home directory with a space in it.
const scratch = mkdtempSync(join(tmpdir(), 'dsh-unit-'))
try {
  const home = join(scratch, 'home with space')
  const script = join(home, 'bin', 'supervisor.sh')
  mkdirSync(dirname(script), { recursive: true })
  writeFileSync(script, '#!/bin/bash\nsleep 30\n')
  chmodSync(script, 0o755)

  const units = renderUnits({
    HOME_DIR: home,
    DSH_HOME: join(home, '.dsh'),
    SUPERVISOR_EXEC: `/bin/bash ${unitExecArg(script)}`,
    SAFE_SUPERVISOR_EXEC: `/bin/bash ${unitExecArg(script)} --force-safe`,
    ENV_DSH_HOME: unitWord(`DSH_HOME=${join(home, '.dsh')}`),
    ENV_PATH: unitWord('PATH=/usr/local/bin:/usr/bin:/bin'),
    SAFE_UNIT: 'dsh-wrainrock-daemon-safemode.service',
    MAIN_UNIT: 'dsh-wrainrock-daemon.service',
    CONDITION: '',
  })

  console.log('3. ExecStart keeps the spaced path as one argument')
  check('main ExecStart', `ExecStart=/bin/bash "${script}"`, (units.main.match(/^ExecStart=.*$/m) || [''])[0])
  check('safe ExecStart', `ExecStart=/bin/bash "${script}" --force-safe`, (units.safe.match(/^ExecStart=.*$/m) || [''])[0])

  console.log('4. Environment values are quoted too')
  const envLines = units.main.split('\n').filter((line) => line.startsWith('Environment='))
  check('both Environment= lines quoted', 2, envLines.filter((line) => /^Environment="[^"]*"$/.test(line)).length)

  console.log('5. systemd itself accepts the rendered unit (skipped when absent)')
  const probe = spawnSync('systemd-analyze', ['--version'], { encoding: 'utf8' })
  if (probe.error) {
    console.log('  skip systemd-analyze is not installed')
  } else {
    for (const [name, text] of [
      ['dsh-wrainrock-daemon.service', units.main],
      ['dsh-wrainrock-daemon-safemode.service', units.safe],
    ]) {
      const file = join(scratch, name)
      // The safe unit is OnFailure= of the main one; verify would only complain
      // that it cannot load the other unit, which is not what this tests.
      writeFileSync(file, text.replace(/^OnFailure=.*$/m, '').replace(/^After=.*\.service$/m, ''))
      const verify = spawnSync('systemd-analyze', ['verify', file], { encoding: 'utf8' })
      const output = `${verify.stdout}${verify.stderr}`
      check(`${name} has no unparsable ExecStart`, false, /is not executable|Invalid|Failed to parse/.test(output))
      if (/is not executable|Invalid|Failed to parse/.test(output)) console.log(output.trim())
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

// Guard the templates themselves: a raw @@TOKEN@@ on an ExecStart=/Environment=
// line means someone reintroduced an unquoted value.
console.log('6. shipped templates never put a bare placeholder in ExecStart/Environment')
for (const file of ['units/dsh-wrainrock-daemon.service.in', 'units/dsh-wrainrock-daemon-safemode.service.in']) {
  const text = spawnSync('cat', [join(PLUGIN_DIR, file)], { encoding: 'utf8' }).stdout
  const bad = text.split('\n').filter((line) => /^(ExecStart|Environment)=/.test(line) && !/^[A-Za-z]+=(@@[A-Z_]+@@|".*")$/.test(line))
  check(`${file} has no unquoted line`, 0, bad.length)
  if (bad.length > 0) console.log(bad.join('\n'))
}

if (failed === 0) console.log('all unit-quoting tests passed')
else console.log('some unit-quoting tests failed')
process.exit(failed)
