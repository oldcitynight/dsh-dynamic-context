// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { digest, normalizePlan } from 'dsh-better-task-grapth/core'
import { defaultWorkflowLimits } from 'dsh-better-task-grapth/workflow-limits'
import { DynamicContextGraph, proposalSchema } from '../core.mjs'
import { unitSnapshotCodec, unitWitnessCodec } from '../unit-storage.mjs'
import { RolePromptRegistry, assertPreloadBudget } from '../role-policy.mjs'
import { materialBundle, materialLimit } from '../context-budget.mjs'
import { unitRouteInput } from '../unit-roles.mjs'
import { guidanceActivation } from '../user-guidance.mjs'
import { prepareRuleSubmission } from '../rule-audit.mjs'
import { createHarness } from '../testing/harness.mjs'
import { unitBackend, unitReport, unitSeed } from '../testing/unit-proposal.mjs'

const temporary = t => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'unit-policy-')))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}
const approval = proposal => ({ verdict: 'APPROVE', proposalHash: digest(proposal), runId: 'approval', reason: 'Verified fixture.' })

test('configured unit count and recursion exceed old limits, including exact boundaries', () => {
  assert.deepEqual(defaultWorkflowLimits, { maxUnits: 512, maxDepth: 32, preloadBytes: 10240, dynamicMaterialBytes: 65536 })
  const chain = depth => ({ title: 'Chain', hierarchy: { version: 2 }, ruleVersion: 1, edges: [],
    nodes: Array.from({ length: depth + 1 }, (_, i) => ({ key: 'u' + i, label: 'unit', kind: 'unit',
      ...(i ? { parent: 'u' + (i - 1) } : {}), ...(i < depth ? { terminal: 'u' + (i + 1), acceptance: 'verify' } : {}) })) })
  assert.equal(normalizePlan(chain(0), { workflowLimits: { maxDepth: 0 } }).nodes.length, 1)
  assert.throws(() => normalizePlan(chain(1), { workflowLimits: { maxDepth: 0 } }), { code: 'UNIT_DEPTH_LIMIT' })
  assert.equal(normalizePlan(chain(32)).nodes.length, 33)
  assert.throws(() => normalizePlan(chain(33)), { code: 'UNIT_DEPTH_LIMIT' })
  assert.equal(normalizePlan(chain(33), { workflowLimits: { maxDepth: 33 } }).nodes.length, 34)
  const wide = chain(1)
  wide.nodes.push(...Array.from({ length: 511 }, (_, i) => ({ key: 'extra' + i, kind: 'unit', label: 'check', parent: 'u0' })))
  assert.throws(() => normalizePlan(wide), { code: 'UNIT_LIMIT' })
  assert.equal(normalizePlan(wide, { workflowLimits: { maxUnits: 513 } }).nodes.length, 513)
})

test('aggregate UTF-8 thresholds use the configured value across slots and material fields', () => {
  const p = new RolePromptRegistry(12), entry = { pluginId: 'plugin', registrationId: 'r', role: 'unit_planner', mode: 'append' }
  p.register({ ...entry, text: '😀😀' })
  p.registerProvider({ ...entry, slot: 'tools', registrationId: 's', assemble: () => 'abc' })
  assert.throws(() => assertPreloadBudget(p.resolve(entry.role, 'base'), p.resolve(entry.role, '', {}, 'tools')), /ROLE_PRELOAD_LIMIT/)
  const data = { reports: ['😀'], facts: ['中'] }, size = Buffer.byteLength(JSON.stringify(data))
  assert.equal(materialLimit({ workflowLimits: { dynamicMaterialBytes: size }, direct: { maxRequestBytes: 1 } }), size)
  assert.equal(materialBundle(data, size), null)
  assert.equal(materialBundle(data, size - 1).text, JSON.stringify(data))
})

