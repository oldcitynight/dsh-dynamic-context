// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { digest } from 'dsh-better-task-grapth/core'
import { createHarness } from '../testing/harness.mjs'
import { hierarchyContext, prepareScopeProposal } from '../hierarchy-context.mjs'
import { advanceHierarchy, publishHierarchyReport } from '../hierarchy-runtime.mjs'
import { readRoleRecord } from '../revision-runtime.mjs'
import { WorkflowOrchestrator } from '../orchestration.mjs'
import { COMPACTION_INSTRUCTION } from '../dsh-compaction-policy.mjs'
import { WORKSPACE_TOOLS } from '../workspace-audit.mjs'
const policy = { objective: 'Deliver the complete verified fixture.', requirements: [{ id: 'result', text: 'Retain actual outcomes, verify delivery, preserve required constraints.' }] }
const answer = value => ({ text: JSON.stringify(value) })
const reference = row => ({ source: row.source, sha256: row.sha256, path: '/result/summary', quote: row.value.result.summary })
const group = (key, parent, terminal) => ({ key, kind: 'container', label: key, ...(parent ? { parent } : {}), terminal, acceptance: key + ': all required results verified' })
const leaf = (key, parent) => ({ key, kind: 'leaf', label: key, parent })
export function hierarchicalProposal(single = false) {
  const nodes = [group('root', null, single ? 'a' : 'b'), group('a', 'root', 'a_end'), leaf('a_work', 'a'), leaf('a_end', 'a'),
    ...single ? [] : [group('b', 'root', 'b_end'), leaf('b_end', 'b')]]
  return { planningReport: { understanding: policy.objective, assumptions: [], design: 'Two evidence-bound groups', acceptanceStrategy: 'Two-stage terminal review' },
    taskGraph: { title: policy.objective, hierarchy: { version: 1, maxGroupDepth: 3 }, nodes,
      edges: [{ kind: 'prerequisite', from: 'a_work', to: 'a_end' }, ...single ? [] : [{ kind: 'prerequisite', from: 'a', to: 'b' }]] },
    contextGraph: { nodes: [{ key: 'a_private', content: 'A_PRIVATE_CONTENT', parents: [] }, { key: 'b_private', content: 'B_PRIVATE_CONTENT', parents: [] }],
      bindings: nodes.filter(node => node.kind === 'leaf').map(node => ({ task: node.key, instruction: node.key + ': satisfy the declared fixture contract',
        contexts: [node.parent + '_private'], inheritReports: node.key === 'b_end' ? ['a'] : node.key === 'a_end' ? ['a_work'] : [], tools: [], completion: { kind: 'report' } })) } }
}
function classify(payload) {
  if (!payload.response_format) return 'worker'
  const prompt = payload.messages[0].content
  for (const [marker, role] of Object.entries({ GROUP_FINAL: 'group_audit', SCOPE_PLAN: 'scope_plan', SCOPE_UPDATE: 'scope_update', SCOPE_AUDIT: 'scope_audit', TASK_REPORTER: 'task_reporter', SCOPED_BLOCKAGE: 'scope_blockage' }))
    if (prompt.includes('DYNAMIC_CONTEXT_' + marker + '_V1')) return role
  if (prompt.includes('DYNAMIC_CONTEXT_BLOCKAGE_PAUSE_AUDIT_V1')) return 'scope_pause'
  if (prompt.includes('受理当前叶') || prompt.includes('你是当前叶处置请求的验收者')) return 'result_check'
  return 'other'
}
function complete(input) {
  return { action: 'COMPLETE', summary: 'Verified group result', limitations: [], children: input.reports.map(row => ({
    nodeId: row.value.taskId, conclusion: row.value.result.outcome === 'COMPLETE' ? 'SATISFIED' : 'ACCEPTED_LIMITATION',
    reason: 'The terminal evidence covers the required result; preserve prior disposition.', evidence: [reference(row)],
  })) }
}
function finalReport(input) { return { title: 'Fixture delivery', summary: 'Verified fixture and preserved history.', achievements: ['Fixture delivered'], limitations: [], verification: ['Evidence-backed tests'], nextSteps: [], evidence: [reference(input.reports.at(-1))] } }
function pause(input) {
  const row = input.reports.find(row => row.value)
  return { action: 'PAUSE', report: { version: 1, summary: 'Required authorized input is missing.',
    constraints: [{ description: 'The input cannot be obtained with current authorization.', affectedTasks: [row.value.taskId], evidence: [reference(row)] }],
    alternatives: { rework: 'Execution cannot create the missing authorized input.', replan: 'The fixed acceptance still requires that input.' },
    resumeCondition: 'User provides the authorized input.', requestedUserAction: 'Provide the missing input.' } }
}
async function fixture(t, respond, config = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hierarchy-fake-'))), projectRoot = path.join(root, 'work')
  fs.mkdirSync(projectRoot)
  const calls = []
  const h = await createHarness({ projectRoot, directory: path.join(root, 'state'), config: {
    transport: 'direct', storageRoot: root, supervision: true, revision: { policy }, direct: { durable: true }, ...config,
  }, respond: request => {
    const role = request.payload.messages.at(-1).content?.startsWith?.(COMPACTION_INSTRUCTION) ? 'compaction' : classify(request.payload)
    const input = ['worker', 'compaction'].includes(role) ? null : JSON.parse(request.payload.messages[1].content)
    calls.push({ role, input, payload: request.payload })
    const custom = respond?.({ ...request, role, input, calls })
    if (custom) return custom
    if (role === 'worker') return answer({ outcome: 'COMPLETE', summary: 'Verified actual leaf result.' })
    if (role === 'result_check') return answer({ verdict: 'ACCEPT', reason: 'The disposition satisfies the leaf contract.', issues: [] })
    if (role === 'scope_plan') return answer({ verdict: 'CURRENT' })
    if (role === 'group_audit') return answer(complete(input))
    if (role === 'task_reporter') return answer(finalReport(input))
    if (role === 'scope_pause' || role === 'scope_audit') return answer({ verdict: 'APPROVE', reason: 'Evidence and scoped contract support this decision.', issues: [] })
    throw Error('Unexpected role ' + role)
  } })
  t.after(async () => { await h.close(); fs.rmSync(root, { recursive: true, force: true }) })
  return { ...h, root, calls }
}
const next = runner => runner.runNext({ expectedRevision: runner.graph.read().revision })
const workspaceResult = payload => payload.messages.filter(row => row.role === 'tool').map(row => {
  try { return JSON.parse(row.content) } catch { return null }
}).findLast(row => row?.source?.startsWith('workspace:'))
const workspaceReference = row => ({ source: row.source, sha256: row.sourceSha256, path: '/text', quote: row.value.text })
const inspectFile = file => ({ tools: [{ name: WORKSPACE_TOOLS.read, arguments: { path: file } }] })
test('group and root auditors read actual files; sibling roles never receive filesystem tools', async t => {
  const h = await fixture(t, ({ role, input, payload }) => {
    const names = payload.tools?.map(row => row.function.name) ?? []
    if (role !== 'group_audit') { assert.ok(names.every(name => !Object.values(WORKSPACE_TOOLS).includes(name))); return }
    assert.ok(Object.values(WORKSPACE_TOOLS).every(name => names.includes(name)))
    assert.ok(!names.includes('bash')); assert.ok(!names.includes('write'))
    const root = input.blueprint.value.scope.key === 'root'
    assert.equal(input.auditMandate.level, root ? 'graph' : 'group')
    assert.match(payload.messages[0].content, root ? /DYNAMIC_CONTEXT_GRAPH_OUTCOME_AUDIT_V1/ : /DYNAMIC_CONTEXT_GROUP_OUTCOME_AUDIT_V1/)
    assert.equal(input.auditMandate.groupGoal.acceptance, input.acceptance)
    if (root) { assert.equal(input.auditMandate.plannedOverallGoal.title, policy.objective); assert.deepEqual(input.contract, policy) }
    const read = workspaceResult(payload)
    if (!read) return inspectFile('delivery.txt')
    assert.equal(read.value.text, 'actual delivered interface')
    const result = complete(input); result.children.at(-1).evidence.push(workspaceReference(read)); return answer(result)
  })
  fs.writeFileSync(path.join(h.runner.config.projectRoot, 'delivery.txt'), 'actual delivered interface')
  h.runner.submit(hierarchicalProposal()); await next(h.runner); await next(h.runner); await next(h.runner)
  assert.equal(h.runner.graph.status().goalReached, true)
  assert.equal(h.calls.filter(row => row.role === 'group_audit').length, 6)
  const state = h.runner.graph.read(), rootId = state.graph.state.plan.nodes.find(row => row.key === 'root').id
  assert.ok(state.graph.state.hierarchy.groups[rootId].audit.children.at(-1).evidence.some(row => row.source.startsWith('workspace:')))
  assert.equal(state.graph.state.hierarchy.groups[rootId].workspaceInspection.observations[0].path, 'delivery.txt')
  assert.ok(h.calls.filter(row => row.role === 'group_audit' && row.input.blueprint.value.scope.key === 'root')
    .every(row => row.input.reports.every(report => report.value.result.workspaceInspection.observations.length === 1)))
  assert.deepEqual(h.backend.errors, [])
  const plan=state.graph.state.plan, a=plan.nodes.find(n=>n.key==='a').id, b=plan.nodes.find(n=>n.key==='b').id
  const rootCatalog=hierarchyContext(h.runner,state,rootId).catalog, aCatalog=hierarchyContext(h.runner,state,a).catalog
  const aSources=[...rootCatalog].filter(([,row])=>row.kind==='workspace'&&row.taskId===a)
  const bSources=[...rootCatalog].filter(([,row])=>row.kind==='workspace'&&row.taskId===b)
  assert.ok(aSources.length&&bSources.length)
  assert.ok(aSources.every(([source])=>aCatalog.has(source)))
  assert.ok(bSources.every(([source])=>!aCatalog.has(source)),'historical observations must follow existing group scope filtering')
  fs.writeFileSync(path.join(h.runner.config.projectRoot,'delivery.txt'),'later legitimate work changed this file')
  assert.equal(aSources[0][1].load().text,'actual delivered interface','historical reads do not re-open the current project file')
})
test('a workspace contradiction can return the terminal report with both task and artifact evidence', async t => {
  let returned = false
  const h = await fixture(t, ({ role, input, payload }) => {
    if (role !== 'group_audit' || returned) return
    const read = workspaceResult(payload); if (!read) return inspectFile('delivery.txt')
    const row = input.reports.find(row => row.value.taskId === input.terminalLeaf.id)
    returned = true
    return answer({ action: 'REWORK', report: { version: 1, findings: [{ taskId: row.value.taskId, attemptId: row.value.attemptId,
      reasonCode: 'CONTRADICTED_RESULT', criterion: 'The declared final interface is actually delivered.', problem: 'The report says verified; the delivered interface still names a nonexistent component.',
      correction: 'Correct the actual interface and revalidate it.', evidence: [reference(row), workspaceReference(read)] }] } })
  })
  fs.writeFileSync(path.join(h.runner.config.projectRoot, 'delivery.txt'), 'component=nonexistent')
  h.runner.submit(hierarchicalProposal(true)); await next(h.runner); await next(h.runner)
  assert.equal(h.runner.graph.status().legalNext[0].label, 'a_end'); assert.equal(h.runner.graph.read().reportArchive.length, 1)
  assert.equal(h.calls.filter(row => row.role === 'worker').length, 2)
})
test('an audited pause resolves its prior workspace citations without granting the pause reviewer filesystem tools', async t => {
  const h = await fixture(t, ({ role, input, payload }) => {
    if (role === 'group_audit') {
      const read = workspaceResult(payload); if (!read) return inspectFile('condition.txt')
      const result = pause(input); result.report.constraints[0].evidence.push(workspaceReference(read)); return answer(result)
    }
    if (role === 'scope_pause') {
      assert.ok(input.evidence.some(row => row.kind === 'workspace' && row.value === 'authorized input unavailable'))
      assert.ok((payload.tools ?? []).every(row => !Object.values(WORKSPACE_TOOLS).includes(row.function.name)))
    }
  })
  fs.writeFileSync(path.join(h.runner.config.projectRoot, 'condition.txt'), 'authorized input unavailable')
  h.runner.submit(hierarchicalProposal(true)); await next(h.runner); await next(h.runner)
  assert.equal(h.runner.graph.read().supervision.hierarchy.stage, 'WAITING_USER')
  assert.equal(h.calls.filter(row => row.role === 'scope_pause').length, 1)
})
test('workspace evidence survives a paused group role and changed bytes cause a fresh read before completion', async t => {
  let changeAfterRead = false
  const h = await fixture(t, ({ role, input, payload }) => {
    if (role !== 'group_audit') return
    const read = workspaceResult(payload)
    if (!read || payload.messages.at(-1).role === 'user') { changeAfterRead = true; return inspectFile('delivery.txt') }
    const result = complete(input); result.children.at(-1).evidence.push(workspaceReference(read)); return answer(result)
  })
  const file = path.join(h.runner.config.projectRoot, 'delivery.txt'); fs.writeFileSync(file, 'before pause')
  h.runner.submit(hierarchicalProposal(true)); await next(h.runner)
  h.runner.workflowControl = { recoverModel: false, beforeRequest() {
    if (changeAfterRead) { const error = Error('paused'); error.code = 'WORKFLOW_PAUSE_REQUESTED'; throw error }
  } }
  await assert.rejects(next(h.runner))
  const state = h.runner.graph.read(), runId = state.supervision.roleRunId
  assert.equal(readRoleRecord(h.runner, runId).phase, 'PAUSED')
  fs.writeFileSync(file, 'after pause'); changeAfterRead = false
  h.runner.workflowControl = { recoverModel: true, beforeRequest() {} }
  await h.runner.continueSupervision({ expectedRevision: state.revision, checkpointChecksum: state.checksum })
  assert.equal(h.runner.graph.status().goalReached, true)
  assert.equal(h.calls.filter(row => row.role === 'worker').length, 2)
  const calls = h.calls.filter(row => row.role === 'group_audit')
  assert.equal(workspaceResult(calls[1].payload).value.text, 'before pause')
  assert.match(calls[2].payload.messages.at(-1).content, /WORKSPACE_OBSERVATION_STALE/)
  assert.equal(workspaceResult(calls.at(-1).payload).value.text, 'after pause')
})
test('full fake two-group flow separates leaf, group and root acceptance and emits one final report', async t => {
  const h = await fixture(t); h.runner.submit(hierarchicalProposal())
  await next(h.runner); await next(h.runner); await next(h.runner)
  assert.deepEqual(h.calls.map(row => row.role), ['worker','result_check','scope_plan','worker','result_check','group_audit','scope_plan','worker','result_check','group_audit','group_audit','task_reporter'])
  assert.equal(h.runner.graph.status().goalReached, true)
  assert.equal(h.runner.graph.read().supervision.finalReport.report.title, 'Fixture delivery')
  const plans = h.calls.filter(row => row.role === 'scope_plan')
  assert.ok(!JSON.stringify(plans[0].input).includes('B_PRIVATE_CONTENT'))
  assert.ok(!JSON.stringify(plans[1].input).includes('A_PRIVATE_CONTENT'))
  const root = h.calls.filter(row => row.role === 'group_audit').at(-1)
  assert.equal(root.input.reports.length, 2); assert.ok(root.input.reports.every(row => row.source.startsWith('group:')))
  assert.ok(!JSON.stringify(root.input).includes('A_PRIVATE_CONTENT'))
  const before = h.calls.length; publishHierarchyReport(h.runner); publishHierarchyReport(h.runner)
  assert.equal(h.calls.length, before)
  const output = h.runner.output.read({}).items.filter(row => row.title === '完整任务报告')
  assert.equal(output.length, 1)
})
test('single effective group reuses root audit and reports from its own direct children', async t => {
  const h = await fixture(t); h.runner.submit(hierarchicalProposal(true)); await next(h.runner); await next(h.runner)
  assert.equal(h.calls.filter(row => row.role === 'group_audit').length, 1)
  const audit = h.calls.find(row => row.role === 'group_audit')
  assert.equal(audit.input.aliasContracts.length, 1)
  assert.equal(audit.input.auditMandate.level, 'graph'); assert.equal(audit.input.auditMandate.reusesSingleGroup, true)
  assert.match(audit.payload.messages[0].content, /原始用户需求是最终依据/)
  assert.ok(h.calls.find(row => row.role === 'task_reporter').input.reports.every(row => row.source.startsWith('report:')))
})
test('BLOCKED accepted disposition can be handed to terminal without rewriting history', async t => {
  let workers = 0
  const h = await fixture(t, ({ role }) => role === 'worker' && ++workers === 1 ? answer({ outcome: 'BLOCKED', summary: 'Optional first approach unavailable; terminal has authorized alternative.' }) : null)
  h.runner.submit(hierarchicalProposal(true)); await next(h.runner); await next(h.runner)
  assert.equal(h.runner.graph.status().goalReached, true)
  assert.equal(h.runner.graph.read().supervision.outcomes[0].result.outcome, 'BLOCKED')
  assert.equal(h.runner.graph.status().nodes.find(node => node.key === 'a_work').status, 'INCOMPLETE')
})
test('terminal rework retains prior acceptance, opens a fresh attempt and does not rerun predecessors', async t => {
  let audits = 0
  const h = await fixture(t, ({ role, input }) => {
    if (role !== 'group_audit' || ++audits !== 1) return
    const row = input.reports.find(row => row.value.taskId === input.terminalLeaf.id)
    return answer({ action: 'REWORK', report: { version: 1, findings: [{ taskId: row.value.taskId, attemptId: row.value.attemptId,
      reasonCode: 'MISSING_REQUIRED_RESULT', criterion: 'Verify the full fixture.', problem: 'The result omits the required second verification.', correction: 'Add the missing verification.', evidence: [reference(row)] }] } })
  })
  h.runner.submit(hierarchicalProposal(true)); await next(h.runner); await next(h.runner)
  assert.equal(h.runner.graph.status().legalNext[0].label, 'a_end')
  assert.equal(h.runner.graph.read().reportArchive.length, 1)
  await next(h.runner)
  assert.equal(h.runner.graph.status().goalReached, true)
  assert.equal(h.calls.filter(row => row.role === 'worker').length, 3)
  const attempts = h.runner.graph.read().supervision.outcomes.filter(row => row.taskId === h.runner.graph.status().nodes.find(node => node.key === 'a_end').id)
  assert.equal(new Set(attempts.map(row => row.attemptId)).size, 2)
})
test('group pause requires independent audit and explicit resume, without automatic re-execution', async t => {
  let paused = false
  const h = await fixture(t, ({ role, input }) => {
    if (role === 'group_audit' && !paused) { paused = true; return answer(pause(input)) }
  })
  h.runner.submit(hierarchicalProposal(true)); await next(h.runner); await next(h.runner)
  assert.equal(h.runner.graph.read().supervision.hierarchy.stage, 'WAITING_USER')
  const count = h.calls.length, state = h.runner.graph.read()
  await h.runner.continueSupervision({ expectedRevision: state.revision, checkpointChecksum: state.checksum })
  assert.equal(h.calls.length, count)
  await h.runner.handleBlockage({ expectedRevision: state.revision, baseChecksum: state.checksum, resume: true })
  assert.equal(h.runner.graph.status().goalReached, true)
  assert.equal(h.calls.filter(row => row.role === 'worker').length, 2)
})
function revisedBinding(input) {
  const b = input.blueprint.value, task = b.nodes.find(node => node.key === 'a_end')
  return { action: 'REVISE', terminal: b.scope.terminal, nodes: b.nodes, edges: b.edges,
    contextGraph: { nodes: [], bindings: b.contextGraph.bindings.map(row => row.task === task.key ? { ...row, instruction: row.instruction + '; verify the newly observed condition.' } : row) },
    modifications: [{ path: '/contextGraph/bindings/a_end', reason: 'The accepted observation requires a targeted additional verification.', evidence: [reference(input.reports.find(row => row.value))] }] }
}
test('scoped update and independent audit preserve sibling contexts and completed work', async t => {
  let signalSent = false
  const h = await fixture(t, ({ role, input }) => {
    if (role === 'scope_plan' && !signalSent) { signalSent = true; return answer({ verdict: 'REVIEW_REQUIRED' }) }
    if (role === 'scope_update') return answer(revisedBinding(input))
  })
  h.runner.submit(hierarchicalProposal()); const old = h.runner.graph.read()
  await next(h.runner)
  const revised = h.runner.graph.read(), event = revised.graph.events.find(row => row.type === 'REVISED')
  assert.ok(event); assert.notEqual(event.data.review.updaterRunId, event.data.review.reviewerRunId)
  const bId = old.graph.state.plan.nodes.find(node => node.key === 'b_end').id
  assert.deepEqual(revised.contexts.bindings.find(row => row.taskId === bId), old.contexts.bindings.find(row => row.taskId === bId))
  assert.deepEqual(revised.contexts.nodes.find(row => row.key === 'b_private'), old.contexts.nodes.find(row => row.key === 'b_private'))
  assert.equal(h.calls.filter(row => row.role === 'worker').length, 1)
  await next(h.runner); await next(h.runner); assert.equal(h.runner.graph.status().goalReached, true)
})
test('program rejects cross-scope binding edits and unreported modifications with exact paths', async t => {
  const h = await fixture(t); h.runner.submit(hierarchicalProposal()); await next(h.runner)
  const state = h.runner.graph.read(), scope = state.graph.state.plan.nodes.find(node => node.key === 'a')
  const { input, catalog } = hierarchyContext(h.runner, state, scope.id), good = revisedBinding(input)
  const bad = structuredClone(good)
  bad.contextGraph.bindings.push({ task: 'b_end', instruction: 'pollution', contexts: [], inheritReports: [], tools: [], completion: { kind: 'report' } })
  assert.throws(() => prepareScopeProposal(h.runner, state, scope.id, bad, catalog), error => error.code === 'SCOPED_REVISION_BOUNDARY' && JSON.stringify(error).includes('/contextGraph/bindings/2/task'))
  good.modifications[0].path = '/contextGraph/bindings/other'
  assert.throws(() => prepareScopeProposal(h.runner, state, scope.id, good, catalog), { code: 'SCOPED_MODIFICATION_REPORT_INCOMPLETE' })
})
for (const boundary of ['before', 'after']) test(`group acceptance survives a ${boundary}-CAS interruption without replaying the audit`, async t => {
  const h = await fixture(t); h.runner.submit(hierarchicalProposal(true)); await next(h.runner)
  const original = h.runner.graph.reviewHierarchy.bind(h.runner.graph)
  let interrupted = false
  h.runner.graph.reviewHierarchy = args => {
    if (args.report && !interrupted) { interrupted = true; if (boundary === 'after') original(args); throw Error('Synthetic gate interruption') }
    return original(args)
  }
  await assert.rejects(next(h.runner), /Synthetic gate interruption/)
  h.runner.graph.reviewHierarchy = original
  const state = h.runner.graph.read()
  await h.runner.continueSupervision({ expectedRevision: state.revision, checkpointChecksum: state.checksum })
  assert.equal(h.runner.graph.status().goalReached, true)
  assert.equal(h.calls.filter(row => row.role === 'group_audit').length, 1)
  assert.equal(h.calls.filter(row => row.role === 'task_reporter').length, 1)
})
test('reporter transport failure retains accepted root and resumes only the same report request', async t => {
  let reports = 0
  const h = await fixture(t, ({ role }) => role === 'task_reporter' && ++reports === 1 ? { status: 503, body: 'Synthetic reporter outage' } : undefined)
  h.runner.submit(hierarchicalProposal(true)); await next(h.runner)
  await assert.rejects(next(h.runner))
  const state = h.runner.graph.read(), runId = state.supervision.roleRunId
  assert.equal(h.runner.graph.status().goalReached, true)
  assert.equal(state.supervision.finalReport, undefined)
  await assert.rejects(h.runner.continueSupervision({ expectedRevision: state.revision, checkpointChecksum: state.checksum }), { code: 'REVISION_UNKNOWN_ROLE_REQUIRES_RECONCILIATION' })
  h.runner.workflowControl = { recoverModel: true, beforeRequest() {} }
  await h.runner.continueSupervision({ expectedRevision: state.revision, checkpointChecksum: state.checksum })
  assert.equal(h.runner.graph.read().supervision.finalReport.runId, runId)
  assert.equal(h.calls.filter(row => row.role === 'worker').length, 2)
  assert.equal(h.calls.filter(row => row.role === 'group_audit').length, 1)
  assert.equal(reports, 2)
})
test('program and independent audit rejection return precise feedback to the same scoped update workflow', async t => {
  let trigger = false, updates = 0, audits = 0
  const h = await fixture(t, ({ role, input, payload }) => {
    if (role === 'scope_plan' && !trigger) { trigger = true; return answer({ verdict: 'REVIEW_REQUIRED' }) }
    if (role === 'scope_update') {
      updates++; const proposal = revisedBinding(input)
      if (updates === 1) proposal.modifications[0].path = '/contextGraph/bindings/wrong'
      if (updates === 2) assert.match(JSON.stringify(payload.messages), /SCOPED_MODIFICATION_REPORT_INCOMPLETE/)
      if (updates === 3) assert.match(input.priorReview, /Make the verification explicit/)
      return answer(proposal)
    }
    if (role === 'scope_audit' && ++audits === 1) return answer({ verdict: 'REJECT', reason: 'Make the verification explicit',
      issues: [{ path: '/changes/0/after', reason: 'Clarify the newly observed condition', expected: 'An explicit verification', observed: 'Generic condition' }] })
  })
  h.runner.submit(hierarchicalProposal()); await next(h.runner)
  assert.equal(updates, 3); assert.equal(audits, 2)
  assert.equal(h.runner.graph.read().graph.events.filter(row => row.type === 'REVISED').length, 1)
})
test('normal pause before a group request preserves the role and resumes without duplicate leaf requests', async t => {
  const h = await fixture(t); h.runner.submit(hierarchicalProposal(true)); await next(h.runner)
  let request = 0
  h.runner.workflowControl = { recoverModel: false, beforeRequest() {
    // beforeRequest is invoked at several pre-send boundaries. Pause by role
    // state, not by a guessed request counter.
    const state = h.runner.graph.read()
    if (state.supervision.phase === 'HIERARCHY' && ++request >= 1) { const error = Error('paused'); error.code = 'WORKFLOW_PAUSE_REQUESTED'; throw error }
  } }
  await assert.rejects(next(h.runner))
  const state = h.runner.graph.read(), runId = state.supervision.roleRunId
  assert.equal(readRoleRecord(h.runner, runId).phase, 'PAUSED')
  h.runner.workflowControl = { recoverModel: true, beforeRequest() {} }
  await h.runner.continueSupervision({ expectedRevision: state.revision, checkpointChecksum: state.checksum })
  assert.equal(h.calls.filter(row => row.role === 'worker').length, 2)
  assert.equal(h.calls.filter(row => row.role === 'group_audit').length, 1)
})
test('blocked runtime dispatches the handler at its actual layer and resumes after audited waiting', async t => {
  let workers = 0, handler = 0
  const h = await fixture(t, ({ role, input }) => {
    if (role === 'worker' && ++workers === 1) return answer({ outcome: 'BLOCKED', summary: 'Required input is missing.' })
    if (role === 'scope_blockage') { handler++; assert.equal(input.blueprint.value.scope.key, 'a'); assert.ok(!JSON.stringify(input).includes('B_PRIVATE_CONTENT')); return answer(pause(input)) }
  })
  const p = hierarchicalProposal(), end = p.taskGraph.nodes.find(node => node.key === 'a_end')
  p.taskGraph.nodes.push(leaf('a_middle','a')); p.taskGraph.edges = p.taskGraph.edges.filter(edge => edge.from !== 'a_work')
  p.taskGraph.edges.push({ kind:'prerequisite',from:'a_work',to:'a_middle' }, { kind:'prerequisite',from:'a_middle',to:'a_end' })
  p.contextGraph.bindings.push({ task:'a_middle',instruction:'Required intermediate work',contexts:['a_private'],inheritReports:['a_work'],tools:[],completion:{kind:'report'} })
  h.runner.submit(p); await next(h.runner)
  assert.equal(h.runner.graph.status().legalNext.length, 0)
  const state = h.runner.graph.read()
  const result = await h.runner.handleBlockage({ expectedRevision: state.revision, baseChecksum: state.checksum })
  assert.equal(result.status, 'WAITING_USER'); assert.equal(handler, 1)
})
test('configured group depth excludes leaves and recursive single wrappers use one terminal final audit', async t => {
  const h = await fixture(t, undefined, { hierarchy: { maxGroupDepth: 4 } })
  const p = hierarchicalProposal(true)
  p.taskGraph.hierarchy.maxGroupDepth = 4
  p.taskGraph.nodes = [group('root', null, 'a'), group('a','root','sub'), group('sub','a','deep'), group('deep','sub','a_end'), leaf('a_end','deep')]
  p.taskGraph.edges = []; p.contextGraph.bindings = [p.contextGraph.bindings.find(row => row.task === 'a_end')]; p.contextGraph.bindings[0].inheritReports = []
  h.runner.submit(p); await next(h.runner)
  assert.equal(h.calls.filter(row => row.role === 'group_audit').length, 1)
  assert.equal(h.calls.find(row => row.role === 'group_audit').input.aliasContracts.length, 3)
  assert.equal(h.runner.graph.status().goalReached, true)
})
test('read-only drilldown retrieves private traces without default-loading them or exposing sibling scopes', async t => {
  let read = false
  const h = await fixture(t, ({ role, input }) => {
    if (role === 'group_audit' && !read) {
      read = true
      assert.ok(!JSON.stringify(input).includes('B_PRIVATE_CONTENT'))
      const source = input.availableSources.find(row => row.kind === 'trace')
      return { tools: [{ name: 'dynamic_context_blockage_trace', arguments: { source: source.source, path: '/events', start: 0, end: 200 } }] }
    }
  })
  h.runner.submit(hierarchicalProposal(true)); await next(h.runner); await next(h.runner)
  const requests = h.calls.filter(row => row.role === 'group_audit')
  assert.equal(requests.length, 2)
  assert.ok(requests[1].payload.messages.some(row => row.role === 'tool' && row.content.includes('sourceSha256')))
})
test('group roles retain native compaction and source paging at the configured window', async t => {
  let summaries = 0
  const h = await fixture(t, ({ role, input }) => {
    if (role === 'compaction') { summaries++; return { text: 'Navigation only: large accepted fixture report; read exact source before relying on claims.' } }
  }, { maxContextCharacters: null, maxReportCharacters: null, revision: { policy, maxOutputTokens: 32768 },
    direct: { durable: true, compaction: { strategy: 'dsh-native', contextWindow: 262144 }, maxRequestBytes: null } })
  const p = hierarchicalProposal(true)
  p.planningReport.design = 'Long planning reference 0123456789. '.repeat(11000)
  h.runner.submit(p); await next(h.runner); await next(h.runner)
  assert.ok(summaries > 0); assert.equal(h.runner.graph.status().goalReached, true)
})
test('real orchestration loop reaches accepted root plus final report without an extra outer audit', async t => {
  const h = await fixture(t); h.runner.submit(hierarchicalProposal())
  const handle = await h.ctx.agents.create({ sessionId: 'hierarchy-controller', meta: { cwd: h.runner.config.projectRoot },
    agentOptions: { provider: 'dynamic-context-fake', model: 'fake-llama' } })
  t.after(() => handle.dispose())
  const agent = handle.agent
  const interaction = { ctx: h.ctx, exact() {}, mode: () => 'full', planOnly: () => false,
    entries: new Map([[agent, { runner: h.runner }]]) }
  const orchestrator = new WorkflowOrchestrator(interaction)
  let record = { phase: 'EXECUTING', afterPlanning: 'auto_start', executionStarted: true }
  orchestrator.record = () => record; orchestrator.save = async (_, value) => (record = { ...record, ...value })
  orchestrator.contractChecksum = () => 'fixture-contract'
  orchestrator.queued.add(agent)
  await orchestrator.drive(agent, new AbortController().signal)
  assert.equal(record.phase, 'COMPLETE', JSON.stringify(record))
  assert.equal(record.reason, 'ROOT_ACCEPTED_AND_REPORTED')
  assert.equal(h.calls.filter(row => row.role === 'task_reporter').length, 1)
})
test('report-scoped supervision keeps local acceptance and group-level defaults free of raw execution traces', async t => {
  const h = await fixture(t, ({ role }) => role === 'worker' ? answer({ outcome: 'COMPLETE', summary: 'Analyzed the supplied fixture facts.', executionReport: {
    workHistory: ['Read the supplied fixture facts.'], results: [{ criterion: 'Analyze authorized input', result: 'The supplied record is internally consistent.', artifactRefs: [], testIds: [] }],
    directories: [], tests: [], limitations: [],
  } }) : undefined, { supervisionContext: 'reports' })
  h.runner.submit(hierarchicalProposal(true)); await next(h.runner); await next(h.runner)
  const local = h.calls.find(row => row.role === 'result_check').input
  assert.ok(local.acceptanceEvidence); assert.equal(local.execution, undefined)
  const final = h.calls.find(row => row.role === 'group_audit').input
  assert.ok(final.reports.every(row => row.value.result.executionReport))
  assert.equal(final.execution, undefined); assert.equal(final.tools, undefined)
  assert.equal(h.runner.graph.status().goalReached, true)
})
test('parent escalation assembles the parent layer and keeps existing child private subtrees opaque', async t => {
  let triggered = false, escalated = false
  const h = await fixture(t, ({ role, input }) => {
    if (role === 'scope_plan' && !triggered) { triggered = true; return answer({ verdict: 'REVIEW_REQUIRED' }) }
    if (role === 'scope_update') {
      if (!escalated) { escalated = true; assert.equal(input.blueprint.value.scope.key, 'a'); return answer({ action: 'ESCALATE' }) }
      assert.equal(input.blueprint.value.scope.key, 'root')
      assert.ok(!JSON.stringify(input).includes('A_PRIVATE_CONTENT'))
      assert.ok(input.blueprint.value.nodes.every(node => node.retainSubtree))
      return answer({ action: 'NO_CHANGE', reason: 'Parent interfaces are sufficient; the existing child plan remains valid.' })
    }
  })
  h.runner.submit(hierarchicalProposal()); await next(h.runner)
  assert.equal(h.runner.graph.status().legalNext[0].label, 'a_end')
  assert.equal(h.calls.filter(row => row.role === 'scope_update').length, 2)
  assert.equal(h.runner.graph.read().graph.events.filter(row => row.type === 'REVISED').length, 0)
})
test('shared context used by a sibling cannot be rewritten by a local structural update', async t => {
  const h = await fixture(t); const p = hierarchicalProposal()
  p.contextGraph.bindings.find(row => row.task === 'b_end').contexts.push('a_private')
  h.runner.submit(p); await next(h.runner)
  const state = h.runner.graph.read(), scope = state.graph.state.plan.nodes.find(node => node.key === 'a')
  const { input, catalog } = hierarchyContext(h.runner, state, scope.id), proposal = revisedBinding(input)
  proposal.contextGraph.nodes.push({ key: 'a_private', content: 'Unexpected rewritten fact', parents: [] })
  assert.throws(() => prepareScopeProposal(h.runner, state, scope.id, proposal, catalog), error => error.code === 'SCOPED_REVISION_BOUNDARY' && JSON.stringify(error).includes('also bound outside'))
  assert.deepEqual(h.runner.graph.read(), state)
})
test('cross-scope context pollution is rejected both directly and through a new context parent', async t => {
  const h = await fixture(t); h.runner.submit(hierarchicalProposal()); await next(h.runner)
  const state = h.runner.graph.read(), scope = state.graph.state.plan.nodes.find(node => node.key === 'a')
  const { input, catalog } = hierarchyContext(h.runner, state, scope.id)
  assert.ok(!input.blueprint.value.contextReuseIndex.some(row => row.key === 'b_private'))
  for (const indirect of [false, true]) {
    const proposal = revisedBinding(input), binding = proposal.contextGraph.bindings.find(row => row.task === 'a_end')
    binding.contexts = [indirect ? 'local_alias' : 'b_private']
    if (indirect) proposal.contextGraph.nodes.push({ key: 'local_alias', content: 'Navigation', parents: ['b_private'] })
    assert.throws(() => prepareScopeProposal(h.runner, state, scope.id, proposal, catalog), error => error.code === 'SCOPED_REVISION_BOUNDARY'
      && JSON.stringify(error).includes('/contextGraph/bindings/1/contexts'))
  }
})

