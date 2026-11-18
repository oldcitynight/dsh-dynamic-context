import { digest } from 'dsh-better-task-grapth/core'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { DynamicContextRuntime } from '../index.mjs'
import { createHarness } from '../testing/harness.mjs'
import { createRuntimeHarness, runtimeProposal } from '../testing/runtime-harness.mjs'
import { COMPACTION_INSTRUCTION } from '../dsh-compaction-policy.mjs'
import { EVIDENCE_TOOL } from '../role-context.mjs'

const policy = { objective: 'Deliver and check the requested fixture',
  requirements: [{ id: 'result', text: 'Use the authorized fixture and preserve actual outcomes.' }] }
const result = (outcome, summary, extra = {}) => ({ text: JSON.stringify({ outcome, summary, ...extra }) })
const accept = { text: JSON.stringify({ verdict: 'ACCEPT', reason: 'The receipt supports the requested disposition.' }) }
const current = { text: '{"verdict":"CURRENT"}' }
const question = { text: '{"verdict":"REVIEW_REQUIRED"}' }
const sha = value => createHash('sha256').update(value).digest('hex')

for (const mutate of [false, true]) test(`long artifact review preserves serial lock and commit revalidation (mutate=${mutate})`, async t => {
  const content = 'evidence item 0123456789, '.repeat(28000) + '\nTAIL_ORIGINAL_EVIDENCE\n'
  const artifact = { kind: 'artifact', ref: 'large.txt', sha256: sha(content) }
  let h, read = false, summaries = 0
  h = await fixture(t, ({ payload }) => {
    if (payload.messages.at(-1).content?.startsWith?.(COMPACTION_INSTRUCTION)) {
      summaries++
      if (!read) assert.ok(h.runner.graph.read().graph.state.active, 'Summary generation cannot release the leaf')
      return { text: 'Navigation only: the immutable original is large.txt; inspect its tail before deciding.' }
    }
    if (!payload.response_format) return result('COMPLETE', 'Prepared the requested artifact.', { artifacts: [artifact] })
    if (!payload.messages[0].content.includes('受理当前叶')) return current
    if (!read) {
      assert.ok(h.runner.graph.read().graph.state.active)
      const source = JSON.parse(payload.messages[2].content).sources[0]
      read = true
      return { tools: [{ name: EVIDENCE_TOOL, arguments: { id: source.id, start: source.characters - 30, end: source.characters } }] }
    }
    assert.match(JSON.parse(payload.messages.at(-1).content).text, /TAIL_ORIGINAL_EVIDENCE/)
    assert.ok(h.runner.graph.read().graph.state.active)
    if (mutate) fs.appendFileSync(path.join(h.projectRoot, 'large.txt'), 'changed during review')
    return accept
  }, { config: { maxOutputTokens: 32768, revision: { policy, maxOutputTokens: 32768 },
    direct: { compaction: { strategy: 'dsh-native', contextWindow: 262144 }, maxRequestBytes: null } } })
  fs.writeFileSync(path.join(h.projectRoot, 'large.txt'), content)
  const p = initial(); p.contextGraph.bindings[0].completion = { kind: 'artifact', path: 'large.txt' }
  h.runner.submit(p)
  if (mutate) {
    await assert.rejects(h.runner.runNext({ expectedRevision: 1 }))
    assert.ok(h.runner.graph.read().graph.state.active)
    assert.equal(h.runner.graph.read().reports.length, 0)
  } else {
    assert.equal((await h.runner.runNext({ expectedRevision: 1 })).status, 'RESULT_COMMITTED')
    assert.equal(h.runner.graph.read().graph.state.active, null)
    assert.equal(h.runner.graph.read().reports.length, 1)
  }
  assert.ok(summaries > 0)
})
const addLeaf = (proposal, key, predecessor) => {
  proposal.taskGraph.nodes.push({ key, kind: 'leaf', label: key, parent: 'root' })
  if (predecessor) proposal.taskGraph.edges.push({ kind: 'prerequisite', from: predecessor, to: key })
  proposal.contextGraph.bindings.push({ task: key, instruction: 'Use your committed binding.', contexts: ['task_data'],
    inheritReports: predecessor ? [predecessor] : [], tools: [], completion: { kind: 'report' } })
}
function initial(tools = []) {
  const proposal = runtimeProposal(tools)
  proposal.contextGraph.bindings[0].completion = { kind: 'report' }
  return proposal
}
async function fixture(t, respond, { runtime = false, config = {}, setup } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-supervision-')))
  const projectRoot = path.join(root, 'workspace')
  fs.mkdirSync(projectRoot)
  const h = await (runtime ? createRuntimeHarness : createHarness)({ projectRoot, directory: path.join(root, 'state'), respond,
    setup: setup ? ctx => setup(ctx, projectRoot, root) : undefined,
    config: { transport: 'direct', storageRoot: root, supervision: true, revision: { policy }, ...config,
      direct: { durable: true, ...config.direct },
    },
  })
  t.after(async () => { await h.close(); fs.rmSync(root, { recursive: true, force: true }) })
  return { ...h, projectRoot }
}
const resume = runner => {
  const state = runner.status()
  return runner.continueSupervision({ expectedRevision: state.revision, checkpointChecksum: state.supervision.checkpointChecksum })
}

