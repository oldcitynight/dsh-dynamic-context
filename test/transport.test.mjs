import test from 'node:test'
import { executeFixtureTool } from '../testing/harness.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { bridge, composeHooks } from '../adapter-bridge.mjs'
import { createHarness, GLOBAL_PRIVATE, HOST_POLICY } from '../testing/harness.mjs'
import { proposal, scenarioResponse } from '../testing/scenario.mjs'

async function fixture(t, { transport = 'direct', respond = () => ({ text: 'Synthetic report' }), config = {}, setup } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-context-transport-')))
  let h
  t.after(async () => { if (h) await h.close(); fs.rmSync(root, { recursive: true, force: true }) })
  h = await createHarness({ projectRoot: root, directory: path.join(root, 'state'), respond, setup, config: { transport, ...config } })
  return h
}
const extraTool = h => h.ctx.systemPrompt.tools(() => ({ schemas: [{ name: 'probe_unlisted_schema',
  description: 'UNAPPROVED_TOOL_DESCRIPTION', parameters: { type: 'object', properties: {}, additionalProperties: false } }] }))
function preStepMessage(h, { secondOnly = false } = {}) {
  h.ctx.on('agent/pre-step', async (event, next) => {
    const decision = await next()
    if (decision.kind !== 'enter' || secondOnly && event.step !== 2) return decision
    return { ...decision, messages: [...decision.messages, createUserMessage({ source: { kind: 'user' },
      content: [{ type: 'text', text: 'UNAPPROVED_PRESTEP_MESSAGE' }] })] }
  })
}
function payloadHook(h) {
  h.ctx.on('llm/stream', async function* (_options, next) {
    const hooks = composeHooks(bridge.getStore()?.hooks, { onPayload: payload => ({ ...payload,
      messages: [...payload.messages, { role: 'user', content: 'UNAPPROVED_WIRE_MESSAGE' }] }) })
    let iterator
    try {
      iterator = bridge.run({ hooks }, () => next()[Symbol.asyncIterator]())
      for (;;) {
        const item = await bridge.run({ hooks }, () => iterator.next())
        if (item.done) return
        yield item.value
      }
    } finally { await bridge.run({ hooks }, () => iterator?.return?.()) }
  })
}
function failedTrace(h) {
  const attempt = h.runner.graph.status().active.attemptId
  return JSON.parse(fs.readFileSync(path.join(h.runner.config.directory, attempt, 'trace.json')))
}
function assertBlocked(h, count) {
  assert.equal(h.backend.requests.length, count)
  assert.equal(h.runner.graph.read().reports.length, 0)
  assert.ok(h.runner.graph.status().active)
}

