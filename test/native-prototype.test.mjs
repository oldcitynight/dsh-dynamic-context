import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { DynamicContextGraph, validateState } from '../core.mjs'
import { createHarness, GLOBAL_PRIVATE } from '../testing/harness.mjs'
import { proposal, scenarioResponse } from '../testing/scenario.mjs'
import { startFakeLlama } from '../testing/fake-llama.mjs'

function location(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-dynamic-context-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return { projectRoot: root, directory: path.join(root, 'state') }
}
async function harness(t, options = {}) {
  const h = await createHarness({ ...location(t), respond: scenarioResponse, ...options })
  t.after(() => h.close())
  return h
}
const payloadText = request => JSON.stringify(request.payload.messages)
const code = expected => error => error.code === expected

test('guarded native executor binds the role provider before DSH selects the adapter and validates the wire model', async t => {
  const backend = await startFakeLlama({ respond: scenarioResponse })
  t.after(() => backend.close())
  const h = await harness(t, { providers: { 'worker-native': { displayName: 'Native worker', api: 'openai-completions',
    baseURL: backend.origin + '/v1', apiKeyEnv: 'DYNAMIC_CONTEXT_FAKE_LLAMA_KEY', defaultContextWindow: 8192, defaultMaxTokens: 512,
    models: [{ id: 'worker-native-model', name: 'Worker', contextWindow: 8192, maxTokens: 512 }] } } })
  h.runner.submit(proposal())
  const remove = h.ctx.get('dynamicContextRoleModels').register({ pluginId: 'fixture', registrationId: 'worker', role: 'executor',
    backend: { provider: 'worker-native', model: 'worker-native-model' } })
  const task = await h.runner.runNext({ expectedRevision: 1 })
  assert.equal(task.trace.contract.provider, 'worker-native')
  assert.equal(backend.requests.length, 2)
  assert.ok(backend.requests.every(row => row.payload.model === 'worker-native-model'))
  assert.equal(h.backend.requests.length, 0)
  remove()
  await h.runner.runNext({ expectedRevision: h.runner.graph.read().revision })
  assert.equal(h.backend.requests.length, 2)
  assert.deepEqual(backend.errors, [])
})

