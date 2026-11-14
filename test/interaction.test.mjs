import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import UserQuestions from '@deepseek-ai/dsh-user-questions'
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import TaskGraph from 'dsh-better-task-grapth'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createRuntimeHarness, runtimeProposal } from '../testing/runtime-harness.mjs'
import { DynamicContextRuntime, validateConfig } from '../index.mjs'
import { MODE_OPTIONS, MODE_RECORD } from '../interaction.mjs'
import { GRAPH_COMMIT_RECORD } from '../graph-presence.mjs'
import { sessionReference } from 'dsh-better-task-grapth/host'

async function fixture(t, { choice = 'full', revision = false, respond, taskGraph = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'interaction-boundaries-')))
  const projectRoot = path.join(root, 'project'); fs.mkdirSync(projectRoot)
  const questions = [], handles = []
  const h = await createRuntimeHarness({ projectRoot, directory: path.join(root, 'state'), taskGraph,
    config: { storageRoot: root, interaction: { mode: 'interactive' }, exposeControlTools: true,
      ...(revision ? { revision: { policy: { objective: 'MUST_NOT_LEAK_TEMPLATE_GOAL', requirements: [{ id: 'original', text: 'Template only.' }] } } } : {}) },
    respond: respond ?? (() => ({ text: 'Fake scoped result.' })),
    setup: async ctx => {
      await ctx.plugin(UserQuestions)
      await ctx.plugin(Persistence, { root: path.join(root, 'sessions') })
      if (taskGraph) await ctx.plugin(TaskGraph)
      ctx.on('user-questions/request', async request => {
        questions.push(request.questions)
        const answer = typeof choice === 'function' ? await choice(request, questions.length) : choice
        return { answers: [{ id: request.questions[0].id,
          selected: answer === null ? [] : [MODE_OPTIONS.find(item => item.mode === answer)?.label ?? answer] }] }
      })
    } })
  t.after(async () => { for (const handle of handles) await handle.dispose(); await h.close(); fs.rmSync(root, { recursive: true, force: true }) })
  async function agent(id, text = '实现并验证当前项目，保留用户验收标准。', cwd = projectRoot) {
    const handle = await h.ctx.agents.create({ sessionId: id, meta: { cwd }, agentOptions: { provider: 'dynamic-context-fake', model: 'fake-llama' } })
    handles.push(handle)
    const message = text === null ? null : createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
    if (message) handle.agent.session.append('user/message', message, { surfaceOp: 'append' })
    return { handle, agent: handle.agent, message }
  }
  const call = (agent, name, args) => h.ctx.tools.get(name, agent).execute(args, { agent, name, callId: 'fixture-' + name, signal: new AbortController().signal })
  return { h, root, projectRoot, questions, agent, call }
}
const schemaNames = (ctx, agent) => ctx.tools.schemas(agent).map(row => row.name)

test('runtime waits for the base service; direct construction also rejects missing dependency', async t => {
  const f = await fixture(t, { taskGraph: false })
  assert.equal(f.h.runner, undefined)
  assert.throws(() => new DynamicContextRuntime(f.h.ctx, { projectRoot: f.projectRoot, directory: path.join(f.root, 'unowned'), provider: 'x', model: 'x', transport: 'direct', systemPrompt: 'x', direct: { endpoint: f.h.backend.origin + '/v1/chat/completions' } }), /DYNAMIC_CONTEXT_REQUIRES_ACTIVE_TASK_GRAPH/)
  await f.h.ctx.plugin(TaskGraph)
  assert.ok(f.h.runner)
  assert.equal(f.h.backend.requests.length, 0)
})

test('interop cannot be disabled to bypass the required base', () => {
  assert.throws(() => validateConfig({ projectRoot: '/tmp', directory: '/tmp/state', provider: 'x', model: 'x', transport: 'direct', systemPrompt: 'x', direct: { endpoint: 'http://127.0.0.1:1/chat/completions' }, interop: { enabled: false } }))
})

