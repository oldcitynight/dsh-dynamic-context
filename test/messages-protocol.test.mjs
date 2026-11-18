import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { DeepSeekAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { startFakeMessages, messagesSSE } from '../testing/fake-messages.mjs'
import { serializeDirectRequest, directEndpoint, directProtocolHeaders } from '../direct-wire.mjs'
import { readCompletion } from '../direct-http.mjs'
import { apiParameters, directProtocol, resolveReasoningPolicy } from '../api-protocol.mjs'
import { validateConfig } from '../index.mjs'
import { createRuntimeHarness, runtimeProposal } from '../testing/runtime-harness.mjs'
import { directRevisionRole, readRoleRecord } from '../revision-runtime.mjs'
import { COMPACTION_INSTRUCTION } from '../dsh-compaction-policy.mjs'
import { nativePressure } from '../native-compaction.mjs'
import { digest } from 'dsh-better-task-grapth/core'
import { directAuthHeaders } from '../direct-auth.mjs'

const signal = () => new AbortController().signal
const direct = { api: 'deepseek', protocol: 'auto', responseModelAliases: [] }
const payload = effort => ({ model: 'fake-llama', messages: [{ role: 'system', content: 'Fixed host policy.' }, { role: 'user', content: 'Inspect the evidence.' }],
  max_tokens: 512, stream: true, stream_options: { include_usage: true }, ...apiParameters({ ...direct, reasoningEffort: effort }) })
const source = effort => ({ session: { id: 'main', requestHeader: () => ({ config: { provider: 'fake', model: 'fake-llama', reasoningEffort: effort } }) } })
const parse = (raw, options = {}) => readCompletion(new Response(raw, { headers: { 'content-type': 'text/event-stream' } }), {
  signal: signal(), model: 'fake-llama', direct, maxResponseBytes: 100000, ...options })

test('default protocol, official endpoint migration and legacy opt-out are explicit', () => {
  assert.equal(directProtocol(direct), 'messages')
  assert.equal(directProtocol({ api: 'openai-compatible', protocol: 'auto' }), 'chat-completions')
  assert.equal(directEndpoint({ ...direct, endpoint: 'https://api.deepseek.com/chat/completions' }), 'https://api.deepseek.com/anthropic/v1/messages')
  assert.equal(directEndpoint({ ...direct, endpoint: 'https://api.deepseek.com/v1/chat/completions' }), 'https://api.deepseek.com/anthropic/v1/messages')
  assert.equal(directEndpoint({ ...direct, endpoint: 'http://127.0.0.1:5/private/messages' }), 'http://127.0.0.1:5/private/messages')
  assert.throws(() => directEndpoint({ ...direct, endpoint: 'http://127.0.0.1:5/v1/chat/completions' }), /DIRECT_MESSAGES_ENDPOINT_REQUIRED/)
  const legacy = { ...direct, protocol: 'chat-completions', endpoint: 'https://api.deepseek.com/chat/completions' }
  assert.equal(directEndpoint(legacy), legacy.endpoint); assert.deepEqual(directProtocolHeaders(legacy), {})
  const value = payload('high'); assert.equal(serializeDirectRequest(value, legacy), value)
})

for (const effort of [undefined, 'off', 'low', 'high', 'max']) test('actual native adapter and direct send identical reasoning controls and prose: ' + (effort ?? 'default'), async t => {
  const backend = await startFakeMessages({ respond: () => ({ text: 'Checked.' }) })
  t.after(() => backend.close())
  const options = resolveAdapterOptions({ baseURL: backend.origin + '/v1', models: [{ id: 'fake-llama' }] })
  const adapter = new DeepSeekAdapter({ options: () => options, resolveAuth: async () => ({ headers: { authorization: 'Bearer fake-only' } }),
    resolveUserId: () => 'fake-only', prepareExtensions: async () => ({ fields: {}, accept: async () => {} }) })
  const request = payload(effort)
  const chunks = []
  for await (const chunk of adapter.stream({ provider: 'fake', model: 'fake-llama', maxTokens: 512, signal: signal(), reasoningEffort: effort,
    messages: request.messages.map(message => ({ role: message.role, content: [{ type: 'text', text: message.content }], source: { kind: 'user' } })) })) chunks.push(chunk)
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  const wire = serializeDirectRequest(request, direct), native = backend.requests[0]
  assert.equal(native.path, '/v1/messages')
  assert.deepEqual(wire, native.payload)
  assert.equal(wire.system, 'Fixed host policy.')
  assert.deepEqual(wire.messages, [{ role: 'user', content: [{ type: 'text', text: 'Inspect the evidence.' }] }])
  assert.equal(wire.reasoning_effort, undefined); assert.equal(wire.response_format, undefined)
  assert.deepEqual(backend.errors, [])
})

test('Messages auto inheritance resolves the native high default without a catalog', async () => {
  const resolved = await resolveReasoningPolicy({ config: { provider: 'direct-only', model: 'fake-llama', direct: { ...direct, reasoningEffort: 'auto' } },
    ctx: {}, signal: signal() })
  assert.equal(resolved.receipt.effective.reasoningEffort, 'high')
  for (const effort of ['off', 'low', 'high', 'max']) {
    const result = await resolveReasoningPolicy({ config: { direct: { ...direct, reasoningEffort: 'auto' } }, ctx: {}, sourceAgent: source(effort), signal: signal() })
    const wire = serializeDirectRequest({ ...payload(), ...apiParameters(result.config.direct) }, result.config.direct)
    assert.deepEqual(wire.thinking, { type: effort === 'off' ? 'disabled' : 'enabled' })
    assert.deepEqual(wire.output_config, effort === 'off' ? undefined : { effort })
  }
})

test('Messages API key authentication matches native without recording the key', async () => {
  const ctx = { get: () => ({ resolve: async () => ({ value: 'private-fixture-key' }) }) }
  assert.deepEqual(await directAuthHeaders(ctx, { ...direct, apiKeyEnv: 'FIXTURE_KEY' }, signal()), { 'x-api-key': 'private-fixture-key' })
  assert.deepEqual(await directAuthHeaders(ctx, { ...direct, protocol: 'chat-completions', apiKeyEnv: 'FIXTURE_KEY' }, signal()), { authorization: 'Bearer private-fixture-key' })
})

test('native and direct serialize identical signed thinking and tool-result history', async t => {
  const firstOutput = { blocks: [{ type: 'thinking', thinking: 'Check first.', signature: 'signed' },
    { type: 'text', text: 'Inspecting.' }, { type: 'tool_use', id: 'call', name: 'inspect', arguments: '{"path":"a"}' }] }
  const backend = await startFakeMessages({ respond: ({ index }) => index === 1 ? firstOutput : { text: 'Done.' } })
  t.after(() => backend.close())
  const connection = resolveAdapterOptions({ baseURL: backend.origin + '/v1', models: [{ id: 'fake-llama' }] })
  const adapter = new DeepSeekAdapter({ options: () => connection, resolveAuth: async () => ({ headers: {} }), resolveUserId: () => 'fake-only',
    prepareExtensions: async () => ({ fields: {}, accept: async () => {} }) })
  const request = payload('max'), native = request.messages.map(message => ({ role: message.role, content: [{ type: 'text', text: message.content }], source: { kind: 'user' } }))
  const schema = { name: 'inspect', description: 'Read evidence', parameters: { type: 'object', properties: { path: { type: 'string' } } } }
  const options = { provider: 'fake', model: 'fake-llama', maxTokens: 512, reasoningEffort: 'max', signal: signal(), messages: native, tools: [schema] }
  const chunks = []; for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  native.push({ role: 'assistant', content: chunks.filter(c => c.type === 'block-end').map(c => c.block),
    source: { kind: 'model', model: 'fake-llama', replayState: chunks.at(-1).replayState } },
    { role: 'tool', toolCallId: 'call', content: [{ type: 'text', text: 'Evidence.' }], source: { kind: 'tool' } })
  for await (const _ of adapter.stream(options)) {}
  const completed = await parse(messagesSSE(firstOutput))
  request.messages.push(completed.message, { role: 'tool', tool_call_id: 'call', content: 'Evidence.' })
  request.tools = [{ type: 'function', function: schema }]
  assert.deepEqual(serializeDirectRequest(request, direct), backend.requests[1].payload)
  assert.deepEqual(backend.errors, [])
})

test('thinking blocks, signatures, tool order and native cache usage survive fragmented SSE and replay', async () => {
  const raw = messagesSSE({ blocks: [{ type: 'thinking', thinking: '先检查。', signature: 'signed-one' }, { type: 'text', text: 'Observed.' },
    { type: 'thinking', thinking: 'Then act.', signature: 'signed-two' }, { type: 'tool_use', id: 'call', name: 'inspect', arguments: '{"target":"a"}' }],
    messagesUsage: { input_tokens: 70, cache_read_input_tokens: 30, cache_creation_input_tokens: 5, output_tokens: 10 } })
  const encoded = new TextEncoder().encode(raw.replaceAll('\n', '\r\n')), deltas = []
  const stream = new ReadableStream({ start(controller) { for (let i = 0; i < encoded.length; i += 7) controller.enqueue(encoded.slice(i, i + 7)); controller.close() } })
  const result = await parse(stream, { onDelta: value => deltas.push(value) })
  assert.equal(result.reasoning, '先检查。Then act.'); assert.equal(result.text, 'Observed.')
  assert.deepEqual(result.usage, { prompt_tokens: 105, completion_tokens: 10, total_tokens: 115, prompt_cache_hit_tokens: 30, prompt_cache_miss_tokens: 75 })
  assert.ok(deltas.some(delta => delta.reasoning === '先检查。'))
  const input = payload('high'); input.messages.push(result.message, { role: 'tool', tool_call_id: 'call', content: 'Observed evidence.' })
  const wire = serializeDirectRequest(input, direct)
  assert.deepEqual(wire.messages[1].content, [{ type: 'thinking', thinking: '先检查。', signature: 'signed-one' }, { type: 'text', text: 'Observed.' },
    { type: 'thinking', thinking: 'Then act.', signature: 'signed-two' }, { type: 'tool_use', id: 'call', name: 'inspect', input: { target: 'a' } }])
  assert.deepEqual(wire.messages[2].content, [{ type: 'tool_result', tool_use_id: 'call', content: [{ type: 'text', text: 'Observed evidence.' }] }])
  result.message.reasoning_content = 'tampered'; assert.throws(() => serializeDirectRequest(input, direct), /REPLAY_INVALID/)
})

for (const [name, change, code] of [
  ['missing terminal', raw => raw.slice(0, raw.indexOf('event: message_stop')), 'DIRECT_INCOMPLETE_SSE'],
  ['duplicate terminal', raw => raw + 'event: message_stop\ndata: {"type":"message_stop"}\n\n', 'DIRECT_DATA_AFTER_DONE'],
  ['max output', raw => raw.replace('end_turn', 'max_tokens'), 'DIRECT_REPORT_DID_NOT_STOP_NORMALLY'],
  ['wrong model', raw => raw.replace('fake-llama', 'other-model'), 'DIRECT_RESPONSE_MODEL_MISMATCH'],
  ['wrong event type', raw => raw.replace('event: message_start', 'event: message_delta'), 'DIRECT_MESSAGES_INVALID_STREAM'],
  ['negative usage', raw => raw.replace('"input_tokens":70', '"input_tokens":-1'), 'DIRECT_MESSAGES_INVALID_STREAM'],
  ['unsettled block', raw => raw.replace(/event: content_block_stop\ndata: [^\n]+\n\n/, ''), 'DIRECT_MESSAGES_INVALID_STREAM'],
]) test('Messages rejects ' + name + ' without accepting partial work', async () => {
  await assert.rejects(parse(change(messagesSSE({ text: 'Partial.' }))), error => error.code === code && error.directReceipt !== undefined)
})

test('Messages idle timeout, cancellation and response bounds retain failure receipts', async () => {
  const make = () => new ReadableStream({ start() {} })
  await assert.rejects(parse(make(), { direct: { ...direct, streamIdleTimeoutMs: 10 } }), { code: 'DIRECT_STREAM_IDLE_TIMEOUT' })
  const control = new AbortController(), pending = parse(make(), { signal: control.signal })
  control.abort(Object.assign(Error('CANCELLED'), { code: 'CANCELLED' })); await assert.rejects(pending, { code: 'CANCELLED' })
  await assert.rejects(parse(messagesSSE({ text: 'long'.repeat(500) }), { maxResponseBytes: 128 }), { code: 'DIRECT_RESPONSE_BYTE_LIMIT' })
})

test('real worker Messages tool rounds resume once with exact payload receipts and thinking signatures', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'messages-worker-'))), projectRoot = path.join(root, 'project')
  fs.mkdirSync(projectRoot)
  const backend = await startFakeMessages({ respond: ({ payload, index }) => {
    assert.deepEqual(payload.output_config, { effort: 'max' })
    if (index > 1) assert.equal(payload.messages.find(m => m.role === 'assistant').content[0].signature, 'fake-signature')
    return index === 1 ? { reasoning: 'Inspect current state.', tools: [{ name: 'dynamic_task_status', arguments: {} }] } : { text: 'Qualified result.' }
  } })
  const instances = []
  t.after(async () => { for (const h of instances) await h.close(); await backend.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const open = async () => {
    const h = await createRuntimeHarness({ projectRoot, directory: path.join(root, 'state'), backend,
      config: { storageRoot: root, allowedTools: ['dynamic_task_status'], direct: { ...direct, endpoint: backend.origin + '/v1/messages',
        reasoningEffort: 'max', durable: true, tracePayloads: 'references', runtime: { modules: ['state'] } } },
      setup: async ctx => { ctx.on('llm/stream', async function* () { throw Error('Native assembly must not run') }) } })
    instances.push(h); return h
  }
  const first = await open(); first.runner.submit(runtimeProposal(['dynamic_task_status']))
  const paused = await first.runner.runNext({ expectedRevision: 1, pauseAfterRequests: 1 }); await first.close()
  const second = await open(), result = await second.runner.resumeActive({ expectedRevision: 2, checkpointChecksum: paused.checkpoint.checksum })
  assert.equal(result.report.text, 'Qualified result.'); assert.equal(backend.requests.length, 2)
  assert.deepEqual(backend.errors, [])
  result.trace.requests.forEach((request, index) => assert.equal(request.bodySha256, createHash('sha256').update(backend.requests[index].rawBody).digest('hex')))
  assert.deepEqual(result.trace.requests.at(-1).payload, backend.requests[1].payload)
})

