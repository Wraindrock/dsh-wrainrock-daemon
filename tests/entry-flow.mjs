// The stable entry route, end to end.
//
// One HTTP server plays both roles: a fake `dsh web` auth surface (401 without
// a cookie, `303` + `Set-Cookie` for `/?token=…`) and the daemon's own routes,
// which is what the entry bridge actually talks to. Run: `node tests/entry-flow.mjs`.
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createManager, entryKeyOf, entryStatePath } from '../index.js'

const TOKEN = 'TOKEN123'
const COOKIE = 'dsh-auth-TESTAUTH=v1.payload.signature'
const execFileAsync = promisify(execFile)

let failed = 0
function check(what, expected, actual) {
  const ok = String(expected) === String(actual)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what} (expected ${expected}, got ${actual})`)
  if (!ok) failed = 1
}

const root = mkdtempSync(join(tmpdir(), 'dwd-entry-'))
const homeDir = join(root, 'daemon')
let server
const services = new Map()
const ctx = {
  get: (name) => services.get(name),
  logger: { info() {}, warn() {}, error() {} },
}

function makeManager(config = {}) {
  return createManager(ctx, {
    homeDir,
    dshHome: join(root, 'dsh'),
    unitDir: join(root, 'units'),
    cliDir: join(root, 'cli'),
    unitName: 'dwd-entry-test-nonexistent.service',
    installOnActivate: false,
    startAtBoot: false,
    enableLinger: false,
    notify: false,
    port: 0,
    // install() refuses to write a unit whose ExecStart would expand to nothing.
    cliPath: process.execPath,
    nodeBin: process.execPath,
    ...config,
  })
}

// The fake `dsh web`: token exchange on `/`, everything else is the daemon's.
function serve(manager) {
  return new Promise((resolve) => {
    const routes = manager.routes()
    server = createServer((req, res) => {
      const path = String(req.url ?? '/').split('?')[0]
      if (path === '/') {
        const token = new URL(String(req.url), 'http://x').searchParams.get('token')
        if (token === TOKEN) {
          res.writeHead(303, { location: './', 'set-cookie': `${COOKIE}; Path=/; HttpOnly; SameSite=Strict` })
          res.end()
          return
        }
        res.writeHead(401, { 'content-type': 'text/plain' })
        res.end('dsh web authentication required; reopen the URL printed by dsh web.\n')
        return
      }
      const route = routes.find((candidate) => candidate.kind === 'exact' && candidate.path === path)
      if (route !== undefined) { route.handler(req, res); return }
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found\n')
    })
    server.listen(0, '127.0.0.1', () => {
      manager.bindPort(server.address().port)
      resolve(server.address().port)
    })
  })
}

// Does anything answer on that port at all? (A tombstone, the daemon, whatever.)
async function answers(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { redirect: 'manual', signal: AbortSignal.timeout(1500) })
    return true
  } catch {
    return false
  }
}

// The tombstone is a separate process: give it a moment to bind.
async function waitForRedirect(port, attempts = 40) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, { redirect: 'manual', signal: AbortSignal.timeout(1000) })
      if (response.status === 302) return response
    } catch { /* not listening yet */ }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return null
}

function origin() { return `http://127.0.0.1:${server.address().port}` }

async function get(path, headers = {}) {
  const res = await fetch(`${origin()}${path}`, { headers, redirect: 'manual' })
  return { status: res.status, headers: res.headers, body: await res.text() }
}

