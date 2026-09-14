#!/usr/bin/env node
// The Deployer's MCP server, for AI coding tools that start MCP servers as a local command.
//
// This is a bridge, not the tools: it reads MCP messages (JSON-RPC, one per line) from stdin, sends each
// to The Deployer's hosted MCP endpoint over HTTPS, and writes the answers to stdout. The tools run on
// The Deployer, so this file doesn't change when they do, and it has no dependencies to audit.
//
//   THEDEPLOYER_API_KEY     a personal API key (The Deployer, Profile). Without one, only check_repo works.
//   THEDEPLOYER_MCP_URL     the endpoint, when it isn't https://app.thedploy.com/api/v1/mcp
//   THEDEPLOYER_TIMEOUT_MS  how long to wait for one answer (default 120000)

import { createInterface } from 'node:readline'

const VERSION = '0.1.0'
const ENDPOINT = process.env.THEDEPLOYER_MCP_URL || 'https://app.thedploy.com/api/v1/mcp'
const API_KEY = (process.env.THEDEPLOYER_API_KEY || '').trim()
const TIMEOUT_MS = Number(process.env.THEDEPLOYER_TIMEOUT_MS) || 120000

if (process.argv.includes('--version')) {
  process.stdout.write(`${VERSION}\n`)
  process.exit(0)
}
if (process.argv.includes('--help')) {
  process.stdout.write('thedeployer-mcp: The Deployer\'s MCP server over stdio. Set THEDEPLOYER_API_KEY; see README.md.\n')
  process.exit(0)
}

let protocolVersion = ''
let sessionId = ''

function write(message) {
  process.stdout.write(JSON.stringify(message) + '\n')
}

// Only a request (it has an id and a method) gets an error back; notifications and responses don't.
function fail(message, text) {
  if (message && message.method && message.id !== undefined && message.id !== null) {
    write({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: text } })
  }
}

function relay(message, text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    fail(message, "The Deployer sent an answer this bridge couldn't read.")
    return
  }
  for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
    if (message.method === 'initialize' && item && item.result && item.result.protocolVersion) {
      protocolVersion = item.result.protocolVersion
    }
    write(item)
  }
}

async function forward(message) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'User-Agent': `thedeployer-mcp/${VERSION}`,
  }
  if (API_KEY) headers.Authorization = `Bearer ${API_KEY}`
  if (protocolVersion) headers['MCP-Protocol-Version'] = protocolVersion
  if (sessionId) headers['Mcp-Session-Id'] = sessionId

  let response
  let body
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST', headers, body: JSON.stringify(message), signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    body = await response.text()
  } catch (err) {
    fail(message, `Couldn't reach The Deployer at ${ENDPOINT}: ${err && err.message ? err.message : err}`)
    return
  }
  const session = response.headers.get('mcp-session-id')
  if (session) sessionId = session
  if (response.status === 202 || response.status === 204) return

  const type = response.headers.get('content-type') || ''
  if (type.includes('text/event-stream')) {
    for (const event of body.split(/\r?\n\r?\n/)) {
      const data = event.split(/\r?\n/).filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart()).join('\n')
      if (data) relay(message, data)
    }
    return
  }
  if (!type.includes('application/json')) {
    const hint = response.status === 401 ? ' Check THEDEPLOYER_API_KEY: create a key on your Profile page in The Deployer.' : ''
    fail(message, `The Deployer answered with HTTP ${response.status}.${hint}`)
    return
  }
  relay(message, body)
}

// initialize goes first and alone, so the version it settles rides on every later message. After that,
// messages go out as they arrive: a long tool call doesn't hold up the next one.
let initialized = Promise.resolve()
const pending = new Set()

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
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
  const task = message && message.method === 'initialize'
    ? (initialized = initialized.then(() => forward(message)))
    : initialized.then(() => forward(message))
  pending.add(task)
  task.finally(() => pending.delete(task))
})
lines.on('close', async () => {
  await Promise.allSettled([...pending])
  process.exit(0)
})
