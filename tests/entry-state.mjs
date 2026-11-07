/**
 * Regression test for the stable login entry behind `dwd enter` and
 * `GET /dsh-wrainrock-daemon/enter` (2026-11-07).
 *
 * DSH web auth is a per-process launch token plus a one-time token -> cookie
 * exchange, and the cookie name is bound to the authority (host:port). So a bare
 * URL 401s, a token URL goes stale on every restart, and changing the port
 * invalidates the cookie. The daemon therefore serves a stable entry route that
 * performs the exchange server-side. Four pure helpers carry it:
 *
 *   peerIsDirectLoopback(req)          who is allowed to use the entry at all
 *   entryGate({mode, key, req})        open / loopback / key policy
 *   buildEntryUrl(origin, options)     the bookmarkable URL
 *   entryKeyOf(paths, options)         the key-mode secret in state/entry.json
 *
 * Everything runs in a temp dir; the real profile, units and `~/.dsh` are never
 * touched.
 *
 *   node tests/entry-state.mjs
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildEntryUrl, entryGate, entryKeyOf, peerIsDirectLoopback } from '../index.js'

let failed = 0
const check = (what, expected, actual) => {
  if (String(expected) === String(actual)) {
    console.log(`  ok   ${what}`)
  } else {
    console.log(`  FAIL ${what} (expected ${expected}, got ${actual})`)
    failed = 1
  }
}

const req = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers })
const ENTER = '/dsh-wrainrock-daemon/enter'
const KEY = 'K7fQ2mZp9xWvLb4TgHnRcYdEsAuJkMw1' // 32 chars, base64url alphabet

console.log('1. peerIsDirectLoopback: only a direct loopback socket, and no forwarding headers')
check('127.0.0.1 is direct loopback', true, peerIsDirectLoopback(req('127.0.0.1')))
check('::1 is direct loopback', true, peerIsDirectLoopback(req('::1')))
check('::ffff:127.0.0.1 is direct loopback', true, peerIsDirectLoopback(req('::ffff:127.0.0.1')))
check('192.168.1.5 is not loopback', false, peerIsDirectLoopback(req('192.168.1.5')))
check('10.1.2.3 is not loopback', false, peerIsDirectLoopback(req('10.1.2.3')))
check('a missing socket is not loopback', false, peerIsDirectLoopback({ headers: {} }))
check('a socket without remoteAddress is not loopback', false, peerIsDirectLoopback({ socket: {}, headers: {} }))
check('an empty remoteAddress is not loopback', false, peerIsDirectLoopback(req('')))
check('an undefined remoteAddress is not loopback', false, peerIsDirectLoopback(req(undefined)))
check('x-forwarded-for disqualifies loopback', false, peerIsDirectLoopback(req('127.0.0.1', { 'x-forwarded-for': '203.0.113.9' })))
check('cf-connecting-ip disqualifies loopback', false, peerIsDirectLoopback(req('127.0.0.1', { 'cf-connecting-ip': '203.0.113.9' })))
check('x-real-ip disqualifies loopback', false, peerIsDirectLoopback(req('127.0.0.1', { 'x-real-ip': '203.0.113.9' })))
check('forwarded disqualifies loopback', false, peerIsDirectLoopback(req('127.0.0.1', { forwarded: 'for=203.0.113.9' })))
check('an unrelated header does not disqualify loopback', true, peerIsDirectLoopback(req('127.0.0.1', { 'user-agent': 'curl/8' })))
check('no headers at all is still loopback', true, peerIsDirectLoopback(req('127.0.0.1')))

console.log('2. entryGate: open mode services everyone')
check('open + loopback -> ok', true, entryGate({ mode: 'open', req: req('127.0.0.1') }).ok)
check('open + remote peer -> ok', true, entryGate({ mode: 'open', req: req('203.0.113.9') }).ok)
check('open + forwarding headers -> ok', true, entryGate({ mode: 'open', key: '', req: req('203.0.113.9', { 'cf-connecting-ip': '203.0.113.9' }) }).ok)

console.log('3. entryGate: loopback mode (the default)')
check('loopback + direct loopback -> ok', true, entryGate({ mode: 'loopback', req: req('127.0.0.1') }).ok)
check('loopback + ::1 -> ok', true, entryGate({ mode: 'loopback', req: req('::1') }).ok)
{
  const gate = entryGate({ mode: 'loopback', req: req('192.168.1.5') })
  check('loopback + LAN peer -> not ok', false, gate.ok)
  check('loopback + LAN peer -> status', 403, gate.status)
  check('loopback + LAN peer -> reason', 'not-loopback', gate.reason)
}
{
  const gate = entryGate({ mode: 'loopback', req: req('127.0.0.1', { 'x-forwarded-for': '203.0.113.9' }) })
  check('loopback + forwarding header -> not ok', false, gate.ok)
  check('loopback + forwarding header -> reason', 'not-loopback', gate.reason)
}
{
  const gate = entryGate({ mode: 'loopback', req: { headers: {} } })
  check('loopback + no socket -> not ok', false, gate.ok)
  check('loopback + no socket -> reason', 'not-loopback', gate.reason)
}

console.log('4. entryGate: key mode')
check('key + matching k -> ok', true, entryGate({ mode: 'key', key: KEY, req: { url: `${ENTER}?k=${KEY}`, socket: { remoteAddress: '127.0.0.1' }, headers: {} } }).ok)
check('key + matching k from a remote peer -> ok (that is the point of the tunnel)', true, entryGate({ mode: 'key', key: KEY, req: { url: `${ENTER}?k=${KEY}`, socket: { remoteAddress: '203.0.113.9' }, headers: { 'cf-connecting-ip': '203.0.113.9' } } }).ok)
check('key + k among other query params -> ok', true, entryGate({ mode: 'key', key: KEY, req: { url: `${ENTER}?x=1&k=${KEY}`, socket: { remoteAddress: '127.0.0.1' }, headers: {} } }).ok)
{
  const gate = entryGate({ mode: 'key', key: KEY, req: { url: `${ENTER}?k=wrong-key`, socket: { remoteAddress: '127.0.0.1' }, headers: {} } })
  check('key + wrong k -> not ok', false, gate.ok)
  check('key + wrong k -> status', 403, gate.status)
  check('key + wrong k -> reason', 'key-invalid', gate.reason)
}
{
  const gate = entryGate({ mode: 'key', key: KEY, req: { url: ENTER, socket: { remoteAddress: '127.0.0.1' }, headers: {} } })
  check('key + no k at all -> not ok', false, gate.ok)
  check('key + no k at all -> reason', 'key-invalid', gate.reason)
}
{
  const gate = entryGate({ mode: 'key', key: '', req: { url: `${ENTER}?k=`, socket: { remoteAddress: '127.0.0.1' }, headers: {} } })
  check('key mode with no configured key -> not ok', false, gate.ok)
  check('key mode with no configured key -> status', 403, gate.status)
  check('key mode with no configured key -> reason', 'key-missing', gate.reason)
}
{
  const gate = entryGate({ mode: 'key', key: '', req: { url: `${ENTER}?k=${KEY}`, socket: { remoteAddress: '127.0.0.1' }, headers: {} } })
  check('key mode with no configured key ignores the supplied k', false, gate.ok)
  check('key mode with no configured key -> reason key-missing', 'key-missing', gate.reason)
}

console.log('5. buildEntryUrl: the bookmarkable URL')
check('defaults (loopback, default prefix)', 'http://127.0.0.1:3080/dsh-wrainrock-daemon/enter', buildEntryUrl('http://127.0.0.1:3080'))
check('defaults keep no query string', '', String(new URL(buildEntryUrl('http://127.0.0.1:3080')).search))
check('key mode adds ?k=', `http://127.0.0.1:3080/dsh-wrainrock-daemon/enter?k=${KEY}`, buildEntryUrl('http://127.0.0.1:3080', { mode: 'key', key: KEY }))
check('key mode with an empty key adds no query', 'http://127.0.0.1:3080/dsh-wrainrock-daemon/enter', buildEntryUrl('http://127.0.0.1:3080', { mode: 'key', key: '' }))
check('open mode adds no query', 'http://127.0.0.1:3080/dsh-wrainrock-daemon/enter', buildEntryUrl('http://127.0.0.1:3080', { mode: 'open', key: KEY }))
check('loopback mode ignores a key', 'http://127.0.0.1:3080/dsh-wrainrock-daemon/enter', buildEntryUrl('http://127.0.0.1:3080', { mode: 'loopback', key: KEY }))
check('a custom prefix is used', 'http://127.0.0.1:3080/pfx/enter', buildEntryUrl('http://127.0.0.1:3080', { prefix: '/pfx' }))
check('a trailing slash on the origin is not doubled', 'http://127.0.0.1:3080/dsh-wrainrock-daemon/enter', buildEntryUrl('http://127.0.0.1:3080/'))
check('a trailing slash on the prefix is not doubled', 'http://127.0.0.1:3080/pfx/enter', buildEntryUrl('http://127.0.0.1:3080', { prefix: '/pfx/' }))
// A prefix without a leading slash is not normalised (`origin + prefix + '/enter'`,
// literally); the default and every documented caller pass one with the slash.
check('the given prefix is used verbatim', 'http://127.0.0.1:3080pfx/enter', buildEntryUrl('http://127.0.0.1:3080', { prefix: 'pfx' }))
check('a public origin is used as-is', 'https://gui.example.com/dsh-wrainrock-daemon/enter', buildEntryUrl('https://gui.example.com'))
check('key mode on a public origin', `https://gui.example.com/dsh-wrainrock-daemon/enter?k=${KEY}`, buildEntryUrl('https://gui.example.com', { mode: 'key', key: KEY }))

const scratch = mkdtempSync(join(tmpdir(), 'dsh-entry-'))
const paths = { stateDir: scratch }
const entryFile = join(scratch, 'entry.json')

console.log('6. entryKeyOf: a valid key or nothing')
rmSync(entryFile, { force: true })
check('an absent file -> empty string', '', entryKeyOf(paths))

writeFileSync(entryFile, `{"key":"${KEY}","at":"2026-11-07T00:00:00.000Z"}\n`)
check('a valid base64url key is returned', KEY, entryKeyOf(paths))

writeFileSync(entryFile, '{oops not json')
check('malformed JSON -> empty string', '', entryKeyOf(paths))

writeFileSync(entryFile, '"just a string"\n')
check('non-object JSON -> empty string', '', entryKeyOf(paths))

writeFileSync(entryFile, 'null\n')
check('null JSON -> empty string', '', entryKeyOf(paths))

writeFileSync(entryFile, '{"at":"2026-11-07T00:00:00.000Z"}\n')
check('a file without a key -> empty string', '', entryKeyOf(paths))

writeFileSync(entryFile, '{"key":""}\n')
check('an empty key -> empty string', '', entryKeyOf(paths))

writeFileSync(entryFile, '{"key":"short"}\n')
check('a too-short key -> empty string', '', entryKeyOf(paths))

writeFileSync(entryFile, `{"key":"${'a'.repeat(15)}"}\n`)
check('15 chars is still too short', '', entryKeyOf(paths))

writeFileSync(entryFile, `{"key":"${'a'.repeat(16)}"}\n`)
check('16 chars is long enough', 'a'.repeat(16), entryKeyOf(paths))

writeFileSync(entryFile, '{"key":12345678901234567890}\n')
check('a non-string key -> empty string', '', entryKeyOf(paths))

writeFileSync(entryFile, `{"key":"${KEY}!"}\n`)
check('a key outside the base64url alphabet -> empty string', '', entryKeyOf(paths))

writeFileSync(entryFile, `{"key":"${KEY}="}\n`)
check('base64 padding is not allowed in a base64url key', '', entryKeyOf(paths))

writeFileSync(entryFile, '{"key":null}\n')
check('a null key -> empty string', '', entryKeyOf(paths))

{
  const other = join(scratch, 'custom.json')
  writeFileSync(other, `{"key":"${KEY}","at":"2026-11-07T00:00:00.000Z"}\n`)
  check('options.file overrides the default path', KEY, entryKeyOf(paths, { file: other }))
  check('a missing options.file -> empty string', '', entryKeyOf(paths, { file: join(scratch, 'nope.json') }))
}

{
  const empty = join(scratch, 'empty')
  check('a stateDir without entry.json -> empty string', '', entryKeyOf({ stateDir: empty }))
}

rmSync(scratch, { recursive: true, force: true })

if (failed === 0) {
  console.log('all entry-state assertions passed')
} else {
  console.log('some entry-state assertions failed')
}
process.exit(failed)