for (const mode of ['native', 'task-graph', 'full']) test(`human choice ${mode} controls only its own session`, async t => {
  const f = await fixture(t, { choice: mode, revision: true })
  const first = await f.agent('first', 'FIRST_TASK_CONTRACT'), second = await f.agent('second', 'SECOND_TASK_CONTRACT')
  const initial = await f.h.ctx.systemPrompt.assemble({ agent: first.agent, scope: first.agent })
  assert.match(JSON.stringify(initial), /初步判断为项目级|任务图与动态上下文使用指引/)
  assert.doesNotMatch(JSON.stringify(initial), /MUST_NOT_LEAK_TEMPLATE_GOAL/)
  assert.equal(schemaNames(f.h.ctx, first.agent).includes('transaction_graph_create'), false)
  assert.equal(schemaNames(f.h.ctx, first.agent).includes('dynamic_context_submit'), false)
  assert.equal((await f.call(first.agent, 'dynamic_context_select_mode', { reason: '项目级工作' })).mode, mode)
  assert.deepEqual(f.questions[0][0].options.map(row => row.label), MODE_OPTIONS.map(row => row.label))
  assert.equal(f.h.runner.interaction.mode(second.agent), 'native')
  assert.equal(schemaNames(f.h.ctx, first.agent).includes('transaction_graph_create'), mode === 'task-graph')
  assert.equal(schemaNames(f.h.ctx, first.agent).includes('dynamic_context_submit'), mode === 'full')
  assert.equal((await f.call(first.agent, 'dynamic_context_select_mode', { reason: '重复调用' })).alreadySelected, true)
  assert.equal(f.questions.length, 1)
  assert.ok(first.agent.session.snapshotEvents().some(row => row.type === MODE_RECORD && row.data.mode === mode))
  const secondPrompt = await f.h.ctx.systemPrompt.assemble({ agent: second.agent, scope: second.agent })
  assert.doesNotMatch(JSON.stringify(secondPrompt), /FIRST_TASK_CONTRACT|MUST_NOT_LEAK_TEMPLATE_GOAL/)
  if (mode === 'full') {
    const firstPrompt = await f.h.ctx.systemPrompt.assemble({ agent: first.agent, scope: first.agent })
    assert.match(JSON.stringify(firstPrompt), /FIRST_TASK_CONTRACT/)
    assert.doesNotMatch(JSON.stringify(firstPrompt), /SECOND_TASK_CONTRACT|MUST_NOT_LEAK_TEMPLATE_GOAL/)
    await f.call(first.agent, 'dynamic_context_submit', { proposal: runtimeProposal([]) })
    const result = await f.call(first.agent, 'dynamic_context_run_next', { expectedRevision: 1 })
    assert.equal(result.revision, 3); assert.equal(f.h.backend.requests.length, 1)
  } else assert.equal(f.h.backend.requests.length, 0)
})

test('task-only proposal falls back to original graph tools without committing a joint ledger', async t => {
  const f = await fixture(t), { agent } = await f.agent('task-only')
  await f.call(agent, 'dynamic_context_select_mode', { reason: '项目级任务' })
  const child = f.h.runner.interaction.entries.get(agent).runner
  const taskGraph = runtimeProposal([]).taskGraph
  const result = await f.call(agent, 'dynamic_context_submit', { proposal: { taskGraph } })
  assert.equal(result.status, 'TASK_GRAPH_ONLY'); assert.equal(result.committed, false)
  assert.equal(result.nextTool, 'transaction_graph_create'); assert.deepEqual(result.arguments.definition, taskGraph)
  assert.equal(child.graph.read(), null)
  assert.equal(f.h.runner.interaction.mode(agent), 'task-graph')
  assert.equal(schemaNames(f.h.ctx, agent).includes('dynamic_context_run_next'), false)
  assert.equal(schemaNames(f.h.ctx, agent).includes('transaction_graph_create'), true)
  assert.equal(f.h.backend.requests.length, 0)
})

for (const fallback of ['回退到原生状态', '不回退，补齐任务图', null]) test(`orphan context reports error and requests human fallback: ${fallback}`, async t => {
  const f = await fixture(t, { choice: (_request, count) => count === 1 ? 'full' : fallback })
  const { agent } = await f.agent('orphan')
  await f.call(agent, 'dynamic_context_select_mode', { reason: '项目级任务' })
  const child = f.h.runner.interaction.entries.get(agent).runner
  const result = await f.call(agent, 'dynamic_context_submit', { proposal: { contextGraph: runtimeProposal([]).contextGraph } })
  assert.equal(result.code, 'CONTEXT_GRAPH_REQUIRES_TASK_GRAPH')
  assert.equal(f.questions.length, 2); assert.match(f.questions[1][0].question, /缺少前置任务图/)
  assert.equal(f.h.runner.interaction.mode(agent), fallback === '回退到原生状态' ? 'native' : 'full')
  assert.equal(child.graph.read(), null); assert.equal(f.h.backend.requests.length, 0)
})

