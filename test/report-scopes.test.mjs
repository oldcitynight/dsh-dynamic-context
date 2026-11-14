import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { createRuntimeHarness, runtimeProposal } from '../testing/runtime-harness.mjs'
import { inspectExecutionReport, parseExecutionDisposition } from '../report-evidence.mjs'
import { digest } from 'dsh-better-task-grapth/core'

const sha = text => createHash('sha256').update(text).digest('hex')
const planningReport = { understanding: 'Deliver the local file, then verify it.', assumptions: ['ASSUMPTION_ORIGINAL'], design: 'Two serial leaves with explicit handoff.', acceptanceStrategy: 'Check file identity and the named test.' }
const policy = { objective: 'Deliver and verify local results', requirements: [{ id: 'delivery', text: 'Respect each local completion criterion.' }] }
const body = 'Delivered bytes\n', artifact = { kind: 'artifact', ref: 'deliverable/result.txt', sha256: sha(body) }
const submitted = () => ({ outcome: 'COMPLETE', summary: 'Delivered the requested result.', artifacts: [{ ...artifact }], executionReport: {
  workHistory: ['Prepared the deliverable and ran its check.'],
  results: [{ criterion: 'Deliver the fixture', result: 'Delivered bytes are ready for the next verification.', artifactRefs: [artifact.ref], testIds: ['fixture'] }],
  directories: [{ path: 'deliverable', files: [{ path: artifact.ref, sha256: artifact.sha256 }] }],
  tests: [{ id: 'fixture', criterion: 'The fixture check succeeds', status: 'PASS', expected: '1 check passed', observed: '1 check passed', callId: 'fake-call-2-0', quote: '1 check passed' }], limitations: [],
} })
async function fixture(t, respond, { later = false, laterInstruction = 'Verify the delivered result.' } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'report-scopes-'))), projectRoot = path.join(root, 'workspace')
  fs.mkdirSync(path.join(projectRoot, 'deliverable'), { recursive: true }); fs.writeFileSync(path.join(projectRoot, artifact.ref), body)
  const h = await createRuntimeHarness({ projectRoot, directory: path.join(root, 'state'), respond,
    config: { supervision: true, supervisionContext: 'reports', storageRoot: root, revision: { policy }, direct: { durable: true } } })
  t.after(async () => { await h.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const p = runtimeProposal(['bash']); p.planningReport = planningReport
  p.contextGraph.bindings[0].completion = { kind: 'artifact', path: artifact.ref }
  if (later) {
    p.taskGraph.nodes.push({ key: 'later', kind: 'leaf', parent: 'root', label: 'Verify later' })
    p.taskGraph.edges.push({ kind: 'prerequisite', from: 'task', to: 'later' })
    p.contextGraph.nodes.push({ key: 'unrelated', content: 'UNRELATED_SCOPE_MARKER', parents: [] })
    p.contextGraph.bindings.push({ task: 'later', instruction: laterInstruction, contexts: ['unrelated'], inheritReports: ['task'], tools: [], completion: { kind: 'report' } })
  }
  h.runner.submit(p)
  return { ...h, root, projectRoot }
}
const work = index => index === 1 ? { tools: [{ name: 'bash', arguments: { command: "printf 'RECOVERED_PROCESS_ERROR_NOISE'; exit 7", description: 'Synthetic recovered exploratory failure' } }] }
  : index === 2 ? { tools: [{ name: 'bash', arguments: { command: "printf '1 check passed\\n'", description: 'Verify the local criterion' } }] }
  : { text: JSON.stringify(submitted()) }

test('acceptance receives outcomes, host static checks and selected test output; plan review gets results and original planning only', async t => {
  const h = await fixture(t, ({ payload, index }) => {
    if (index <= 3) return work(index)
    const input = JSON.parse(payload.messages[1].content)
    assert.ok(!input.execution)
    assert.doesNotMatch(JSON.stringify(input), /RECOVERED_PROCESS_ERROR_NOISE/)
    if (index === 4) {
      assert.doesNotMatch(JSON.stringify(input), /UNRELATED_SCOPE_MARKER/)
      assert.equal(input.programValidation.verifiedArtifacts[0].source.sha256, artifact.sha256)
      assert.equal(input.programValidation.directories[0].completeMembershipVerified, true)
      assert.equal(input.acceptanceEvidence.tests[0].keyOutput, '1 check passed')
      assert.ok(!input.programValidation.artifactContents)
      assert.ok(!payload.tools, 'Acceptance does not calculate SHA through model tools')
      return { text: '{"verdict":"ACCEPT","reason":"The local result, tree, hashes and check agree."}' }
    }
    assert.equal(input.snapshot.planningRecord.report.assumptions[0], 'ASSUMPTION_ORIGINAL')
    assert.equal(input.snapshot.executionReports.length, 1)
    assert.ok(!input.snapshot.execution && !input.snapshot.outcomes && !input.snapshot.reports)
    assert.doesNotMatch(JSON.stringify(input.snapshot.executionReports), /1 check passed|callId|workHistory/)
    return { text: '{"verdict":"CURRENT"}' }
  }, { later: true })
  const result = await h.runner.runNext({ expectedRevision: 1 })
  assert.equal(result.status, 'RESULT_COMMITTED')
  assert.equal(h.runner.graph.read().graph.state.active, null)
  assert.equal(h.runner.graph.read().reports.length, 1)
})

test('updater explains each actual change with an original report citation; reviewer sees only report, diff, cited evidence and affected closure', async t => {
  let reviewerSeen = false
  const h = await fixture(t, ({ payload, index }) => {
    if (index <= 3) return work(index)
    const input = JSON.parse(payload.messages[1].content)
    if (index === 4) return { text: '{"verdict":"ACCEPT","reason":"Local result supported."}' }
    if (index === 5) return { text: '{"verdict":"REVIEW_REQUIRED"}' }
    if (index === 6) {
      assert.doesNotMatch(JSON.stringify(input), /RECOVERED_PROCESS_ERROR_NOISE|1 check passed/)
      assert.ok(input.evidenceCatalog.find(fact => fact.factId === 'fact_0').fields.some(field => field.pointer === '/summary'))
      const proposal = { disposition: 'REVISE', trigger: 'CONTEXT_GAP', reason: 'Specify the next verification based on the delivered result.', evidenceIds: ['fact_0'],
        taskGraph: input.snapshot.taskGraph, contextGraph: input.snapshot.contextGraph,
        coverage: [{ requirement: 'delivery', tasks: ['later'] }], retirements: [], invalidateReports: [],
        modificationReport: { summary: 'Clarify the pending verification.', changes: [{ path: '/contextGraph/bindings/later/instruction', why: 'The delivered file now supplies the target for the pending check.',
          evidence: [{ factId: 'fact_0', pointer: '/summary', quote: 'Delivered the requested result.' }] }] } }
      proposal.contextGraph.bindings.find(row => row.task === 'later').instruction = 'Verify deliverable/result.txt against the declared local criterion.'
      proposal.contextGraph.nodes = proposal.contextGraph.nodes.map(node => ({ key: node.key, retain: true, sha256: input.snapshot.contextHashes[node.key] }))
      return { text: JSON.stringify(proposal) }
    }
    reviewerSeen = true
    assert.ok(!input.snapshot && !input.proposal && !input.facts && !input.executionReports)
    assert.equal(input.changes.length, 1)
    assert.equal(input.changes[0].path, '/contextGraph/bindings/later/instruction')
    assert.equal(input.evidence[0].sourceValue, 'Delivered the requested result.')
    assert.deepEqual(input.affectedContexts.map(row => row.task), ['later'])
    assert.equal(input.programValidation.reportChangeCoverage, 'EXACT')
    assert.doesNotMatch(JSON.stringify(input), /RECOVERED_PROCESS_ERROR_NOISE|1 check passed|ASSUMPTION_ORIGINAL/)
    return { text: '{"verdict":"APPROVE","reason":"One necessary, scoped and grounded change.","violations":[]}' }
  }, { later: true })
  const result = await h.runner.runNext({ expectedRevision: 1 })
  assert.equal(result.plan, 'COMMITTED'); assert.ok(reviewerSeen)
  assert.deepEqual(h.runner.graph.read().planningRecord.report, planningReport)
})

test('a single JSON presentation fence is parsed without rewriting its contents, preserving narrative for review', () => {
  const result = submitted(), raw = 'Local outcome follows.\n\n```json\n' + JSON.stringify(result, null, 2) + '\n```\nNo global completion is claimed.'
  const parsed = parseExecutionDisposition(raw)
  assert.deepEqual(parsed.value, result)
  assert.equal(parsed.envelope.before, 'Local outcome follows.')
  assert.equal(parsed.envelope.after, 'No global completion is claimed.')
  assert.equal(parsed.envelope.originalSha256, digest(raw))
  assert.throws(() => parseExecutionDisposition('```json\n{}\n```\n```json\n{}\n```'))
  assert.throws(() => parseExecutionDisposition('{"other":"object"}\n```json\n{}\n```'))
  assert.throws(() => parseExecutionDisposition('```json\n{"invalid": }\n```'))
})
test('a unique disposition wrapper is losslessly normalized, while conflicting or extra fields remain validation errors', () => {
  const report = submitted(), { executionReport, ...disposition } = report
  const normalized = parseExecutionDisposition(JSON.stringify({ disposition, executionReport }))
  assert.deepEqual(normalized.value, report)
  assert.equal(normalized.envelope.structuralNormalization, 'unwrapped-disposition-object')
  for (const ambiguous of [{ disposition, outcome: 'BLOCKED', executionReport }, { disposition: report, executionReport }, { disposition, invented: true, executionReport }]) {
    const parsed = parseExecutionDisposition(JSON.stringify(ambiguous))
    assert.deepEqual(parsed.value, ambiguous)
    assert.equal(parsed.envelope, undefined)
  }
})

test('report-mode tool outputs show their true receipt IDs; fenced report is accepted without a paid repair call', async t => {
  let calls = 0
  const h = await fixture(t, ({ index, payload }) => {
    calls++
    if (index <= 2) return work(index)
    if (index === 3) {
      for (const tool of payload.messages.filter(message => message.role === 'tool')) {
        assert.ok(tool.content.startsWith('<host-receipt>'))
        const meta = JSON.parse(tool.content.slice('<host-receipt>'.length, tool.content.indexOf('</host-receipt>')))
        assert.equal(meta.callId, tool.tool_call_id)
      }
      return { text: 'Local result follows.\n```json\n' + JSON.stringify(submitted()) + '\n```' }
    }
    if (index === 4) {
      const input = JSON.parse(payload.messages[1].content)
      assert.equal(input.programValidation.reportEnvelope.before, 'Local result follows.')
      assert.equal(input.acceptanceEvidence.tests[0].keyOutput, '1 check passed')
      return { text: '{"verdict":"ACCEPT","reason":"Local verified result is consistent."}' }
    }
    return { text: '{"verdict":"CURRENT"}' }
  })
  assert.equal((await h.runner.runNext({ expectedRevision: 1 })).status, 'RESULT_COMMITTED')
  assert.equal(calls, 5)
})

test('unknown artifact feedback names the exact result field, bad path and allowed declarations', async t => {
  const h = await fixture(t, ({ index }) => {
    if (index <= 2) return work(index)
    const result = submitted(); result.executionReport.results[0].artifactRefs.push('input-only.json')
    return { text: JSON.stringify(result) }
  })
  const result = await h.runner.runNext({ expectedRevision: 1 })
  assert.equal(result.status, 'RESULT_RETURNED')
  assert.match(result.feedback, /executionReport.results\[0\]/)
  assert.match(result.feedback, /input-only.json/)
  assert.match(result.feedback, /declaredArtifactPaths/)
  assert.ok(h.runner.graph.read().graph.state.active)
  assert.equal(h.backend.requests.length, 3)
})

for (const fault of ['missing-report', 'wrong-hash', 'extra-file', 'extra-directory', 'fabricated-quote', 'unknown-test']) test(`static report validation rejects ${fault} before any acceptance request`, async t => {
  let h
  h = await fixture(t, ({ index }) => {
    if (index <= 2) return work(index)
    const report = submitted()
    if (fault === 'missing-report') delete report.executionReport
    if (fault === 'wrong-hash') { report.artifacts[0].sha256 = 'a'.repeat(64); report.executionReport.directories[0].files[0].sha256 = 'a'.repeat(64) }
    if (fault === 'extra-file') fs.writeFileSync(path.join(h.projectRoot, 'deliverable/extra.txt'), 'unreported')
    if (fault === 'extra-directory') fs.mkdirSync(path.join(h.projectRoot, 'deliverable/empty-unreported'))
    if (fault === 'fabricated-quote') report.executionReport.tests[0].quote = 'FORGED_PASS'
    if (fault === 'unknown-test') report.executionReport.results[0].testIds = ['unknown']
    return { text: JSON.stringify(report) }
  })
  const result = await h.runner.runNext({ expectedRevision: 1 })
  assert.equal(result.status, 'RESULT_RETURNED')
  assert.equal(h.backend.requests.length, 3)
  assert.equal(h.runner.graph.read().reports.length, 0)
  assert.ok(h.runner.graph.read().graph.state.active)
})

test('current directory/file identity is revalidated after semantic acceptance', async t => {
  let h
  h = await fixture(t, ({ index }) => {
    if (index <= 3) return work(index)
    fs.writeFileSync(path.join(h.projectRoot, artifact.ref), 'changed after static validation')
    return { text: '{"verdict":"ACCEPT","reason":"Synthetic approval cannot override current bytes."}' }
  })
  await assert.rejects(h.runner.runNext({ expectedRevision: 1 }))
  assert.ok(h.runner.graph.read().graph.state.active)
  assert.equal(h.runner.graph.read().reports.length, 0)
})
for (const change of ['modified', 'missing']) test(`historical report inheritance observes ${change} files without pretending they still match the accepted SHA`, async t => {
  const h = await fixture(t, ({ index }) => {
    if (index <= 3) return work(index)
    return { text: index === 4 ? '{"verdict":"ACCEPT","reason":"Verified local delivery."}' : '{"verdict":"CURRENT"}' }
  }, { later: true })
  await h.runner.runNext({ expectedRevision: 1 })
  const state = h.runner.graph.read(), later = state.graph.state.plan.nodes.find(n => n.key === 'later')
  // Exercise historical inheritance as used by a later leaf after an authorized
  // middle stage modified a previously delivered shared file.
  state.contexts.bindings.find(b => b.taskId === later.id).inheritReports = [state.reports[0].taskId]
  if (change === 'modified') fs.writeFileSync(path.join(h.projectRoot, artifact.ref), 'New current bytes from a later development stage\n')
  else fs.unlinkSync(path.join(h.projectRoot, artifact.ref))
  const inherited = h.runner.graph.checkInputs(state, later.id)[0]
  assert.equal(inherited.currentArtifactChecks[0].status, change === 'modified' ? 'CHANGED' : 'MISSING')
  assert.equal(inherited.currentArtifactChecks[0].acceptedSha256, artifact.sha256)
  assert.notEqual(inherited.currentArtifactChecks[0].currentSha256, artifact.sha256)
  assert.equal(state.reports[0].currentArtifactChecks, undefined, 'Historical report is not rewritten')
  const trace = state.reports[0].evidence[0].ref
  fs.appendFileSync(path.resolve(h.root, trace), '\nTAMPERED')
  assert.throws(() => h.runner.graph.checkInputs(state, later.id), /ARTIFACT_CHANGED_OR_HASH_MISMATCH/)
})

test('plan review accumulates all accepted result reports across leaves without inheriting their raw test output', async t => {
  const lengths = []
  const h = await fixture(t, ({ index, payload }) => {
    if (index <= 3) return work(index)
    if (index === 6) return { text: JSON.stringify({ outcome: 'COMPLETE', summary: 'Reported the inherited accepted status.', artifacts: [], executionReport: {
      workHistory: ['Read the inherited report.'], results: [{ criterion: 'Report the prior status', result: 'The prior leaf had an accepted delivery report.', artifactRefs: [], testIds: [] }],
      directories: [], tests: [], limitations: ['This reporting leaf did not independently recheck current bytes.'],
    } }) }
    if ([4, 7].includes(index)) return { text: '{"verdict":"ACCEPT","reason":"The requested local report is present."}' }
    const input = JSON.parse(payload.messages[1].content)
    lengths.push(input.snapshot.executionReports.length)
    assert.equal(input.snapshot.planningRecord.report.design, planningReport.design)
    assert.doesNotMatch(JSON.stringify(input.snapshot.executionReports), /RECOVERED_PROCESS_ERROR_NOISE|1 check passed/)
    return { text: '{"verdict":"CURRENT"}' }
  }, { later: true, laterInstruction: 'Report the inherited accepted status without running a new check.' })
  await h.runner.runNext({ expectedRevision: 1 })
  await h.runner.runNext({ expectedRevision: h.runner.status().revision })
  assert.deepEqual(lengths, [1, 2])
})
