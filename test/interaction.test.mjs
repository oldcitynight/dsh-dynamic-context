import test from 'node:test'
import { fixtureState } from '../testing/harness.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import UserQuestions from '@deepseek-ai/dsh-user-questions'
import Commands from '@deepseek-ai/dsh-commands'
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import TaskGraph from 'dsh-better-task-grapth'
import { z } from 'zod'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { bindScopeParent, createScope } from '@deepseek-ai/dsh-scope'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { rootTask, unitBackend } from '../testing/unit-proposal.mjs'
import { createRuntimeHarness, runtimeProposal } from '../testing/runtime-harness.mjs'
import { DynamicContextRuntime, validateConfig } from '../index.mjs'
import { MODE_OPTIONS, MODE_RECORD } from '../interaction.mjs'
import { GRAPH_COMMIT_RECORD } from '../graph-presence.mjs'
import { sessionReference } from 'dsh-better-task-grapth/host'

async function startGraph(f, agent, task) {
  if (!f.h.ctx.get('commands')) await f.h.ctx.plugin(Commands)
  return f.h.ctx.commands.execute(agent, '/task-graph ' + task, [], new AbortController().signal)
}

for (const mode of ['native', 'task-graph', 'full']) test(`human /task-graph command selects ${mode} before the first model request`, async t => {
  const f = await fixture(t, { choice: mode, revision: true, setup: ctx => ctx.plugin(Commands), respond: ({ payload }) => {
    assert.equal(f.questions.length, 1)
    const text = JSON.stringify(payload.messages)
    assert.match(text, /COMMAND_TASK_WITH_EXACT_CONSTRAINT/)
    assert.match(text, /selected/)
    const names = payload.tools?.map(row => row.function.name) ?? []
    assert.equal(names.includes('dynamic_context_submit'), mode === 'full')
    assert.equal(names.includes('transaction_graph_create'), mode === 'task-graph')
    return { text: 'Fake command entry observed.' }
  } })
  const { agent } = await f.agent('command-' + mode, null)
  assert.ok(f.h.ctx.commands.list(agent).some(row => row.name === 'task-graph'))
  const result = await f.h.ctx.commands.execute(agent, '/task-graph COMMAND_TASK_WITH_EXACT_CONSTRAINT', [], new AbortController().signal)
  assert.equal(result.result.kind, 'success')
  await agent.whenIdle()
  assert.equal(f.h.backend.requests.length, 1)
  assert.deepEqual(f.h.backend.errors, [])
  assert.equal(f.h.runner.interaction.mode(agent), mode)
  if (mode === 'full') {
    const row = f.h.runner.interaction.record(agent)
    assert.equal(row.evidence.commandId, result.commandId)
    assert.match(JSON.stringify(row.policy), /COMMAND_TASK_WITH_EXACT_CONSTRAINT/)
    assert.equal(f.h.runner.interaction.entries.get(agent).runner.graph.read(), null)
  }
  const lifecycle = agent.session.snapshotEvents().filter(row => row.type.startsWith('command/'))
  assert.deepEqual(lifecycle.map(row => row.type), ['command/run', 'command/done'])
})

test('the default human command enters full units once and preserves an unrelated native conversation', async t => {
  const f = await fixture(t, { setup: ctx => ctx.plugin(Commands), config: { interaction: { mode: 'interactive', orchestration: false } } })
  const { agent } = await f.agent('default-full-command')
  const sibling = (await f.agent('default-native-sibling')).agent
  assert.equal(f.h.runner.interaction.mode(agent), 'native')
  const command = () => f.h.ctx.commands.execute(agent, '/task-graph Build the fixture.', [], new AbortController().signal)
  assert.equal((await command()).result.kind, 'success')
  await agent.whenIdle()
  const selection = f.h.runner.interaction.record(agent)
  assert.equal(selection.mode, 'full')
  assert.equal(selection.unitWorkflowVersion, 2)
  assert.equal(selection.evidence.source, 'human-command')
  const runner = f.h.runner.interaction.entries.get(agent).runner
  assert.equal(runner.graph.read(), null)
  const release = runner.storage
    ? JSON.parse(runner.storage.db.q('SELECT workflow_release FROM instance WHERE id=1').get().workflow_release)
    : JSON.parse(fs.readFileSync(path.join(runner.config.directory, '.workflow-storage-v1'), 'utf8').split('\n')[1]).release
  assert.equal(release.workflowCompatibilityEpoch, 1)
  assert.deepEqual(Object.keys(release.pluginVersions).sort(), ['dsh-better-task-grapth', 'dsh-dynamic-context'])
  assert.equal(f.h.runner.interaction.mode(sibling), 'native')
  await command()
  await agent.whenIdle()
  assert.equal(f.questions.length, 0)
  assert.equal(agent.session.snapshotEvents().filter(row => row.type === MODE_RECORD).length, 1)
})

test('an empty command reuses the current task and repeats do not ask again or replace a committed graph', async t => {
  const f = await fixture(t, { setup: ctx => ctx.plugin(Commands) })
  const { agent } = await f.agent('repeat-command', 'EXISTING_USER_TASK')
  const invoke = () => f.h.ctx.commands.execute(agent, '/task-graph', [], new AbortController().signal)
  await invoke(); await agent.whenIdle()
  await f.call(agent, 'dynamic_context_submit', { proposal: rootTask() })
  const runner = f.h.runner.interaction.entries.get(agent).runner, before = runner.graph.read().checksum
  await invoke(); await agent.whenIdle()
  assert.equal(f.questions.length, 1)
  assert.equal(runner.graph.read().checksum, before)
  assert.match(JSON.stringify(f.h.backend.requests[0].payload.messages), /EXISTING_USER_TASK/)
  assert.deepEqual(f.h.backend.errors, [])
})

