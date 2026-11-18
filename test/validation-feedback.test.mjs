// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { diagnostic } from 'dsh-better-task-grapth/validation'
import { inspectExecutionReport, parseExecutionDisposition } from '../report-evidence.mjs'
import { validateReview } from '../review-feedback.mjs'
import { directRevisionRole, readRoleRecord } from '../revision-runtime.mjs'
import { startFakeLlama } from '../testing/fake-llama.mjs'
import { validateConfig } from '../index.mjs'
import { createReportDraft, REPORT_EDIT, REPORT_READ } from '../report-draft.mjs'
import { checkDirectHistory, VALIDATION_FEEDBACK_PROTOCOL } from '../checkpoints.mjs'

const hash = text => createHash('sha256').update(text).digest('hex')
const signal = () => new AbortController().signal

test('nested manifest rejection identifies missing descendants; reusing existing child declarations passes', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'directory-feedback-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'delivery/child'), { recursive: true })
  fs.writeFileSync(path.join(root, 'delivery/top.txt'), 'top')
  fs.writeFileSync(path.join(root, 'delivery/child/result.txt'), 'result')
  const files = [{ path: 'delivery/top.txt', sha256: hash('top') }, { path: 'delivery/child/result.txt', sha256: hash('result') }]
  const result = { outcome: 'COMPLETE', summary: 'Delivered', artifacts: [], executionReport: { workHistory: ['Produced files'],
    results: [{ criterion: 'Deliver files', result: 'Both files exist', artifactRefs: ['delivery'], testIds: [] }],
    directories: [{ path: 'delivery', subdirectories: ['delivery/child'], files: files.slice(0, 1) }, { path: 'delivery/child', files: files.slice(1) }], tests: [], limitations: [] } }
  const runner = { config: { projectRoot: root, directory: path.join(root, '.state'), direct: {} } }
  assert.throws(() => inspectExecutionReport(runner, result, { tools: [] }, signal()), error => {
    const issue = diagnostic(error).issues[0]
    assert.equal(error.code, 'SUPERVISION_DIRECTORY_MANIFEST_MISMATCH')
    assert.equal(issue.path, '/executionReport/directories/0')
    assert.deepEqual(issue.missingFiles, ['delivery/child/result.txt'])
    assert.deepEqual(issue.extraFiles, [])
    assert.match(issue.reason, /full recursive/)
    return true
  })
  result.executionReport.directories[0].files = files
  assert.equal(inspectExecutionReport(runner, result, { tools: [] }, signal()).programValidation.verifiedArtifacts.length, 2)
  fs.writeFileSync(path.join(root, 'delivery/child/result.txt'), 'changed')
  assert.throws(() => inspectExecutionReport(runner, result, { tools: [] }, signal()), error => {
    const issue = diagnostic(error).issues[0]
    assert.equal(issue.item, path.join(root, 'delivery/child/result.txt'))
    assert.equal(issue.expected, hash('result'))
    assert.equal(issue.observed, hash('changed'))
    return true
  })
})

test('report parser accepts uniquely repairable syntax and retains original offsets and evidence', () => {
  const raw = '```json\n{"outcome":"BLOCKED","summary":"one\ntwo", "artifacts":[],}\n```'
  const { value, envelope } = parseExecutionDisposition(raw)
  assert.equal(value.summary, 'one\ntwo')
  assert.equal(envelope.originalPresentation, raw)
  assert.ok(envelope.repairs.some(row => row.kind === 'literal_control_character'))
  assert.ok(envelope.repairs.some(row => row.kind === 'trailing_comma'))
})

test('ambiguous local report edits retain the draft and locate the exact edit and matching spans', () => {
  const original = '{"summary":"repeat repeat"}'
  const draft = createReportDraft(original)
  const refused = draft.execute(REPORT_EDIT, JSON.stringify({ expectedRevision: 0, edits: [{ op: 'replace_text', oldText: 'repeat', newText: 'once' }] }))
  assert.equal(refused.error, 'REPORT_TEXT_AMBIGUOUS')
  assert.equal(refused.diagnostic.issues[0].path, '/edits/0/oldText')
  assert.deepEqual(refused.diagnostic.issues[0].offsets, [12, 19])
  assert.equal(refused.revision, 0)
  assert.equal(draft.execute(REPORT_READ, JSON.stringify({ start: 0, end: original.length })).text, original)
})