test('unanswered initial question never selects the recommended full mode', async t => {
  const f = await fixture(t, { choice: null }), { agent } = await f.agent('unanswered')
  const result = await f.call(agent, 'dynamic_context_select_mode', { reason: '项目级任务' })
  assert.equal(result.status, 'NEEDS_USER_CHOICE'); assert.equal(result.changed, false)
  assert.equal(f.h.runner.interaction.record(agent), undefined)
  assert.equal(f.h.backend.requests.length, 0)
})

test('whole explicit user choice is honored; quoted or negated phrases do not authorize a mode', async t => {
  const f = await fixture(t, { choice: 'native' })
  const explicit = await f.agent('explicit', '使用动态上下文')
  const result = await f.call(explicit.agent, 'dynamic_context_select_mode', { reason: '用户指定', explicit: { mode: 'full', userMessageId: explicit.message.id, quote: '使用动态上下文' } })
  assert.equal(result.mode, 'full'); assert.equal(f.questions.length, 0)
  const negated = await f.agent('negated', '不要“使用动态上下文”，这是一个反例。')
  const denied = await f.call(negated.agent, 'dynamic_context_select_mode', { reason: '需要确认', explicit: { mode: 'full', userMessageId: negated.message.id, quote: '使用动态上下文' } })
  assert.equal(denied.mode, 'native'); assert.equal(f.questions.length, 1)
})

test('new conversations in different projects get guidance and distinct full workflows', async t => {
  const f = await fixture(t), otherRoot = path.join(f.root, 'other-project'); fs.mkdirSync(otherRoot)
  const a = await f.agent('project-a', 'PROJECT_A', f.projectRoot), b = await f.agent('project-b', 'PROJECT_B', otherRoot)
  for (const item of [a, b]) {
    const prompt = await f.h.ctx.systemPrompt.assemble({ agent: item.agent, scope: item.agent })
    assert.match(JSON.stringify(prompt), /任务图与动态上下文使用指引/)
    await f.call(item.agent, 'dynamic_context_select_mode', { reason: '项目任务' })
  }
  const one = f.h.runner.interaction.entries.get(a.agent).runner, two = f.h.runner.interaction.entries.get(b.agent).runner
  assert.notEqual(one.config.interop.workflowId, two.config.interop.workflowId)
  assert.notEqual(one.config.directory, two.config.directory)
  assert.equal(one.config.projectRoot, f.projectRoot); assert.equal(two.config.projectRoot, otherRoot)
  assert.throws(() => one.assertController(b.agent), /DYNAMIC_CONTEXT_FULL_MODE_REQUIRED/)
  assert.equal(f.h.ctx.transactionGraph.listWorkflows(a.agent).length, 1)
  assert.equal(f.h.ctx.transactionGraph.listWorkflows(b.agent).length, 1)
})

test('mode switches cannot release an active leaf and base loss blocks further requests', async t => {
  const f = await fixture(t), { agent } = await f.agent('active')
  await f.call(agent, 'dynamic_context_select_mode', { reason: '项目任务' })
  const child = f.h.runner.interaction.entries.get(agent).runner
  await f.call(agent, 'dynamic_context_submit', { proposal: runtimeProposal([]) })
  child.graph.begin({ expectedRevision: 1, choice: 0 })
  await assert.rejects(f.call(agent, 'dynamic_context_select_mode', { reason: '改变模式', reconsider: true }), /IDLE_BOUNDARY/)
  assert.ok(child.graph.read().graph.state.active)
  f.h.ctx.transactionGraph.workflows.close()
  await assert.rejects(child.runNext({ expectedRevision: 2, sourceAgent: agent }), /DYNAMIC_CONTEXT_REQUIRES_ACTIVE_TASK_GRAPH/)
  assert.equal(f.h.backend.requests.length, 0)
})