test('file state and witness round-trip large existing v2 snapshots and retain original event hashes', t => {
  const root = temporary(t), config = { projectRoot: root, directory: path.join(root, 'state'),
    workflowLimits: { maxUnits: 1, maxDepth: 1 }, supervision: true }
  const graph = new DynamicContextGraph(config), seed = unitSeed()
  seed.contextGraph.nodes[0].content = 'a'.repeat(4 * 1024 * 1024 + 32)
  for (let i = 0; i < 40; i++) seed.contextGraph.nodes.push({ key: 'ctx' + i, content: 'data' })
  seed.contextGraph.bindings[0].contexts = seed.contextGraph.nodes.map(n => n.key)
  seed.contextGraph.bindings[0].baseline.facts = Array.from({ length: 40 }, () => 'fact'.repeat(2100))
  seed.contextGraph.bindings[0].unit = 'root'
  delete seed.contextGraph.bindings[0].task
  seed.taskGraph.nodes[0].kind = 'unit'
  const proposal = proposalSchema.parse(seed), saved = graph.submit(proposal, approval(proposal))
  const file = graph.store.file, witnessFile = graph.store.witness.file, raw = JSON.parse(fs.readFileSync(file))
  assert.equal(raw.storageFormat, 'units-v2')
  assert.equal(raw.graph.events[0].data.plan.nodes[0].kind, 'unit')
  assert.equal(raw.graph.events[0].data.plan.hierarchy.maxDepth, 1)
  assert.equal(raw.contexts.bindings[0].unitId, saved.graph.state.plan.nodes[0].id)
  assert.equal(Object.hasOwn(raw.graph.state, 'leaves'), false)
  assert.deepEqual(unitSnapshotCodec.decode(raw), saved)
  const witness = JSON.parse(fs.readFileSync(witnessFile))
  assert.equal(witness.committed.storageFormat, 'units-v2')
  const route = unitRouteInput({ graph, config: { revision: { policy: {} } } }, saved, saved.graph.state.plan.nodes[0])
  assert.deepEqual(route.capacity.allowedActions, ['EXECUTE'])
  fs.writeFileSync(file, JSON.stringify(saved))
  fs.writeFileSync(witnessFile, JSON.stringify(unitWitnessCodec.decode(witness)))
  const reopened = new DynamicContextGraph(config)
  assert.deepEqual(reopened.read(), saved)
  reopened.updateSupervision(saved, { ...saved.supervision, phase: 'READY' })
  const migrated = JSON.parse(fs.readFileSync(file))
  assert.equal(migrated.storageFormat, 'units-v2')
  assert.deepEqual(migrated.graph.events, raw.graph.events)
  assert.deepEqual(new DynamicContextGraph(config).read(), reopened.read())
})

test('a 512-unit audited plan commits all unit bindings through SQLite and targeted planning roles', async t => {
  const root = temporary(t), projectRoot = path.join(root, 'project')
  fs.mkdirSync(projectRoot)
  const keys = Array.from({ length: 511 }, (_, i) => 'child' + i), admissions = new Set()
  const respond = unitBackend(() => ({ text: JSON.stringify(unitReport('Checked.')) }), { plan: { keys } })
  const h = await createHarness({ projectRoot, directory: path.join(root, 'state'), config: { storageRoot: root,
    storageFormat: 'sqlite', transport: 'direct', supervision: true, supervisionContext: 'reports', timeoutMs: null,
    revision: { policy: { objective: 'Verify the fixture', requirements: [{ id: 'result', text: 'Check each unit' }] } },
    direct: { durable: true } }, respond: request => {
    const sys = request.payload.messages[0].content
    const role = sys.includes('DYNAMIC_CONTEXT_SCOPE_UPDATE_V1') ? 'unit_planner' : sys.includes('DYNAMIC_CONTEXT_SCOPE_AUDIT_V1') ? 'unit_plan_audit' : null
    if (role) {
      const state = h.runner.graph.read(), scopeId = state.graph.state.plan.nodes[0].id
      assert.ok(state.supervision.roleRunId.startsWith('revision_' + role + '_'))
      assert.equal(guidanceActivation(h.runner, { role, unitId: scopeId }).ready, true)
      admissions.add(role)
    }
    return respond(request)
  } })
  try {
    const runner = h.runner
    runner.submit(await prepareRuleSubmission(runner, unitSeed(), undefined, new AbortController().signal))
    await runner.runNext({ expectedRevision: runner.graph.read().revision })
    const db = runner.storage.db, raw = JSON.parse(db.range(db.info('graph/state')))
    assert.equal(raw.graph.state.plan.nodes.length, 512)
    assert.equal(Object.keys(raw.graph.state.units).length, 512)
    assert.equal(new Set(raw.contexts.bindings.map(row => row.unitId)).size, 512)
    assert.equal(raw.graph.state.plan.hierarchy.maxDepth, 32)
    assert.equal(raw.graph.state.plan.nodes[0].mode, 'planned')
    assert.equal(raw.graph.state.plan.nodes[0].kind, 'unit')
    assert.deepEqual(new Set(['unit_planner', 'unit_plan_audit']), admissions)
    assert.deepEqual(unitSnapshotCodec.decode(raw), runner.graph.read())
    assert.deepEqual(unitWitnessCodec.decode(JSON.parse(db.range(db.info('graph/witness')))).committed, runner.graph.read())
  } finally { await h.close() }
})
