import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { digest, view } from 'dsh-better-task-grapth/core'
import { createHarness } from '../testing/harness.mjs'
import { runtimeProposal } from '../testing/runtime-harness.mjs'
import { blockageSituation, validateBlockageDecision } from '../blockage-protocol.mjs'
import { blockageCatalog, blockageInput, blockageTools, sourceValue, readBlockage, saveBlockage } from '../blockage-evidence.mjs'
import { blockageStatus } from '../blockage-runtime.mjs'
import { executionReportHistory } from '../report-evidence.mjs'
import { WorkflowOrchestrator } from '../orchestration.mjs'
import { COMPACTION_INSTRUCTION } from '../dsh-compaction-policy.mjs'

const policy = { objective: 'Deliver and verify the fixture', requirements: [{ id: 'result', text: 'Retain all actual outcomes and verify every required file.' }] }
const answer = value => ({ text: JSON.stringify(value) })
const blocked = 'Only the first required file was checked; the second was omitted.'
const accept = answer({ verdict: 'ACCEPT', reason: 'Evidence supports the submitted disposition.' })
const current = answer({ verdict: 'CURRENT' })
const kind = payload => payload.messages[0]?.content.includes('DYNAMIC_CONTEXT_BLOCKAGE_PAUSE_AUDIT_V1') ? 'audit'
  : payload.messages[0]?.content.includes('DYNAMIC_CONTEXT_BLOCKAGE_HANDLER_V1') ? 'handler'
    : !payload.response_format ? 'worker' : payload.messages[0]?.content.includes('受理当前叶') || payload.messages[0]?.content.includes('你是当前叶处置请求的验收者') ? 'accept'
      : payload.messages[0]?.content.includes('你是任务图修订角色') ? 'updater'
        : payload.messages[0]?.content.includes('你是独立的任务图修改审批角色') ? 'reviewer' : 'plan'
const proposal = (count = 2) => {
  const p = runtimeProposal([]); p.contextGraph.bindings[0].completion = { kind: 'report' }
  for (let i=1; i<count; i++) {
    const key = 'task' + i, predecessor = i === 1 ? 'task' : 'task' + (i-1)
    p.taskGraph.nodes.push({ key, kind: 'leaf', label: key, parent: 'root' })
    p.taskGraph.edges.push({ kind: 'prerequisite', from: predecessor, to: key })
    p.contextGraph.bindings.push({ task: key, instruction: 'Check all required files.', contexts: ['task_data'], inheritReports: [predecessor], tools: [], completion: { kind: 'report' } })
  }
  return p
}
async function fixture(t, respond, config = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'blockage-fake-'))), projectRoot = path.join(root, 'work')
  fs.mkdirSync(projectRoot)
  const h = await createHarness({ projectRoot, directory: path.join(root, 'state'),
    config: { transport: 'direct', storageRoot: root, supervision: true, revision: { policy }, direct: { durable: true }, ...config },
    respond: request => {
      const role = kind(request.payload)
      return respond?.({ ...request, role }) ?? (role === 'worker' ? answer({ outcome: 'BLOCKED', summary: blocked }) : role === 'accept' ? accept : current)
    } })
  t.after(async () => { await h.close(); fs.rmSync(root, { recursive: true, force: true }) })
  return { ...h, root, projectRoot }
}
const handle = (runner, extra = {}) => { const s = runner.graph.read(); return runner.handleBlockage({ expectedRevision: s.revision, baseChecksum: s.checksum, ...extra }) }
function rework(input, all = false) {
  const tasks = new Set(all ? input.situation.related : input.situation.causes)
  return { action: 'REWORK', report: { version: 1, findings: input.affectedReports.filter(r => tasks.has(r.value.taskId) && !r.value.revoked.length).map(r => ({
    taskId: r.value.taskId, attemptId: r.value.attemptId, reasonCode: 'MISSING_REQUIRED_RESULT',
    criterion: 'Verify every required file.', problem: 'The second required file was not included in the verification.',
    correction: 'Inspect the missing file and recheck the required result.',
    evidence: [{ source: r.source, sha256: r.sha256, path: '/result/summary', quote: r.value.result.summary }],
  })) } }
}
function pause(input) {
  const r = input.affectedReports.at(-1)
  return { action: 'PAUSE', report: { version: 1, summary: 'Required input is unavailable in the authorized area.',
    constraints: [{ description: 'The required second file cannot be inspected.', affectedTasks: input.situation.causes,
      evidence: [{ source: r.source, sha256: r.sha256, path: '/result/summary', quote: r.value.result.summary }] }],
    alternatives: { rework: 'Another run cannot supply the absent input.', replan: 'The fixed requirement still needs this input.' },
    resumeCondition: 'The user supplies the required input.', requestedUserAction: 'Provide the second required file.' } }
}

