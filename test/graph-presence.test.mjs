import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DynamicContextGraph } from '../core.mjs'
import { FileGraphStore } from 'dsh-better-task-grapth/store'
import { runtimeProposal } from '../testing/runtime-harness.mjs'

function fixture(t) {
  const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'graph-presence-')))
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }))
  const options = { projectRoot, directory: path.join(projectRoot, 'ledger') }
  return { graph: new DynamicContextGraph(options), options }
}
test('absence before any commit is a fresh workflow and invalid proposals leave no commit witness', t => {
  const { graph } = fixture(t)
  assert.equal(graph.store.presence().state, 'NEVER_CREATED')
  const bad = runtimeProposal([]); bad.contextGraph.bindings = []
  assert.throws(() => graph.submit(bad))
  assert.equal(fs.existsSync(graph.store.witness.file), false)
  assert.equal(graph.read(), null)
})
for (const [kind, damage] of [
  ['BOTH_GRAPHS_LOST', (graph) => fs.unlinkSync(graph.store.file)],
  ['TASK_GRAPH_LOST', (graph, state) => { delete state.graph; fs.writeFileSync(graph.store.file, JSON.stringify(state)) }],
  ['CONTEXT_GRAPH_LOST', (graph, state) => { delete state.contexts; fs.writeFileSync(graph.store.file, JSON.stringify(state)) }],
  ['INVALID_AFTER_COMMIT', graph => fs.writeFileSync(graph.store.file, '{truncated')],
]) test(`${kind} blocks creation and restores exact state without releasing or replaying the active leaf`, t => {
  const { graph, options } = fixture(t)
  graph.submit(runtimeProposal([])); graph.begin({ expectedRevision: 1, choice: 0 })
  const before = graph.read(); damage(graph, structuredClone(before))
  // Also exercise fresh process objects; the evidence must be durable, not a JS flag.
  const reopened = new DynamicContextGraph(options), plan = reopened.store.recoveryPlan()
  assert.equal(plan.state, kind); assert.equal(plan.previouslyCommitted, true)
  assert.equal(plan.canRestore, true); assert.equal(plan.activeAttemptPreserved, true)
  assert.throws(() => reopened.submit(runtimeProposal([])), /GRAPH_RECOVERY_REQUIRED/)
  assert.throws(() => reopened.begin({ expectedRevision: 2, choice: 0 }), /GRAPH_RECOVERY_REQUIRED/)
  assert.throws(() => reopened.store.restore('0'.repeat(64)), /GRAPH_RECOVERY_WITNESS_CHANGED/)
  const recovered = reopened.store.restore(plan.expectedWitnessChecksum)
  assert.equal(recovered.executionResumed, false); assert.equal(recovered.activeAttemptPreserved, true)
  assert.deepEqual(reopened.read(), before)
  if (kind !== 'BOTH_GRAPHS_LOST') assert.ok(fs.existsSync(recovered.preservedDamagedFile))
  assert.throws(() => reopened.begin({ expectedRevision: 2, choice: 0 }))
})
test('a missing or corrupt witness never authorizes graph replacement', t => {
  const { graph } = fixture(t); graph.submit(runtimeProposal([]))
  const witness = fs.readFileSync(graph.store.witness.file)
  fs.unlinkSync(graph.store.witness.file)
  assert.equal(graph.store.presence().state, 'COMMIT_WITNESS_MISSING')
  assert.throws(() => graph.read(), /GRAPH_RECOVERY_REQUIRED/)
  fs.writeFileSync(graph.store.witness.file, witness)
  fs.writeFileSync(graph.store.witness.file, '{truncated')
  assert.equal(graph.store.presence().state, 'WITNESS_INVALID')
  assert.equal(graph.store.recoveryPlan().canRestore, false)
})
test('prepared receipt reconciles only a published exact candidate; otherwise stays uncertain', t => {
  const { graph } = fixture(t); graph.submit(runtimeProposal([]))
  const state = graph.read(), witness = graph.store.witness.read()
  graph.store.writeWitness(witness, 'PREPARED', state, state.checksum)
  assert.equal(graph.store.presence().state, 'READY')
  assert.equal(graph.store.witness.read().phase, 'COMMITTED')
  graph.store.writeWitness(graph.store.witness.read(), 'PREPARED', state, '0'.repeat(64))
  assert.equal(graph.store.presence().state, 'COMMIT_REQUIRES_RECONCILIATION')
  assert.equal(graph.store.recoveryPlan().canRestore, false)
  assert.throws(() => graph.read(), /GRAPH_RECOVERY_REQUIRED/)
})
test('first interrupted creation is uncertainty even when no graph has ever committed', t => {
  const { graph } = fixture(t)
  graph.store.writeWitness(null, 'PREPARED', null, '0'.repeat(64))
  assert.equal(graph.store.presence().state, 'COMMIT_REQUIRES_RECONCILIATION')
  assert.throws(() => graph.submit(runtimeProposal([])), /GRAPH_RECOVERY_REQUIRED/)
})
test('valid older graph and newer witness are a conflict, never a fresh graph', t => {
  const { graph } = fixture(t); graph.submit(runtimeProposal([])); const old = graph.read()
  graph.begin({ expectedRevision: 1, choice: 0 })
  fs.writeFileSync(graph.store.file, JSON.stringify(old))
  assert.equal(graph.store.presence().state, 'GRAPH_WITNESS_CONFLICT')
  assert.throws(() => graph.read(), /GRAPH_RECOVERY_REQUIRED/)
})

