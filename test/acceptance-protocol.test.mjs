import { suspendForGuidance, resolveGuidanceSuspension } from '../suspension.mjs'
import { blockageCatalog } from '../blockage-evidence.mjs'
import { crc32 } from 'node:zlib'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRuntimeHarness, runtimeProposal } from '../testing/runtime-harness.mjs'
import { acceptanceSnapshot, scopedCurrentFacts, planningAcceptanceVersion, checkPlanningAcceptance, archiveCorrectionInput } from '../acceptance-protocol.mjs'
import { DirectJournal } from '../durable-store.mjs'
import { createReceiptSelector, receiptCatalog, bindReceipt } from '../receipt-selection.mjs'
import { inspectDelivery, zipInventory } from '../delivery-evidence.mjs'
import { snapshotDirectory } from '../directory-evidence.mjs'
import { digest } from 'dsh-better-task-grapth/core'
import { inspectExecutionReport } from '../report-evidence.mjs'
const sha = value => createHash('sha256').update(value).digest('hex')
const plan = { version: 1, requirements: [{ id: 'goal', origin: 'USER', statement: 'Deliver the checked result', source: 'User request', verification: 'Recorded check of the actual result', required: true }], deliveryRequired: false }
const report = (extra = {}) => ({ outcome: 'COMPLETE', summary: 'Result ready', artifacts: [], executionReport: {
  workHistory: ['Worked within the active leaf'], results: [{ criterion: 'Local result', result: 'Ready', artifactRefs: [], testIds: [] }],
  directories: [], tests: [], limitations: ['No external interface tested'], verification: [{ requirementId: 'goal', status: 'LIMITED', method: 'ANALYSIS', target: 'fixture', environment: 'fake loopback', testIds: [], limits: ['External integration untested'], conclusion: 'Fixture only' }], ...extra } })