test('a human command may reconsider a previous native choice, but missing historical graphs block it', async t => {
  let choice = 'native'
  const f = await fixture(t, { choice: () => choice, setup: ctx => ctx.plugin(Commands) })
  const { agent } = await f.agent('reconsider-command')
  await startGraph(f, agent, '')
  await agent.whenIdle()
  choice = 'full'
  const invoke = () => f.h.ctx.commands.execute(agent, '/task-graph', [], new AbortController().signal)
  assert.equal((await invoke()).result.kind, 'success'); await agent.whenIdle()
  assert.equal(f.questions.length, 2)
  const runner = f.h.runner.interaction.entries.get(agent).runner
  await f.call(agent, 'dynamic_context_submit', { proposal: rootTask() })
  const graphFile = runner.graph.store.file
  // Damage the actual ledger, preserving its witness and session receipts.
  if (runner.storage) runner.storage.db.put('graph/state', 'broken ledger')
  else fs.writeFileSync(graphFile, 'broken ledger')
  const count = f.h.backend.requests.length
  assert.equal((await invoke()).result.kind, 'error')
  assert.equal(f.h.backend.requests.length, count)
})

test('the command enters the real graph submission and direct worker path under fake HTTP', async t => {
  let rootSteps = 0, workers = 0
  const f = await fixture(t, { setup: ctx => ctx.plugin(Commands), respond: ({ payload }) => {
    if (!(payload.tools ?? []).some(row => row.function.name === 'dynamic_context_graph_status')) {
      workers++; return { text: 'Fake leaf evidence-qualified result.' }
    }
    rootSteps++
    if (rootSteps === 1) return { tools: [{ name: 'dynamic_context_submit', arguments: { proposal: rootTask() } }] }
    if (rootSteps === 2) {
      const submitted = JSON.parse(payload.messages.findLast(row => row.role === 'tool').content)
      return { tools: [{ name: submitted.nextTool, arguments: submitted.arguments }] }
    }
    return { text: 'The leaf report is recorded; acceptance remains independent.' }
  } })
  const { agent } = await f.agent('command-real-flow', null)
  assert.equal((await f.h.ctx.commands.execute(agent, '/task-graph 处理并检查这个小任务', [], new AbortController().signal)).result.kind, 'success')
  await agent.whenIdle()
  assert.deepEqual(f.h.backend.errors, [])
  assert.deepEqual([rootSteps, workers, f.questions.length], [3, 1, 1])
  assert.equal(f.h.runner.interaction.entries.get(agent).runner.graph.read().reports.length, 1)
  assert.deepEqual(agent.session.snapshotEvents().filter(row => row.type === 'tool/call').map(row => row.data.name),
    ['dynamic_context_submit', 'dynamic_context_run_next'])
})

test('cancelling a command while its question is open cannot accept a late answer', async t => {
  let entered, resolveChoice
  const ready = new Promise(resolve => { entered = resolve })
  const choice = new Promise(resolve => { resolveChoice = resolve })
  const f = await fixture(t, { setup: ctx => ctx.plugin(Commands), choice: () => { entered(); return choice } })
  const { agent } = await f.agent('cancel-question')
  const abort = new AbortController()
  const pending = f.h.ctx.commands.execute(agent, '/task-graph', [], abort.signal)
  const stopped = assert.rejects(pending, /cancelled/)
  await ready; abort.abort(new Error('cancelled')); resolveChoice('full')
  await stopped
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.h.runner.interaction.record(agent), undefined)
  assert.equal(f.h.runner.interaction.pending.has(agent), false)
  assert.equal(f.h.backend.requests.length, 0)
})

test('cancelled or unanswered command choices enqueue no model turn', async t => {
  const f = await fixture(t, { choice: null, setup: ctx => ctx.plugin(Commands) })
  const { agent } = await f.agent('empty-command-choice')
  const result = await f.h.ctx.commands.execute(agent, '/task-graph', [], new AbortController().signal)
  assert.equal(result.result.kind, 'error')
  assert.equal(f.h.runner.interaction.record(agent), undefined)
  assert.equal(f.h.backend.requests.length, 0)
  const abort = new AbortController(); abort.abort(new Error('cancelled'))
  await assert.rejects(f.h.ctx.commands.execute(agent, '/task-graph', [], abort.signal), /cancelled/)
  assert.equal(f.questions.length, 1)
  assert.equal(f.h.backend.requests.length, 0)
})

async function readGraphDock(ctx, agent) {
  const service = ctx.transactionGraph
  const resolveAgent = async sessionId => {
    assert.equal(sessionId, agent.session.id)
    return { agent }
  }
  const result = await TaskGraph.prototype.status.call({
    ctx: { get: name => name === 'sessionController' ? { resolveAgent } : undefined },
    host: service.host, workflows: service.workflows,
  }, { sessionId: agent.session.id })
  // The deployed Host and lazy browser module share this exact result codec.
  const { createRemoteContribution } = await import(new URL('./remote.mjs', import.meta.resolve('dsh-better-task-grapth')))
  return createRemoteContribution(z).descriptors[0].result.create().parse(result)
}