test('Messages usage anchors still apply to private history after wire projection', () => {
  const history = payload('high').messages, wire = serializeDirectRequest(payload('high'), direct)
  const pressure = nativePressure(history, [], [{ status: 'COMPLETE', purpose: 'task', payload: wire, usage: { prompt_tokens: 1000 },
    normalizedHistory: { length: history.length, sha256: digest(history), toolsSha256: digest([]) } }])
  assert.equal(pressure.tokens, 1000); assert.equal(pressure.anchorApplied, true)
  const changed = nativePressure([...history, { role: 'user', content: 'Changed.' }].slice(1), [], [{ status: 'COMPLETE', purpose: 'task', payload: wire,
    usage: { prompt_tokens: 1000 }, normalizedHistory: { length: history.length, sha256: digest(history), toolsSha256: digest([]) } }])
  assert.equal(changed.anchorApplied, false)
})

test('all independent roles, JSON validation and role compaction use Messages with the inherited effort', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'messages-roles-'))
  let summaries = 0, reads = 0
  const backend = await startFakeMessages({ respond: ({ payload }) => {
    assert.deepEqual(payload.output_config, { effort: 'low' }); assert.equal(payload.response_format, undefined)
    if (payload.messages.at(-1).content.at(-1).text?.startsWith(COMPACTION_INSTRUCTION)) { summaries++; return { text: 'Evidence navigation only.' } }
    if (payload.tools?.some(tool => tool.name === 'dynamic_context_read_evidence')) {
      const manifest = payload.messages.flatMap(m => m.content).filter(b => b.type === 'text').map(b => { try { return JSON.parse(b.text) } catch { return null } })
        .find(value => value?.protocol === 'direct-role-evidence-v1' && value.sources)
      if (!reads++) return { reasoning: 'Read the original evidence.', tools: [{ name: 'dynamic_context_read_evidence',
        arguments: { id: manifest.sources[0].id, start: 0, end: 80 } }] }
      assert.ok(payload.messages.at(-1).content.some(block => block.type === 'tool_result' && block.content[0].text.includes('large evidence')))
    }
    return { text: '{"observed":true}' }
  } })
  t.after(async () => { await backend.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const runner = { controller: source('low'), ctx: { get: () => ({ resolve: async () => ({ value: 'fake-only' }) }) },
    config: validateConfig({ projectRoot: root, directory: root, provider: 'fake', model: 'fake-llama', systemPrompt: 'Host', transport: 'direct',
      revision: { policy: { objective: 'Check', requirements: [{ id: 'a', text: 'Check evidence' }] }, maxOutputTokens: 32768 },
      direct: { ...direct, endpoint: backend.origin + '/v1/messages', apiKeyEnv: 'FAKE_KEY', durable: true,
        compaction: { strategy: 'dsh-native', contextWindow: 262144 }, maxRequestBytes: null, maxResponseBytes: null } }) }
  for (const role of ['updater','reviewer','result_check','plan_check','result_repair','blockage','blockage_audit','group_audit','scope_plan','scope_update','scope_audit','task_reporter','scope_blockage','scope_pause']) {
    const runId = `revision_${role}_${randomUUID()}`
    const result = await directRevisionRole(runner, { role, runId, signal: signal(), messages: [
      { role: 'system', content: 'Check evidence and return a JSON object.' },
      { role: 'user', content: JSON.stringify({ evidence: role === 'result_check' ? 'large evidence '.repeat(24000) : 'supplied facts' }) }] })
    assert.equal(result.observed, true)
    const record = readRoleRecord(runner, runId)
    assert.ok(record.calls.every(call => call.payload.output_config.effort === 'low'))
    assert.ok(record.calls.every(call => call.bodySha256 === createHash('sha256').update(JSON.stringify(call.payload)).digest('hex')))
  }
  assert.ok(summaries > 0); assert.ok(reads >= 2); assert.deepEqual(backend.errors, [])
})

