import test from 'node:test'
import { withBlockageReports } from '../testing/blockage-reports.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import UserQuestions from '@deepseek-ai/dsh-user-questions'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import Commands from '@deepseek-ai/dsh-commands'
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import TaskGraph from 'dsh-better-task-grapth'
import { createRuntimeHarness, runtimeProposal } from '../testing/runtime-harness.mjs'
import { rootTask, unitBackend, enterPlan, reviewRoot } from '../testing/unit-proposal.mjs'
import { MODE_OPTIONS } from '../interaction.mjs'
import { EXECUTION_OPTIONS, LIFECYCLE_RECORD } from '../orchestration.mjs'
import { PLANNING_TOOLS, plannerAnswerSnapshot, plannerSubmissionReceipt } from '../preplanning.mjs'
import { readSnapshot } from '../context-budget.mjs'
import { guidanceRecords } from '../guidance-state.mjs'
import { monitorHotPath } from '../testing/hot-path-probe.mjs'
import { watchValidation } from '../testing/validation-probe.mjs'
import BasicCompaction from '@deepseek-ai/dsh-compaction-basic'
import { startFakeLlama } from '../testing/fake-llama.mjs'

const names = payload => (payload.tools ?? []).map(row => row.function.name)

test('controller handoff carries only answered planning questions before commit, with a paged original when large', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'planner-clarifications-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const runner = { config: { directory } }
  const call = (seq, callId, name, questions) => ({ seq, type: 'tool/call', data: { callId, name, arguments: JSON.stringify({ questions }) } })
  const result = (seq, callId, value, isError = false) => ({ seq, type: 'tool/result', data: {
    message: { source: { callId }, isError, content: [{ type: 'text', text: JSON.stringify(value) }] } } })
  const questions = [{ id: 'units', question: 'Which units?' }, { id: 'colour', question: 'Which colour?' }]
  const answer = { answers: [{ id: 'units', selected: ['boxes'], custom: 'Use full boxes' }, { id: 'colour', selected: [] },
    { id: 'unknown', selected: ['unrelated'] }] }
  const events = [call(1, 'shell', 'bash', questions), result(2, 'shell', answer),
    call(3, 'waiting', 'ask_user_question', questions), result(4, 'waiting', { pending: true }),
    call(5, 'error', 'ask_user_question', questions), result(6, 'error', answer, true),
    call(7, 'asked', 'ask_user_question', questions), result(8, 'asked', answer),
    call(11, 'late', 'ask_user_question', questions), result(12, 'late', answer)]
  assert.equal(plannerSubmissionReceipt(runner, 'planner', events, 7).clarifications, undefined)
  assert.deepEqual(plannerAnswerSnapshot(runner, events.slice(0, 8)), plannerSubmissionReceipt(runner, 'planner', events, 10).clarifications)
  const receipt = plannerSubmissionReceipt(runner, 'planner', events, 10)
  assert.deepEqual(receipt.clarifications, { answers: [{ callId: 'asked', questionId: 'units', question: 'Which units?',
    selected: ['boxes'], custom: 'Use full boxes' }] })
  answer.answers[0].custom = '甲乙'.repeat(6000)
  events[7] = result(8, 'asked', answer)
  runner.config.dynamicContextMaxBytes = 1024
  const paged = plannerSubmissionReceipt(runner, 'planner', events, 10).clarifications
  assert.equal(paged.answers, undefined)
  const reader = paged.materialSummary.reader
  assert.equal(reader.tool, 'dynamic_context_status')
  const original = readSnapshot(runner, 'controller', { ...reader.arguments, length: 20000 })
  assert.equal(JSON.parse(original.text).answers[0].custom, answer.answers[0].custom)
})
const isPlanner = payload => payload.messages.some(row => row.role === 'system' && row.content.includes('DYNAMIC_CONTEXT_PREPLANNER_V1'))
const isController = payload => names(payload).includes('dynamic_context_graph_status')
const tool = (name, args) => ({ tools: [{ name, arguments: args }] })
const user = text => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
const nativeProfile = (backend, id) => ({ displayName: id, api: 'openai-completions', baseURL: backend.origin + '/v1',
  apiKeyEnv: 'DYNAMIC_CONTEXT_FAKE_LLAMA_KEY', defaultContextWindow: 8192, defaultMaxTokens: 512,
  models: [{ id, name: id, contextWindow: 8192, maxTokens: 512 }] })
const nativeSummary = (ctx, agent) => ctx.compaction.summarize({ messages: [user('Fixture evidence for a checkpoint.')] }, agent, new AbortController().signal)
const nativeCompactor = ctx => ctx.plugin(BasicCompaction, { auto: false, summarizationProvider: 'dynamic-context-fake', summarizationModel: 'fake-llama' })
// Lifecycle fixtures drive the role under test and supply independent replies for routine v2 reviews.
async function fixture(t, { respond, choice = 'full', after = 'auto_start', setup, providers, config = {}, outsideTemp = false, autoDecisions = true, plan } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(outsideTemp ? os.homedir() : os.tmpdir(), 'managed-workflow-')))
  const projectRoot = path.join(root, 'project'); fs.mkdirSync(projectRoot)
  const handles = [], questions = []
  const h = await createRuntimeHarness({ projectRoot, directory: path.join(root, 'state'), respond: respond && autoDecisions ? unitBackend(respond, { supervise: config.supervision, plan }) : respond, providers,
    config: { interaction: { mode: 'interactive' }, storageRoot: root, exposeControlTools: true, preplanningAcceptance: false, ...config },
    setup: async ctx => {
      await ctx.plugin(UserQuestions); await ctx.plugin(Commands)
      await ctx.plugin(Persistence, { root: path.join(root, 'sessions') })
      ctx.on('user-questions/request', request => {
        questions.push(request)
        const id = request.questions[0].id
        const selected = id === 'dynamic-context-execution' ? EXECUTION_OPTIONS.find(row => row.mode === after)?.label
          : id === 'dynamic-context-plan-approval' ? '确认并开始执行' : MODE_OPTIONS.find(row => row.mode === choice)?.label
        return { answers: [{ id, selected: selected ? [selected] : [] }] }
      })
      await setup?.(ctx)
    } })
  t.after(async () => { for (const handle of handles) await handle.dispose(); await h.close(); fs.rmSync(root, { recursive: true, force: true }) })
  async function agent(id, setup) {
    const handle = await h.ctx.agents.create({ sessionId: id, meta: { cwd: projectRoot }, setup,
      agentOptions: { provider: 'dynamic-context-fake', model: 'fake-llama' } })
    handles.push(handle); return handle.agent
  }
  const call = (agent, name, args) => h.ctx.tools.get(name, agent).execute(args,
    { agent, name, callId: 'host-' + name, signal: new AbortController().signal })
  return { h, root, projectRoot, questions, agent, call, handles,
    status: agent => h.runner.interaction.orchestrator.status(agent),
    runner: agent => h.runner.interaction.entries.get(agent)?.runner }
}

test('ordinary discussion keeps native tools and cannot activate graphs through legacy model tools', async t => {
  let step = 0, effects = 0
  const f = await fixture(t, { respond: ({ payload }) => {
    step++
    assert.ok(names(payload).includes('bash'))
    assert.ok(names(payload).includes('todo_write'))
    assert.ok(!names(payload).includes('dynamic_context_route_task'))
    assert.ok(!names(payload).includes('dynamic_context_select_mode'))
    assert.ok(!names(payload).includes('dynamic_context_workflow'))
    assert.match(JSON.stringify(payload.messages), /暂不规划/)
    if (step === 1) return tool('dynamic_context_select_mode', { reason: 'A large project.' })
    if (step === 2) return tool('dynamic_context_route_task', { route: 'project', reason: 'A large project.' })
    if (step === 3) {
      const refusals = payload.messages.filter(row => row.role === 'tool')
      assert.equal(refusals.length, 2)
      for (const message of refusals) {
        assert.match(message.content, /DYNAMIC_CONTEXT_COMMAND_REQUIRED/)
        assert.match(message.content, /开发中暂不可用/)
      }
      return tool('bash', { command: 'pwd', description: 'Inspect for discussion' })
    }
    return { text: 'Only discussion and the requested inspection.' }
  } })
  const agent = await f.agent('native-discussion', agentCtx => {
    agentCtx.tools.presentAs('native')
    for (const name of ['bash', 'todo_write']) agentCtx.tools.register(defineTool({ name, description: 'Mock native tool',
      parameters: { command: { type: 'string' } }, output: { schema: { type: 'string' }, render: (_a, value) => [{ type: 'text', text: value }] }, execute: () => { effects++; return 'OK' } }))
  })
  for (const [name, args] of [
    ['dynamic_context_route_task', { route: 'native', reason: 'local check' }],
    ['dynamic_context_route_task', { route: 'project', reason: 'project work' }],
    ['dynamic_context_select_mode', { reason: 'project work' }],
  ]) {
    assert.match(f.h.ctx.tools.get(name, agent).description, /开发中暂不可用/)
    await assert.rejects(async () => f.call(agent, name, args), { code: 'DYNAMIC_CONTEXT_COMMAND_REQUIRED', message: /开发中暂不可用/ })
  }
  agent.followup(user('这是一个大型项目；先讨论，暂不规划。')); await agent.whenIdle()
  assert.deepEqual(f.h.backend.errors, [])
  assert.equal(effects, 1); assert.equal(f.questions.length, 0)
  assert.equal(f.h.runner.interaction.record(agent), undefined)
  assert.equal(f.h.runner.interaction.route(agent), undefined)
  assert.equal(f.runner(agent), undefined)
})

test('delayed human activation carries earlier discussion into the planner as evidence without automatic activation', async t => {
  let planning = 0
  const f = await fixture(t, { after: 'await_approval', respond: ({ payload }) => {
    if (isPlanner(payload)) {
      assert.match(JSON.stringify(payload.messages), /VISIBLE_EARLIER_PROPOSAL/)
      assert.match(JSON.stringify(payload.messages), /pre-activation-discussion-v1/)
      assert.ok(names(payload).includes('dynamic_context_planning_history'))
      if (++planning === 1) return tool('dynamic_context_planning_history', { action: 'search', query: 'VISIBLE_EARLIER_PROPOSAL' })
      assert.match(payload.messages.findLast(row => row.role === 'tool').content, /assistant/)
      return tool('dynamic_context_submit', { proposal: rootTask() })
    }
    return { text: 'VISIBLE_EARLIER_PROPOSAL: a staged blueprint, pending user agreement.' }
  } })
  const agent = await f.agent('delayed-command')
  agent.followup(user('先讨论，不规划任务图。')); await agent.whenIdle()
  assert.equal(f.questions.length, 0); assert.equal(f.runner(agent), undefined)
  await f.h.ctx.commands.execute(agent, '/task-graph 按刚才讨论的方案正式规划。', [], new AbortController().signal)
  await agent.whenIdle()
  assert.deepEqual(f.h.backend.errors, [])
  assert.equal(planning, 2); assert.equal(f.status(agent).phase, 'WAITING_PLAN_APPROVAL')
})

