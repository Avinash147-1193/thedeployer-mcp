#!/usr/bin/env node
// The Deployer's MCP server, for AI coding tools that start MCP servers as a local command.
//
// This is a bridge, not the tools: it reads MCP messages (JSON-RPC, one per line) from stdin, sends each
// to The Deployer's hosted MCP endpoint over HTTPS, and writes the answers to stdout. The tools run on
// The Deployer, so this file doesn't change when they do, and it has no dependencies to audit.
//
//   THEDEPLOYER_API_KEY     a personal API key (The Deployer, Profile). Without one, only check_repo works.
//   THEDEPLOYER_MCP_URL     the endpoint, when it isn't https://app.thedploy.com/api/v1/mcp
//   THEDEPLOYER_TIMEOUT_MS  how long to wait for one answer, from 1000 to 600000 (default 200000)
//
// What it promises: stdout carries only JSON-RPC 2.0 messages and logs go to stderr, every request gets
// exactly one answer unless the client cancels it, and the key goes nowhere but the Authorization header.

import { createInterface } from 'node:readline'

const VERSION = '0.2.0'
const DEFAULT_ENDPOINT = 'https://app.thedploy.com/api/v1/mcp'
const DEFAULT_TIMEOUT_MS = 200000
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost'])
const TOKEN = /^[\x21-\x7e]+$/ // printable ASCII without spaces: all a key, a session id or a version holds

if (process.argv.includes('--version')) {
  process.stdout.write(`${VERSION}\n`)
  process.exit(0)
}
if (process.argv.includes('--help')) {
  process.stdout.write('thedeployer-mcp: The Deployer\'s MCP server over stdio. Set THEDEPLOYER_API_KEY; see README.md.\n')
  process.exit(0)
}

function log(text) {
  process.stderr.write(`thedeployer-mcp: ${text}\n`)
}

// Settings are checked once, at startup, and their values are never repeated back: a key pasted into the
// wrong variable mustn't end up in a log. A bad key or URL stops anything from being sent, and every
// request is answered with the reason, so the editor can show it.
const problems = []

const API_KEY = (process.env.THEDEPLOYER_API_KEY || '').trim()
if (API_KEY && !TOKEN.test(API_KEY)) {
  problems.push("THEDEPLOYER_API_KEY isn't a valid key: it has spaces, line breaks or other characters a key never has. Copy it again from your Profile page in The Deployer.")
}

const URL_SETTING = (process.env.THEDEPLOYER_MCP_URL || '').trim()
let endpoint = new URL(DEFAULT_ENDPOINT)
if (URL_SETTING) {
  let url = null
  try {
    url = new URL(URL_SETTING)
  } catch {
    // reported just below
  }
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
    problems.push("THEDEPLOYER_MCP_URL isn't a valid https:// address.")
  } else if (url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname)) {
    problems.push('THEDEPLOYER_MCP_URL must start with https://. Plain http:// only works for 127.0.0.1, ::1 and localhost.')
  } else if (url.username || url.password) {
    problems.push("THEDEPLOYER_MCP_URL can't contain a user name or password. Put your key in THEDEPLOYER_API_KEY.")
  } else {
    url.hash = ''
    endpoint = url
    log(`sending MCP messages to ${url.origin}, as THEDEPLOYER_MCP_URL says`)
  }
}
const ENDPOINT = endpoint.href
const ORIGIN = endpoint.origin // what messages show: never the full URL

const TIMEOUT_MS = readTimeout((process.env.THEDEPLOYER_TIMEOUT_MS || '').trim())
function readTimeout(text) {
  if (!text) return DEFAULT_TIMEOUT_MS
  const value = /^\d+$/.test(text) ? Number(text) : NaN
  if (value >= 1000 && value <= 600000) return value
  log(`THEDEPLOYER_TIMEOUT_MS must be a whole number of milliseconds from 1000 to 600000. Using the default, ${DEFAULT_TIMEOUT_MS}.`)
  return DEFAULT_TIMEOUT_MS
}

