import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { canonical } from 'dsh-better-task-grapth/core'
import { nativeRevisionRole } from '../revision-host.mjs'
import { DynamicContextGraph, validateState } from '../core.mjs'
import { createHarness } from '../testing/harness.mjs'
import { runtimeProposal } from '../testing/runtime-harness.mjs'

const policy = { objective: 'Implement lazy configuration evaluation', requirements: [{ id: 'lazy', text: 'Preserve forward references and lazy evaluation' }] }
const verdict = { verdict: 'APPROVE', reason: 'The new evidence justifies the change and preserves requirements.', violations: [] }
test('standalone native role calls use fresh supplied messages without default prompt assembly or tool execution', async t => {
  const h = await fixture(t, ({ payload }) => {
    assert.equal(payload.messages.length, 2)
    assert.doesNotMatch(JSON.stringify(payload.messages), /UNRELATED_GLOBAL_CONTEXT_MUST_NOT_LEAK/)
    return { text: JSON.stringify(verdict) }
  })
  const result = await nativeRevisionRole(h.ctx, { options: { provider: 'dynamic-context-fake', model: 'fake-llama' },
    session: { requestHeader: () => undefined } }, { role: 'reviewer', runId: 'native-role-fixture', signal: new AbortController().signal,
    messages: [{ role: 'system', content: 'Independent review. Return JSON.' }, { role: 'user', content: 'Inspect this plan.' }] })
  assert.deepEqual(JSON.parse(result), verdict)
})
function proposal(input) {
  return { disposition: 'REVISE', trigger: 'COUNTEREXAMPLE', reason: 'Forward reference fails under eager evaluation.',
    evidenceIds: ['fact_0'], taskGraph: input.snapshot.taskGraph, contextGraph: input.snapshot.contextGraph,
    coverage: [{ requirement: 'lazy', tasks: ['task'] }], retirements: [], invalidateReports: [] }
}
async function fixture(t, respond, initial = runtimeProposal([])) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-joint-revise-')))
  const h = await createHarness({ projectRoot: root, directory: path.join(root, 'state'), config: {
    transport: 'direct', revision: { policy }, direct: { durable: true }, exposeControlTools: true,
  }, respond })
  const file = path.join(root, 'counterexample.txt'), text = 'foo = bar * 2; bar = 21; expected foo=42. Eager evaluation fails.'
  fs.writeFileSync(file, text)
  h.runner.submit(initial)
  t.after(async () => { await h.close(); fs.rmSync(root, { recursive: true, force: true }) })
  return { ...h, root, evidence: [{ kind: 'artifact', ref: file, sha256: createHash('sha256').update(text).digest('hex') }] }
}

test('fake HTTP roles are isolated; joint revision survives restart and runs the new binding', async t => {
  let updater
  const h = await fixture(t, ({ payload, index }) => {
    if (index === 1) {
      updater = proposal(JSON.parse(payload.messages[1].content))
      updater.contextGraph.nodes.push({ key: 'lazy', content: 'NEW_LAZY_SEMANTICS', parents: [] })
      updater.contextGraph.bindings[0].contexts.push('lazy')
      return { text: JSON.stringify(updater), reasoning: 'PRIVATE_UPDATER_REASONING_ONLY' }
    }
    if (index === 2) {
      assert.equal(payload.messages.length, 2)
      assert.doesNotMatch(JSON.stringify(payload.messages), /PRIVATE_UPDATER_REASONING_ONLY/)
      return { text: JSON.stringify(verdict) }
    }
    assert.match(JSON.stringify(payload.messages), /NEW_LAZY_SEMANTICS/)
    return { text: 'Work resumed with corrected lazy semantics.' }
  })
  const before = h.runner.graph.read(), result = await h.runner.revise({ expectedRevision: 1, evidence: h.evidence, reason: 'Use the new counterexample.' })
  assert.equal(result.status, 'COMMITTED'); assert.equal(result.revision, 2)
  const state = validateState(h.runner.graph.read())
  assert.notEqual(state.contexts.version, before.contexts.version)
  assert.deepEqual(state.contextHistory[0], { graph: before.graph, contexts: before.contexts })
  assert.deepEqual(state.graph.events.slice(0, -1), before.graph.events)
  h.runner.graph = new DynamicContextGraph(h.runner.config)
  assert.deepEqual(h.runner.graph.read(), state)
  const worked = await h.runner.runNext({ expectedRevision: 2 })
  assert.match(worked.report.text, /corrected lazy/)
  validateState(h.runner.graph.read())
})

