import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { directRevisionRole, readRoleRecord, revisionRecoveryState } from '../revision-runtime.mjs'
import { roleInputTokens, EVIDENCE_TOOL, EVIDENCE_SEARCH_TOOL } from '../role-context.mjs'
import { COMPACTION_INSTRUCTION, nativeCompactSpec } from '../dsh-compaction-policy.mjs'
import { startFakeLlama } from '../testing/fake-llama.mjs'
import { validateConfig } from '../index.mjs'
import { digest } from 'dsh-better-task-grapth/core'
import { ExecutionOutput } from '../execution-output.mjs'

const text = 'ordinary evidence 0123456789, '.repeat(24000) + '\nTAIL_COUNTEREXAMPLE: required_field is missing.\n'
const messages = () => [{ role: 'system', content: 'Independently check this evidence. Return a JSON verdict.' },
  { role: 'user', content: JSON.stringify({ contract: { objective: 'Check the entire source' }, task: { key: 'local' },
    programValidation: { artifactContents: [{ source: { ref: 'evidence.txt', sha256: digest(text) }, text }] } }) }]
async function fixture(t, respond, options = {}) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'role-context-')))
  const backend = await startFakeLlama({ respond, maxRequestBytes: 16 * 1024 * 1024,
    contextWindow: 262144, countInputTokens: roleInputTokens })
  const accounting = [], runner = { output: new ExecutionOutput(directory), ctx: { get: name => name === 'credentials' ? { resolve: async () => ({ value: 'fake-only' }) } : undefined },
    config: validateConfig({ projectRoot: directory, directory, provider: 'fake', model: 'fake-llama',
      systemPrompt: 'Host', transport: 'direct', revision: { policy: { objective: 'Inspect', requirements: [{ id: 'a', text: 'Verify' }] }, maxOutputTokens: 32768 },
      direct: { endpoint: backend.origin + '/v1/chat/completions', apiKeyEnv: 'FAKE_ROLE_KEY', durable: true,
        compaction: { strategy: 'dsh-native', contextWindow: 262144 }, maxRequestBytes: null, maxResponseBytes: null, streamIdleTimeoutMs: 5000 } }),
    revisionAccounting: { beforeRequest: async (_, meta) => accounting.push(['before', meta]),
      afterResponse: async (_, meta) => accounting.push(['after', meta]), onFailure: async (_, meta) => accounting.push(['failed', meta]) } }
  const role = options.role ?? 'result_check', runId = `revision_${role}_${randomUUID()}`
  const request = { role, runId, messages: options.messages ?? messages(), signal: new AbortController().signal }
  t.after(async () => { await backend.close(); fs.rmSync(directory, { recursive: true, force: true }) })
  return { runner, backend, directory, runId, request, accounting, run: () => directRevisionRole(runner, request) }
}
const summary = { text: 'Navigation checkpoint: inspect the original source for exact fields; no acceptance is established.' }
const isSummary = payload => typeof payload.messages.at(-1).content === 'string' && payload.messages.at(-1).content.startsWith(COMPACTION_INSTRUCTION)