async function fixture(t, { choice = 'full', revision = false, respond, taskGraph = true, setup, config = {}, plan } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'interaction-boundaries-')))
  const projectRoot = path.join(root, 'project'); fs.mkdirSync(projectRoot)
  const questions = [], handles = []
  const h = await createRuntimeHarness({ projectRoot, directory: path.join(root, 'state'), taskGraph,
    config: { storageRoot: root, interaction: { mode: 'interactive', orchestration: false, commandMode: 'ask' }, exposeControlTools: true,
      ...(revision ? { revision: { policy: { objective: 'MUST_NOT_LEAK_TEMPLATE_GOAL', requirements: [{ id: 'original', text: 'Template only.' }] } } } : {}), ...config },
    respond: unitBackend(respond ?? (() => ({ text: 'Fake scoped result.' })), { plan }),
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
      await setup?.(ctx)
    } })
  t.after(async () => { for (const handle of handles) await handle.dispose(); await h.close(); fs.rmSync(root, { recursive: true, force: true }) })
  async function agent(id, text = '实现并验证当前项目，保留用户验收标准。', cwd = projectRoot, setup) {
    const handle = await h.ctx.agents.create({ sessionId: id, meta: { cwd }, setup,
      agentOptions: { provider: 'dynamic-context-fake', model: 'fake-llama' } })
    handles.push(handle)
    const message = text === null ? null : createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
    if (message) handle.agent.session.append('user/message', message, { surfaceOp: 'append' })
    return { handle, agent: handle.agent, message }
  }
  const call = (agent, name, args) => h.ctx.tools.get(name, agent).execute(args, { agent, name, callId: 'fixture-' + name, signal: new AbortController().signal })
  // Exercise mode transitions in isolation, without queuing a model turn.
  const selectMode = (agent, args) => h.runner.interaction.select(agent, args, new AbortController().signal)
  return { h, root, projectRoot, questions, agent, call, selectMode }
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
  assert.ok(initial.contexts.some(row => row.text.includes('当前未通过 /task-graph 启用任务图')))
  assert.equal((await f.selectMode(first.agent, { reason: '项目级工作' })).mode, mode)
  assert.deepEqual(f.questions[0][0].options.map(row => row.label), MODE_OPTIONS.map(row => row.label))
  assert.equal(f.h.runner.interaction.mode(second.agent), 'native')
  assert.equal(schemaNames(f.h.ctx, first.agent).includes('transaction_graph_create'), mode === 'task-graph')
  assert.equal(schemaNames(f.h.ctx, first.agent).includes('dynamic_context_submit'), mode === 'full')
  assert.equal((await f.selectMode(first.agent, { reason: '重复调用' })).alreadySelected, true)
  assert.equal(f.questions.length, 1)
  assert.ok(first.agent.session.snapshotEvents().some(row => row.type === MODE_RECORD && row.data.mode === mode))
  const selected = await f.h.ctx.systemPrompt.assemble({ agent: first.agent, scope: first.agent })
  assert.equal(selected.contexts.some(row => row.text.includes('当前未通过 /task-graph 启用任务图')), false)
  assert.equal(selected.contexts.some(row => row.text.includes('"role":"controller"')), mode === 'full')
  const secondPrompt = await f.h.ctx.systemPrompt.assemble({ agent: second.agent, scope: second.agent })
  assert.doesNotMatch(JSON.stringify(secondPrompt), /FIRST_TASK_CONTRACT|MUST_NOT_LEAK_TEMPLATE_GOAL/)
  if (mode === 'full') {
    const firstPrompt = await f.h.ctx.systemPrompt.assemble({ agent: first.agent, scope: first.agent })
    assert.match(JSON.stringify(firstPrompt), /FIRST_TASK_CONTRACT/)
    assert.doesNotMatch(JSON.stringify(firstPrompt), /SECOND_TASK_CONTRACT|MUST_NOT_LEAK_TEMPLATE_GOAL/)
    await f.call(first.agent, 'dynamic_context_submit', { proposal: rootTask() })
    const result = await f.call(first.agent, 'dynamic_context_run_next', { expectedRevision: 1 })
    assert.equal(result.revision, 3); assert.equal(f.h.backend.requests.length, 5)
  } else assert.equal(f.h.backend.requests.length, 0)
})

test('task-only proposal falls back to original graph tools without committing a joint ledger', async t => {
  const f = await fixture(t), { agent } = await f.agent('task-only')
  await f.selectMode(agent, { reason: '项目级任务' })
  const child = f.h.runner.interaction.entries.get(agent).runner
  const taskGraph = runtimeProposal([]).taskGraph
  const result = await f.call(agent, 'dynamic_context_submit', { proposal: { taskGraph } })
  assert.equal(result.status, 'TASK_GRAPH_ONLY'); assert.equal(result.committed, false)
  assert.equal(result.nextTool, 'transaction_graph_create'); assert.deepEqual(result.arguments.definition, taskGraph)
  assert.equal(fixtureState(child), null)
  assert.equal(f.h.runner.interaction.mode(agent), 'task-graph')
  assert.equal(schemaNames(f.h.ctx, agent).includes('dynamic_context_run_next'), false)
  assert.equal(schemaNames(f.h.ctx, agent).includes('transaction_graph_create'), true)
  assert.equal(f.h.backend.requests.length, 0)
})

for (const fallback of ['回退到原生状态', '不回退，补齐任务图', null]) test(`orphan context reports error and requests human fallback: ${fallback}`, async t => {
  const f = await fixture(t, { choice: (_request, count) => count === 1 ? 'full' : fallback })
  const { agent } = await f.agent('orphan')
  await f.selectMode(agent, { reason: '项目级任务' })
  const child = f.h.runner.interaction.entries.get(agent).runner
  const result = await f.call(agent, 'dynamic_context_submit', { proposal: { contextGraph: runtimeProposal([]).contextGraph } })
  assert.equal(result.code, 'CONTEXT_GRAPH_REQUIRES_TASK_GRAPH')
  assert.equal(f.questions.length, 2); assert.match(f.questions[1][0].question, /缺少前置任务图/)
  assert.equal(f.h.runner.interaction.mode(agent), fallback === '回退到原生状态' ? 'native' : 'full')
  assert.equal(fixtureState(child), null); assert.equal(f.h.backend.requests.length, 0)
})

test('unanswered initial question never selects the recommended full mode', async t => {
  const f = await fixture(t, { choice: null }), { agent } = await f.agent('unanswered')
  const result = await f.selectMode(agent, { reason: '项目级任务' })
  assert.equal(result.status, 'NEEDS_USER_CHOICE'); assert.equal(result.changed, false)
  assert.equal(f.h.runner.interaction.record(agent), undefined)
  assert.equal(f.h.backend.requests.length, 0)
})

test('whole explicit user choice is honored; quoted or negated phrases do not authorize a mode', async t => {
  const f = await fixture(t, { choice: 'native' })
  const explicit = await f.agent('explicit', '使用动态上下文')
  const result = await f.selectMode(explicit.agent, { reason: '用户指定', explicit: { mode: 'full', userMessageId: explicit.message.id, quote: '使用动态上下文' } })
  assert.equal(result.mode, 'full'); assert.equal(f.questions.length, 0)
  const negated = await f.agent('negated', '不要“使用动态上下文”，这是一个反例。')
  const denied = await f.selectMode(negated.agent, { reason: '需要确认', explicit: { mode: 'full', userMessageId: negated.message.id, quote: '使用动态上下文' } })
  assert.equal(denied.mode, 'native'); assert.equal(f.questions.length, 1)
})