test('blockage gate never handles active, ready, pending review or complete legacy work', async t => {
  const h = await fixture(t)
  h.runner.submit(proposal())
  assert.equal(blockageSituation(h.runner.graph.read()), null)
  await h.runner.runNext({ expectedRevision: 1 })
  const s = h.runner.graph.read(), situation = blockageSituation(s)
  assert.equal(situation.causes.length, 1); assert.equal(situation.related.length, 2)
  const before = JSON.stringify(s)
  for (const phase of ['CHECK_PLAN','CHECK_RESULT','REPAIR_RESULT','REVISE'])
    assert.equal(blockageSituation({ ...s, supervision: { ...s.supervision, phase } }), null)
  assert.equal(blockageSituation({ ...s, graph: { ...s.graph, state: { ...s.graph.state, active: {} } } }), null)
  assert.equal(JSON.stringify(h.runner.graph.read()), before)
})

test('evidence rejection identifies exact points, stale attempts, dependency-only reasons and incomplete causes', async t => {
  const h = await fixture(t); h.runner.submit(proposal()); await h.runner.runNext({ expectedRevision: 1 })
  const state = h.runner.graph.read(), situation = blockageSituation(state), catalog = blockageCatalog(h.runner, state)
  const input = blockageInput(h.runner, state, situation, catalog), good = rework(input)
  assert.deepEqual(validateBlockageDecision(good, { state, situation, catalog }), good)
  for (const [field,value,code] of [['sha256','0'.repeat(64),'BLOCKAGE_EVIDENCE_HASH_MISMATCH'],
    ['source','report:other-workflow','BLOCKAGE_EVIDENCE_SOURCE_UNKNOWN'], ['path','/result/missing','BLOCKAGE_EVIDENCE_POINTER_MISSING'],
    ['quote','not present in the report','BLOCKAGE_EVIDENCE_QUOTE_MISMATCH']]) {
    const bad = structuredClone(good); bad.report.findings[0].evidence[0][field] = value
    assert.throws(() => validateBlockageDecision(bad,{ state,situation,catalog }), error => error.code === code && JSON.stringify(error).includes('/report/findings/0/evidence/0/'))
  }
  const bad = structuredClone(good); bad.report.findings[0].problem = '因为任务未完成导致后续无法继续'
  assert.throws(() => validateBlockageDecision(bad,{ state,situation,catalog }), { code: 'BLOCKAGE_DEPENDENCY_ONLY_REASON' })
  bad.report.findings[0].attemptId = 'attempt_stale'
  assert.throws(() => validateBlockageDecision(bad,{ state,situation,catalog }), { code: 'BLOCKAGE_REWORK_TARGET_INVALID' })
  assert.throws(() => validateBlockageDecision(good,{ state,situation: { ...situation, causes: [...situation.causes, 'node_other'] },catalog }), { code: 'BLOCKAGE_ALL_CAUSES_REQUIRED' })
  assert.throws(() => validateBlockageDecision({ action: 'REPLAN', reason: 'Do this instead' },{state,situation,catalog}))
})

test('rework archives complete reports, preserves every old event/outcome, resets dependents and starts a new attempt', async t => {
  let workers = 0, reworking = false
  const h = await fixture(t, ({ role,payload }) => {
    if (role === 'handler') { reworking = true; return answer(rework(JSON.parse(payload.messages[1].content),true)) }
    if (role === 'worker') {
      workers++
      if (reworking) assert.match(JSON.stringify(payload.messages), /reworkRequest/)
      return answer({ outcome: workers === 2 ? 'BLOCKED' : 'COMPLETE', summary: blocked })
    }
  })
  h.runner.submit(proposal(3)); await h.runner.runNext({ expectedRevision: 1 }); await h.runner.runNext({ expectedRevision: 3 })
  const before = h.runner.graph.read(); assert.equal(before.reports.length,1)
  const r = await handle(h.runner); assert.equal(r.status,'REWORKED')
  const after = h.runner.graph.read()
  assert.deepEqual(after.graph.events.slice(0,-1),before.graph.events)
  assert.deepEqual(after.supervision.outcomes,before.supervision.outcomes)
  assert.deepEqual(after.contexts,before.contexts); assert.deepEqual(after.reportArchive,before.reports)
  assert.equal(after.reports.length,0); assert.equal(view(after.graph).legalNext.length,1)
  assert.equal(executionReportHistory(after)[0].reportValid,false)
  assert.equal(after.graph.events.at(-1).data.attempts.length,2)
  await h.runner.runNext({ expectedRevision: after.revision })
  const final = h.runner.graph.read()
  assert.notEqual(final.reports[0].attemptId,before.reports[0].attemptId)
  assert.deepEqual(final.reportArchive,before.reports)
  assert.deepEqual(h.backend.errors,[])
})