test('one status call shares the verified graph and cannot publish a prepared witness', async t => {
  const f = await fixture(t, { after: 'await_approval', respond: ({ payload }) => isPlanner(payload)
    ? tool('dynamic_context_submit', { proposal: rootTask() }) : { text: 'Waiting for approval.' } })
  const agent = await f.agent('matched-graph-status')
  await f.h.ctx.commands.execute(agent, '/task-graph Prepare a scoped report.', [], new AbortController().signal)
  await agent.whenIdle()
  const service = f.h.ctx.transactionGraph, graph = f.runner(agent).graph
  const status = () => TaskGraph.prototype.status.call({
    ctx: { get: () => ({ resolveAgent: async () => ({ agent }) }) },
    host: service.host, workflows: service.workflows,
  }, { sessionId: agent.session.id })
  const stop = watchValidation(t, graph.store, 'inspect', { label: 'Web task graph status snapshot', maxCalls: 1 })
  const {value:current}=await monitorHotPath('poll linked graph and workflow activity',status,{diagnostic:t.diagnostic.bind(t)})
  assert.equal(stop(), 1)
  assert.equal(current.status, 'ready')
  assert.equal(current.graph.revision, 1)
  assert.equal(current.execution.phase, 'WAITING_PLAN_APPROVAL')

  const state = graph.read()
  graph.store.writeWitness(graph.store.witness.read(), 'PREPARED', state, state.checksum)
  const witness = graph.store.witness
  const readWitnessBytes = () => witness.db ? witness.db.read('graph/witness') : fs.readFileSync(witness.file)
  const evidence = readWitnessBytes()
  const unavailable = await status()
  assert.equal(unavailable.status, 'unavailable')
  assert.equal(unavailable.execution.state, 'blocked')
  assert.deepEqual(readWitnessBytes(), evidence)
})

test('independent preplanning opens real Bash, repairs a proposal in-place, ends at commit and program-dispatches two leaves', async t => {
  let planning = 0, workers = 0, rootRequests = 0
  const extension = 'scoped_media'
  const proposal = rootTask()
  const f = await fixture(t, { plan: { keys: ['task','second'], rules: [{ id: 'inherit', when: { node: 'task', in: ['PASS'] } }], bindings: { task: { tools: ['read_image', extension] }, second: { inheritReports: ['task'] } } }, setup: ctx => ctx.plugin(LocalAttachmentStore, { dshHome: ctx.workingDirectory.defaultDirectory }), respond: ({ payload }) => {
    if (isPlanner(payload)) {
      planning++
      assert.ok(names(payload).includes('bash'))
      assert.ok(names(payload).every(name => PLANNING_TOOLS.has(name)))
      assert.match(payload.messages.find(row => row.role === 'system').content, /"unitAllowedTools":\[[^\]]*"read_image"/)
      assert.match(payload.messages.find(row => row.role === 'system').content, /"unitAllowedTools":\[[^\]]*"scoped_media"/)
      assert.match(payload.tools.find(row => row.function.name === 'dynamic_context_submit').function.description,
        /Unit tool allowlist for this workflow: \[[^\]]*"scoped_media"/)
      assert.doesNotMatch(JSON.stringify(payload.messages), /UNRELATED_GLOBAL_CONTEXT_MUST_NOT_LEAK|PARENT_TOOL_NOISE/)
      assert.match(JSON.stringify(payload.messages), /USER_EXACT_TASK/)
      assert.match(payload.messages.find(row => row.role === 'system').content, /DYNAMIC_CONTEXT_PLANNING_EXPLORATION_V1/)
      assert.match(payload.messages.find(row => row.role === 'system').content, /根单元/)
      if (planning === 1) return tool('bash', { command: 'pwd', description: 'Inspect basic task location' })
      if (planning === 2) { assert.match(payload.messages.findLast(row => row.role === 'tool').content, /project/); return tool('dynamic_context_submit', { proposal: {} }) }
      assert.equal(planning, 3)
      assert.match(JSON.stringify(payload.messages), /taskGraph/)
      return { tools: [{ name: 'dynamic_context_submit', arguments: { proposal } },
        { name: 'bash', arguments: { command: 'touch should-not-exist', description: 'Must not execute after submission' } }] }
    }
    if (isController(payload)) {
      rootRequests++
      assert.ok(!names(payload).includes('dynamic_context_submit')); assert.ok(!names(payload).includes('bash'))
      return { text: 'Both leaves have recorded results.' }
    }
    assert.match(JSON.stringify(payload.messages), /DYNAMIC_CONTEXT_LEAF_AUTONOMY_V1/)
    assert.match(JSON.stringify(payload.messages), /固定目标、权限、依赖和跨叶接口仍是边界/)
    assert.equal(names(payload).includes(extension), workers === 0)
    workers++; return { text: 'Evidence-qualified worker report.' }
  } })
  f.h.ctx.get('dynamicContextRoleTools').registerTool({ pluginId: 'fixture', registrationId: 'workspace-media', toolId: extension,
    workspaceRoot: f.projectRoot, roles: ['executor'], effect: 'read',
    schema: { type: 'function', function: { name: extension, description: 'Read a synthetic media observation.', parameters: { type: 'object', properties: {} } } },
    authorize: () => true, execute: () => ({ ok: true }) })
  const agent = await f.agent('full-flow')
  const outcome = await f.h.ctx.commands.execute(agent, '/task-graph USER_EXACT_TASK', [], new AbortController().signal)
  assert.equal(outcome.result.kind, 'success')
  await agent.whenIdle()
  assert.deepEqual(f.h.backend.errors, [])
  assert.deepEqual({ planning, workers, rootRequests }, { planning: 3, workers: 2, rootRequests: 1 }, JSON.stringify(f.status(agent)))
  assert.equal(f.status(agent).phase, 'COMPLETE')
  assert.equal(f.runner(agent).graph.read().reports.length, 2)
  assert.deepEqual(f.questions.map(q => q.questions[0].id), ['dynamic-context-execution'])
  assert.equal(fs.existsSync(path.join(f.projectRoot, 'should-not-exist')), false)
  const human = agent.session.deriveMessages().filter(row => row.source?.kind === 'user')
  assert.deepEqual(human.map(row => row.content.map(b => b.text).join('')), ['USER_EXACT_TASK'])
  assert.equal(f.h.ctx.agents.list().filter(child => child !== agent).length, 0)
})

test('await-approval performs no leaf request until the current committed graph is approved', async t => {
  let workers = 0
  const f = await fixture(t, { after: 'await_approval', respond: ({ payload }) => isPlanner(payload)
    ? tool('dynamic_context_submit', { proposal: rootTask() })
    : isController(payload) ? { text: 'Current phase observed.' } : (workers++, { text: 'A worker report.' }) })
  const agent = await f.agent('approval-flow')
  await f.h.ctx.commands.execute(agent, '/task-graph Plan a staged task', [], new AbortController().signal)
  await agent.whenIdle()
  assert.deepEqual(f.h.backend.errors, [])
  assert.equal(f.status(agent).phase, 'WAITING_PLAN_APPROVAL', JSON.stringify(f.status(agent)))
  assert.equal(workers, 0)
  await f.call(agent, 'dynamic_context_workflow', { action: 'approve' })
  agent.followup(createUserMessage({ source: { kind: 'dynamic-context' }, content: [{ type: 'text', text: 'Approved state ready.' }] }))
  await agent.whenIdle()
  assert.equal(workers, 1, JSON.stringify(f.status(agent))); assert.equal(f.status(agent).phase, 'COMPLETE')
})

test('an unanswered execution preference never schedules planning or workers', async t => {
  const f = await fixture(t, { after: null, respond: ({ payload }) => {
    assert.ok(isController(payload)); return { text: 'Execution choice is still required.' }
  } })
  const agent = await f.agent('no-preference')
  await f.h.ctx.commands.execute(agent, '/task-graph A project task', [], new AbortController().signal)
  await agent.whenIdle()
  assert.equal(f.h.backend.requests.length, 1)
  assert.equal(f.status(agent).scheduled, false)
  assert.equal(f.runner(agent).graph.read(), null)
})

test('the human command selects the standalone graph workflow before the model turn', async t => {
  let step = 0
  const f = await fixture(t, { choice: 'task-graph', config: { interaction: { mode: 'interactive', commandMode: 'ask' } }, respond: ({ payload }) => {
    assert.ok(names(payload).includes('transaction_graph_create'))
    assert.ok(!names(payload).includes('dynamic_context_submit'))
    return { text: 'The selected standalone workflow is available.' }
  } })
  const agent = await f.agent('standalone-routing')
  await f.h.ctx.commands.execute(agent, '/task-graph Prepare, build and independently verify this deliverable.', [], new AbortController().signal); await agent.whenIdle()
  assert.deepEqual(f.h.backend.errors, [])
  assert.equal(f.questions.length, 1); assert.equal(f.runner(agent), undefined)
  assert.equal(f.h.runner.interaction.mode(agent), 'task-graph')
})

