import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import UserQuestions from '@deepseek-ai/dsh-user-questions'
import Commands from '@deepseek-ai/dsh-commands'
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createRuntimeHarness, runtimeProposal } from '../testing/runtime-harness.mjs'
import { MODE_OPTIONS } from '../interaction.mjs'
import { EXECUTION_OPTIONS } from '../orchestration.mjs'
import { ROLE_PROMPTS_SERVICE, ROLE_TOOLS_SERVICE } from '../role-policy.mjs'
import { guidanceRecords, withUserGuidance } from '../guidance-state.mjs'
import { guidanceActivation, validateGuidanceRoute } from '../user-guidance.mjs'

const deferred = () => { let resolve; return { promise: new Promise(r => { resolve = r }), resolve } }
const user = text => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
const tool = (name, args) => ({ tools: [{ name, arguments: args }] })
const names = payload => (payload.tools ?? []).map(row => row.function.name)
const system = payload => payload.messages.find(row => row.role === 'system')?.content ?? ''
const isPlanner = payload => system(payload).includes('DYNAMIC_CONTEXT_PREPLANNER_V1')
const isController = payload => names(payload).includes('dynamic_context_graph_status')
const json = value => ({ text: JSON.stringify(value) })
async function fixture(t, respond, config = {}) {
  const root = fs.mkdtempSync(path.join(os.homedir(), '.dsh-guidance-fake-')), projectRoot = path.join(root, 'project'); fs.mkdirSync(projectRoot)
  const h = await createRuntimeHarness({ projectRoot, directory: path.join(root, 'state'), respond,
    config: { interaction: { mode: 'interactive' }, storageRoot: root, exposeControlTools: true, preplanningAcceptance: false,
      ...config, direct: { durable: true, ...config.direct } }, setup: async ctx => {
      await ctx.plugin(UserQuestions); await ctx.plugin(Commands); await ctx.plugin(Persistence, { root: path.join(root, 'sessions') })
      ctx.on('user-questions/request', request => {
        const id = request.questions[0].id, selected = id === 'dynamic-context-execution' ? EXECUTION_OPTIONS[0].label : MODE_OPTIONS.find(row => row.mode === 'full').label
        return { answers: [{ id, selected: [selected] }] }
      })
    } })
  const handle = await h.ctx.agents.create({ sessionId: 'guidance-owner', meta: { cwd: projectRoot }, agentOptions: { provider: 'dynamic-context-fake', model: 'fake-llama' } })
  t.after(async () => { await handle.dispose(); await h.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const agent = handle.agent, orchestrator = h.runner.interaction.orchestrator
  return { h, agent, projectRoot, root, orchestrator, status: () => orchestrator.status(agent), runner: () => h.runner.interaction.entries.get(agent).runner,
    start: () => h.ctx.commands.execute(agent, '/task-graph Build and inspect a staged local artifact', [], new AbortController().signal) }
}
function guidanceReply(payload, action = 'dispatch') {
  const input = JSON.parse(payload.messages[1].content)
  if (system(payload).includes('DYNAMIC_CONTEXT_GUIDANCE_INTAKE_V1')) return json({ level: action === 'pause' ? 'control' : 'leaf',
    intent: action === 'pause' ? 'Wait for the user' : 'Use the new artifact name', targets: input.graph?.active ? [input.graph.active.nodeId] : [],
    conditions: ['Preserve completed tool results'], changes: [action === 'pause' ? 'pause' : 'execution'], needsClarification: false })
  if (system(payload).includes('DYNAMIC_CONTEXT_GUIDANCE_ROUTER_V1')) return json({ action, summary: action === 'pause' ? 'Waiting as requested' : 'Continue the active leaf with the new instruction',
    jobs: action === 'dispatch' ? [{ role: 'executor', taskId: input.graph.active.nodeId, instruction: 'Follow the original user guidance within this leaf', when: 'now' }] : [] })
}

test('guidance arriving during reasoning stops the old tool batch, runs both handlers, and resumes the exact leaf', { timeout: 20000 }, async t => {
  const entered = deferred(), release = deferred(), order = []; let workers = 0
  const f = await fixture(t, async ({ payload }) => {
    if (isPlanner(payload)) return tool('dynamic_context_submit', { proposal: runtimeProposal(['write']) })
    if (isController(payload)) return { text: 'Recorded.' }
    if (system(payload).includes('DYNAMIC_CONTEXT_GUIDANCE_')) { order.push(system(payload).includes('INTAKE') ? 'intake' : 'router'); return guidanceReply(payload) }
    workers++; order.push('worker' + workers)
    if (workers === 1) { entered.resolve(); await release.promise; return { tools: [
      { name: 'write', arguments: { file_path: 'obsolete-one.txt', content: 'old' } }, { name: 'write', arguments: { file_path: 'obsolete-two.txt', content: 'old' } }] } }
    assert.match(JSON.stringify(payload.messages), /改为 new-result.txt/)
    if (workers === 2) return tool('write', { file_path: 'new-result.txt', content: 'new guidance applied' })
    return { text: 'Current artifact saved and inspected.' }
  })
  await f.start(); await entered.promise
  f.agent.steer(user('改为 new-result.txt，保留本叶边界。')); release.resolve(); await f.agent.whenIdle()
  assert.deepEqual(f.h.backend.errors, [])
  assert.equal(f.status().phase, 'COMPLETE', JSON.stringify(f.status()))
  assert.deepEqual(order, ['worker1', 'intake', 'router', 'worker2', 'worker3'])
  assert.equal(fs.existsSync(path.join(f.projectRoot, 'obsolete-one.txt')), false)
  assert.equal(fs.existsSync(path.join(f.projectRoot, 'obsolete-two.txt')), false)
  assert.equal(fs.readFileSync(path.join(f.projectRoot, 'new-result.txt'), 'utf8'), 'new guidance applied')
  const records = guidanceRecords(f.agent.session); assert.equal(records.length, 1); assert.equal(records[0].phase, 'APPLIED')
  assert.equal(records[0].jobs[0].result.roleReturned, true)
})

test('guidance during a real extension tool retains that result once and skips the following call', { timeout: 20000 }, async t => {
  const entered = deferred(), release = deferred(); let workers = 0, calls = 0
  const f = await fixture(t, ({ payload }) => {
    if (isPlanner(payload)) return tool('dynamic_context_submit', { proposal: runtimeProposal(['fixture_guided_work']) })
    if (isController(payload)) return { text: 'Recorded.' }
    if (system(payload).includes('DYNAMIC_CONTEXT_GUIDANCE_')) return guidanceReply(payload)
    if (++workers === 1) return { tools: [{ name: 'fixture_guided_work', arguments: { item: 'first' } }, { name: 'fixture_guided_work', arguments: { item: 'second' } }] }
    assert.match(JSON.stringify(payload.messages), /first completed/)
    assert.match(JSON.stringify(payload.messages), /NOT_EXECUTED/)
    return { text: 'Preserved the completed first tool and the changed direction.' }
  }, { allowedTools: ['fixture_guided_work'] })
  f.h.ctx.get(ROLE_TOOLS_SERVICE).registerTool({ pluginId: 'fixture', registrationId: 'work', toolId: 'fixture_guided_work', roles: ['executor'], effect: 'work',
    schema: { type: 'function', function: { name: 'fixture_guided_work', description: 'Controlled fake effect', parameters: { type: 'object', properties: { item: { type: 'string' } }, required: ['item'], additionalProperties: false } } },
    authorize: () => true, execute: async args => { calls++; entered.resolve(); await release.promise; return { result: args.item + ' completed' } } })
  await f.start(); await Promise.race([entered.promise, f.agent.whenIdle().then(() => assert.fail(JSON.stringify(f.status()) + JSON.stringify(f.h.backend.errors)))])
  f.agent.steer(user('保留第一项结果，后续方向改为 new-result.txt。')); release.resolve(); await f.agent.whenIdle()
  assert.deepEqual(f.h.backend.errors, [])
  assert.equal(f.status().phase, 'COMPLETE', JSON.stringify(f.status()))
  assert.equal(calls, 1); assert.equal(workers, 2)
})

test('executor prompt override and tool blacklist reach the actual native-backed direct request', { timeout: 20000 }, async t => {
  const f = await fixture(t, ({ payload }) => {
    if (isPlanner(payload)) return tool('dynamic_context_submit', { proposal: runtimeProposal(['read', 'write']) })
    if (isController(payload)) return { text: 'Recorded.' }
    assert.match(JSON.stringify(payload.messages), /CUSTOM_EXECUTOR_SKILL/)
    assert.match(JSON.stringify(payload.messages), /Host role protocol v1/)
    assert.ok(names(payload).includes('read')); assert.ok(!names(payload).includes('write'))
    return { text: 'Inspected under narrowed tool policy.' }
  })
  f.h.ctx.get(ROLE_PROMPTS_SERVICE).register({ pluginId: 'fixture', registrationId: 'prompt', role: 'executor', mode: 'replace', text: 'CUSTOM_EXECUTOR_SKILL' })
  f.h.ctx.get(ROLE_TOOLS_SERVICE).register({ pluginId: 'fixture', registrationId: 'tools', role: 'executor', mode: 'blacklist', toolIds: ['write'] })
  await f.start(); await f.agent.whenIdle()
  assert.deepEqual(f.h.backend.errors, [])
  assert.equal(f.status().phase, 'COMPLETE', JSON.stringify(f.status()))
})

test('guidance after report tool success reopens the declaration before semantic acceptance', { timeout: 20000 }, async t => {
  let workers = 0, guided = false
  const f = await fixture(t, ({ payload }) => {
    if (isPlanner(payload)) {
      const proposal = runtimeProposal([]); proposal.contextGraph.bindings[0].completion = { kind: 'report' }
      return tool('dynamic_context_submit', { proposal })
    }
    if (isController(payload)) return { text: 'Recorded.' }
    if (system(payload).includes('DYNAMIC_CONTEXT_GUIDANCE_')) return guidanceReply(payload)
    if (payload.response_format) return json(system(payload).includes('倒查') || system(payload).includes('当前规划')
      ? { verdict: 'CURRENT' } : { verdict: 'ACCEPT', reason: 'The updated declaration was checked.' })
    workers++
    if (workers === 1) return tool('dynamic_context_generate_report', { report: { outcome: 'COMPLETE', summary: 'Initial declaration' } })
    if (workers === 2) return tool('dynamic_context_rewrite_report', { expectedRevision: 1, edits: [{ op: 'set', path: '/summary', value: 'Updated declaration' }] })
    assert.match(payload.messages.at(-1).content, /"revision":2/)
    assert.doesNotMatch(payload.messages.at(-1).content, /REPORT_ALREADY_SUBMITTED/)
    return tool('dynamic_context_submit_report', { expectedRevision: 2 })
  }, { supervision: true, revision: { policy: { objective: 'Check the declaration', requirements: [{ id: 'report', text: 'Follow the current user direction.' }] } } })
  const dispose = f.h.ctx.on('tools/execute', async (exec, next) => {
    const result = await next()
    if (exec.name === 'dynamic_context_generate_report' && !guided) {
      guided = true
      f.agent.steer(user('验收前把本叶报告摘要改为 Updated declaration，保留其他内容。'))
      await new Promise(resolve => setImmediate(resolve))
    }
    return result
  })
  t.after(dispose)
  await f.start(); await f.agent.whenIdle()
  assert.deepEqual(f.h.backend.errors, [])
  assert.equal(guided, true); assert.equal(workers, 3)
  assert.equal(f.status().phase, 'COMPLETE', JSON.stringify(f.status()))
  assert.equal(f.runner().graph.read().supervision.outcomes.length, 1)
  assert.equal(f.runner().graph.read().supervision.outcomes[0].result.summary, 'Updated declaration')
})

test('interim report request runs a read-only reporter, repairs an invalid claim locally and resumes the leaf', { timeout: 20000 }, async t => {
  const entered = deferred(), release = deferred(); let workers = 0, reports = 0, f
  f = await fixture(t, async ({ payload }) => {
    if (isPlanner(payload)) return tool('dynamic_context_submit', { proposal: runtimeProposal(['write']) })
    if (isController(payload)) return { text: 'Recorded.' }
    if (system(payload).includes('GUIDANCE_INTAKE')) return tool('dynamic_context_generate_report', { report: { level: 'information', intent: 'Report current progress', targets: [], conditions: [], changes: ['report'], needsClarification: false } })
    if (system(payload).includes('GUIDANCE_ROUTER')) return tool('dynamic_context_generate_report', { report: { action: 'dispatch', summary: 'Report the current state', jobs: [{ role: 'progress_reporter', instruction: 'Summarize intermediate work', when: 'now' }] } })
    if (system(payload).includes('PROGRESS_REPORTER')) {
      reports++
      assert.ok(!names(payload).includes('write'))
      const input = JSON.parse(payload.messages[1].content), snapshot = input.snapshot
      if (reports === 1) return tool('dynamic_context_generate_report', { report: { kind: 'interim', summary: 'Partial progress only', completed: [{ nodeId: snapshot.value.taskGraph.active.nodeId, summary: 'Not actually complete', evidence: [{ source: 'snapshot', sha256: snapshot.sha256, path: '/taskGraph/active/nodeId', quote: snapshot.value.taskGraph.active.nodeId }] }], inProgress: [], blocked: [], remaining: [], verification: [], limitations: ['No acceptance yet'] } })
      if (reports === 2) {
        const rejected = JSON.parse(payload.messages.at(-1).content); assert.equal(rejected.error, 'PROGRESS_STATUS_MISMATCH')
        return tool('dynamic_context_rewrite_report', { expectedRevision: rejected.revision, edits: [{ op: 'set', path: '/completed', value: [] }] })
      }
      return tool('dynamic_context_submit_report', { expectedRevision: 2 })
    }
    workers++
    if (workers === 1) { entered.resolve(); await release.promise; return tool('write', { file_path: 'withheld.txt', content: 'must not run' }) }
    return { text: 'Worker finished after progress report.' }
  })
  await f.start(); await entered.promise; f.agent.steer(user('给我一份中间的总体执行报告，然后继续工作')); release.resolve(); await f.agent.whenIdle()
  assert.deepEqual(f.h.backend.errors, [])
  assert.equal(f.status().phase, 'COMPLETE', JSON.stringify(f.status())); assert.equal(reports, 3); assert.equal(workers, 2)
  assert.equal(fs.existsSync(path.join(f.projectRoot, 'withheld.txt')), false)
  assert.equal(guidanceRecords(f.agent.session)[0].jobs[0].status, 'DONE')
})

function guidedHierarchy() {
  const p = runtimeProposal(['write'])
  p.taskGraph.hierarchy = { version: 1, maxGroupDepth: 3 }
  p.taskGraph.nodes[0].terminal = 'task'; p.taskGraph.nodes[0].acceptance = 'Produce the requested fixture.'
  p.contextGraph.bindings[0].completion = { kind: 'report' }
  return p
}
for (const revise of [false, true]) test('immediate blueprint review suspends unfinished work and ' + (revise ? 'audited changes start a new attempt with old evidence' : 'NO_CHANGE resumes its checkpoint'), { timeout: 20000 }, async t => {
  const entered = deferred(), release = deferred(); let workers = 0, oldAttempt, f
  f = await fixture(t, async ({ payload }) => {
    if (isPlanner(payload)) return tool('dynamic_context_submit', { proposal: guidedHierarchy() })
    if (isController(payload)) return { text: 'Recorded.' }
    const input = payload.response_format ? JSON.parse(payload.messages[1].content) : null
    if (system(payload).includes('GUIDANCE_INTAKE')) return json({ level: 'workflow', intent: 'Check the blueprint immediately', targets: [], conditions: [], changes: ['plan'], needsClarification: false })
    if (system(payload).includes('GUIDANCE_ROUTER')) return json({ action: 'dispatch', summary: 'Suspend and review the blueprint', jobs: [{ role: 'scope_update', scopeId: input.graph.nodes.find(row => row.parent === null).id, instruction: 'Inspect the requested correction before any further work.', when: 'now' }] })
    if (system(payload).includes('SCOPE_UPDATE')) {
      const state = f.runner().graph.read(); assert.equal(state.graph.state.active, null); assert.equal(state.graph.state.suspended.active.attemptId, oldAttempt)
      assert.equal(state.supervision.outcomes.length, 0); assert.equal(f.runner().status().taskGraph.legalNext.length, 0)
      assert.ok(input.unfinishedWork)
      if (!revise) return json({ action: 'NO_CHANGE', reason: 'The current contract already permits the requested correction.' })
      const blueprint = structuredClone(input.blueprint.value), contextGraph = blueprint.contextGraph
      contextGraph.bindings[0].instruction = 'Follow the new user direction and inspect preserved partial work before redoing anything.'
      return tool('dynamic_context_generate_report', { report: { action: 'REVISE', terminal: blueprint.scope.terminal, nodes: blueprint.nodes, edges: blueprint.edges, contextGraph,
        modifications: [{ path: '/contextGraph/bindings/task', reason: 'The user explicitly changed the direction.', evidence: [{ source: input.guidanceEvidence.source, sha256: input.guidanceEvidence.sha256, path: '/content/0/text', quote: input.guidanceEvidence.value.content[0].text }] }] } })
    }
    if (payload.response_format) {
      if (system(payload).includes('SCOPE_AUDIT')) return tool('dynamic_context_generate_report', { report: { verdict: 'APPROVE', reason: 'Only the requested binding changed; existing work is retained.', issues: [] } })
      if (system(payload).includes('GROUP_FINAL')) return json({ action: 'COMPLETE', summary: 'Terminal result checked.', limitations: [], children: input.reports.map(row => ({ nodeId: row.value.taskId, conclusion: 'SATISFIED', reason: 'The leaf contract is satisfied.', evidence: [{ source: row.source, sha256: row.sha256, path: '/result/summary', quote: row.value.result.summary }] })) })
      if (system(payload).includes('TASK_REPORTER')) return json({ title: 'Final report', summary: 'Work completed.', achievements: ['Fixture'], limitations: [], verification: ['Reviewed'], nextSteps: [], evidence: [{ source: input.reports[0].source, sha256: input.reports[0].sha256, path: '/result/summary', quote: input.reports[0].value.result.summary }] })
      return json({ verdict: 'ACCEPT', reason: 'Current leaf request accepted.' })
    }
    workers++
    if (workers === 1) { oldAttempt = f.runner().graph.read().graph.state.active.attemptId; entered.resolve(); await release.promise; return tool('write', { file_path: 'old.txt', content: 'must not run' }) }
    if (revise) { assert.notEqual(f.runner().graph.read().graph.state.active.attemptId, oldAttempt); assert.match(JSON.stringify(payload.messages), /interruptedWork/); assert.match(JSON.stringify(payload.messages), /sourceRead/) }
    else assert.equal(f.runner().graph.read().graph.state.active.attemptId, oldAttempt)
    return json({ outcome: 'COMPLETE', summary: 'Report-only fixture completed.' })
  }, { supervision: true, revision: { policy: { objective: 'Produce a fixture report', requirements: [{ id: 'fixture', text: 'Retain evidence' }] } } })
  await f.start(); await entered.promise; f.agent.steer(user('现在先停下，立即重新检查任务图，改图处理之后继续')); release.resolve(); await f.agent.whenIdle()
  assert.deepEqual(f.h.backend.errors, [])
  assert.equal(f.status().phase, 'COMPLETE', JSON.stringify(f.status()))
  const events = f.runner().graph.read().graph.events
  assert.equal(events.filter(row => row.type === 'BEGUN').length, revise ? 2 : 1)
  assert.equal(events.find(row => row.type === 'SUSPENSION_RESOLVED').data.mode, revise ? 'supersede' : 'resume')
  assert.equal(fs.existsSync(path.join(f.projectRoot, 'old.txt')), false)
})

test('asking for an interim report from a normal pause preserves the pause and never resumes work', { timeout: 20000 }, async t => {
  const entered = deferred(), release = deferred(); let workers = 0, reports = 0
  const f = await fixture(t, async ({ payload }) => {
    if (isPlanner(payload)) return tool('dynamic_context_submit', { proposal: runtimeProposal(['write']) })
    if (isController(payload)) return { text: 'Recorded.' }
    if (system(payload).includes('GUIDANCE_INTAKE')) return json({ level: 'information', intent: 'Current progress only', targets: [], conditions: ['Remain paused'], changes: ['report'], needsClarification: false })
    if (system(payload).includes('GUIDANCE_ROUTER')) return json({ action: 'dispatch', summary: 'Produce interim report', jobs: [{ role: 'progress_reporter', instruction: 'Report progress without resuming work', when: 'now' }] })
    if (system(payload).includes('PROGRESS_REPORTER')) { reports++; return tool('dynamic_context_generate_report', { report: { kind: 'interim', summary: 'Paused after the last known step.', completed: [], inProgress: [], blocked: [], remaining: [], verification: [], limitations: ['Work has not been accepted.'] } }) }
    workers++; entered.resolve(); await release.promise; return tool('write', { file_path: 'before-pause.txt', content: 'current step retained' })
  })
  await f.start(); await entered.promise; await f.orchestrator.control(f.agent, 'pause', new AbortController().signal); release.resolve(); await f.agent.whenIdle()
  assert.equal(f.status().phase, 'PAUSED'); const old = f.runner().graph.read().checksum
  f.agent.steer(user('保持暂停，给我中间的总体执行报告')); await f.agent.whenIdle()
  assert.deepEqual(f.h.backend.errors, []); assert.equal(reports, 1); assert.equal(workers, 1)
  assert.equal(f.status().phase, 'PAUSED', JSON.stringify(f.status())); assert.equal(f.runner().graph.read().checksum, old)
})

test('role routing excludes another leaf instructions and cancelled jobs while preserving the original user authority', async () => {
  const { applicableGuidance, GUIDANCE_RECORD } = await import('../guidance-state.mjs'), { digest } = await import('dsh-better-task-grapth/core')
  const message = user('A 修正命名，B 增加测试'), jobs = [
    { role: 'executor', taskId: 'a', instruction: 'A direction', status: 'DONE' },
    { role: 'executor', taskId: 'b', instruction: 'PRIVATE B DIRECTION', status: 'QUEUED' },
    { role: 'executor', taskId: 'a', instruction: 'CANCELLED DIRECTION', status: 'CANCELLED' },
  ]
  const data = { version: 1, sessionId: 'owner', id: 'guidance_test', message, messageHash: digest(message), phase: 'RUNNING', analysis: { level: 'workflow', intent: 'Scoped changes', targets: [] }, route: { action: 'dispatch', jobs }, jobs }
  const session = { id: 'owner', snapshotEvents: () => [{ type: GUIDANCE_RECORD, ignorable: true, data }] }
  const runner = { controller: { session }, graph: { read: () => ({ graph: { state: { active: { nodeId: 'a' }, plan: { nodes: [{ id: 'root' }, { id: 'a', parent: 'root' }, { id: 'b', parent: 'root' }] } } } }) } }
  const guidance = applicableGuidance(runner, 'executor', { taskId: 'a' })
  assert.equal(guidance[0].roleInstructions.length, 1); assert.equal(guidance[0].roleInstructions[0].instruction, 'A direction')
  assert.deepEqual(guidance[0].original, message.content)
})