test('separate historical inputs compact before assembly; nested shared facts and graph prompts stay verbatim', async t => {
  const fixed = { contexts: [{ id: 'shared', mutable: true, content: '固定共享事实😀'.repeat(1000) }],
    contextGraph: { nodes: [{ key: 'local', content: '不得缩写的图提示词' }], bindings: [{ instruction: '保持角色职责' }] } }
  const input = { task: { instruction: 'Only this leaf' }, sharedContexts: fixed.contexts,
    acceptanceContext: { startContext: { contexts: fixed.contexts } },
    blueprint: { contextGraph: fixed.contextGraph },
    execution: { localContext: { contexts: fixed.contexts }, tools: [{ callId: 'original-tail', content: text.repeat(2) }] },
    programValidation: { artifactContents: [{ text }] } }
  let normal = 0, nextRead
  const h = await fixture(t, ({ payload }) => {
    if (isSummary(payload)) return summary
    const loaded = JSON.parse(payload.messages[1].content)
    assert.deepEqual(loaded.sharedContexts, fixed.contexts)
    assert.deepEqual(loaded.acceptanceContext.startContext.contexts, fixed.contexts)
    assert.deepEqual(loaded.execution.localContext.contexts, fixed.contexts)
    assert.deepEqual(loaded.blueprint.contextGraph, fixed.contextGraph)
    assert.ok(payload.messages[0].content.startsWith('Original executor instructions remain exact.'))
    if (++normal === 1) return { tools: [{ name: EVIDENCE_SEARCH_TOOL, arguments: { query: 'TAIL_COUNTEREXAMPLE', limit: 1 } }] }
    if (normal === 2) {
      const result = JSON.parse(payload.messages.at(-1).content)
      assert.equal(result.hits.length, 1); assert.ok(result.nextCursor)
      nextRead = result.hits[0].read
      return { tools: [{ name: nextRead.tool, arguments: nextRead.arguments }] }
    }
    assert.match(JSON.parse(payload.messages.at(-1).content).text, /TAIL_COUNTEREXAMPLE/)
    return { text: '{"verdict":"RETURN"}' }
  }, { messages: [{ role: 'system', content: 'Original executor instructions remain exact.' }, { role: 'user', content: JSON.stringify(input) }] })
  assert.equal((await h.run()).verdict, 'RETURN')
  const record = readRoleRecord(h.runner, h.runId)
  assert.ok(record.context.actions.length >= 2)
  assert.ok(record.context.actions.some(row => row.rounds[0].coverage.length > 1))
  for (const source of record.context.sources) assert.ok(!/contexts|contextGraph|sharedContexts/.test(source.location))
  for (const row of h.backend.requests) assert.ok(row.windowInputTokens + row.payload.max_tokens <= 262144)
})

test('oversized protected context fails without summarizing it or sending any request', async t => {
  const h = await fixture(t, () => assert.fail('must not send'), { messages: [
    { role: 'system', content: 'Keep role exact.' }, { role: 'user', content: JSON.stringify({ nested: { contexts: [{ content: text }] } }) }] })
  await assert.rejects(h.run(), { code: 'REVISION_CONTEXT_ANCHORS_EXCEED_WINDOW' })
  assert.equal(h.backend.requests.length, 0)
  assert.equal(readRoleRecord(h.runner, h.runId).context.sources.length, 0)
})

test('capacity guard remains active with compaction disabled', async t => {
  const h = await fixture(t, () => assert.fail('must not send'))
  delete h.runner.config.direct.compaction
  h.runner.config.direct.contextWindow = 262144
  await assert.rejects(h.run(), { code: 'REVISION_CONTEXT_WINDOW_EXCEEDED_BEFORE_SEND' })
  assert.equal(h.backend.requests.length, 0)
  assert.equal(readRoleRecord(h.runner, h.runId).calls[0].phase, 'NOT_SENT')
})

test('a definite role overflow is rejected then compressed; it never becomes an unknown response', async t => {
  let normal = 0
  const h = await fixture(t, ({ payload }) => {
    if (isSummary(payload)) return summary
    if (++normal === 1) return { status: 400, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: { code: 'context_length_exceeded' } }) }
    assert.ok(manifest(payload).sources.length)
    return { text: '{"verdict":"CURRENT"}' }
  }, { messages: [{ role: 'system', content: 'Role' }, { role: 'user', content: JSON.stringify({ evidence: 'small history '.repeat(2000) }) }] })
  assert.equal((await h.run()).verdict, 'CURRENT')
  const record = readRoleRecord(h.runner, h.runId)
  assert.equal(record.calls[0].phase, 'REJECTED')
  assert.equal(record.calls.filter(row => row.purpose === 'compaction').length, 1)
  assert.equal(record.calls.some(row => row.phase === 'UNKNOWN_NO_REPLAY'), false)
  const before = h.backend.requests.length
  assert.equal((await h.run()).verdict, 'CURRENT')
  assert.equal(h.backend.requests.length, before)
})

