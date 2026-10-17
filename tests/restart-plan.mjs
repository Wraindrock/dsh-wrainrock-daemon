/**
 * Regression test for the "重启" action's policy.
 *
 * The reported bug (2026-10-17): the panel reported a successful restart while
 * nothing restarted. An account with two systemd user managers (user@1000.service
 * and user@ian.service) runs this unit twice; `systemctl --user` reaches only one
 * of them, and the unit's MainPID then belongs to the *other* manager — so a
 * plain restart restarted the idle standby instance and the serving process kept
 * the port forever.
 *
 * `decideRestartPlan` is the pure decision the host half uses; this drives it.
 *
 *   node tests/restart-plan.mjs
 */
import { decideRestartPlan } from '../index.js'

let failed = 0
const check = (what, expected, actual) => {
  if (String(expected) === String(actual)) {
    console.log(`  ok   ${what}`)
  } else {
    console.log(`  FAIL ${what} (expected ${expected}, got ${actual})`)
    failed = 1
  }
}

console.log('1. one manager: the unit we would restart is the one running us')
check('action', 'systemd', decideRestartPlan({
  managed: true, enabled: true, unitMainPid: 500, supervisorPid: 500,
}).action)

console.log('2. two managers: the unit belongs to the other manager, so the helper must do it')
{
  const plan = decideRestartPlan({ managed: true, enabled: true, unitMainPid: 900, supervisorPid: 500 })
  check('action', 'systemd-kill', plan.action)
  check('the reason names the cause', 'true', String(plan.reason).includes('another systemd user manager'))
}

console.log('3. an unknown MainPID never forces the helper path')
check('action', 'systemd', decideRestartPlan({
  managed: true, enabled: true, unitMainPid: 0, supervisorPid: 500,
}).action)

console.log('4. runs that are not unit-managed keep the handoff policy')
check('autostart enabled', 'systemd-handoff', decideRestartPlan({
  managed: false, enabled: true, unitMainPid: 0, supervisorPid: 0,
}).action)
check('autostart disabled', 'relaunch', decideRestartPlan({
  managed: false, enabled: false, unitMainPid: 0, supervisorPid: 0,
}).action)

if (failed === 0) {
  console.log('all restart-plan tests passed')
} else {
  console.log('some restart-plan tests failed')
}
process.exit(failed)