test('audit feedback must identify a real input item; absent reasons or invented pointers are refused', () => {
  const input = { proposal: { reason: 'Change future work' }, contract: {} }
  assert.throws(() => validateReview('reviewer', { verdict: 'REJECT', reason: 'No', violations: [] }, input), /specific items/)
  assert.throws(() => validateReview('reviewer', { verdict: 'REJECT', reason: 'No', issues: [{ path: '/proposal/missing', item: 'future work', reason: 'Missing criterion' }] }, input), error => {
    assert.equal(diagnostic(error).issues[0].path, '/issues/0/path')
    assert.equal(diagnostic(error).issues[0].rejectedPath, '/proposal/missing')
    return true
  })
  const valid = validateReview('reviewer', { verdict: 'REJECT', reason: 'Need evidence', violations: [], issues: [{ path: '/proposal/reason', item: 'future work', reason: 'No source supports this change' }] }, input)
  assert.equal(valid.issues[0].item, 'future work')
})

test('reviewer repairs its own missing feedback items before forwarding a located rejection, retaining full input', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'review-feedback-'))
  const input = { contract: { objective: 'Preserve scope' }, proposal: { reason: 'No evidence' } }
  const backend = await startFakeLlama({ respond: ({ payload, index }) => {
    assert.deepEqual(JSON.parse(payload.messages[1].content), input)
    if (index === 1) return { text: '{"verdict":"REJECT","reason":"Need evidence","violations":[]}' }
    assert.match(payload.messages.at(-1).content, index === 2 ? /issues/ : /REVIEW_ISSUE_PATH_MISSING/)
    return { text: JSON.stringify({ verdict: 'REJECT', reason: 'Need evidence', violations: [], issues: [
      { path: index === 2 ? '/proposal/nonexistent' : '/proposal/reason', item: 'future work', reason: 'No source supports this change' },
    ] }) }
  } })
  t.after(async () => { await backend.close(); fs.rmSync(directory, { recursive: true, force: true }) })
  const runner = { ctx: { get: () => ({ resolve: async () => ({ value: 'fake-only' }) }) },
    config: validateConfig({ projectRoot: directory, directory, provider: 'fake', model: 'fake-llama', transport: 'direct', systemPrompt: 'Fixture',
      revision: { policy: { objective: 'Preserve', requirements: [{ id: 'p', text: 'Preserve' }] }, maxOutputTokens: 2048 },
      direct: { endpoint: backend.origin + '/v1/chat/completions', apiKeyEnv: 'FAKE_VALIDATION', durable: true } }) }
  const request = { runId: 'revision_reviewer_' + randomUUID(), role: 'reviewer', validateOutput: true, signal: signal(),
    messages: [{ role: 'system', content: 'Review the supplied proposal. Return located issues.' }, { role: 'user', content: JSON.stringify(input) }] }
  const result = await directRevisionRole(runner, request)
  assert.equal(result.issues[0].path, '/proposal/reason')
  assert.equal(backend.requests.length, 3)
  assert.deepEqual(await directRevisionRole(runner, request), result)
  assert.equal(backend.requests.length, 3)
  const record = readRoleRecord(runner, request.runId)
  assert.equal(record.phase, 'COMPLETE')
  assert.deepEqual(record.payload.messages, request.messages)
})

test('host feedback cannot enter a direct history unless its exact bytes were approved', () => {
  const feedback = { role: 'user', content: JSON.stringify({ protocol: VALIDATION_FEEDBACK_PROTOCOL }) }
  const history = [{ role: 'system', content: 'Pinned' }, { role: 'user', content: 'Task' }, { role: 'assistant', content: 'Prior' }, feedback]
  assert.throws(() => checkDirectHistory(history), { code: 'DIRECT_UNAPPROVED_CHECKPOINT' })
  assert.doesNotThrow(() => checkDirectHistory(history, [feedback]))
  assert.throws(() => checkDirectHistory([...history.slice(0, -1), { ...feedback, content: feedback.content + ' ' }], [feedback]), { code: 'DIRECT_UNAPPROVED_CHECKPOINT' })
})