test('scoped read tools provide exact paged receipts and refuse cross-workflow, write or arbitrary file requests', async t => {
  const h = await fixture(t); h.runner.submit(proposal()); await h.runner.runNext({ expectedRevision: 1 })
  const state = h.runner.graph.read(), catalog = blockageCatalog(h.runner,state), directory = path.join(h.root,'tool-role')
  const tools = blockageTools(catalog,directory)
  const report = [...catalog.keys()].find(id => id.startsWith('report:'))
  const call = (name,args,id='call') => ({ id,function:{ name,arguments:JSON.stringify(args) } })
  const read = call('dynamic_context_blockage_report',{source:report,path:'/result/summary',start:0,end:12})
  const first = await tools.execute(read); assert.equal(first.text,blocked.slice(0,12)); assert.equal(first.next,12)
  assert.equal(first.sourceSha256,sourceValue(catalog,report).sha256)
  assert.deepEqual(await blockageTools(catalog,directory).execute(read),first)
  assert.equal((await tools.execute(call('dynamic_context_blockage_trace',{ source:'/etc/passwd' }))).error,'BLOCKAGE_SOURCE_SCOPE_MISMATCH')
  assert.equal((await tools.execute(call('dynamic_context_shared_update',{ source:'shared' }))).error,'BLOCKAGE_SOURCE_SCOPE_MISMATCH')
  const trace = [...catalog.keys()].find(id => id.startsWith('trace:'))
  assert.match((await tools.execute(call('dynamic_context_blockage_trace',{source:trace,path:'/assembly/task'}))).text,/attempt_/)
  assert.equal((await tools.execute(call('dynamic_context_blockage_report',{source:report,path:'/absent'}))).error,'BLOCKAGE_EVIDENCE_POINTER_MISSING')
})

test('pause needs independent approval; rejection returns precise issues; waiting does not make another model call', async t => {
  let handlers = 0, audits = 0
  const h = await fixture(t, ({role,payload}) => {
    const input = payload.response_format ? JSON.parse(payload.messages[1].content) : null
    if (role === 'handler') {
      handlers++
      if (handlers === 2) assert.equal(input.priorReview.review.issues[0].path,'/submission/summary')
      const request = pause(input); if (handlers > 1) request.report.summary += ' Verified by the cited report.'
      return answer(request)
    }
    if (role === 'audit') {
      audits++
      assert.ok(payload.tools.every(tool => ['read_image', 'dynamic_context_generate_report', 'dynamic_context_read_report', 'dynamic_context_rewrite_report', 'dynamic_context_submit_report'].includes(tool.function.name))); assert.ok(input.evidence[0].value)
      return answer(audits === 1 ? {verdict:'REJECT',reason:'Clarify the request.',issues:[{path:'/submission/summary',item:'missing input',reason:'State the evidence behind the request.'}]}
        : {verdict:'APPROVE',reason:'The reported constraint supports waiting.',issues:[]})
    }
  })
  h.runner.submit(proposal()); await h.runner.runNext({expectedRevision:1})
  const before = h.runner.graph.read(), r = await handle(h.runner)
  assert.equal(r.status,'WAITING_USER'); assert.equal(handlers,2); assert.equal(audits,2)
  assert.deepEqual(h.runner.graph.read(),before)
  const count = h.backend.requests.length
  assert.equal((await handle(h.runner)).status,'WAITING_USER'); assert.equal(h.backend.requests.length,count)
  assert.equal(blockageStatus(h.runner).phase,'WAITING_USER')
  assert.equal((await handle(h.runner,{resume:true})).status,'WAITING_USER'); assert.equal(handlers,3)
  assert.deepEqual(h.runner.graph.read(),before)
})