test('three group layers recurse through sibling subgroups with layer-local reports and one root final', async t => {
  const h = await fixture(t), p = hierarchicalProposal()
  p.taskGraph.nodes = [group('root',null,'b'),group('a','root','ay'),group('ax','a','x_end'),leaf('x_end','ax'),
    group('ay','a','y_end'),leaf('y_end','ay'),group('b','root','b_end'),leaf('b_end','b')]
  p.taskGraph.edges = [{kind:'prerequisite',from:'ax',to:'ay'},{kind:'prerequisite',from:'a',to:'b'}]
  p.contextGraph.bindings = p.taskGraph.nodes.filter(node => node.kind === 'leaf').map(node => ({task:node.key,instruction:'Verify the scoped result',
    contexts:[node.key === 'b_end' ? 'b_private' : 'a_private'],inheritReports:node.key === 'y_end' ? ['ax'] : node.key === 'b_end' ? ['a'] : [],tools:[],completion:{kind:'report'}}))
  h.runner.submit(p)
  for (let i=0;i<3;i++) await next(h.runner)
  assert.equal(h.runner.graph.status().goalReached,true)
  const finals = h.calls.filter(row => row.role === 'group_audit')
  assert.deepEqual(finals.map(row => row.input.blueprint.value.scope.key),['ax','ay','a','b','root'])
  for (const row of finals.filter(row => ['a','root'].includes(row.input.blueprint.value.scope.key)))
    assert.ok(row.input.reports.every(report => report.source.startsWith('group:')))
  assert.equal(h.calls.filter(row => row.role === 'task_reporter').length,1)
})

