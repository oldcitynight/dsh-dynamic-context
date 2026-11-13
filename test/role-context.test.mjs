import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { directRevisionRole, readRoleRecord, revisionRecoveryState } from '../revision-runtime.mjs'
import { roleInputTokens, EVIDENCE_TOOL } from '../role-context.mjs'
import { COMPACTION_INSTRUCTION, nativeCompactSpec } from '../dsh-compaction-policy.mjs'
import { startFakeLlama } from '../testing/fake-llama.mjs'
import { validateConfig } from '../index.mjs'
import { digest } from 'dsh-bettertaskgraphs/core'

const text = 'ordinary evidence 0123456789, '.repeat(24000) + '\nTAIL_COUNTEREXAMPLE: required_field is missing.\n'
const messages = () => [{ role: 'system', content: 'Independently check this evidence. Return a JSON verdict.' },
  { role: 'user', content: JSON.stringify({ contract: { objective: 'Check the entire source' }, task: { key: 'local' },
    programValidation: { artifactContents: [{ source: { ref: 'evidence.txt', sha256: digest(text) }, text }] } }) }]
async function fixture(t, respond, options = {}) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'role-context-')))
  const backend = await startFakeLlama({ respond, maxRequestBytes: 16 * 1024 * 1024,
    contextWindow: 262144, countInputTokens: roleInputTokens })
  const accounting = [], runner = { ctx: { get: name => name === 'credentials' ? { resolve: async () => ({ value: 'fake-only' }) } : undefined },
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
const isSummary = payload => payload.messages.at(-1).content === COMPACTION_INSTRUCTION
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
      assert.ok(!payload.response_format && !payload.tools)
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

test('small role requests retain their original two messages and no read tool', async t => {
  const input = [{ role: 'system', content: 'Return JSON.' }, { role: 'user', content: '{"small":true}' }]
  const h = await fixture(t, ({ payload }) => {
    assert.deepEqual(payload.messages, input); assert.ok(!payload.tools)
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

test('summary engines cannot execute tools or produce an approval receipt', async t => {
  const h = await fixture(t, () => ({ tools: [{ name: 'write', arguments: { file_path: 'forbidden', content: 'x' } }] }))
  await assert.rejects(h.run(), { code: 'REVISION_CONTEXT_SUMMARY_INVALID' })
  assert.equal(readRoleRecord(h.runner, h.runId).phase, 'INVALID_RESPONSE')
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