test('native Plan mode allows foundational Bash in its read-only policy and prevents execution until a real mode exit', async t => {
  let planning = 0, workers = 0
  const f = await fixture(t, { outsideTemp: true, setup(ctx) {
    ctx.sessionProjections.register({ key: 'plan', stateVersion: 3, stateSchema: z.object({ active: z.boolean() }),
      init: () => ({ active: true }), apply: (state, event) => event.type === 'plan/mode' ? { active: event.data.active } : state })
  }, respond: ({ payload }) => {
    if (isPlanner(payload)) {
      if (++planning === 1) return tool('bash', { command: 'touch forbidden-in-plan', description: 'Exercise native write confinement' })
      if (planning === 2) {
        assert.match(payload.messages.findLast(row => row.role === 'tool').content, /[Rr]ead-only|[Pp]ermission|denied/)
        return tool('dynamic_context_submit', { proposal: rootTask() })
      }
    }
    if (isController(payload)) return { text: 'Observed native plan boundary.' }
    workers++; return { text: 'A recorded worker result.' }
  } })
  const agent = await f.agent('native-plan')
  await f.h.ctx.commands.execute(agent, '/task-graph Task with native Plan active', [], new AbortController().signal)
  await agent.whenIdle()
  assert.deepEqual(f.h.backend.errors, [])
  assert.equal(f.status(agent).phase, 'WAITING_NATIVE_PLAN', JSON.stringify(f.status(agent)))
  assert.equal(workers, 0); assert.equal(fs.existsSync(path.join(f.projectRoot, 'forbidden-in-plan')), false)
  agent.session.append('plan/mode', { active: false })
  agent.followup(createUserMessage({ source: { kind: 'dynamic-context' }, content: [{ type: 'text', text: 'Native mode changed.' }] }))
  await agent.whenIdle()
  assert.equal(workers, 1, JSON.stringify(f.status(agent)))
  assert.equal(f.status(agent).phase, 'COMPLETE')
})

test('an incomplete planning conversation resumes its existing observations without starting a leaf early', async t => {
  let planning = 0, workers = 0
  const f = await fixture(t, { respond: ({ payload }) => {
    if (isPlanner(payload)) {
      planning++
      if (planning === 1) return tool('bash', { command: 'pwd', description: 'Observe workspace once' })
      if (planning === 2) return { text: 'I have not submitted a graph yet. PLANNING_OBSERVATION_RETAINED' }
      assert.match(JSON.stringify(payload.messages), /PLANNING_OBSERVATION_RETAINED/)
      return tool('dynamic_context_submit', { proposal: rootTask() })
    }
    if (isController(payload)) return { text: 'Planning phase observed.' }
    workers++; return { text: 'Recorded worker result.' }
  } })
  const agent = await f.agent('resume-planner')
  await f.h.ctx.commands.execute(agent, '/task-graph An unfinished plan', [], new AbortController().signal)
  await agent.whenIdle()
  const sessionId = f.status(agent).plannerSessionId
  assert.equal(f.status(agent).phase, 'PLANNING_INCOMPLETE'); assert.equal(workers, 0)
  await f.call(agent, 'dynamic_context_workflow', { action: 'continue' })
  agent.followup(createUserMessage({ source: { kind: 'dynamic-context' }, content: [{ type: 'text', text: 'Continue queued planner.' }] }))
  await agent.whenIdle()
  assert.deepEqual(f.h.backend.errors, [])
  assert.equal(f.status(agent).plannerSessionId, sessionId)
  assert.equal(f.status(agent).phase, 'COMPLETE', JSON.stringify(f.status(agent)))
  assert.equal(workers, 1); assert.equal(planning, 3)
})

test('parent cancellation stops the planner and never dispatches a leaf', async t => {
  let ready, finish, workers = 0
  const entered = new Promise(resolve => { ready = resolve })
  const release = new Promise(resolve => { finish = resolve })
  const f = await fixture(t, { respond: async ({ payload }) => {
    if (isPlanner(payload)) { ready(); await release; return tool('dynamic_context_submit', { proposal: rootTask() }) }
    if (isController(payload)) return { text: 'Cancelled state observed.' }
    workers++; return { text: 'Must not run.' }
  } })
  const agent = await f.agent('cancel-planner')
  await f.h.ctx.commands.execute(agent, '/task-graph Cancellable plan', [], new AbortController().signal)
  await entered
  agent.cancel({ kind: 'user' }); finish(); await agent.whenIdle()
  assert.equal(f.status(agent).phase, 'PAUSED'); assert.equal(workers, 0)
  assert.equal(f.h.ctx.agents.list().length, 1)
  assert.equal(f.runner(agent).graph.read(), null)
})

test('a steering pause is classified and routed before planning can submit or start work', async t => {
  let ready, finish, workers = 0
  const entered = new Promise(resolve => { ready = resolve })
  const release = new Promise(resolve => { finish = resolve })
  const f = await fixture(t, { respond: async ({ payload }) => {
    if (payload.messages[0].content.includes('DYNAMIC_CONTEXT_GUIDANCE_INTAKE_V1')) return { text: JSON.stringify({ level: 'control', intent: 'Pause to clarify the new condition', targets: [], conditions: [], changes: ['pause'], needsClarification: false }) }
    if (payload.messages[0].content.includes('DYNAMIC_CONTEXT_GUIDANCE_ROUTER_V1')) return { text: JSON.stringify({ action: 'pause', summary: 'Paused as the user requested', jobs: [] }) }
    if (isPlanner(payload)) { ready(); await release; return tool('dynamic_context_submit', { proposal: rootTask() }) }
    if (isController(payload)) return { text: 'The user update needs consideration.' }
    workers++; return { text: 'Must not run.' }
  } })
  const agent = await f.agent('steer-planner')
  await f.h.ctx.commands.execute(agent, '/task-graph Cancellable plan', [], new AbortController().signal)
  await entered
  agent.steer(user('暂停，先确认新的约束。')); finish(); await agent.whenIdle()
  assert.equal(f.status(agent).phase, 'PAUSED'); assert.equal(f.status(agent).reason, 'USER_GUIDANCE_WAIT')
  assert.equal(workers, 0); assert.equal(f.status(agent).scheduled, false)
  assert.ok(guidanceRecords(agent.session).some(row => JSON.stringify(row.message.content).includes('新的约束')))
  assert.equal(f.runner(agent).graph.read(), null)
})

test('persisted queued planning does not replay on remount; an explicit continuation is required', async t => {
  let planners = 0
  const f = await fixture(t, { respond: ({ payload }) => {
    if (isPlanner(payload)) { planners++; return tool('dynamic_context_submit', { proposal: rootTask() }) }
    return { text: 'Observed only.' }
  } })
  const agent = await f.agent('reloaded-queue')
  agent.session.append('user/message', user('Prepare and execute this task.'), { surfaceOp: 'append' })
  await f.h.runner.interaction.select(agent, { reason: 'A staged task.' }, new AbortController().signal)
  assert.equal(f.status(agent).scheduled, true)
  await f.h.ctx.sessions.flush(agent.session)
  await f.handles[0].dispose()
  const handle = await f.h.ctx.agents.resume({ resumeSessionId: 'reloaded-queue',
    agentOptions: { provider: 'dynamic-context-fake', model: 'fake-llama' } })
  f.handles.push(handle)
  assert.equal(f.status(handle.agent).scheduled, false)
  assert.equal(f.status(handle.agent).restartRequiresContinue, true)
  handle.agent.followup(user('说明当前状态。')); await handle.agent.whenIdle()
  assert.equal(planners, 0)
  await f.call(handle.agent, 'dynamic_context_workflow', { action: 'continue' })
  handle.agent.followup(createUserMessage({ source: { kind: 'dynamic-context' }, content: [{ type: 'text', text: 'Resume explicitly queued.' }] }))
  await handle.agent.whenIdle()
  assert.equal(planners, 1, JSON.stringify(f.status(handle.agent)))
})

test('loss of the controller handoff receipt can be recovered from the durable planner result without a model replay', async t => {
  let planners = 0, workers = 0
  const f = await fixture(t, { after: 'await_approval', respond: ({ payload }) => {
    if (isPlanner(payload)) { planners++; return tool('dynamic_context_submit', { proposal: rootTask() }) }
    if (isController(payload)) return { text: 'Observed phase.' }
    workers++; return { text: 'Verified recorded result.' }
  } })
  const agent = await f.agent('lost-handoff')
  await f.h.ctx.commands.execute(agent, '/task-graph A controlled task', [], new AbortController().signal)
  await agent.whenIdle()
  const row = f.h.runner.interaction.orchestrator.record(agent)
  appendPluginRecord(agent.session, LIFECYCLE_RECORD, { ...row, plannerReceipt: null, phase: 'PLAN_COMMITTED' })
  await f.call(agent, 'dynamic_context_workflow', { action: 'continue' })
  agent.followup(createUserMessage({ source: { kind: 'dynamic-context' }, content: [{ type: 'text', text: 'Reconcile the handoff.' }] }))
  await agent.whenIdle()
  assert.equal(planners, 1); assert.equal(workers, 0)
  assert.equal(f.status(agent).phase, 'WAITING_PLAN_APPROVAL', JSON.stringify(f.status(agent)))
  assert.equal(f.status(agent).plannerReceipt.recovered, true)
})

test('two root conversations keep their task contracts and independent planners separate', async t => {
  const tasks = []
  const f = await fixture(t, { after: 'await_approval', respond: ({ payload }) => {
    if (isPlanner(payload)) {
      const content = JSON.stringify(payload.messages)
      assert.notEqual(content.includes('ONLY_ALPHA_TASK'), content.includes('ONLY_BETA_TASK'))
      tasks.push(content.includes('ONLY_ALPHA_TASK') ? 'alpha' : 'beta')
      return tool('dynamic_context_submit', { proposal: rootTask() })
    }
    return { text: 'Only observe the selected conversation.' }
  } })
  const a = await f.agent('alpha'), b = await f.agent('beta')
  await Promise.all([['ONLY_ALPHA_TASK', a], ['ONLY_BETA_TASK', b]].map(async ([task, agent]) => {
    await f.h.ctx.commands.execute(agent, '/task-graph ' + task, [], new AbortController().signal)
    await agent.whenIdle()
  }))
  assert.deepEqual(f.h.backend.errors, [])
  assert.deepEqual(tasks.sort(), ['alpha', 'beta'])
  assert.notEqual(f.status(a).workflowId, f.status(b).workflowId)
  assert.equal(f.status(a).phase, 'WAITING_PLAN_APPROVAL'); assert.equal(f.status(b).phase, 'WAITING_PLAN_APPROVAL')
})