test('scoped update can replace future terminal work with a new subtree and preserve executed history', async t => {
  let triggered = false
  const h = await fixture(t, ({role,input}) => {
    if (role === 'scope_plan' && !triggered) { triggered = true; return answer({verdict:'REVIEW_REQUIRED'}) }
    if (role === 'scope_update') {
      const b = input.blueprint.value
      const paths = ['/taskGraph/nodes/a_end','/taskGraph/nodes/extra','/taskGraph/nodes/extra_end','/taskGraph/terminal',
        '/taskGraph/edges/a_work~a_end','/taskGraph/edges/a_work~extra','/contextGraph/bindings/a_end','/contextGraph/bindings/extra_end']
      return answer({action:'REVISE',terminal:'extra',nodes:[b.nodes.find(node=>node.key==='a_work'),group('extra','a','extra_end'),leaf('extra_end','extra')],
        edges:[{kind:'prerequisite',from:'a_work',to:'extra'}],contextGraph:{nodes:[],bindings:[b.contextGraph.bindings.find(row=>row.task==='a_work'),
          {...b.contextGraph.bindings.find(row=>row.task==='a_end'),task:'extra_end',inheritReports:[]}]},
        modifications:paths.map(path=>({path,reason:'An observed verification gap requires one additional isolated verification group.',evidence:[reference(input.reports.find(row=>row.value))]}))})
    }
  })
  h.runner.submit(hierarchicalProposal()); await next(h.runner)
  const before = h.runner.graph.read().supervision.outcomes[0]
  assert.equal(h.runner.graph.status().legalNext[0].label,'extra_end')
  await next(h.runner); await next(h.runner)
  assert.equal(h.runner.graph.status().goalReached,true)
  assert.deepEqual(h.runner.graph.read().supervision.outcomes[0],before)
  assert.deepEqual(h.calls.filter(row=>row.role==='group_audit').map(row=>row.input.blueprint.value.scope.key),['extra','a','b','root'])
})