test('local review and report repair receive actual paths and content without unrelated graph context', async t => {
  const h = await fixture(t, ({ payload, index }) => {
    if (index === 1) return { tools: [{ name: 'read', arguments: { file_path: 'wrong.txt' } }] }
    if (index === 2) return result('COMPLETE', 'Read required.txt and found the expected value.')
    const input = JSON.parse(payload.messages[1].content)
    if (index === 3 || index === 4) {
      assert.equal(input.execution.tools[0].arguments.file_path, 'wrong.txt')
      assert.match(JSON.stringify(input.execution.tools[0].content), /ACTUAL_WRONG_VALUE/)
      assert.match(JSON.stringify(input.execution.localContext), /LOCAL_REQUIREMENT/)
      assert.doesNotMatch(JSON.stringify(input), /UNRELATED_PRIVATE_CONTEXT/)
      if (index === 3) return { text: JSON.stringify({ verdict: 'RETURN', reason: 'The recorded read used wrong.txt, not required.txt.', issues: [{ path: '/submission/summary', item: 'required input', reason: 'The recorded read used wrong.txt, not required.txt.' }] }) }
      return result('BLOCKED', 'The required file has not been inspected. Only wrong.txt was read.')
    }
    return index === 5 ? accept : current
  }, { runtime: true })
  fs.writeFileSync(path.join(h.projectRoot, 'wrong.txt'), 'ACTUAL_WRONG_VALUE')
  const p = initial(['read'])
  p.contextGraph.nodes.find(node => node.key === 'task_data').content = 'LOCAL_REQUIREMENT: read required.txt and verify EXPECTED_VALUE.'
  p.contextGraph.nodes.push({ key: 'unrelated', content: 'UNRELATED_PRIVATE_CONTEXT', parents: [] })
  h.runner.submit(p)
  assert.equal((await h.runner.runNext({ expectedRevision: 1 })).status, 'RESULT_RETURNED')
  assert.equal((await resume(h.runner)).outcome, 'BLOCKED')
  assert.equal(h.runner.graph.read().reports.length, 0)
  assert.equal(h.backend.requests.filter(request => !request.payload.response_format).length, 2)
})

test('accepted BLOCKED closes only the attempt and leaves its dependent unready', async t => {
  const h = await fixture(t, ({ payload, index }) => {
    if (index === 1) return result('BLOCKED', 'A required fixture is missing.')
    assert.equal(payload.messages.length, 2)
    assert.ok(payload.tools.every(tool => ['read_image', 'dynamic_context_generate_report', 'dynamic_context_read_report', 'dynamic_context_rewrite_report', 'dynamic_context_submit_report'].includes(tool.function.name)))
    const input = JSON.parse(payload.messages[1].content)
    if (index === 2) {
      assert.equal(input.submission.outcome, 'BLOCKED')
      assert.ok(!input.snapshot)
      assert.doesNotMatch(JSON.stringify(input), /GLOBAL_PLAN_TITLE/)
      return accept
    }
    assert.equal(input.snapshot.taskStates.task.status, 'INCOMPLETE')
    assert.deepEqual(input.snapshot.scheduling.readyAfterReview, [])
    assert.deepEqual(input.snapshot.scheduling.pendingButBlocked, [
      { task: 'dependent', reason: 'UNMET_PREREQUISITE', unmetPrerequisites: ['task'] },
    ])
    assert.equal(input.latest.result.outcome, 'BLOCKED')
    assert.equal(input.latest.execution.localContext, undefined)
    assert.ok(input.snapshot.contextGraph.nodes.length)
    return current
  })
  const p = initial()
  p.taskGraph.title = 'GLOBAL_PLAN_TITLE'
  addLeaf(p, 'dependent', 'task')
  h.runner.submit(p)
  const accepted = await h.runner.runNext({ expectedRevision: 1 })
  assert.equal(accepted.outcome, 'BLOCKED')
  assert.equal(accepted.status, 'RESULT_COMMITTED')
  const state = h.runner.graph.read()
  assert.equal(state.supervision.phase, 'READY')
  assert.equal(state.graph.state.active, null)
  assert.equal(state.reports.length, 0)
  assert.equal(h.runner.status().taskGraph.legalNext.length, 0)
  assert.equal(h.backend.requests.length, 3)
})

test('unstructured text is returned before approval and never records completion', async t => {
  const h = await fixture(t, () => ({ text: 'Blocked; the fixture is missing.' }))
  h.runner.submit(initial())
  const rejected = await h.runner.runNext({ expectedRevision: 1 })
  assert.equal(rejected.status, 'RESULT_RETURNED')
  assert.match(rejected.feedback, /MODEL_JSON_SYNTAX/); assert.match(rejected.feedback, /location/)
  const state = h.runner.graph.read()
  assert.equal(state.supervision.phase, 'REPAIR_RESULT')
  assert.equal(state.revision, 2)
  assert.ok(state.graph.state.active)
  assert.deepEqual(state.reports, [])
  assert.equal(h.backend.requests.length, 1)
  await assert.rejects(h.runner.runNext({ expectedRevision: 2 }), { code: 'SUPERVISION_SCHEDULING_BLOCKED' })
  await assert.rejects(h.runner.revise({ expectedRevision: 2 }), { code: 'SUPERVISION_REVISION_SIGNAL_REQUIRED' })
})