test('new conversations in different projects get guidance and distinct full workflows', async t => {
  const f = await fixture(t), otherRoot = path.join(f.root, 'other-project'); fs.mkdirSync(otherRoot)
  const a = await f.agent('project-a', 'PROJECT_A', f.projectRoot), b = await f.agent('project-b', 'PROJECT_B', otherRoot)
  for (const item of [a, b]) {
    const prompt = await f.h.ctx.systemPrompt.assemble({ agent: item.agent, scope: item.agent })
    assert.match(JSON.stringify(prompt), /任务图与动态上下文使用指引/)
    await f.selectMode(item.agent, { reason: '项目任务' })
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
  await f.selectMode(agent, { reason: '项目任务' })
  const child = f.h.runner.interaction.entries.get(agent).runner
  await f.call(agent, 'dynamic_context_submit', { proposal: rootTask() })
  await child.runNext({ expectedRevision: 1, routeOnly: true, sourceAgent: agent })
  child.graph.begin({ expectedRevision: 1, choice: 0 })
  await assert.rejects(f.selectMode(agent, { reason: '改变模式', reconsider: true }), /IDLE_BOUNDARY/)
  assert.ok(child.graph.read().graph.state.active)
  f.h.ctx.transactionGraph.workflows.close()
  await assert.rejects(child.runNext({ expectedRevision: 2, sourceAgent: agent }), /DYNAMIC_CONTEXT_REQUIRES_ACTIVE_TASK_GRAPH/)
  assert.equal(f.h.backend.requests.length, 2)
})

for (const answer of ['恢复已核验快照（推荐）', '暂停并保留现场', null]) test(`committed graph loss requires recovery consent: ${answer}`, async t => {
  const f = await fixture(t, { config: { storageFormat: 'files' }, choice: (_request, count) => count === 1 ? 'full' : answer })
  const { agent } = await f.agent('lost-graph')
  await f.selectMode(agent, { reason: '项目任务' })
  await f.call(agent, 'dynamic_context_submit', { proposal: rootTask() })
  const child = f.h.runner.interaction.entries.get(agent).runner
  await child.runNext({ expectedRevision: 1, routeOnly: true, sourceAgent: agent })
  child.graph.begin({ expectedRevision: 1, choice: 0 }); const saved = child.graph.read()
  fs.unlinkSync(child.graph.store.file)
  const status = await f.call(agent, 'dynamic_context_graph_status', {})
  assert.equal(status.linked.state, 'BOTH_GRAPHS_LOST')
  assert.equal((await f.selectMode(agent, { reason: '改用原生', reconsider: true })).status, 'RECOVERY_REQUIRED')
  assert.equal((await f.call(agent, 'dynamic_context_submit', { proposal: { taskGraph: runtimeProposal([]).taskGraph } })).code, 'GRAPH_RECOVERY_REQUIRED')
  await assert.rejects(child.runNext({ sourceAgent: agent, expectedRevision: 2 }), /GRAPH_RECOVERY_REQUIRED/)
  const result = await f.call(agent, 'dynamic_context_recover_graphs', {})
  if (answer === '恢复已核验快照（推荐）') {
    assert.equal(result.restored, true); assert.equal(result.executionResumed, false)
    assert.deepEqual(child.graph.read(), saved)
  } else { assert.equal(result.changed, false); assert.equal(fs.existsSync(child.graph.store.file), false) }
  assert.equal(f.h.runner.interaction.mode(agent), 'full'); assert.equal(f.h.backend.requests.length, 2)
})

test('session commit receipt prevents fresh creation after both graph and witness are removed', async t => {
  const f = await fixture(t, { config: { storageFormat: 'files' } }), { agent } = await f.agent('double-loss')
  await f.selectMode(agent, { reason: '项目任务' })
  await f.call(agent, 'dynamic_context_submit', { proposal: rootTask() })
  const child = f.h.runner.interaction.entries.get(agent).runner
  assert.ok(agent.session.snapshotEvents().some(event => event.type === GRAPH_COMMIT_RECORD))
  fs.unlinkSync(child.graph.store.file); fs.unlinkSync(child.graph.store.witness.file)
  assert.equal(child.graphPresence().state, 'GRAPH_AND_WITNESS_LOST_AFTER_COMMIT')
  assert.equal(child.graphPresence().canRestore, false)
  assert.throws(() => child.submit(runtimeProposal([]), { sourceAgent: agent }), /GRAPH_RECOVERY_REQUIRED/)
  assert.throws(() => f.h.runner.interaction.ensureIdle(agent), /GRAPH_RECOVERY_REQUIRED/)
  assert.equal((await f.selectMode(agent, { reason: '回退', reconsider: true })).status, 'RECOVERY_REQUIRED')
  assert.equal(f.h.backend.requests.length, 1)
})

test('a partial replacement cannot discard a committed joint graph', async t => {
  const f = await fixture(t), { agent } = await f.agent('partial-replacement')
  await f.selectMode(agent, { reason: '项目任务' })
  await f.call(agent, 'dynamic_context_submit', { proposal: rootTask() })
  const child = f.h.runner.interaction.entries.get(agent).runner, before = child.graph.read()
  for (const key of ['taskGraph', 'contextGraph']) {
    const result = await f.call(agent, 'dynamic_context_submit', { proposal: { [key]: runtimeProposal([])[key] } })
    assert.equal(result.code, 'PARTIAL_UPDATE_REQUIRES_REVISION')
  }
  assert.deepEqual(child.graph.read(), before); assert.equal(f.questions.length, 1)
})

test('switching an idle workflow off does not erase its historical presence in graph status', async t => {
  const f = await fixture(t), { agent } = await f.agent('inactive-history')
  await f.selectMode(agent, { reason: '项目任务' })
  await f.call(agent, 'dynamic_context_submit', { proposal: rootTask() })
  const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '不启用任务图' }] })
  agent.session.append('user/message', message, { surfaceOp: 'append' })
  await f.selectMode(agent, { reason: '用户更改选择', reconsider: true,
    explicit: { mode: 'native', userMessageId: message.id, quote: '不启用任务图' } })
  const result = await f.call(agent, 'dynamic_context_graph_status', {})
  assert.equal(result.mode, 'native')
  assert.equal(result.linked.state, 'INACTIVE_GRAPH_NOT_INSPECTED')
  assert.equal(result.linked.previouslyCommitted, true)
})

