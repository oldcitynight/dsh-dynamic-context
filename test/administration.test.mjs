import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { createRuntimeHarness, runtimeProposal } from '../testing/runtime-harness.mjs'
import { DirectJournal } from '../durable-store.mjs'

async function fixture(t, options = {}) {
  const storageRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-runtime-admin-'))), projectRoot = path.join(storageRoot, 'workspace')
  fs.mkdirSync(projectRoot)
  const h = await createRuntimeHarness({ projectRoot, directory: path.join(storageRoot, 'state'),
    respond: () => ({ tools: [{ name: 'write', arguments: { file_path: 'effect.txt', content: 'effect survived\n' } }] }),
    setup: ctx => ctx.on('tools/execute', async (exec, next) => { const value = await next(); if (exec.name === 'write') throw new Error('Injected interruption after actual effect'); return value }),
    ...options, config: { storageRoot, ...options.config, direct: { durable: true, ...options.config?.direct } } })
  t.after(async () => { await h.close(); fs.rmSync(storageRoot, { recursive: true, force: true }) })
  return { ...h, storageRoot, projectRoot }
}
const proof = h => {
  const ref = path.join(h.storageRoot, 'operator-receipt.json'), body = JSON.stringify({ fixture: true, quiescent: true, acceptance: 'UNVERIFIED' })
  fs.writeFileSync(ref, body)
  return { kind: 'artifact', ref, sha256: createHash('sha256').update(body).digest('hex') }
}
const ticket = h => ({ expectedRevision: h.runner.graph.read().revision, expectedAttemptId: h.runner.graph.read().graph.state.active.attemptId,
  checkpointChecksum: h.runner.checkpointStatus().checksum, note: 'Operator confirmed all work stopped; original effects remain unverified.' })
async function interrupted(h, sourceAgent) {
  const proposal = runtimeProposal(['write'])
  proposal.taskGraph.nodes.push({ key: 'dependent', kind: 'leaf', label: 'Dependent', parent: 'root' })
  proposal.taskGraph.edges.push({ kind: 'prerequisite', from: 'task', to: 'dependent' })
  proposal.contextGraph.bindings.push({ task: 'dependent', instruction: 'Wait for verified predecessor.', contexts: [], tools: [], inheritReports: ['task'] })
  h.runner.submit(proposal)
  await assert.rejects(h.runner.runNext({ expectedRevision: 1, sourceAgent }), /DIRECT_TOOL_EXECUTION_FAILED/)
}

test('reconciliation requires a trusted current host receipt and never retries or upgrades an unknown effect', async t => {
  const h = await fixture(t); await interrupted(h)
  assert.equal(fs.readFileSync(path.join(h.projectRoot, 'effect.txt'), 'utf8'), 'effect survived\n')
  const request = ticket(h)
  await assert.rejects(h.runner.reconcileActive(request), /DIRECT_TRUSTED_RECONCILIATION_REQUIRED/)
  const reference = proof(h)
  h.runner.registerReconciliationVerifier({ version: 'fixture-operator-v1', verify: async value => {
    assert.equal(value.disposition, 'UNSATISFIED'); assert.equal(value.checkpointChecksum, request.checkpointChecksum)
    return { confirmedQuiescent: true, closeUnverified: true, evidence: [reference] }
  } })
  const result = await h.runner.reconcileActive(request)
  assert.equal(result.disposition, 'UNSATISFIED'); assert.equal(result.revision, 3)
  const state = h.runner.graph.read()
  assert.equal(state.graph.state.active, null); assert.equal(state.reports.length, 0)
  assert.equal(Object.values(state.graph.state.leaves).find(row => row.attemptId === request.expectedAttemptId).disposition, 'UNSATISFIED')
  assert.equal(h.runner.graph.status().legalNext.length, 0)
  assert.equal(h.backend.requests.length, 1)
  await assert.rejects(h.runner.reconcileActive(request), /DIRECT_RECONCILE_STALE_OR_DIFFERENT_ATTEMPT/)
})

for (const defect of ['denied', 'bad-artifact']) test(`unattested reconciliation remains ACTIVE (${defect})`, async t => {
  const h = await fixture(t); await interrupted(h)
  const reference = proof(h), before = ticket(h)
  h.runner.registerReconciliationVerifier({ version: 'fixture-operator-v1', verify: async () => ({
    confirmedQuiescent: defect !== 'denied', closeUnverified: true,
    evidence: [{ ...reference, ...(defect === 'bad-artifact' ? { sha256: '0'.repeat(64) } : {}) }],
  }) })
  await assert.rejects(h.runner.reconcileActive(before), defect === 'denied' ? /DIRECT_RECONCILIATION_NOT_ATTESTED/ : /ARTIFACT_CHANGED_OR_HASH_MISMATCH/)
  assert.equal(h.runner.graph.read().revision, 2)
  assert.equal(h.runner.checkpointStatus().checksum, before.checkpointChecksum)
  assert.equal(h.backend.requests.length, 1)
})

