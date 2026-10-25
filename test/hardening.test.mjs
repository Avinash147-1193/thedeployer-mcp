// What the bridge promises when things go wrong: every request gets one answer, stdout carries only
// JSON-RPC 2.0, nothing leaks the key or the full URL, and bad settings are caught before anything is sent.
// Nothing here touches the network: each stand-in endpoint listens on 127.0.0.1.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const BRIDGE = fileURLToPath(new URL('../index.mjs', import.meta.url))
const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
}

function shut(server) {
  if (server.closeAllConnections) server.closeAllConnections()
  return new Promise((resolve) => server.close(() => resolve()))
}

// A stand-in for The Deployer's endpoint: records what arrives (and whether the bridge gave up on it),
// and answers through `reply(message, res)`. A reply that never ends the response leaves the request hanging.
async function endpoint(reply) {
  const seen = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      const entry = { headers: req.headers, message: JSON.parse(body), aborted: false }
      res.on('close', () => { if (!res.writableFinished) entry.aborted = true })
      seen.push(entry)
      reply(entry.message, res)
    })
  })
  await listen(server)
  const { port } = server.address()
  return { url: `http://127.0.0.1:${port}/api/v1/mcp`, origin: `http://127.0.0.1:${port}`, seen, close: () => shut(server) }
}

// A port that nothing listens on, so connecting to it is refused.
async function closedPort() {
  const server = createServer()
  await listen(server)
  const { port } = server.address()
  await shut(server)
  return port
}

const json = (res, message, status = 200) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(message))
const ok = (message, res) => json(res, { jsonrpc: '2.0', id: message.id, result: {} })
const ping = (id = 1) => ({ jsonrpc: '2.0', id, method: 'ping' })
const initialize = (id = 1) => ({
  jsonrpc: '2.0', id, method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
})
const initialized = (message, res, headers = {}) => res.writeHead(200, { 'Content-Type': 'application/json', ...headers })
  .end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'test', version: '1' } } }))
// How The Deployer refuses a whole message: JSON-RPC with id null, which no editor can match to its request.
const refuse = (res, status, text) => json(res, { jsonrpc: '2.0', id: null, error: { code: -32001, message: text } }, status)

// Starts the bridge. `send` writes one line (an object as JSON, a string as it is), `end` closes stdin, and
// `done` resolves once it exits, with every stdout line parsed, the raw stdout and stderr, and the exit code.
function start(env = {}) {
  const child = spawn(process.execPath, [BRIDGE], {
    env: { ...process.env, THEDEPLOYER_API_KEY: '', THEDEPLOYER_MCP_URL: '', THEDEPLOYER_TIMEOUT_MS: '', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const done = new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code) => {
      try {
        resolve({ messages: stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line)), stdout, stderr, code })
      } catch {
        reject(new Error(`stdout had a line that isn't JSON: ${stdout.slice(0, 300)}`))
      }
    })
  })
  return {
    child,
    done,
    send: (message) => child.stdin.write(`${typeof message === 'string' ? message : JSON.stringify(message)}\n`),
    end: () => child.stdin.end(),
    stop: () => child.kill(), // so a failing test can't leave the bridge running
  }
}

async function run(env, messages) {
  const bridge = start(env)
  try {
    for (const message of messages) bridge.send(message)
    bridge.end()
    return await bridge.done
  } finally {
    bridge.stop()
  }
}

