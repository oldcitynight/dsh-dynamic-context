import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createReportDraft, REPORT_READ, REPORT_EDIT, REPORT_SUBMIT } from '../report-draft.mjs'
import { executionReportDraft } from '../execution-report-tools.mjs'
import { directRevisionRole, readRoleRecord } from '../revision-runtime.mjs'
import { validateConfig } from '../index.mjs'
import { startFakeLlama } from '../testing/fake-llama.mjs'
const original = { outcome: 'COMPLETE', summary: 'Preserve this summary', artifacts: [], executionReport: {
  workHistory: ['Preserve full work history'], results: [{ criterion: 'c', result: 'observed', artifactRefs: [], testIds: ['test'] }],
  directories: [], tests: [{ id: 'test', criterion: 'c', status: 'PASS', expected: 'ok', observed: 'ok', callId: 'wrong', quote: 'ok' }], limitations: [] } }
const invoke = (draft, name, args) => draft.execute(name, JSON.stringify(args))
test('selected edits preserve unrelated declarations; stale and ambiguous batches are atomic', () => {
  const draft = createReportDraft(JSON.stringify(original))
  assert.equal(invoke(draft, REPORT_EDIT, { expectedRevision: 1, edits: [{ op: 'set', path: '/summary', value: 'bad' }] }).error, 'REPORT_STALE_REVISION')
  const error = invoke(draft, REPORT_EDIT, { expectedRevision: 0, edits: [{ op: 'set', path: '/summary', value: 'bad' },
    { op: 'replace_text', oldText: 'ok', newText: 'ambiguous' }] })
  assert.equal(error.error, 'REPORT_TEXT_AMBIGUOUS'); assert.equal(error.editIndex, 1)
  assert.deepEqual(invoke(draft, REPORT_READ, { path: '' }).value, original)
  const missingValue = invoke(draft, REPORT_EDIT, { expectedRevision: 0, edits: [{ op: 'set', path: '/summary' }] })
  assert.equal(missingValue.error, 'REPORT_TOOL_INVALID_ARGUMENTS')
  assert.deepEqual(missingValue.fields[0].path, ['edits', 0, 'value'])
  assert.equal(invoke(draft, REPORT_EDIT, { expectedRevision: 0, edits: [{ op: 'set', path: '/__proto__/polluted', value: true }] }).error, 'REPORT_POINTER_INVALID')
  const edited = invoke(draft, REPORT_EDIT, { expectedRevision: 0, edits: [{ op: 'set', path: '/executionReport/tests/0/callId', value: 'actual' }] })
  assert.equal(edited.revision, 1)
  assert.equal(invoke(draft, REPORT_SUBMIT, { expectedRevision: 1 }).acceptance, 'PENDING_ORIGINAL_CHECKS')
  const expected = structuredClone(original); expected.executionReport.tests[0].callId = 'actual'
  assert.deepEqual(draft.result(), expected)
})
test('malformed JSON can be repaired by an exact span and schema errors remain field-addressed', () => {
  const text = JSON.stringify(original).replace('"outcome":"COMPLETE"', '"outcome":COMPLETE')
  const draft = createReportDraft(text)
  assert.equal(invoke(draft, REPORT_READ, { path: '/outcome' }).error, 'REPORT_JSON_INVALID')
  assert.equal(invoke(draft, REPORT_EDIT, { expectedRevision: 0, edits: [{ op: 'replace_text', oldText: ':COMPLETE,', newText: ':"COMPLETE",' }] }).revision, 1)
  invoke(draft, REPORT_EDIT, { expectedRevision: 1, edits: [{ op: 'remove', path: '/executionReport/tests/0/id' }] })
  const rejected = invoke(draft, REPORT_SUBMIT, { expectedRevision: 2 })
  assert.ok(rejected.fields.some(field => field.path.join('.') === 'executionReport.tests.0.id'))
  assert.equal(draft.result(), undefined)
})
test('fake repair edits and submits without full regeneration; full input survives pause and replay', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'report-draft-'))
  let paused = false, sent = 0
  const input = { contract: { objective: 'Check evidence' }, previousSubmission: JSON.stringify(original),
    execution: { localContext: 'UNCHANGED_FULL_CONTEXT'.repeat(400), tools: [{ callId: 'actual', content: 'ok' }] }, feedback: 'Fix callId only.' }
  const backend = await startFakeLlama({ respond: ({ payload }) => {
    assert.deepEqual(JSON.parse(payload.messages[1].content), input)
    assert.ok(payload.tools.some(tool => tool.function.name === REPORT_EDIT))
    if (++sent === 1) {
      paused = true
      return { tools: [{ name: REPORT_EDIT, arguments: { expectedRevision: 0, edits: [{ op: 'set', path: '/executionReport/tests/0/callId', value: 'actual' }] } }] }
    }
    assert.equal(JSON.parse(payload.messages.at(-1).content).revision, 1)
    return { tools: [{ name: REPORT_SUBMIT, arguments: { expectedRevision: 1 } }] }
  } })
  t.after(async () => { await backend.close(); fs.rmSync(directory, { recursive: true, force: true }) })
  const runner = { ctx: { get: name => name === 'credentials' ? { resolve: async () => ({ value: 'fake-only' }) } : undefined },
    config: validateConfig({ projectRoot: directory, directory, provider: 'fake', model: 'fake-llama', transport: 'direct', systemPrompt: 'Fixture',
      revision: { policy: { objective: 'Check', requirements: [{ id: 'c', text: 'Check' }] }, maxOutputTokens: 2048 },
      direct: { endpoint: backend.origin + '/v1/chat/completions', apiKeyEnv: 'FAKE_DRAFT', durable: true } }),
    workflowControl: { beforeRequest() { if (paused) throw Object.assign(Error('pause'), { code: 'WORKFLOW_PAUSE_REQUESTED' }) } } }
  const request = { role: 'result_repair', runId: 'revision_result_repair_' + randomUUID(), signal: new AbortController().signal,
    messages: [{ role: 'system', content: 'Repair declaration against the full evidence. Return JSON.' }, { role: 'user', content: JSON.stringify(input) }] }
  await assert.rejects(directRevisionRole(runner, request), { code: 'WORKFLOW_PAUSE_REQUESTED' })
  paused = false
  const result = await directRevisionRole(runner, request)
  const expected = structuredClone(original); expected.executionReport.tests[0].callId = 'actual'
  assert.deepEqual(result, expected)
  assert.deepEqual(await directRevisionRole(runner, request), expected)
  assert.equal(sent, 2, 'no model call to replay patches or regenerate the full result')
  const record = readRoleRecord(runner, request.runId)
  assert.equal(record.context.reportDraft.revision, 1)
  assert.deepEqual(record.payload.messages, request.messages)
  const file = path.join(directory, 'revisions', request.runId, 'role.json')
  record.submittedReport.summary = 'tampered'; fs.writeFileSync(file, JSON.stringify(record))
  await assert.rejects(directRevisionRole(runner, request), { code: 'REVISION_ROLE_RECEIPT_INVALID' })
})