test('persisted full mode remounts its original graph after the controller is recreated', async t => {
  const f = await fixture(t), first = await f.agent('reopen')
  await f.selectMode(first.agent, { reason: '项目任务' })
  await f.call(first.agent, 'dynamic_context_submit', { proposal: rootTask() })
  const before = f.h.runner.interaction.entries.get(first.agent).runner.graph.read()
  await first.handle.dispose()
  const next = await f.h.ctx.agents.resume({ resumeSessionId: 'reopen', agentOptions: { provider: 'dynamic-context-fake', model: 'fake-llama' } })
  t.after(() => next.dispose())
  assert.equal(f.h.runner.interaction.mode(next.agent), 'full')
  assert.deepEqual(f.h.runner.interaction.entries.get(next.agent).runner.graph.read(), before)
  assert.ok(schemaNames(f.h.ctx, next.agent).includes('dynamic_context_run_next'))
  assert.equal(f.questions.length, 1)
})

test('the Web status RPC displays the committed linked graph for its session, including after reopening', async t => {
  const f = await fixture(t, { plan: { keys: ['task','later'], rules: [{ id: 'after', when: { node: 'task', in: ['PASS'] } }] } }), { agent, handle } = await f.agent('web-linked')
  const other = await f.agent('web-other-session')
  assert.equal((await readGraphDock(f.h.ctx, agent)).status, 'empty')
  await f.selectMode(agent, { reason: '项目任务' })
  assert.equal((await readGraphDock(f.h.ctx, agent)).status, 'empty')
  const proposal = rootTask()
  proposal.contextGraph.nodes[0].content = 'PRIVATE_CONTEXT_DO_NOT_DISPLAY'
  await f.call(agent, 'dynamic_context_submit', { proposal })
  const child = f.h.runner.interaction.entries.get(agent).runner
  await child.runNext({ expectedRevision: 1, routeOnly: true, sourceAgent: agent })
  const planned = child.graph.read().revision
  const created = await readGraphDock(f.h.ctx, agent)
  assert.equal(created.status, 'ready')
  assert.equal(created.graph.revision, planned)
  assert.equal(created.graph.nodes.length, 3)
  assert.equal(created.graph.edges.length, 1)
  assert.equal(created.graph.legalNext.length, 1)
  assert.deepEqual(created.graph.skipChoices, [])
  assert.doesNotMatch(JSON.stringify(created), /PRIVATE_CONTEXT_DO_NOT_DISPLAY/)
  assert.equal((await readGraphDock(f.h.ctx, other.agent)).status, 'empty')
  assert.equal(f.h.ctx.transactionGraph.host.snapshot(agent.session).status, 'empty')

  await child.runNext({ expectedRevision: planned, routeOnly: true, sourceAgent: agent })
  child.graph.begin({ expectedRevision: planned })
  const started = await readGraphDock(f.h.ctx, agent)
  assert.equal(started.graph.revision, planned + 1)
  assert.equal(started.graph.active.recoveryRequired, false)
  assert.deepEqual(started.graph.legalNext, [])
  assert.equal(started.graph.nodes.find(node => node.label === 'later').blocked, true)
  const requests = f.h.backend.requests.length
  await handle.dispose()
  const reopened = await f.h.ctx.agents.resume({ resumeSessionId: agent.session.id,
    agentOptions: { provider: 'dynamic-context-fake', model: 'fake-llama' } })
  t.after(() => reopened.dispose())
  const resumed = await readGraphDock(f.h.ctx, reopened.agent)
  assert.equal(resumed.graph.revision, planned + 1)
  assert.equal(resumed.graph.active.recoveryRequired, true)
  assert.equal(resumed.graph.active.nodeId, started.graph.active.nodeId)
  assert.equal(f.h.backend.requests.length, requests)
})

test('the Web status RPC does not repair an unresolved witness or hide a missing committed graph as empty', async t => {
  const f = await fixture(t, { config: { storageFormat: 'files' } }), { agent } = await f.agent('web-recovery')
  await f.selectMode(agent, { reason: '项目任务' })
  await f.call(agent, 'dynamic_context_submit', { proposal: rootTask() })
  const { graph } = f.h.runner.interaction.entries.get(agent).runner
  const state = graph.read(), witness = graph.store.witness.read()
  graph.store.writeWitness(witness, 'PREPARED', state, state.checksum)
  const prepared = fs.readFileSync(graph.store.witness.file)
  assert.deepEqual(await readGraphDock(f.h.ctx, agent), { sessionId: agent.session.id, status: 'unavailable', graph: null })
  assert.deepEqual(fs.readFileSync(graph.store.witness.file), prepared)

  fs.unlinkSync(graph.store.file)
  fs.unlinkSync(graph.store.witness.file)
  assert.equal((await readGraphDock(f.h.ctx, agent)).status, 'unavailable')
  assert.equal(fs.existsSync(graph.store.file), false)
  assert.equal(fs.existsSync(graph.store.witness.file), false)
  assert.equal(f.h.backend.requests.length, 1)
})