async function until(check, ms = 5000) {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`gave up waiting after ${ms} ms`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

// Refusals and answers that aren't JSON-RPC

test('answers each request refused with a 401 and id null, in the words the server used', async () => {
  const server = await endpoint((message, res) => refuse(res, 401, "This API key isn't valid. Create a new one on your Profile page."))
  try {
    const { messages, stdout } = await run({ THEDEPLOYER_MCP_URL: server.url, THEDEPLOYER_API_KEY: 'dpl_revoked' }, [
      initialize(1),
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ])
    assert.deepEqual(messages.map((m) => m.id), [1, 2])
    for (const message of messages) {
      assert.equal(message.jsonrpc, '2.0')
      assert.equal(message.error.code, -32001)
      assert.equal(message.error.message, "This API key isn't valid. Create a new one on your Profile page.")
    }
    assert.doesNotMatch(stdout, /"id":null/)
  } finally {
    await server.close()
  }
})

test('keeps what the server said for a 403 and a 400, and asks for a key on a 401 that says nothing usable', async () => {
  const server = await endpoint((message, res) => {
    if (message.method === 'disabled') refuse(res, 403, 'This account has been disabled. Please contact support.')
    else if (message.method === 'old-version') refuse(res, 400, 'Unsupported MCP-Protocol-Version 1999-01-01. Supported: 2025-06-18.')
    else res.writeHead(401, { 'Content-Type': 'text/plain' }).end('Unauthorized')
  })
  try {
    const { messages } = await run({ THEDEPLOYER_MCP_URL: server.url }, [
      { jsonrpc: '2.0', id: 1, method: 'disabled' },
      { jsonrpc: '2.0', id: 2, method: 'old-version' },
      { jsonrpc: '2.0', id: 3, method: 'no-key' },
    ])
    const byId = new Map(messages.map((m) => [m.id, m.error.message]))
    assert.equal(messages.length, 3)
    assert.equal(byId.get(1), 'This account has been disabled. Please contact support.')
    assert.equal(byId.get(2), 'Unsupported MCP-Protocol-Version 1999-01-01. Supported: 2025-06-18.')
    assert.equal(byId.get(3), 'The Deployer answered with HTTP 401. This needs a personal API key. Create one on your Profile page in The Deployer, then set THEDEPLOYER_API_KEY.')
  } finally {
    await server.close()
  }
})

test('answers every request whose answer is not JSON-RPC, and writes nothing that is not JSON-RPC 2.0', async () => {
  const server = await endpoint((message, res) => {
    const method = Array.isArray(message) ? message[0].method : message.method
    if (method === 'not-found') json(res, { detail: 'Not Found' }, 404)
    else if (method === 'detail') json(res, { detail: 'Something else' })
    else if (method === 'html') res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html>Sign in to the proxy</html>')
    else if (method === 'accepted') res.writeHead(202).end()
    else if (method === 'junk') {
      json(res, [{ foo: 'bar' }, { jsonrpc: '1.0', id: message.id, result: {} }, { jsonrpc: '2.0', id: 999, result: {} },
        { jsonrpc: '2.0', id: message.id, error: { message: 'An error without a code' } }])
    } else res.writeHead(500, { 'Content-Type': 'text/plain' }).end('oops')
  })
  try {
    const { messages, stdout } = await run({ THEDEPLOYER_MCP_URL: server.url }, [
      { jsonrpc: '2.0', id: 1, method: 'not-found' },
      { jsonrpc: '2.0', id: 2, method: 'detail' },
      { jsonrpc: '2.0', id: 3, method: 'html' },
      { jsonrpc: '2.0', id: 4, method: 'accepted' },
      { jsonrpc: '2.0', id: 5, method: 'junk' },
      [{ jsonrpc: '2.0', id: 6, method: 'batch' }, { jsonrpc: '2.0', method: 'notifications/progress' }, { jsonrpc: '2.0', id: 'seven', method: 'batch' }],
    ])
    const byId = new Map(messages.map((m) => [m.id, m]))
    assert.equal(messages.length, 7)
    assert.ok(messages.every((m) => m.jsonrpc === '2.0' && Number.isInteger(m.error.code) && typeof m.error.message === 'string'))
    assert.equal(byId.get(1).error.message, 'The Deployer answered with HTTP 404.')
    assert.equal(byId.get(2).error.message, "The Deployer sent an answer this bridge couldn't read.")
    assert.equal(byId.get(3).error.message, "The Deployer sent an answer this bridge couldn't read.")
    assert.equal(byId.get(4).error.message, 'The Deployer sent no answer to this request.')
    assert.equal(byId.get(5).error.message, 'An error without a code.')
    assert.equal(byId.get(6).error.message, 'The Deployer answered with HTTP 500.')
    assert.equal(byId.get('seven').error.message, 'The Deployer answered with HTTP 500.')
    assert.doesNotMatch(stdout, /detail|foo|999|html/)
  } finally {
    await server.close()
  }
})

// Connection failures, redirects and timeouts

test('says why a connection failed with a short code, never the raw error text or the full URL', async () => {
  const port = await closedPort()
  const { messages, stderr } = await run({ THEDEPLOYER_MCP_URL: `http://127.0.0.1:${port}/api/v1/mcp?tenant=private` }, [
    ping(1),
    { jsonrpc: '2.0', method: 'notifications/initialized' },
  ])
  assert.equal(messages.length, 1)
  assert.equal(messages[0].error.message, `Couldn't reach The Deployer at http://127.0.0.1:${port}: the connection was refused (ECONNREFUSED).`)
  assert.doesNotMatch(stderr + JSON.stringify(messages), /fetch failed|api\/v1|tenant/)
})

test('does not follow a redirect', async () => {
  const target = await endpoint(ok)
  const redirect = await endpoint((message, res) => res.writeHead(307, { Location: target.url }).end())
  try {
    const { messages } = await run({ THEDEPLOYER_MCP_URL: redirect.url, THEDEPLOYER_API_KEY: 'dpl_test' }, [ping(1)])
    assert.equal(target.seen.length, 0)
    assert.equal(messages.length, 1)
    assert.equal(messages[0].error.message, `Couldn't reach The Deployer at ${redirect.origin}: it answered with a redirect, and this bridge doesn't follow redirects. Check THEDEPLOYER_MCP_URL.`)
  } finally {
    await target.close()
    await redirect.close()
  }
})

test('reports a timeout as a timeout, and stops the request', async () => {
  const server = await endpoint(() => {}) // never answers
  try {
    const { messages } = await run({ THEDEPLOYER_MCP_URL: server.url, THEDEPLOYER_TIMEOUT_MS: '1000' }, [{ jsonrpc: '2.0', id: 1, method: 'tools/call' }])
    assert.deepEqual(messages, [{ jsonrpc: '2.0', id: 1, error: { code: -32000, message: "The Deployer didn't answer within 1 second, so this request timed out. Try again, or raise THEDEPLOYER_TIMEOUT_MS." } }])
    await until(() => server.seen[0].aborted)
  } finally {
    await server.close()
  }
})

// What comes in on stdin: bad lines, a failed initialize, sessions, cancellation, and exiting

test('answers a line that is not a message on its own, sends nothing for it, and keeps going', async () => {
  const server = await endpoint(ok)
  try {
    const { messages, code } = await run({ THEDEPLOYER_MCP_URL: server.url }, [
      'null', '[]', '42', '"text"', '[1, 2]', 'not json',
      [{ jsonrpc: '2.0', id: 9, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }, 5],
      ping(10),
    ])
    const invalid = { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request: a message must be a JSON object, or a non-empty array of them.' } }
    assert.deepEqual(messages, [
      invalid, invalid, invalid, invalid, invalid,
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
      { ...invalid, id: 9 }, invalid,
      { jsonrpc: '2.0', id: 10, result: {} },
    ])
    assert.deepEqual(server.seen.map((s) => s.message.id), [10])
    assert.equal(code, 0)
  } finally {
    await server.close()
  }
})

test('a failed initialize does not silence the messages after it', async () => {
  let attempts = 0
  const server = await endpoint((message, res) => {
    if (message.method !== 'initialize') ok(message, res)
    else if (++attempts === 1) res.socket.destroy()
    else initialized(message, res)
  })
  try {
    const { messages } = await run({ THEDEPLOYER_MCP_URL: server.url }, [initialize(1), initialize(2), { jsonrpc: '2.0', id: 3, method: 'tools/list' }])
    assert.deepEqual(messages.map((m) => m.id), [1, 2, 3])
    assert.match(messages[0].error.message, /^Couldn't reach The Deployer at http:\/\/127\.0\.0\.1:\d+/)
    assert.equal(messages[1].result.protocolVersion, '2025-06-18')
    assert.deepEqual(messages[2].result, {})
    assert.equal(server.seen[2].headers['mcp-protocol-version'], '2025-06-18')
  } finally {
    await server.close()
  }
})

test('echoes the session id the server hands out, but not on initialize', async () => {
  const server = await endpoint((message, res) => (message.method === 'initialize' ? initialized(message, res, { 'Mcp-Session-Id': 'session-123' }) : ok(message, res)))
  try {
    const { messages } = await run({ THEDEPLOYER_MCP_URL: server.url }, [initialize(1), ping(2), initialize(3)])
    assert.deepEqual(messages.map((m) => m.id), [1, 2, 3])
    assert.deepEqual(server.seen.map((s) => s.headers['mcp-session-id']), [undefined, 'session-123', undefined])
  } finally {
    await server.close()
  }
})

test('a cancel notification stops the request it names, which then gets no answer', { timeout: 20000 }, async () => {
  const server = await endpoint((message, res) => {
    if (message.method === 'tools/call') return // held until the bridge gives up on it
    if (message.id === undefined) res.writeHead(202).end()
    else ok(message, res)
  })
  const bridge = start({ THEDEPLOYER_MCP_URL: server.url })
  try {
    bridge.send({ jsonrpc: '2.0', id: 'long', method: 'tools/call', params: { name: 'logs' } })
    await until(() => server.seen.length === 1)
    bridge.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'long', reason: 'The user stopped it' } })
    bridge.send(ping(2))
    await until(() => server.seen[0].aborted)
    bridge.end()
    const { messages, code } = await bridge.done
    assert.deepEqual(messages, [{ jsonrpc: '2.0', id: 2, result: {} }])
    assert.ok(server.seen.some((s) => s.message.method === 'notifications/cancelled'))
    assert.equal(code, 0)
  } finally {
    bridge.stop()
    await server.close()
  }
})