test('parent-layer revision uses opaque group templates without exposing or editing private subtrees', async t => {
  let triggered = false
  const h = await fixture(t,({role,input})=>{
    if(role==='scope_plan' && input.blueprint.value.scope.key==='root' && !triggered) {triggered=true;return answer({verdict:'REVIEW_REQUIRED'})}
    if(role==='scope_update') return answer({action:'REVISE',terminal:input.blueprint.value.scope.terminal,
      nodes:input.blueprint.value.nodes.map(node=>node.key==='b'?{...node,label:'Publish verified delivery'}:node),edges:input.blueprint.value.edges,
      contextGraph:{nodes:[],bindings:[]},modifications:[{path:'/taskGraph/nodes/b',reason:'Clarify the public handoff using the accepted result.',evidence:[reference(input.reports.find(row=>row.value))]}]})
  })
  h.runner.submit(hierarchicalProposal()); const initial = h.runner.graph.read()
  await next(h.runner); await next(h.runner); await next(h.runner)
  const current = h.runner.graph.read()
  assert.equal(h.runner.graph.status().goalReached,true)
  assert.deepEqual(current.contexts,initial.contexts)
  assert.equal(h.calls.filter(row=>row.role==='scope_audit').length,1)
})

test('malformed scoped binding reports its exact missing field before semantic checks', async t => {
  const h = await fixture(t); h.runner.submit(hierarchicalProposal()); await next(h.runner)
  const state=h.runner.graph.read(),scope=state.graph.state.plan.nodes.find(node=>node.key==='a')
  const {input,catalog}=hierarchyContext(h.runner,state,scope.id),proposal=revisedBinding(input)
  delete proposal.contextGraph.bindings[1].contexts
  assert.throws(()=>prepareScopeProposal(h.runner,state,scope.id,proposal,catalog), error => error.diagnostic?.issues.some(issue=>issue.path==='/contextGraph/bindings/1/contexts'))
  assert.deepEqual(h.runner.graph.read(),state)
})