for (const interruptReview of [false, true]) test(`program scheduling retains the report/acceptance/plan-review pipeline (interruptReview=${interruptReview})`, async t => {
  const order = [], proposal = rootTask()
  const f = await fixture(t, { plan: { keys: ['task','second'] }, config: { supervision: true, supervisionContext: 'reports', direct: { durable: true },
    revision: { policy: { objective: 'Fixture template replaced by the real user task.', requirements: [{ id: 'fixture', text: 'Follow current task.' }] } } },
  respond: ({ payload }) => {
    if (isPlanner(payload)) { order.push('planning'); return tool('dynamic_context_submit', { proposal }) }
    if (isController(payload)) { order.push('controller'); return { text: 'Report and supervision states observed.' } }
    if (payload.response_format) {
      if (payload.messages[0].content.includes('受理当前叶')) {
        order.push('acceptance')
        return interruptReview ? { status: 503, body: 'Synthetic acceptance outage' }
          : { text: '{"verdict":"ACCEPT","reason":"The local result satisfies the requested disposition."}' }
      }
      order.push('plan-review'); return { text: '{"verdict":"CURRENT"}' }
    }
    order.push('worker')
    return { text: JSON.stringify({ outcome: 'PASS', summary: 'Prepared a scoped report.', artifacts: [], executionReport: {
      workHistory: ['Considered the active local criterion.'], results: [{ criterion: 'Prepare a scoped report', result: 'The local result is recorded.', artifactRefs: [], testIds: [] }],
      directories: [], tests: [], limitations: ['This is a synthetic protocol exercise.'],
    } }) }
  } })
  const agent = await f.agent('supervised-' + interruptReview)
  await f.h.ctx.commands.execute(agent, '/task-graph Prepare two serial reports.', [], new AbortController().signal)
  await agent.whenIdle()
  assert.deepEqual(f.h.backend.errors, [])
  assert.deepEqual(order, interruptReview ? ['planning', 'worker', 'acceptance', 'controller']
    : ['planning', 'worker', 'acceptance', 'plan-review', 'worker', 'acceptance', 'controller'], JSON.stringify(f.status(agent)))
  assert.equal(f.status(agent).phase, interruptReview ? 'NEEDS_ATTENTION' : 'COMPLETE')
  if (interruptReview) {
    assert.equal(f.runner(agent).status().supervision.phase, 'CHECK_RESULT')
    assert.ok(f.runner(agent).status().taskGraph.active)
  } else assert.equal(f.runner(agent).graph.read().supervision.outcomes.length, 2)
})

test('a committed graph without a successful planner tool receipt never starts execution', async t => {
  let planning = 0, workers = 0
  const f = await fixture(t, { respond: ({ payload }) => {
    if (isPlanner(payload)) return ++planning === 1 ? tool('dynamic_context_submit', { proposal: rootTask() }) : { text: 'Submission failed at the receipt boundary.' }
    if (isController(payload)) return { text: 'Requires handoff investigation.' }
    workers++; return { text: 'Must not execute.' }
  } })
  const agent = await f.agent('submit-fault')
  agent.session.append('user/message', user('A task with a controlled fault.'), { surfaceOp: 'append' })
  await f.h.runner.interaction.select(agent, { reason: 'Staged task.' }, new AbortController().signal)
  const runner = f.runner(agent), submit = runner.submit.bind(runner)
  runner.submit = (...args) => { submit(...args); throw new Error('INJECTED_POST_COMMIT_FAILURE') }
  agent.followup(createUserMessage({ source: { kind: 'dynamic-context' }, content: [{ type: 'text', text: 'Drive queued plan.' }] }))
  await agent.whenIdle()
  assert.equal(runner.graph.read().revision, 1); assert.equal(workers, 0)
  await f.call(agent, 'dynamic_context_workflow', { action: 'continue' })
  agent.followup(createUserMessage({ source: { kind: 'dynamic-context' }, content: [{ type: 'text', text: 'Inspect handoff.' }] }))
  await agent.whenIdle()
  assert.equal(f.status(agent).phase, 'NEEDS_ATTENTION')
  assert.equal(f.status(agent).reason, 'PLANNER_HANDOFF_NOT_CONFIRMED')
  assert.equal(workers, 0); assert.equal(planning, 2)
})

test('planning inherits the currently admitted model route after the parent switches models', async t => {
  let rootSteps = 0, planning = 0
  const f = await fixture(t, { after: 'await_approval', respond: ({ payload }) => {
    assert.equal(payload.model, 'fake-llama')
    if (isPlanner(payload)) { planning++; return tool('dynamic_context_submit', { proposal: rootTask() }) }
    return { text: 'The committed graph is waiting as selected.' }
  } })
  const handle = await f.h.ctx.agents.create({ sessionId: 'changed-model', meta: { cwd: f.projectRoot },
    agentOptions: { provider: 'old-unavailable-provider', model: 'old-unavailable-model' },
    setup: agentCtx => { agentCtx.on('agent/request', async (_request, next) => ({ ...await next(),
      provider: 'dynamic-context-fake', model: 'fake-llama' })) },
  })
  f.handles.push(handle)
  await f.h.ctx.commands.execute(handle.agent, '/task-graph Plan a project using the currently selected model.', [], new AbortController().signal); await handle.agent.whenIdle()
  assert.deepEqual(f.h.backend.errors, [])
  assert.equal(planning, 1, JSON.stringify(f.status(handle.agent)))
  assert.equal(f.status(handle.agent).phase, 'WAITING_PLAN_APPROVAL')
})

const validDisposition = () => ({ outcome: 'PASS', summary: 'Delivered the local report.', artifacts: [], executionReport: {
  workHistory: ['Performed this local step.'], results: [{ criterion: 'Local report', result: 'Scoped result prepared.', artifactRefs: [], testIds: [] }],
  directories: [], tests: [], limitations: [],
} })
const supervisedConfig = { supervision: true, supervisionContext: 'reports', direct: { durable: true },
  revision: { policy: { objective: 'Fixture', requirements: [{ id: 'scope', text: 'Follow the task.' }] } } }
function supervisedProposal() {
  const proposal = rootTask()
  proposal.planningReport = { understanding: 'One local report.', assumptions: [], design: 'One leaf with result review.', acceptanceStrategy: 'Inspect the result.' }
  proposal.contextGraph.bindings[0].completion = { kind: 'report' }
  return proposal
}

for (const auditedPause of [false, true]) test(`no-ready exception runs only after acceptance and plan review, then serially reopens work (auditedPause=${auditedPause})`, async t => {
  const order = []; let workers = 0, handlers = 0
  const f = await fixture(t, { plan: { keys: ['check','finish'], rules: [{ id: 'pass', when: { node: 'check', in: ['PASS'] } }], bindings: { check: { tools: ['read'] } } }, config: supervisedConfig, respond: ({ payload }) => {
    if (isPlanner(payload)) return tool('dynamic_context_submit', { proposal: supervisedProposal() })
    if (isController(payload)) { order.push('controller'); return { text: 'State observed.' } }
    const instruction = payload.messages[0].content
    if (instruction.includes('DYNAMIC_CONTEXT_BLOCKAGE_PAUSE_AUDIT_V1')) {
      order.push('pause-audit'); return { text: JSON.stringify({ verdict: 'APPROVE', reason: 'The requested wait is supported.', issues: [] }) }
    }
    if (instruction.includes('DYNAMIC_CONTEXT_SCOPED_BLOCKAGE')) {
      const input = JSON.parse(payload.messages[1].content), report = input.reports.find(row => row.value?.attemptId)
      order.push('blockage'); handlers++
      const evidence = [{ source: report.source, sha256: report.sha256, path: '/result/summary', quote: report.value.result.summary }]
      return { text: JSON.stringify(auditedPause && handlers === 1 ? { action: 'PAUSE', report: { version: 1,
        summary: 'Required input unavailable.', constraints: [{ description: 'The input must be provided.', affectedTasks: input.situation.causes, evidence }],
        alternatives: { rework: 'Same input unavailable.', replan: 'Fixed goal requires the input.' }, resumeCondition: 'Input provided.', requestedUserAction: 'Provide the input.' } }
        : { action: 'REWORK', report: { version: 1, findings: [{ taskId: report.value.taskId, attemptId: report.value.attemptId,
          reasonCode: 'MISSING_REQUIRED_RESULT', criterion: 'Check all required inputs.', problem: 'One required inspection was omitted.',
          correction: 'Perform the omitted inspection and submit a fresh result.', evidence }] } }) }
    }
    if (payload.response_format) {
      if (instruction.includes('受理当前叶')) { order.push('accept'); return { text: '{"verdict":"ACCEPT","reason":"The disposition matches the report."}' } }
      order.push('plan'); return { text: '{"verdict":"CURRENT"}' }
    }
    if (workers === 0 && !payload.messages.some(row => row.tool_call_id === 'observed-missing')) return { tools: [{ name: 'read', id: 'observed-missing', arguments: { file_path: 'missing-fixture.txt' } }] }
    order.push('worker'); workers++
    const result = validDisposition()
    if (workers === 1) { result.outcome = 'FAILED'; result.failedCallId = 'observed-missing'; result.summary = 'A required input was not inspected.' }
    else if (workers === 2) assert.match(JSON.stringify(payload.messages), /reworkRequest/)
    return { text: JSON.stringify(result) }
  } })
  const agent = await f.agent('blockage-lifecycle-' + auditedPause)
  await f.h.ctx.commands.execute(agent, '/task-graph Inspect required inputs and report.', [], new AbortController().signal)
  await agent.whenIdle()
  if (auditedPause) {
    assert.deepEqual(order, ['worker', 'accept', 'plan', 'blockage', 'pause-audit'], JSON.stringify(f.status(agent)))
    assert.equal(f.status(agent).phase, 'PAUSED'); assert.equal(f.status(agent).reason, 'SCOPE_REVIEWED_WAIT')
    assert.equal(f.h.runner.interaction.orchestrator.executionView(agent).canResume, true)
    await f.h.runner.interaction.orchestrator.fromView(agent, 'resume', new AbortController().signal)
    await agent.whenIdle()
  }
  assert.deepEqual(f.h.backend.errors, [])
  assert.equal(f.status(agent).phase, 'COMPLETE', JSON.stringify(f.status(agent)))
  assert.equal(workers, 3); assert.equal(f.runner(agent).graph.read().supervision.outcomes.length, 3)
  assert.equal(f.runner(agent).graph.read().graph.events.filter(e => e.type === 'REOPENED').length, 1)
  assert.ok(order.indexOf('blockage') > order.indexOf('accept')); assert.equal(order.filter(role => role === 'accept').length, 3)
})

