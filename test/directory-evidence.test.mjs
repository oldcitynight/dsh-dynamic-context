// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { diagnostic } from 'dsh-better-task-grapth/validation'
import { DIRECTORY_HASH_SCHEME, DIRECTORY_SNAPSHOT_TOOL, snapshotDirectory, issueDirectorySnapshot } from '../directory-evidence.mjs'
import { directoryReportSchema, dispositionSchema } from '../supervision-state.mjs'
import { inspectExecutionReport } from '../report-evidence.mjs'
import { dispositionExamples, scopedRevisionReviewExamples, legacyResultReviewExamples } from '../format-examples.mjs'
import { validateReview } from '../review-feedback.mjs'
import { createRoleContext } from '../role-context.mjs'
import { REPORT_EDIT, REPORT_SUBMIT } from '../report-draft.mjs'
import { directRevisionRole, readRoleRecord } from '../revision-runtime.mjs'
import { validateConfig } from '../index.mjs'
import { createRuntimeHarness, runtimeProposal } from '../testing/runtime-harness.mjs'
import { startFakeLlama } from '../testing/fake-llama.mjs'

const signal = () => new AbortController().signal
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'directory-identity-')))
  const projectRoot = path.join(root, 'workspace'), directory = path.join(root, 'state'), folder = path.join(projectRoot, 'deliverable')
  fs.mkdirSync(path.join(folder, 'empty'), { recursive: true }); fs.mkdirSync(directory)
  fs.writeFileSync(path.join(folder, 'result.txt'), 'verified bytes')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return { root, folder, config: { projectRoot, directory, direct: {} } }
}
const report = row => ({ outcome: 'COMPLETE', summary: 'Delivered the requested result', artifacts: [], executionReport: {
  workHistory: ['Prepared the delivered file'], results: [{ criterion: 'Deliver the result', result: 'The result is ready', artifactRefs: ['deliverable'], testIds: [] }],
  directories: [row], tests: [], limitations: [],
} })
const tools = (name, args, id = 'call_1') => ({ finish: 'tool_calls', message: { role: 'assistant', content: null,
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } })
const examples = text => [...text.matchAll(/```json\n([^\n]+)\n```/g)].map(match => JSON.parse(match[1]))

test('directory identity covers contents, names, empty directories and permissions, but ignores timestamps and enumeration order', t => {
  const { config, folder } = fixture(t), file = path.join(folder, 'result.txt')
  const read = () => snapshotDirectory(config, 'deliverable', signal()).sha256, baseline = read()
  fs.utimesSync(file, 1, 1); fs.utimesSync(folder, 1, 1); assert.equal(read(), baseline)
  const changes = [
    [() => fs.writeFileSync(file, 'new bytes'), () => fs.writeFileSync(file, 'verified bytes')],
    [() => fs.renameSync(file, file + '.renamed'), () => fs.renameSync(file + '.renamed', file)],
    [() => fs.writeFileSync(path.join(folder, 'added'), 'new'), () => fs.unlinkSync(path.join(folder, 'added'))],
    [() => fs.rmdirSync(path.join(folder, 'empty')), () => fs.mkdirSync(path.join(folder, 'empty'))],
  ]
  for (const [mutate, restore] of changes) { mutate(); assert.notEqual(read(), baseline); restore(); assert.equal(read(), baseline) }
  const mode = fs.statSync(file).mode & 0o777
  fs.chmodSync(file, mode ^ 0o100); assert.notEqual(read(), baseline); fs.chmodSync(file, mode); assert.equal(read(), baseline)
  const receipt = issueDirectorySnapshot(config, 'deliverable', signal())
  assert.equal(receipt.directory.sha256, baseline); assert.deepEqual(receipt.counts, { files: 1, directories: 1 })
  assert.deepEqual(issueDirectorySnapshot(config, './deliverable', signal()), receipt)
  assert.equal(Object.hasOwn(receipt, 'entries'), false)
})

