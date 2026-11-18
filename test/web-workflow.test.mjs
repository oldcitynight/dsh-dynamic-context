import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { startWorkflowWeb, until } from '../testing/web-workflow-harness.mjs'
import { runtimeProposal } from '../testing/runtime-harness.mjs'

const names = payload => (payload.tools ?? []).map(row => row.function.name)
const callTool = (name, args) => ({ tools: [{ name, arguments: args }] })
test('real Web displays live planning/leaf reasoning, native terminal receipts, persistence and session isolation', { timeout: 60000 }, async t => {
  let plans = 0, workers = 0
  const slow = (marker, tool, args) => ({ fragmentDelayMs: 1100, rawSSE: [
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: marker } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-' + marker, type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`, 'data: [DONE]\n\n',
  ] })
  const h = await startWorkflowWeb({ respond: ({ payload }) => {
    if (payload.messages.some(row => row.role === 'system' && row.content.includes('DYNAMIC_CONTEXT_PREPLANNER_V1'))) {
      if (++plans === 1) return slow('planning-live', 'bash', { command: 'printf "terminal-fixture-ok\\n"', description: 'Read synthetic foundational condition' })
      return callTool('dynamic_context_submit', { proposal: runtimeProposal(['write']) })
    }
    if (names(payload).includes('dynamic_context_graph_status')) {
      return { text: 'Done.' }
    }
    if (++workers === 1) return slow('worker-live', 'write', { file_path: 'result.txt', content: 'One result.' })
    return { reasoning: 'Check the saved result.', text: 'The result is saved.' }
  } })
  t.after(() => h.stop())
  const { sessionId } = await h.call('session/create', { cwd: h.workspace })
  const status = () => h.call('transactionGraphView/status', { sessionId })
  await h.call('commands/execute', { agentId: sessionId, line: '/task-graph Execute a coupled fixture.', submittedAttachments: [] })
  const active = await until(status, value => value.execution?.workflowId, 'workflow started')
  const request = { sessionId, workflowId: active.execution.workflowId }
  const output = () => h.call('transactionGraphView/output', request)
  const first = await until(output, page => page.items.some(row => row.kind === 'reasoning' && row.preview.includes('planning-live')), 'live planning output')
  assert.ok(first.items.some(row => row.kind === 'reasoning' && row.state === 'running'))
  assert.equal(h.backend.requests.find(row => row.payload.messages.some(m => m.role === 'system' && m.content.includes('DYNAMIC_CONTEXT_PREPLANNER_V1'))).completed, false)
  const other = await h.call('session/create', { cwd: h.workspace })
  assert.equal((await h.rpc('transactionGraphView/output', { ...request, sessionId: other.sessionId })).ok, false)
  assert.equal((await h.rpc('transactionGraphView/outputBody', { ...request, sessionId: other.sessionId, itemId: first.items[0].id })).ok, false)
  const live = await until(output, page => page.items.some(row => row.kind === 'reasoning' && row.preview === 'worker-live' && row.state === 'running'), 'live direct output', 20000)
  const terminal = live.items.find(row => row.kind === 'tool' && row.title === 'bash')
  assert.ok(terminal?.preview.includes('terminal-fixture-ok'), JSON.stringify(live))
  assert.equal(terminal.state, 'complete')
  assert.ok(terminal.preview.includes('[result]'))
  await until(status, value => value.execution.state === 'complete', 'complete workflow')
  const final = await output()
  const projections = () => h.call('session/projections', { sessionId })
  // The root's native completion receipt can follow the workflow-complete event.
  const totals = await until(projections, result => result.values.tokenUsage.outputTokens + result.values.dynamicContextPerformance.usage.outputTokens === 30, 'all request usage receipts')
  const requests = h.backend.requests.length
  assert.equal(totals.values.dynamicContextPerformance.requests, 4, 'both planning and both direct requests are included')
  assert.equal(totals.values.dynamicContextPerformance.stats.steps, 4)
  assert.equal(totals.values.tokenUsage.outputTokens + totals.values.dynamicContextPerformance.usage.outputTokens, 30)
  assert.equal(totals.values.dynamicContextPerformance.missingUsage, 1, 'direct requests without a usage receipt are unknown; native adapter zero samples retain native semantics')
  assert.ok(final.items.some(row => row.kind === 'tool' && row.title === 'write' && row.state === 'complete'))
  assert.ok(!JSON.stringify(final).includes('DYNAMIC_CONTEXT_PREPLANNER_V1'), 'system instructions never cross the display port')
  assert.ok(!JSON.stringify(final).includes('fake-only'), 'credential is never displayed')
  await h.restart(); await status()
  const recovered = await output()
  assert.deepEqual((await projections()).values.dynamicContextPerformance, totals.values.dynamicContextPerformance)
  assert.equal(recovered.items.length, final.items.length)
  assert.equal(h.backend.requests.length, requests, 'observation does not execute or replay requests')
  const body = await h.call('transactionGraphView/outputBody', { ...request, itemId: terminal.id })
  assert.equal(body.text, terminal.preview)
  assert.deepEqual(h.backend.errors, [])
})
test('real Web RPC exposes planning, pauses, rejects cross-session control and resumes after process restart', { timeout: 60000 }, async t => {
  const planning = Promise.withResolvers(), release = Promise.withResolvers(); let plans = 0, workers = 0
  const h = await startWorkflowWeb({ respond: async ({ payload }) => {
    if (payload.messages.some(row => row.role === 'system' && row.content.includes('DYNAMIC_CONTEXT_PREPLANNER_V1'))) {
      if (++plans === 1) { planning.resolve(); await release.promise; return callTool('read', { file_path: 'probe.txt' }) }
      return callTool('dynamic_context_submit', { proposal: runtimeProposal(['write']) })
    }
    if (names(payload).includes('dynamic_context_graph_status')) {
      return { text: 'Done.' }
    }
    if (++workers === 1) return callTool('write', { file_path: 'result.txt', content: 'Produced once.' })
    return { text: 'The result is saved.' }
  } })
  t.after(() => h.stop())
  fs.writeFileSync(path.join(h.workspace, 'probe.txt'), 'Foundational condition available.')
  const { sessionId } = await h.call('session/create', { cwd: h.workspace })
  const status = () => h.call('transactionGraphView/status', { sessionId })
  assert.equal((await status()).status, 'empty')
  await h.call('commands/execute', { agentId: sessionId, line: '/task-graph Build and verify two dependent deliverables.', submittedAttachments: [] })
  await until(status, value => value.execution?.activity?.stage === 'PREPLANNING', 'planner admission', 12000)
  await until(async () => ({ plans, status: await status(), errors: h.backend.errors }), value => value.plans > 0, 'planner model request')
  const initial = await status()
  assert.equal(initial.status, 'empty'); assert.equal(initial.execution.activity.stage, 'PREPLANNING')
  const request = { sessionId, workflowId: initial.execution.workflowId }
  const other = await h.call('session/create', { cwd: h.workspace })
  const denied = await h.rpc('transactionGraphView/control', { ...request, sessionId: other.sessionId, action: 'pause' })
  assert.equal(denied.ok, false)
  const paused = await h.call('transactionGraphView/control', { ...request, action: 'pause' })
  assert.equal(paused.execution.state, 'pausing')
  release.resolve()
  await until(status, value => value.execution.state === 'paused', 'normal pause')
  const before = h.backend.requests.length
  await h.restart()
  assert.equal(h.backend.requests.length, before, 'reloading never sends a model request')
  assert.equal((await status()).execution.pauseKind, 'normal')
  await h.call('transactionGraphView/control', { ...request, action: 'resume' })
  const done = await until(status, value => value.execution.state === 'complete', 'workflow completion')
  assert.equal(done.status, 'ready'); assert.equal(workers, 2); assert.equal(plans, 2)
  assert.equal(fs.readFileSync(path.join(h.workspace, 'result.txt'), 'utf8'), 'Produced once.')
  assert.deepEqual(h.backend.errors, [])
})