test('small review returns a real write and repair reuses its evidence without repeating the tool', async t => {
  const content = 'committed fixture\n'
  const artifact = { kind: 'artifact', ref: 'result.txt', sha256: sha(content) }
  const h = await fixture(t, ({ payload, index }) => {
    if (index === 1) return { tools: [{ name: 'write', arguments: { file_path: 'result.txt', content } }] }
    if (index === 2) return result('COMPLETE', 'Report missing the required clarification.', { artifacts: [artifact] })
    if (index === 3) return { text: '{"verdict":"RETURN","reason":"Identify the produced result.","issues":[{"path":"/submission/summary","item":"produced result","reason":"The produced file is not identified."}]}' }
    if (index === 4) {
      assert.deepEqual(payload.tools.map(tool => tool.function.name), ['dynamic_context_generate_report', 'dynamic_context_read_report', 'dynamic_context_rewrite_report', 'dynamic_context_submit_report', 'read_image'])
      const input = JSON.parse(payload.messages[1].content)
      assert.equal(JSON.parse(input.feedback).reason, 'Identify the produced result.'); assert.equal(JSON.parse(input.feedback).issues[0].path, '/submission/summary')
      assert.deepEqual(input.execution.tools.map(tool => tool.name), ['write'])
      assert.equal(input.execution.tools[0].arguments.content, content)
      assert.match(JSON.stringify(input.execution.tools[0].content), /result\.txt/)
      assert.ok(input.execution.localContext.contexts.length)
      return result('COMPLETE', 'Wrote and supplied the result.txt receipt.', { artifacts: [artifact] })
    }
    return index === 5 ? accept : current
  }, { runtime: true })
  const p = initial(['write'])
  p.contextGraph.bindings[0].completion = { kind: 'artifact', path: 'result.txt' }
  h.runner.submit(p)
  const rejected = await h.runner.runNext({ expectedRevision: 1 })
  assert.equal(rejected.status, 'RESULT_RETURNED')
  const attempt = h.runner.graph.read().graph.state.active.attemptId
  const file = path.join(h.projectRoot, 'result.txt')
  const original = fs.statSync(file, { bigint: true })
  await h.runner.close()
  const reopened = new DynamicContextRuntime(h.ctx, h.runner.config)
  t.after(() => reopened.close())
  assert.equal((await resume(reopened)).outcome, 'COMPLETE')
  assert.equal(reopened.graph.read().reports[0].attemptId, attempt)
  assert.equal(reopened.graph.read().reports[0].text, 'Wrote and supplied the result.txt receipt.')
  assert.equal(reopened.graph.read().supervision.outcomes[0].result.artifacts.length, 1)
  assert.equal(fs.readFileSync(file, 'utf8'), content)
  assert.equal(fs.statSync(file, { bigint: true }).mtimeNs, original.mtimeNs)
  assert.equal(h.backend.requests.length, 6)
})

test('artifact completion without the required proof never reaches the small reviewer', async t => {
  const h = await fixture(t, () => result('COMPLETE', 'Claimed without a file.'))
  const p = initial()
  p.contextGraph.bindings[0].completion = { kind: 'artifact', path: 'required.txt' }
  h.runner.submit(p)
  const rejected = await h.runner.runNext({ expectedRevision: 1 })
  assert.match(rejected.feedback, /SUPERVISION_REQUIRED_ARTIFACT_MISSING/); assert.match(rejected.feedback, /path/)
  assert.equal(h.backend.requests.length, 1)
  assert.ok(h.runner.graph.read().graph.state.active)
})

test('a real multi-file delivery can submit and verify more than three artifacts', async t => {
  const artifacts = Array.from({ length: 6 }, (_, i) => ({ kind: 'artifact', ref: 'module-' + i + '.txt', sha256: sha('module-' + i) }))
  const h = await fixture(t, ({ payload, index }) => {
    if (index === 1) return result('COMPLETE', 'Six actual delivery files.', { artifacts })
    if (index === 2) {
      const input = JSON.parse(payload.messages[1].content)
      assert.equal(input.programValidation.verifiedArtifacts.length, 6)
      assert.equal(input.programValidation.artifactContents.length, 6)
      return accept
    }
    return current
  })
  for (const [i, artifact] of artifacts.entries()) fs.writeFileSync(path.join(h.projectRoot, artifact.ref), 'module-' + i)
  h.runner.submit(initial())
  assert.equal((await h.runner.runNext({ expectedRevision: 1 })).outcome, 'COMPLETE')
  assert.equal(h.runner.graph.read().supervision.outcomes[0].result.artifacts.length, 6)
})

test('invalid disposition feedback identifies the field and repair retains that guidance', async t => {
  const h = await fixture(t, ({ payload, index }) => {
    if (index === 1 || index === 2) return { text: '{"outcome":"SUCCESS","summary":"Invalid outcome label.","artifacts":[]}' }
    if (index === 3) {
      const input = JSON.parse(payload.messages[1].content)
      assert.match(input.feedback, /outcome/)
      assert.match(input.feedback, /COMPLETE/)
      return result('BLOCKED', 'The current scope cannot be completed.')
    }
    return index === 4 ? accept : current
  })
  h.runner.submit(initial())
  assert.match((await h.runner.runNext({ expectedRevision: 1 })).feedback, /outcome/)
  assert.equal((await resume(h.runner)).outcome, 'BLOCKED')
  assert.match(h.backend.requests[2].payload.messages.at(-1).content, /outcome/)
})

test('a terminal malformed repair can retry while retaining verified artifacts and the original write', async t => {
  const content = 'exact bytes without newline'
  const artifact = { kind: 'artifact', ref: 'result.txt', sha256: sha(content) }
  const h = await fixture(t, ({ payload, index }) => {
    if (index === 1) return { tools: [{ name: 'write', arguments: { file_path: 'result.txt', content } }] }
    if (index === 2) return { text: 'Finished writing.' }
    if (index === 3) return { text: '{"outcome":"COMPLETE","summary":"unterminated' }
    if (index === 4) return result('COMPLETE', 'Wrote the exact bytes.', { artifacts: [artifact] })
    if (index === 5) {
      const input = JSON.parse(payload.messages[1].content)
      assert.deepEqual(input.programValidation.verifiedArtifacts, [{ ...artifact, ref: path.join(h.projectRoot, artifact.ref) }])
      return accept
    }
    return current
  }, { runtime: true })
  const p = initial(['write'])
  p.contextGraph.bindings[0].completion = { kind: 'artifact', path: artifact.ref }
  h.runner.submit(p)
  assert.equal((await h.runner.runNext({ expectedRevision: 1 })).status, 'RESULT_RETURNED')
  const modified = fs.statSync(path.join(h.projectRoot, artifact.ref), { bigint: true }).mtimeNs
  assert.equal((await resume(h.runner)).outcome, 'COMPLETE')
  assert.deepEqual(h.runner.revisionRecovery(), [])
  assert.match(h.backend.requests[3].payload.messages.at(-1).content, /MODEL_JSON_SYNTAX/)
  assert.equal(fs.statSync(path.join(h.projectRoot, artifact.ref), { bigint: true }).mtimeNs, modified)
  assert.equal(h.backend.requests.length, 6)
})