test('real DSH -> shipped pi-ai -> fake llama: task boundaries, inheritance, tools and meter agree', async t => {
  const h = await harness(t); h.runner.submit(proposal())
  const results = []
  for (const key of ['a', 'b', 'c']) {
    results.push(await h.runner.runNext({ expectedRevision: h.runner.graph.read().revision }))
    assert.equal(results.at(-1).trace.assembly.task.key, key)
  }
  assert.equal(h.backend.requests.length, 5)
  assert.deepEqual(h.backend.errors, [])
  assert.deepEqual(h.toolCalls, ['fixture_read_a', 'fixture_read_b'])
  assert.equal(new Set(results.map(result => result.report.sessionId)).size, 3)
  const [a, b, c] = [h.backend.requests.slice(0, 2), h.backend.requests.slice(2, 4), h.backend.requests.slice(4)]
  for (const row of a) {
    assert.match(payloadText(row), /A_CONTEXT_PRIVATE_ONLY_A/)
    assert.doesNotMatch(payloadText(row), /B_CONTEXT_PRIVATE_ONLY_B|C_CONTEXT_PRIVATE_ONLY_C|UNUSED_CONTEXT/)
    assert.deepEqual(row.payload.tools.map(tool => tool.function.name), ['fixture_read_a'])
  }
  for (const row of b) {
    assert.match(payloadText(row), /B_CONTEXT_PRIVATE_ONLY_B/)
    assert.match(payloadText(row), /A_REPORT_DECLARED_FOR_INHERITANCE/)
    assert.doesNotMatch(payloadText(row), /A_CONTEXT_PRIVATE_ONLY_A|A_TOOL_PRIVATE_RAW|C_CONTEXT_PRIVATE_ONLY_C/)
    assert.deepEqual(row.payload.tools.map(tool => tool.function.name), ['fixture_read_b'])
  }
  assert.match(payloadText(c[0]), /C_CONTEXT_PRIVATE_ONLY_C/)
  assert.doesNotMatch(payloadText(c[0]), /A_CONTEXT_PRIVATE_ONLY_A|B_CONTEXT_PRIVATE_ONLY_B|A_REPORT_DECLARED_FOR_INHERITANCE|B_REPORT_NOT_INHERITED_BY_C|COMMON_CONTEXT/)
  assert.equal(c[0].payload.tools, undefined)
  for (const row of h.backend.requests) {
    assert.equal(row.payload.model, 'fake-llama')
    assert.match(payloadText(row), /HOST_POLICY_KEEP/)
    assert.equal(payloadText(row).includes(GLOBAL_PRIVATE), false)
    assert.doesNotMatch(payloadText(row), /UNUSED_CONTEXT_MUST_NOT_LEAK|FORBIDDEN_TOOL_PRIVATE_RAW/)
  }
  for (const result of results) {
    assert.equal(result.report.acceptance, 'UNVERIFIED_MODEL_REPORT')
    const evidence = result.report.evidence[0]
    assert.equal(createHash('sha256').update(fs.readFileSync(evidence.ref)).digest('hex'), evidence.sha256)
    for (const request of result.trace.requests) {
      assert.equal(request.derivesSameMessages, true)
      assert.deepEqual(request.measuredSurfaceSeqs, request.requestSurfaceSeqs)
      assert.ok(request.measuredTokens > 0)
    }
    const calls = result.trace.events.filter(event => event.type === 'tool/call')
    const toolResults = result.trace.events.filter(event => event.type === 'tool/result')
    for (const call of calls) assert.ok(toolResults.some(row => row.data.message.toolCallId === call.data.callId))
  }
  assert.equal(h.runner.graph.read().reports.length, 3)
  assert.equal(h.runner.graph.status().nodes.find(row => row.kind === 'container').status, 'COMPLETE')
  assert.equal(h.runner.graph.status().goalReached, false)
  assert.deepEqual(h.ctx.tools.schemas().map(tool => tool.name).sort(), ['fixture_forbidden', 'fixture_read_a', 'fixture_read_b',
    'transaction_graph_begin', 'transaction_graph_create', 'transaction_graph_finish', 'transaction_graph_read', 'transaction_graph_skip'])
  assert.ok((await h.ctx.systemPrompt.assemble()).contexts.some(row => row.text === GLOBAL_PRIVATE),
    'task-local suppression leaves the global context registry intact')
})

test('a completed prefix reopens with only declared reports and a fresh task session', async t => {
  const where = location(t)
  const first = await createHarness({ ...where, respond: scenarioResponse })
  first.runner.submit(proposal())
  const a = await first.runner.runNext({ expectedRevision: 1 }); await first.close()
  const second = await createHarness({ ...where, respond: scenarioResponse }); t.after(() => second.close())
  const b = await second.runner.runNext({ expectedRevision: 3 })
  assert.equal(b.report.text, 'B_REPORT_NOT_INHERITED_BY_C')
  assert.equal(b.trace.assembly.inheritedReports[0].text, a.report.text)
  assert.notEqual(b.report.sessionId, a.report.sessionId)
  assert.doesNotMatch(payloadText(second.backend.requests[0]), /A_CONTEXT_PRIVATE_ONLY_A|A_TOOL_PRIVATE_RAW/)
})

test('reopened ACTIVE is never replayed or silently reassigned', async t => {
  const where = location(t), first = new DynamicContextGraph(where)
  first.submit(proposal()); first.begin({ expectedRevision: 1 })
  const h = await createHarness({ ...where, respond: scenarioResponse }); t.after(() => h.close())
  const before = h.runner.graph.read()
  await assert.rejects(h.runner.runNext({ expectedRevision: 2 }), /RECOVERY_REQUIRED/)
  assert.deepEqual(h.runner.graph.read(), before)
  assert.equal(h.backend.requests.length, 0)
  assert.equal(h.runner.graph.status().active.recoveryRequired, true)
})

