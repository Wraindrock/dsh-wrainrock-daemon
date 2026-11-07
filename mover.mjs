#!/usr/bin/env node
/**
 * The tombstone for a port this daemon left behind.
 *
 * Changing the port restarts the child, and the old port dies with it: a tab or
 * a bookmark still pointing there gets "connection refused" and no hint about
 * where the daemon went. This tiny server keeps answering on the abandoned port
 * and sends every request to the *current* port's login entry, which mints a
 * fresh token and cookie, so a stale address recovers by itself.
 *
 * It binds loopback only, never touches the app, and exits quietly when the
 * port is taken. The host half starts one per abandoned port (`node mover.mjs
 * --from A --to B --home <homeDir>`) and kills it when the daemon comes back to
 * that port; `supervisor.sh` clears the way before the child starts.
 *
 * Usage: node mover.mjs --from <port> --to <port> [--home <homeDir>]
 *        [--prefix /dsh-wrainrock-daemon]
 */

import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function argValue(name, fallback = '') {
  const index = process.argv.indexOf(name)
  if (index < 0) return fallback
  const value = process.argv[index + 1]
  return typeof value === 'string' && value !== '' ? value : fallback
}

function portOf(value) {
  const text = String(value ?? '').trim()
  if (!/^[0-9]{1,5}$/.test(text)) return 0
  const port = Number(text)
  return port >= 1 && port <= 65535 ? port : 0
}

const fromPort = portOf(argValue('--from', '0'))
const toPort = portOf(argValue('--to', '0'))
const homeDir = argValue('--home', '')
const prefix = argValue('--prefix', '/dsh-wrainrock-daemon').replace(/\/+$/, '') || '/dsh-wrainrock-daemon'

// Nothing to do without a port to hold and a port to point at.
if (fromPort === 0) process.exit(0)

function runtimePort() {
  if (homeDir === '') return toPort
  try {
    const raw = readFileSync(join(homeDir, 'state', 'runtime.json'), 'utf8')
    const record = JSON.parse(raw)
    const port = portOf(record?.port)
    if (port > 0) return port
  } catch { /* not written yet, or the daemon went away */ }
  return toPort
}

function entryUrl(port) {
  return `http://127.0.0.1:${port}${prefix}/enter`
}

const server = createServer((req, res) => {
  const port = runtimePort()
  if (port === 0) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    res.end('the daemon is not running; there is no port to forward to\n')
    return
  }
  // 302 rather than 303: a bookmark that is retried, a tab that is reloaded and
  // a form that is re-submitted all end up at the same entry.
  res.writeHead(302, {
    location: entryUrl(port),
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  })
  res.end()
})

server.on('error', () => {
  // EADDRINUSE and friends: whoever holds the port now is not ours to argue
  // with, and a tombstone that cannot listen is not an error worth logging.
  process.exit(0)
})

server.listen(fromPort, '127.0.0.1')
