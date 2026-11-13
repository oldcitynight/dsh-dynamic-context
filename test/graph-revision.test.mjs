import test from 'node:test'
import assert from 'node:assert/strict'
import { TransactionGraph, revisedPlan, digest, copy } from 'dsh-bettertaskgraphs/core'
import { MemoryGraphStore } from 'dsh-bettertaskgraphs/store'
import { RevisionCoordinator, planDefinition } from '../revision.mjs'

const definition = { title: 'Revision fixture', nodes: [{ key: 'root', kind: 'container', label: 'Root' },
  { key: 'build', kind: 'leaf', label: 'Build', parent: 'root' },
  { key: 'test', kind: 'leaf', label: 'Test', parent: 'root' }],
  edges: [{ kind: 'prerequisite', from: 'build', to: 'test' }] }
const policy = { objective: 'Build and test', requirements: [{ id: 'correct', text: 'Keep functional validation' }] }
const verdict = { verdict: 'APPROVE', reason: 'The missing prerequisite is justified.', violations: [] }
const code = name => error => error.code === name
function fixture() {
  const store = new MemoryGraphStore(), graph = new TransactionGraph(store)
  graph.create({ definition, operationId: 'create' })
  return { store, graph }
}
function proposal(snapshot) {
  const next = copy(snapshot.taskGraph)
  next.nodes.push({ key: 'inspect', kind: 'leaf', label: 'Inspect evidence', parent: 'root' })
  next.edges.push({ kind: 'prerequisite', from: 'inspect', to: 'build' })
  return { disposition: 'REVISE', trigger: 'MISSING_DEPENDENCY', reason: 'Evidence revealed an omitted preparation step.',
    evidenceIds: ['fact'], taskGraph: next, contextGraph: null,
    coverage: [{ requirement: 'correct', tasks: ['build', 'test'] }], retirements: [], invalidateReports: [] }
}
function coordinator(f, runRole, options = {}) {
  return new RevisionCoordinator({ policy, runRole, adapter: {
    snapshot: () => ({ revision: f.store.read().revision, checksum: f.store.read().checksum, linked: false,
      taskGraph: planDefinition(f.store.read().state.plan), active: f.store.read().state.active }),
    verifyFacts: () => {},
    prepare: p => ({ plan: revisedPlan(f.store.read(), p.taskGraph) }),
    commit: (prepared, review) => f.graph.revise({ expectedRevision: review.baseRevision, operationId: 'revise', plan: prepared.plan, review }),
    ...options,
  } })
}
const request = { expectedRevision: 1, facts: [{ id: 'fact', text: 'The parser requires a prepared grammar.' }], reason: 'Fix omitted preparation.' }

test('updater and reviewer receive separate contexts serially, approval appends one event preserving IDs', async () => {
  const f = fixture(), before = f.store.read(), calls = []
  const c = coordinator(f, async r => {
    calls.push(r)
    const input = JSON.parse(r.messages[1].content)
    assert.equal(r.messages.length, 2)
    return r.role === 'updater' ? proposal(input.snapshot) : verdict
  })
  const result = await c.run(request)
  assert.equal(result.status, 'COMMITTED'); assert.equal(result.revision, 2)
  assert.deepEqual(calls.map(row => row.role), ['updater', 'reviewer'])
  assert.notEqual(calls[0].runId, calls[1].runId)
  assert.match(calls[1].messages[0].content, /独立/)
  assert.deepEqual(f.store.read().events.slice(0, -1), before.events)
  for (const node of before.state.plan.nodes) assert.equal(f.store.read().state.plan.nodes.find(row => row.key === node.key).id, node.id)
  f.graph.begin({ expectedRevision: 2, operationId: 'after_revision', choice: f.graph.read().legalNext.findIndex(row => row.label === 'Inspect evidence') })
  assert.equal(f.graph.read().active.nodeId, f.store.read().state.plan.nodes.find(row => row.key === 'inspect').id)
})

for (const mode of ['REJECT', 'NEEDS_USER', 'NO_CHANGE']) test(`${mode} preserves every ledger byte`, async () => {
  const f = fixture(), before = f.store.read(), roles = []
  const c = coordinator(f, async r => {
    roles.push(r.role)
    const p = proposal(JSON.parse(r.messages[1].content).snapshot)
    return r.role === 'updater' ? mode === 'NO_CHANGE' ? { ...p, disposition: mode, taskGraph: null } : p : { ...verdict, verdict: mode }
  })
  assert.equal((await c.run(request)).status, mode)
  assert.deepEqual(f.store.read(), before)
  assert.equal(roles.length, mode === 'NO_CHANGE' ? 1 : 2)
})

