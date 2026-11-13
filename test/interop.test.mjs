import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import TaskGraphPlugin from 'dsh-bettertaskgraphs'
import { createRuntimeHarness, runtimeProposal } from '../testing/runtime-harness.mjs'

async function fixture(t, { late = false, workflowOnly = false, respond, setup } = {}) {
  const storageRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-workflow-link-'))), projectRoot = path.join(storageRoot, 'workspace')
  fs.mkdirSync(projectRoot)
  const mount = async ctx => {
    await ctx.plugin(Persistence, { root: path.join(storageRoot, 'sessions') })
    await ctx.plugin(TaskGraphPlugin, { projectRoot })
    if (setup) await setup(ctx)
  }
  const h = await createRuntimeHarness({ projectRoot, directory: path.join(storageRoot, 'state'),
    respond: respond ?? (({ index }) => index === 1 ? { tools: [{ name: 'write', arguments: { file_path: 'linked.txt', content: 'one effect\n' } }] } : { text: 'Linked report; acceptance unverified.' }),
    config: { storageRoot, direct: { durable: true }, interop: { workflowId: 'linked-workflow' } }, taskGraph: !late,
    ...(!late ? { setup: mount } : {}) })
  t.after(async () => { await h.close(); fs.rmSync(storageRoot, { recursive: true, force: true }) })
  if (late) await mount(h.ctx)
  const controller = await h.ctx.agents.create({ sessionId: 'workflow-controller', meta: { cwd: projectRoot } })
  if (workflowOnly) {
    h.ctx.transactionGraph.registerSessionPolicy({ id: 'fixture', allowClassic: agent => agent !== controller.agent })
    controller.agent.ctx.tools.restrict({ deny: [...h.ctx.transactionGraph.host.definitions.keys()] })
  }
  t.after(() => controller.dispose())
  return { ...h, controller: controller.agent, api: h.ctx.transactionGraph, projectRoot,
    reference: { kind: 'dynamic-context', workflowId: 'linked-workflow' } }
}

test('generic base ports allow the extension to suppress the classic interface for one session', async t => {
  const h = await fixture(t, { workflowOnly: true })
  assert.equal(h.api.host.definitions.size, 5)
  assert.equal(h.ctx.tools.get('transaction_graph_create', h.controller), undefined)
  assert.equal(h.api.listWorkflows(h.controller).length, 1)
  const prompt = await h.ctx.systemPrompt.assemble({ agent: h.controller, scope: h.controller })
  assert.doesNotMatch(JSON.stringify(prompt), /For work the user asks to track in a transaction graph/)
  const created = await h.api.dispatchWorkflow(h.controller, h.reference, 'submit', { proposal: runtimeProposal(['write']) })
  const result = await h.api.dispatchWorkflow(h.controller, h.reference, 'run_next', { expectedRevision: created.revision })
  assert.equal(result.report.acceptance, 'UNVERIFIED_MODEL_REPORT')
  assert.equal(fs.readFileSync(path.join(h.projectRoot, 'linked.txt'), 'utf8'), 'one effect\n')
})

for (const late of [false, true]) test(`real task-graph plugin drives one atomic dynamic ledger (task graph loaded late=${late})`, async t => {
  const h = await fixture(t, { late }), seen = []
  const unsubscribe = h.api.subscribeWorkflows(event => { seen.push(event) })
  t.after(unsubscribe)
  h.api.subscribeWorkflows(() => { throw new Error('Listener failure must not undo a committed graph') })
  assert.equal(h.api.listWorkflows(h.controller).length, 1)
  const created = await h.api.dispatchWorkflow(h.controller, h.reference, 'submit', { proposal: runtimeProposal(['write']) })
  assert.equal(created.revision, 1)
  const linked = h.api.readWorkflow(h.controller, h.reference)
  assert.equal(linked.contextVersion, h.runner.graph.read().contexts.version)
  assert.equal(linked.graph.checksum, h.runner.graph.read().graph.checksum)
  assert.doesNotMatch(JSON.stringify(linked), /DIRECT_RUNTIME_TASK_DATA/)
  const paused = await h.api.dispatchWorkflow(h.controller, h.reference, 'run_next', { expectedRevision: 1, pauseAfterRequests: 1 })
  assert.equal(paused.paused, true)
  const pausedState = h.api.readWorkflow(h.controller, h.reference)
  assert.equal(pausedState.execution.continuation.phase, 'PAUSED')
  assert.equal(pausedState.reports.length, 0)
  const finished = await h.api.dispatchWorkflow(h.controller, h.reference, 'resume', { expectedRevision: 2, checkpointChecksum: paused.checkpoint.checksum })
  assert.equal(finished.report.acceptance, 'UNVERIFIED_MODEL_REPORT')
  assert.equal(fs.readFileSync(path.join(h.projectRoot, 'linked.txt'), 'utf8'), 'one effect\n')
  const result = h.api.readWorkflow(h.controller, h.reference)
  assert.equal(result.revision, 3); assert.equal(result.goalReached, false)
  assert.equal(result.reports.length, 1)
  assert.equal(h.api.host.snapshot(h.controller.session).status, 'empty')
  assert.deepEqual(seen.map(row => [row.type, row.revision]), [['created', 1], ['begun', 2], ['paused', 2], ['resumed', 2], ['report-committed', 3]])
  assert.equal(h.backend.requests.length, 2)
})

test('the inter-plugin command port rejects forged controllers, foreign projects and injected authority fields', async t => {
  const h = await fixture(t)
  assert.throws(() => h.api.readWorkflow({ ...h.controller }, h.reference), /WORKFLOW_EXACT_CONTROLLER_REQUIRED/)
  const foreign = await h.ctx.agents.create({ sessionId: 'foreign-controller', meta: { cwd: path.dirname(h.projectRoot) } })
  t.after(() => foreign.dispose())
  assert.deepEqual(h.api.listWorkflows(foreign.agent), [])
  assert.throws(() => h.api.readWorkflow(foreign.agent, h.reference), /WORKFLOW_CONTROLLER_OUTSIDE_PROJECT/)
  await assert.rejects(h.api.dispatchWorkflow(h.controller, h.reference, 'submit', { proposal: runtimeProposal(['write']), sourceAgent: {} }))
  assert.equal(h.runner.graph.read(), null)
  assert.equal(h.backend.requests.length, 0)
})