test('the post-result scheduling gate survives restart and blocks a competing runner', async t => {
  const h = await fixture(t, ({ index }) => index === 1 ? result('COMPLETE', 'Prepared the report.') : index === 2 ? accept : current)
  const p = initial()
  addLeaf(p, 'next', 'task')
  h.runner.submit(p)
  const abort = new AbortController()
  const off = h.runner.subscribe(({ type }) => {
    if (type === 'result-committed') abort.abort(new Error('Synthetic interruption before plan review'))
  })
  await assert.rejects(h.runner.runNext({ expectedRevision: 1, signal: abort.signal }), /Synthetic interruption/)
  off()
  const state = h.runner.graph.read()
  assert.equal(state.supervision.phase, 'CHECK_PLAN')
  assert.equal(state.graph.state.active, null)
  assert.equal(h.runner.status().taskGraph.legalNext.length, 0)
  const other = new DynamicContextRuntime(h.ctx, h.runner.config)
  t.after(() => other.close())
  await assert.rejects(other.runNext({ expectedRevision: 3 }), { code: 'SUPERVISION_SCHEDULING_BLOCKED' })
  await assert.rejects(other.continueSupervision({ expectedRevision: 3, checkpointChecksum: '0'.repeat(64) }), { code: 'SUPERVISION_STALE_BASE' })
  assert.equal(h.backend.requests.length, 2)
  await h.runner.close()
  assert.equal((await resume(other)).plan, 'CURRENT')
  assert.equal(other.status().taskGraph.legalNext.length, 1)
  assert.equal(h.backend.requests.length, 3)
})

test('a durable small review response is consumed after restart without another request', async t => {
  const h = await fixture(t, ({ index }) => index === 1 ? result('COMPLETE', 'Prepared report.') : index === 2 ? accept : current)
  const abort = new AbortController()
  h.runner.registerRevisionAccounting({ beforeRequest() {}, onFailure() {},
    afterResponse(_receipt, { role }) { if (role === 'result_check') abort.abort(new Error('Stop after recorded review')) },
  })
  h.runner.submit(initial())
  await assert.rejects(h.runner.runNext({ expectedRevision: 1, signal: abort.signal }), /Stop after recorded review/)
  assert.equal(h.runner.status().supervision.phase, 'CHECK_RESULT')
  assert.equal(h.backend.requests.length, 2)
  await h.runner.close()
  const other = new DynamicContextRuntime(h.ctx, h.runner.config)
  t.after(() => other.close())
  assert.equal((await resume(other)).outcome, 'COMPLETE')
  assert.equal(h.backend.requests.length, 3)
})

test('an unknown supervision request leaves the attempt active and prohibits replay', async t => {
  const h = await fixture(t, ({ index }) => index === 1 ? result('COMPLETE', 'Prepared report.') : { disconnect: true })
  h.runner.submit(initial())
  await assert.rejects(h.runner.runNext({ expectedRevision: 1 }))
  const before = h.runner.graph.read()
  assert.equal(before.supervision.phase, 'CHECK_RESULT')
  assert.ok(before.graph.state.active)
  assert.equal(h.runner.revisionRecovery().length, 1)
  await assert.rejects(resume(h.runner), { code: 'REVISION_UNKNOWN_ROLE_REQUIRES_RECONCILIATION' })
  assert.equal(h.backend.requests.length, 2)
  assert.deepEqual(h.runner.graph.read(), before)
})

for (const approved of [true, false]) test('the signal has no proposal, and audit ' + (approved ? 'commits' : 'rejects') + ' the actual candidate', async t => {
  const h = await fixture(t, ({ payload, index }) => {
    if (index === 1) return result('BLOCKED', 'The old data source is unavailable. Use an authorized recovery task.')
    if (index === 2) return accept
    if (index === 3) return question
    const input = JSON.parse(payload.messages[1].content)
    if (index === 4) {
      const saved = h.runner.graph.read().supervision.signal
      assert.deepEqual(Object.keys(saved).sort(), ['attemptId', 'contextVersion', 'revision', 'runId'])
      assert.match(input.facts[0].text, /old data source is unavailable/)
      const { taskGraph, contextGraph } = input.snapshot
      addLeaf({ taskGraph, contextGraph }, 'recover')
      taskGraph.edges = [{ kind: 'prerequisite', from: 'recover', to: 'next' }]
      contextGraph.bindings.find(row => row.task === 'next').inheritReports = ['recover']
      contextGraph.nodes = contextGraph.nodes.map(node => ({ key: node.key, retain: true, sha256: input.snapshot.contextHashes[node.key] }))
      return { text: JSON.stringify({ disposition: 'REVISE', trigger: 'MISSING_DEPENDENCY', reason: 'Restore required input first.',
        evidenceIds: ['fact_0'], taskGraph, contextGraph, coverage: [{ requirement: 'result', tasks: ['recover', 'next'] }],
        retirements: [], invalidateReports: [],
      }), reasoning: 'PRIVATE_UPDATER_REASONING' }
    }
    assert.equal(input.programValidation.passed, true)
    assert.match(input.snapshot.supervisionReview.minimality, /unnecessary changes/)
    assert.match(input.snapshot.supervisionReview.completionSemantics, /including completion.kind=artifact/)
    assert.match(input.snapshot.supervisionReview.completionSemantics, /never replaces or suppresses the report/)
    assert.equal(Object.keys(input.snapshot)[0], 'contextGraph')
    assert.equal(input.snapshot.supervisionReview.runtimeSemantics.dispositions.COMPLETE.createsReport, true)
    assert.equal(input.snapshot.supervisionReview.runtimeSemantics.dispositions.BLOCKED.createsReport, false)
    assert.deepEqual(input.programValidation.changes.taskNodesAdded, ['recover'])
    assert.ok(!input.programValidation.changes.bindings.some(row => row.task === 'task'))
    assert.doesNotMatch(JSON.stringify(payload), /PRIVATE_UPDATER_REASONING/)
    return { text: JSON.stringify({ verdict: approved ? 'APPROVE' : 'REJECT', reason: 'Independent review.',
      violations: approved ? [] : ['The proposed recovery needs a real proof source.'], issues: approved ? [] : [{ path: '/proposal/reason', item: 'recover', reason: 'The proposed recovery needs a real proof source.' }] }) }
  })
  const p = initial()
  addLeaf(p, 'next', 'task')
  h.runner.submit(p)
  const outcome = await h.runner.runNext({ expectedRevision: 1 })
  assert.equal(outcome.plan, approved ? 'COMMITTED' : 'REJECT')
  const state = h.runner.graph.read()
  assert.equal(state.revision, approved ? 4 : 3)
  assert.equal(state.supervision.phase, approved ? 'READY' : 'REVISE')
  assert.equal(state.supervision.outcomes[0].result.outcome, 'BLOCKED')
  assert.deepEqual(h.runner.status().taskGraph.legalNext.map(row => row.label), approved ? ['recover'] : [])
  assert.equal(h.backend.requests.length, 5)
})