test('escalated audited pause resumes the original pending layer instead of a nonexistent parent gate', async t => {
  let triggered=false,escalated=false
  const h = await fixture(t,({role,input})=>{
    if(role==='scope_plan'&&!triggered) {triggered=true;return answer({verdict:'REVIEW_REQUIRED'})}
    if(role==='scope_update') {
      if(!escalated) {escalated=true;return answer({action:'ESCALATE'})}
      const state=h.runner.graph.read(),{catalog}=hierarchyContext(h.runner,state,input.scopeId)
      const source=input.availableSources.find(row=>row.kind==='report'),value=catalog.get(source.source).load()
      return answer(pause({reports:[{source:source.source,sha256:digest(value),value}]}))
    }
  })
  h.runner.submit(hierarchicalProposal());await next(h.runner)
  const state=h.runner.graph.read()
  assert.equal(state.supervision.hierarchy.stage,'WAITING_USER')
  assert.notEqual(state.supervision.hierarchy.scopeId,state.graph.state.hierarchy.pending.scopeId)
  const view=h.runner.graph.status()
  assert.equal(view.nodes.find(node=>node.id===view.focusScopeId).gate,'WAITING_USER')
  await h.runner.handleBlockage({expectedRevision:state.revision,baseChecksum:state.checksum,resume:true})
  assert.equal(h.runner.graph.status().legalNext[0].label,'a_end')
  assert.equal(h.calls.filter(row=>row.role==='worker').length,1)
})