test('snapshot rejects protected entries, links, out-of-workspace paths and guard-denied descendants rather than skipping them', t => {
  const { config, folder, root } = fixture(t), file = path.join(folder, 'result.txt')
  for (const entry of ['.env', 'private.key', 'credentials']) {
    const p = path.join(folder, entry); fs.writeFileSync(p, 'private')
    assert.throws(() => snapshotDirectory(config, 'deliverable', signal()), /DIRECTORY_PRIVATE_ENTRY_DENIED/); fs.unlinkSync(p)
  }
  const link = path.join(folder, 'link')
  fs.symlinkSync(file, link); assert.throws(() => snapshotDirectory(config, 'deliverable', signal()), /DIRECTORY_NONREGULAR_ENTRY/); fs.unlinkSync(link)
  fs.linkSync(file, link); assert.throws(() => snapshotDirectory(config, 'deliverable', signal()), /DIRECTORY_HARDLINK_DENIED/); fs.unlinkSync(link)
  assert.throws(() => snapshotDirectory(config, root, signal()))
  assert.throws(() => snapshotDirectory({ ...config, direct: { runtime: { cwd: 'deliverable/empty' } } }, 'deliverable', signal()), /DIRECTORY_OUTSIDE_WORKSPACE/)
  assert.throws(() => snapshotDirectory(config, 'deliverable', signal(), p => { if (p === file) throw new Error('CREDENTIAL_GUARD_DENIED') }), /CREDENTIAL_GUARD_DENIED/)
})

test('compact directory report is verified by host and changed membership returns exact differences', t => {
  const { config, folder } = fixture(t), receipt = issueDirectorySnapshot(config, 'deliverable', signal())
  const result = report(receipt.directory), runner = { config }, facts = { tools: [] }
  assert.equal(inspectExecutionReport(runner, result, facts, signal()).programValidation.verifiedArtifacts.length, 1)
  fs.writeFileSync(path.join(folder, 'result.txt'), 'changed'); fs.writeFileSync(path.join(folder, 'added.txt'), 'added'); fs.rmdirSync(path.join(folder, 'empty'))
  assert.throws(() => inspectExecutionReport(runner, result, facts, signal()), error => {
    const issue = diagnostic(error).issues[0]
    assert.equal(issue.path, '/executionReport/directories/0/sha256'); assert.equal(issue.baselineAvailable, true)
    assert.deepEqual(issue.added, ['added.txt']); assert.deepEqual(issue.removed, ['empty'])
    assert.deepEqual(issue.changed, [{ path: 'result.txt', fields: ['sha256'] }]); return true
  })
})

test('hash and recursive manifest schemas stay compatible while mixed formats locate the offending field', t => {
  const { config } = fixture(t), snapshot = snapshotDirectory(config, 'deliverable', signal())
  const hashed = { path: snapshot.path, hashScheme: snapshot.hashScheme, sha256: snapshot.sha256 }
  const legacy = { path: snapshot.path, files: snapshot.files, subdirectories: snapshot.subdirectories }
  for (const row of [hashed, legacy]) {
    assert.ok(directoryReportSchema.safeParse(row).success)
    assert.equal(inspectExecutionReport({ config }, report(row), { tools: [] }, signal()).programValidation.directories[0].completeMembershipVerified, true)
  }
  for (const [field, value] of [['files', []], ['subdirectories', ['deliverable/empty']]]) {
    const check = directoryReportSchema.safeParse({ ...hashed, [field]: value }); assert.equal(check.success, false)
    assert.deepEqual(check.error.issues[0].path, [field])
  }
  for (const sample of examples(dispositionExamples(true))) assert.ok(dispositionSchema.safeParse(sample).success)
  for (const sample of examples(scopedRevisionReviewExamples)) assert.doesNotThrow(() => validateReview('reviewer', sample,
    { contract: {}, changes: [{ path: '/contextGraph/bindings/deliver/inheritReports', before: ['inspect'], after: [] }] }))
  for (const sample of examples(legacyResultReviewExamples)) assert.doesNotThrow(() => validateReview('result_check', sample,
    { submission: { artifacts: [] } }))
})