test('report return automatically enters repair, acceptance and plan review without a controller request', async t => {
  const order = []
  const f = await fixture(t, { config: supervisedConfig, respond: ({ payload }) => {
    if (isPlanner(payload)) return tool('dynamic_context_submit', { proposal: supervisedProposal() })
    if (isController(payload)) { order.push('controller'); return { text: 'Finished.' } }
    if (!payload.response_format) { order.push('worker'); return { text: 'Malformed report; retain my work.' } }
    if (payload.messages[0].content.includes('补正')) { order.push('repair'); return { text: JSON.stringify(validDisposition()) } }
    if (payload.messages[0].content.includes('受理当前叶')) { order.push('accept'); return { text: '{"verdict":"ACCEPT","reason":"Scoped report accepted."}' } }
    order.push('plan'); return { text: '{"verdict":"CURRENT"}' }
  } })
  const agent = await f.agent('automatic-report-repair')
  await f.h.ctx.commands.execute(agent, '/task-graph Produce and validate a report.', [], new AbortController().signal)
  await agent.whenIdle()
  assert.deepEqual(f.h.backend.errors, [])
  assert.deepEqual(order, ['worker', 'repair', 'accept', 'controller'], JSON.stringify(f.status(agent)))
  assert.equal(f.status(agent).phase, 'COMPLETE')
})

test('unchanged rejected reports stop automatic repair instead of creating an endless role loop', async t => {
  let workers = 0, repairs = 0
  const f = await fixture(t, { config: supervisedConfig, respond: ({ payload }) => {
    if (isPlanner(payload)) return tool('dynamic_context_submit', { proposal: supervisedProposal() })
    if (isController(payload)) return { text: 'The unchanged report requires attention.' }
    if (!payload.response_format) { workers++; return { text: JSON.stringify(validDisposition()) } }
    if (payload.messages[0].content.includes('补正')) { repairs++; return { text: JSON.stringify(validDisposition()) } }
    return { text: '{"verdict":"RETURN","reason":"The local evidence is still insufficient.","issues":[{"path":"/submission/summary","item":"leaf acceptance","reason":"The local evidence is still insufficient."}]}' }
  } })
  const agent = await f.agent('unchanged-report')
  await f.h.ctx.commands.execute(agent, '/task-graph Produce and validate a report.', [], new AbortController().signal)
  await agent.whenIdle()
  assert.equal(f.status(agent).reason, 'SUPERVISION_NO_PROGRESS')
  assert.equal(workers, 1); assert.equal(repairs, 1)
  assert.equal(f.runner(agent).status().supervision.phase, 'REPAIR_RESULT')
})

test('cosmetic report edits cannot hide an unchanged rejection and create an endless role loop', async t => {
  let workers = 0, repairs = 0
  const f = await fixture(t, { config: supervisedConfig, respond: ({ payload }) => {
    if (isPlanner(payload)) return tool('dynamic_context_submit', { proposal: supervisedProposal() })
    if (isController(payload)) return { text: 'The unchanged report requires attention.' }
    if (!payload.response_format) { workers++; return { text: JSON.stringify(validDisposition()) } }
    if (payload.messages[0].content.includes('补正')) { repairs++; return { text: JSON.stringify({ ...validDisposition(), summary: 'Cosmetic rewrite ' + repairs }) } }
    return { text: '{"verdict":"RETURN","reason":"The local evidence is still insufficient.","issues":[{"path":"/submission/summary","item":"leaf acceptance","reason":"The local evidence is still insufficient."}]}' }
  } })
  const agent = await f.agent('unchanged-report')
  await f.h.ctx.commands.execute(agent, '/task-graph Produce and validate a report.', [], new AbortController().signal)
  await agent.whenIdle()
  assert.equal(f.status(agent).reason, 'SUPERVISION_NO_PROGRESS')
  assert.equal(workers, 1); assert.equal(repairs, 1)
  assert.equal(f.runner(agent).status().supervision.phase, 'REPAIR_RESULT')
})


test('UI classifies a crash during pause admission as unexpected, and lost graphs block continuation', async t => {
  const f = await fixture(t, { respond: () => ({ text: 'No model work expected.' }) })
  const agent = await f.agent('interrupted-pause')
  agent.session.append('user/message', user('Prepare the staged task.'), { surfaceOp: 'append' })
  await f.h.runner.interaction.select(agent, { reason: 'A project task.' }, new AbortController().signal)
  // Persist the exact lifecycle shape written while a request is still running.
  appendPluginRecord(agent.session, LIFECYCLE_RECORD, { ...f.status(agent), phase: 'PAUSE_REQUESTED', pauseKind: 'normal' })
  await f.h.ctx.sessions.flush(agent.session); await f.handles[0].dispose()
  const handle = await f.h.ctx.agents.resume({ resumeSessionId: 'interrupted-pause', agentOptions: { provider: 'dynamic-context-fake', model: 'fake-llama' } })
  f.handles.push(handle)
  const registry = f.h.ctx.transactionGraph.workflows
  assert.equal(registry.executionView(handle.agent).state, 'interrupted')
  assert.equal(registry.executionView(handle.agent).pauseKind, 'unexpected')
  const runner = f.runner(handle.agent), original = runner.graphPresence
  runner.graphPresence = () => ({ recoveryRequired: true })
  try {
    const view = registry.executionView(handle.agent)
    assert.equal(view.state, 'blocked'); assert.equal(view.canResume, false)
    await assert.rejects(registry.controlExecution(handle.agent, { workflowId: view.workflowId, action: 'resume' }), /CONTROL_NOT_AVAILABLE/)
  } finally { runner.graphPresence = original }
})

test('the graph control shows planning before a graph exists and pauses before the next API request', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers(); let planning = 0, workers = 0
  const f = await fixture(t, { config: { direct: { durable: true } }, respond: async ({ payload }) => {
    if (isPlanner(payload)) {
      if (++planning === 1) { entered.resolve(); await release.promise; return tool('read', { file_path: 'probe.txt' }) }
      assert.match(JSON.stringify(payload.messages), /probe receipt/)
      assert.doesNotMatch(JSON.stringify(payload.messages), /用户点击继续|从正常暂停|执行意外中断/)
      return tool('dynamic_context_submit', { proposal: rootTask() })
    }
    if (isController(payload)) return { text: 'Finished.' }
    workers++; return { text: 'Scoped report.' }
  } })
  fs.writeFileSync(path.join(f.projectRoot, 'probe.txt'), 'probe receipt')
  const agent = await f.agent('pause-planning')
  await f.h.ctx.commands.execute(agent, '/task-graph A staged project.', [], new AbortController().signal)
  await entered.promise
  const api = f.h.ctx.transactionGraph
  const view = api.workflows.executionView(agent)
  assert.equal(view.activity.stage, 'PREPLANNING'); assert.equal(view.activity.kind, 'model')
  assert.equal(api.workflows.graphView(agent), null)
  await api.workflows.controlExecution(agent, { workflowId: view.workflowId, action: 'pause' })
  assert.equal(api.workflows.executionView(agent).state, 'pausing')
  release.resolve(); await agent.whenIdle()
  assert.equal(planning, 1); assert.equal(workers, 0); assert.equal(f.h.backend.requests.length, 1)
  assert.equal(f.status(agent).pauseKind, 'normal')
  assert.equal(api.workflows.executionView(agent).state, 'paused')
  await api.workflows.controlExecution(agent, { workflowId: view.workflowId, action: 'resume' })
  await agent.whenIdle()
  assert.equal(f.status(agent).phase, 'COMPLETE', JSON.stringify(f.status(agent)))
  assert.equal(planning, 2); assert.equal(workers, 1)
  assert.equal(f.h.backend.requests.filter(({ payload }) => isController(payload)).length, 0)
  assert.deepEqual(f.h.backend.errors, [])
})

test('UI pause completes the current tool batch once and resumes the same leaf; unrelated sessions cannot control it', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers(); let workers = 0, writes = 0
  const f = await fixture(t, { config: { direct: { durable: true } }, setup: ctx => {
    ctx.on('tools/execute', (exec, next) => { if (exec.name === 'write') writes++; return next() })
  }, respond: async ({ payload }) => {
    if (isPlanner(payload)) return tool('dynamic_context_submit', { proposal: rootTask(['write']) })
    if (isController(payload)) return { text: 'Finished.' }
    if (++workers === 1) { entered.resolve(); await release.promise; return { tools: ['a', 'b'].map(name => ({ name: 'write', arguments: { file_path: name + '.txt', content: name } })) } }
    return { text: 'Both files delivered.' }
  } })
  const agent = await f.agent('pause-leaf'), outsider = await f.agent('unrelated')
  await f.h.ctx.commands.execute(agent, '/task-graph Produce two files.', [], new AbortController().signal)
  await entered.promise
  const registry = f.h.ctx.transactionGraph.workflows, view = registry.executionView(agent)
  await assert.rejects(registry.controlExecution(outsider, { workflowId: view.workflowId, action: 'pause' }), /UNAVAILABLE/)
  await registry.controlExecution(agent, { workflowId: view.workflowId, action: 'pause' })
  release.resolve(); await agent.whenIdle()
  const attempt = f.runner(agent).graph.read().graph.state.active.attemptId
  assert.equal(workers, 1); assert.equal(writes, 2); assert.equal(f.runner(agent).checkpointStatus().phase, 'PAUSED')
  // Reproduce a legacy checkpoint whose last displayed activity was planning.
  const runner = f.runner(agent), resume = runner.resumeActive
  runner.activity = { stage: 'scope_plan', kind: 'result' }
  const requestsBefore = f.h.backend.requests.length
  runner.resumeActive = async () => { throw new Error('FIXTURE_RESUME_INTERRUPTED') }
  try {
    await registry.controlExecution(agent, { workflowId: view.workflowId, action: 'resume' }); await agent.whenIdle()
    assert.equal(f.status(agent).reason, 'FIXTURE_RESUME_INTERRUPTED')
    assert.equal(registry.executionView(agent).activity.stage, 'EXECUTING')
    assert.equal(f.h.backend.requests.length, requestsBefore, 'an interrupted leaf must not start a native conversation request')
  } finally { runner.resumeActive = resume }
  const response = new AbortController()
  await registry.controlExecution(agent, { workflowId: view.workflowId, action: 'resume' }, response.signal)
  response.abort()
  await agent.whenIdle()
  assert.equal(f.status(agent).phase, 'COMPLETE', JSON.stringify(f.status(agent)))
  assert.equal(workers, 2); assert.equal(writes, 2)
  assert.equal(f.runner(agent).graph.read().reports[0].attemptId, attempt)
  assert.equal(f.h.backend.requests.length, requestsBefore + 3)
  assert.doesNotMatch(JSON.stringify(agent.session.deriveMessages()), /用户点击继续|程序按已保存状态接续工作流/)
  assert.deepEqual(f.h.backend.errors, [])
})