try {
  const manager = makeManager()
  server = undefined
  services.set('webServer', { port: 0, getOrigin: () => origin() })
  services.set('connection', { authenticatedUrl: (base) => `${base}?token=${TOKEN}` })
  const port = await serve(manager)
  console.log(`-- harness server on ${port}`)

  // 1. the bare origin is still gated by dsh itself
  check('bare origin without a cookie', 401, (await get('/')).status)

  // 2. /url reports both URLs
  const url = await get('/dsh-wrainrock-daemon/url')
  check('/url status', 200, url.status)
  const urlBody = JSON.parse(url.body)
  check('/url current', `${origin()}/`, urlBody.current)
  check('/url authenticated', `${origin()}/?token=${TOKEN}`, urlBody.authenticated)
  check('/url entry', `${origin()}/dsh-wrainrock-daemon/enter`, urlBody.entry)
  check('/url mode', 'loopback', urlBody.mode)
  check('/url port', port, urlBody.port)
  check('/url gate', 'ok', urlBody.gate)

  // 3. the entry route performs the exchange itself
  const entered = await get('/dsh-wrainrock-daemon/enter')
  check('enter status', 303, entered.status)
  check('enter location', '/', entered.headers.get('location'))
  check('enter cookie', COOKIE, entered.headers.getSetCookie()[0]?.split(';')[0])
  check('enter has no token in the location', false, String(entered.headers.get('location')).includes('token'))

  // 4. a proxied request is refused
  const proxied = await get('/dsh-wrainrock-daemon/enter', { 'x-forwarded-for': '203.0.113.7' })
  check('enter through a proxy', 403, proxied.status)
  check('enter through a proxy says why', true, proxied.body.includes('loopback'))
  check('proxied /url hides the token', null, JSON.parse((await get('/dsh-wrainrock-daemon/url', { 'cf-connecting-ip': '203.0.113.7' })).body).authenticated)

  // 5. a non-GET is refused on both routes
  const post = await fetch(`${origin()}/dsh-wrainrock-daemon/enter`, { method: 'POST', redirect: 'manual' })
  check('POST enter', 405, post.status)
  check('POST url', 405, (await fetch(`${origin()}/dsh-wrainrock-daemon/url`, { method: 'POST', redirect: 'manual' })).status)

  await new Promise((resolve) => server.close(resolve))

  // 6. key mode: install generates the key, and only ?k=<key> is answered
  const keyed = makeManager({ enterMode: 'key' })
  services.set('webServer', { port: 0, getOrigin: () => origin() })
  await serve(keyed)
  const install = await keyed.install()
  check('install wrote the entry key', true, existsSync(entryStatePath(keyed.paths)))
  check('install reported entry.json', true, (install.changed ?? []).includes('entry.json'))
  const key = entryKeyOf(keyed.paths)
  check('generated key is long enough', true, key.length >= 16)
  check('key survived a re-read', key, entryKeyOf(keyed.paths))

  const keyedUrl = JSON.parse((await get('/dsh-wrainrock-daemon/url')).body)
  check('key mode entry carries the key', `${origin()}/dsh-wrainrock-daemon/enter?k=${key}`, keyedUrl.entry)
  check('key mode without k', 403, (await get('/dsh-wrainrock-daemon/enter')).status)
  const refused = await get('/dsh-wrainrock-daemon/enter')
  check('key mode refusal names the key', true, refused.body.includes('key'))
  check('key mode with a wrong k', 403, (await get('/dsh-wrainrock-daemon/enter?k=nope')).status)
  const ok = await get(`/dsh-wrainrock-daemon/enter?k=${key}`)
  check('key mode with the right k', 303, ok.status)
  check('key mode sets the cookie', COOKIE, ok.headers.getSetCookie()[0]?.split(';')[0])
  await new Promise((resolve) => server.close(resolve))

  // 7. no connection service: the log is the fallback
  const logged = makeManager()
  services.delete('connection')
  await serve(logged)
  const logDir = join(homeDir, 'logs')
  mkdirSync(logDir, { recursive: true })
  writeFileSync(join(logDir, 'dsh.out.log'), `noise\ndsh web: http://127.0.0.1:${server.address().port}/?token=LOGFALLBACK\n`)
  const fallback = JSON.parse((await get('/dsh-wrainrock-daemon/url')).body)
  check('log fallback url', `${origin()}/?token=LOGFALLBACK`, fallback.authenticated)
  // The fake auth surface only accepts TOKEN, so this exchange must fail and
  // the route must fall back to a plain redirect carrying the token URL.
  const stale = await get('/dsh-wrainrock-daemon/enter')
  check('a stale log token falls back to a redirect', 302, stale.status)
  check('the redirect carries the token url', `${origin()}/?token=LOGFALLBACK`, stale.headers.get('location'))
  await new Promise((resolve) => server.close(resolve))

  // 8. key mode with a hand-written key file
  const handKey = makeManager({ enterMode: 'key' })
  mkdirSync(join(homeDir, 'state'), { recursive: true })
  writeFileSync(entryStatePath(handKey.paths), '{ "key": "SHORTKEY" }\n')
  check('a short hand-written key is ignored', '', entryKeyOf(handKey.paths))
  writeFileSync(entryStatePath(handKey.paths), '{ "key": "handwrittenkey1234567890" }\n')
  check('a long hand-written key is accepted', 'handwrittenkey1234567890', entryKeyOf(handKey.paths))
  writeFileSync(entryStatePath(handKey.paths), 'not json at all {{{\n')
  check('a broken entry.json is ignored', '', entryKeyOf(handKey.paths))
  check('readFileSync sanity', true, readFileSync(entryStatePath(handKey.paths), 'utf8').length > 0)

  // 9. the installed `dwd` command, against a daemon that is actually up
  //    NOTE: the daemon lives in THIS process, so the CLI must be run
  //    asynchronously — execFileSync would block the event loop and the
  //    request would time out.
  const cliHome = join(root, 'cli-home')
  const cli = makeManager({ homeDir: cliHome })
  services.set('connection', { authenticatedUrl: (base) => `${base}?token=${TOKEN}` })
  services.set('webServer', { port: 0, getOrigin: () => origin() })
  await serve(cli)
  const cliInstall = await cli.install()
  const cliShim = join(cliHome, 'bin', 'dwd')
  check('install wrote the dwd shim', true, existsSync(cliShim))
  const cliText = readFileSync(cliShim, 'utf8')
  check('install left no template placeholder behind', false, /@@[A-Z_]+@@/.test(cliText))
  const runDwd = async (...args) => (await execFileAsync(cliShim, args, { timeout: 20000 })).stdout.trim()
  // `dwd url` hands out the link to keep (the entry), not the one-shot token
  // URL: the token belongs to one process and dies with it.
  check('dwd url is the stable entry', `${origin()}/dsh-wrainrock-daemon/enter`, await runDwd('url'))
  check('dwd url --token is the one-shot link', `${origin()}/?token=${TOKEN}`, await runDwd('url', '--token'))
  check('dwd enter', `${origin()}/dsh-wrainrock-daemon/enter`, await runDwd('enter'))
  check('dwd status still works', true, (await runDwd('status')).includes('当前端口'))
  check('dwd status shows the entry', true, (await runDwd('status')).includes('/dsh-wrainrock-daemon/enter'))
  check('the install reported the shim', true, (cliInstall.changed ?? []).includes('dwd'))
  await new Promise((resolve) => server.close(resolve))

  // 10. the port tombstone: a browser left on the previous port finds its way.
  //     This is the case that stranded the user: the port changes, the old
  //     origin dies, and the tab that was open says nothing about where to go.
  const moveHome = join(root, 'move-home')
  const first = makeManager({ homeDir: moveHome })
  const portA = await serve(first)
  first.syncMovers()
  check('the first start records its own port', portA, (await first.status()).mover.previousPort)
  check('the first start leaves no tombstone', 0, (await first.status()).mover.records.length)
  await new Promise((resolve) => server.close(resolve))

  const second = makeManager({ homeDir: moveHome })
  const portB = await serve(second)
  const plan = second.syncMovers()
  check('the abandoned port is covered', `${portA}`, plan.spawn.join(','))
  check('the tombstone script is on disk', true, existsSync(second.paths.mover))
  const moved = await waitForRedirect(portA)
  check('a stale address is answered', 302, moved?.status)
  check('the redirect names the new entry', `http://127.0.0.1:${portB}/dsh-wrainrock-daemon/enter`, moved?.headers.get('location'))
  const landed = await fetch(moved.headers.get('location'), { redirect: 'manual' })
  check('the entry logs the browser in', 303, landed.status)
  check('the entry sets a fresh cookie', COOKIE, landed.headers.getSetCookie()[0]?.split(';')[0])
  const recorded = (await second.status()).mover.records
  check('the tombstone is recorded', `${portA}`, recorded.map((entry) => entry.from).join(','))
  check('the tombstone is a real process', true, recorded.every((entry) => entry.pid > 0))

  // ... and it lets go of the port when the daemon wants it back.
  const third = makeManager({ homeDir: moveHome, moverOnPortChange: false })
  third.bindPort(portB)
  third.syncMovers()
  check('turning it off clears the tombstones', 0, (await third.status()).mover.records.length)
  await new Promise((resolve) => setTimeout(resolve, 400))
  check('the abandoned port goes quiet again', false, await answers(portA))
  await new Promise((resolve) => server.close(resolve))

  console.log(failed === 0 ? '\nall entry-flow assertions passed' : '\nSOME entry-flow assertions FAILED')
} catch (error) {
  failed = 1
  console.log(`FAIL entry-flow harness threw: ${error?.stack ?? error}`)
} finally {
  // Tombstones outlive the test process: kill them before the temp home (and
  // the script they run) disappears.
  try {
    const file = join(homeDir, 'state', 'movers.json')
    const other = join(root, 'move-home', 'state', 'movers.json')
    for (const candidate of [file, other]) {
      if (!existsSync(candidate)) continue
      for (const entry of JSON.parse(readFileSync(candidate, 'utf8')).movers ?? []) {
        try { process.kill(entry.pid, 'SIGTERM') } catch { /* already gone */ }
      }
    }
  } catch { /* best effort */ }
  try { server?.close() } catch { /* already closed */ }
  rmSync(root, { recursive: true, force: true })
}
process.exit(failed === 0 ? 0 : 1)