test('real Web Continue keeps a failed executor in its workflow without starting a native controller turn', { timeout: 60000 }, async t => {
  let leaves = 0, controllers = 0
  const h = await startWorkflowWeb({ respond: ({ payload }) => {
    if (payload.messages.some(row => row.role === 'system' && row.content.includes('DYNAMIC_CONTEXT_PREPLANNER_V1')))
      return callTool('dynamic_context_submit', { proposal: runtimeProposal(['write']) })
    if (names(payload).includes('dynamic_context_graph_status')) {
      controllers++
      return { text: 'Native controller request.' }
    }
    if (++leaves <= 2) return { disconnect: true }
    return { text: 'Completed the retained leaf.' }
  } })
  t.after(() => h.stop())
  const { sessionId } = await h.call('session/create', { cwd: h.workspace })
  const status = () => h.call('transactionGraphView/status', { sessionId })
  await h.call('commands/execute', { agentId: sessionId, line: '/task-graph Build a deliverable.', submittedAttachments: [] })
  const first = await until(status, value => leaves === 1 && value.execution?.state === 'interrupted', 'failed leaf stays in workflow')
  const resume = () => h.call('transactionGraphView/control', { sessionId, workflowId: first.execution.workflowId, action: 'resume' })
  await resume()
  const second = await until(status, value => leaves === 2 && value.execution?.state === 'interrupted', 'second failure stays in workflow')
  assert.equal(second.graph.revision, first.graph.revision)
  assert.equal(second.execution.canResume, true)
  assert.equal(controllers, 0)
  await resume()
  const done = await until(status, value => value.execution?.state === 'complete', 'same leaf completed')
  assert.equal(done.status, 'ready')
  assert.equal(leaves, 3)
  assert.deepEqual(h.backend.errors, [])
})