test('pausing during acceptance stops the following plan-review request and resumes its committed boundary', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers(); const order = []
  const f = await fixture(t, { config: supervisedConfig, respond: async ({ payload }) => {
    if (isPlanner(payload)) return tool('dynamic_context_submit', { proposal: supervisedProposal() })
    if (isController(payload)) { order.push('controller'); return { text: 'Finished.' } }
    if (!payload.response_format) { order.push('worker'); return { text: JSON.stringify(validDisposition()) } }
    if (payload.messages[0].content.includes('受理当前叶')) { order.push('accept'); entered.resolve(); await release.promise; return { text: '{"verdict":"ACCEPT","reason":"Accepted."}' } }
    order.push('plan'); return { text: '{"verdict":"CURRENT"}' }
  } })
  const agent = await f.agent('pause-supervision')
  await f.h.ctx.commands.execute(agent, '/task-graph Produce a report.', [], new AbortController().signal)
  await entered.promise
  const api = f.h.ctx.transactionGraph.workflows, view = api.executionView(agent)
  assert.equal(view.activity.stage, 'result_check')
  await api.controlExecution(agent, { workflowId: view.workflowId, action: 'pause' }); release.resolve(); await agent.whenIdle()
  assert.equal(f.status(agent).phase, 'PAUSED', JSON.stringify(f.status(agent)))
  assert.deepEqual(order, ['worker', 'accept'])
  await api.controlExecution(agent, { workflowId: view.workflowId, action: 'resume' }); await agent.whenIdle()
  assert.equal(f.status(agent).phase, 'COMPLETE', JSON.stringify(f.status(agent)))
  assert.deepEqual(order, ['worker', 'accept'])
})


test('new preplanner rejects only the missing verification declaration, then commits v1 without an extra execution request', async t => {
  let planning = 0
  const proposal = rootTask()
  proposal.planningReport = { understanding: 'Prepare local work', assumptions: [], design: 'One terminal', acceptanceStrategy: 'Review result evidence' }
  const f = await fixture(t, { after: 'await_approval', config: { ...supervisedConfig, preplanningAcceptance: true }, respond: ({ payload }) => {
    if (isPlanner(payload)) {
      planning++
      assert.match(payload.messages[0].content, /DYNAMIC_CONTEXT_ACCEPTANCE_V1/)
      if (planning === 2) {
        assert.match(JSON.stringify(payload.messages), /PREPLANNING_ACCEPTANCE_PROTOCOL_REQUIRED/)
        proposal.planningReport.verification = { version: 1, deliveryRequired: false, requirements: [{ id: 'goal', origin: 'USER', statement: 'Prepare local work', source: 'User request', verification: 'Result review', required: true }] }
      }
      return tool('dynamic_context_submit', { proposal })
    }
    if (payload.messages[0].content.includes('DYNAMIC_CONTEXT_UNIT_ROUTER_V1')) return {text:JSON.stringify({action:'EXECUTE',reason:'The plan is sufficient.'})}
    if (payload.messages[0].content.includes('RULE_BLUEPRINT_AUDIT_V1')) return {text:JSON.stringify({verdict:'APPROVE',reason:'The declared terminal covers the verified user goal.'})}
    assert.ok(isController(payload), 'No worker starts before the user-selected approval boundary')
    return { text: 'Plan is ready for the selected approval boundary.' }
  } })
  const agent = await f.agent('acceptance-preplanner')
  await f.h.ctx.commands.execute(agent, '/task-graph Prepare local work.', [], new AbortController().signal)
  await agent.whenIdle()
  assert.deepEqual(f.h.backend.errors, [])
  assert.equal(planning, 2); assert.equal(f.status(agent).phase, 'WAITING_PLAN_APPROVAL')
  assert.equal(f.status(agent).plannerAcceptanceVersion, 1)
  assert.equal(f.runner(agent).graph.read().planningRecord.report.verification.version, 1)
})

test('the scoped planner authors a rule, reads its mnemonic and confirms it before plan approval', async t => {
  let step = 0, audits = 0
  const f = await fixture(t, { after: 'await_approval', autoDecisions: false, respond: ({ payload }) => {
    if (isPlanner(payload)) return tool('dynamic_context_submit', { proposal: rootTask() })
    const system = payload.messages[0].content
    if (system.includes('DYNAMIC_CONTEXT_UNIT_ROUTER_V1')) return { text: JSON.stringify({ action: 'PLAN', reason: 'Plan the two units.' }) }
    if (system.includes('DYNAMIC_CONTEXT_SCOPE_AUDIT_V1')) { audits++; return { text: JSON.stringify({ verdict: 'APPROVE', reason: 'Validated plan and rule.', issues: [] }) } }
    if (system.includes('DYNAMIC_CONTEXT_SCOPE_UPDATE_V1')) {
      const target = 'finish'
      if (++step === 1) return tool('dynamic_context_set_rule', { target, expected_revision: 0, id: 'checked', when: { node: 'check', in: ['PASS'] } })
      if (step === 2) return tool('dynamic_context_read_rules', { target, format: 'mnemonic' })
      if (step === 3) {
        assert.match(JSON.stringify(payload.messages), /check 通过/)
        return tool('dynamic_context_manage_rules', { target, expected_revision: 1, action: 'confirm' })
      }
      return { text: JSON.stringify(enterPlan(JSON.parse(payload.messages[1].content), ['check','finish'])) }
    }
    return reviewRoot(payload) ?? { text: 'Ready for human plan approval.' }
  } })
  const agent = await f.agent('rules-layer-planner')
  await f.h.ctx.commands.execute(agent, '/task-graph Check then deliver.', [], new AbortController().signal)
  await agent.whenIdle()
  assert.deepEqual(f.h.backend.errors, [])
  assert.equal(f.status(agent).phase, 'WAITING_PLAN_APPROVAL', JSON.stringify(f.status(agent)))
  assert.equal(step, 4); assert.equal(audits, 1)
  assert.deepEqual(f.runner(agent).graph.read().graph.state.plan.nodes.find(row => row.key === 'finish').rules[0].when, { node: 'check', in: ['PASS'] })
})

test('registered tool blockage survives controller retry and reload, then UI continuation consumes receipts without replay', async t => {
  let workers = 0, writes = 0
  const f = await fixture(t, { config: { direct: { durable: true } }, setup: ctx => {
    ctx.on('tools/execute', (exec, next) => {
      if (exec.name !== 'write') return next()
      writes++
      return { isError: true, content: [{ type: 'text', text: 'Fixture store requires repair' }], error: { message: 'Fixture store requires repair' } }
    })
  }, respond: ({ payload }) => {
    if (isPlanner(payload)) return tool('dynamic_context_submit', { proposal: rootTask(['write']) })
    if (isController(payload)) return { text: 'Waiting for the human continuation control.' }
    if (++workers === 1) return tool('write', { file_path: 'blocked.txt', content: 'not written' })
    assert.match(JSON.stringify(payload.messages), /Fixture store requires repair/)
    return { text: 'Recovered under unchanged permissions without repeating the failed write.' }
  } })
  f.h.ctx.get('dynamicContextToolErrors').register({ pluginId: 'fixture-plugin', ruleId: 'blocked-write', toolId: 'write',
    when: { '/isError': true, '/error/message': 'Fixture store requires repair' }, reason: 'Explicit fixture host repair.' })
  let agent = await f.agent('blocked-tool-workflow')
  await f.h.ctx.commands.execute(agent, '/task-graph Inspect error handling.', [], new AbortController().signal)
  await agent.whenIdle()
  assert.equal(f.status(agent).phase, 'BLOCKED_TOOL_ERROR', JSON.stringify(f.status(agent)))
  assert.equal(f.runner(agent).checkpointStatus().phase, 'BLOCKED'); assert.equal(workers, 1); assert.equal(writes, 1)
  for (const action of ['continue', 'pause', 'start', 'approve']) {
    const status = await f.call(agent, 'dynamic_context_workflow', { action })
    assert.equal(status.phase, 'BLOCKED_TOOL_ERROR'); assert.equal(f.status(agent).scheduled, false)
  }
  await f.handles[0].dispose()
  const resumed = await f.h.ctx.agents.resume({ resumeSessionId: agent.id, agentOptions: { provider: 'dynamic-context-fake', model: 'fake-llama' } })
  f.handles.push(resumed); agent = resumed.agent
  assert.equal(f.status(agent).phase, 'BLOCKED_TOOL_ERROR'); assert.equal(f.status(agent).scheduled, false)
  const registry = f.h.ctx.transactionGraph.workflows, view = registry.executionView(agent)
  assert.equal(view.state, 'blocked'); assert.equal(view.canResume, true)
  assert.match(view.reason, /write: Explicit fixture host repair/)
  await registry.controlExecution(agent, { workflowId: view.workflowId, action: 'resume' }); await agent.whenIdle()
  assert.equal(f.status(agent).phase, 'COMPLETE', JSON.stringify(f.status(agent)))
  assert.equal(workers, 2); assert.equal(writes, 1); assert.equal(fs.existsSync(path.join(f.projectRoot, 'blocked.txt')), false)
  assert.deepEqual(f.h.backend.errors, [])
})