const SETUP_PROBLEM = problems.join(' ')
if (SETUP_PROBLEM) log(`${SETUP_PROBLEM} Nothing is sent to The Deployer until this is fixed.`)

let protocolVersion = ''
let sessionId = ''

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}
// The editor stopped reading (EPIPE and the like), so nobody is left to answer.
process.stdout.on('error', () => process.exit(0))

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

// Tells ids apart by type too: 1 and "1" are different requests. Anything else can't be answered by id.
function idKey(id) {
  if (typeof id === 'string') return `s:${id}`
  if (typeof id === 'number' && Number.isFinite(id)) return `n:${id}`
  return undefined
}

// A request waits for an answer; a notification, or a response to the server, doesn't.
const awaitsAnswer = (item) => idKey(item.id) !== undefined && ('method' in item || !('result' in item || 'error' in item))

// What may go to stdout: a well-formed JSON-RPC 2.0 request, notification or response.
function kindOf(item) {
  if (!isObject(item) || item.jsonrpc !== '2.0') return ''
  if (typeof item.method === 'string') {
    if (item.id === undefined) return 'notification'
    return idKey(item.id) ? 'request' : ''
  }
  if (item.id !== null && !idKey(item.id)) return ''
  if (('result' in item) === ('error' in item)) return ''
  if ('error' in item && !(isObject(item.error) && Number.isInteger(item.error.code) && typeof item.error.message === 'string')) return ''
  return 'response'
}

// One line from stdin and everything that happens to it: which requests in it still wait for an answer,
// which the client cancelled, and the controller that stops its fetch.
function exchangeFor(message, items) {
  const ids = new Map()
  for (const item of items) if (awaitsAnswer(item)) ids.set(idKey(item.id), item.id)
  return { message, items, ids, answered: new Set(), cancelled: new Set(), controller: new AbortController(), timedOut: false }
}

function answer(exchange, key, text, code = -32000) {
  if (exchange.answered.has(key) || exchange.cancelled.has(key)) return
  exchange.answered.add(key)
  write({ jsonrpc: '2.0', id: exchange.ids.get(key), error: { code, message: text } })
}

// Answers every request still waiting with this error. With no request in the line, it goes to stderr: a
// notification never gets an answer invented for it.
function answerRest(exchange, text) {
  if (!exchange.ids.size) log(text)
  for (const key of exchange.ids.keys()) answer(exchange, key, text)
}

// True when all the line holds is requests the client has cancelled, so there's nothing left to send.
const allCancelled = (exchange) => exchange.items.every((item) => exchange.cancelled.has(idKey(item.id)))

// notifications/cancelled: stop waiting. MCP says a cancelled request gets no answer, so none is written.
const exchanges = new Set()
function cancel(requestId) {
  const key = idKey(requestId)
  if (key === undefined) return
  for (const exchange of exchanges) {
    if (!exchange.ids.has(key) || exchange.answered.has(key)) continue
    exchange.cancelled.add(key)
    if (allCancelled(exchange)) exchange.controller.abort()
  }
}

const sentence = (text) => (/[.!?]$/.test(text) ? text : `${text}.`)

function statusHint(status) {
  if (status === 401) {
    return API_KEY
      ? "This API key isn't valid or was revoked. Create a new one on your Profile page in The Deployer."
      : 'This needs a personal API key. Create one on your Profile page in The Deployer, then set THEDEPLOYER_API_KEY.'
  }
  if (status === 403) return 'The Deployer refused this account. Sign in to The Deployer to check it, or contact support.'
  return ''
}

// The server's own error for this request, or its error for the whole message (id null), if it sent one.
function serverError(items, key) {
  const usable = (item) => isObject(item) && isObject(item.error) && typeof item.error.message === 'string' && item.error.message.trim()
  const found = items.find((item) => usable(item) && key !== undefined && idKey(item.id) === key)
    || items.find((item) => usable(item) && (item.id === null || item.id === undefined))
  if (!found) return undefined
  return { text: sentence(found.error.message.trim()), code: Number.isInteger(found.error.code) ? found.error.code : -32000 }
}