test('short REPLAN signal reuses updater and independent audit without forging plan-check history', async t => {
  let updater=0, reviewer=0, h
  h = await fixture(t, ({role,payload}) => {
    if (role==='handler') return answer({action:'REPLAN'})
    if (role==='updater') {
      updater++
      const input=JSON.parse(payload.messages[1].content), p=proposal(3)
      // Retain executed task. A new independent recovery leaf resolves the unmet
      // prerequisite for the remaining pending work under the unchanged contract.
      p.taskGraph.edges=[{kind:'prerequisite',from:'task2',to:'task1'}]
      p.contextGraph.bindings[1].inheritReports=['task2']; p.contextGraph.bindings[2].inheritReports=[]
      return answer({disposition:'REVISE',trigger:'MISSING_DEPENDENCY',reason:'Add an independent recovery step.', evidenceIds:[input.facts[0].id],
        taskGraph:p.taskGraph,contextGraph:p.contextGraph,coverage:[{requirement:'result',tasks:['task','task1','task2']}],retirements:[],invalidateReports:[]})
    }
    if (role==='reviewer') { reviewer++; return answer({verdict:'APPROVE',reason:'Recovery preserves requirements and executed history.',violations:[],issues:[]}) }
  })
  h.runner.submit(proposal()); await h.runner.runNext({expectedRevision:1}); const before=h.runner.graph.read()
  assert.equal((await handle(h.runner)).status,'REPLANNED')
  const after=h.runner.graph.read()
  assert.equal(updater,1); assert.equal(reviewer,1)
  assert.deepEqual(after.graph.events.slice(0,-1),before.graph.events); assert.deepEqual(after.supervision,before.supervision)
  assert.ok(after.graph.events.at(-1).data.review.blockageSignal)
  assert.ok(view(after.graph).legalNext.length)
})

test('normal pause/restart reuses exact role and tool receipts, and does not approve pause prematurely', async t => {
  let stop=false, once=false
  const h=await fixture(t,({role,payload})=>{
    if(role==='handler') {
      if(!once) { once=true; stop=true; return {tools:[{name:'dynamic_context_blockage_shared',arguments:{source:'shared',path:'/current'}}]} }
      assert.equal(payload.messages.at(-1).role,'tool')
      return answer(pause(JSON.parse(payload.messages[1].content)))
    }
    if(role==='audit') return answer({verdict:'APPROVE',reason:'The evidence supports waiting.',issues:[]})
  })
  h.runner.submit(proposal()); await h.runner.runNext({expectedRevision:1})
  h.runner.workflowControl={beforeRequest(){if(stop){const e=new Error('WORKFLOW_PAUSE_REQUESTED');e.code=e.message;throw e}}}
  await assert.rejects(handle(h.runner),{code:'WORKFLOW_PAUSE_REQUESTED'})
  assert.equal(blockageStatus(h.runner).phase,'ANALYZE'); assert.equal(h.runner.busy,false)
  const record=readBlockage(path.join(h.root,'state','blockage-control.json')), id=record.handlerRunId
  stop=false; h.runner.workflowControl.recoverModel=true
  assert.equal((await handle(h.runner,{resume:true})).status,'WAITING_USER')
  assert.equal(readBlockage(path.join(h.root,'state','blockage-control.json')).handlerRunId,id)
  assert.equal(h.backend.requests.filter(r=>kind(r.payload)==='handler').length,2)
})

test('audited waiting cannot be resumed by the controller model without human input; the UI button is an explicit resume', async t=>{
  const h=await fixture(t,({role,payload})=>role==='handler'?answer(pause(JSON.parse(payload.messages[1].content)))
    : role==='audit'?answer({verdict:'APPROVE',reason:'Evidence supports waiting.',issues:[]}):undefined)
  h.runner.submit(proposal());await h.runner.runNext({expectedRevision:1});await handle(h.runner)
  let questions=0, followups=0
  const agent={followup(){followups++}}, interaction={ctx:h.ctx,exact(){},mode(){return 'full'},entries:new Map([[agent,{runner:h.runner}]]),
    ask:async()=>{questions++;return 'wait'}}
  const o=new WorkflowOrchestrator(interaction)
  o.record=()=>({phase:'PAUSED',afterPlanning:'auto_start',reason:'BLOCKAGE_REVIEWED_WAIT',pauseKind:'normal'})
  await o.control(agent,'continue',new AbortController().signal)
  assert.equal(questions,1);assert.equal(o.queued.has(agent),false)
  o.executionView=()=>({canResume:true})
  await o.fromView(agent,'resume',new AbortController().signal)
  assert.equal(questions,1);assert.equal(o.queued.has(agent),true);assert.equal(followups,1)
})