for (const answer of ['恢复已核验快照（推荐）', '暂停并保留现场', null]) test(`committed graph loss requires recovery consent: ${answer}`, async t => {
  const f = await fixture(t, { choice: (_request, count) => count === 1 ? 'full' : answer })
  const { agent } = await f.agent('lost-graph')
  await f.call(agent, 'dynamic_context_select_mode', { reason: '项目任务' })
  await f.call(agent, 'dynamic_context_submit', { proposal: runtimeProposal([]) })
  const child = f.h.runner.interaction.entries.get(agent).runner
  child.graph.begin({ expectedRevision: 1, choice: 0 }); const saved = child.graph.read()
  fs.unlinkSync(child.graph.store.file)
  const status = await f.call(agent, 'dynamic_context_graph_status', {})
  assert.equal(status.linked.state, 'BOTH_GRAPHS_LOST')
  assert.equal((await f.call(agent, 'dynamic_context_select_mode', { reason: '改用原生', reconsider: true })).status, 'RECOVERY_REQUIRED')
  assert.equal((await f.call(agent, 'dynamic_context_submit', { proposal: { taskGraph: runtimeProposal([]).taskGraph } })).code, 'GRAPH_RECOVERY_REQUIRED')
  await assert.rejects(child.runNext({ sourceAgent: agent, expectedRevision: 2 }), /GRAPH_RECOVERY_REQUIRED/)
  const result = await f.call(agent, 'dynamic_context_recover_graphs', {})
  if (answer === '恢复已核验快照（推荐）') {
    assert.equal(result.restored, true); assert.equal(result.executionResumed, false)
    assert.deepEqual(child.graph.read(), saved)
  } else { assert.equal(result.changed, false); assert.equal(fs.existsSync(child.graph.store.file), false) }
  assert.equal(f.h.runner.interaction.mode(agent), 'full'); assert.equal(f.h.backend.requests.length, 0)
})

test('session commit receipt prevents fresh creation after both graph and witness are removed', async t => {
  const f = await fixture(t), { agent } = await f.agent('double-loss')
  await f.call(agent, 'dynamic_context_select_mode', { reason: '项目任务' })
  await f.call(agent, 'dynamic_context_submit', { proposal: runtimeProposal([]) })
  const child = f.h.runner.interaction.entries.get(agent).runner
  assert.ok(agent.session.snapshotEvents().some(event => event.type === GRAPH_COMMIT_RECORD))
  fs.unlinkSync(child.graph.store.file); fs.unlinkSync(child.graph.store.witness.file)
  assert.equal(child.graphPresence().state, 'GRAPH_AND_WITNESS_LOST_AFTER_COMMIT')
  assert.equal(child.graphPresence().canRestore, false)
  assert.throws(() => child.submit(runtimeProposal([]), { sourceAgent: agent }), /GRAPH_RECOVERY_REQUIRED/)
  assert.throws(() => f.h.runner.interaction.ensureIdle(agent), /GRAPH_RECOVERY_REQUIRED/)
  assert.equal((await f.call(agent, 'dynamic_context_select_mode', { reason: '回退', reconsider: true })).status, 'RECOVERY_REQUIRED')
  assert.equal(f.h.backend.requests.length, 0)
})

test('a partial replacement cannot discard a committed joint graph', async t => {
  const f = await fixture(t), { agent } = await f.agent('partial-replacement')
  await f.call(agent, 'dynamic_context_select_mode', { reason: '项目任务' })
  await f.call(agent, 'dynamic_context_submit', { proposal: runtimeProposal([]) })
  const child = f.h.runner.interaction.entries.get(agent).runner, before = child.graph.read()
  for (const key of ['taskGraph', 'contextGraph']) {
    const result = await f.call(agent, 'dynamic_context_submit', { proposal: { [key]: runtimeProposal([])[key] } })
    assert.equal(result.code, 'PARTIAL_UPDATE_REQUIRES_REVISION')
  }
  assert.deepEqual(child.graph.read(), before); assert.equal(f.questions.length, 1)
})

test('switching an idle workflow off does not erase its historical presence in graph status', async t => {
  const f = await fixture(t), { agent } = await f.agent('inactive-history')
  await f.call(agent, 'dynamic_context_select_mode', { reason: '项目任务' })
  await f.call(agent, 'dynamic_context_submit', { proposal: runtimeProposal([]) })
  const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '不启用任务图' }] })
  agent.session.append('user/message', message, { surfaceOp: 'append' })
  await f.call(agent, 'dynamic_context_select_mode', { reason: '用户更改选择', reconsider: true,
    explicit: { mode: 'native', userMessageId: message.id, quote: '不启用任务图' } })
  const result = await f.call(agent, 'dynamic_context_graph_status', {})
  assert.equal(result.mode, 'native')
  assert.equal(result.linked.state, 'INACTIVE_GRAPH_NOT_INSPECTED')
  assert.equal(result.linked.previouslyCommitted, true)
})