test('delivers a large answer in full before exiting, even when the editor reads slowly', async () => {
  const text = 'x'.repeat(400000)
  const server = await endpoint((message, res) => json(res, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text }] } }))
  const bridge = start({ THEDEPLOYER_MCP_URL: server.url })
  try {
    bridge.child.stdout.pause()
    bridge.send({ jsonrpc: '2.0', id: 1, method: 'tools/call' })
    bridge.end()
    await until(() => server.seen.length === 1)
    await new Promise((resolve) => setTimeout(resolve, 500))
    bridge.child.stdout.resume()
    const { messages } = await bridge.done
    assert.equal(messages.length, 1)
    assert.equal(messages[0].result.content[0].text.length, text.length)
  } finally {
    bridge.stop()
    await server.close()
  }
})

// Settings

test('refuses a malformed key without sending anything, and never repeats the key', async () => {
  const server = await endpoint(ok)
  try {
    for (const key of ['dpl_secretvalue\r\nX-Injected: 1', 'dpl_secret value', 'dpl_secret\tvalue', 'dpl_sécret']) {
      const { messages, stdout, stderr, code } = await run({ THEDEPLOYER_MCP_URL: server.url, THEDEPLOYER_API_KEY: key }, [
        ping(1), { jsonrpc: '2.0', method: 'notifications/initialized' },
      ])
      assert.equal(messages.length, 1)
      assert.equal(messages[0].id, 1)
      assert.match(messages[0].error.message, /^THEDEPLOYER_API_KEY isn't a valid key: /)
      assert.match(stderr, /THEDEPLOYER_API_KEY isn't a valid key: /)
      assert.doesNotMatch(stdout + stderr, /secret|Injected/)
      assert.equal(code, 1)
    }
    assert.equal(server.seen.length, 0)
  } finally {
    await server.close()
  }
})

test('refuses plain http to another computer, other schemes, and a URL with a password, never echoing the URL', async () => {
  for (const url of ['http://example.com/api/v1/mcp', 'ftp://127.0.0.1/mcp', 'not a url', 'https://someone:hunter2@example.com/mcp']) {
    const { messages, stderr, code } = await run({ THEDEPLOYER_MCP_URL: url, THEDEPLOYER_API_KEY: 'dpl_test' }, [ping()])
    assert.equal(messages.length, 1, url)
    assert.match(messages[0].error.message, /^THEDEPLOYER_MCP_URL /, url)
    assert.doesNotMatch(stderr + JSON.stringify(messages), /example\.com|hunter2|ftp|not a url|dpl_test/, url)
    assert.equal(code, 1)
  }
})

test('allows plain http to this computer, trims the key, and names only the origin, once, on stderr', async () => {
  const server = await endpoint(ok)
  try {
    const { messages, stderr } = await run({ THEDEPLOYER_MCP_URL: `${server.url}?tenant=private#part`, THEDEPLOYER_API_KEY: '  dpl_test\n' }, [ping(1), ping(2)])
    assert.deepEqual(messages.map((m) => m.id).sort(), [1, 2])
    assert.equal(server.seen[0].headers.authorization, 'Bearer dpl_test')
    const notes = stderr.split('\n').filter((line) => line.includes('sending MCP messages'))
    assert.deepEqual(notes, [`thedeployer-mcp: sending MCP messages to ${server.origin}, as THEDEPLOYER_MCP_URL says`])
    assert.doesNotMatch(stderr, /tenant|api\/v1|dpl_test/)
  } finally {
    await server.close()
  }
  const port = await closedPort()
  for (const host of ['localhost', '[::1]']) {
    const { messages } = await run({ THEDEPLOYER_MCP_URL: `http://${host}:${port}/mcp` }, [ping()])
    assert.ok(messages[0].error.message.startsWith(`Couldn't reach The Deployer at http://${host}:${port}`), host)
  }
})

test('falls back to the default timeout, with a warning, unless THEDEPLOYER_TIMEOUT_MS is a whole number from 1000 to 600000', async () => {
  const server = await endpoint((message, res) => setTimeout(() => ok(message, res), 50))
  try {
    for (const value of ['-1', '1.5', '999', '600001', '99999999999', 'abc']) {
      const { messages, stderr } = await run({ THEDEPLOYER_MCP_URL: server.url, THEDEPLOYER_TIMEOUT_MS: value }, [ping()])
      assert.deepEqual(messages, [{ jsonrpc: '2.0', id: 1, result: {} }], value)
      assert.match(stderr, /THEDEPLOYER_TIMEOUT_MS must be a whole number of milliseconds from 1000 to 600000\. Using the default, 200000\./, value)
      assert.doesNotMatch(stderr, /abc/)
    }
    for (const value of ['1000', ' 5000 ', '600000', '']) {
      const { messages, stderr } = await run({ THEDEPLOYER_MCP_URL: server.url, THEDEPLOYER_TIMEOUT_MS: value }, [ping()])
      assert.deepEqual(messages, [{ jsonrpc: '2.0', id: 1, result: {} }], value)
      assert.doesNotMatch(stderr, /TIMEOUT/, value)
    }
  } finally {
    await server.close()
  }
})

// The package itself

test('index.mjs, package.json and server.json agree on the version', () => {
  const pkg = JSON.parse(read('package.json'))
  const server = JSON.parse(read('server.json'))
  const constant = read('index.mjs').match(/^const VERSION = '([^']+)'$/m)[1]
  const printed = spawnSync(process.execPath, [BRIDGE, '--version'], { encoding: 'utf8' }).stdout.trim()
  assert.equal(constant, pkg.version)
  assert.equal(printed, pkg.version)
  assert.equal(server.version, pkg.version)
  assert.deepEqual(server.packages.map((p) => [p.identifier, p.version]), [[pkg.name, pkg.version]])
  assert.equal(server.name, pkg.mcpName)
})

test('the package keeps its shape: no dependencies, only node: imports, the bin with its shebang, and its files list', () => {
  const pkg = JSON.parse(read('package.json'))
  const source = read('index.mjs')
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) assert.equal(pkg[field], undefined, field)
  assert.deepEqual([...source.matchAll(/^import .* from '([^']+)'$/gm)].map((m) => m[1].startsWith('node:')), [true])
  assert.ok(source.startsWith('#!/usr/bin/env node\n'))
  assert.deepEqual(pkg.bin, { 'thedeployer-mcp': 'index.mjs' })
  assert.deepEqual(pkg.files, ['index.mjs', 'README.md', 'LICENSE'])
  assert.equal(pkg.engines.node, '>=18')
})