test('manual recovery of an old full-input failure archives uncertain calls without overwriting or replaying them', async t => {
  const h = await fixture(t, ({ payload }) => isSummary(payload) ? summary : { text: '{"verdict":"CURRENT"}' })
  // Prepare a legacy pending envelope without making a model call.
  const config = h.runner.config
  const { apiParameters } = await import('../api-protocol.mjs')
  const payload = { ...config.direct.generation, ...apiParameters(config.direct), model: config.model,
    messages: h.request.messages, max_tokens: config.revision.maxOutputTokens, response_format: { type: 'json_object' },
    stream: true, stream_options: { include_usage: true } }
  const old = { sequence: 1, logicalStep: 1, purpose: 'result_check', phase: 'UNKNOWN_NO_REPLAY', payload, requestHash: digest(payload) }
  const record = { role: h.request.role, runId: h.runId, phase: 'UNKNOWN_NO_REPLAY', payload, requestHash: digest(payload), calls: [old], context: { actions: [] } }
  const directory = path.join(h.directory, 'revisions', h.runId)
  fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, 'role.json'), JSON.stringify(record))
  await assert.rejects(h.run(), { code: 'REVISION_ROLE_REQUIRES_RECONCILIATION' })
  h.runner.revisionAccounting = null
  h.runner.workflowControl = { recoverModel: true, beforeRequest() {} }
  assert.equal((await h.run()).verdict, 'CURRENT')
  const after = readRoleRecord(h.runner, h.runId)
  assert.deepEqual(after.calls[0], old)
  assert.equal(after.calls[1].purpose, 'compaction')
  assert.equal(after.calls[1].contextGeneration, 1)
  assert.equal(after.contextGenerations[0].financialStatus, 'UNCHANGED')
  assert.equal(h.backend.requests.some(row => digest(row.payload) === old.requestHash), false)
})
function manifest(payload) { return JSON.parse(payload.messages[2].content) }
function readTail(payload) {
  const source = manifest(payload).sources.find(row => row.location.endsWith('/text'))
  return { tools: [{ name: EVIDENCE_TOOL, arguments: { id: source.id, start: source.characters - 100, end: source.characters } }] }
}

for (const role of ['result_check', 'plan_check', 'result_repair', 'updater', 'reviewer']) test(`${role}: overflow is compacted, anchors stay exact, tail counterevidence remains readable`, async t => {
  let roleCalls = 0
  const h = await fixture(t, ({ payload }) => {
    if (isSummary(payload)) {
      assert.equal(payload.max_tokens, 65536)
      assert.ok(!payload.response_format); assert.deepEqual(payload.tools.map(t => t.function.name), ['read_image'])
      return summary
    }
    assert.equal(payload.max_tokens, 32768)
    const input = JSON.parse(payload.messages[1].content)
    assert.deepEqual(input.contract, { objective: 'Check the entire source' })
    assert.deepEqual(input.task, { key: 'local' })
    if (++roleCalls === 1) return readTail(payload)
    const read = JSON.parse(payload.messages.at(-1).content)
    assert.match(read.text, /TAIL_COUNTEREXAMPLE/)
    assert.equal(read.complete, true)
    return { text: '{"verdict":"RETURN","reason":"The original tail identifies a missing required field."}' }
  }, { role })
  const result = await h.run()
  assert.equal(result.verdict, 'RETURN')
  const observed = h.runner.output.read()
  assert.ok(observed.items.some(row => row.kind === 'tool' && row.title === EVIDENCE_TOOL && row.state === 'complete' && row.preview.includes('TAIL_COUNTEREXAMPLE')))
  assert.ok(observed.items.some(row => row.stage === role && row.kind === 'message'))
  const record = readRoleRecord(h.runner, h.runId)
  assert.equal(record.phase, 'COMPLETE')
  assert.deepEqual(record.payload.messages, h.request.messages)
  assert.equal(record.context.actions.length, 1)
  const originalRound = record.context.actions[0].rounds[0]
  assert.equal(originalRound.coverage[0].start, 0)
  assert.equal(originalRound.coverage.at(-1).end, text.length)
  originalRound.coverage.forEach((span, index) => {
    assert.equal(span.start, index ? originalRound.coverage[index - 1].end : 0)
    assert.equal(span.sha256, digest(text.slice(span.start, span.end)))
  })
  assert.equal(h.accounting.length, h.backend.requests.length * 2)
  for (const r of h.backend.requests) assert.ok(roleInputTokens(r.payload) + r.payload.max_tokens <= 262144)
  const before = h.backend.requests.length
  assert.deepEqual(await h.run(), result)
  assert.equal(h.backend.requests.length, before, 'completed role never sends again')
})