test('local review receives current artifact contents even when they changed after the recorded write', async t => {
  const original = '{"enabled":false}', currentBytes = '{"enabled":true}'
  const h = await fixture(t, ({ index }) => {
    if (index === 1) return { tools: [{ name: 'write', arguments: { file_path: 'result.json', content: original } }] }
    if (index === 2) {
      fs.writeFileSync(path.join(h.projectRoot, 'result.json'), currentBytes)
      return result('COMPLETE', 'The required disabled configuration was written.', {
        artifacts: [{ kind: 'artifact', ref: 'result.json', sha256: sha(currentBytes) }],
      })
    }
    return index === 3 ? accept : current
  }, { runtime: true })
  const p = initial(['write'])
  p.contextGraph.bindings[0].completion = { kind: 'artifact', path: 'result.json' }
  h.runner.submit(p)
  await h.runner.runNext({ expectedRevision: 1 })
  const input = JSON.parse(h.backend.requests[2].payload.messages[1].content)
  assert.equal(input.programValidation.artifactContents[0].text, currentBytes)
  assert.equal(input.execution.tools[0].arguments.content, original)
  assert.deepEqual(input.task.tools, ['write'])
})

test('every supervised worker receives the fixed host contract even when its selected nodes omit it', async t => {
  const h = await fixture(t, ({ index }) => index === 1 ? result('COMPLETE', 'A local report.') : index === 2 ? accept : current)
  h.runner.submit(initial())
  await h.runner.runNext({ expectedRevision: 1 })
  const input = h.backend.requests[0].payload.messages[1].content
  const assembly = JSON.parse(input.slice(input.lastIndexOf('\n\n') + 2))
  assert.deepEqual(assembly.taskContract, policy)
  const check = JSON.parse(h.backend.requests[1].payload.messages[1].content)
  assert.deepEqual(check.contract, policy)
})