test('real Web resumes an unexpectedly killed preplanner without silently starting on reload', { timeout: 60000 }, async t => {
  let plans = 0, workers = 0
  const h = await startWorkflowWeb({ respond: ({ payload }) => {
    if (payload.messages.some(row => row.role === 'system' && row.content.includes('DYNAMIC_CONTEXT_PREPLANNER_V1'))) {
      if (++plans === 1) return { hang: true }
      return callTool('dynamic_context_submit', { proposal: runtimeProposal(['write']) })
    }
    if (names(payload).includes('dynamic_context_graph_status')) {
      return { text: 'Done.' }
    }
    if (++workers === 1) return callTool('write', { file_path: 'result.txt', content: 'Produced once.' })
    return { text: 'The result is saved.' }
  } })
  t.after(() => h.stop())
  const { sessionId } = await h.call('session/create', { cwd: h.workspace })
  const status = () => h.call('transactionGraphView/status', { sessionId })
  await h.call('commands/execute', { agentId: sessionId, line: '/task-graph Build and verify dependent deliverables.', submittedAttachments: [] })
  const initial = await until(status, value => plans === 1 && value.execution?.state === 'running', 'pending planning request')
  await h.restart()
  assert.equal(plans, 1)
  assert.equal((await status()).execution.pauseKind, 'unexpected')
  await h.call('transactionGraphView/control', { sessionId, workflowId: initial.execution.workflowId, action: 'resume' })
  await until(status, value => value.execution?.state === 'complete', 'recovered planning')
  assert.equal(plans, 2); assert.equal(workers, 2)
  assert.equal(fs.readFileSync(path.join(h.workspace, 'result.txt'), 'utf8'), 'Produced once.')
  assert.deepEqual(h.backend.errors, [])
})
