import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici'
import { directAuthHeaders } from '../direct-auth.mjs'
import { validateConfig } from '../index.mjs'
import { createRuntimeHarness, runtimeProposal } from '../testing/runtime-harness.mjs'
import { messagesSSE } from '../testing/fake-messages.mjs'
import { directEndpoint } from '../direct-wire.mjs'

const endpoint = 'https://api.deepseek.com/chat/completions'
const direct = { auth: 'deepseek-account', api: 'deepseek', endpoint }
test('account credentials cannot be resolved for another destination or mixed with API keys', async () => {
  let resolved = 0
  const ctx = { get: () => ({ resolveToken() { resolved++; return 'PRIVATE_TOKEN' } }) }
  for (const changes of [{ endpoint: 'http://api.deepseek.com/chat/completions' }, { endpoint: 'https://api.deepseek.com.evil.invalid/chat/completions' },
    { endpoint: 'https://example.invalid/chat/completions' }, { apiKeyEnv: 'KEY' }, { api: 'openai-compatible' }]) {
    await assert.rejects(directAuthHeaders(ctx, { ...direct, ...changes }, new AbortController().signal), /DIRECT_ACCOUNT_DESTINATION_DENIED/)
    assert.throws(() => validateConfig({ projectRoot: '/tmp', directory: '/tmp/state', provider: 'x', model: 'x', transport: 'direct', systemPrompt: 'x',
      allowedTools: [], direct: { ...direct, ...changes } }))
  }
  assert.equal(resolved, 0)
})

test('account sign-in is mandatory and credential resolution can be cancelled', async () => {
  const signal = new AbortController().signal
  await assert.rejects(directAuthHeaders({ get: () => undefined }, direct, signal), /DIRECT_ACCOUNT_SERVICE_REQUIRED/)
  await assert.rejects(directAuthHeaders({ get: () => ({ resolveToken: async () => undefined }) }, direct, signal), /DIRECT_ACCOUNT_SIGN_IN_REQUIRED/)
  const cancelled = new AbortController()
  const pending = directAuthHeaders({ get: () => ({ resolveToken: () => new Promise(() => {}) }) }, direct, cancelled.signal)
  cancelled.abort(new Error('CANCEL_AUTH'))
  await assert.rejects(pending, /CANCEL_AUTH/)
})

for (const protocol of ['chat-completions', 'auto']) test('direct account tool rounds refresh authentication without native model assembly or secret receipts: ' + protocol, async t => {
  const route = { ...direct, protocol }, actualEndpoint = directEndpoint(route)
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-direct-account-'))), projectRoot = path.join(root, 'workspace')
  fs.mkdirSync(projectRoot)
  const original = getGlobalDispatcher(), mock = new MockAgent()
  mock.disableNetConnect(); setGlobalDispatcher(mock)
  let authCalls = 0, nativeCalls = 0
  const pool = mock.get('https://api.deepseek.com')
  for (let index = 1; index <= 2; index++) pool.intercept({ path: new URL(actualEndpoint).pathname, method: 'POST' }).reply(options => {
    const headers = new Headers(options.headers)
    assert.equal(headers.get('x-dsh-auth-token'), `PRIVATE_TOKEN_${index}`)
    assert.equal(headers.has('authorization'), false)
    const body = JSON.parse(options.body)
    assert.equal(body.model, 'deepseek-flash')
    if (protocol === 'auto') {
      assert.equal(headers.get('anthropic-version'), '2023-06-01')
      assert.deepEqual(body.output_config, { effort: 'high' })
      return { statusCode: 200, responseOptions: { headers: { 'content-type': 'text/event-stream' } }, data: messagesSSE(index === 1
        ? { reasoning: 'Inspect state.', tools: [{ name: 'dynamic_task_status', arguments: {} }] }
        : { reasoning: 'Report observations.', text: 'Qualified account report.' }, index, body.model) }
    }
    const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: `response-${index}`, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`
    const delta = index === 1 ? { reasoning_content: 'Inspect state.', tool_calls: [{ index: 0, id: 'state-call', type: 'function', function: { name: 'dynamic_task_status', arguments: '{}' } }] }
      : { reasoning_content: 'Report observations.', content: 'Qualified account report.' }
    return { statusCode: 200, responseOptions: { headers: { 'content-type': 'text/event-stream' } }, data:
      chunk(delta) + chunk({}, index === 1 ? 'tool_calls' : 'stop') + 'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":10,"total_tokens":110}}\n\ndata: [DONE]\n\n' }
  })
  const h = await createRuntimeHarness({ projectRoot, directory: path.join(root, 'state'),
    config: { storageRoot: root, model: 'deepseek-flash', direct: { ...route, apiKeyEnv: undefined, durable: true } },
    setup: async ctx => {
      ctx.provide('deepseekAccount', { resolveToken: async url => { assert.equal(url, actualEndpoint); return `PRIVATE_TOKEN_${++authCalls}` } })
      ctx.on('llm/stream', async function* () { nativeCalls++; throw new Error('Native assembly invoked') })
    } })
  t.after(async () => { setGlobalDispatcher(original); await h.close(); await mock.close(); fs.rmSync(root, { recursive: true, force: true }) })
  h.runner.submit(runtimeProposal(['dynamic_task_status']))
  const result = await h.runner.runNext({ expectedRevision: 1 })
  assert.equal(result.report.text, 'Qualified account report.')
  assert.equal(authCalls, 2); assert.equal(nativeCalls, 0)
  assert.doesNotMatch(JSON.stringify(result.trace), /PRIVATE_TOKEN/)
  mock.assertNoPendingInterceptors()
})

for (const protocol of ['chat-completions', 'auto']) test('account sign-out cancels an in-flight direct request without accepting a report: ' + protocol, async t => {
  const route = { ...direct, protocol }
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-account-signout-'))), projectRoot = path.join(root, 'workspace')
  fs.mkdirSync(projectRoot)
  const original = getGlobalDispatcher(), mock = new MockAgent()
  mock.disableNetConnect(); setGlobalDispatcher(mock)
  const h = await createRuntimeHarness({ projectRoot, directory: path.join(root, 'state'),
    config: { storageRoot: root, model: 'deepseek-flash', direct: { ...route, apiKeyEnv: undefined, durable: true } },
    setup: async ctx => ctx.provide('deepseekAccount', { resolveToken: async () => 'PRIVATE_TEST_TOKEN' }) })
  t.after(async () => { setGlobalDispatcher(original); await h.close(); await mock.close(); fs.rmSync(root, { recursive: true, force: true }) })
  mock.get('https://api.deepseek.com').intercept({ path: new URL(directEndpoint(route)).pathname, method: 'POST' }).reply(() => {
    setTimeout(() => h.ctx.emit('deepseek-account/signed-out'), 10)
    return { statusCode: 200, data: '', responseOptions: { headers: { 'content-type': 'text/event-stream' } } }
  }).delay(500)
  h.runner.submit(runtimeProposal([]))
  await assert.rejects(h.runner.runNext({ expectedRevision: 1 }), /DIRECT_ACCOUNT_SIGNED_OUT/)
  assert.equal(h.runner.graph.read().reports.length, 0)
  assert.equal(h.runner.checkpointStatus().phase, 'BLOCKED')
  mock.assertNoPendingInterceptors()
})