test('new controller input invalidates an outstanding reconciliation approval', async t => {
  const h = await fixture(t)
  const controller = await h.ctx.agents.create({ sessionId: 'operator-controller', meta: { cwd: h.projectRoot } })
  t.after(() => controller.dispose())
  await interrupted(h, controller.agent)
  const reference = proof(h)
  h.runner.registerReconciliationVerifier({ version: 'fixture-operator-v1', verify: async () => {
    controller.agent.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'New instruction while approval was pending.' }] }), { surfaceOp: 'append' })
    return { confirmedQuiescent: true, closeUnverified: true, evidence: [reference] }
  } })
  await assert.rejects(h.runner.reconcileActive({ ...ticket(h), sourceAgent: controller.agent }), /DIRECT_RECONCILE_STATE_CHANGED/)
  assert.equal(h.runner.graph.read().revision, 2)
})

test('changed controller permissions invalidate an outstanding reconciliation approval', async t => {
  const h = await fixture(t)
  const controller = await h.ctx.agents.create({ sessionId: 'policy-operator-controller', meta: { cwd: h.projectRoot } })
  t.after(() => controller.dispose())
  await interrupted(h, controller.agent)
  const reference = proof(h)
  h.runner.registerReconciliationVerifier({ version: 'fixture-operator-v1', verify: async () => {
    setSandboxMode(controller.agent.session, 'read-only')
    return { confirmedQuiescent: true, closeUnverified: true, evidence: [reference] }
  } })
  await assert.rejects(h.runner.reconcileActive({ ...ticket(h), sourceAgent: controller.agent }), /DIRECT_RECONCILE_STATE_CHANGED/)
  assert.equal(h.runner.graph.read().revision, 2)
})

test('maintenance removes only the exact previewed orphan and preserves every committed checkpoint and report', async t => {
  const h = await fixture(t, { respond: () => ({ text: 'Completed report, still unverified.' }), setup: () => {} })
  h.runner.submit(runtimeProposal([]))
  const result = await h.runner.runNext({ expectedRevision: 1 })
  const journal = DirectJournal.open(result.runDirectory, { attemptId: result.report.attemptId })
  const orphan = journal.archive([{ role: 'tool', content: 'Unreferenced interrupted-write fixture' }])
  const reportProof = fs.readFileSync(result.report.evidence[0].ref)
  const head = journal.latest().checksum
  const preview = await h.runner.collectOrphans({ expectedRevision: 3 })
  assert.deepEqual(preview.files.map(row => row.ref), [orphan.ref])
  await assert.rejects(h.runner.collectOrphans({ expectedRevision: 3, planChecksum: '0'.repeat(64) }), /DIRECT_MAINTENANCE_PLAN_CHANGED/)
  assert.equal(fs.existsSync(orphan.ref), true)
  const cleaned = await h.runner.collectOrphans({ expectedRevision: 3, planChecksum: preview.planChecksum })
  assert.equal(cleaned.removed, 1); assert.equal(fs.existsSync(orphan.ref), false)
  assert.equal(journal.latest().checksum, head)
  assert.deepEqual(fs.readFileSync(result.report.evidence[0].ref), reportProof)
  assert.equal(journal.loadCheckpoint(journal.latest()).reportText, result.report.text)
})

test('maintenance preserves a source archive explicitly committed as a reconciliation receipt', async t => {
  const h = await fixture(t); await interrupted(h)
  const request = ticket(h)
  const journal = DirectJournal.open(path.join(h.runner.config.directory, request.expectedAttemptId), { attemptId: request.expectedAttemptId })
  const receipt = journal.archive([{ role: 'tool', content: 'Fixture operator confirmed stopped work; effects remain unverified.' }])
  h.runner.registerReconciliationVerifier({ version: 'fixture-operator-archive-v1', verify: async () => ({
    confirmedQuiescent: true, closeUnverified: true, evidence: [{ kind: 'artifact', ref: receipt.ref, sha256: receipt.sha256 }],
  }) })
  await h.runner.reconcileActive(request)
  const plan = await h.runner.collectOrphans({ expectedRevision: 3 })
  assert.deepEqual(plan.files, [])
  await h.runner.collectOrphans({ expectedRevision: 3, planChecksum: plan.planChecksum })
  assert.equal(fs.existsSync(receipt.ref), true)
})

test('a journal storage budget halts snapshot growth without replaying or completing the task', async t => {
  const h = await fixture(t, { respond: () => ({ tools: [{ name: 'read', arguments: { file_path: 'long.txt' } }] }), setup: () => {},
    config: { allowedTools: ['read', 'dynamic_context_source_read'], maxContextCharacters: 96000, maxRequestsPerTask: 16,
      direct: { maxJournalBytes: 1048576, compaction: { triggerCharacters: 50000, maxCheckpointCharacters: 12000, maxCompactions: 8 } } } })
  fs.writeFileSync(path.join(h.projectRoot, 'long.txt'), Array.from({ length: 400 }, (_, i) => `line-${i}: ${'x'.repeat(90)}`).join('\n'))
  h.runner.submit(runtimeProposal(['read', 'dynamic_context_source_read']))
  await assert.rejects(h.runner.runNext({ expectedRevision: 1 }), /DIRECT_JOURNAL_STORAGE_BUDGET/)
  assert.ok(h.backend.requests.length < 16)
  assert.ok(h.runner.checkpointStatus().storageBytes <= 1048576)
  assert.ok(h.runner.graph.read().graph.state.active)
  assert.equal(h.runner.graph.read().reports.length, 0)
  await assert.rejects(h.runner.collectOrphans({ expectedRevision: 2 }), /DIRECT_MAINTENANCE_ACTIVE_ATTEMPT/)
})