function reference(input, row = input.reports.find(row => row.value)) { return { source: row.source, sha256: row.sha256, path: '/result/summary', quote: row.value.result.summary } }
function defaultRole(payload) {
  const system = payload.messages[0].content
  if (!system.includes('DYNAMIC_CONTEXT_GROUP_FINAL_V1') && !system.includes('DYNAMIC_CONTEXT_TASK_REPORTER_V1') && !system.includes('你负责受理当前叶') && !system.includes('DYNAMIC_CONTEXT_SCOPE_PLAN_V1')) return
  const input = JSON.parse(payload.messages[1].content)
  if (system.includes('DYNAMIC_CONTEXT_SCOPE_PLAN_V1')) return { text: '{"verdict":"CURRENT"}' }
  if (system.includes('DYNAMIC_CONTEXT_GROUP_FINAL_V1')) {
    const ref = reference(input)
    return { text: JSON.stringify({ action: 'COMPLETE', summary: 'Fixture accepted', children: input.reports.map(row => ({ nodeId: row.value.taskId, conclusion: 'SATISFIED', reason: 'Fixture contract met', evidence: [reference(input, row)] })), limitations: [], goalCoverage: [{ requirementId: 'goal', conclusion: 'LIMITED', reason: 'Only fixture verified', evidence: [ref] }] }) }
  }
  if (system.includes('DYNAMIC_CONTEXT_TASK_REPORTER_V1')) return { text: JSON.stringify({ title: 'Fixture', summary: 'Done', achievements: ['Result'], limitations: [], verification: ['Fixture'], nextSteps: [], evidence: [reference(input)] }) }
  if (system.includes('你负责受理当前叶')) return { text: '{"verdict":"ACCEPT","reason":"Local evidence agrees","issues":[]}' }
}
async function fixture(t, respond, { tools = [], mutable = false, deliveryRequired = false, alias = false, transform, runtimeModules } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-v1-'))), projectRoot = path.join(root, 'workspace')
  fs.mkdirSync(projectRoot)
  const allowedTools = [...new Set([...tools, 'bash', 'dynamic_context_shared_read', 'dynamic_context_shared_update'])]
  const h = await createRuntimeHarness({ projectRoot, directory: path.join(root, 'state'), respond,
    config: { allowedTools, supervision: true, supervisionContext: 'reports', storageRoot: root,
      revision: { policy: { objective: 'Deliver the checked result', requirements: [{ id: 'goal', text: 'Check the local result' }] } }, direct: { durable: true, ...(runtimeModules ? { runtime: { modules: runtimeModules } } : {}) } } })
  t.after(async () => { await h.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const p = runtimeProposal(tools); p.taskGraph.hierarchy = { version: 1 }
  Object.assign(p.taskGraph.nodes[0], { terminal: 'task', acceptance: 'Accept fixture with declared limitations' })
  p.contextGraph.bindings[0].completion = { kind: 'report' }
  if (mutable) Object.assign(p.contextGraph.nodes[0], { mutable: true, content: 'OLD_FACT' })
  if (alias) {
    p.taskGraph.nodes[0].terminal = 'group'
    p.taskGraph.nodes[1].parent = 'group'
    p.taskGraph.nodes.push({ key: 'group', kind: 'container', parent: 'root', label: 'Single group', terminal: 'task', acceptance: 'Fixture group contract' })
  }
  p.planningReport = { understanding: 'Fixture', assumptions: [], design: 'One terminal', acceptanceStrategy: 'Check actual evidence', verification: { ...plan, deliveryRequired } }
  transform?.(p)
  h.runner.submit(p)
  return { ...h, root, projectRoot }
}
test('submission facts overlay only the bound closure and keep the start snapshot immutable', () => {
  const start = { contexts: [{ id: 'a', content: 'old', revision: 1 }], inheritedReports: [] }
  const state = { contexts: { nodes: [{ id: 'a', key: 'a', content: 'old', mutable: true, parents: ['b'] }, { id: 'b', key: 'b', content: 'parent', parents: [] }, { id: 'c', key: 'c', content: 'PRIVATE', mutable: true, parents: [] }], bindings: [{ taskId: 't', contexts: ['a'] }] },
    sharedContextHistory: [{ id: 'a', revision: 2, content: 'new', attemptId: 'attempt' }] }
  const value = acceptanceSnapshot(state, { taskId: 't', attemptId: 'attempt' }, { localContext: start })
  assert.equal(start.contexts[0].content, 'old'); assert.equal(value.submissionContext.contexts[0].content, 'new')
  assert.equal(value.submissionContext.changes.length, 1); assert.doesNotMatch(JSON.stringify(value), /PRIVATE/)
  assert.equal(scopedCurrentFacts(state, ['t']).length, 2)
})
test('real shared update reaches leaf acceptance and group review without changing the start trace', async t => {
  let checked = false, grouped = false
  const h = await fixture(t, ({ payload, index }) => {
    if (index === 1) { const assembly = JSON.parse(payload.messages[1].content.slice(payload.messages[1].content.indexOf('{"protocol"'))); return { tools: [{ name: 'dynamic_context_shared_update', arguments: { id: assembly.contexts[0].id, content: 'NEW_FACT' } }] } }
    if (index === 2) return { text: JSON.stringify(report()) }
    const input = JSON.parse(payload.messages[1].content)
    if (input.acceptanceContext) { checked = true; assert.equal(input.acceptanceContext.startContext.contexts[0].content, 'OLD_FACT'); assert.equal(input.acceptanceContext.submissionContext.contexts[0].content, 'NEW_FACT') }
    if (payload.messages[0].content.includes('DYNAMIC_CONTEXT_GROUP_FINAL_V1')) { grouped = true; assert.equal(input.currentSharedFacts[0].content, 'NEW_FACT') }
    return defaultRole(payload)
  }, { tools: ['dynamic_context_shared_update'], mutable: true })
  const result = await h.runner.runNext({ expectedRevision: 1 })
  assert.equal(result.status, 'TASK_REPORTED'); assert.ok(checked && grouped)
  assert.equal(result.trace.assembly.contexts[0].content, 'OLD_FACT')
})
test('WORK rejection executes a new segment under the same leaf and preserves original trace bytes', async t => {
  let worker = 0, reviewed = 0
  const h = await fixture(t, ({ payload }) => {
    const sys = payload.messages[0].content
    if (sys.includes('你负责受理当前叶') && reviewed++ === 0) return { text: JSON.stringify({ verdict: 'RETURN', reason: 'Actual result is wrong', issues: [{ path: '/submission/summary', item: 'local result', reason: 'Submitted result lacks the required content', expected: 'correct', observed: 'bad in submitted result', correction: 'WORK' }] }) }
    const role = defaultRole(payload); if (role) return role
    worker++
    if (worker === 1) return { tools: [{ name: 'bash', arguments: { command: "printf bad > result.txt", description: 'Create original result' } }] }
    if (worker === 2) return { text: JSON.stringify(report()) }
    if (worker === 3) {
      assert.match(payload.messages[1].content, /previousExecution/)
      const seed = payload.messages[1].content
      const assembly = JSON.parse(seed.slice(seed.indexOf('{"protocol"')))
      assert.ok(payload.tools.some(row => row.function.name === 'dynamic_context_source_read'))
      return { tools: [{ name: 'dynamic_context_source_read', arguments: assembly.correction.previousSubmission.sourceRead }] }
    }
    if (worker === 4) {
      assert.match(payload.messages.at(-1).content, /Result ready/)
      return { tools: [{ name: 'bash', arguments: { command: "printf correct > result.txt; cat result.txt", description: 'Correct local result' } }] }
    }
    return { text: JSON.stringify(report()) }
  }, { tools: ['bash'] })
  const first = await h.runner.runNext({ expectedRevision: 1 }), state = h.runner.graph.read()
  assert.equal(state.supervision.phase, 'REWORK_RESULT')
  const before = fs.readFileSync(path.join(first.runDirectory, 'trace.json')), attemptId = state.graph.state.active.attemptId
  const next = await h.runner.continueSupervision({ expectedRevision: state.revision, checkpointChecksum: state.checksum })
  assert.equal(next.status, 'TASK_REPORTED'); assert.equal(fs.readFileSync(path.join(h.projectRoot, 'result.txt'), 'utf8'), 'correct')
  assert.deepEqual(fs.readFileSync(path.join(first.runDirectory, 'trace.json')), before)
  assert.equal(h.runner.graph.read().reports[0].attemptId, attemptId)
  assert.equal(h.runner.graph.read().graph.events.filter(row => row.type === 'FINISHED').length, 1)
  assert.notEqual(next.runDirectory, first.runDirectory)
  const catalog = blockageCatalog(h.runner, h.runner.graph.read(), new AbortController().signal)
  assert.ok(catalog.has('trace:' + attemptId + ':1'))
  assert.equal(catalog.get('trace:' + attemptId + ':1').load().sessionId, first.trace.sessionId)
})
test('receipt selection binds exact ranges, rejects foreign or stale IDs and disambiguates reused call IDs', () => {
  const facts = { tools: [{ callId: 'same', receiptScope: 'a', name: 'bash', outcome: 'RETURNED', content: 'before\nPASS 😀\nafter' }, { callId: 'same', receiptScope: 'b', name: 'bash', outcome: 'RETURNED', content: 'FAIL' }] }
  const selector = createReceiptSelector(facts), listed = selector.execute('{"query":"PASS"}')
  assert.equal(listed.total, 1)
  const row = listed.receipts[0], binding = { id: row.id, sourceSha256: row.sourceSha256, start: 7, end: 14 }
  assert.equal(bindReceipt(binding, facts).quote, 'PASS 😀')
  assert.throws(() => bindReceipt({ ...binding, end: 13 }, facts), /RECEIPT_BINDING_RANGE/)
  assert.throws(() => bindReceipt({ ...binding, sourceSha256: '0'.repeat(64) }, facts), /RECEIPT_BINDING_SOURCE/)
  assert.throws(() => bindReceipt(binding, { tools: facts.tools.slice(1) }), /RECEIPT_BINDING_SOURCE/)
})
test('delivery validates all copied directory members and rejects missing or changed dependencies', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-check-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const dir of ['dist', 'consumer']) { fs.mkdirSync(path.join(root, dir)); fs.writeFileSync(path.join(root, dir, 'main'), 'entry'); fs.writeFileSync(path.join(root, dir, 'dependency'), 'needed') }
  const config = { projectRoot: root, directory: path.join(root, '.state'), direct: {} }, signal = new AbortController().signal
  const item = { id: 'package', path: 'dist', kind: 'directory', sha256: snapshotDirectory(config, 'dist', signal).sha256, entrypoints: ['main'], requiredFiles: ['dependency'], externalRequirements: [], userSteps: ['Run main'], testIds: ['consumer'], consumerCheck: { root: 'consumer', testId: 'consumer', isolation: 'Copied delivery only' } }
  const r = { delivery: { items: [item] }, tests: [{ id: 'consumer', status: 'PASS' }] }
  assert.equal(inspectDelivery({ config }, r, signal)[0].consumer.inputBytesMatched, true)
  fs.writeFileSync(path.join(root, 'consumer', 'dependency'), 'wrong')
  assert.throws(() => inspectDelivery({ config }, r, signal), /Consumer input/)
  item.requiredFiles.push('missing')
  assert.throws(() => inspectDelivery({ config }, r, signal))
  item.requiredFiles = ['../secret']; assert.throws(() => inspectDelivery({ config }, r, signal), /relative member/)
})
test('report-only correction selects a receipt and rewrites one field without another execution', async t => {
  let selection, repairStep = 0, executions = 0
  const h = await fixture(t, ({ payload }) => {
    const sys = payload.messages[0].content
    if (sys.includes('你负责补正')) {
      const tools = payload.tools.map(tool => tool.function.name)
      assert.ok(tools.includes('dynamic_context_select_receipt')); assert.ok(!tools.includes('bash'))
      if (++repairStep === 1) {
        const input = JSON.parse(payload.messages[1].content); assert.equal(input.execution.tools.length, 1)
        return { tools: [{ name: 'dynamic_context_select_receipt', arguments: { query: 'CHECK_OK' } }] }
      }
      if (repairStep === 2) {
        const row = JSON.parse(payload.messages.at(-1).content).receipts[0]
        selection = { id: row.id, sourceSha256: row.sourceSha256, start: row.matchStart, end: row.matchStart + 8 }
        return { tools: [{ name: 'dynamic_context_select_receipt', arguments: selection }] }
      }
      if (repairStep === 3) return { tools: [{ name: 'dynamic_context_rewrite_report', arguments: { expectedRevision: 0, edits: [
        { op: 'remove', path: '/executionReport/tests/0/callId' }, { op: 'remove', path: '/executionReport/tests/0/quote' },
        { op: 'set', path: '/executionReport/tests/0/evidence', value: selection } ] } }] }
      return { tools: [{ name: 'dynamic_context_submit_report', arguments: { expectedRevision: 1 } }] }
    }
    const role = defaultRole(payload); if (role) return role
    if (++executions === 1) return { tools: [{ name: 'bash', arguments: { command: 'printf CHECK_OK', description: 'Check fixture' } }] }
    return { text: JSON.stringify(report({ tests: [{ id: 'check', criterion: 'Fixture', status: 'PASS', expected: 'CHECK_OK', observed: 'CHECK_OK', callId: 'wrong', quote: 'wrong' }] })) }
  }, { tools: ['bash'] })
  await h.runner.runNext({ expectedRevision: 1 }); const state = h.runner.graph.read()
  assert.equal(state.supervision.phase, 'REPAIR_RESULT')
  const result = await h.runner.continueSupervision({ expectedRevision: state.revision, checkpointChecksum: state.checksum })
  assert.equal(result.status, 'TASK_REPORTED'); assert.equal(executions, 2)
  const submitted = h.runner.graph.read().supervision.outcomes[0].result.executionReport.tests[0]
  assert.equal(submitted.quote, 'CHECK_OK'); assert.ok(submitted.evidence)
  assert.match(h.runner.graph.read().supervision.outcomes[0].check.acceptanceSnapshotHash, /^[a-f0-9]{64}$/)
})
test('changed artifact after review returns to declaration and new acceptance, never rewrites an old SHA', async t => {
  let changed = false
  const h = await fixture(t, ({ payload }) => {
    if (payload.messages[0].content.includes('你负责受理当前叶') && !changed) { fs.writeFileSync(path.join(h.projectRoot, 'file.txt'), 'after'); changed = true }
    const role = defaultRole(payload); if (role) return role
    const r = report(); r.artifacts = [{ kind: 'artifact', ref: 'file.txt', sha256: sha('before') }]; return { text: JSON.stringify(r) }
  })
  fs.writeFileSync(path.join(h.projectRoot, 'file.txt'), 'before')
  const result = await h.runner.runNext({ expectedRevision: 1 })
  assert.equal(result.status, 'RESULT_RETURNED'); assert.equal(h.runner.graph.read().supervision.phase, 'REPAIR_RESULT')
  assert.equal(h.runner.graph.read().supervision.outcomes.length, 0)
  assert.match(h.runner.graph.read().supervision.pending.report.text, new RegExp(sha('before')))
  assert.doesNotMatch(h.runner.graph.read().supervision.pending.report.text, new RegExp(sha('after')))
})
for (const hold of [false, true]) test('a paused correction resumes its own checkpoint without replay, including blueprint suspension=' + hold, async t => {
  let worker = 0, reviews = 0
  const h = await fixture(t, ({ payload }) => {
    if (payload.messages[0].content.includes('你负责受理当前叶') && reviews++ === 0) return { text: JSON.stringify({ verdict: 'RETURN', reason: 'Work needed', issues: [{ path: '/submission/summary', item: 'result', reason: 'Actual result needs an amendment', expected: 'checked amendment', observed: 'first report omits amendment', correction: 'WORK' }] }) }
    const role = defaultRole(payload); if (role) return role
    if (++worker === 1) {
      assert.ok(!payload.tools?.some(row => row.function.name === 'dynamic_context_source_read'))
      return { text: JSON.stringify(report()) }
    }
    if (worker === 2) return { tools: [{ name: 'bash', arguments: { command: 'printf once >> counter', description: 'Make the one amendment' } }] }
    if (worker === 3) {
      const seed = payload.messages[1].content, assembly = JSON.parse(seed.slice(seed.indexOf('{"protocol"')))
      return { tools: [{ name: 'dynamic_context_source_read', arguments: assembly.correction.feedback.sourceRead }] }
    }
    if (worker === 4) assert.match(payload.messages.at(-1).content, /Actual result needs an amendment/)
    return { text: JSON.stringify(report()) }
  }, { tools: ['bash'], runtimeModules: ['shell'] })
  const initial = await h.runner.runNext({ expectedRevision: 1 }), state = h.runner.graph.read()
  const oldBytes = fs.readFileSync(path.join(initial.runDirectory, 'trace.json'))
  const paused = await h.runner.execute({ expectedRevision: state.revision, correction: true, correctionChecksum: state.checksum, pauseAfterRequests: 1 })
  assert.equal(paused.paused, true); assert.equal(h.runner.checkpointStatus().resumablePhase, true)
  assert.equal(h.runner.graph.read().supervision.phase, 'REWORK_RESULT')
  if (hold) {
    const prior = h.runner.graph.read(), scopeId = prior.graph.state.plan.nodes.find(node => node.parent === null).id
    suspendForGuidance(h.runner, { id: 'test-guidance', message: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Check this blueprint now' }] } }, { scopeId })
    assert.equal(h.runner.graph.read().supervision.phase, 'READY'); assert.equal(h.runner.graph.status().legalNext.length, 0)
    assert.equal(resolveGuidanceSuspension(h.runner).mode, 'resume')
    assert.deepEqual(h.runner.graph.read().supervision, prior.supervision)
  }
  const current = h.runner.graph.read(), resumed = await h.runner.continueSupervision({ expectedRevision: current.revision, checkpointChecksum: current.checksum })
  assert.equal(resumed.status, 'TASK_REPORTED'); assert.equal(fs.readFileSync(path.join(h.projectRoot, 'counter'), 'utf8'), 'once')
  assert.deepEqual(fs.readFileSync(path.join(initial.runDirectory, 'trace.json')), oldBytes)
  h.runner.output.read()
  const display = [...h.runner.output.rows.values()].filter(row => row.kind === 'model')
  assert.equal(new Set(display.map(row => row.key)).size, display.length)
  assert.ok(display.some(row => row.stage === 'result_work'))
  const cleanup = await h.runner.collectOrphans({ expectedRevision: h.runner.graph.read().revision })
  assert.equal(cleanup.dryRun, true); assert.ok(!cleanup.files.some(row => row.ref.endsWith('trace.json')))
})
function zipFixture(name, content = 'hello') {
  const n = Buffer.from(name), b = Buffer.from(content), crc = crc32(b)
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(2048, 6)
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(b.length, 18); local.writeUInt32LE(b.length, 22); local.writeUInt16LE(n.length, 26)
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(2048, 8)
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(b.length, 20); central.writeUInt32LE(b.length, 24); central.writeUInt16LE(n.length, 28)
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10)
  end.writeUInt32LE(46 + n.length, 12); end.writeUInt32LE(30 + n.length + b.length, 16)
  return Buffer.concat([local, n, b, central, n, end])
}
test('archive membership is checked from actual ZIP bytes, rejecting corruption, traversal and missing entrypoints', t => {
  const zip = zipFixture('main'), signal = new AbortController().signal
  assert.equal(zipInventory(zip, signal)[0].sha256, sha('hello'))
  const changed = Buffer.from(zip); changed[34] ^= 1
  assert.throws(() => zipInventory(changed, signal), /CRC/)
  assert.throws(() => zipInventory(zipFixture('../outside'), signal), /relative member/)
  assert.throws(() => zipInventory(zip.subarray(0, zip.length - 1), signal), /truncated/)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-delivery-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, 'bundle.zip'), zip); fs.mkdirSync(path.join(root, 'consumer')); fs.writeFileSync(path.join(root, 'consumer/main'), 'hello')
  const config = { projectRoot: root, directory: path.join(root, '.state'), direct: {} }
  const item = { id: 'zip', kind: 'file', path: 'bundle.zip', sha256: sha(zip), entrypoints: ['main'], requiredFiles: [], externalRequirements: [], userSteps: ['Unzip and run main'], testIds: ['consumer'], consumerCheck: { root: 'consumer', testId: 'consumer', isolation: 'Unzipped delivered bytes' } }
  const r = { delivery: { items: [item] }, tests: [{ id: 'consumer', status: 'PASS' }] }
  assert.equal(inspectDelivery({ config }, r, signal)[0].archive.length, 1)
  item.requiredFiles = ['omitted-config-tool']
  assert.throws(() => inspectDelivery({ config }, r, signal), /missing from the actual archive/)
})
test('missing final requirement coverage is located before any model acceptance', async t => {
  const h = await fixture(t, () => ({ text: JSON.stringify(report({ verification: [] })) }))
  const result = await h.runner.runNext({ expectedRevision: 1 })
  assert.equal(result.status, 'RESULT_RETURNED'); assert.equal(h.backend.requests.length, 1)
  assert.match(result.feedback, /ACCEPTANCE_FINAL_COVERAGE_REQUIRED/); assert.match(result.feedback, /executionReport\/verification/)
})
test('PLAN rejection retains the current lock and asks for an honest disposition before graph changes', async t => {
  const h = await fixture(t, ({ payload }) => {
    if (payload.messages[0].content.includes('你负责受理当前叶')) return { text: JSON.stringify({ verdict: 'RETURN', reason: 'Dependency absent', issues: [{ path: '/submission/summary', item: 'plan', reason: 'The result proves an unavailable prerequisite', expected: 'authorized prerequisite', observed: 'declared missing input', correction: 'PLAN' }] }) }
    return { text: JSON.stringify(report()) }
  })
  await h.runner.runNext({ expectedRevision: 1 }); const state = h.runner.graph.read()
  assert.equal(state.supervision.correction.route, 'PLAN'); assert.ok(state.graph.state.active)
  assert.equal(state.graph.events.filter(row => row.type === 'REVISED').length, 0)
  assert.throws(() => h.runner.graph.begin({ expectedRevision: state.revision }), /SUPERVISION_SCHEDULING_BLOCKED/)
})
test('actual delivery inventory reaches a single-group final report and its public clickable entrypoint', async t => {
  let worker = 0, groupChecks = 0, resultChecks = 0, item
  const h = await fixture(t, ({ payload }) => {
    const sys = payload.messages[0].content
    if (sys.includes('你负责受理当前叶')) {
      const input = JSON.parse(payload.messages[1].content); resultChecks++
      assert.equal(input.programValidation.deliveries[0].consumer.inputBytesMatched, true)
    }
    if (sys.includes('DYNAMIC_CONTEXT_GROUP_FINAL_V1')) {
      groupChecks++; const input = JSON.parse(payload.messages[1].content)
      assert.equal(input.aliasContracts.length, 1); assert.equal(input.publicEvidence[0].deliveries[0].id, 'product')
      if (groupChecks === 1) { const answer = defaultRole(payload); const row = JSON.parse(answer.text); delete row.goalCoverage; return { text: JSON.stringify(row) } }
      assert.match(payload.messages.at(-1).content, /GROUP_GOAL_COVERAGE_REQUIRED/)
    }
    if (sys.includes('DYNAMIC_CONTEXT_TASK_REPORTER_V1')) {
      const input = JSON.parse(payload.messages[1].content)
      assert.equal(input.acceptedRoot.deliveries[0].id, 'product')
    }
    const role = defaultRole(payload); if (role) return role
    if (++worker === 1) return { tools: [{ name: 'bash', arguments: { command: 'cd consumer && test "$(cat entry)" = ready && printf CONSUMER_PASS', description: 'Use delivered bytes in isolated directory' } }] }
    return { text: JSON.stringify(report({ delivery: { items: [item] }, tests: [{ id: 'consumer', criterion: 'Consumer path', status: 'PASS', expected: 'CONSUMER_PASS', observed: 'CONSUMER_PASS', callId: 'fake-call-1-0', quote: 'CONSUMER_PASS' }] })) }
  }, { tools: ['bash'], deliveryRequired: true, alias: true })
  for (const name of ['dist', 'consumer']) { fs.mkdirSync(path.join(h.projectRoot, name)); fs.writeFileSync(path.join(h.projectRoot, name, 'entry'), 'ready') }
  item = { id: 'product', kind: 'directory', path: 'dist', sha256: snapshotDirectory(h.runner.config, 'dist').sha256, entrypoints: ['entry'], requiredFiles: [], externalRequirements: [], userSteps: ['Read entry'], testIds: ['consumer'], consumerCheck: { root: 'consumer', testId: 'consumer', isolation: 'Copy of final delivery' } }
  const result = await h.runner.runNext({ expectedRevision: 1 })
  assert.equal(result.status, 'TASK_REPORTED'); assert.equal(resultChecks, 1); assert.equal(groupChecks, 2)
  const root = h.runner.graph.read().graph.state.plan.nodes.find(node => node.parent === null)
  assert.ok(h.runner.graph.read().graph.state.hierarchy.groups[root.id].aliasOf)
  const output = [...h.runner.output.rows.values()].find(row => row.title === '完整任务报告')
  assert.match(fs.readFileSync(path.join(h.runner.output.directory, output.id + '.txt'), 'utf8'), /交付入口\n- \[product\]/)
})
test('lost model reply in a correction stays unknown until explicit recovery and retains original execution', async t => {
  let worker = 0, reviews = 0
  const h = await fixture(t, ({ payload }) => {
    if (payload.messages[0].content.includes('你负责受理当前叶') && reviews++ === 0) return { text: JSON.stringify({ verdict: 'RETURN', reason: 'Correction required', issues: [{ path: '/submission/summary', item: 'fixture', reason: 'Actual local defect', expected: 'amended result', observed: 'specific missing result', correction: 'WORK' }] }) }
    const role = defaultRole(payload); if (role) return role
    if (++worker === 2) return { disconnect: true }
    return { text: JSON.stringify(report()) }
  })
  const initial = await h.runner.runNext({ expectedRevision: 1 }), state = h.runner.graph.read(), before = fs.readFileSync(path.join(initial.runDirectory, 'trace.json'))
  await assert.rejects(h.runner.continueSupervision({ expectedRevision: state.revision, checkpointChecksum: state.checksum }))
  const requests = h.backend.requests.length
  await assert.rejects(h.runner.continueSupervision({ expectedRevision: state.revision, checkpointChecksum: state.checksum }), /REQUIRES_RECOVERY/)
  assert.equal(h.backend.requests.length, requests)
  const checkpoint = h.runner.checkpointStatus()
  const recovered = await h.runner.resumeActive({ expectedRevision: state.revision, checkpointChecksum: checkpoint.checksum, recover: true })
  assert.equal(recovered.status, 'TASK_REPORTED'); assert.deepEqual(fs.readFileSync(path.join(initial.runDirectory, 'trace.json')), before)
  assert.ok(recovered.trace.requests.some(row => row.status !== 'COMPLETE'))
})
test('shared updates with a reused provider call ID remain distinct across correction segments', async t => {
  let worker = 0, reviews = 0, contextId
  const h = await fixture(t, ({ payload }) => {
    if (payload.messages[0].content.includes('你负责受理当前叶') && reviews++ === 0) return { text: JSON.stringify({ verdict: 'RETURN', reason: 'Fact was disproven', issues: [{ path: '/acceptanceContext/submissionContext/contexts/0/content', item: 'shared fact', reason: 'The checked fact needs correction', expected: 'correct value', observed: 'first value', correction: 'WORK' }] }) }
    const role = defaultRole(payload); if (role) return role
    worker++
    if (worker === 1 || worker === 3) {
      contextId ??= h.runner.graph.read().contexts.nodes[0].id
      return { tools: [{ id: 'same-provider-id', name: 'dynamic_context_shared_update', arguments: { id: contextId, content: worker === 1 ? 'first' : 'correct' } }] }
    }
    return { text: JSON.stringify(report()) }
  }, { tools: ['dynamic_context_shared_update'], mutable: true })
  await h.runner.runNext({ expectedRevision: 1 }); const state = h.runner.graph.read()
  const result = await h.runner.continueSupervision({ expectedRevision: state.revision, checkpointChecksum: state.checksum })
  assert.equal(result.status, 'TASK_REPORTED')
  const changes = h.runner.graph.read().sharedContextHistory
  assert.equal(changes.length, 2); assert.equal(changes[1].content, 'correct'); assert.equal(changes[1].sourceCallId, 'same-provider-id')
  assert.notEqual(changes[0].callId, changes[1].callId)
})
test('multi-group public summaries retain history and export only the final terminal delivery', async t => {
  let worker = 0, firstHash, lastHash, rootSeen = false
  const h = await fixture(t, ({ payload }) => {
    if (payload.messages[0].content.includes('DYNAMIC_CONTEXT_GROUP_FINAL_V1')) {
      const input = JSON.parse(payload.messages[1].content)
      if (input.reports.length === 2) { rootSeen = true; assert.equal(input.publicEvidence[0].deliveries[0].sha256, firstHash); assert.equal(input.publicEvidence[1].deliveries[0].sha256, lastHash) }
    }
    const role = defaultRole(payload); if (role) return role
    worker++
    if (worker === 1 || worker === 3) return { tools: [{ name: 'bash', arguments: { command: 'mkdir -p dist; printf ' + (worker === 1 ? 'first' : 'final') + ' > dist/entry', description: 'Create the version belonging to this leaf' } }] }
    const hash = snapshotDirectory(h.runner.config, 'dist').sha256
    if (worker === 2) firstHash = hash; else lastHash = hash
    return { text: JSON.stringify(report({ delivery: { items: [{ id: 'product', path: 'dist', kind: 'directory', sha256: hash, entrypoints: ['entry'], requiredFiles: [], externalRequirements: [], userSteps: ['Read entry'], testIds: [] }] } })) }
  }, { tools: ['bash'], deliveryRequired: true, transform(p) {
    p.taskGraph.nodes[0].terminal = 'b'; p.taskGraph.nodes[1].parent = 'a'
    p.taskGraph.nodes.push({ key: 'a', kind: 'container', parent: 'root', label: 'First group', terminal: 'task', acceptance: 'Initial result' },
      { key: 'b', kind: 'container', parent: 'root', label: 'Final group', terminal: 'finish', acceptance: 'Consolidated final result' },
      { key: 'finish', kind: 'leaf', parent: 'b', label: 'Finalize result' })
    p.taskGraph.edges.push({ kind: 'prerequisite', from: 'a', to: 'b' })
    p.contextGraph.bindings.push({ ...p.contextGraph.bindings[0], task: 'finish', inheritReports: ['a'] })
  } })
  assert.equal((await h.runner.runNext({ expectedRevision: 1 })).status, 'RESULT_COMMITTED')
  assert.equal((await h.runner.runNext({ expectedRevision: h.runner.graph.read().revision })).status, 'TASK_REPORTED')
  const state = h.runner.graph.read(), root = state.graph.state.plan.nodes.find(node => node.parent === null)
  assert.ok(rootSeen); assert.equal(state.graph.state.hierarchy.groups[root.id].deliveries.length, 1)
  assert.equal(state.graph.state.hierarchy.groups[root.id].deliveries[0].sha256, lastHash)
  assert.equal(state.supervision.outcomes[0].result.executionReport.delivery.items[0].sha256, firstHash)
  assert.notEqual(firstHash, lastHash)
})