test('completed reports keep their original context version; invalidation propagates through report dependencies', async t => {
  const initial = runtimeProposal([])
  initial.taskGraph.nodes = [initial.taskGraph.nodes[0], ...['a', 'b', 'c'].map(key => ({ key, kind: 'leaf', label: key, parent: 'root' }))]
  initial.taskGraph.edges = [{ kind: 'prerequisite', from: 'a', to: 'b' }, { kind: 'prerequisite', from: 'b', to: 'c' }]
  initial.contextGraph.bindings = ['a', 'b', 'c'].map((task, i) => ({ task, instruction: 'Inspect and report.', contexts: ['task_data'],
    tools: [], inheritReports: i === 0 ? [] : [i === 1 ? 'a' : 'b'] }))
  const h = await fixture(t, ({ payload, index }) => {
    if (index <= 2 || index >= 5) return { text: 'Recorded result; semantics remain unverified.' }
    if (index === 4) return { text: JSON.stringify(verdict) }
    const p = proposal(JSON.parse(payload.messages[1].content))
    p.coverage[0].tasks = ['c']; p.invalidateReports = ['a']
    p.contextGraph.nodes.push({ key: 'corrected', content: 'The earlier result is disproved; revalidate all affected semantics.', parents: [] })
    p.contextGraph.bindings[2].contexts = ['corrected']; p.contextGraph.bindings[2].inheritReports = []
    return { text: JSON.stringify(p) }
  }, initial)
  await h.runner.runNext({ expectedRevision: 1 })
  await h.runner.runNext({ expectedRevision: 3 })
  const before = h.runner.graph.read()
  assert.equal(before.reports.length, 2)
  const revised = await h.runner.revise({ expectedRevision: 5, evidence: h.evidence, reason: 'Disprove the first report.' })
  assert.equal(revised.status, 'COMMITTED')
  const state = h.runner.graph.read()
  assert.deepEqual(state.reports, before.reports)
  assert.deepEqual([...state.invalidatedReports].sort(), before.reports.map(row => row.taskId).sort())
  assert.notEqual(state.contexts.version, before.contexts.version)
  validateState(state)
  assert.equal(h.runner.status().reportStates.filter(row => row.validity === 'INVALIDATED').length, 2)
  assert.equal(h.runner.status().contextVersion, state.contexts.version)
  await h.runner.runNext({ expectedRevision: 6 })
  const finished = h.runner.graph.read()
  assert.equal(finished.reports[2].contextVersion, state.contexts.version)
  assert.equal(finished.reports[0].contextVersion, before.contexts.version)
  validateState(finished)
})

test('modifying a context already used by a completed task is rejected before reviewer', async t => {
  const initial = runtimeProposal([])
  initial.taskGraph.nodes.push({ key: 'later', kind: 'leaf', label: 'later', parent: 'root' })
  initial.contextGraph.bindings.push({ ...initial.contextGraph.bindings[0], task: 'later' })
  const h = await fixture(t, ({ payload, index }) => {
    if (index === 1) return { text: 'Work response.' }
    const p = proposal(JSON.parse(payload.messages[1].content)); p.contextGraph.nodes[0].content = 'Rewrite old facts'
    return { text: JSON.stringify(p) }
  }, initial)
  await h.runner.runNext({ expectedRevision: 1 })
  const before = h.runner.graph.read()
  await assert.rejects(h.runner.revise({ expectedRevision: 3, evidence: h.evidence, reason: 'Attempt unsafe rewrite.' }),
    error => error.code === 'EXECUTED_CONTEXT_BINDING_IMMUTABLE')
  assert.deepEqual(h.runner.graph.read(), before)
  assert.equal(h.backend.requests.length, 2)
})