for (const full of [false, true]) test(`native tool loop reaches ${full ? 'joint direct' : 'original task graph'} execution after human selection`, async t => {
  let controller, step = 1
  const call = (name, args) => ({ tools: [{ name, arguments: args }] })
  const f = await fixture(t, { respond: ({ payload }) => {
    // A direct worker request has no mode selector; it executes the leaf only.
    if (!payload.tools?.some(row => row.function.name === 'dynamic_context_graph_status')) return { text: 'Scoped leaf result.' }
    step++
    if (step === 2) return call('dynamic_context_submit', { proposal: full ? rootTask() : { taskGraph: runtimeProposal([]).taskGraph } })
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
  await startGraph(f, controller, '请开始推进并验证。')
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
    assert.equal((await f.selectMode(controller, { reason: '回退', reconsider: true })).status, 'RECOVERY_REQUIRED')
  }
  assert.equal(f.questions.length, 1)
})

test('the native planner receives a usable joint template and specific tool and topology feedback', async t => {
  let step = 1, accepted
  const f = await fixture(t, { respond: ({ payload }) => {
    const tools = payload.tools?.map(row => row.function) ?? []
    const call = (name, args) => ({ tools: [{ name, arguments: args }] })
    step++
    if (step === 2) {
      for (const tool of tools.filter(row => row.name.startsWith('dynamic_context_'))) {
        const samples = [...tool.description.matchAll(/```json\n([^\n]+)\n```/g)].map(match => JSON.parse(match[1]))
        assert.ok(samples.length, tool.name)
        for (const args of samples) assert.deepEqual(validateJsonSchemaValue(tool.parameters, args, ''), [], tool.name)
      }
      const doc = tools.find(row => row.name === 'dynamic_context_submit').description
      assert.match(doc, /Unit tool allowlist for this workflow: \["read","write"/)
      accepted = JSON.parse(doc.match(/```json\n([^\n]+)\n```/)[1])
      const denied = structuredClone(accepted)
      denied.proposal.contextGraph.bindings[0].tools = ['fixture_forbidden']
      return call('dynamic_context_submit', denied)
    }
    if (step === 3) {
      const feedback = JSON.stringify(payload.messages.at(-1))
      for (const text of ['CONTEXT_CANNOT_GRANT_TOOL_PERMISSION', 'root', 'fixture_forbidden', 'allowedTools']) assert.ok(feedback.includes(text), feedback)
      const invalid = structuredClone(accepted)
      invalid.proposal.taskGraph.nodes.push({ key: 'inspect', label: 'Premature child', parent: 'root', kind: 'leaf' })
      invalid.proposal.taskGraph.edges.push({ kind: 'prerequisite', from: 'root', to: 'inspect' })
      return call('dynamic_context_submit', invalid)
    }
    if (step === 4) {
      const feedback = JSON.stringify(payload.messages.at(-1))
      for (const text of ['UNIT_ROOT_SEED_REQUIRED']) assert.ok(feedback.includes(text), feedback)
      return call('dynamic_context_submit', accepted)
    }
    return { text: 'The documented template passed graph validation.' }
  } })
  const { agent } = await f.agent('documented-joint-graph', null)
  await startGraph(f, agent, 'Plan and check this project task.')
  await agent.whenIdle()
  assert.deepEqual(f.h.backend.errors, [])
  assert.equal(step, 5)
  const state = f.h.runner.interaction.entries.get(agent).runner.graph.read()
  assert.equal(state.revision, 1)
  assert.equal(state.graph.state.plan.edges.length, 0)
})

test('the command-selected full controller dispatches the leaf from its receipt', async t => {
  let preset, step = 1, workerRequests = 0
  const executed = []
  const tools = (name, args) => ({ tools: [{ name, arguments: args }] })
  const text = (payload, role) => payload.messages.filter(row => row.role === role).map(row => JSON.stringify(row.content)).join('\n')
  const register = (ctx, name) => ctx.tools.register(defineTool({
    name, description: 'Synthetic native tool for checking dispatch boundaries.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => { executed.push(name); return 'executed ' + name },
  }))
  const f = await fixture(t, {
    async setup(ctx) {
      await ctx.plugin(Commands)
      const key = {}
      const scope = createScope(ctx, key)
      preset = key
      await scope.ctx.plugin({ inject: ['tools'], apply(presetCtx) {
        for (const name of ['todo_write', 'read', 'bash', 'write', 'subagent']) register(presetCtx, name)
      } })
    },
    respond({ payload }) {
      const names = payload.tools?.map(row => row.function.name) ?? []
      if (!names.includes('dynamic_context_graph_status')) {
        assert.ok(names.includes('write')); assert.ok(!names.includes('bash') && !names.includes('todo_write'))
        if (workerRequests++ === 0) return tools('write', { file_path: 'worker-result.txt', content: 'Written under the committed leaf.' })
        return { text: 'Checked fixture handoff.' }
      }
      ++step
      assert.match(text(payload, 'system'), /只通过用户实际输入 \/task-graph/)
      for (const name of ['todo_write', 'bash', 'write', 'subagent']) assert.ok(!names.includes(name), name)
      assert.ok(names.includes('read'))
      if (step === 2) {
        assert.match(text(payload, 'user'), /唯一的根单元/)
        assert.match(text(payload, 'user'), /既有条件|已有条件/)
        assert.match(text(payload, 'user'), /尚待验证的内容标作假设/)
        return { tools: ['read', 'todo_write', 'late_fixture_write'].map(name => ({ name, arguments: {} })) }
      }
      if (step === 3) {
        assert.match(text(payload, 'tool'), /executed read/)
        assert.match(text(payload, 'tool'), /DYNAMIC_CONTEXT_CONTROLLER_TOOL_NOT_ALLOWED: todo_write/)
        assert.match(text(payload, 'tool'), /DYNAMIC_CONTEXT_CONTROLLER_TOOL_NOT_ALLOWED: late_fixture_write/)
        const proposal = rootTask(['write'])
        return { tools: [
          { name: 'dynamic_context_submit', arguments: { proposal } },
          { name: 'bash', arguments: {} }, { name: 'write', arguments: {} },
        ] }
      }
      if (step === 4) {
        assert.match(text(payload, 'tool'), /DYNAMIC_CONTEXT_CONTROLLER_TOOL_NOT_ALLOWED: bash/)
        assert.match(text(payload, 'tool'), /DYNAMIC_CONTEXT_CONTROLLER_TOOL_NOT_ALLOWED: write/)
        const receipt = payload.messages.filter(row => row.role === 'tool')
          .map(row => typeof row.content === 'string' ? row.content : row.content.map(block => block.text ?? '').join(''))
          .map(content => { try { return JSON.parse(content) } catch { return null } })
          .find(value => value?.nextTool === 'dynamic_context_run_next')
        assert.deepEqual(receipt?.arguments, { expectedRevision: 1, choice: 0 })
        const runtime = text(payload, 'user')
        assert.match(runtime, /standaloneGraphPresence/)
        assert.doesNotMatch(runtime, /taskGraphPresent/)
        assert.match(runtime, /只有联合账本中的执行与验收状态可以确认叶的结果/)
        assert.match(runtime, /不会把你切换为叶执行者/)
        assert.match(runtime, /写文件不等于更新共享上下文/)
        return tools(receipt.nextTool, receipt.arguments)
      }
      return { text: 'Leaf finished through its bound worker.' }
    },
  })
  const { agent } = await f.agent('controller-boundaries', null, f.projectRoot, async (agentCtx, agent) => {
    bindScopeParent(agent, preset)
    await agentCtx.plugin({ inject: ['tools'], apply(localCtx) { register(localCtx, 'late_fixture_write') } })
  })
  await f.h.ctx.commands.execute(agent, '/task-graph 请制作一个整合包，完成依赖选型、配置和集成测试，并提交可验证的结果。', [], new AbortController().signal)
  await agent.whenIdle()
  assert.deepEqual(f.h.backend.errors, [])
  assert.equal(step, 5)
  assert.equal(workerRequests, 2)
  assert.deepEqual(executed, ['read'])
  assert.equal(fs.readFileSync(path.join(f.projectRoot, 'worker-result.txt'), 'utf8'), 'Written under the committed leaf.')
  assert.deepEqual(f.questions[0][0].options.map(row => row.label), MODE_OPTIONS.map(row => row.label))
  assert.deepEqual(agent.session.snapshotEvents().filter(row => row.type === 'tool/call').map(row => row.data.name),
    ['read', 'todo_write', 'late_fixture_write', 'dynamic_context_submit', 'bash', 'write', 'dynamic_context_run_next'])
  const runner = f.h.runner.interaction.entries.get(agent).runner
  assert.equal(runner.graph.read().reports.length, 1)
  assert.equal(runner.status().taskGraph.nodes.find(row => row.kind === 'leaf').status, 'COMPLETE')
  assert.deepEqual(runner.status().taskGraph.legalNext, [])

  const other = await f.agent('native-neighbor', null, f.projectRoot, (_ctx, agent) => { bindScopeParent(agent, preset) })
  assert.ok(schemaNames(f.h.ctx, other.agent).includes('todo_write'))
  assert.ok(schemaNames(f.h.ctx, other.agent).includes('bash'))
  await f.call(other.agent, 'todo_write', {})
  assert.deepEqual(executed, ['read', 'todo_write'])
})

test('controller identity and committed status survive a two-leaf handoff and a new user turn', async t => {
  let step = 1, workers = 0
  const call = (name, args) => ({ tools: [{ name, arguments: args }] })
  const runtimeState = payload => {
    const text = payload.messages.filter(row => row.role === 'user').map(row =>
      typeof row.content === 'string' ? row.content : row.content.map(block => block.text ?? '').join('\n'))
      .findLast(text => text.includes('"standaloneGraphPresence"'))
    const line = text.split('\n').findLast(line => line.startsWith('{') && line.includes('"standaloneGraphPresence"'))
    return { text, state: JSON.parse(line) }
  }
  const f = await fixture(t, { plan: { keys: ['task','verify'], rules: [{ id: 'after', when: { node: 'task', in: ['PASS'] } }], bindings: { verify: { inheritReports: ['task'] } } }, respond: ({ payload }) => {
    if (!payload.tools?.some(row => row.function.name === 'dynamic_context_graph_status')) {
      workers++
      assert.doesNotMatch(payload.messages[0].content, /你当前是完整模式主会话控制器/)
      const seed = JSON.parse(payload.messages[1].content.split('\n\n').at(-1))
      if (workers === 2) assert.match(JSON.stringify(seed.inheritedReports), /FIRST_LEAF_HANDOFF/)
      return { text: workers === 1 ? 'FIRST_LEAF_HANDOFF' : 'SECOND_LEAF_HANDOFF' }
    }
    const { state, text } = runtimeState(payload)
    step++
    assert.equal(state.role, 'controller')
    assert.match(text, /legalNext 是可调度候选，不是已启动的叶/)
    if (step === 2) {
      const proposal = rootTask()
      const desc = payload.tools.find(row => row.function.name === 'dynamic_context_submit').function.description
      assert.match(desc, /唯一的根单元/)
      return call('dynamic_context_submit', { proposal })
    }
    assert.equal(state.status.taskGraph.active, null)
    assert.doesNotMatch(text, /当前等待双图提交/)
    if ([3,4,6].includes(step)) {
      assert.equal(state.arguments.expectedRevision, state.status.revision)
      return call(state.nextTool, state.arguments)
    }
    assert.equal(state.status.reportStates.length, step === 5 ? 1 : 2)
    return { text: step === 5 ? 'First leaf report recorded; waiting for the next user turn in this fixture.' : 'Both leaf reports recorded; semantic acceptance remains independent.' }
  } })
  const { agent } = await f.agent('serial-role-handoff', null)
  const followup = text => agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
  await startGraph(f, agent, '迁移数据格式并完成兼容性检查；按两个有依赖的阶段推进。')
  await agent.whenIdle()
  assert.deepEqual(f.h.backend.errors, [])
  assert.equal(workers, 1)
  followup('继续处理下一阶段。')
  await agent.whenIdle()
  assert.deepEqual(f.h.backend.errors, [])
  assert.equal(workers, 2)
  assert.equal(step, 7)
  assert.equal(f.questions.length, 1)
  const runner = f.h.runner.interaction.entries.get(agent).runner
  assert.equal(runner.status().taskGraph.rootOutcome, 'PASS')
  assert.equal(runner.graph.read().reports.length, 2)
  assert.deepEqual(runner.status().taskGraph.legalNext, [])
  assert.equal(runner.status().semanticAcceptance, 'NOT_EVALUATED')
  assert.deepEqual(agent.session.snapshotEvents().filter(row => row.type === 'tool/call').map(row => row.data.name),
    ['dynamic_context_submit', 'dynamic_context_run_next', 'dynamic_context_run_next', 'dynamic_context_run_next'])
})

test('the advertised shared proposal actually binds the fact and hands its update to the next worker', async t => {
  const read = 'dynamic_context_shared_read', update = 'dynamic_context_shared_update'
  let requests = 0, sharedId
  const f = await fixture(t, { plan: { keys: ['inspect','finish'], rules: [{ id: 'after', when: { node: 'inspect', in: ['PASS'] } }], bindings: { inspect: { tools: [read,update] }, finish: { tools: [read], inheritReports: ['inspect'] } } }, config: { allowedTools: [read, update] }, respond: ({ payload }) => {
    const names = payload.tools?.map(row => row.function.name) ?? []
    assert.ok(!names.includes('dynamic_context_submit'))
    const seed = JSON.parse(payload.messages[1].content.split('\n\n').at(-1))
    const fact = seed.contexts.find(row => row.key === 'shared')
    assert.ok(fact)
    requests++
    if (requests === 1) {
      sharedId = fact.id
      assert.notEqual(sharedId, 'shared')
      assert.ok(names.includes(update))
      return { tools: [{ name: update, arguments: { id: sharedId, content: 'The inspected input is ready.', reason: 'The bound input records readiness.' } }] }
    }
    if (requests === 2) {
      const result = JSON.parse(payload.messages.findLast(row => row.role === 'tool').content.split('</host-receipt>\n').at(-1))
      assert.equal(result.status, 'APPLIED')
      assert.equal(result.revision, 2)
      return { text: 'Inspected input and published the shared fact.' }
    }
    assert.equal(fact.id, sharedId)
    assert.equal(fact.content, 'The inspected input is ready.')
    assert.equal(fact.revision, 2)
    assert.ok(names.includes(read)); assert.ok(!names.includes(update))
    assert.match(JSON.stringify(seed.inheritedReports), /Inspected input and published/)
    return { text: 'Delivered from the current shared fact and predecessor report.' }
  } })
  const { agent } = await f.agent('shared-template')
  await f.selectMode(agent, { reason: '分阶段处理并交接可变事实' })
  const schemas = f.h.ctx.tools.schemas(agent)
  assert.ok(!schemas.some(row => [read, update].includes(row.name)))
  const description = schemas.find(row => row.name === 'dynamic_context_submit').description
  const { proposal } = JSON.parse([...description.matchAll(/```json\n([^\n]+)\n```/g)][0][1])
  const submitted = await f.call(agent, 'dynamic_context_submit', { proposal })
  const plan = await f.call(agent, submitted.nextTool, submitted.arguments)
  const first = await f.call(agent, 'dynamic_context_run_next', { expectedRevision: plan.revision, choice: 0 })
  assert.equal(first.status.reportStates.length, 1)
  const second = await f.call(agent, 'dynamic_context_run_next', { expectedRevision: first.revision, choice: 0 })
  assert.equal(second.status.reportStates.length, 2)
  assert.deepEqual(second.status.taskGraph.legalNext, [])
  assert.deepEqual(f.h.backend.errors, [])
  assert.equal(requests, 3)
  assert.equal(f.h.runner.interaction.entries.get(agent).runner.graph.read().sharedContextHistory.length, 1)
})

test('the full-mode receipt and tool gate respect the native planning boundary', async t => {
  const f = await fixture(t, { setup(ctx) {
    ctx.sessionProjections.register({
      key: 'plan', stateVersion: 3, stateSchema: z.object({ active: z.boolean() }),
      init: () => ({ active: true }),
      apply: (state, event) => event.type === 'plan/mode' ? { active: event.data.active } : state,
    })
  } })
  const { agent } = await f.agent('plan-only')
  await f.selectMode(agent, { reason: '先规划项目' })
  const submitted = await f.call(agent, 'dynamic_context_submit', { proposal: rootTask() })
  assert.equal(submitted.revision, 1)
  assert.equal(submitted.nextTool, undefined)
  const blocked = await f.h.ctx.tools.execute({ agent, name: 'dynamic_context_run_next', arguments: { expectedRevision: 1 },
    callId: 'before-plan-approval', signal: new AbortController().signal })
  assert.match(blocked.error?.message, /DYNAMIC_CONTEXT_PLAN_MODE_ACTIVE/)
  assert.equal(f.h.backend.requests.length, 1)
  agent.session.append('plan/mode', { active: false })
  const ran = await f.h.ctx.tools.execute({ agent, name: 'dynamic_context_run_next', arguments: { expectedRevision: 1 },
    callId: 'after-plan-approval', signal: new AbortController().signal })
  assert.equal(ran.isError, false)
  assert.equal(ran.value.revision, 3)
})

test('settings are snapshotted on explicit activation and never rewrite an existing workflow', async t => {
  const f = await fixture(t, { config: { workflowLimits: { maxDepth: 35 }, direct: { api: 'deepseek' } } })
  let settings = { reasoningEffort: 'high', maxGroupDepth: 5 }
  f.h.runner.preferences = () => structuredClone(settings)
  const first = (await f.agent('settings-first')).agent
  await f.h.runner.interaction.set(first, 'full', { source: 'human-question' })
  const runner = f.h.runner.interaction.entries.get(first).runner
  assert.equal(runner.config.direct.reasoningEffort, 'high'); assert.equal(runner.config.workflowLimits.maxDepth, 35)
  settings = { reasoningEffort: 'low', maxGroupDepth: 2 }
  await f.h.runner.interaction.unmount(first)
  const restored = f.h.runner.interaction.mount(first, f.h.runner.interaction.record(first))
  assert.equal(restored.config.direct.reasoningEffort, 'high'); assert.equal(restored.config.workflowLimits.maxDepth, 35)
  const second = (await f.agent('settings-second')).agent
  await f.h.runner.interaction.set(second, 'full', { source: 'human-question' })
  assert.equal(f.h.runner.interaction.entries.get(second).runner.config.direct.reasoningEffort, 'low')
  const legacy = (await f.agent('settings-legacy')).agent
  const prior = { ...f.h.runner.interaction.record(first), sessionId: legacy.id }
  delete prior.preferences
  assert.equal(f.h.runner.interaction.mount(legacy, prior).config.direct.reasoningEffort, f.h.runner.config.direct.reasoningEffort)
})