for(const boundary of ['READY','HIERARCHY']) test(`resuming ${boundary} does not authorize a newly audited wait later in the same drive`, async t=>{
  const h=await fixture(t,({role,input})=>role==='group_audit'?answer(pause(input)):undefined)
  const handle=await h.ctx.agents.create({sessionId:'hierarchy-resume-'+boundary,meta:{cwd:h.runner.config.projectRoot},agentOptions:{provider:'dynamic-context-fake',model:'fake-llama'}})
  t.after(()=>handle.dispose())
  const agent=handle.agent,run=()=>h.runner.runNext({expectedRevision:h.runner.graph.read().revision,sourceAgent:agent})
  h.runner.submit(hierarchicalProposal(true));await run()
  if(boundary==='HIERARCHY') {
    h.runner.workflowControl={recoverModel:false,beforeRequest(){
      if(h.runner.graph.read().supervision.phase==='HIERARCHY') {const error=Error('pause');error.code='WORKFLOW_PAUSE_REQUESTED';throw error}
    }}
    await assert.rejects(run())
    assert.equal(h.runner.graph.read().supervision.phase,'HIERARCHY')
  }
  const interaction={ctx:h.ctx,exact(){},mode:()=> 'full',planOnly:()=>false,entries:new Map([[agent,{runner:h.runner}]])}
  const orchestrator=new WorkflowOrchestrator(interaction)
  let record={phase:'PAUSED',afterPlanning:'auto_start',executionStarted:true}
  orchestrator.record=()=>record;orchestrator.save=async(_,value)=>(record={...record,...value});orchestrator.contractChecksum=()=> 'fixture-contract'
  orchestrator.queued.add(agent);orchestrator.continuations.add(agent)
  await orchestrator.drive(agent,new AbortController().signal)
  assert.equal(record.phase,'PAUSED',JSON.stringify(record));assert.equal(record.reason,'SCOPE_REVIEWED_WAIT')
  assert.equal(h.runner.graph.read().supervision.hierarchy.stage,'WAITING_USER')
  assert.equal(h.calls.filter(row=>row.role==='group_audit').length,1)
  assert.equal(h.calls.filter(row=>row.role==='scope_pause').length,1)
})
