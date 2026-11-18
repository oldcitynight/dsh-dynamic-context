import test from 'node:test'
import assert from 'node:assert/strict'
import { foldMetadata, completedIndex, foldPlan, foldStats } from '../client-enhancements.mjs'
const snapshot = (status = 'COMPLETE', revision = 1) => ({ sessionId: 'chat', status: 'ready', execution: { workflowId: 'wf' },
  graph: { revision, nodes: [{ id: 'leaf', kind: 'leaf', label: '测试任务', status }, { id: 'group', kind: 'container', status: 'COMPLETE' }] } })
const index = completedIndex(snapshot(), 'chat')
function fixture(specs) {
  const nodes = new Map(), entries = specs.map((s, i) => {
    const e = { key: 'n' + i, kind: s.nativeGroup ? 'group' : 'node' }
    nodes.set(e.key, { data: s.user || s.nativeGroup ? {} : { dynamicContextFold: foldMetadata(s.wf ?? 'wf', {
      taskId: 'leaf', taskLabel: '测试任务', sessionId: 'run', step: 1, stage: 'EXECUTING', state: 'complete', ...s }) } })
    return e
  }); return { nodes, entries }
}
const flatten = parts => parts.flatMap(p => p.entries)
test('completion requires authoritative matching chat, workflow, revision and leaf', () => {
  assert.equal(completedIndex(snapshot(), 'other'), null)
  assert.equal(completedIndex({ ...snapshot(), status: 'unavailable' }, 'chat'), null)
  assert.equal(completedIndex(snapshot('COMPLETE', 0), 'chat', index), null)
  assert.equal(completedIndex(snapshot(), 'chat', index), index)
  assert.equal(index.leaves.has('group'), false)
  for (const status of ['READY', 'ACTIVE', 'BLOCKED', 'FAILED', 'CONTAINER_COMPLETE']) assert.equal(completedIndex(snapshot(status), 'chat').leaves.size, 0)
})
test('completed leaf includes execution and result review with nested phase folding', () => {
  const { entries, nodes } = fixture([{ step: 1 }, { step: 2 }, { step: 1, stage: 'result_check', sessionId: 'audit' }, { step: 2, stage: 'result_check', sessionId: 'audit' }])
  const p = foldPlan(entries, nodes, index)
  assert.equal(p.length, 1); assert.equal(p[0].type, 'leaf'); assert.equal(p[0].steps, 4)
  assert.deepEqual(p[0].children.map(p => p.type), ['steps', 'native', 'steps', 'native'])
  assert.deepEqual(flatten(p[0].children), entries)
})
test('active execution and review fold earlier steps but preserve entire latest step', () => {
  for (const stage of ['EXECUTING', 'result_check', 'scope_audit', 'group_audit', 'scope_plan']) {
    const { entries, nodes } = fixture([{ stage, step: 1 }, { stage, step: 2, kind: 'model' }, { stage, step: 2, kind: 'reasoning' }, { stage, step: 2, state: 'running', kind: 'tool' }])
    const p = foldPlan(entries, nodes, null)
    assert.equal(p[0].type, 'steps'); assert.equal(p[0].entries.length, 1)
    assert.equal(p[1].type, 'native'); assert.deepEqual(p[1].entries, entries.slice(1))
  }
})
test('messages, native groups and unrelated roles preserve chronological boundaries', () => {
  const { entries, nodes } = fixture([{ step: 1 }, { user: true }, { step: 2 }, { nativeGroup: true }, { stage: 'scope_plan' }, { taskId: 'group' }, { wf: 'another' }])
  const p = foldPlan(entries, nodes, index)
  assert.deepEqual(flatten(p), entries)
  assert.deepEqual(p.filter(p => p.type === 'leaf').flatMap(p => p.entries.map(e => e.key)), ['n0', 'n2'])
})
test('running, failed and interrupted steps stay visible while active', () => {
  const { entries, nodes } = fixture([{ step: 1, state: 'running' }, { step: 2, state: 'error' }, { step: 3, state: 'interrupted' }, { step: 4 }])
  assert.deepEqual(foldPlan(entries, nodes, null).map(p => p.type), ['native'])
  assert.equal(foldPlan(entries, nodes, index)[0].type, 'native')
})
test('rework removes completed outer fold; old attempts cannot absorb a newer attempt', () => {
  const { entries, nodes } = fixture([{ step: 1 }, { step: 2 }, { sessionId: 'rework', step: 1 }, { sessionId: 'rework', step: 2 }])
  const rework = completedIndex(snapshot('ACTIVE', 2), 'chat', index)
  const p = foldPlan(entries, nodes, rework)
  assert.equal(p.some(p => p.type === 'leaf'), false)
  assert.deepEqual(p.map(p => p.type), ['steps', 'native', 'steps', 'native'])
  assert.deepEqual(flatten(p), entries)
})
test('labels, values, node object identity and raw history are never mutated', () => {
  const { entries, nodes } = fixture([{ step: 1 }, { step: 2 }]); const before = JSON.stringify([...nodes])
  Object.freeze(entries); for (const e of entries) Object.freeze(e)
  const p = foldPlan(entries, nodes, index); assert.strictEqual(p[0].entries[0], entries[0]); assert.equal(JSON.stringify([...nodes]), before)
  assert.deepEqual(foldStats(p), { rawEntries: 2, defaultEntries: 1, hiddenEntries: 2, headers: 1, leafSections: 1, stepSections: 0 })
})
test('missing metadata, unknown stages and malformed steps fail open', () => {
  const { entries, nodes } = fixture([{ user: true }, { stage: 'future-role' }, { step: '1' }, { step: null }])
  assert.deepEqual(foldPlan(entries, nodes, index).map(p => p.type), ['native'])
})
test('contradictory active or blocked flag wins over COMPLETE label', () => {
  const active = snapshot(); active.graph.active = { nodeId: 'leaf' }
  const blocked = snapshot(); blocked.graph.nodes[0].blocked = true
  assert.equal(completedIndex(active, 'chat').leaves.size, 0)
  assert.equal(completedIndex(blocked, 'chat').leaves.size, 0)
})