test('post-CAS interruption is reconciled from the exact rework event without replaying a model or old tool',async t=>{
  const h=await fixture(t,({role,payload})=>role==='handler'?answer(rework(JSON.parse(payload.messages[1].content))):undefined)
  h.runner.submit(proposal());await h.runner.runNext({expectedRevision:1});await handle(h.runner)
  const file=path.join(h.root,'state','blockage-control.json'), control=readBlockage(file)
  control.phase='REWORK';delete control.resolvedRevision;saveBlockage(file,control)
  const before=h.runner.graph.read(),count=h.backend.requests.length
  assert.equal((await handle(h.runner,{resume:true})).status,'NOT_APPLICABLE')
  assert.equal(blockageStatus(h.runner).phase,'RESOLVED');assert.equal(h.backend.requests.length,count)
  assert.deepEqual(h.runner.graph.read(),before)
})

test('program-invalid and audit-rejected blueprint changes return to the updater with exact feedback',async t=>{
  let updates=0,audits=0
  const h=await fixture(t,({role,payload})=>{
    if(role==='handler')return answer({action:'REPLAN'})
    if(role==='updater'){
      updates++;const input=JSON.parse(payload.messages[1].content),p=proposal(3)
      if(updates===2)assert.equal(input.priorReview.stage,'PROGRAM')
      if(updates===3)assert.equal(input.priorReview.review.issues[0].path,'/proposal/reason')
      p.taskGraph.edges=[{kind:'prerequisite',from:'task2',to:'task1'}]
      p.contextGraph.bindings[1].inheritReports=['task2'];p.contextGraph.bindings[2].inheritReports=[]
      if(updates===1)p.contextGraph.bindings[2].tools=['forbidden_tool']
      return answer({disposition:'REVISE',trigger:'MISSING_DEPENDENCY',reason:updates===3?'An independent recovery step supplies the required input.':'Recovery proposal.',
        evidenceIds:[input.facts[0].id],taskGraph:p.taskGraph,contextGraph:p.contextGraph,
        coverage:[{requirement:'result',tasks:['task','task1','task2']}],retirements:[],invalidateReports:[]})
    }
    if(role==='reviewer'){
      audits++
      return answer(audits===1?{verdict:'REJECT',reason:'Clarify recovery.',issues:[{path:'/proposal/reason',item:'recovery',reason:'State how the new step supplies the input.'}]}
        :{verdict:'APPROVE',reason:'Recovery is defined.',issues:[]})
    }
  })
  h.runner.submit(proposal());await h.runner.runNext({expectedRevision:1})
  assert.equal((await handle(h.runner)).status,'REPLANNED');assert.equal(updates,3);assert.equal(audits,2)
  assert.equal(h.runner.graph.read().graph.events.filter(e=>e.type==='REVISED').length,1)
  assert.equal(blockageStatus(h.runner).phase,'RESOLVED')
})

test('oversized graph prompts stop plan review instead of silently compressing protected context',async t=>{
  let summaries=0
  const h=await fixture(t,({role,payload})=>{
    if(payload.messages.at(-1).content?.startsWith?.(COMPACTION_INSTRUCTION)){summaries++;return {text:'Navigation: large background reference; inspect originals for decisive claims.'}}
    if(role==='handler'){
      assert.ok(payload.tools.some(t=>t.function.name==='dynamic_context_blockage_trace'))
      assert.match(JSON.stringify(payload.messages),/_dynamicContextEvidence/)
      return answer(pause(JSON.parse(payload.messages[1].content)))
    }
    if(role==='audit')return answer({verdict:'APPROVE',reason:'Evidence supports waiting.',issues:[]})
  },{maxContextCharacters:null,maxReportCharacters:null,
    revision:{policy,maxOutputTokens:32768},direct:{durable:true,compaction:{strategy:'dsh-native',contextWindow:262144},maxRequestBytes:null}})
  const p=proposal();for(let i=0;i<3;i++)p.contextGraph.nodes.push({key:'background_'+i,content:'Unbound reference material 0123456789. '.repeat(3000),parents:[]})
  h.runner.submit(p)
  await assert.rejects(h.runner.runNext({expectedRevision:1}),{code:'REVISION_CONTEXT_ANCHORS_EXCEED_WINDOW'})
  assert.equal(summaries,0,'graph prompts cannot be substituted by a model summary')
  assert.equal(h.runner.graph.read().contexts.nodes.filter(n=>n.key.startsWith('background_')).length,3)
})

