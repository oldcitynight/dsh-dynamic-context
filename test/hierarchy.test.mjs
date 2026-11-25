// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test'
import { withBlockageReports } from '../testing/blockage-reports.mjs'
import { diagnoseBlockage, diagnosticInput, checkGlobalDecision, checkRevisionProgress } from '../blockage-diagnosis.mjs'
import { blockageCatalog, blockageTools, sourceValue } from '../blockage-evidence.mjs'
import { documentOf, normalizePlan, revisionOutlook, reworkClosure } from 'dsh-better-task-grapth/core'
import { hierarchyFocus } from 'dsh-better-task-grapth/hierarchy'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { digest } from 'dsh-better-task-grapth/core'
import { createHarness } from '../testing/harness.mjs'
import { hierarchyContext, auditReportInput, prepareScopeProposal } from '../hierarchy-context.mjs'
import { advanceHierarchy, publishHierarchyReport } from '../hierarchy-runtime.mjs'
import { changedUnitBaselines, baselineAuditInput } from '../unit-roles.mjs'
import { readRoleRecord } from '../revision-runtime.mjs'
import { WorkflowOrchestrator } from '../orchestration.mjs'
import { guidanceActivation } from '../user-guidance.mjs'
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
  for (const [marker, role] of Object.entries({ UNIT_ROUTER: 'unit_router', BASELINE_AUDIT: 'baseline_audit', GROUP_FINAL: 'group_audit', SCOPE_PLAN: 'scope_plan', SCOPE_UPDATE: 'scope_update', SCOPE_AUDIT: 'scope_audit', TASK_REPORTER: 'task_reporter', SCOPED_BLOCKAGE: 'scope_blockage', BLOCKAGE_HANDLER: 'scope_blockage' }))
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
    if (role === 'unit_router') return answer({ action: 'EXECUTE', reason: 'The selected unit has a verified plan.' })
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
for (const groupVerdict of ['PASS','FAILED']) test('rule tools, independent blueprint audit and native group verdict '+groupVerdict, async t => {
  const h = await fixture(t, ({role, input, payload}) => {
    if (payload.messages[0].content.includes('RULE_BLUEPRINT_AUDIT_V1')) {
      assert.ok(input.proposal.taskGraph.nodes.find(n=>n.key==='a_end').rules.length)
      return answer({verdict:'APPROVE',reason:'The inspection must pass before the handoff.'})
    }
    if (role === 'worker') return answer({outcome:'PASS',summary:'Verified actual leaf result.'})
    if (role === 'group_audit' && input.blueprint.value.scope.key==='a' && groupVerdict==='FAILED') return answer({action:'FAILED',summary:'Group verification failed.',unmetCriterion:'The group acceptance check found no final delivery.',evidence:[reference(input.reports.at(-1))]})
    if (role === 'group_audit') return answer({...complete(input), action:'PASS', children:input.reports.map(row=>({
      nodeId:row.value.taskId, conclusion:row.value.result.outcome==='FAILED'?'ACCEPTED_LIMITATION':'SATISFIED', reason:'Verified the cited child receipt.', evidence:[reference(row)]
    }))})
  }, {exposeControlTools:true, storageFormat:'sqlite'})
  const controller=await h.ctx.agents.create({sessionId:'rule-owner',meta:{cwd:h.runner.config.projectRoot},
    agentOptions:{provider:'dynamic-context-fake',model:'fake-llama'}})
  t.after(()=>controller.dispose())
  let seq=0
  const call=(name,args)=>h.ctx.tools.get(name,controller.agent).execute(args,{
    agent:controller.agent,name,callId:'rules_'+ ++seq,signal:new AbortController().signal})
  const plan=hierarchicalProposal(true)
  plan.taskGraph.ruleVersion=1
  plan.taskGraph.edges=[]
  plan.taskGraph.nodes.push(leaf('outside','root'))
  plan.contextGraph.bindings.push({task:'outside',instruction:'Verify the independent result.',contexts:[],inheritReports:[],tools:[],completion:{kind:'report'}})
  const saved=await call('dynamic_context_set_rule_tree',{target:'a_end',expected_revision:0,
    rules:[{id:'work_passed',when:{node:'a_work',in:['PASS']}}]})
  assert.equal(saved.status,'confirmed')
  assert.match((await call('dynamic_context_read_rules',{target:'a_end',format:'mnemonic'})).mnemonic,/a_work 通过/)
  assert.throws(()=>h.runner.submit(plan),{code:'RULE_INDEPENDENT_AUDIT_REQUIRED'})
  const submitted=await call('dynamic_context_submit',{proposal:plan})
  assert.equal(submitted.revision,1)
  assert.match(submitted.ruleSummary.find(n=>n.target==='a_end').mnemonic,/a_work.*通过/)
  assert.equal((await call('dynamic_context_read_rules',{target:'a_end'})).status,'committed')
  assert.ok(h.runner.graph.read().ruleAudit.runId)
  assert.equal(h.calls.filter(c=>c.payload.messages[0].content.includes('RULE_BLUEPRINT_AUDIT_V1')).length,1)
  const future=structuredClone(plan)
  future.taskGraph.nodes.find(n=>n.key==='a_end').rules=[{id:'reviewed',when:{not:{node:'a_work',in:['FAILED']}}}]
  const candidate=h.runner.graph.prepareRevision({...future,invalidateReports:[]})
  assert.ok(candidate.effect)
  assert.equal(candidate.plan.ruleVersion,1)
  assert.ok(candidate.plan.nodes.find(n=>n.key==='a_end').rules[0].when.not)
  const invalid=structuredClone(future)
  invalid.taskGraph.nodes.find(node=>node.key==='a').terminal='a_work'
  assert.throws(()=>h.runner.graph.prepareRevision({...invalid,invalidateReports:[]}),{code:'TERMINAL_AS_PREDECESSOR'})
  const inherited=structuredClone(future)
  inherited.contextGraph.bindings.find(binding=>binding.task==='outside').inheritReports=['a']
  assert.throws(()=>h.runner.graph.prepareRevision({...inherited,invalidateReports:[]}),{code:'REPORT_SOURCE_MUST_BE_PREDECESSOR'})
  assert.equal(h.runner.graph.read().revision,submitted.revision)
  await assert.rejects(call('dynamic_context_set_rule_tree',{target:'a_end',expected_revision:1,rules:[]}),{code:'RULE_GRAPH_ALREADY_COMMITTED'})
  const status=h.runner.graph.status()
  assert.deepEqual(status.legalNext.map(row=>row.label),['outside'])
  const executor={role:'executor',taskId:status.nodes.find(node=>node.key==='a_work').id}
  const deferred=guidanceActivation(h.runner,executor)
  assert.equal(deferred.ready,false)
  assert.match(deferred.reason,/terminal unit yields/)
  await next(h.runner)
  assert.deepEqual(h.runner.graph.status().legalNext.map(row=>row.label),['a_work'])
  assert.equal(guidanceActivation(h.runner,executor).ready,true)
  await next(h.runner);await next(h.runner)
  const state=h.runner.graph.read()
  assert.deepEqual(state.supervision.outcomes.map(row=>row.result.outcome),['PASS','PASS','PASS'])
  assert.deepEqual(Object.values(state.graph.state.hierarchy.groups).map(row=>row.outcome),[groupVerdict,'PASS'])
  assert.equal(h.runner.graph.status().goalReached,true)
  assert.deepEqual(h.backend.errors,[])
})

