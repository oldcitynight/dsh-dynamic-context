import test from 'node:test'
import assert from 'node:assert/strict'
import { describeRevisionChanges } from '../revision.mjs'

test('removing a failed prerequisite does not describe its preserved binding as removed', () => {
  const taskGraph = { nodes: [{ key: 'a' }, { key: 'b' }], edges: [{ kind: 'prerequisite', from: 'a', to: 'b' }] }
  const nodes = [{ key: 'contract', content: 'fixed contract', parents: [] }, { key: 'source', content: 'old input', parents: [] }]
  const bindings = [{ task: 'a', instruction: 'Inspect', contexts: ['contract'], inheritReports: [], tools: ['read'], completion: { kind: 'report' } },
    { task: 'b', instruction: 'Build', contexts: ['source'], inheritReports: ['a'], tools: ['write'], completion: { kind: 'artifact', path: 'out' } }]
  const snapshot = { linked: true, taskGraph, contextGraph: { nodes, bindings } }
  const proposal = structuredClone(snapshot)
  proposal.taskGraph.edges = []
  proposal.contextGraph.nodes[0] = { key: 'contract', retain: true, sha256: 'a'.repeat(64) }
  proposal.contextGraph.nodes[1].content = 'new input'
  proposal.contextGraph.bindings[1].inheritReports = []
  const changed = describeRevisionChanges(snapshot, proposal)
  assert.equal(changed.prerequisiteEdgesRemoved.length, 1)
  assert.deepEqual(changed.taskNodesRemoved, [])
  assert.deepEqual(changed.contextNodesModified, ['source'])
  assert.deepEqual(changed.bindings, [{ task: 'b', kind: 'MODIFIED', fields: ['inheritReports'],
    beforePath: '/snapshot/contextGraph/bindings/1', afterPath: '/proposal/contextGraph/bindings/1' }])
  assert.equal(snapshot.taskGraph.edges.length, 1)
})

test('added and retired bindings have distinct paths and retained content is not a new edit', () => {
  const snapshot = { linked: true, taskGraph: { nodes: [{ key: 'old' }], edges: [] },
    contextGraph: { nodes: [{ key: 'fact', content: 'same', parents: [] }], bindings: [{ task: 'old', instruction: 'old' }] } }
  const proposal = { taskGraph: { nodes: [{ key: 'new' }], edges: [] },
    contextGraph: { nodes: [{ key: 'fact', retain: true, sha256: 'a'.repeat(64) }], bindings: [{ task: 'new', instruction: 'new' }] } }
  const changed = describeRevisionChanges(snapshot, proposal)
  assert.deepEqual(changed.contextNodesModified, [])
  assert.deepEqual(changed.bindings.map(row => [row.task, row.kind, row.beforePath, row.afterPath]), [
    ['old', 'REMOVED', '/snapshot/contextGraph/bindings/0', null], ['new', 'ADDED', null, '/proposal/contextGraph/bindings/0']])
})
