import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const BRIDGE = fileURLToPath(new URL('../index.mjs', import.meta.url))

// A stand-in for The Deployer's endpoint: records what arrives, answers through `reply`.
async function endpoint(reply) {
  const seen = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      const message = JSON.parse(body)
      seen.push({ headers: req.headers, message })
      reply(message, res)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}/api/v1/mcp`,
    seen,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

// Run the bridge, send it messages, and collect every line it writes once stdin closes.
function bridge(env, messages) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BRIDGE], {
      env: { ...process.env, THEDEPLOYER_API_KEY: '', ...env }, stdio: ['pipe', 'pipe', 'inherit'],
    })
    let out = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.on('error', reject)
    child.on('close', () => resolve(out.split('\n').filter(Boolean).map((line) => JSON.parse(line))))
    for (const message of messages) child.stdin.write(JSON.stringify(message) + '\n')
    child.stdin.end()
  })
}

const json = (res, message) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(message))

test('forwards messages with the key and the settled version, and says nothing for notifications', async () => {
  const server = await endpoint((message, res) => {
    if (message.id === undefined) {
      res.writeHead(202).end()
    } else if (message.method === 'initialize') {
      json(res, { jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'thedeployer', version: 'test' } } })
    } else {
      json(res, { jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'check_repo' }] } })
    }
  })
  try {
    const out = await bridge({ THEDEPLOYER_MCP_URL: server.url, THEDEPLOYER_API_KEY: 'dpl_test' }, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ])
    assert.deepEqual(out.map((m) => m.id), [1, 2])
    assert.equal(out[1].result.tools[0].name, 'check_repo')
    assert.equal(server.seen.length, 3)
    const init = server.seen.find((s) => s.message.method === 'initialize')
    const list = server.seen.find((s) => s.message.method === 'tools/list')
    assert.equal(init.headers.authorization, 'Bearer dpl_test')
    assert.equal(init.headers['mcp-protocol-version'], undefined)
    assert.equal(list.headers['mcp-protocol-version'], '2025-06-18')
  } finally {
    await server.close()
  }
})

test('reads an answer sent as a server-sent event stream, and sends no key when none is set', async () => {
  const server = await endpoint((message, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} })}\n\n`)
  })
  try {
    const out = await bridge({ THEDEPLOYER_MCP_URL: server.url }, [{ jsonrpc: '2.0', id: 'a', method: 'ping' }])
    assert.deepEqual(out, [{ jsonrpc: '2.0', id: 'a', result: {} }])
    assert.equal(server.seen[0].headers.authorization, undefined)
  } finally {
    await server.close()
  }
})

test('answers a request with an error when The Deployer cannot be reached', async () => {
  const out = await bridge({ THEDEPLOYER_MCP_URL: 'http://127.0.0.1:9/api/v1/mcp' }, [
    { jsonrpc: '2.0', id: 7, method: 'tools/list' },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
  ])
  assert.equal(out.length, 1)
  assert.equal(out[0].id, 7)
  assert.match(out[0].error.message, /Couldn't reach The Deployer/)
})