test('an incompatible historical terminal points blockage handling to the group owning the reference', () => {
  const { taskGraph } = hierarchicalProposal(true)
  taskGraph.ruleVersion = 1
  taskGraph.edges = []
  taskGraph.nodes.find(node => node.key === 'a_end').rules = [{ id: 'checked', when: { node: 'a_work', in: ['PASS'] } }]
  const plan = normalizePlan(taskGraph)
  const scope = plan.nodes.find(node => node.key === 'a')
  scope.terminal = plan.nodes.find(node => node.key === 'a_work').id
  const created = { id: 'old_create', operationId: 'old_commit', seq: 1, type: 'CREATED', data: { plan }, previousHash: null }
  const graph = documentOf([{ ...created, hash: digest(created) }])
  const diagnosis = diagnoseBlockage({ graph })
  assert.equal(hierarchyFocus(graph.state), scope.id)
  assert.equal(revisionOutlook(graph.state).planIssue.code, 'TERMINAL_AS_PREDECESSOR')
  assert.deepEqual(diagnosis.situation.planIssue, revisionOutlook(graph.state).planIssue)
  assert.ok(diagnosis.eligibleScopeIds.includes(scope.id))
  assert.equal(diagnosis.situation.planIssue.target, 'a_end')
})

test('a returned native measurement can prove FAILED, drive BLOCK and reach a successful fallback with inherited evidence', async t=>{
  const h=await fixture(t,({role,input,payload})=>{
    if(payload.messages[0].content.includes('RULE_BLUEPRINT_AUDIT_V1')) return answer({verdict:'APPROVE',reason:'The measured failure routes to an explicit fallback.'})
    if(role==='worker') {
      if(payload.tools?.some(t=>t.function.name==='fixture_read_a')) {
        const read=payload.messages.findLast(m=>m.role==='tool' && m.content.includes('A_TOOL_PRIVATE_RAW'))
        if(!read) return {tools:[{name:'fixture_read_a',arguments:{}}]}
        return answer({outcome:'FAILED',summary:'A was observed; B is required.',artifacts:[],executionReport:{
          workHistory:['Measured the fixture once.'],results:[],directories:[],limitations:['The required value B was absent.'],
          tests:[{id:'value',criterion:'Fixture must be B',status:'FAIL',expected:'B_TOOL_PRIVATE_RAW',observed:'A_TOOL_PRIVATE_RAW',callId:read.tool_call_id,quote:'A_TOOL_PRIVATE_RAW'}]}})
      }
      assert.match(JSON.stringify(payload.messages),/A was observed/)
      return answer({outcome:'PASS',summary:'Handled the known fallback.',artifacts:[],executionReport:{
        workHistory:['Reviewed the failed measurement.'],results:[{criterion:'Handle fallback',result:'Measurement was recorded.',artifactRefs:[],testIds:[]}],directories:[],limitations:[],tests:[]}})
    }
    if(role==='group_audit') return answer({action:'PASS',summary:'Verified fallback and original measurement.',limitations:[],children:input.reports.map(row=>{
      if(row.value.outcome==='BLOCK') return {nodeId:row.value.nodeId,conclusion:'NOT_SELECTED',reason:'Original route closed.',evidence:[{source:row.source,sha256:row.sha256,path:'/outcome',quote:'BLOCK'}]}
      return {nodeId:row.value.taskId,conclusion:row.value.result.outcome==='FAILED'?'ACCEPTED_LIMITATION':'SATISFIED',reason:'Covered by the agreed fallback.',evidence:[reference(row)]}
    })})
  },{exposeControlTools:true,supervisionContext:'reports',storageFormat:'sqlite'})
  const owner=await h.ctx.agents.create({sessionId:'failed-route-owner',meta:{cwd:h.runner.config.projectRoot}})
  t.after(()=>owner.dispose())
  const plan=hierarchicalProposal(true)
  plan.taskGraph={title:'Handle a known fallback',hierarchy:{version:1,maxGroupDepth:3},ruleVersion:1,edges:[],nodes:[group('root',null,'recover'),leaf('measure','root'),leaf('preferred','root'),leaf('recover','root')]}
  plan.contextGraph={nodes:[],bindings:['measure','preferred','recover'].map(task=>({task,instruction:task==='measure'?'Measure the fixture; B is required.':'Report the disposition in this scope.',
    contexts:[],inheritReports:task==='recover'?['measure']:[],tools:task==='measure'?['fixture_read_a']:[],completion:{kind:'report'}}))}
  const call=(name,args)=>h.ctx.tools.get(name,owner.agent).execute(args,{agent:owner.agent,name,callId:'negative_'+name+'_'+(args.target??'plan'),signal:new AbortController().signal})
  await call('dynamic_context_set_rule_tree',{target:'preferred',expected_revision:0,rules:[{id:'success',when:{node:'measure',in:['PASS']}}]})
  await call('dynamic_context_set_rule_tree',{target:'recover',expected_revision:0,rules:[{id:'fallback',when:{not:{node:'preferred',in:['PASS']}}}]})
  await call('dynamic_context_submit',{proposal:plan})
  await next(h.runner)
  assert.equal(h.runner.graph.status().nodes.find(n=>n.key==='preferred').ruleState,'BLOCK')
  assert.deepEqual(h.runner.graph.status().legalNext.map(n=>n.label),['recover'])
  await next(h.runner)
  assert.equal(h.runner.graph.status().rootOutcome,'PASS')
  assert.deepEqual(h.runner.graph.read().supervision.outcomes.map(row=>row.result.outcome),['FAILED','PASS'])
  assert.deepEqual(h.backend.errors,[])
})

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
    const row = input.reports.find(row => row.value.taskId === input.terminalExecutionUnit.id)
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
    const row = input.reports.find(row => row.value.taskId === input.terminalExecutionUnit.id)
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
test('a scoped revision audits existing group acceptance and leaf instructions independently', () => {
  const state = { revision: 9, graph: { state: { plan: { nodes: [
    { id: 'group_a', key: 'a', kind: 'container' }, { id: 'work_a', key: 'work', kind: 'leaf' },
  ] } } } }
  const source = { observation: 'A second measurement is required.' }
  const ref = { source: 'report', sha256: digest(source), path: '/observation', quote: 'second measurement' }
  const changes = [
    { path: '/taskGraph/nodes/a', before: {key:'a',kind:'container',acceptance:'one result'}, after: {key:'a',kind:'container',acceptance:'two results'} },
    { path: '/contextGraph/bindings/work', before: {task:'work',instruction:'measure once'}, after: {task:'work',instruction:'measure twice'} },
    { path: '/taskGraph/nodes/later', before: null, after: {key:'later',kind:'leaf'} },
    { path: '/taskGraph/nodes/work', before: {key:'work',kind:'leaf',label:'original'}, after: {key:'work',kind:'leaf',label:'new label'} },
  ]
  const candidate = { changes, proposal: { modifications: changes.map(({path}) => ({ path, reason: 'Verify both results.', evidence:[ref] })) } }
  const catalog = new Map([[ref.source, { kind: 'report', load: () => source }]])
  const targets = changedUnitBaselines(state, 'root', candidate)
  assert.deepEqual(targets.map(({baseline}) => [baseline.unitId, baseline.field]), [['group_a','acceptance'],['work_a','instruction']])
  const inputs = targets.map(target => baselineAuditInput({ config:{revision:{policy}} }, state, 'root', target, catalog))
  assert.deepEqual(inputs.map(input => [input.scopeId, input.taskId]), [['group_a',undefined],['root','work_a']])
  for (const input of inputs) assert.equal(input.evidence[0].value, source.observation)
  assert.notEqual(changedUnitBaselines(state, 'another_scope', candidate)[0].hash, targets[0].hash)
})
test('unit routing, baseline rejection, independent approval and replanning use registered scoped roles before commit', async t => {
  const files = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-role-skill-'))
  t.after(() => fs.rmSync(files, { recursive: true, force: true }))
  fs.writeFileSync(path.join(files, 'SKILL.md'), '---\nname: unit-review\n---\nUNIT_SKILL_CONTEXT')
  const rolePolicyFile = path.join(files, 'roles.json')
  fs.writeFileSync(rolePolicyFile, JSON.stringify({ version: 1, skills: ['unit_router','baseline_audit'].map(role => ({
    role, slot: 'role', mode: 'append', file: 'SKILL.md',
  })) }))
  const decisions = [], auditTargets = []
  let firstRoute = true, firstReview = true
  const h = await fixture(t, ({ role, input, payload }) => {
    if (payload.messages[0].content.includes('RULE_BLUEPRINT_AUDIT_V1')) return answer({verdict:'APPROVE',reason:'The declared prerequisites cover the fixture.'})
    if (role === 'unit_router') {
      decisions.push(role)
      assert.match(payload.messages[0].content, /SCOPED_ROUTER_CONTEXT/)
      assert.match(payload.messages[0].content, /UNIT_SKILL_CONTEXT/)
      assert.ok(guidanceActivation(h.runner, {role, taskId:input.taskId}).ready)
      assert.ok(!guidanceActivation(h.runner, {role:'baseline_audit', taskId:input.taskId}).ready)
      assert.equal(payload.model, 'fake-llama')
      assert.equal(input.unit.label, 'a_work')
      assert.ok(!JSON.stringify(input).includes('B_PRIVATE_CONTENT'))
      assert.ok(firstRoute, 'the planner may release this unit without rerouting it')
      firstRoute = false
      return answer({ action: 'PLAN', reason: 'Review the current subdivision before execution.' })
    }
    if (role === 'worker') {
      assert.equal(h.runner.graph.read().supervision.routedUnit, undefined)
      return answer({outcome:'PASS',summary:'The first task produced a verified result.'})
    }
    if (role === 'scope_plan' && firstReview) {
      firstReview = false
      return answer({verdict:'REVIEW_REQUIRED'})
    }
    if (role === 'scope_update') {
      if (input.unitRoute) {
        decisions.push('route-plan')
        return answer({action:'NO_CHANGE',reason:'This unit can execute under the approved plan.'})
      }
      decisions.push(input.approvedBaselines ? 'replan' : 'propose')
      if (input.approvedBaselines) assert.equal(input.approvedBaselines[0].baseline.key, 'a_end')
      const proposed = revisedBinding(input)
      if (auditTargets.length) proposed.contextGraph.bindings.find(row => row.task === 'a_end').instruction += ' Record its actual value.'
      return answer(proposed)
    }
    if (role === 'baseline_audit') {
      decisions.push(role)
      assert.match(payload.messages[0].content, /SCOPED_BASELINE_CONTEXT/)
      assert.match(payload.messages[0].content, /UNIT_SKILL_CONTEXT/)
      assert.ok(guidanceActivation(h.runner, {role, taskId:input.taskId}).ready)
      assert.ok(!guidanceActivation(h.runner, {role, scopeId:input.scopeId}).ready)
      assert.equal(input.baseline.key, 'a_end')
      assert.ok(input.reason && input.evidence[0].value.includes(input.evidence[0].quote))
      assert.ok(!input.blueprint && !JSON.stringify(input).includes('B_PRIVATE_CONTENT'))
      assert.equal(h.runner.graph.read().contexts.bindings.find(row => row.taskId === input.taskId).instruction, input.baseline.before)
      const tools = payload.tools.map(row => row.function.name)
      assert.ok(tools.includes('dynamic_context_generate_report'))
      assert.ok(!tools.includes('dynamic_context_read_report') && !tools.includes('bash'))
      auditTargets.push(input.baseline.after)
      return auditTargets.length === 1
        ? answer({verdict:'REJECT',reason:'Specify how to record the measurement.',issues:[{path:'/baseline/after',reason:'Missing observation.',expected:'Recorded value.',observed:'Only verification.'}]})
        : answer({verdict:'APPROVE',reason:'The new instruction preserves the original goal and specifies the measurement.',issues:[]})
    }
    if (role === 'scope_audit') {
      decisions.push(role)
      assert.equal(input.approvedBaselines[0].baseline.after, auditTargets[1])
      return answer({verdict:'APPROVE',reason:'The plan implements the independently approved baseline.',issues:[]})
    }
  }, {exposeControlTools:true, storageFormat:'sqlite', rolePolicyFile})
  const owner = await h.ctx.agents.create({sessionId:'unit-role-owner',meta:{cwd:h.runner.config.projectRoot},agentOptions:{provider:'dynamic-context-fake',model:'fake-llama'}})
  t.after(() => owner.dispose())
  const plan = hierarchicalProposal(true)
  plan.taskGraph.ruleVersion = 1
  plan.taskGraph.edges = []
  await h.ctx.tools.get('dynamic_context_set_rule_tree',owner.agent).execute(
    {target:'a_end',expected_revision:0,rules:[{id:'first',when:{node:'a_work',in:['PASS']}}]},
    {agent:owner.agent,name:'dynamic_context_set_rule_tree',callId:'unit_rules',signal:new AbortController().signal})
  await h.ctx.tools.get('dynamic_context_submit',owner.agent).execute({proposal:plan}, {agent:owner.agent,name:'dynamic_context_submit',callId:'unit_submit',signal:new AbortController().signal})
  const state = h.runner.graph.read(), group = state.graph.state.plan.nodes.find(row => row.key === 'a').id
  const toolPolicies = h.ctx.get('dynamicContextRoleTools'), prompts = h.ctx.get('dynamicContextRolePrompts')
  for (const [role, label] of [['unit_router','SCOPED_ROUTER_CONTEXT'], ['baseline_audit','SCOPED_BASELINE_CONTEXT']]) {
    prompts.registerProvider({pluginId:'fixture',registrationId:role,role,mode:'append',scope:{scopeId:group},assemble:()=>label})
  }
  toolPolicies.register({pluginId:'fixture',registrationId:'deny-read-draft',role:'baseline_audit',scope:{scopeId:group},mode:'blacklist',toolIds:['dynamic_context_read_report']})
  assert.throws(() => h.runner.graph.begin({expectedRevision:state.revision,choice:0}), {code:'UNIT_ROUTE_REQUIRED'})
  h.runner.workflowControl = { beforeRequest() {
    if (h.runner.graph.read().supervision.hierarchy?.stage === 'UPDATE') {
      throw Object.assign(new Error('Pause before the first planning request.'), {code:'WORKFLOW_PAUSE_REQUESTED'})
    }
  } }
  await assert.rejects(next(h.runner), {code:'WORKFLOW_PAUSE_REQUESTED'})
  const paused = h.runner.graph.read()
  assert.equal(paused.supervision.outcomes.length, 0)
  assert.deepEqual(decisions, ['unit_router'])
  const boundary = {expectedRevision:paused.revision,checkpointChecksum:paused.checksum}
  h.runner.workflowControl = { recoverModel:true, beforeRequest() {} }
  await assert.rejects(h.runner.continueSupervision({...boundary,sourceAgent:owner.agent}), {code:'SUPERVISION_AUTHORITY_CHANGED'})
  assert.equal((await h.runner.continueSupervision(boundary)).status, 'UNIT_READY')
  assert.equal(h.runner.graph.read().supervision.routedUnit.authorityHash, paused.supervision.hierarchy.routeAuthority)
  await next(h.runner)
  assert.deepEqual(decisions, ['unit_router','route-plan','propose','baseline_audit','propose','baseline_audit','replan','scope_audit'])
  const final = h.runner.graph.read(), receipt = final.graph.events.find(e => e.type === 'REVISED').data.review.scopeSignal.baselineReviews
  assert.equal(receipt.length,1)
  const approved = readRoleRecord(h.runner, receipt[0].runId)
  assert.equal(approved.phase, 'COMPLETE')
  assert.equal(approved.role, 'baseline_audit')
  assert.equal(JSON.parse(approved.payload.messages[1].content).baselineHash, receipt[0].hash)
  assert.equal(final.contexts.bindings.find(row => row.taskId === receipt[0].unitId).instruction,auditTargets[1])
  assert.notEqual(auditTargets[0],auditTargets[1])
  assert.deepEqual(h.backend.errors,[])
})
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
function blockedGroups() {
  const p = hierarchicalProposal()
  p.taskGraph.nodes.push(leaf('a_middle','a'))
  p.taskGraph.edges = p.taskGraph.edges.filter(edge => edge.from !== 'a_work')
  p.taskGraph.edges.push({ kind:'prerequisite',from:'a_work',to:'a_middle' }, { kind:'prerequisite',from:'a_middle',to:'a_end' })
  p.contextGraph.bindings.push({ task:'a_middle',instruction:'Required intermediate work',contexts:['a_private'],inheritReports:['a_work'],tools:[],completion:{kind:'report'} })
  return p
}
test('blocked runtime dispatches the handler at its actual layer and resumes after audited waiting', async t => {
  let workers = 0, handler = 0
  const h = await fixture(t, ({ role, input, payload }) => {
    if (role === 'worker' && ++workers === 1) return answer({ outcome: 'BLOCKED', summary: 'Required input is missing.' })
    if (role === 'scope_blockage') return withBlockageReports(payload, reports => {
      handler++
      const upstream = input.situation.groups.find(group => group.key === 'a')
      assert.equal(input.scopeId, input.situation.rootScopeId)
      assert.deepEqual(input.situation.groups.find(group => group.key === 'b').waitingOn, [upstream.scopeId])
      assert.equal(input.blueprint, undefined); assert.ok(!JSON.stringify(input).includes('B_PRIVATE_CONTENT'))
      return answer({ ...pause({ reports }), scopeId: upstream.scopeId })
    })
  })
  h.runner.submit(blockedGroups()); await next(h.runner)
  assert.equal(h.runner.graph.status().legalNext.length, 0)
  const state = h.runner.graph.read()
  const result = await h.runner.handleBlockage({ expectedRevision: state.revision, baseChecksum: state.checksum })
  assert.equal(result.status, 'WAITING_USER'); assert.equal(handler, 1)
})
test('global investigator reads root, group, plan decisions and private traces; effective repair is submitted and independently committed', async t => {
  const reason = 'The required middle leaf waits on an unsatisfied inspection. The source group needs an independent verification path.'
  let steps = 0, updates = 0, audits = 0
  const ask = (name, args) => ({ tools: [{ name, arguments: args }] })
  const h = await fixture(t, ({ role, input, payload }) => {
    if (role === 'worker') return answer({ outcome:'BLOCKED', summary:'Inspection was incomplete.' })
    if (role === 'scope_blockage') {
      const source = input.situation.groups.find(row => row.key === 'a'), downstream = input.situation.groups.find(row => row.key === 'b')
      const raw = payload.messages.at(-1).content
      assert.equal(input.situation.code, 'NO_READY_LEAF')
      assert.deepEqual(downstream.waitingOn, [source.scopeId])
      switch (steps++) {
        case 0:
          assert.doesNotMatch(payload.messages[1].content, /Inspection was incomplete|_PRIVATE_CONTENT/)
          return ask('dynamic_context_blockage_topology', {})
        case 1:
          assert.equal(JSON.parse(JSON.parse(raw).text).scope.key, 'root')
          return ask('dynamic_context_blockage_topology', { scopeId: source.scopeId })
        case 2: {
          const group = JSON.parse(JSON.parse(raw).text)
          assert.equal(group.children.find(row => row.key === 'a_middle').unmetPrerequisites[0], source.blockers[0].taskId)
          return ask('dynamic_context_blockage_history', { role: 'scope_plan' })
        }
        case 3: return ask('dynamic_context_blockage_history', { source: JSON.parse(raw).sources[0].source, path:'/decision' })
        case 4:
          assert.equal(JSON.parse(raw).text, 'CURRENT')
          return ask('dynamic_context_blockage_trace', { source:'trace:' + source.blockers[0].attemptId + ':0', path:'/assembly/task' })
        case 5:
          assert.equal(JSON.parse(JSON.parse(raw).text).key, 'a_work')
          return ask('dynamic_context_generate_report', { report: { action:'REPLAN', scopeId:downstream.scopeId, reason } })
        case 6:
          assert.match(raw,/BLOCKAGE_TARGET_SCOPE_INVALID/)
          return ask('dynamic_context_generate_report', { report: { action:'REPLAN', scopeId:source.scopeId, reason } })
        default: throw Error('Unexpected repeated investigation')
      }
    }
    if (role === 'scope_update') {
      assert.equal(input.blockageSignal.reason, reason)
      assert.equal(input.revisionGuard.unchanged.status,'NO_READY_LEAF')
      assert.equal(input.blueprint.value.scope.key, 'a')
      assert.ok(!payload.tools.some(row => row.function.name === 'dynamic_context_blockage_history'))
      const submit = report => ask('dynamic_context_generate_report', { report })
      ++updates
      if (updates === 1) return submit({action:'NO_CHANGE',reason:'The existing graph should suffice.'})
      if (updates === 2) {
        assert.match(payload.messages.at(-1).content,/BLUEPRINT_UNCHANGED_WOULD_BLOCK/)
        return submit(revisedBinding(input))
      }
      assert.equal(updates, 3); assert.match(payload.messages.at(-1).content,/BLUEPRINT_REVISION_STILL_BLOCKED/)
      const b = input.blueprint.value
      const edges = b.edges.map(edge => edge.from === 'a_work' ? { ...edge, to:'a_end' } : edge)
      const bindings = b.contextGraph.bindings.map(row => row.task === 'a_work' ? row : { ...row, inheritReports:[] })
      return submit({ action:'REVISE', terminal:b.scope.terminal, nodes:b.nodes, edges,
        contextGraph:{nodes:[], bindings}, modifications:['/taskGraph/edges/a_work~a_middle','/taskGraph/edges/a_work~a_end',
          '/contextGraph/bindings/a_middle','/contextGraph/bindings/a_end'].map(path => ({ path, reason, evidence:[reference(input.reports.find(row=>row.value))] })) })
    }
    if (role === 'scope_audit') {
      audits++
      assert.equal(input.modificationReport.length, 4); assert.equal(input.changes.length, 4)
      assert.equal(input.blockageSignal.reason, reason)
    }
  })
  h.runner.submit(blockedGroups()); await next(h.runner)
  const before = h.runner.graph.read(), snapshot = diagnoseBlockage(before)
  const reversed = structuredClone(before); reversed.graph.state.plan.nodes.reverse()
  assert.deepEqual(diagnoseBlockage(reversed).situation, snapshot.situation)
  await h.runner.handleBlockage({ expectedRevision:before.revision, baseChecksum:before.checksum })
  const after = h.runner.graph.read(), event = after.graph.events.at(-1)
  assert.equal(event.type,'REVISED'); assert.equal(event.data.review.scopeSignal.reason,reason)
  assert.equal(h.runner.graph.status().legalNext[0].label,'a_middle'); assert.equal(audits,1)
  assert.deepEqual(after.supervision.outcomes,before.supervision.outcomes)
  const source = 'history:' + event.data.review.updaterRunId
  const history = blockageTools(blockageCatalog(h.runner, after, undefined, snapshot), path.join(h.root,'inspect-history'))
  const read = args => history.execute({id:'historical',function:{name:'dynamic_context_blockage_history',arguments:JSON.stringify(args)}})
  assert.equal(Number(read({source,path:'/graphCommitRevision'}).text), event.seq)
  assert.equal(JSON.parse(read({source,path:'/record/modifications'}).text).length,4)
  const alternative = structuredClone(after)
  alternative.graph.events[before.revision-1].hash='0'.repeat(64)
  const otherCatalog = blockageCatalog(h.runner, alternative, undefined, snapshot)
  assert.throws(()=>otherCatalog.get(source).load(), { code:'BLOCKAGE_HISTORY_OUTSIDE_CHECKPOINT' })
  assert.equal(read({source:'history:../../outside'}).error,'BLOCKAGE_SOURCE_SCOPE_MISMATCH')
  assert.deepEqual(h.backend.errors,[])
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
test('historical predecessor in another group can be inspected and reopened only with a causal claim at the common ancestor', async t => {
  let workers = 0
  const h = await fixture(t, ({ role, payload, input }) => {
    if (role === 'worker') return answer(++workers === 1 ? { outcome:'COMPLETE',summary:'Only one of two checks was performed.' }
      : {outcome:'BLOCKED',summary:'Required independent check is absent.'})
    if (role !== 'scope_blockage') return
    const warm = input.situation.groups.find(row => row.key === 'warm')
    assert.equal(warm, undefined, 'finished groups are absent from the initial blocker list')
    const received = payload.messages.filter(row=>row.role==='tool').map(row=>JSON.parse(row.content))
    const ask = (name,args) => ({tools:[{name,arguments:args}]})
    const topology = received.find(row=>row.source?.startsWith('topology:'))
    if (!topology) return ask('dynamic_context_blockage_topology',{scopeId:'warm'})
    const target = JSON.parse(topology.text).children[0]
    if (!received.some(row=>row.source?.startsWith('trace:'))) return ask('dynamic_context_blockage_trace',{source:'trace:'+target.attemptId+':0',path:'/assembly/task/key'})
    assert.equal(received.find(row=>row.source?.startsWith('trace:')).text,'warm_end')
    const page = received.find(row=>row.source?.startsWith('report:'))
    if (!page) return ask('dynamic_context_blockage_report',{source:'report:'+target.attemptId,path:'/result/summary'})
    return answer({action:'REWORK',scopeId:input.scopeId,report:{version:1,findings:[{taskId:target.id,attemptId:target.attemptId,
      reasonCode:'MISSING_REQUIRED_RESULT',criterion:'Verify both required checks.',problem:'The accepted result verifies only one of two checks.',
      correction:'Perform the omitted independent check.',evidence:[{source:page.source,sha256:page.sourceSha256,path:page.path,quote:page.text}]}]}})
  })
  const p = blockedGroups()
  p.taskGraph.nodes.push(group('warm','root','warm_end'),leaf('warm_end','warm'))
  p.taskGraph.edges.push({kind:'prerequisite',from:'warm',to:'a'})
  p.contextGraph.bindings.push({task:'warm_end',instruction:'Verify both checks.',contexts:['a_private'],inheritReports:[],tools:[],completion:{kind:'report'}})
  h.runner.submit(p); await next(h.runner); await next(h.runner)
  const before = h.runner.graph.read(), d = diagnoseBlockage(before), catalog = blockageCatalog(h.runner,before,undefined,d)
  const warm = before.graph.state.plan.nodes.find(node=>node.key==='warm')
  const cold = structuredClone(before), bad = cold.supervision.outcomes[0].evidence[0]; bad.sha256='0'.repeat(64)
  const coldTools = blockageTools(blockageCatalog(h.runner,cold,undefined,diagnoseBlockage(cold)),path.join(h.root,'cold-global'))
  const call = (name, args) => coldTools.execute({id:'cold',function:{name,arguments:JSON.stringify(args)}})
  assert.equal(JSON.parse(call('dynamic_context_blockage_topology',{}).text).scope.key,'root')
  const planned = call('dynamic_context_blockage_topology',{scopeId:'b',view:'context',path:'/contextGraph/bindings'})
  assert.equal(JSON.parse(planned.text)[0].task,'b_end');assert.ok(!planned.text.includes('a_private'))
  assert.ok(call('dynamic_context_blockage_trace',{source:'trace:'+cold.supervision.outcomes[0].attemptId+':0'}).error)
  const result = await h.runner.handleBlockage({expectedRevision:before.revision,baseChecksum:before.checksum})
  assert.equal(result.status,'REWORKED')
  const after = h.runner.graph.read(), reopened = after.graph.events.at(-1)
  assert.equal(reopened.type,'REOPENED'); assert.equal(reopened.data.attempts.length,2)
  assert.deepEqual(after.supervision.outcomes,before.supervision.outcomes)
  const record = h.calls.filter(row=>row.role==='scope_blockage').at(-1)
  assert.ok(!JSON.stringify(record.input).includes('Only one of two checks'))
  const row = sourceValue(catalog,'report:'+before.supervision.outcomes[0].attemptId)
  const badScope = {action:'REWORK',scopeId:warm.id,report:{version:1,findings:[{taskId:row.value.taskId,attemptId:row.value.attemptId,
    reasonCode:'MISSING_REQUIRED_RESULT',criterion:'Verify both checks',problem:'Only one was verified',correction:'Verify the other',
    evidence:[reference(row)]}]}}
  assert.throws(()=>checkGlobalDecision(badScope,{state:before,diagnosis:d,catalog}),{code:'BLOCKAGE_TARGET_SCOPE_INVALID'})
  assert.deepEqual(h.backend.errors,[])
})
test('root escalation returns to global investigation with prior decisions visible; a settled terminal has a legal next step', async t => {
  let roots = 0, auditRequests = 0
  const issue = 'The prerequisite depends on an externally licensed source.'
  const h = await fixture(t, ({role,input,payload})=>{
    if (role==='worker') return answer({outcome:'BLOCKED',summary:'The source requires a license outside the workspace.'})
    if (role==='scope_blockage') {
      const group = input.situation.groups.find(g=>g.key==='a')
      if (!input.reviewedScopeIds) return answer({action:'REPLAN',scopeId:group.scopeId,reason:issue})
      assert.deepEqual(new Set(input.reviewedScopeIds),new Set([group.scopeId,input.scopeId]))
      assert.equal(input.situation.referral.reason,issue)
      return withBlockageReports(payload,reports=>answer({...pause({reports}),scopeId:input.scopeId}))
    }
    if (role==='scope_update') {
      assert.equal(input.blockageSignal.reason,issue)
      if(input.scopeId===input.blockageSignal.scopeId) assert.equal(input.blueprint.value.scope.key,'a')
      else {roots++; assert.equal(input.blueprint.value.scope.key,'root')}
      return answer({action:'ESCALATE',reason:issue})
    }
    if (role==='scope_pause') auditRequests++
  })
  h.runner.submit(blockedGroups()); await next(h.runner)
  let s=h.runner.graph.read()
  const saved=diagnosticInput(s,diagnoseBlockage(s))
  assert.deepEqual(saved.situation.groups.find(g=>g.key==='a').blockers.map(b=>b.reportedOutcome),['BLOCKED'])
  assert.equal((await h.runner.handleBlockage({expectedRevision:s.revision,baseChecksum:s.checksum})).status,'WAITING_USER')
  s=h.runner.graph.read()
  assert.equal(roots,1);assert.equal(auditRequests,1);assert.equal(s.supervision.hierarchy.stage,'WAITING_USER')
  const g=structuredClone(s.graph.state), id=key=>g.plan.nodes.find(n=>n.key===key).id
  const refused=g.plan.edges.find(e=>e.from===id('a_work'));refused.to=id('a_end')
  assert.equal(revisionOutlook(g).status,'READY')
  assert.ok(!diagnoseBlockage({...s,graph:{...s.graph,state:g}}).causes.includes(id('a_work')))
  assert.throws(()=>checkRevisionProgress(revisionOutlook(g),'REVISE','/modifications',g,s.graph.state.plan),{code:'BLUEPRINT_REVISION_INTRODUCES_BLOCK'})
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
  }, { dynamicContextMaxBytes: 8388608, maxContextCharacters: null, maxReportCharacters: null, revision: { policy, maxOutputTokens: 32768 },
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
      if (!escalated) { escalated = true; assert.equal(input.blueprint.value.scope.key, 'a'); return answer({ action: 'ESCALATE', reason: 'The contract concerns the parent interface.' }) }
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
  const h = await fixture(t,({role,input,payload})=>{
    if(role==='scope_plan'&&!triggered) {triggered=true;return answer({verdict:'REVIEW_REQUIRED'})}
    if(role==='scope_update') return answer({action:'ESCALATE',reason:'The missing authorization is outside this layer.'})
    if(role==='scope_blockage') return withBlockageReports(payload, reports => {
      escalated = true
      assert.equal(input.situation.code, 'ROOT_UPDATE_ESCALATED')
      assert.equal(input.situation.outlookAfterReview.status, 'READY')
      return answer({ ...pause({ reports }), scopeId: input.scopeId })
    }, { all: true })
  })
  h.runner.submit(hierarchicalProposal());await next(h.runner)
  const state=h.runner.graph.read()
  assert.equal(state.supervision.hierarchy.stage,'WAITING_USER')
  assert.ok(escalated); assert.notEqual(state.supervision.hierarchy.scopeId,state.graph.state.hierarchy.pending.scopeId)
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

test('group/root report projection indexes large and aggregate inputs while preserving the original evidence and scoped paging', async t => {
  const { sourceValue, blockageTools } = await import('../blockage-evidence.mjs')
  const { BLOCKAGE_TOOLS, lookupPointer, verifyReference } = await import('../blockage-protocol.mjs')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hierarchy-report-index-'))
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))
  const catalog = new Map()
  function add(id, result) {
    const source = (result.audit ? 'group:' : 'report:') + id
    catalog.set(source, { kind: 'report', taskId: id, load: () => ({ taskId: id, result }) })
    return sourceValue(catalog, source)
  }
  const long = 'abcdefgh😊'.repeat(4000), marker = 'evidence-only-sentinel'
  const report = add('leaf', { outcome: 'COMPLETE', executionReport: { verification: [{ id: 'v1', observed: long + marker }],
    limitations: [], delivery: { items: [{ path: 'file', details: long }] }, 'a/b~c': [marker] } })
  const group = add('child', { audit: { action: 'COMPLETE', children: [{ nodeId: 'child-terminal', detail: long }], limitations: [long] }, verification: [long], deliveries: [] })
  const small = add('small', { outcome: 'BLOCKED', summary: 'Known limitation' }), missing = { taskId: 'missing', report: null }
  const original = { reports: [group, small, missing, report], publicEvidence: [
    { source: report.source, taskId: 'leaf', verification: report.value.result.executionReport.verification },
    { source: group.source, taskId: 'child', limitations: [long] }], currentSharedFacts: [marker], auditMandate: { level: 'graph' } }
  const snapshot = structuredClone(original), out = auditReportInput(original)
  assert.deepEqual(original, snapshot)
  assert.strictEqual(out.currentSharedFacts, original.currentSharedFacts)
  assert.strictEqual(out.auditMandate, original.auditMandate)
  assert.strictEqual(out.reports[1], small); assert.strictEqual(out.reports[2], missing)
  assert.deepEqual(out.reports.map(r => r.source), original.reports.map(r => r.source))
  assert.equal(JSON.stringify(out).includes(long.slice(0, 1000)), false)
  assert.equal(out.reportAccess.tool, BLOCKAGE_TOOLS.report)
  assert.equal(out.publicEvidence[0].paths.deliveries, '/result/executionReport/delivery/items')
  assert.equal(out.publicEvidence[1].paths.limitations, '/result/audit/limitations')
  const reader = blockageTools(catalog, tmp)
  let seq = 0
  const get = args => reader.execute({ id: 'page_' + ++seq, function: { name: out.reportAccess.tool, arguments: JSON.stringify(args) } })
  for (const [i, raw] of [[0, group], [3, report]]) {
    assert.equal(out.reports[i].sha256, raw.sha256)
    for (const section of out.reports[i].sections) assert.notEqual(lookupPointer(raw.value, section.path), undefined)
  }
  const pointer = '/result/executionReport/verification/0/observed'
  const first = get({ source: report.source, path: pointer, start: 0, end: 9 })
  assert.equal(first.end, 8)
  const second = get({ source: report.source, path: pointer, start: first.next, end: 25 })
  assert.equal(first.text + second.text, (long + marker).slice(0, 25))
  assert.equal(second.sourceSha256, report.sha256)
  assert.ok(out.reports[3].sections.some(s => s.path === '/result/executionReport/a~1b~0c'))
  assert.equal(get({ source: 'report:outside', path: '' }).error, 'BLOCKAGE_SOURCE_SCOPE_MISMATCH')
  const ref = { source: report.source, sha256: report.sha256, path: pointer, quote: second.text }
  assert.equal(verifyReference(ref, catalog, '/evidence').taskId, 'leaf')
  const short = { reports: [small, missing] }
  assert.strictEqual(auditReportInput(short), short)
  const medium = Array.from({ length: 7 }, (_, i) => add('mid' + i, { summary: 'x'.repeat(11000 + i) }))
  const limited = auditReportInput({ reports: medium })
  assert.deepEqual(limited.reports.map(r => !!r.sections), [false, false, false, false, false, true, true])
  assert.deepEqual(auditReportInput({ reports: medium }), limited)
})

for (const outcome of ['COMPLETE', 'BLOCKED']) test('fake direct executor follows the audited group '+outcome+' branch through the OR join', async t => {
  const h = await fixture(t, ({role,input}) => {
    if (role !== 'group_audit') return
    const key=input.blueprint.value.scope.key
    if (key==='a' && outcome==='BLOCKED') return answer({action:'BLOCKED',summary:'Published artifact misses a current requirement.',
      unmetCriterion:'Delivery must include the current audio.',scopeBoundary:'Verification can inspect but cannot produce the missing track.',evidence:[reference(input.reports.at(-1))]})
    if (key==='root' && outcome==='COMPLETE') {
      const approved=complete({...input,reports:input.reports.filter(row=>!row.source.startsWith('route:'))})
      const bypassed=input.reports.find(row=>row.source.startsWith('route:'));assert.ok(bypassed)
      approved.children.push({nodeId:bypassed.value.nodeId,conclusion:'NOT_SELECTED',reason:'The first group passed.',
        evidence:[{source:bypassed.source,sha256:bypassed.sha256,path:'/outcome',quote:'NOT_SELECTED'}]})
      return answer(approved)
    }
  })
  const proposal=hierarchicalProposal();proposal.taskGraph.nodes[0].terminal='final';proposal.taskGraph.nodes.push(leaf('final','root'))
  const route=(from,outcome,to)=>({kind:'route',from,outcome,to})
  proposal.taskGraph.edges=[proposal.taskGraph.edges[0],route('a','blocked','b'),route('a','complete','final'),route('b','complete','final')]
  proposal.contextGraph.bindings.push({task:'final',instruction:'Verify the selected final delivery.',contexts:[],inheritReports:['a','b'],tools:[],completion:{kind:'report'}})
  h.runner.submit(proposal)
  const leaves=[];const inputs=[]
  while(!h.runner.graph.status().goalReached && leaves.length<4){
    const state=h.runner.graph.read(),legal=h.runner.graph.status().legalNext
    assert.equal(legal.length,1);leaves.push(legal[0].label)
    if(legal[0].label==='final')inputs.push(...h.runner.graph.checkInputs(state,legal[0].id).map(row=>row.acceptance))
    await next(h.runner)
  }
  assert.deepEqual(leaves,outcome==='COMPLETE'?['a_work','a_end','final']:['a_work','a_end','b_end','final'])
  assert.deepEqual(inputs,outcome==='COMPLETE'?['GROUP_FINAL_ACCEPTED']:['GROUP_BLOCKED_DISPOSITION','GROUP_FINAL_ACCEPTED'])
  assert.equal(h.runner.graph.status().goalReached,true);assert.deepEqual(h.backend.errors,[])
})

import { unitSeed, enterPlan } from '../testing/unit-proposal.mjs'
import { prepareRuleSubmission } from '../rule-audit.mjs'
for (const depth of [0, 2]) test('unit workflow v2 routes and independently closes every level, depth ' + depth, async t => {
  const h = await fixture(t, ({role, input, payload}) => {
    if (payload.messages[0].content.includes('RULE_BLUEPRINT_AUDIT_V1')) return answer({ verdict: 'APPROVE', reason: 'The root captures the goal.' })
    if (role === 'unit_router') return answer({ action: depth && input.unit.key !== 'finish' ? 'PLAN' : 'EXECUTE', reason: input.unit.baseline.objective })
    if (role === 'scope_update') return answer(enterPlan(input, [input.blueprint.value.scope.key === 'root' ? 'middle' : 'finish']))
    if (role === 'worker') return answer({outcome:'PASS',summary:'Verified actual result.'})
    if (role === 'group_audit') {
      assert.equal(input.completionRequest.proposedOutcome, 'PASS')
      return answer({...complete(input),action:'PASS'})
    }
  }, { storageFormat:'sqlite' })
  const runner = h.runner
  runner.submit(await prepareRuleSubmission(runner, unitSeed(), undefined, new AbortController().signal))
  const rootId = runner.graph.read().graph.state.plan.nodes[0].id
  const fact = runner.graph.read().contexts.nodes[0].id
  const message = { id: 'correction_one', source: {kind:'user'}, content:[{type:'text',text:'Set the fact to corrected value.'}] }
  const change = { scopeId: rootId, id: fact, expectedRevision:1, content:'corrected value' }
  runner.graph.applyUserFact(change, message, 'guidance_first')
  runner.graph.applyUserFact(change, message, 'guidance_first')
  assert.throws(() => runner.graph.applyUserFact(change, message, 'guidance_stale'), { code:'USER_FACT_REVISION_STALE' })
  for (let i=0; i<=depth; i++) await next(runner)
  const state = runner.graph.read()
  assert.equal(state.graph.state.plan.nodes[0].id, rootId)
  if (depth) assert.deepEqual(reworkClosure(state.graph.state, [rootId]), [state.graph.state.plan.nodes.find(node => node.key === 'finish').id])
  assert.equal(state.contexts.bindings.length, depth+1)
  assert.equal(state.graph.state.plan.nodes.length, depth+1)
  assert.deepEqual(h.calls.filter(row=>row.role==='unit_router').map(row=>row.input.unit.key), depth ? ['root','middle','finish'] : ['root'])
  assert.equal(h.calls.filter(row=>row.role==='scope_audit').length, depth)
  assert.equal(h.calls.filter(row=>row.role==='group_audit').length, depth)
  assert.equal(h.calls.filter(row=>row.role==='result_check').length, 1)
  assert.equal(h.calls.find(row=>row.role==='unit_router').input.facts[0].content, 'corrected value')
  assert.equal(runner.graph.status().rootOutcome, 'PASS')
  assert.ok(state.supervision.finalReport)
})

test('unit v2 rebuilds a baseline after plan review, retries rejected drafts and re-enters audited planning', async t => {
  let rewrite = 0, baselineReviews = 0, planSignal = false, unitChange
  const h = await fixture(t, ({ role, input, payload }) => {
    const system = payload.messages[0].content
    if (system.includes('RULE_BLUEPRINT_AUDIT_V1')) return answer({ verdict: 'APPROVE', reason: 'Root ready.' })
    if (role === 'unit_router') return answer({ action: input.unit.key === 'root' ? 'PLAN' : 'EXECUTE', reason: 'Follow the unit mandate.' })
    if (system.includes('UNIT_REBASELINE_V2')) {
      rewrite++
      return answer({ baseline: { ...input.unitBaseline, objective: 'Inspect the revised evidence ' + rewrite }, reason: 'Additional evidence from the first unit.' })
    }
    if (role === 'baseline_audit') {
      baselineReviews++
      if (baselineReviews === 1) return answer({ verdict: 'REJECT', reason: 'Specify the evidence.', issues: [
        { path: '/baseline/after/objective', reason: 'Specify what to inspect.', expected: 'Revised evidence', observed: input.baseline.after.objective }] })
      if (!input.baseline.key) unitChange = input.baseline.after
      else assert.equal(input.baseline.key, 'old_end')
      return answer({ verdict: 'APPROVE', reason: 'Revised objective covers the evidence.', issues: [] })
    }
    if (role === 'scope_update') {
      if (!input.approvedUnitBaseline) return answer(enterPlan(input, ['first', 'old_end']))
      const old = input.blueprint.value, plan = enterPlan(input, ['rechecked_end'])
      plan.nodes.unshift(...old.nodes)
      plan.contextGraph.bindings.unshift(...old.contextGraph.bindings.filter(row => row.task !== old.scope.key)
        .map(row => row.task === 'old_end' ? { ...row, baseline: { ...row.baseline, objective: 'Check the additional child evidence.' } } : row))
      plan.baseline = unitChange
      plan.modifications.push({ ...plan.modifications[0], path: '/contextGraph/bindings/' + old.scope.key })
      plan.modifications.push({ ...plan.modifications[0], path: '/contextGraph/bindings/old_end' })
      return answer(plan)
    }
    if (role === 'scope_plan' && !planSignal) { planSignal = true; return answer({ verdict: 'REBASELINE' }) }
    if (role === 'worker') return answer({ outcome: 'PASS', summary: 'Checked the actual unit.' })
    if (role === 'group_audit') return answer({ ...complete(input), action: 'PASS' })
  }, { storageFormat: 'sqlite' })
  const r = h.runner
  r.submit(await prepareRuleSubmission(r, unitSeed(), undefined, new AbortController().signal))
  const id = r.graph.read().graph.state.plan.nodes[0].id
  for (let i = 0; i < 5 && !r.graph.read().supervision.finalReport; i++) await next(r)
  assert.equal(rewrite, 2)
  assert.equal(baselineReviews, 3)
  assert.deepEqual(r.graph.read().contexts.bindings.find(row => row.taskId === id).baseline, unitChange)
  assert.ok(r.graph.read().supervision.finalReport)
  assert.equal(h.calls.filter(call => call.role === 'scope_audit').length, 2)
})

test('unit v2 repairs a stalled inner layer before an outer runnable sibling', async t => {
  let scope, repaired = false
  const h = await fixture(t, ({ role, input, payload }) => {
    if (payload.messages[0].content.includes('RULE_BLUEPRINT_AUDIT_V1')) return answer({ verdict: 'APPROVE', reason: 'Seed.' })
    if (role === 'unit_router') return answer({ action: ['root','inner'].includes(input.unit.key) ? 'PLAN' : 'EXECUTE', reason: input.unit.key })
    if (role === 'scope_blockage') {
      assert.equal(input.blueprint.value.scope.key, 'inner')
      scope = input.scopeId
      return answer({ action: 'REPLAN' })
    }
    if (role === 'scope_update') {
      const before = input.blueprint.value
      if (before.scope.key === 'root') return answer(enterPlan(input, ['inner','outer_work','outer_end']))
      if (!payload.messages.some(row => row.role === 'tool')) {
        assert.ok(payload.tools.some(row => row.function.name === 'dynamic_context_set_rule_tree'))
        const rules = scope ? [] : [{ id: 'failed_only', when: { node: 'check', in: ['FAILED'] } }]
        return { tools: [{ name: 'dynamic_context_set_rule_tree', arguments: { target: 'inner_end', expected_revision: 0, rules } }] }
      }
      if (!scope) return answer(enterPlan(input, ['check','inner_end']))
      const prior = before.nodes.find(row => row.key === 'inner_end')
      repaired = true
      const ref = { source: 'scope', sha256: input.blueprint.sha256, path: '/scope/key', quote: before.scope.key }
      return answer({ action: 'REVISE', terminal: 'inner_end', nodes: before.nodes.map(row => row === prior ? { ...row, rules: [] } : row),
        edges: [], contextGraph: { nodes: [], bindings: before.contextGraph.bindings.filter(row => row.task !== 'inner') },
        modifications: [{ path: '/taskGraph/nodes/inner_end', reason: 'Remove the closed entrance.', evidence: [ref] }] })
    }
    if (role === 'worker') return answer({ outcome: 'PASS', summary: 'Checked the actual unit.' })
    if (role === 'group_audit') return answer({ ...complete(input), action: 'PASS' })
  })
  const r = h.runner
  r.submit(await prepareRuleSubmission(r, unitSeed(), undefined, new AbortController().signal))
  for (let i = 0; i < 8 && !r.graph.read().supervision.finalReport; i++) await next(r)
  assert.ok(repaired)
  const order = h.calls.map(call => call.role === 'unit_router' ? call.input.unit.key : call.role)
  assert.ok(order.indexOf('scope_blockage') < order.indexOf('outer_work'))
  assert.equal(r.graph.status().rootOutcome, 'PASS')
})

test('agentless unit request pages its oversized baseline and shared facts without a duplicate in the wire payload', async t => {
  const marker = 'ORIGINAL_END_7923', fact = '本单元有一份长材料。'.repeat(290) + marker
  let read = false
  const h = await fixture(t, ({ role, input, payload }) => {
    if (payload.messages[0].content.includes('RULE_BLUEPRINT_AUDIT_V1')) return answer({ verdict: 'APPROVE', reason: 'Root verified.' })
    if (role === 'unit_router') return answer({ action: 'EXECUTE', reason: 'Run this unit.' })
    if (role !== 'worker') return
    const prior = payload.messages.find(row => row.role === 'tool')
    if (prior) {
      assert.match(prior.content, /ORIGINAL_END_7923/)
      read = true
      return answer({ outcome: 'PASS', summary: 'Read scoped source.' })
    }
    const wire = JSON.stringify(payload.messages)
    assert.ok(!wire.includes(marker))
    const task = payload.messages.filter(row => row.role === 'user').map(row => { try { return JSON.parse(row.content.split('\n\n').at(-1)) } catch { return {} } }).find(row => row.materialSummary)
    assert.ok(task?.materialSummary, wire.slice(-300))
    const { tool: name, arguments: args } = task.materialSummary.reader
    assert.ok(payload.tools.some(row => row.function.name === name))
    return { tools: [{ name, arguments: { ...args, length: 8000 } }] }
  }, { dynamicContextMaxBytes: 2048, unitFinalReport: false })
  const r = h.runner, seed = unitSeed()
  seed.contextGraph.nodes[0].content = fact
  r.submit(await prepareRuleSubmission(r, seed, undefined, new AbortController().signal))
  await next(r)
  assert.equal(read, true)
  assert.equal(r.graph.status().rootOutcome, 'PASS')
})