// The JSON values in a body: one for a JSON answer, one per event for a stream. Unreadable parts are skipped.
function bodyValues(type, body) {
  const texts = type.toLowerCase().includes('text/event-stream')
    ? body.split(/\r?\n\r?\n/).map((event) => event.split(/\r?\n/).filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart()).join('\n'))
    : [body]
  const values = []
  for (const text of texts) {
    if (!text.trim()) continue
    try {
      values.push(JSON.parse(text))
    } catch {
      // not JSON: if a request goes unanswered because of it, it gets an error below
    }
  }
  return values.flatMap((value) => (Array.isArray(value) ? value : [value]))
}

// Only a short description of what went wrong: the raw error text can quote a header, which holds the key.
function unreachable(err) {
  const where = `Couldn't reach The Deployer at ${ORIGIN}`
  const cause = err && err.cause
  const code = [cause && cause.code, cause && Array.isArray(cause.errors) && cause.errors[0] && cause.errors[0].code, err && err.code]
    .find((value) => typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(value))
  if (cause && cause.message === 'unexpected redirect') {
    return `${where}: it answered with a redirect, and this bridge doesn't follow redirects.${URL_SETTING ? ' Check THEDEPLOYER_MCP_URL.' : ''}`
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `${where}: its address couldn't be looked up (${code}). Check your internet connection.`
  if (code === 'ECONNREFUSED') return `${where}: the connection was refused (${code}).`
  if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'UND_ERR_SOCKET') return `${where}: the connection closed before an answer came (${code}).`
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return `${where}: connecting timed out (${code}).`
  if (code && /CERT|SELF_SIGNED|UNABLE_TO_(VERIFY|GET_ISSUER)/.test(code)) {
    return `${where}: its certificate couldn't be verified (${code}). If a proxy on your network inspects HTTPS, set NODE_EXTRA_CA_CERTS to its certificate file.`
  }
  if (code && /SSL|TLS/.test(code)) return `${where}: a secure connection couldn't be set up (${code}).`
  return code ? `${where} (${code}).` : `${where}.`
}

function timedOut() {
  const seconds = TIMEOUT_MS / 1000
  return `The Deployer didn't answer within ${seconds} second${seconds === 1 ? '' : 's'}, so this request timed out. Try again, or raise THEDEPLOYER_TIMEOUT_MS.`
}