test('direct route bypasses all prompt, Agent-loop and LLM-hook injection paths', async t => {
  const h = await fixture(t, { transport: 'direct', respond: scenarioResponse })
  const callbacks = { sections: 0, toolProvider: 0, preStep: 0, llm: 0, createAgent: 0 }
  h.ctx.systemPrompt.section({ name: 'probe:complete', order: 2, complete: true, text: 'OTHER_COMPLETE_POLICY' })
  h.ctx.systemPrompt.section({ name: 'probe:throwing', order: 3, text: () => { callbacks.sections++; throw new Error('DEFAULT_PROVIDER_MUST_NOT_RUN') } })
  h.ctx.systemPrompt.tools(() => { callbacks.toolProvider++; throw new Error('DEFAULT_TOOL_PROVIDER_MUST_NOT_RUN') })
  h.ctx.on('agent/pre-step', () => { callbacks.preStep++; throw new Error('PRESTEP_MUST_NOT_RUN') })
  h.ctx.on('llm/stream', async function* () { callbacks.llm++; throw new Error('LLM_STREAM_MUST_NOT_RUN') })
  h.ctx.agents.create = async () => { callbacks.createAgent++; throw new Error('NATIVE_AGENT_MUST_NOT_BE_CREATED') }
  h.runner.submit(proposal())
  const results = []
  for (const task of ['a', 'b', 'c']) results.push(await h.runner.runNext({ expectedRevision: h.runner.graph.read().revision }))
  assert.equal(h.backend.requests.length, 5)
  assert.deepEqual(callbacks, { sections: 0, toolProvider: 0, preStep: 0, llm: 0, createAgent: 0 })
  assert.deepEqual(h.toolCalls, ['fixture_read_a', 'fixture_read_b'])
  const [a, b, c] = results
  assert.equal(b.trace.assembly.inheritedReports[0].text, a.report.text)
  assert.equal(c.trace.assembly.inheritedReports.length, 0)
  assert.doesNotMatch(JSON.stringify(h.backend.requests.slice(2, 4)), /A_CONTEXT_PRIVATE_ONLY_A|A_TOOL_PRIVATE_RAW/)
  assert.doesNotMatch(JSON.stringify(h.backend.requests[4]), /A_REPORT_DECLARED_FOR_INHERITANCE|B_REPORT_NOT_INHERITED_BY_C/)
  for (const payload of h.backend.requests.map(row => row.payload)) {
    assert.equal(payload.messages[0].content, HOST_POLICY)
    assert.equal(payload.messages.filter(row => row.role === 'system').length, 1)
    assert.equal(payload.messages.filter(row => row.role === 'user').length, 1)
    assert.equal(JSON.stringify(payload).includes(GLOBAL_PRIVATE), false)
    assert.doesNotMatch(JSON.stringify(payload), /OTHER_COMPLETE_POLICY|UNAPPROVED/)
  }
  const traces = results.flatMap(result => result.trace.requests)
  for (let index = 0; index < traces.length; index++) {
    assert.equal(traces[index].bodySha256, createHash('sha256').update(h.backend.requests[index].rawBody).digest('hex'))
    assert.equal(traces[index].validation, 'PASS')
  }
  assert.equal(h.runner.graph.status().goalReached, false)
})

test('direct request is persisted before its first HTTP effect and credentials stay out of artifacts', async t => {
  let h, observed
  h = await fixture(t, { transport: 'direct', respond: ({ record }) => {
    observed = failedTrace(h)
    assert.equal(observed.requests[0].status, 'SENT')
    assert.equal(observed.requests[0].bodySha256, createHash('sha256').update(record.rawBody).digest('hex'))
    return { text: 'Synthetic report' }
  } })
  h.runner.submit(proposal())
  const result = await h.runner.runNext({ expectedRevision: 1 })
  assert.ok(observed)
  assert.equal(JSON.stringify(result.trace).includes('fake-llama-only'), false)
  assert.equal(fs.readFileSync(result.report.evidence[0].ref, 'utf8').includes('fake-llama-only'), false)
  assert.equal(createHash('sha256').update(fs.readFileSync(result.report.evidence[0].ref)).digest('hex'), result.report.evidence[0].sha256)
})

test('direct mode requires an explicit agentless permission for every tool', async t => {
  const h = await fixture(t, { transport: 'direct', config: { direct: { agentlessTools: [] } } })
  assert.throws(() => h.runner.submit(proposal()), /DIRECT_TOOL_REQUIRES_EXPLICIT_AGENTLESS_PERMISSION/)
  assert.equal(h.runner.graph.read(), null)
  assert.equal(h.backend.requests.length, 0)
})

test('direct mode retains the native global tool guard', async t => {
  const h = await fixture(t, { transport: 'direct', respond: scenarioResponse })
  h.ctx.tools.guard(() => 'Synthetic host policy denial')
  h.runner.submit(proposal())
  const result = await h.runner.runNext({ expectedRevision: 1 })
  assert.match(JSON.stringify(result.trace.events.filter(row => row.type === 'tool/result')), /Synthetic host policy denial/)
  assert.equal(h.backend.requests.length, 2)
  assert.deepEqual(h.toolCalls, [])
})

test('an around-tool callback cannot redirect a direct execution after permission checks', async t => {
  const h = await fixture(t, { transport: 'direct', respond: scenarioResponse })
  h.ctx.on('tools/execute', async (exec, next) => { exec.name = 'fixture_forbidden'; return next() })
  h.runner.submit(proposal())
  await assert.rejects(h.runner.runNext({ expectedRevision: 1 }), /DIRECT_TOOL_EXECUTION_CONTRACT_MISMATCH/)
  assertBlocked(h, 1)
  assert.deepEqual(h.toolCalls, [])
})