for (const mode of ['reject', 'permission', 'cycle', 'unknown']) test(`joint ${mode} preserves graph and enforces the stop boundary`, async t => {
  const h = await fixture(t, ({ payload, index }) => {
    if (mode === 'unknown') return { disconnect: true }
    if (index === 1) {
      const p = proposal(JSON.parse(payload.messages[1].content))
      if (mode === 'reject') p.contextGraph.bindings[0].instruction += ' Check the revised assumptions.'
      if (mode === 'permission') p.contextGraph.bindings[0].tools = ['unauthorized']
      if (mode === 'cycle') p.contextGraph.nodes[0].parents = [p.contextGraph.nodes[0].key]
      return { text: JSON.stringify(p) }
    }
    return { text: JSON.stringify({ ...verdict, verdict: 'REJECT', violations: ['No justified semantic change.'] }) }
  })
  const before = h.runner.graph.read(), action = () => h.runner.revise({ expectedRevision: 1, evidence: h.evidence, reason: 'Check evidence.' })
  if (mode === 'reject') assert.equal((await action()).status, 'REJECT')
  else await assert.rejects(action())
  assert.equal(canonical(h.runner.graph.read()), canonical(before))
  assert.equal(h.backend.requests.length, mode === 'reject' ? 2 : 1)
  if (mode === 'unknown') {
    await assert.rejects(action(), error => error.code === 'REVISION_UNKNOWN_ROLE_REQUIRES_RECONCILIATION')
    assert.equal(h.backend.requests.length, 1)
  }
})

for (const altered of [false, true]) test(`retained context references are resolved by exact source hash (altered=${altered})`, async t => {
  const h = await fixture(t, ({ payload, index }) => {
    if (index === 2) return { text: JSON.stringify(verdict) }
    const input = JSON.parse(payload.messages[1].content), p = proposal(input)
    p.contextGraph.nodes = p.contextGraph.nodes.map(node => ({ key: node.key, retain: true,
      sha256: altered ? '0'.repeat(64) : input.snapshot.contextHashes[node.key] }))
    p.taskGraph.nodes[1].label = 'Task with clarified lazy evaluation scope'
    return { text: JSON.stringify(p) }
  })
  const before = h.runner.graph.read()
  const action = h.runner.revise({ expectedRevision: 1, evidence: h.evidence, reason: 'Retain exact original context.' })
  if (altered) {
    await assert.rejects(action, error => error.code === 'REVISION_RETAIN_REFERENCE_INVALID')
    assert.deepEqual(h.runner.graph.read(), before); assert.equal(h.backend.requests.length, 1)
  } else {
    assert.equal((await action).status, 'COMMITTED')
    assert.deepEqual(h.runner.graph.read().contexts, before.contexts)
  }
})

test('host workflow revise port binds the real controller without global goal injection and rejects worker elevation', async t => {
 const {createRuntimeHarness}=await import('../testing/runtime-harness.mjs');
 const {default:TaskGraph}=await import('dsh-better-task-grapth');
 const Persistence=await import('@deepseek-ai/dsh-session-persistence-jsonl').then(module => module.default);
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'revision-controller-'))), projectRoot=path.join(root,'workspace');fs.mkdirSync(projectRoot);
 const h=await createRuntimeHarness({projectRoot,directory:path.join(root,'state'),config:{storageRoot:root,revision:{policy},exposeControlTools:true,direct:{durable:true},interop:{workflowId:'revision-fixture'}},
  setup:async ctx=>{await ctx.plugin(Persistence,{root:path.join(root,'sessions')});await ctx.plugin(TaskGraph,{projectRoot});},
  respond:({payload,index})=>{if(index===2)return{text:JSON.stringify(verdict)};const p=proposal(JSON.parse(payload.messages[1].content));p.contextGraph.bindings[0].instruction+=' Preserve counterexample foo=42.';return{text:JSON.stringify(p)};}});
 const controller=await h.ctx.agents.create({sessionId:'revision-controller',meta:{cwd:projectRoot}});
 t.after(async()=>{await controller.dispose();await h.close();fs.rmSync(root,{recursive:true,force:true});});
 h.runner.submit(runtimeProposal([]));
 const file=path.join(projectRoot,'counterexample.txt');fs.writeFileSync(file,'Forward reference must evaluate to 42.');
 const evidence=[{kind:'artifact',ref:file,sha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex')}];
 const prompt=await h.ctx.systemPrompt.assemble({agent:controller.agent});assert.match(JSON.stringify(prompt),/dynamic_context_revise/);assert.doesNotMatch(JSON.stringify(prompt.contexts),/Implement lazy configuration evaluation/);
 const ref={kind:'dynamic-context',workflowId:'revision-fixture'};assert.ok(h.ctx.transactionGraph.readWorkflow(controller.agent,ref).operations.includes('revise'));
 const result=await h.ctx.transactionGraph.dispatchWorkflow(controller.agent,ref,'revise',{expectedRevision:1,evidence,reason:'Fix known forward reference behavior.'});
 assert.equal(result.status,'COMMITTED');assert.equal(h.runner.graph.read().revision,2);
 h.runner.current={agent:controller.agent};
 const tool=h.ctx.tools.get('dynamic_context_revise',controller.agent);
 await assert.rejects(tool.execute({expectedRevision:2,evidence,reason:'Worker must not elevate.'},{agent:controller.agent,callId:'worker-cannot-revise',signal:new AbortController().signal}),error=>error.code==='DYNAMIC_CONTEXT_CONTROLLER_REQUIRED');
 h.runner.current=null;
});