for (const [name, alter, expected] of [
  ['requirement deletion', p => { p.coverage = [] }, 'REVISION_REQUIREMENT_COVERAGE'],
  ['invented evidence', p => { p.evidenceIds = ['invented'] }, 'REVISION_UNKNOWN_EVIDENCE'],
  ['cycle', p => p.taskGraph.edges.push({ kind: 'prerequisite', from: 'test', to: 'build' }), 'PREREQUISITE_ROUTE_OR_COMPLETION_CYCLE'],
  ['unjustified retirement', p => { p.taskGraph.nodes = p.taskGraph.nodes.filter(row => row.key !== 'test'); p.taskGraph.edges = []; p.coverage[0].tasks = ['build'] }, 'REVISION_RETIREMENT_COVERAGE'],
  ['permission/goal expansion', p => { p.trigger = 'USER_CHANGE' }, 'REVISION_NEW_AUTHORIZATION_REQUIRED'],
]) test(`${name} fails before reviewer invocation`, async () => {
  const f = fixture(), before = f.store.read(), roles = []
  const c = coordinator(f, async r => { roles.push(r.role); const p = proposal(JSON.parse(r.messages[1].content).snapshot); alter(p); return p })
  await assert.rejects(c.run(request), code(expected)); assert.deepEqual(roles, ['updater']); assert.deepEqual(f.store.read(), before)
})

test('approval cannot race changed authority, evidence, or graph revision', async () => {
  for (const mode of ['authority', 'evidence', 'graph']) {
    const f = fixture(), before = f.store.read(); let authority = 1, evidence = true
    const c = coordinator(f, async r => {
      if (r.role === 'updater') return proposal(JSON.parse(r.messages[1].content).snapshot)
      if (mode === 'authority') authority++
      if (mode === 'evidence') evidence = false
      if (mode === 'graph') f.graph.begin({ expectedRevision: 1, operationId: 'concurrent_begin', choice: 0 })
      return verdict
    }, { authority: () => authority, verifyFacts: () => { if (!evidence) throw Error('EVIDENCE_CHANGED') } })
    await assert.rejects(c.run(request))
    if (mode !== 'graph') assert.deepEqual(f.store.read(), before)
    else assert.equal(f.store.read().events.at(-1).type, 'BEGUN')
  }
})

test('active and finished work cannot be rewritten and retired task keys cannot be reused', () => {
  const f = fixture()
  f.graph.begin({ expectedRevision: 1, operationId: 'begin', choice: 0 })
  assert.throws(() => revisedPlan(f.store.read(), definition), code('REVISION_REQUIRES_NO_ACTIVE_ATTEMPT'))
  f.graph.finish({ expectedRevision: 2, operationId: 'finish', outcome: 'incomplete', note: 'Known unsatisfied work' })
  const changed = copy(definition); changed.nodes[1].label = 'Rewrite old outcome'
  assert.throws(() => revisedPlan(f.store.read(), changed), code('STARTED_TASK_IMMUTABLE'))
})

test('reentrant revision and cancelled updater never invoke reviewer or commit', async () => {
  const f = fixture(), abort = new AbortController(); let c, calls = 0
  c = coordinator(f, async r => {
    calls++; await assert.rejects(c.run(request), code('REVISION_SERIAL_EXECUTION_REQUIRED'))
    abort.abort(Error('cancelled')); return proposal(JSON.parse(r.messages[1].content).snapshot)
  })
  await assert.rejects(c.run({ ...request, signal: abort.signal }), /cancelled/)
  assert.equal(calls, 1); assert.equal(f.store.read().revision, 1)
})

test('a draft changed after independent approval cannot use that approval to commit',async()=>{
 const f=fixture(),before=f.store.read();
 const c=coordinator(f,async r=>r.role==='updater'?proposal(JSON.parse(r.messages[1].content).snapshot):verdict,
  {revalidate:prepared=>{prepared.plan.nodes.find(row=>row.key==='inspect').label='Unreviewed change';}});
 await assert.rejects(c.run(request),code('REVISION_APPROVED_DRAFT_MISMATCH'));assert.deepEqual(f.store.read(),before);
});

test('root descriptive labels may change while root identity stays fixed',()=>{
 const f=fixture(),before=f.store.read(),next=copy(definition);next.nodes[0].label='Clarified project description';
 const plan=revisedPlan(before,next);assert.equal(plan.nodes[0].id,before.state.plan.nodes[0].id);assert.equal(plan.nodes[0].label,next.nodes[0].label);
 next.nodes[0].key='replacement_root';for(const node of next.nodes.slice(1))node.parent='replacement_root';
 assert.throws(()=>revisedPlan(before,next),code('REVISION_ROOT_IMMUTABLE'));
});