test('a tool wrapper cannot execute the same direct call again through nested dispatch', async t => {
  const h = await fixture(t, { transport: 'direct', respond: scenarioResponse })
  let attempted = false
  h.ctx.on('tools/execute', async (exec, next) => {
    attempted = true
    const duplicate = await executeFixtureTool(h.ctx, { callId: exec.callId, name: exec.name, arguments: exec.arguments, signal: exec.signal })
    assert.equal(duplicate.isError, true)
    return next()
  })
  h.runner.submit(proposal())
  await assert.rejects(h.runner.runNext({ expectedRevision: 1 }), /DIRECT_TOOL_EXECUTION_CONTRACT_MISMATCH/)
  assert.equal(attempted, true)
  assertBlocked(h, 1)
  assert.deepEqual(h.toolCalls, [])
})

for (const transport of ['direct']) test(`${transport} refuses tool-deferred user context`, async t => {
  const h = await fixture(t, { transport, respond: scenarioResponse })
  h.ctx.on('tools/execute', (exec, next) => {
    exec.deferContext(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'UNAPPROVED_DEFERRED_CONTEXT' }] }))
    return next()
  })
  h.runner.submit(proposal())
  await assert.rejects(h.runner.runNext({ expectedRevision: 1 }))
  assertBlocked(h, 1)
  assert.equal(JSON.stringify(h.backend.requests).includes('UNAPPROVED_DEFERRED_CONTEXT'), false)
})

for (const [name, respond] of [
  ['disconnect', () => ({ text: 'partial', disconnect: true })],
  ['empty response', () => ({ text: '' })],
  ['length termination', () => ({ text: 'partial', finishReason: 'length' })],
  ['non-SSE response', () => ({ status: 200, headers: { 'content-type': 'application/json' }, body: '{}' })],
  ['backend HTTP error', () => ({ status: 503, body: 'synthetic error' })],
  ['bad tool argument JSON', () => ({ tools: [{ name: 'fixture_read_a', argumentsText: '{' }] })],
  ['forbidden tool', () => ({ tools: [{ name: 'fixture_forbidden' }] })],
  ['invalid whole tool batch', () => ({ tools: [{ name: 'fixture_read_a' }, { name: 'fixture_read_b', arguments: [] }] })],
  ['duplicate call IDs in a batch', () => ({ tools: [{ name: 'fixture_read_a', id: 'same' }, { name: 'fixture_read_a', id: 'same' }] })],
]) test(`direct ${name} preserves ACTIVE without replay or tool side effects`, async t => {
  const h = await fixture(t, { transport: 'direct', respond }); h.runner.submit(proposal())
  await assert.rejects(h.runner.runNext({ expectedRevision: 1 }))
  assertBlocked(h, ['bad tool argument JSON', 'forbidden tool', 'invalid whole tool batch'].includes(name) ? 4 : 1)
  assert.deepEqual(h.toolCalls, [])
  await assert.rejects(h.runner.runNext({ expectedRevision: 2 }), /ONE_ACTIVE_LEAF_ONLY/)
  assert.equal(h.backend.requests.length, ['bad tool argument JSON', 'forbidden tool', 'invalid whole tool batch'].includes(name) ? 4 : 1)
})

test('direct redirect is rejected rather than followed or retried', async t => {
  const h = await fixture(t, { transport: 'direct', respond: () => ({ status: 302, headers: { location: '/must-not-follow' } }) })
  h.runner.submit(proposal())
  await assert.rejects(h.runner.runNext({ expectedRevision: 1 }))
  assert.deepEqual(h.backend.routes, [{ method: 'POST', path: '/v1/chat/completions' }])
  assertBlocked(h, 1)
})

const chunk = (delta, finish_reason = null) => ({ model: 'fake-llama', choices: [{ index: 0, delta, finish_reason }] })
const frame = data => `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`
for (const [name, raw] of [
  ['missing DONE', frame(chunk({ content: 'partial' }, 'stop'))],
  ['DONE without finish', frame(chunk({ content: 'partial' })) + frame('[DONE]')],
  ['invalid JSON', 'data: {broken}\n\n'],
  ['extra content after finish', frame(chunk({ content: 'report' }, 'stop')) + frame(chunk({ content: 'extra' })) + frame('[DONE]')],
  ['response role injection', frame(chunk({ role: 'user', content: 'extra' }, 'stop')) + frame('[DONE]')],
]) test(`direct rejects SSE ${name}`, async t => {
  const h = await fixture(t, { transport: 'direct', respond: () => ({ rawSSE: raw }) }); h.runner.submit(proposal())
  await assert.rejects(h.runner.runNext({ expectedRevision: 1 }))
  assertBlocked(h, 1)
})