test('only identical persisted bytes reuse graph validation and each caller gets its own snapshot', t => {
  const { graph } = fixture(t)
  graph.submit(runtimeProposal([]))
  const raw = graph.store.raw, validator = raw.validator
  let validations = 0
  raw.validator = value => { validations++; validator(value) }
  const first = graph.read()
  first.graph.events.length = 0
  assert.equal(graph.read().graph.events.length, 1)
  assert.equal(validations, 1)

  const before = fs.readFileSync(raw.file, 'utf8'), stat = fs.statSync(raw.file)
  const checksum = JSON.parse(before).checksum
  const changed = before.replace(checksum, (checksum[0] === '0' ? '1' : '0') + checksum.slice(1))
  assert.equal(changed.length, before.length)
  fs.writeFileSync(raw.file, changed)
  fs.utimesSync(raw.file, stat.atime, stat.mtime)
  assert.equal(graph.store.presence().state, 'INVALID_AFTER_COMMIT')
  assert.equal(validations, 2)
  assert.throws(() => graph.read(), /GRAPH_RECOVERY_REQUIRED/)
})

test('store preparation runs under the lock after validation and cannot change the published value', t => {
  const { options } = fixture(t)
  const store = new FileGraphStore({ ...options, fileName: 'prepared-test.json',
    validator: next => assert.equal(next.revision, 1), updateValidator: (_previous, next) => {
      if (next.data !== 'valid') throw Error('candidate rejected')
    } })
  const prepare = () => assert.fail('an invalid candidate must not prepare an external commit')
  assert.throws(() => store.compareAndSwapPrepared(0, () => ({ revision: 1, data: 'invalid' }), prepare), /candidate rejected/)
  assert.throws(() => store.compareAndSwapPrepared(0, () => ({ revision: 1, data: 'valid' }), () => { throw Error('prepare failed') }), /prepare failed/)
  assert.equal(store.read(), null)
  const next = store.compareAndSwapPrepared(0, () => ({ revision: 1, data: 'valid' }), (previous, candidate) => {
    assert.equal(previous, null)
    assert.ok(fs.existsSync(store.lock))
    candidate.data = 'modified copy'
  })
  assert.equal(next.data, 'valid')
  assert.deepEqual(store.read(), next)
})