test('a blocked result reviewer resumes from its stored response and keeps the active leaf', async t => {
  const toolId = 'fixture_review_read'
  let workers = 0, reviews = 0, reads = 0
  const f = await fixture(t, { config: supervisedConfig, respond: ({ payload }) => {
    if (isPlanner(payload)) return tool('dynamic_context_submit', { proposal: supervisedProposal() })
    if (isController(payload)) return { text: 'Observed workflow state.' }
    if (!payload.response_format) { workers++; return { text: JSON.stringify(validDisposition()) } }
    if (!payload.messages[0].content.includes('受理当前叶')) return { text: '{"verdict":"CURRENT"}' }
    if (++reviews === 1) return tool(toolId, {})
    assert.match(JSON.stringify(payload.messages), /REVIEW_FIXTURE_UNAVAILABLE/)
    return { text: '{"verdict":"ACCEPT","reason":"Checked the recorded limitation."}' }
  } })
  f.h.ctx.get('dynamicContextRoleTools').registerTool({ pluginId: 'fixture', registrationId: toolId, toolId,
    roles: ['result_check'], effect: 'read', schema: { type: 'function', function: { name: toolId,
      description: 'Read fixture evidence.', parameters: { type: 'object' } } }, authorize: () => true,
    execute: () => { reads++; throw Object.assign(new Error('Fixture evidence could not be read.'), { code: 'REVIEW_FIXTURE_UNAVAILABLE' }) } })
  f.h.ctx.get('dynamicContextToolErrors').register({ pluginId: 'fixture', ruleId: 'review-read-block', role: 'result_check', toolId,
    errorCode: 'REVIEW_FIXTURE_UNAVAILABLE', reason: 'Inspect the archived fixture.' })
  const agent = await f.agent('background-role-tool-block')
  await f.h.ctx.commands.execute(agent, '/task-graph Deliver one reviewed leaf.', [], new AbortController().signal)
  await agent.whenIdle()
  const runner = f.runner(agent), orchestrator = f.h.runner.interaction.orchestrator
  const blocked = f.status(agent).toolErrorBlock, attemptId = runner.graph.read().graph.state.active?.attemptId
  assert.equal(blocked?.role, 'result_check', JSON.stringify(f.status(agent)))
  assert.equal(blocked.runId, runner.graph.read().supervision.roleRunId)
  assert.equal(f.status(agent).phase, 'BLOCKED_TOOL_ERROR'); assert.equal(reviews, 1); assert.ok(attemptId)
  assert.equal(orchestrator.executionView(agent).canResume, true)
  await orchestrator.fromView(agent, 'resume', new AbortController().signal)
  await agent.whenIdle()
  assert.equal(f.status(agent).phase, 'COMPLETE', JSON.stringify(f.status(agent)))
  assert.equal(workers, 1); assert.equal(reads, 1); assert.equal(reviews, 2)
  assert.equal(runner.graph.read().reports[0].attemptId, attemptId)
  assert.deepEqual(f.h.backend.errors, [])
})

for (const role of ['controller', 'preplanning']) test(`${role} uses the shared tool-error registry and waits for a human`, async t => {
  const name = role === 'preplanning' ? 'bash' : 'dynamic_context_graph_status'
  let executions = 0, seen = 0
  const f = await fixture(t, { after: 'await_approval', setup: ctx => {
    ctx.on('tools/execute', (exec, next) => {
      if (exec.name !== name) return next()
      executions++
      return { isError: true, content: [{ type: 'text', text: 'Fixture input needs repair.' }],
        error: { message: 'Fixture input needs repair.', info: { code: 'FIXTURE_INPUT_FAILED' } } }
    })
  }, respond: ({ payload }) => {
    if (isPlanner(payload)) {
      if (role === 'preplanning' && ++seen === 1) return tool(name, { command: 'pwd', description: 'Check fixture directory' })
      if (role === 'preplanning') assert.match(JSON.stringify(payload.messages), /Fixture input needs repair/)
      return tool('dynamic_context_submit', { proposal: rootTask() })
    }
    if (role === 'controller' && ++seen === 1) return tool(name, {})
    return { text: 'Waiting for plan approval.' }
  } })
  f.h.ctx.get('dynamicContextToolErrors').register({ pluginId: 'fixture', ruleId: 'native-role-block', role,
    toolId: name, errorCode: 'FIXTURE_INPUT_FAILED', reason: 'Repair the fixture input.' })
  const agent = await f.agent('native-tool-block-' + role)
  await f.h.ctx.commands.execute(agent, '/task-graph Prepare a validation plan.', [], new AbortController().signal)
  await agent.whenIdle()
  const orchestrator = f.h.runner.interaction.orchestrator
  await orchestrator.nativeToolBlocks.get(agent)
  assert.equal(f.status(agent).toolErrorBlock?.role, role, JSON.stringify(f.status(agent)))
  assert.equal(f.status(agent).phase, 'BLOCKED_TOOL_ERROR'); assert.equal(executions, 1)
  assert.equal(seen, 1)
  assert.equal((await f.call(agent, 'dynamic_context_workflow', { action: 'continue' })).phase, 'BLOCKED_TOOL_ERROR')
  assert.equal(orchestrator.executionView(agent).canResume, true)
  await orchestrator.fromView(agent, 'resume', new AbortController().signal)
  await agent.whenIdle()
  assert.equal(f.status(agent).phase, 'WAITING_PLAN_APPROVAL'); assert.equal(executions, 1)
  assert.deepEqual(f.h.backend.errors, [])
})

test('controller adopts an already registered DSH ID on the next prompt and enforces its selected operation', async t => {
  const id = 'records_lookup', effects = []
  let step = 0
  const f = await fixture(t, { config: { interaction: { mode: 'interactive', orchestration: false } },
    setup(ctx) { ctx.tools.register({ name: id, description: 'Records', parameters: { type: 'object', properties: { action: { type: 'string' } },
      required: ['action'], additionalProperties: false }, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute({ action }) { effects.push(action); return action } }) },
    respond({ payload }) {
      step++
      if (step === 1) { assert.ok(!names(payload).includes(id)); return { text: 'Ready.' } }
      assert.ok(names(payload).includes(id), names(payload).join(', '))
      if (step === 2) return tool(id, { action: 'edit' })
      if (step === 3) { assert.match(JSON.stringify(payload.messages), /ROLE_TOOL_DENIED/); return tool(id, { action: 'read' }) }
      return { text: 'Read complete.' }
    } })
  const agent = await f.agent('controller-dsh-policy')
  await f.h.ctx.commands.execute(agent, '/task-graph Inspect records.', [], new AbortController().signal)
  await agent.whenIdle()
  const target = f.h.ctx.get('dynamicContextToolPolicies').forTool(f.h.ctx.tools.get(id).name)
    .getStrategy({ target: 'roleTools', role: 'controller' })
  assert.equal(target.mode, 'whitelist')
  target.register({ pluginId: 'records', registrationId: 'inspect', priority: 20, when: { '/action': 'read' } })
  agent.followup(user('Read the records.'))
  await agent.whenIdle()
  assert.deepEqual(f.h.backend.errors, [])
  assert.deepEqual(effects, ['read'])
})

test('native controller and its DSH compactor use the scoped registered API until the override is disposed', async t => {
  const selected = await startFakeLlama({ respond: () => ({ text: 'Controller reply on its own API.' }) })
  t.after(() => selected.close())
  const f = await fixture(t, { config: { interaction: { mode: 'interactive', orchestration: false } },
    providers: { 'controller-api': nativeProfile(selected, 'controller-model') }, setup: nativeCompactor,
    respond: () => ({ text: 'Ordinary reply.' }) })
  const ordinary = await f.agent('ordinary-model'), agent = await f.agent('controller-model-owner')
  const remove = f.h.ctx.get('dynamicContextRoleModels').register({ pluginId: 'example', registrationId: 'controller',
    role: 'controller', backend: { provider: 'controller-api', model: 'controller-model' } })
  ordinary.followup(user('Ordinary chat')); await ordinary.whenIdle()
  assert.equal(f.h.backend.requests.length, 1)
  await f.h.ctx.commands.execute(agent, '/task-graph Choose a controller route.', [], new AbortController().signal)
  await agent.whenIdle()
  assert.equal(agent.session.requestHeader().config.provider, 'controller-api')
  const before = selected.requests.length
  assert.ok(before > 0)
  const receipt = await nativeSummary(f.h.ctx, agent)
  assert.deepEqual([receipt.provider, receipt.model], ['controller-api', 'controller-model'])
  assert.equal(selected.requests.length, before + 1)
  assert.ok(selected.requests.every(row => row.payload.model === 'controller-model'))
  remove()
  let stepSummary, restore
  const off = f.h.ctx.on('agent/pre-step', async ({ agent: current }, next) => {
    if (current === agent && !stepSummary) {
      stepSummary = await nativeSummary(f.h.ctx, current)
      restore = f.h.ctx.get('dynamicContextRoleModels').register({ pluginId: 'example', registrationId: 'next-controller',
        role: 'controller', backend: { provider: 'controller-api', model: 'controller-model' } })
    }
    return next()
  })
  agent.followup(user('Continue with the current route.')); await agent.whenIdle()
  off()
  assert.deepEqual([stepSummary.provider, stepSummary.model], ['dynamic-context-fake', 'fake-llama'])
  assert.equal(agent.session.requestHeader().config.provider, 'dynamic-context-fake')
  assert.equal(selected.requests.length, before + 1)
  assert.equal(f.h.backend.requests.length, 3)
  agent.followup(user('Run the next step.')); await agent.whenIdle()
  assert.equal(agent.session.requestHeader().config.provider, 'controller-api')
  restore()
  assert.deepEqual(selected.errors, [])
})

test('resumed native planning and its DSH compaction use the original independent planner API', async t => {
  let f, owner, receipt, steps = 0
  const selected = await startFakeLlama({ respond: async ({ payload }) => {
    if (!isPlanner(payload)) return { text: 'Planning evidence checkpoint.' }
    if (++steps === 1) return { text: 'First planning pass is complete.' }
    const planner = f.h.ctx.agents.get(f.status(owner).plannerSessionId)
    receipt = await nativeSummary(f.h.ctx, planner)
    return tool('dynamic_context_submit', { proposal: rootTask() })
  } })
  t.after(() => selected.close())
  f = await fixture(t, { after: 'await_approval', providers: { 'planner-api': nativeProfile(selected, 'planner-model') },
    setup: nativeCompactor, respond: () => ({ text: 'Waiting for planning.' }) })
  owner = await f.agent('planner-model-owner')
  const remove = f.h.ctx.get('dynamicContextRoleModels').register({ pluginId: 'example', registrationId: 'planner',
    role: 'preplanning', scope: { sessionId: owner.id }, backend: { provider: 'planner-api', model: 'planner-model' } })
  await f.h.ctx.commands.execute(owner, '/task-graph Draft the local plan.', [], new AbortController().signal)
  await owner.whenIdle()
  assert.equal(f.status(owner).phase, 'PLANNING_INCOMPLETE')
  remove()
  await f.call(owner, 'dynamic_context_workflow', { action: 'continue' })
  owner.followup(createUserMessage({ source: { kind: 'dynamic-context' }, content: [{ type: 'text', text: 'Continue this plan.' }] }))
  await owner.whenIdle()
  assert.equal(f.status(owner).phase, 'WAITING_PLAN_APPROVAL', JSON.stringify(f.status(owner)))
  assert.deepEqual([receipt.provider, receipt.model], ['planner-api', 'planner-model'])
  assert.equal(steps, 2)
  assert.equal(selected.requests.length, 3)
  assert.ok(selected.requests.every(row => row.payload.model === 'planner-model'))
  assert.deepEqual(selected.errors, [])
})