test('direct bounded SSE parser handles CRLF and split UTF-8 content', async t => {
  const raw = (': keep-alive\n\n' + frame(chunk({ role: 'assistant' })) + frame(chunk({ content: '合成测试报告' }, 'stop')) + frame('[DONE]')).replaceAll('\n', '\r\n')
  const bytes = Buffer.from(raw), fragments = []
  for (let start = 0; start < bytes.length; start += 17) fragments.push(bytes.subarray(start, start + 17))
  const h = await fixture(t, { transport: 'direct', respond: () => ({ rawSSE: fragments, fragmentDelayMs: 1 }) }); h.runner.submit(proposal())
  assert.equal((await h.runner.runNext({ expectedRevision: 1 })).report.text, '合成测试报告')
})

for (const [name, config, requests] of [
  ['request byte limit', { direct: { maxRequestBytes: 1024 } }, 0],
  ['response byte limit', { direct: { maxResponseBytes: 128 } }, 1],
]) test(`direct enforces ${name}`, async t => {
  const h = await fixture(t, { transport: 'direct', config }); h.runner.submit(proposal())
  await assert.rejects(h.runner.runNext({ expectedRevision: 1 }))
  assertBlocked(h, requests)
})

test('direct request cap cannot turn a tool loop into a completed report', async t => {
  const h = await fixture(t, { transport: 'direct', respond: scenarioResponse, config: { maxRequestsPerTask: 1 } })
  h.runner.submit(proposal())
  await assert.rejects(h.runner.runNext({ expectedRevision: 1 }), /TASK_REQUEST_LIMIT/)
  assertBlocked(h, 1)
  assert.deepEqual(h.toolCalls, ['fixture_read_a'])
})

test('direct cancellation rejects concurrent work and records uncertainty', async t => {
  let received
  const arrived = new Promise(resolve => { received = resolve })
  const h = await fixture(t, { transport: 'direct', respond: () => { received(); return { hang: true } } })
  h.runner.submit(proposal())
  const control = new AbortController(), run = h.runner.runNext({ expectedRevision: 1, signal: control.signal })
  const rejected = assert.rejects(run)
  await arrived
  await assert.rejects(h.runner.runNext({ expectedRevision: 2 }), /SERIAL_CONTEXT_RUN_IN_PROGRESS/)
  control.abort(new Error('Synthetic cancellation'))
  await rejected
  assertBlocked(h, 1)
  assert.equal(failedTrace(h).requests[0].status, 'UNKNOWN_OR_FAILED')
})

test('direct timeout stops HTTP and preserves ACTIVE', async t => {
  const h = await fixture(t, { transport: 'direct', respond: () => ({ hang: true }), config: { timeoutMs: 1000 } })
  h.runner.submit(proposal())
  await assert.rejects(h.runner.runNext({ expectedRevision: 1 }))
  assertBlocked(h, 1)
  assert.equal(failedTrace(h).status, 'TIMEOUT_UNKNOWN')
})

function registration(ctx, name, execute) {
  return ctx.tools.register(defineTool({ name, description: 'Isolated registration fixture', parameters: {},
    output: { schema: { type: 'object', properties: {}, additionalProperties: false },
      render: () => [{ type: 'text', text: 'Pinned tool completed' }] }, execute }))
}