test('changed report evidence blocks inheritance before another model request', async t => {
  const h = await harness(t); h.runner.submit(proposal())
  const a = await h.runner.runNext({ expectedRevision: 1 })
  fs.appendFileSync(a.report.evidence[0].ref, '\nchanged')
  await assert.rejects(h.runner.runNext({ expectedRevision: 3 }), /ARTIFACT_CHANGED_OR_HASH_MISMATCH/)
  assert.equal(h.backend.requests.length, 2)
  assert.equal(h.runner.graph.read().reports.length, 1)
  assert.equal(h.runner.graph.status().active.nodeId, h.runner.graph.read().contexts.bindings[1].taskId)
})

for (const [name, response, expectedRequests] of [
  ['backend disconnect', () => ({ text: 'partial answer', disconnect: true }), 1],
  ['empty answer', () => ({ text: '' }), 1],
  ['truncated answer', () => ({ text: 'unfinished report', finishReason: 'length' }), 1],
  ['denied tool call', ({ payload }) => payload.messages.some(row => row.role === 'tool')
    ? { text: 'ignore the denied tool and claim success' } : { tools: [{ name: 'fixture_forbidden' }] }, 1],
]) test(`${name} cannot complete the task or start its dependent`, async t => {
  const h = await harness(t, { respond: response }); h.runner.submit(proposal())
  await assert.rejects(h.runner.runNext({ expectedRevision: 1 }))
  assert.equal(h.backend.requests.length, expectedRequests)
  assert.equal(h.runner.graph.read().reports.length, 0)
  assert.ok(h.runner.graph.status().active)
  assert.equal(h.toolCalls.includes('fixture_forbidden'), false)
  await assert.rejects(h.runner.runNext({ expectedRevision: 2 }), /ONE_ACTIVE_LEAF_ONLY/)
  assert.equal(h.backend.requests.length, expectedRequests)
})

test('the retired character limit permits a full managed context', async t => {
  const h = await harness(t, { config: { maxContextCharacters: 100 } }); h.runner.submit(proposal())
  assert.ok((await h.runner.runNext({ expectedRevision: 1 })).report.text)
  assert.ok(h.backend.requests.length > 0)
  assert.equal(h.runner.graph.read().reports.length, 1)
})

test('request loop cap preserves ACTIVE instead of repeatedly calling the backend', async t => {
  const h = await harness(t, { respond: () => ({ tools: [{ name: 'fixture_read_a' }] }), config: { maxRequestsPerTask: 2 } })
  h.runner.submit(proposal())
  await assert.rejects(h.runner.runNext({ expectedRevision: 1 }))
  assert.equal(h.backend.requests.length, 2)
  assert.equal(h.runner.graph.read().reports.length, 0)
})

test('cancellation and concurrent run attempts cannot duplicate a claim', async t => {
  let requested
  const received = new Promise(resolve => { requested = resolve })
  const h = await harness(t, { respond: () => { requested(); return { hang: true } } })
  h.runner.submit(proposal())
  const controller = new AbortController()
  const running = h.runner.runNext({ expectedRevision: 1, signal: controller.signal })
  const rejection = assert.rejects(running)
  await received
  await assert.rejects(h.runner.runNext({ expectedRevision: 2 }), code('SERIAL_CONTEXT_RUN_IN_PROGRESS'))
  controller.abort(new Error('synthetic user cancellation'))
  await rejection
  assert.equal(h.backend.requests.length, 1)
  assert.equal(h.runner.graph.read().reports.length, 0)
  assert.equal(h.runner.busy, false)
})

test('timeout closes its task session and leaves an unresolved attempt', async t => {
  const h = await harness(t, { respond: () => ({ hang: true }), config: { timeoutMs: 50 } })
  h.runner.submit(proposal())
  await assert.rejects(h.runner.runNext({ expectedRevision: 1 }))
  assert.equal(h.runner.graph.read().reports.length, 0)
  assert.ok(h.runner.graph.status().active)
  const attempt = h.runner.graph.status().active.attemptId
  const trace = JSON.parse(fs.readFileSync(path.join(h.runner.config.directory, attempt, 'trace.json')))
  assert.equal(trace.status, 'TIMEOUT_UNKNOWN')
})
