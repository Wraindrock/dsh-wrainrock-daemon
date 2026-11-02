/**
 * Regression test for how two systemd user managers are reported.
 *
 * On 2026-11-02 the warning told the user to "stop the extra manager". That is
 * wrong for distrobox/podman: the host and the container each run a user
 * manager for the same uid, both read the same `~/.config/systemd/user`, and
 * neither is redundant. The plugin has to pin the unit to one side instead, and
 * say so.
 *
 *   node tests/manager-advice.mjs
 */
import { managerAdvice, containerKind, renderUnits, unitWord, unitExecArg } from '../index.js'

let failed = 0
const check = (what, expected, actual) => {
  const ok = String(expected) === String(actual)
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : ` (expected ${expected}, got ${actual})`}`)
  if (!ok) failed = 1
}
const has = (text, needle) => String(text ?? '').includes(needle)

console.log('1. one manager is never worth a warning')
check('single manager', 'undefined', String(managerAdvice({ ids: ['user@1000.service'] })))

console.log('2. duplicated managers on a real host still advise removing one')
const host = managerAdvice({ ids: ['user@1000.service', 'user@ian.service'], container: 'none', unitName: 'dsh-wrainrock-daemon.service', port: 3080 })
check('mentions stopping the extra manager', true, has(host, 'stopping the extra manager'))
check('names the port', true, has(host, 'port 3080'))

console.log('3. a host + container split is reported as normal, not as a fault')
const boxed = managerAdvice({ ids: ['user@1000.service', 'user@wraindrock.service'], container: 'podman', containerOnly: true })
check('names distrobox/podman', true, has(boxed, 'distrobox/podman'))
check('says it is not a misconfiguration', true, has(boxed, 'not a misconfiguration'))
check('does not tell the user to remove a manager', false, has(boxed, 'stopping the extra manager'))
check('says the unit is pinned to the container', true, has(boxed, 'ConditionVirtualization=container'))

console.log('4. containerOnly=false still explains the split without the pin')
const unpinned = managerAdvice({ ids: ['user@1000.service', 'user@wraindrock.service'], container: 'podman', containerOnly: false })
check('no pin claimed', false, has(unpinned, 'ConditionVirtualization=container'))

console.log('5. the pin renders into both generated units')
const values = {
  SUPERVISOR_EXEC: `/bin/bash ${unitExecArg('/tmp/supervisor.sh')}`,
  SAFE_SUPERVISOR_EXEC: `/bin/bash ${unitExecArg('/tmp/supervisor.sh')} --force-safe`,
  ENV_DSH_HOME: unitWord('DSH_HOME=/tmp/.dsh'),
  ENV_PATH: unitWord('PATH=/usr/bin:/bin'),
  SAFE_UNIT: 'dsh-wrainrock-daemon-safemode.service',
  MAIN_UNIT: 'dsh-wrainrock-daemon.service',
  CONDITION: 'ConditionVirtualization=container',
}
const units = renderUnits(values)
for (const [name, text] of [['main', units.main], ['safe', units.safe]]) {
  check(`${name} unit pinned`, true, /^ConditionVirtualization=container$/m.test(text))
}

console.log('6. without the pin the units stay host-generic')
const plain = renderUnits({ ...values, CONDITION: '' })
for (const [name, text] of [['main', plain.main], ['safe', plain.safe]]) {
  check(`${name} unit has no condition`, false, /ConditionVirtualization/.test(text))
  check(`${name} unit has no bare placeholder`, false, /@@[A-Z_]+@@/.test(text))
}

console.log('7. containerKind answers without throwing')
check('returns a string', 'string', typeof containerKind())

if (failed === 0) console.log('all manager-advice tests passed')
else console.log('some manager-advice tests failed')
process.exit(failed)