test('persisted full mode remounts its original graph after the controller is recreated', async t => {
  const f = await fixture(t), first = await f.agent('reopen')
  await f.call(first.agent, 'dynamic_context_select_mode', { reason: '项目任务' })
  await f.call(first.agent, 'dynamic_context_submit', { proposal: runtimeProposal([]) })
  const before = f.h.runner.interaction.entries.get(first.agent).runner.graph.read()
  await first.handle.dispose()
  const next = await f.h.ctx.agents.resume({ resumeSessionId: 'reopen', agentOptions: { provider: 'dynamic-context-fake', model: 'fake-llama' } })
  t.after(() => next.dispose())
  assert.equal(f.h.runner.interaction.mode(next.agent), 'full')
  assert.deepEqual(f.h.runner.interaction.entries.get(next.agent).runner.graph.read(), before)
  assert.ok(schemaNames(f.h.ctx, next.agent).includes('dynamic_context_run_next'))
  assert.equal(f.questions.length, 1)
})

for (const full of [false, true]) test(`native tool loop reaches ${full ? 'joint direct' : 'original task graph'} execution after human selection`, async t => {
  let controller, step = 0
  const call = (name, args) => ({ tools: [{ name, arguments: args }] })
  const f = await fixture(t, { respond: ({ payload }) => {
    // A direct worker request has no mode selector; it executes the leaf only.
    if (!payload.tools?.some(row => row.function.name === 'dynamic_context_select_mode')) return { text: 'Scoped leaf result.' }
    step++
    if (step === 1) return call('dynamic_context_select_mode', { reason: '项目级工作' })
    if (step === 2) return call('dynamic_context_submit', { proposal: full ? runtimeProposal([]) : { taskGraph: runtimeProposal([]).taskGraph } })
    if (full) return step === 3 ? call('dynamic_context_run_next', { expectedRevision: 1 }) : { text: 'Joint workflow submitted its report.' }
    if (step === 3) return call('transaction_graph_create', { expectedRevision: 0, definition: runtimeProposal([]).taskGraph })
    if (step === 4) return call('transaction_graph_begin', { expectedRevision: 1, choice: 0 })
    if (step === 5) return call('fixture_read_a', {})
    if (step === 6) {
      const evidence = controller.session.snapshotEvents().findLast(row => row.type === 'tool/result' && row.data.message.content.some(part => part.text?.includes('A_TOOL_PRIVATE_RAW')))
      assert.ok(evidence)
      return call('transaction_graph_finish', { expectedRevision: 2, outcome: 'complete', note: 'Verified fixture output.', evidence: [{ kind: 'tool_result', ref: sessionReference(controller.session.id, evidence.seq) }] })
    }
    if (step === 7) return call('transaction_graph_read', {})
    return { text: 'Task graph leaf finished.' }
  } })
  const item = await f.agent('native-loop', null); controller = item.agent
  controller.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '请开始推进并验证。' }] }))
  await controller.whenIdle()
  const failures = controller.session.snapshotEvents().filter(row => row.type === 'tool/result' && row.data.message.isError)
  assert.deepEqual(failures, [])
  if (full) {
    const child = f.h.runner.interaction.entries.get(controller).runner
    assert.equal(child.graph.read().revision, 3); assert.equal(child.graph.read().reports.length, 1)
  } else {
    const state = f.h.ctx.transactionGraph.host.snapshot(controller.session)
    assert.equal(state.graph.revision, 3)
    assert.equal(state.graph.nodes.find(row => row.kind === 'leaf').status, 'COMPLETE')
    assert.deepEqual(f.h.toolCalls, ['fixture_read_a'])
    // Removing the durable native journal also reaches the recovery gate.
    const { binding, key } = f.h.ctx.transactionGraph.host.journal(controller.session)
    fs.unlinkSync(path.join(binding.projectRoot, '.dsh', 'transaction-graphs-v4', key, 'transaction-host-journal.json'))
    assert.equal(f.h.runner.interaction.mode(controller), 'recovery')
    assert.equal((await f.call(controller, 'dynamic_context_select_mode', { reason: '回退', reconsider: true })).status, 'RECOVERY_REQUIRED')
  }
  assert.equal(f.questions.length, 1)
})