for (const rejection of ['audit', 'program', 'malformed', 'schema']) test('rejected ' + rejection + ' proposal resumes after restart with feedback and serial exclusion', async t => {
  let updates = 0, reviews = 0
  const h = await fixture(t, ({ payload, index }) => {
    if (index === 1) return result('BLOCKED', 'The initial source is unavailable.')
    if (index === 2) return accept
    if (index === 3) return question
    const input = JSON.parse(payload.messages[1].content)
    if (payload.messages[0].content.includes('你是任务图修订角色')) {
      updates++
      if (updates === 1 && rejection === 'malformed') return { text: '{"disposition":' }
      if (updates === 1 && rejection === 'schema') return { text: '{"disposition":"REVISE"}' }
      if (updates === 2 && rejection === 'malformed') assert.match(payload.messages.at(-1).content, /MODEL_JSON_SYNTAX/)
      if (updates === 2 && rejection !== 'malformed') {
        assert.equal(input.priorReview.stage, rejection === 'audit' ? 'AUDIT' : 'PROGRAM')
        assert.doesNotMatch(JSON.stringify(input.priorReview), /PRIVATE_REVIEW_REASONING/)
      }
      const { taskGraph, contextGraph } = input.snapshot
      addLeaf({ taskGraph, contextGraph }, 'recover')
      taskGraph.edges = [{ kind: 'prerequisite', from: 'recover', to: 'next' }]
      contextGraph.bindings.find(row => row.task === 'next').inheritReports = ['recover']
      if (updates === 1 && rejection === 'program') contextGraph.bindings.find(row => row.task === 'recover').tools = ['unauthorized_tool']
      contextGraph.nodes = contextGraph.nodes.map(node => ({ key: node.key, retain: true, sha256: input.snapshot.contextHashes[node.key] }))
      return { text: JSON.stringify({ disposition: 'REVISE', trigger: 'MISSING_DEPENDENCY', reason: 'Add the required recovery step.',
        evidenceIds: ['fact_0'], taskGraph, contextGraph, coverage: [{ requirement: 'result', tasks: ['recover', 'next'] }], retirements: [], invalidateReports: [] }) }
    }
    reviews++
    assert.equal(input.priorReview, undefined)
    assert.ok(input.programValidation.proposedContextUse.find(row => row.task === 'recover').future)
    assert.equal(input.snapshot.contextUse.find(row => row.task === 'task').future, false)
    assert.deepEqual(input.programValidation.proposedContextUse.find(row => row.task === 'recover').contextKeys, ['shared_constraint', 'task_data'])
    return { text: JSON.stringify({ verdict: rejection === 'audit' && reviews === 1 ? 'REJECT' : 'APPROVE',
      reason: 'Independent review of the current candidate.', violations: rejection === 'audit' && reviews === 1 ? ['Clarify the recovery evidence.'] : [], issues: rejection === 'audit' && reviews === 1 ? [{ path: '/proposal/reason', item: 'recover', reason: 'Clarify the recovery evidence.' }] : [] }),
      reasoning: 'PRIVATE_REVIEW_REASONING' }
  })
  const p = initial()
  addLeaf(p, 'next', 'task')
  p.contextGraph.nodes.push({ key: 'shared_constraint', parents: [], content: 'Applicable shared requirement.' })
  p.contextGraph.nodes.find(node => node.key === 'task_data').parents = ['shared_constraint']
  h.runner.submit(p)
  const first = await h.runner.runNext({ expectedRevision: 1 })
  if (rejection === 'malformed') { assert.equal(first.plan, 'COMMITTED'); assert.equal(updates, 2); assert.equal(reviews, 1); return }
  assert.equal(first.plan, 'REJECT')
  const before = h.runner.graph.read()
  assert.equal(before.supervision.phase, 'REVISE')
  assert.deepEqual(h.runner.status().taskGraph.legalNext, [])
  assert.ok(h.runner.status().supervision.needsContinuation)
  await assert.rejects(h.runner.runNext({ expectedRevision: before.revision }), { code: 'SUPERVISION_SCHEDULING_BLOCKED' })
  if (rejection === 'program') {
    const receipt = path.join(h.runner.config.directory, 'revisions', before.supervision.revisionFeedback.updaterRunId, 'role.json')
    const bytes = fs.readFileSync(receipt)
    const changed = JSON.parse(bytes)
    changed.response.text += ' '
    fs.writeFileSync(receipt, JSON.stringify(changed))
    const requests = h.backend.requests.length
    await assert.rejects(resume(h.runner), { code: 'SUPERVISION_REVISION_FEEDBACK_CHANGED' })
    assert.equal(h.backend.requests.length, requests)
    assert.deepEqual(h.runner.graph.read(), before)
    fs.writeFileSync(receipt, bytes)
  }
  await h.runner.close()
  const reopened = new DynamicContextRuntime(h.ctx, h.runner.config)
  t.after(() => reopened.close())
  assert.equal((await resume(reopened)).plan, 'COMMITTED')
  assert.equal(updates, 2)
  assert.equal(reopened.graph.read().supervision.phase, 'READY')
  assert.equal(reopened.graph.read().supervision.outcomes.length, 1)
  assert.deepEqual(reopened.status().taskGraph.legalNext.map(row => row.label), ['recover'])
})

test('an unknown updater response cannot become a recoverable proposal rejection', async t => {
  const h = await fixture(t, ({ index }) => index === 1 ? result('BLOCKED', 'Required input missing.')
    : index === 2 ? accept : index === 3 ? question : { disconnect: true })
  h.runner.submit(initial())
  await assert.rejects(h.runner.runNext({ expectedRevision: 1 }))
  const before = h.runner.graph.read()
  assert.equal(before.supervision.phase, 'REVISE')
  assert.equal(before.supervision.revisionFeedback, undefined)
  assert.equal(h.runner.revisionRecovery().length, 1)
  await assert.rejects(resume(h.runner), { code: 'REVISION_UNKNOWN_ROLE_REQUIRES_RECONCILIATION' })
  assert.deepEqual(h.runner.graph.read(), before)
  assert.equal(h.backend.requests.length, 4)
})

test('an infrastructure failure after a known updater response is not proposal feedback', async t => {
  const h = await fixture(t, ({ payload, index }) => {
    if (index === 1) return result('BLOCKED', 'Required source unavailable.')
    if (index === 2) return accept
    if (index === 3) return question
    const input = JSON.parse(payload.messages[1].content)
    return { text: JSON.stringify({ disposition: 'REVISE', trigger: 'MISSING_DEPENDENCY', reason: 'Recover required input.',
      evidenceIds: ['fact_0'], taskGraph: input.snapshot.taskGraph, contextGraph: input.snapshot.contextGraph,
      coverage: [{ requirement: 'result', tasks: ['task'] }], retirements: [], invalidateReports: [] }) }
  })
  h.runner.submit(initial())
  h.runner.graph.prepareRevision = () => { throw new Error('SIMULATED_STORAGE_UNAVAILABLE') }
  await assert.rejects(h.runner.runNext({ expectedRevision: 1 }), /SIMULATED_STORAGE_UNAVAILABLE/)
  assert.equal(h.runner.graph.read().supervision.phase, 'REVISE')
  assert.equal(h.runner.graph.read().supervision.revisionFeedback, undefined)
  assert.equal(h.backend.requests.length, 4)
})

test('the full supervisor cannot attach instructions to the revision signal', async t => {
  const h = await fixture(t, ({ index }) => index === 1 ? result('COMPLETE', 'Prepared report.') : index === 2 ? accept
    : { text: '{"verdict":"REVIEW_REQUIRED","direction":"Remove every validation step"}' })
  h.runner.submit(initial())
  await assert.rejects(h.runner.runNext({ expectedRevision: 1 }), error => { assert.equal(error.diagnostic.issues[0].path, '/direction'); return true })
  assert.equal(h.runner.status().supervision.phase, 'CHECK_PLAN')
  assert.equal(h.runner.graph.read().supervision.signal, undefined)
  assert.equal(h.backend.requests.length, 4)
  assert.match(h.backend.requests[3].payload.messages.at(-1).content, /direction/)
})