for (const revoke of [false, true]) test(revoke
  ? 'revoking a pinned tool during its execution interrupts the Direct task without replay'
  : 'unrelated registrations during a pending tool do not change its payload or interrupt it', { timeout: 10000 }, async t => {
  const entered = Promise.withResolvers(), finish = Promise.withResolvers()
  const name = 'fixture_pending'
  let unregister, calls = 0, completed = false
  const h = await fixture(t, { config: { allowedTools: [name], direct: { agentlessTools: [name] } },
    setup(ctx) {
      unregister = registration(ctx, name, async (_args, exec) => {
        calls++; entered.resolve()
        await finish.promise
        exec.signal.throwIfAborted()
        completed = true
        return {}
      })
    },
    respond: ({ index }) => index === 1 ? { tools: [{ name }] } : { text: 'Completed once.' } })
  const plan = proposal()
  for (const binding of plan.contextGraph.bindings) binding.tools = binding.task === 'a' ? [name] : []
  h.runner.submit(plan)
  const run = h.runner.runNext({ expectedRevision: 1 })
  const result = revoke ? assert.rejects(run, error => error.code === 'DIRECT_TOOL_REGISTRY_CHANGED' && error.message.includes(name)) : run
  try {
    await Promise.race([entered.promise, run.then(() => { throw Error('Direct finished before the tool started') })])
    if (revoke) {
      unregister()
      registration(h.ctx, name, () => { throw Error('replacement must not run') })
    } else {
      const remove = registration(h.ctx, 'fixture_added_mid_task', () => { throw Error('not authorized') })
      remove()
      registration(h.ctx, 'fixture_added_mid_task', () => ({}))
    }
  } finally { finish.resolve() }
  const outcome = await result
  assert.equal(calls, 1)
  assert.equal(completed, !revoke)
  if (revoke) assertBlocked(h, 1)
  else {
    assert.equal(outcome.report.text, 'Completed once.')
    assert.equal(h.backend.requests.length, 2)
    assert.match(h.backend.requests[1].payload.messages.at(-1).content, /Pinned tool completed/)
    for (const { payload } of h.backend.requests) assert.deepEqual(payload.tools.map(row => row.function.name), [name])
  }
})

for (const transport of ['direct']) test(`${transport} accepts host policy and tool schemas exceeding the former character quota`, async t => {
  const h = await fixture(t, { transport, config: {
    systemPrompt: 'HOST_POLICY_KEEP '.repeat(900), allowedTools: ['fixture_read_a', 'fixture_read_b', 'fixture_large'],
    ...(transport === 'direct' ? { direct: { agentlessTools: ['fixture_read_a', 'fixture_read_b', 'fixture_large'] } } : {}),
  } })
  h.ctx.tools.register(defineTool({ name: 'fixture_large', description: 'large schema description '.repeat(2400), parameters: {},
    output: { schema: { type: 'object', properties: {}, additionalProperties: false }, render: () => [] }, execute: async () => ({}) }))
  const p = proposal(); p.contextGraph.bindings[0].tools = ['fixture_large']; h.runner.submit(p)
  const result = await h.runner.runNext({ expectedRevision: 1 })
  assert.ok(result.report.text)
  assert.ok(h.backend.requests.length)

})

test('direct missing credentials cannot fall back to ambient credentials or an unauthenticated request', async t => {
  const h = await fixture(t, { transport: 'direct' }); h.ctx.credentials.resolve = async () => undefined
  h.runner.submit(proposal())
  await assert.rejects(h.runner.runNext({ expectedRevision: 1 }), /DIRECT_MISSING_CONFIGURED_CREDENTIAL/)
  assertBlocked(h, 0)
})

test('direct timeout also interrupts a credential lookup before HTTP', async t => {
  const h = await fixture(t, { transport: 'direct', config: { timeoutMs: 40 } })
  h.ctx.credentials.resolve = () => new Promise(() => {})
  h.runner.submit(proposal())
  await assert.rejects(h.runner.runNext({ expectedRevision: 1 }))
  assertBlocked(h, 0)
  assert.equal(failedTrace(h).status, 'TIMEOUT_UNKNOWN')
})

test('closing a direct runner waits for its aborted request and leaves no committed report', async t => {
  let ready
  const received = new Promise(resolve => { ready = resolve })
  const h = await fixture(t, { transport: 'direct', respond: () => { ready(); return { hang: true } } })
  h.runner.submit(proposal())
  const rejected = assert.rejects(h.runner.runNext({ expectedRevision: 1 }))
  await received
  await h.runner.close(); await rejected
  assertBlocked(h, 1)
  assert.equal(h.runner.busy, false)
  await assert.rejects(h.runner.runNext({ expectedRevision: 2 }), /DYNAMIC_CONTEXT_RUNNER_CLOSED/)
})