test('manual controller pauses on a whole-tool error and human resume does not schedule planning or replay', async t => {
  const name = 'dynamic_context_graph_status'
  let calls = 0
  const f = await fixture(t, { config: { interaction: { mode: 'interactive', orchestration: false } },
    setup(ctx) { ctx.on('tools/execute', (exec, next) => {
      if (exec.name !== name) return next()
      calls++
      return { isError: true, error: { message: 'Status unavailable.' }, content: [{ type: 'text', text: 'Status unavailable.' }] }
    }) }, respond: () => tool(name, {}) })
  f.h.ctx.get('dynamicContextToolErrors').register({ pluginId: 'manual', ruleId: 'all-status-errors', toolId: name })
  const agent = await f.agent('manual-status-error'), signal = new AbortController().signal
  await f.h.ctx.commands.execute(agent, '/task-graph Inspect current status.', [], signal)
  await agent.whenIdle()
  const lifecycle = f.h.runner.interaction.lifecycle
  await lifecycle.nativeToolBlocks.get(agent)
  const blocked = lifecycle.record(agent)?.toolErrorBlock
  assert.equal(blocked?.toolId, name)
  assert.equal(lifecycle.executionView(agent).canResume, true)
  await lifecycle.fromView(agent, 'resume', signal)
  assert.equal(lifecycle.record(agent).phase, 'MANUAL_READY')
  assert.equal(lifecycle.record(agent).toolErrorAcknowledgement.block.id, blocked.id)
  assert.equal(lifecycle.queued.has(agent), false)
  assert.equal(calls, 1)
  assert.equal(f.h.backend.requests.length, 1)
})

test('preplanning follows main permission changes and still commits through its existing boundary', async t => {
  let owner, steps = 0
  const f = await fixture(t, { after: 'await_approval', respond: ({ payload }) => {
    if (!isPlanner(payload)) return { text: 'Controller observed current state.' }
    if (++steps === 1) {
      setSandboxMode(owner.session, 'read-only')
      return tool('bash', { command: 'pwd', description: 'Read basic conditions under updated permissions' })
    }
    assert.match(JSON.stringify(payload.messages), /main conversation permissions/)
    assert.match(JSON.stringify(payload.messages), /read-only/)
    return tool('dynamic_context_submit', { proposal: rootTask() })
  } })
  owner = await f.agent('hot-planner-permissions')
  await f.h.ctx.commands.execute(owner, '/task-graph Plan this task', [], new AbortController().signal)
  await owner.whenIdle()
  assert.deepEqual(f.h.backend.errors, [])
  assert.equal(steps, 2); assert.equal(f.status(owner).phase, 'WAITING_PLAN_APPROVAL')
})

test('a pre-existing interrupted boundary without a step is readable and only new records are normalized', async t => {
  const f=await fixture(t), agent=await f.agent('legacy-boundary-without-step')
  f.h.runner.interaction.mount(agent,{mode:'full'})
  const orch=f.h.runner.interaction.orchestrator, runner=f.runner(agent)
  const boundary={stage:'EXECUTING',kind:'boundary',at:new Date().toISOString(),sessionId:null,tool:null}
  const legacy={version:1,workflowId:runner.workflowId,sessionId:agent.session.id,phase:'PAUSED',pauseKind:'normal',activity:boundary}
  appendPluginRecord(agent.session,LIFECYCLE_RECORD,legacy)
  const length=agent.session.snapshotEvents().length
  assert.equal(orch.executionView(agent).activity.step,0)
  assert.equal(agent.session.snapshotEvents().length,length)
  assert.equal(Object.hasOwn(orch.record(agent).activity,'step'),false)
  assert.equal((await orch.save(agent,{phase:'PAUSED',activity:boundary})).activity.step,0)
  runner.activity={...boundary,step:17}
  assert.equal(orch.executionView(agent).activity.step,17)
  runner.activity={...boundary,kind:'tool'}
  assert.equal(orch.executionView(agent).activity.step,undefined)
})

for (const outcome of ['PASS', 'FAILED']) test('unit v2 command rejects legacy proposals, waits for human approval and settles ' + outcome, async t => {
  const { rootTask, unitReport, reviewRoot } = await import('../testing/unit-proposal.mjs')
  const roles = [], expected = outcome === 'PASS' ? 'Successful verification.' : 'Observed failure.'
  let submittedLegacy = false
  const f = await fixture(t, { after: 'await_approval', autoDecisions: false, respond: ({ payload }) => {
    if (isPlanner(payload)) {
      if (!submittedLegacy) {
        submittedLegacy = true
        return tool('dynamic_context_submit', { proposal: runtimeProposal([]) })
      }
      assert.match(JSON.stringify(payload.messages), /UNIT_ROOT_SEED_REQUIRED/)
      return tool('dynamic_context_submit', { proposal: rootTask(outcome === 'FAILED' ? ['read'] : []) })
    }
    const review = reviewRoot(payload)
    if (review) { roles.push(JSON.parse(review.text).action ?? JSON.parse(review.text).verdict ?? 'report'); return review }
    if (isController(payload)) return { text: 'Ready.' }
    if (outcome === 'FAILED' && !payload.messages.some(row => row.tool_call_id === 'criterion-missing'))
      return { tools: [{ id: 'criterion-missing', name: 'read', arguments: { file_path: 'absent-fixture.txt' } }] }
    roles.push('work')
    return { text: JSON.stringify({ ...unitReport(expected, outcome), ...(outcome === 'FAILED' ? { failedCallId: 'criterion-missing' } : {}) }) }
  } })
  const agent = await f.agent('unit-command-' + outcome)
  await f.h.ctx.commands.execute(agent, '/task-graph Verify one source.', [], new AbortController().signal)
  await agent.whenIdle()
  assert.deepEqual(f.h.backend.errors, [])
  assert.equal(f.status(agent).phase, 'WAITING_PLAN_APPROVAL', JSON.stringify(f.status(agent)))
  assert.deepEqual(roles, ['APPROVE', 'EXECUTE'])
  await f.call(agent, 'dynamic_context_workflow', { action: 'approve' })
  agent.followup(createUserMessage({ source: { kind: 'dynamic-context' }, content: [{ type: 'text', text: 'Approved state ready.' }] }))
  await agent.whenIdle()
  assert.deepEqual(f.h.backend.errors, [])
  assert.equal(f.status(agent).phase, 'COMPLETE', JSON.stringify(f.status(agent)))
  assert.equal(f.runner(agent).graph.status().rootOutcome, outcome)
  assert.deepEqual(roles, ['APPROVE', 'EXECUTE', 'work', 'ACCEPT', 'report'])
})

test('v2 refuses an existing unversioned complete-mode ledger before any model call or graph mutation', async t => {
  const { MODE_RECORD } = await import('../interaction.mjs')
  const f = await fixture(t, { respond: () => { throw new Error('Legacy ledger started a model.') } })
  const agent = await f.agent('historic-graph')
  agent.session.append('user/message', user('Inspect the historic workflow.'), { surfaceOp: 'append' })
  const i = f.h.runner.interaction, signal = new AbortController().signal
  await i.select(agent, { reason: 'Inspect historical records' }, signal)
  const runner = f.runner(agent), old = runtimeProposal([])
  old.planningReport = rootTask().planningReport
  old.contextGraph.bindings[0].completion = { kind: 'report' }
  const archive = runner.graph.submit(old)
  const { unitWorkflowVersion, ...oldMode } = i.record(agent)
  appendPluginRecord(agent.session, MODE_RECORD, oldMode)
  await assert.rejects(runner.runNext({ expectedRevision: archive.revision, sourceAgent: agent }), { code: 'LEGACY_WORKFLOW_UNSUPPORTED' })
  await i.orchestrator.drive(agent, signal)
  assert.equal(f.status(agent).reason, 'LEGACY_WORKFLOW_UNSUPPORTED')
  assert.equal(runner.graph.read().checksum, archive.checksum)
  assert.equal(f.h.backend.requests.length, 0)
})

test('v2 keeps oversized project instructions out of the native executor system prompt and pages their original', async t => {
  const marker = 'PROJECT_SOURCE_END_731', body = 'Check the recorded unit evidence. '.repeat(2500) + marker
  let paged = false
  const f = await fixture(t, { config: { dynamicContextMaxBytes: 2048, unitFinalReport: false }, respond: ({ payload }) => {
    if (isPlanner(payload)) return tool('dynamic_context_submit', { proposal: rootTask() })
    if (isController(payload)) return { text: 'Complete.' }
    const system = payload.messages[0].content
    const page = payload.messages.findLast(row => row.role === 'tool')
    if (page) {
      assert.match(page.content, /PROJECT_SOURCE_END_731/)
      paged = true
      return { text: 'Inspected the original.' }
    }
    assert.ok(!system.includes(marker))
    const facts = JSON.parse(system.match(/<direct_host_facts>\s*([\s\S]*?)\s*<\/direct_host_facts>/)[1])
    assert.ok(facts.materialSummary.fields.some(field => field.field === 'instructions'))
    const reader = facts.materialSummary.reader
    return tool(reader.tool, { ...reader.arguments, length: body.length + 8192 })
  } })
  fs.writeFileSync(path.join(f.projectRoot, 'AGENTS.md'), body)
  const agent = await f.agent('large-project-instructions')
  await f.h.ctx.commands.execute(agent, '/task-graph Check project instructions.', [], new AbortController().signal)
  await agent.whenIdle()
  assert.deepEqual(f.h.backend.errors, [])
  assert.equal(f.status(agent).phase, 'COMPLETE', JSON.stringify(f.status(agent)))
  assert.equal(paged, true)
})