test('small role requests retain two messages and expose only local report declaration tools', async t => {
  const input = [{ role: 'system', content: 'Return JSON.' }, { role: 'user', content: '{"small":true}' }]
  const h = await fixture(t, ({ payload }) => {
    assert.equal(payload.messages.length, 2); assert.deepEqual(payload.messages[1], input[1]); assert.ok(payload.messages[0].content.startsWith(input[0].content)); assert.ok(payload.tools.every(tool => ['read_image', 'dynamic_context_generate_report', 'dynamic_context_read_report', 'dynamic_context_rewrite_report', 'dynamic_context_submit_report'].includes(tool.function.name)))
    return { text: '{"verdict":"CURRENT"}' }
  }, { messages: input })
  assert.equal((await h.run()).verdict, 'CURRENT')
  assert.equal(h.backend.requests.length, 1)
})

test('unknown summary transport is durable and cannot replay on a second invocation', async t => {
  const h = await fixture(t, () => ({ disconnect: true }))
  await assert.rejects(h.run())
  const record = readRoleRecord(h.runner, h.runId)
  assert.equal(record.phase, 'UNKNOWN_NO_REPLAY')
  assert.equal(record.calls[0].purpose, 'compaction')
  assert.equal(revisionRecoveryState(h.runner).length, 1)
  await assert.rejects(h.run(), { code: 'REVISION_ROLE_REQUIRES_RECONCILIATION' })
  assert.equal(h.backend.requests.length, 1)
})

test('summary engines return forbidden work calls without executing them or approving work', async t => {
  const h = await fixture(t, ({ payload }) => {
    if (isSummary(payload)) return { tools: [{ name: 'write', arguments: { file_path: 'forbidden', content: 'x' } }] }
    if (payload.messages.at(-1).role === 'tool') { assert.match(payload.messages.at(-1).content, /COMPACTION_TOOL_FORBIDDEN/); return summary }
    return { text: '{"verdict":"RETURN"}' }
  })
  assert.equal((await h.run()).verdict, 'RETURN')
  assert.equal(readRoleRecord(h.runner, h.runId).phase, 'COMPLETE')
  assert.ok(!fs.existsSync(path.join(h.directory, 'forbidden')))
})

test('read scope rejects paths, extra parameters and out-of-range offsets, then permits local repair', async t => {
  let calls = 0
  const h = await fixture(t, ({ payload }) => {
    if (isSummary(payload)) return summary
    if (++calls === 1) return { tools: [{ name: EVIDENCE_TOOL, arguments: { id: '/etc/passwd', start: 0, end: 40 } },
      { name: EVIDENCE_TOOL, arguments: { id: manifest(payload).sources[0].id, start: -1, end: 10, path: '/tmp' } }] }
    assert.equal(payload.messages.slice(-2).every(row => JSON.parse(row.content).error === 'EVIDENCE_READ_INVALID_RANGE_OR_SOURCE'), true)
    return { text: '{"verdict":"RETURN","reason":"Need valid source ranges."}' }
  })
  assert.equal((await h.run()).verdict, 'RETURN')
})

