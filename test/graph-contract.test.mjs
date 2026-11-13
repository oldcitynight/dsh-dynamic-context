import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { DynamicContextGraph, validateState } from '../core.mjs'
import { createHarness, GLOBAL_PRIVATE } from '../testing/harness.mjs'
import { proposal, scenarioResponse } from '../testing/scenario.mjs'

function location(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-dynamic-context-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return { projectRoot: root, directory: path.join(root, 'state') }
}
async function harness(t, options = {}) {
  const h = await createHarness({ ...location(t), respond: scenarioResponse, ...options })
  t.after(() => h.close())
  return h
}
const payloadText = request => JSON.stringify(request.payload.messages)
const code = expected => error => error.code === expected

test('one invalid context graph never commits the valid task graph', t => {
  const graph = new DynamicContextGraph(location(t)), p = proposal()
  p.contextGraph.nodes[0].parents = ['missing']
  assert.throws(() => graph.submit(p), code('UNKNOWN_CONTEXT_REFERENCE'))
  assert.equal(graph.read(), null)
  assert.equal(graph.submit(proposal()).revision, 1)
  assert.equal(validateState(graph.read()).contexts.graphId, graph.status().graph.id)
})

for (const [name, change] of [
  ['cyclic context inheritance', p => { p.contextGraph.nodes[0].parents = ['a_private'] }],
  ['duplicate context keys', p => { p.contextGraph.nodes.push({ ...p.contextGraph.nodes[0] }) }],
  ['missing leaf binding', p => { p.contextGraph.bindings.pop() }],
  ['duplicate task binding', p => { p.contextGraph.bindings[2] = { ...p.contextGraph.bindings[1] } }],
  ['forward report inheritance', p => { p.contextGraph.bindings[0].inheritReports = ['b'] }],
  ['unrelated report inheritance', p => { p.taskGraph.edges = []; p.contextGraph.bindings[1].inheritReports = ['a'] }],
  ['unknown context binding', p => { p.contextGraph.bindings[0].contexts = ['absent'] }],
  ['model-proposed system role', p => { p.contextGraph.nodes[0].role = 'system' }],
]) test(`${name} is rejected before either graph is committed`, t => {
  const graph = new DynamicContextGraph(location(t)), p = proposal(); change(p)
  assert.throws(() => graph.submit(p))
  assert.equal(graph.read(), null)
})

test('stale begin leaves the joint graph byte-for-byte unchanged', t => {
  const graph = new DynamicContextGraph(location(t)); graph.submit(proposal())
  const before = graph.read()
  assert.throws(() => graph.begin({ expectedRevision: 0 }), code('CAS_CONFLICT'))
  assert.deepEqual(graph.read(), before)
  graph.begin({ expectedRevision: 1 })
  const assembled = graph.assemble()
  assert.deepEqual(assembled.contexts.map(row => row.key), ['common', 'a_private'])
  assert.equal(assembled.inheritedReports.length, 0)
  assert.equal(assembled.contexts[0].content, 'COMMON_CONTEXT_LITERAL_{{unchanged}}')
})

test('context proposal cannot expand the host tool authorization', async t => {
  const h = await harness(t), p = proposal()
  p.contextGraph.bindings[0].tools = ['fixture_forbidden']
  assert.throws(() => h.runner.submit(p), code('CONTEXT_CANNOT_GRANT_TOOL_PERMISSION'))
  assert.equal(h.runner.graph.read(), null)
  assert.equal(h.backend.requests.length, 0)
})