test('report-scoped mode supplies full affected execution reports without raw tools or assembly failures by default',async t=>{
  const h=await fixture(t,({role,payload})=>{
    if(role==='worker')return answer({outcome:'BLOCKED',summary:blocked,executionReport:{workHistory:['Partial inspection.'],
      results:[{criterion:'Check every file',result:'Second file absent',artifactRefs:[],testIds:['check']}],directories:[],
      tests:[{id:'check',criterion:'Input exists',status:'NOT_RUN',expected:'Second file available',observed:'Input unavailable'}],limitations:['Second input unavailable.']}})
    if(role==='handler'){
      const input=JSON.parse(payload.messages[1].content)
      assert.equal(input.affectedReports[0].value.result.executionReport.workHistory[0],'Partial inspection.')
      assert.ok(!('execution' in input));assert.ok(!('tools' in input.affectedReports[0].value))
      return answer(pause(input))
    }
    if(role==='audit')return answer({verdict:'APPROVE',reason:'Evidence supports waiting.',issues:[]})
  },{supervisionContext:'reports'})
  const p=proposal();p.planningReport={understanding:'Verify required inputs.',assumptions:['Two inputs expected.'],design:'Serial verification.',acceptanceStrategy:'Inspect every file.'}
  h.runner.submit(p);await h.runner.runNext({expectedRevision:1})
  assert.equal((await handle(h.runner)).status,'WAITING_USER')
})

test('an interrupted updater/auditor pair resumes its pinned role IDs and never silently repeats the completed updater',async t=>{
  let stop=false,updates=0,audits=0
  const h=await fixture(t,({role,payload})=>{
    if(role==='handler')return answer({action:'REPLAN'})
    if(role==='updater'){
      updates++;stop=true;const input=JSON.parse(payload.messages[1].content),p=proposal(3)
      p.taskGraph.edges=[{kind:'prerequisite',from:'task2',to:'task1'}]
      p.contextGraph.bindings[1].inheritReports=['task2'];p.contextGraph.bindings[2].inheritReports=[]
      return answer({disposition:'REVISE',trigger:'MISSING_DEPENDENCY',reason:'Independent recovery.',evidenceIds:[input.facts[0].id],
        taskGraph:p.taskGraph,contextGraph:p.contextGraph,coverage:[{requirement:'result',tasks:['task','task1','task2']}],retirements:[],invalidateReports:[]})
    }
    if(role==='reviewer'){audits++;return answer({verdict:'APPROVE',reason:'Recovery preserves requirements.',issues:[]})}
  })
  h.runner.submit(proposal());await h.runner.runNext({expectedRevision:1})
  h.runner.workflowControl={beforeRequest(){if(stop){const e=new Error('WORKFLOW_PAUSE_REQUESTED');e.code=e.message;throw e}}}
  await assert.rejects(handle(h.runner),{code:'WORKFLOW_PAUSE_REQUESTED'})
  const file=path.join(h.root,'state','blockage-control.json'),before=readBlockage(file)
  assert.equal(before.phase,'REVISING');assert.equal(updates,1);assert.equal(audits,0)
  stop=false;h.runner.workflowControl.recoverModel=true
  assert.equal((await handle(h.runner,{resume:true})).status,'REPLANNED')
  assert.deepEqual(readBlockage(file).revisionRuns,before.revisionRuns)
  assert.equal(updates,1);assert.equal(audits,1)
})

test('ambiguous model transport failure remains pending until explicit recovery, then resumes the same decision role',async t=>{
  let calls=0
  const h=await fixture(t,({role,payload})=>{
    if(role==='handler')return ++calls===1?{status:503,body:'Synthetic model outage'}:answer(rework(JSON.parse(payload.messages[1].content)))
  })
  h.runner.submit(proposal());await h.runner.runNext({expectedRevision:1});const base=h.runner.graph.read()
  await assert.rejects(handle(h.runner))
  assert.deepEqual(h.runner.graph.read(),base)
  const file=path.join(h.root,'state','blockage-control.json'),first=readBlockage(file).handlerRunId
  await assert.rejects(handle(h.runner),{code:'BLOCKAGE_UNKNOWN_ROLE_REQUIRES_RECONCILIATION'})
  assert.equal(calls,1)
  h.runner.workflowControl={recoverModel:true,beforeRequest(){}}
  assert.equal((await handle(h.runner,{resume:true})).status,'REWORKED')
  assert.equal(readBlockage(file).handlerRunId,first);assert.equal(calls,2)
  assert.equal(h.backend.requests.filter(r=>kind(r.payload)==='worker').length,1)
})
