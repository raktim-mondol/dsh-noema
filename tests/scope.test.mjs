import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { test } from 'node:test'
import { McpStdioClient } from '../lib/mcp-stdio.js'
import { createNoemaTools } from '../lib/tools.js'
import { MEMORY_SCOPE_ARG, resolveNoemaScope, stripModelScope } from '../lib/scope.js'
import { NOEMA_MEMORY_SETTINGS_DEFAULTS } from '../lib/settings.js'

const CONFIG = { ...NOEMA_MEMORY_SETTINGS_DEFAULTS, command: 'noema-mcp' }

const ECHO_SERVER = [
  "import { createInterface } from 'node:readline'",
  "const rl = createInterface({ input: process.stdin })",
  "const send = value => process.stdout.write(JSON.stringify(value) + '\\n')",
  "rl.on('line', raw => {",
  "  let msg",
  "  try { msg = JSON.parse(raw) } catch { process.exit(3) }",
  "  if (msg.method === 'notifications/initialized') return",
  "  if (msg.method === 'initialize') {",
  "    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake-noema', version: '0' } } })",
  "    return",
  "  }",
  "  if (msg.method === 'tools/call') {",
  "    send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(msg.params) }] } })",
  "  }",
  "})",
].join('\n')

function startEchoServer() {
  return spawn(process.execPath, ['--input-type=module', '-e', ECHO_SERVER], { stdio: ['pipe', 'pipe', 'pipe'] })
}

const EXEC = {
  signal: undefined,
  agent: {
    id: 'session-abc',
    session: {
      id: 'session-abc',
      header: { cwd: '/work/demo', agentPreset: 'coder' },
    },
  },
}

test('scope resolves from the execution context, never from tool args', () => {
  const scope = resolveNoemaScope(EXEC, CONFIG)
  assert.equal(scope.tenant, 'personal')
  assert.equal(scope.principal, 'session-abc')
  assert.equal(scope.agent, 'session-abc')
  assert.equal(scope.session, 'session-abc')
  assert.equal(scope.workspace, '/work/demo')
})

test('settings pin tenant and principal; context still attributes the caller', () => {
  const scope = resolveNoemaScope(EXEC, { ...CONFIG, tenant: 'acme', principal: 'ci-bot' })
  assert.equal(scope.tenant, 'acme')
  assert.equal(scope.principal, 'ci-bot')
  assert.equal(scope.agent, 'session-abc')
  assert.equal(scope.workspace, '/work/demo')
})

test('scope degrades to host identity without an agent context', () => {
  const scope = resolveNoemaScope({}, CONFIG)
  assert.equal(scope.tenant, 'personal')
  assert.ok(typeof scope.principal === 'string' && scope.principal !== '')
  assert.equal(scope.agent, undefined)
  assert.equal(scope.session, undefined)
  assert.equal(scope.workspace, undefined)
})

test('stripModelScope drops model-supplied scope claims', () => {
  assert.deepEqual(stripModelScope({ query: 'q' }), { query: 'q' })
  const cleaned = stripModelScope({ query: 'q', [MEMORY_SCOPE_ARG]: { tenant: 'other', principal: 'root' } })
  assert.deepEqual(cleaned, { query: 'q' })
})

test('tool execution injects host scope and strips model scope claims', async () => {
  const calls = []
  const manager = {
    async call(name, args, options) {
      calls.push({ name, args, options })
      return { text: '{}' }
    },
  }
  const tools = createNoemaTools(manager, () => CONFIG)
  const recall = tools.find(tool => tool.name === 'noema_recall')
  await recall.execute({ query: 'deploy', [MEMORY_SCOPE_ARG]: { tenant: 'other', principal: 'root' } }, EXEC)
  assert.equal(calls.length, 1)
  const { args, options } = calls[0]
  assert.equal(args[MEMORY_SCOPE_ARG], undefined, 'model scope claim must not reach the provider arguments')
  assert.equal(args.query, 'deploy')
  assert.equal(options.scope.tenant, 'personal')
  assert.equal(options.scope.principal, 'session-abc')
  assert.equal(options.scope.agent, 'session-abc')
  assert.equal(options.scope.workspace, '/work/demo')
})

test('scope travels on the tools/call envelope, outside tool arguments', async () => {
  const server = startEchoServer()
  const client = new McpStdioClient({ command: server.spawnargs[0], args: server.spawnargs.slice(1) })
  try {
    await client.start()
    const scope = resolveNoemaScope(EXEC, CONFIG)
    const result = await client.callTool('noema_recall', { query: 'hello' }, { timeoutMs: 5000, scope })
    const params = JSON.parse(result.text)
    assert.deepEqual(params.arguments, { query: 'hello' }, 'arguments stay model-chosen only')
    assert.deepEqual(params[MEMORY_SCOPE_ARG], scope)
  } finally {
    await client.dispose()
    server.kill()
  }
})

test('calls without an agent context carry the host-derived fallback scope', async () => {
  const server = startEchoServer()
  const client = new McpStdioClient({ command: server.spawnargs[0], args: server.spawnargs.slice(1) })
  try {
    await client.start()
    const scope = resolveNoemaScope({}, CONFIG)
    const result = await client.callTool('noema_search', { query: 'x' }, { timeoutMs: 5000, scope })
    const params = JSON.parse(result.text)
    assert.equal(params[MEMORY_SCOPE_ARG].tenant, 'personal')
    assert.equal(params[MEMORY_SCOPE_ARG].principal, scope.principal)
    assert.equal(params[MEMORY_SCOPE_ARG].agent, undefined)
  } finally {
    await client.dispose()
    server.kill()
  }
})