test('repair snapshot tool only inspects declared directories and rewrites one row without replacing the full report', async t => {
  const { config } = fixture(t), snapshot = snapshotDirectory(config, 'deliverable', signal())
  const original = report({ path: snapshot.path, files: snapshot.files, subdirectories: snapshot.subdirectories })
  const context = createRoleContext({ config: { ...config, model: 'fake', supervisionContext: 'reports', revision: { maxOutputTokens: 2048 } },
    role: 'result_repair', directorySnapshots: true, directory: path.join(config.directory, 'role'), signal: signal(), call: async () => assert.fail('No summary required'),
    messages: [{ role: 'system', content: 'Repair only this report' }, { role: 'user', content: JSON.stringify({ previousSubmission: JSON.stringify(original), execution: { marker: 'FULL_ORIGINAL_TRACE' } }) }] })
  assert.ok((await context.prepare()).tools.some(tool => tool.function.name === DIRECTORY_SNAPSHOT_TOOL))
  await context.continueRead(tools(DIRECTORY_SNAPSHOT_TOOL, { path: '.' }))
  assert.equal(JSON.parse((await context.prepare()).messages.at(-1).content).error, 'DIRECTORY_NOT_IN_REPORT')
  await context.continueRead(tools(DIRECTORY_SNAPSHOT_TOOL, { path: 'deliverable' }, 'call_2'))
  const receipt = JSON.parse((await context.prepare()).messages.at(-1).content)
  assert.equal(receipt.directory.hashScheme, DIRECTORY_HASH_SCHEME)
  await context.continueRead(tools(REPORT_EDIT, { expectedRevision: 0, edits: [{ op: 'set', path: '/executionReport/directories/0', value: receipt.directory }] }, 'call_3'))
  await context.continueRead(tools(REPORT_SUBMIT, { expectedRevision: 1 }, 'call_4'))
  const submitted = context.submitted()
  assert.deepEqual(submitted.executionReport.results, original.executionReport.results)
  assert.match((await context.prepare()).messages[1].content, /FULL_ORIGINAL_TRACE/)
  assert.equal(inspectExecutionReport({ config }, submitted, { tools: [] }, signal()).programValidation.directories[0].sha256, receipt.directory.sha256)
})

test('fake worker uses its bound snapshot tool; acceptance receives static proof without being granted hash tools', async t => {
  const { config, root } = fixture(t)
  let descriptor
  const h = await createRuntimeHarness({ projectRoot: config.projectRoot, directory: config.directory,
    config: { storageRoot: root, allowedTools: [DIRECTORY_SNAPSHOT_TOOL], supervision: true, supervisionContext: 'reports',
      revision: { policy: { objective: 'Deliver the result', requirements: [{ id: 'delivery', text: 'Deliver the result file' }] } }, direct: { durable: true } },
    respond: ({ index, payload }) => {
      if (index === 1) { assert.deepEqual(payload.tools.map(t => t.function.name).filter(name => !['read_image', 'dynamic_context_generate_report', 'dynamic_context_read_report', 'dynamic_context_rewrite_report', 'dynamic_context_submit_report'].includes(name)), [DIRECTORY_SNAPSHOT_TOOL]); return { tools: [{ name: DIRECTORY_SNAPSHOT_TOOL, arguments: { path: 'missing-directory' } }] } }
      if (index === 2) {
        const rejected = JSON.parse(payload.messages.at(-1).content.replace(/^<host-receipt>.*?<\/host-receipt>\n/, ''))
        assert.equal(rejected.error, 'ENOENT'); assert.equal(rejected.diagnostic.issues[0].path, '/path')
        return { tools: [{ name: DIRECTORY_SNAPSHOT_TOOL, arguments: { path: 'deliverable' } }] }
      }
      if (index === 3) { descriptor = JSON.parse(payload.messages.at(-1).content.replace(/^<host-receipt>.*?<\/host-receipt>\n/, '')).directory; assert.ok(descriptor); return { text: JSON.stringify(report(descriptor)) } }
      if (index === 4) {
        const input = JSON.parse(payload.messages[1].content)
        assert.equal(input.programValidation.directories[0].sha256, descriptor.sha256)
        assert.equal(input.programValidation.verifiedArtifacts.length, 1); assert.ok(payload.tools.every(tool => ['read_image', 'dynamic_context_generate_report', 'dynamic_context_read_report', 'dynamic_context_rewrite_report', 'dynamic_context_submit_report'].includes(tool.function.name)))
        return { text: '{"verdict":"ACCEPT","reason":"Result identity matches the local criterion","issues":[]}' }
      }
      return { text: '{"verdict":"CURRENT"}' }
    } })
  t.after(() => h.close())
  const p = runtimeProposal([DIRECTORY_SNAPSHOT_TOOL]); p.contextGraph.bindings[0].completion = { kind: 'artifact', path: 'deliverable/result.txt' }
  p.planningReport = { understanding: 'Deliver the result', assumptions: [], design: 'One leaf', acceptanceStrategy: 'Inspect the directory proof' }
  h.runner.submit(p)
  assert.equal((await h.runner.runNext({ expectedRevision: 1 })).status, 'RESULT_COMMITTED')
  assert.equal(h.backend.requests.length, 5)
})