test('oversized read is paginated and a growing inspection history is compacted without splitting tool pairs', async t => {
  let roleCalls = 0
  const h = await fixture(t, ({ payload }) => {
    if (isSummary(payload)) return summary
    roleCalls++
    if (roleCalls <= 6) {
      const source = manifest(payload).sources[0]
      return { tools: [{ name: EVIDENCE_TOOL, arguments: { id: source.id, start: 0, end: source.characters } }] }
    }
    const page = JSON.parse(payload.messages.at(-1).content)
    assert.equal(page.complete, false); assert.ok(page.next > 0)
    assert.equal(page.text, text.slice(0, page.end))
    return { text: '{"verdict":"RETURN","reason":"Partial reads do not prove full coverage."}' }
  })
  await h.run()
  const record = readRoleRecord(h.runner, h.runId)
  assert.ok(record.context.actions.some(action => action.location.startsWith('/role-history/')))
  for (const call of record.calls.filter(call => call.purpose !== 'compaction')) {
    const messages = call.payload.messages
    for (let i = 0; i < messages.length; i++) if (messages[i].role === 'tool') {
      assert.ok(messages.slice(0, i).some(message => message.tool_calls?.some(tool => tool.id === messages[i].tool_call_id)))
    }
  }
})

test('tampering an archived source prevents approval', async t => {
  let h
  h = await fixture(t, ({ payload }) => {
    if (isSummary(payload)) return summary
    const file = path.join(h.directory, 'revisions', h.runId, 'context-sources', 'source-000001.json')
    const value = JSON.parse(fs.readFileSync(file)); value.text += 'changed'; fs.writeFileSync(file, JSON.stringify(value))
    return readTail(payload)
  })
  await assert.rejects(h.run(), { code: 'REVISION_CONTEXT_ARCHIVE_CHANGED' })
  assert.notEqual(readRoleRecord(h.runner, h.runId).phase, 'COMPLETE')
})

test('an exact registered measurement can veto underestimated requests before transmission', async t => {
  const h = await fixture(t, () => { throw Error('MUST_NOT_SEND') }, { messages: [{ role: 'system', content: 'JSON' }, { role: 'user', content: '{}' }] })
  h.runner.inputMeter = { version: 'fixture', measure: async () => ({ method: 'exact', tokens: 262144 }) }
  await assert.rejects(h.run(), { code: 'REVISION_CONTEXT_ANCHORS_EXCEED_WINDOW' })
  assert.equal(h.backend.requests.length, 0)
  assert.equal(readRoleRecord(h.runner, h.runId).phase, 'NOT_SENT')
})

test('provider context rejections retain status and message instead of becoming quota errors', async t => {
  const message = "This model's maximum context length is 1048576 tokens. However, you requested 1145650 tokens."
  const h = await fixture(t, () => ({ status: 400, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: { code: null, type: 'invalid_request_error', message } }) }),
    { messages: [{ role: 'system', content: 'JSON' }, { role: 'user', content: '{}' }] })
  await assert.rejects(h.run(), error => error.code === 'DIRECT_CONTEXT_LENGTH_EXCEEDED' && error.providerError.httpStatus === 400 && error.providerError.message === message)
  assert.equal(readRoleRecord(h.runner, h.runId).providerError.httpStatus, 400)
  assert.equal(h.backend.requests.length, 1)
})

test('pause during role compression preserves completed summaries and resumes without paying for them again', async t => {
  let paused = false
  const h = await fixture(t, ({ payload }) => {
    if (isSummary(payload)) { paused = true; return summary }
    return { text: '{"verdict":"CURRENT"}' }
  })
  h.runner.workflowControl = { beforeRequest: () => { if (paused) throw Object.assign(new Error('WORKFLOW_PAUSE_REQUESTED'), { code: 'WORKFLOW_PAUSE_REQUESTED' }) } }
  await assert.rejects(h.run(), { code: 'WORKFLOW_PAUSE_REQUESTED' })
  const completed = h.backend.requests.length
  assert.equal(readRoleRecord(h.runner, h.runId).phase, 'PAUSED')
  paused = false
  // All previously completed compression replies are replayed locally. Only
  // genuinely new chunks may ask to pause again.
  h.runner.workflowControl.beforeRequest = () => {}
  assert.equal((await h.run()).verdict, 'CURRENT')
  const bodies = h.backend.requests.map(row => JSON.stringify(row.payload))
  assert.equal(new Set(bodies).size, bodies.length)
  assert.ok(completed >= 1)
})