test('generic generation retains rejected content and replays exact validation receipts without rechecking historical files', () => {
  let checks = 0
  const validateResult = value => { checks++; if (!value.reason) throw Object.assign(new Error('reason is required'), { code: 'MISSING_REASON' }); return value }
  const draft = createReportDraft('{}', { generate: true, validateResult })
  const first = invoke(draft, 'dynamic_context_generate_report', { report: { verdict: 'APPROVE', keep: 'unchanged' } })
  assert.equal(first.error, 'MISSING_REASON'); assert.equal(first.revision, 1); assert.equal(first.draftRetained, true)
  invoke(draft, REPORT_EDIT, { expectedRevision: 1, edits: [{ op: 'set', path: '/reason', value: 'The evidence is sufficient.' }] })
  assert.equal(invoke(draft, REPORT_SUBMIT, { expectedRevision: 2 }).submitted, true); assert.equal(checks, 2)
  const snapshot = draft.snapshot(), restored = createReportDraft('{}', { generate: true, replayReceipts: snapshot.receipts, validateResult: () => { throw Error('Historical receipt must not rerun filesystem-dependent validation') } })
  for (const receipt of snapshot.receipts) assert.deepEqual(restored.execute(receipt.name, receipt.rawArguments), receipt.result)
  assert.deepEqual(restored.snapshot(), snapshot); assert.equal(restored.result().keep, 'unchanged')
  const changed = createReportDraft('{}', { generate: true, replayReceipts: snapshot.receipts, validateResult })
  assert.throws(() => invoke(changed, 'dynamic_context_generate_report', { report: { verdict: 'REJECT' } }), /REPORT_RECEIPT_CHANGED/)
})

test('execution declaration reopening survives restart before and after local revision with original receipts intact', () => {
  const trace = { assembly: {}, events: [] }, saved = []
  const restore = () => executionReportDraft({}, trace, new AbortController().signal, () => saved.push(structuredClone(trace)))
  const execute = (draft, name, args) => draft.definitions.find(row => row.name === name).execute(args)
  const draft = restore()
  assert.equal(execute(draft, 'dynamic_context_generate_report', { report: { outcome: 'COMPLETE', summary: 'Original summary' } }).submitted, true)
  const originalReceipt = structuredClone(trace.reportDraft.receipts[0])
  assert.equal(draft.reopenForGuidance([{ id: 'human-guidance', text: 'Revise the summary only' }]).revision, 1)
  const reopened = restore(); assert.equal(reopened.result(), undefined)
  assert.equal(execute(reopened, REPORT_EDIT, { expectedRevision: 1, edits: [{ op: 'set', path: '/summary', value: 'Revised summary' }] }).revision, 2)
  const revised = restore(); assert.equal(revised.result(), undefined)
  assert.equal(execute(revised, REPORT_SUBMIT, { expectedRevision: 2 }).submitted, true)
  assert.equal(restore().result().summary, 'Revised summary')
  assert.deepEqual(trace.reportDraft.receipts[0], originalReceipt)
  assert.equal(saved.length, 4, 'only original submit, reopen, edit and new submit mutate the trace')
  trace.reportDraftReopens[0].snapshotHash = '0'.repeat(64)
  assert.throws(restore, { code: 'DIRECT_REPORT_DRAFT_CHANGED' })
})