test('protected report entries locate the report field and corrupted saved snapshots never masquerade as a changed deliverable', t => {
  const { config, folder } = fixture(t), receipt = issueDirectorySnapshot(config, 'deliverable', signal())
  const result = report(receipt.directory)
  fs.writeFileSync(path.join(folder, '.env'), 'private')
  assert.throws(() => inspectExecutionReport({ config }, result, { tools: [] }, signal()), error => {
    assert.equal(diagnostic(error).issues[0].path, '/executionReport/directories/0/path'); return true
  })
  fs.unlinkSync(path.join(folder, '.env'))
  const file = path.join(config.directory, 'directory-snapshots', receipt.snapshotId + '.json')
  const record = JSON.parse(fs.readFileSync(file)); record.entries = []; fs.writeFileSync(file, JSON.stringify(record))
  assert.throws(() => issueDirectorySnapshot(config, 'deliverable', signal()), /DIRECTORY_SNAPSHOT_RECEIPT_CHANGED/)
  fs.writeFileSync(path.join(folder, 'result.txt'), 'changed')
  assert.throws(() => inspectExecutionReport({ config }, result, { tools: [] }, signal()), /DIRECTORY_SNAPSHOT_RECEIPT_CHANGED/)
})

test('paused snapshot tool replays the original receipt even if files changed; final host validation catches the change', async t => {
  const { config: base, folder, root } = fixture(t), old = snapshotDirectory(base, 'deliverable', signal())
  const original = report({ path: old.path, files: old.files, subdirectories: old.subdirectories })
  let pause = false
  const backend = await startFakeLlama({ respond: ({ index, payload }) => {
    if (index === 1) { pause = true; return { tools: [{ name: DIRECTORY_SNAPSHOT_TOOL, arguments: { path: 'deliverable' } }] } }
    if (index === 2) {
      const receipt = JSON.parse(payload.messages.at(-1).content); assert.equal(receipt.directory.sha256, old.sha256)
      return { tools: [{ name: REPORT_EDIT, arguments: { expectedRevision: 0, edits: [{ op: 'set', path: '/executionReport/directories/0', value: receipt.directory }] } }] }
    }
    return { tools: [{ name: REPORT_SUBMIT, arguments: { expectedRevision: 1 } }] }
  } })
  t.after(() => backend.close())
  const runner = { ctx: { get: () => ({ resolve: async () => ({ value: 'fake-only' }) }) }, config: validateConfig({ ...base, storageRoot: root,
    model: 'fake-llama', provider: 'fake', systemPrompt: 'Fixture', transport: 'direct', supervisionContext: 'reports',
    revision: { policy: { objective: 'Deliver', requirements: [{ id: 'delivery', text: 'Deliver' }] }, maxOutputTokens: 2048 },
    direct: { endpoint: backend.origin + '/v1/chat/completions', apiKeyEnv: 'FAKE_DIRECTORY_KEY', durable: true } }),
    workflowControl: { beforeRequest() { if (pause) throw Object.assign(new Error('Paused'), { code: 'WORKFLOW_PAUSE_REQUESTED' }) } } }
  const request = { runId: 'revision_result_repair_' + randomUUID(), role: 'result_repair', signal: signal(),
    messages: [{ role: 'system', content: 'Repair only the report' }, { role: 'user', content: JSON.stringify({ previousSubmission: JSON.stringify(original) }) }] }
  await assert.rejects(directRevisionRole(runner, request), { code: 'WORKFLOW_PAUSE_REQUESTED' })
  assert.equal(readRoleRecord(runner, request.runId).context.directorySnapshots, true)
  fs.writeFileSync(path.join(folder, 'result.txt'), 'modified during pause'); pause = false
  const result = await directRevisionRole(runner, request)
  assert.equal(backend.requests.length, 3)
  assert.throws(() => inspectExecutionReport(runner, result, { tools: [] }, signal()), /SUPERVISION_DIRECTORY_HASH_MISMATCH/)
  assert.deepEqual(await directRevisionRole(runner, request), result); assert.equal(backend.requests.length, 3)
})