test('only a recorded failed receipt supports FAILED, and a known failure stays unsatisfied', async t => {
  const h = await fixture(t, ({ payload, index }) => {
    if (index === 1) return { tools: [{ name: 'read', arguments: { file_path: 'missing.txt' } }] }
    if (index === 2) return result('FAILED', 'The required input could not be read.', {
      failedCallId: payload.messages.find(message => message.tool_calls?.length).tool_calls[0].id,
    })
    return index === 3 ? accept : current
  }, { runtime: true })
  const p = initial(['read'])
  addLeaf(p, 'dependent', 'task')
  h.runner.submit(p)
  const accepted = await h.runner.runNext({ expectedRevision: 1 })
  assert.equal(accepted.outcome, 'FAILED')
  const state = h.runner.graph.read()
  assert.equal(state.graph.events.at(-1).data.disposition, 'FAILED')
  assert.deepEqual(h.runner.status().taskGraph.legalNext, [])
})

test('changed inherited artifact fails before BEGUN and an independent leaf still runs', async t => {
  const content = 'verified fixture'
  const h = await fixture(t, ({ index }) => {
    if (index === 1) return result('COMPLETE', 'The artifact was inspected.', {
      artifacts: [{ kind: 'artifact', ref: 'source.txt', sha256: sha(content) }],
    })
    if (index === 4) return result('COMPLETE', 'Independent task report.')
    return index === 2 || index === 5 ? accept : current
  })
  const file = path.join(h.projectRoot, 'source.txt')
  fs.writeFileSync(file, content)
  const p = initial()
  p.contextGraph.bindings[0].completion = { kind: 'artifact', path: 'source.txt' }
  addLeaf(p, 'dependent', 'task')
  addLeaf(p, 'independent')
  h.runner.submit(p)
  await h.runner.runNext({ expectedRevision: 1 })
  const before = h.runner.graph.read()
  fs.writeFileSync(file, 'a later unapproved version')
  await assert.rejects(h.runner.runNext({ expectedRevision: 3, choice: 0 }), { code: 'ARTIFACT_CHANGED_OR_HASH_MISMATCH' })
  assert.deepEqual(h.runner.graph.read(), before)
  const choice = h.runner.status().taskGraph.legalNext.find(row => row.label === 'independent').choice
  assert.equal((await h.runner.runNext({ expectedRevision: 3, choice })).outcome, 'COMPLETE')
})

test('a competing runtime cannot acquire the shared lease during the full review', async t => {
  let other
  const h = await fixture(t, async ({ index }) => {
    if (index === 1) return result('COMPLETE', 'Prepared report.')
    if (index === 2) return accept
    await assert.rejects(other.runNext({ expectedRevision: 3 }), { code: 'DIRECT_EXECUTION_LEASE_HELD' })
    return current
  })
  const p = initial()
  addLeaf(p, 'next', 'task')
  h.runner.submit(p)
  other = new DynamicContextRuntime(h.ctx, h.runner.config)
  t.after(() => other.close())
  assert.equal((await h.runner.runNext({ expectedRevision: 1 })).plan, 'CURRENT')
  assert.equal(other.status().taskGraph.legalNext.length, 1)
  assert.equal(h.backend.requests.length, 3)
})

test('a review signal can end in NO_CHANGE without an audit or a graph mutation', async t => {
  const h = await fixture(t, ({ index }) => {
    if (index === 1) return result('COMPLETE', 'Prepared the expected report.')
    if (index === 2) return accept
    if (index === 3) return question
    assert.equal(index, 4)
    return { text: JSON.stringify({ disposition: 'NO_CHANGE', trigger: 'NONE', reason: 'Existing future bindings already cover the facts.',
      evidenceIds: [], taskGraph: null, contextGraph: null, coverage: [], retirements: [], invalidateReports: [],
    }) }
  })
  h.runner.submit(initial())
  const outcome = await h.runner.runNext({ expectedRevision: 1 })
  assert.equal(outcome.plan, 'NO_CHANGE')
  assert.equal(h.runner.graph.read().revision, 3)
  assert.equal(h.runner.status().supervision.phase, 'READY')
  assert.equal(h.backend.requests.length, 4)
})

test('trusted closure of an unknown worker commits an unsatisfied attempt and still requires plan review', async t => {
  const h = await fixture(t, ({ index }) => index === 1 ? { disconnect: true } : current)
  h.runner.submit(initial())
  await assert.rejects(h.runner.runNext({ expectedRevision: 1 }))
  const checkpoint = h.runner.checkpointStatus()
  const active = h.runner.graph.read().graph.state.active
  const record = path.join(h.projectRoot, 'operator-receipt.txt'), content = 'Synthetic operator verified quiescence.'
  fs.writeFileSync(record, content)
  h.runner.registerReconciliationVerifier({ version: 'fixture-v1', verify: async () => ({
    confirmedQuiescent: true, closeUnverified: true,
    evidence: [{ kind: 'artifact', ref: record, sha256: sha(content) }],
  }) })
  await h.runner.reconcileActive({ expectedRevision: 2, expectedAttemptId: active.attemptId,
    checkpointChecksum: checkpoint.checksum, note: 'Operator closed an unverified attempt.' })
  assert.equal(h.runner.status().supervision.phase, 'CHECK_PLAN')
  assert.equal((await resume(h.runner)).outcome, 'BLOCKED')
  assert.equal(h.runner.graph.read().reports.length, 0)
  assert.equal(h.backend.requests.length, 2)
})

test('a fabricated failed tool identifier cannot close the attempt', async t => {
  const h = await fixture(t, () => result('FAILED', 'Invented failure.', { failedCallId: 'never-executed' }))
  h.runner.submit(initial())
  const rejected = await h.runner.runNext({ expectedRevision: 1 })
  assert.match(rejected.feedback, /SUPERVISION_FAILED_RECEIPT_REQUIRED/); assert.match(rejected.feedback, /path/)
  assert.equal(h.backend.requests.length, 1)
  assert.ok(h.runner.graph.read().graph.state.active)
})