test('explicit interrupted role recovery retries the lost model reply and keeps the unknown billing receipt', async t => {
  const h = await fixture(t, ({ index, payload }) => index === 1 ? { disconnect: true }
    : isSummary(payload) ? summary : { text: '{"verdict":"CURRENT"}' })
  h.runner.revisionAccounting = null
  await assert.rejects(h.run())
  h.runner.workflowControl = { recoverModel: true, beforeRequest() {} }
  assert.equal((await h.run()).verdict, 'CURRENT')
  assert.deepEqual(h.backend.requests[0].payload, h.backend.requests[1].payload)
  const record = readRoleRecord(h.runner, h.runId)
  assert.equal(record.calls[0].phase, 'UNKNOWN_NO_REPLAY')
  assert.equal(record.calls[1].resumedFrom, 1)
  assert.equal(record.calls[1].financialStatus, 'UNCHANGED')
})

test('pause after accounting admission releases a definitely unsent role request and can resume', async t => {
  const h = await fixture(t, () => ({ text: '{"verdict":"CURRENT"}' }),
    { messages: [{ role: 'system', content: 'JSON' }, { role: 'user', content: '{}' }] })
  let paused = false, receipt
  h.runner.revisionAccounting.beforeRequest = async () => { paused = true }
  h.runner.revisionAccounting.onFailure = async error => { receipt = error.directReceipt }
  h.runner.workflowControl = { beforeRequest: () => { if (paused) throw Object.assign(new Error('WORKFLOW_PAUSE_REQUESTED'), { code: 'WORKFLOW_PAUSE_REQUESTED' }) } }
  await assert.rejects(h.run(), { code: 'WORKFLOW_PAUSE_REQUESTED' })
  assert.equal(h.backend.requests.length, 0)
  assert.equal(readRoleRecord(h.runner, h.runId).calls[0].phase, 'NOT_SENT')
  assert.equal(receipt.notSent, true)
  paused = false; h.runner.revisionAccounting.beforeRequest = async () => {}
  assert.equal((await h.run()).verdict, 'CURRENT')
  assert.equal(h.backend.requests.length, 1)
})

test('receipt selector survives native compression and a pause with exact immutable source ranges', async t => {
  let pause = false, selected = false, summaries = 0
  const source = 'context text '.repeat(60000) + '\nDECISIVE_OUTPUT'
  const input = { verificationPlan: { version: 1 }, execution: { trace: { sha256: 'a'.repeat(64) }, tools: [
    { callId: 'receipt-call', name: 'bash', outcome: 'RETURNED', content: source } ] },
    previousSubmission: '{"outcome":"COMPLETE","summary":"Existing report"}', feedback: 'Fix a citation only' }
  const h = await fixture(t, ({ payload }) => {
    if (isSummary(payload)) { summaries++; return summary }
    if (!selected) { selected = true; pause = true; return { tools: [{ name: 'dynamic_context_select_receipt', arguments: { query: 'DECISIVE_OUTPUT' } }] } }
    const row = JSON.parse(payload.messages.at(-1).content).receipts[0]
    assert.equal(row.characters, source.length); assert.equal(row.sourceSha256, digest(source))
    assert.equal(row.matchStart, source.indexOf('DECISIVE_OUTPUT'))
    return { text: '{"outcome":"COMPLETE","summary":"Original evidence remains selectable"}' }
  }, { role: 'result_repair', messages: [{ role: 'system', content: 'Repair only the report with supplied evidence.' }, { role: 'user', content: JSON.stringify(input) }] })
  h.runner.workflowControl = { beforeRequest() { if (pause) throw Object.assign(new Error('WORKFLOW_PAUSE_REQUESTED'), { code: 'WORKFLOW_PAUSE_REQUESTED' }) } }
  await assert.rejects(h.run(), { code: 'WORKFLOW_PAUSE_REQUESTED' })
  const before = summaries; pause = false
  assert.equal((await h.run()).outcome, 'COMPLETE'); assert.ok(before > 0); assert.equal(summaries, before)
  assert.equal(readRoleRecord(h.runner, h.runId).context.reportDraft.revision, 0)
})