test('worker compression and resume keep Messages effort, raw request hashes and accounting intact', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'messages-compress-'))), projectRoot = path.join(root, 'workspace')
  fs.mkdirSync(projectRoot); fs.writeFileSync(path.join(projectRoot, 'input.txt'), 'input evidence')
  let normal = 0, summaries = 0, metered = 0
  const backend = await startFakeMessages({ respond: ({ payload }) => {
    assert.deepEqual(payload.output_config, { effort: 'high' })
    if (payload.messages.at(-1).content.at(-1).text?.startsWith(COMPACTION_INSTRUCTION)) { summaries++; return { text: 'Input evidence was read. Output remains pending.' } }
    if (++normal <= 6) return { reasoning: 'Check evidence.', text: 'Historical exploration detail. '.repeat(2000), tools: [{ name: 'read', arguments: { file_path: 'input.txt' } }] }
    if (normal === 7) return { tools: [{ name: 'write', arguments: { file_path: 'output.txt', content: 'continued after native summary' } }] }
    return { text: 'File written. Independent acceptance NOT_RUN.' }
  } })
  const options = { projectRoot, directory: path.join(root, 'state'), backend,
    config: { storageRoot: root, maxContextCharacters: 8388608, maxRequestsPerTask: 10, timeoutMs: 60000,
      direct: { ...direct, endpoint: backend.origin + '/v1/messages', reasoningEffort: 'high', durable: true, maxRequestBytes: 8388608,
        compaction: { strategy: 'dsh-native', contextWindow: 131072 } } } }
  const first = await createRuntimeHarness(options); let second
  t.after(async () => { await second?.close(); await first.close(); await backend.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const meter = { version: 'messages-fixture', measure: async wire => {
    assert.ok(wire.system && wire.output_config); assert.ok(wire.messages.every(m => Array.isArray(m.content)))
    metered++; return { tokens: 100, method: 'estimate' }
  } }
  first.runner.registerInputMeter(meter); first.runner.submit(runtimeProposal(['read', 'write']))
  const paused = await first.runner.runNext({ expectedRevision: 1, pauseAfterRequests: 7 })
  assert.equal(paused.paused, true); const before = summaries; await first.close()
  second = await createRuntimeHarness(options); second.runner.registerInputMeter(meter)
  const result = await second.runner.resumeActive({ expectedRevision: 2, checkpointChecksum: paused.checkpoint.checksum })
  assert.ok(summaries > 0); assert.equal(summaries, before)
  assert.ok(metered >= backend.requests.length, 'chunk planning performs local admission measurements before HTTP sends')
  assert.ok(result.trace.requests.every(row => row.inputMeasurement?.method === 'estimate'))
  assert.equal(result.trace.requests.filter(r => r.purpose === 'compaction').length, summaries)
  for (const [i, r] of result.trace.requests.entries()) assert.equal(r.bodySha256, createHash('sha256').update(backend.requests[i].rawBody).digest('hex'))
  assert.equal(fs.readFileSync(path.join(projectRoot, 'output.txt'), 'utf8'), 'continued after native summary')
  assert.deepEqual(backend.errors, [])
})