test('the real workflow port and controller schema expose only the supervised continuation', async t => {
  const { default: TaskGraph } = await import('dsh-better-task-grapth')
  const Persistence = await import('@deepseek-ai/dsh-session-persistence-jsonl').then(module => module.default)
  const h = await fixture(t, ({ index }) => index === 1 ? result('COMPLETE', 'Prepared report.') : index === 2 ? accept : current, {
    runtime: true, config: { exposeControlTools: true, interop: { workflowId: 'supervision-fixture' } },
    setup: async (ctx, projectRoot, root) => {
      await ctx.plugin(Persistence, { root: path.join(root, 'sessions') })
      await ctx.plugin(TaskGraph, { projectRoot })
    },
  })
  const controller = await h.ctx.agents.create({ sessionId: 'supervision-controller', meta: { cwd: h.projectRoot } })
  t.after(() => controller.dispose())
  const ref = { kind: 'dynamic-context', workflowId: 'supervision-fixture' }
  const port = h.ctx.transactionGraph
  const submit = h.ctx.tools.schemas(controller.agent).find(row => row.name === 'dynamic_context_submit')
  assert.equal(submit.parameters.properties.proposal.properties.contextGraph.properties.bindings.items.properties.completion.type, 'object')
  assert.equal(h.ctx.tools.get('dynamic_context_revise', controller.agent), undefined)
  assert.ok(h.ctx.tools.get('dynamic_context_continue_supervision', controller.agent))
  await port.dispatchWorkflow(controller.agent, ref, 'submit', { proposal: initial() })
  const view = port.readWorkflow(controller.agent, ref)
  assert.ok(view.operations.includes('continue_supervision'))
  assert.ok(!view.operations.includes('revise'))
  const completed = await port.dispatchWorkflow(controller.agent, ref, 'run_next', { expectedRevision: 1 })
  assert.equal(completed.outcome, 'COMPLETE')
  assert.equal(port.readWorkflow(controller.agent, ref).execution.supervision.phase, 'READY')
})

test('a paused report role keeps its original prompt across a prompt-only upgrade without repeating completed reads', async t => {
  let pause = false
  const h = await fixture(t, ({ index, payload }) => {
    if (index === 1) return { text: '{"outcome":"SUCCESS","summary":"Retain this draft.","artifacts":[]}' }
    if (index === 2) { pause = true; return { tools: [{ name: 'dynamic_context_read_report', arguments: { path: '/summary' } }] } }
    if (index === 3) {
      assert.match(payload.messages[0].content, /^OLD_PINNED_ROLE_PROMPT/)
      assert.equal(JSON.parse(payload.messages.at(-1).content).value, 'Retain this draft.')
      return result('BLOCKED', 'Required input is unavailable.')
    }
    assert.doesNotMatch(payload.messages[0].content, /OLD_PINNED_ROLE_PROMPT/)
    return index === 4 ? accept : current
  })
  h.runner.submit(initial())
  await h.runner.runNext({ expectedRevision: 1 })
  h.runner.workflowControl = { beforeRequest() { if (pause) throw Object.assign(new Error('Paused fixture'), { code: 'WORKFLOW_PAUSE_REQUESTED' }) } }
  await assert.rejects(resume(h.runner), { code: 'WORKFLOW_PAUSE_REQUESTED' })
  const roleId = h.runner.graph.read().supervision.roleRunId
  const file = path.join(h.runner.config.directory, 'revisions', roleId, 'role.json')
  const prior = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(prior.phase, 'PAUSED')
  // Represent a genuine older prompt while keeping every request and response
  // identity internally consistent in this isolated fixture only.
  prior.payload.messages[0].content = 'OLD_PINNED_ROLE_PROMPT\n' + prior.payload.messages[0].content
  prior.requestHash = digest(prior.payload)
  for (const call of prior.calls) { call.payload.messages[0].content = 'OLD_PINNED_ROLE_PROMPT\n' + call.payload.messages[0].content; call.requestHash = digest(call.payload) }
  fs.writeFileSync(file, JSON.stringify(prior))
  pause = false
  assert.equal((await resume(h.runner)).outcome, 'BLOCKED')
  assert.equal(h.backend.requests.length, 5)
})

test('executor generates a checked report by tool, repairs one field and commits real tool-call receipts', async t => {
  let workerCalls = 0
  const h = await fixture(t, ({ payload }) => {
    if (payload.response_format) return (payload.messages[0].content.includes('倒查') || payload.messages[0].content.includes('当前规划')) ? { tools: [{ name: 'dynamic_context_generate_report', arguments: { report: { verdict: 'CURRENT' } } }] }
      : { tools: [{ name: 'dynamic_context_generate_report', arguments: { report: { verdict: 'ACCEPT', reason: 'The report satisfies this fixture.' } } }] }
    workerCalls++
    if (workerCalls === 1) return { tools: [{ name: 'dynamic_context_generate_report', arguments: { report: { outcome: 'COMPLETE', summary: '' } } }] }
    if (workerCalls === 2) { assert.match(payload.messages.at(-1).content, /summary/); return { tools: [{ name: 'dynamic_context_rewrite_report', arguments: { expectedRevision: 1, edits: [{ op: 'set', path: '/summary', value: 'The requested report is ready.' }] } }] } }
    return { tools: [{ name: 'dynamic_context_submit_report', arguments: { expectedRevision: 2 } }] }
  }, { runtime: true })
  h.runner.submit(initial())
  const outcome = await h.runner.runNext({ expectedRevision: 1 })
  assert.equal(outcome.status, 'RESULT_COMMITTED', JSON.stringify(outcome))
  assert.equal(workerCalls, 3); assert.equal(h.runner.graph.read().supervision.outcomes.length, 1)
  assert.equal(outcome.trace.requests.at(-1).finish, 'tool_calls')
  assert.equal(outcome.trace.reportDraft.revision, 2)
  assert.ok(outcome.trace.events.some(row => row.type === 'task/structured-report-submitted'))
})