for(const kind of ['credential','private-ledger','hardlink'])test(`revision evidence cannot expose ${kind} through the role interface`,async t=>{
 const h=await fixture(t,()=>{throw Error('Evidence rejection must occur before HTTP');});
 let file;
 if(kind==='credential'){file=path.join(h.root,'.env');fs.writeFileSync(file,'SYNTHETIC_SECRET_MUST_NOT_BE_SENT');}
 if(kind==='private-ledger'){file=path.join(h.root,'state','private.txt');fs.writeFileSync(file,'PRIVATE_LEDGER_MUST_NOT_BE_SENT');}
 if(kind==='hardlink'){file=path.join(h.root,'alias.txt');fs.linkSync(h.evidence[0].ref,file);}
 const ref={kind:'artifact',ref:file,sha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex')};
 await assert.rejects(h.runner.revise({expectedRevision:1,evidence:[ref],reason:'Reject private source.'}),error=>error.code==='REVISION_PRIVATE_EVIDENCE_DENIED');
 assert.equal(h.backend.requests.length,0);assert.equal(h.runner.graph.read().revision,1);
});

async function unknownRevision(t, respond = () => ({ disconnect: true })) {
  const h = await fixture(t, respond)
  await assert.rejects(h.runner.revise({ expectedRevision: 1, evidence: h.evidence, reason: 'Inspect the counterexample.' }))
  const pending = h.runner.revisionRecovery()
  assert.equal(pending.length, 1)
  const recordFile = path.join(h.runner.config.directory, 'revisions', pending[0].runId, 'role.json')
  return { ...h, pending: pending[0], recordFile, originalRecord: fs.readFileSync(recordFile), before: h.runner.graph.read() }
}
const recoveryRequest = h => ({ expectedRevision: 1, runId: h.pending.runId, requestHash: h.pending.requestHash })
const recoveryAttestation = h => ({ confirmedQuiescent: true, abandonRevisionRole: true,
  financialStatus: 'RESERVATION_RETAINED', evidence: h.evidence })

test('unknown revision recovery requires a trusted, role-specific attestation and exact current identity', async t => {
  const h = await unknownRevision(t)
  assert.deepEqual(h.runner.status().revisionRecovery, [h.pending])
  assert.equal(h.pending.requiresTrustedReconciliation, true)
  assert.deepEqual(Object.keys(h.pending).sort(), ['phase', 'requestHash', 'requiresTrustedReconciliation', 'role', 'runId'])
  await assert.rejects(h.runner.abandonRevisionRole(recoveryRequest(h)), error => error.code === 'REVISION_TRUSTED_RECONCILIATION_REQUIRED')
  let remove = h.runner.registerReconciliationVerifier({ version: 'generic-task-reconciler', verify: async () => ({
    confirmedQuiescent: true, closeUnverified: true, evidence: h.evidence,
  }) })
  await assert.rejects(h.runner.abandonRevisionRole(recoveryRequest(h)), error => error.code === 'REVISION_RECOVERY_NOT_ATTESTED')
  remove()
  remove = h.runner.registerReconciliationVerifier({ version: 'role-reconciler', verify: async () => recoveryAttestation(h) })
  await assert.rejects(h.runner.abandonRevisionRole({ ...recoveryRequest(h), expectedRevision: 0 }), error => error.code === 'REVISION_STALE_BASE')
  await assert.rejects(h.runner.abandonRevisionRole({ ...recoveryRequest(h), requestHash: '0'.repeat(64) }), error => error.code === 'REVISION_RECOVERY_RECORD_CHANGED')
  await assert.rejects(h.runner.abandonRevisionRole({ ...recoveryRequest(h), runId: '../escape' }), error => error.code === 'REVISION_RECOVERY_SCOPE_REQUIRED')
  assert.ok(fs.readFileSync(h.recordFile).equals(h.originalRecord))
  assert.deepEqual(h.runner.graph.read(), h.before)
  assert.equal(h.backend.requests.length, 1)
  remove()
})

test('trusted abandonment archives the exact unknown call, preserves the graph and permits only a fresh revision', async t => {
  const h = await unknownRevision(t, ({ payload, index }) => {
    if (index === 1) return { disconnect: true }
    if (index === 2) {
      const p = proposal(JSON.parse(payload.messages[1].content))
      p.contextGraph.bindings[0].instruction += ' Preserve the newly confirmed forward-reference behavior.'
      return { text: JSON.stringify(p) }
    }
    return { text: JSON.stringify(verdict) }
  })
  h.runner.registerReconciliationVerifier({ version: 'operator-v1', verify: async request => {
    assert.equal(request.kind, 'revision-role'); assert.equal(request.runId, h.pending.runId)
    assert.equal(request.requestHash, h.pending.requestHash)
    assert.equal(request.financialReservationReleased, false)
    return recoveryAttestation(h)
  } })
  const result = await h.runner.abandonRevisionRole(recoveryRequest(h))
  assert.deepEqual(result, { status: 'ABANDONED_UNVERIFIED', runId: h.pending.runId, revision: 1,
    graphChanged: false, financialReservationReleased: false, originalOutcome: 'UNVERIFIED', goalReached: false })
  assert.deepEqual(h.runner.graph.read(), h.before)
  const record = JSON.parse(fs.readFileSync(h.recordFile))
  assert.equal(record.phase, 'ABANDONED_UNVERIFIED')
  assert.equal(record.reconciliation.financialStatus, 'RESERVATION_RETAINED')
  assert.equal(record.reconciliation.financialReservationReleased, false)
  assert.ok(fs.readFileSync(record.reconciliation.originalRecord.ref).equals(h.originalRecord))
  assert.equal(record.reconciliation.originalRecord.sha256, createHash('sha256').update(h.originalRecord).digest('hex'))
  assert.deepEqual(h.runner.revisionRecovery(), [])
  await assert.rejects(h.runner.abandonRevisionRole(recoveryRequest(h)), error => error.code === 'REVISION_RECOVERY_RECORD_CHANGED')
  const revised = await h.runner.revise({ expectedRevision: 1, evidence: h.evidence, reason: 'Start a fresh attempt after operator reconciliation.' })
  assert.equal(revised.status, 'COMMITTED')
  const roleIds = fs.readdirSync(path.dirname(path.dirname(h.recordFile))).filter(name => name.startsWith('revision_'))
  assert.equal(roleIds.length, 3)
  assert.equal(new Set(roleIds).size, 3)
  assert.equal(h.backend.requests.length, 3)
})

for (const defect of ['changed-evidence', 'cancelled', 'changed-graph']) test(`trusted revision abandonment preserves UNKNOWN on ${defect}`, async t => {
  const h = await unknownRevision(t), control = new AbortController()
  h.runner.registerReconciliationVerifier({ version: 'operator-v1', verify: async () => {
    if (defect === 'changed-evidence') fs.appendFileSync(h.evidence[0].ref, '\nchanged after attestation')
    if (defect === 'cancelled') control.abort(new Error('operator cancelled reconciliation'))
    if (defect === 'changed-graph') h.runner.graph.begin({ expectedRevision: 1 })
    return recoveryAttestation(h)
  } })
  await assert.rejects(h.runner.abandonRevisionRole({ ...recoveryRequest(h), signal: control.signal }))
  assert.ok(fs.readFileSync(h.recordFile).equals(h.originalRecord))
  assert.equal(h.runner.revisionRecovery().length, 1)
  if (defect !== 'changed-graph') assert.deepEqual(h.runner.graph.read(), h.before)
  assert.equal(h.runner.busy, false)
  assert.equal(h.backend.requests.length, 1)
})