test('new preplanning enforces the declaration while an existing unmarked planner retains its protocol', () => {
  const config = { supervision: true, supervisionContext: 'reports', transport: 'direct', direct: { durable: true, runtime: {} } }
  assert.equal(planningAcceptanceVersion(config, {}), 1)
  assert.throws(() => checkPlanningAcceptance(1, { planningReport: {} }), /PREPLANNING_ACCEPTANCE_PROTOCOL_REQUIRED/)
  assert.doesNotThrow(() => checkPlanningAcceptance(1, { planningReport: { verification: plan } }))
  assert.equal(planningAcceptanceVersion(config, { plannerSessionId: 'old' }), null)
  assert.equal(planningAcceptanceVersion(config, { plannerSessionId: 'new', plannerAcceptanceVersion: 1 }), 1)
  assert.equal(planningAcceptanceVersion({ ...config, supervisionContext: 'legacy' }, {}), null)
  assert.equal(planningAcceptanceVersion({ ...config, direct: { durable: true } }, {}), null)
  assert.doesNotThrow(() => checkPlanningAcceptance(null, {}))
})

test('large correction history stays outside the pinned seed and exact sources survive journal reopen', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'correction-archive-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const identity = { taskId: 'task', attemptId: 'attempt', contextVersion: 'c'.repeat(64), owner: 'owner', graphRevision: 1, sessionId: 'correction' }
  const journal = new DirectJournal(root, identity, { maxBytes: null })
  journal.append('PREPARING')
  const tools = Array.from({ length: 85 }, (_, i) => ({ callId: 'original_' + i, name: 'bash', outcome: 'RETURNED', receiptScope: 'a'.repeat(64), content: 'x'.repeat(100000) + 'EXACT_END_' + i }))
  const previousReport = { text: 'Report ' + 'r'.repeat(1000000) }, feedback = 'Specific evidence-backed defect'
  const data = archiveCorrectionInput(journal, { id: 'correction', route: 'WORK', previousReport }, feedback, { tools, localContext: { contexts: [] } })
  assert.ok(JSON.stringify(data).length < 6000, 'Pinned correction instructions must not grow with historical receipts')
  assert.ok(!JSON.stringify(data).includes('EXACT_END_84'))
  const restored = DirectJournal.open(root, identity, { maxBytes: null }); restored.restoreArchives([...journal.archives.values()])
  assert.equal(restored.readSource(data.feedback.sourceRead).text, feedback)
  let messageIndex = data.previousExecution.index.sourceRead.message_index, rows = []
  while (messageIndex !== null) {
    const page = restored.readSource({ ...data.previousExecution.index.sourceRead, message_index: messageIndex })
    assert.equal(page.nextOffset, null)
    const value = JSON.parse(page.text); rows.push(...value.receipts); messageIndex = value.nextMessageIndex
  }
  assert.equal(rows.length, tools.length)
  const last = rows.at(-1), tail = restored.readSource({ ...data.previousExecution.index.sourceRead, message_index: last.messageIndex, offset: last.characters - 100, length: 100 })
  assert.match(tail.text, /EXACT_END_84/)
  assert.throws(() => restored.readSource({ ...data.feedback.sourceRead, archive_id: 'f'.repeat(64) }), /DIRECT_ARCHIVE_NOT_OWNED/)
  const reportTail = restored.readSource({ ...data.previousSubmission.sourceRead, offset: previousReport.text.length - 90, length: 90 })
  assert.equal(reportTail.text, previousReport.text.slice(-90))
  assert.equal(reportTail.nextOffset, null)
})