async function forward(exchange) {
  if (allCancelled(exchange)) return
  if (SETUP_PROBLEM) {
    for (const key of exchange.ids.keys()) answer(exchange, key, SETUP_PROBLEM)
    return
  }
  const initialize = exchange.items.find((item) => item.method === 'initialize')
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'User-Agent': `thedeployer-mcp/${VERSION}`,
  }
  if (API_KEY) headers.Authorization = `Bearer ${API_KEY}`
  if (!initialize) { // initialize settles these, so it starts without them
    if (protocolVersion) headers['MCP-Protocol-Version'] = protocolVersion
    if (sessionId) headers['Mcp-Session-Id'] = sessionId
  }

  const timer = setTimeout(() => {
    exchange.timedOut = true
    exchange.controller.abort()
  }, TIMEOUT_MS)
  let response
  let body
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST', headers, body: JSON.stringify(exchange.message), redirect: 'error', signal: exchange.controller.signal,
    })
    body = await response.text()
  } catch (err) {
    if (exchange.controller.signal.aborted && !exchange.timedOut) return // the client cancelled it
    answerRest(exchange, exchange.timedOut ? timedOut() : unreachable(err))
    return
  } finally {
    clearTimeout(timer)
  }

  const session = response.headers.get('mcp-session-id')
  if (session && TOKEN.test(session)) sessionId = session
  const status = response.status
  const ok = status >= 200 && status <= 299
  const items = bodyValues(response.headers.get('content-type') || '', body)

  // Only a success is passed on, and only what's well formed: an answer to a request in this line, or a
  // message of the server's own. Everything else is used, at most, for the error text below.
  if (ok) {
    const initializeKey = initialize && idKey(initialize.id)
    for (const item of items) {
      const kind = kindOf(item)
      if (kind === 'request' || kind === 'notification') {
        write(item)
      } else if (kind === 'response') {
        const key = idKey(item.id)
        if (!exchange.ids.has(key) || exchange.answered.has(key) || exchange.cancelled.has(key)) continue
        exchange.answered.add(key)
        if (key === initializeKey && isObject(item.result) && typeof item.result.protocolVersion === 'string'
          && item.result.protocolVersion.length <= 64 && TOKEN.test(item.result.protocolVersion)) {
          protocolVersion = item.result.protocolVersion
        }
        write(item)
      }
    }
  }

  // Refusals (401, 403, 400) come with id null, which no editor can match to its request, so each request
  // that's still waiting gets its own error. What the server said is kept as it is, since it already says what
  // to do; the hint is for an answer that says nothing usable, such as a proxy's error page.
  const hint = ok ? '' : statusHint(status)
  const fallback = ok
    ? (body.trim() ? "The Deployer sent an answer this bridge couldn't read." : 'The Deployer sent no answer to this request.')
    : `The Deployer answered with HTTP ${status}.`
  if (!exchange.ids.size && !ok) {
    const said = serverError(items)
    log(said ? said.text : [fallback, hint].filter(Boolean).join(' '))
  }
  for (const key of exchange.ids.keys()) {
    const said = serverError(items, key)
    answer(exchange, key, said ? said.text : [fallback, hint].filter(Boolean).join(' '), said ? said.code : -32000)
  }
}

// Not an object, or a batch with something else in it: answered here and never sent. Each request in it that
// carries an id gets its own error, so nothing waits forever, and the rest share one error with id null.
function refuseInvalid(items) {
  const error = { code: -32600, message: 'Invalid Request: a message must be a JSON object, or a non-empty array of them.' }
  let anonymous = items.length === 0
  for (const item of items) {
    if (!isObject(item)) anonymous = true
    else if (awaitsAnswer(item)) write({ jsonrpc: '2.0', id: item.id, error })
  }
  if (anonymous) write({ jsonrpc: '2.0', id: null, error })
}

// initialize goes first and alone, so the version it settles rides on every later message. After that,
// messages go out as they arrive: a long tool call doesn't hold up the next one. The gate opens again
// however initialize ends, so one failed start doesn't silence the rest of the session.
let gate = Promise.resolve()
const tasks = new Set()

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
process.stdin.on('error', () => lines.close())
lines.on('line', (line) => {
  const text = line.trim()
  if (!text) return
  let message
  try {
    message = JSON.parse(text)
  } catch {
    write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
    return
  }
  const items = Array.isArray(message) ? message : [message]
  if (items.length === 0 || !items.every(isObject)) {
    refuseInvalid(items)
    return
  }
  for (const item of items) {
    if (item.method === 'notifications/cancelled' && isObject(item.params)) cancel(item.params.requestId)
  }

  const exchange = exchangeFor(message, items)
  exchanges.add(exchange)
  const task = gate
    .then(() => forward(exchange))
    .catch((err) => {
      answerRest(exchange, 'Something went wrong inside thedeployer-mcp, so this message was not sent.')
      log(`unexpected ${err && err.name ? err.name : 'error'}`) // not its text, which could quote a header
    })
    .catch(() => {})
    .then(() => {
      exchanges.delete(exchange)
      tasks.delete(task)
    })
  tasks.add(task)
  if (items.some((item) => item.method === 'initialize')) gate = task
})

// Answer everything still on its way, then let stdout drain before exiting: exiting straight after a big
// write cuts it off wherever pipes are asynchronous, as on macOS.
lines.on('close', () => {
  Promise.allSettled([...tasks]).then(() => {
    process.stdout.end(() => process.exit(SETUP_PROBLEM ? 1 : 0))
  })
})
