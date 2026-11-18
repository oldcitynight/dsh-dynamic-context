import test from 'node:test'
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
import { createRuntimeHarness, runtimeProposal } from '../testing/runtime-harness.mjs'
import { MODE_OPTIONS } from '../interaction.mjs'
import { EXECUTION_OPTIONS, LIFECYCLE_RECORD } from '../orchestration.mjs'
import { PLANNING_TOOLS } from '../preplanning.mjs'
import { guidanceRecords } from '../guidance-state.mjs'

const names = payload => (payload.tools ?? []).map(row => row.function.name)
const isPlanner = payload => payload.messages.some(row => row.role === 'system' && row.content.includes('DYNAMIC_CONTEXT_PREPLANNER_V1'))
const isController = payload => names(payload).includes('dynamic_context_graph_status')
const tool = (name, args) => ({ tools: [{ name, arguments: args }] })
const user = text => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
// Existing scenarios exercise the legacy protocol deliberately; new acceptance
// cases override preplanningAcceptance=true and submit an explicit v1 plan.
async function fixture(t, { respond, choice = 'full', after = 'auto_start', setup, config = {}, outsideTemp = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(outsideTemp ? os.homedir() : os.tmpdir(), 'managed-workflow-')))
  const projectRoot = path.join(root, 'project'); fs.mkdirSync(projectRoot)
  const handles = [], questions = []
  const h = await createRuntimeHarness({ projectRoot, directory: path.join(root, 'state'), respond,
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
      assert.match(JSON.stringify(payload.messages), /DYNAMIC_CONTEXT_COMMAND_REQUIRED/)
      return tool('bash', { command: 'pwd', description: 'Inspect for discussion' })
    }
    return { text: 'Only discussion and the requested inspection.' }
  } })
  const agent = await f.agent('native-discussion', agentCtx => {
    for (const name of ['bash', 'todo_write']) agentCtx.tools.register(defineTool({ name, description: 'Mock native tool',
      parameters: { command: { type: 'string' } }, output: { schema: { type: 'string' }, render: (_a, value) => [{ type: 'text', text: value }] }, execute: () => { effects++; return 'OK' } }))
  })
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
      return tool('dynamic_context_submit', { proposal: runtimeProposal([]) })
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

test('independent preplanning opens real Bash, repairs a proposal in-place, ends at commit and program-dispatches two leaves', async t => {
  let planning = 0, workers = 0, rootRequests = 0
  const extension = 'scoped_media'
  const proposal = runtimeProposal(['read_image', extension])
  proposal.taskGraph.nodes.push({ key: 'second', kind: 'leaf', label: 'Second stage', parent: 'root' })
  proposal.taskGraph.edges.push({ kind: 'prerequisite', from: 'task', to: 'second' })
  proposal.contextGraph.bindings.push({ task: 'second', instruction: 'Check the preceding result.', contexts: [], tools: [], inheritReports: ['task'] })
  const f = await fixture(t, { setup: ctx => ctx.plugin(LocalAttachmentStore, { dshHome: ctx.workingDirectory.defaultDirectory }), respond: ({ payload }) => {
    if (isPlanner(payload)) {
      planning++
      assert.ok(names(payload).includes('bash'))
      assert.ok(names(payload).every(name => PLANNING_TOOLS.has(name)))
      assert.match(payload.messages.find(row => row.role === 'system').content, /"leafAllowedTools":\[[^\]]*"read_image"/)
      assert.match(payload.messages.find(row => row.role === 'system').content, /"leafAllowedTools":\[[^\]]*"scoped_media"/)
      assert.match(payload.tools.find(row => row.function.name === 'dynamic_context_submit').function.description,
        /Leaf tool allowlist for this workflow: \[[^\]]*"scoped_media"/)
      assert.doesNotMatch(JSON.stringify(payload.messages), /UNRELATED_GLOBAL_CONTEXT_MUST_NOT_LEAK|PARENT_TOOL_NOISE/)
      assert.match(JSON.stringify(payload.messages), /USER_EXACT_TASK/)
      assert.match(payload.messages.find(row => row.role === 'system').content, /DYNAMIC_CONTEXT_PLANNING_EXPLORATION_V1/)
      assert.match(payload.messages.find(row => row.role === 'system').content, /不同可行方案/)
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
  assert.deepEqual({ planning, workers, rootRequests }, { planning: 3, workers: 2, rootRequests: 1 }, JSON.stringify({ status: f.status(agent), tail: agent.session.snapshotEvents().slice(-8) }))
  assert.equal(f.status(agent).phase, 'COMPLETE')
  assert.equal(f.runner(agent).graph.read().reports.length, 2)
  assert.equal(f.questions.length, 2)
  assert.equal(fs.existsSync(path.join(f.projectRoot, 'should-not-exist')), false)
  const human = agent.session.deriveMessages().filter(row => row.source?.kind === 'user')
  assert.deepEqual(human.map(row => row.content.map(b => b.text).join('')), ['USER_EXACT_TASK'])
  assert.equal(f.h.ctx.agents.list().filter(child => child !== agent).length, 0)
})

test('await-approval performs no leaf request until the current committed graph is approved', async t => {
  let workers = 0
  const f = await fixture(t, { after: 'await_approval', respond: ({ payload }) => isPlanner(payload)
    ? tool('dynamic_context_submit', { proposal: runtimeProposal([]) })
    : isController(payload) ? { text: 'Current phase observed.' } : (workers++, { text: 'A worker report.' }) })
  const agent = await f.agent('approval-flow')
  await f.h.ctx.commands.execute(agent, '/task-graph Plan a staged task', [], new AbortController().signal)
  await agent.whenIdle()
  assert.deepEqual(f.h.backend.errors, [])
  assert.equal(f.status(agent).phase, 'WAITING_PLAN_APPROVAL', JSON.stringify({ status: f.status(agent), tail: agent.session.snapshotEvents().slice(-8) }))
  assert.equal(workers, 0)
  await f.call(agent, 'dynamic_context_workflow', { action: 'approve' })
  agent.followup(createUserMessage({ source: { kind: 'dynamic-context' }, content: [{ type: 'text', text: 'Approved state ready.' }] }))
  await agent.whenIdle()
  assert.equal(workers, 1, JSON.stringify({ status: f.status(agent), tail: agent.session.snapshotEvents().slice(-8) })); assert.equal(f.status(agent).phase, 'COMPLETE')
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
  const f = await fixture(t, { choice: 'task-graph', respond: ({ payload }) => {
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
        return tool('dynamic_context_submit', { proposal: runtimeProposal([]) })
      }
    }
    if (isController(payload)) return { text: 'Observed native plan boundary.' }
    workers++; return { text: 'A recorded worker result.' }
  } })
  const agent = await f.agent('native-plan')
  await f.h.ctx.commands.execute(agent, '/task-graph Task with native Plan active', [], new AbortController().signal)
  await agent.whenIdle()
  assert.deepEqual(f.h.backend.errors, [])
  assert.equal(f.status(agent).phase, 'WAITING_NATIVE_PLAN', JSON.stringify({ status: f.status(agent), tail: agent.session.snapshotEvents().slice(-8) }))
  assert.equal(workers, 0); assert.equal(fs.existsSync(path.join(f.projectRoot, 'forbidden-in-plan')), false)
  agent.session.append('plan/mode', { active: false })
  agent.followup(createUserMessage({ source: { kind: 'dynamic-context' }, content: [{ type: 'text', text: 'Native mode changed.' }] }))
  await agent.whenIdle()
  assert.equal(workers, 1, JSON.stringify({ status: f.status(agent), tail: agent.session.snapshotEvents().slice(-8) }))
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
      return tool('dynamic_context_submit', { proposal: runtimeProposal([]) })
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
  assert.equal(f.status(agent).phase, 'COMPLETE', JSON.stringify({ status: f.status(agent), tail: agent.session.snapshotEvents().slice(-8) }))
  assert.equal(workers, 1); assert.equal(planning, 3)
})

test('parent cancellation stops the planner and never dispatches a leaf', async t => {
  let ready, finish, workers = 0
  const entered = new Promise(resolve => { ready = resolve })
  const release = new Promise(resolve => { finish = resolve })
  const f = await fixture(t, { respond: async ({ payload }) => {
    if (isPlanner(payload)) { ready(); await release; return tool('dynamic_context_submit', { proposal: runtimeProposal([]) }) }
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
    if (isPlanner(payload)) { ready(); await release; return tool('dynamic_context_submit', { proposal: runtimeProposal([]) }) }
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
    if (isPlanner(payload)) { planners++; return tool('dynamic_context_submit', { proposal: runtimeProposal([]) }) }
    return { text: 'Observed only.' }
  } })
  const agent = await f.agent('reloaded-queue')
  agent.session.append('user/message', user('Prepare and execute this task.'), { surfaceOp: 'append' })
  await f.call(agent, 'dynamic_context_select_mode', { reason: 'A staged task.' })
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
    if (isPlanner(payload)) { planners++; return tool('dynamic_context_submit', { proposal: runtimeProposal([]) }) }
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
  assert.equal(f.status(agent).phase, 'WAITING_PLAN_APPROVAL', JSON.stringify({ status: f.status(agent), tail: agent.session.snapshotEvents().slice(-8) }))
  assert.equal(f.status(agent).plannerReceipt.recovered, true)
})

test('two root conversations keep their task contracts and independent planners separate', async t => {
  const tasks = []
  const f = await fixture(t, { after: 'await_approval', respond: ({ payload }) => {
    if (isPlanner(payload)) {
      const content = JSON.stringify(payload.messages)
      assert.notEqual(content.includes('ONLY_ALPHA_TASK'), content.includes('ONLY_BETA_TASK'))
      tasks.push(content.includes('ONLY_ALPHA_TASK') ? 'alpha' : 'beta')
      return tool('dynamic_context_submit', { proposal: runtimeProposal([]) })
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
  const order = [], proposal = runtimeProposal([])
  proposal.planningReport = { understanding: 'Prepare two serial reports.', assumptions: [], design: 'One report then a dependent check.', acceptanceStrategy: 'Check each submitted result.' }
  proposal.contextGraph.bindings[0].completion = { kind: 'report' }
  proposal.taskGraph.nodes.push({ key: 'second', kind: 'leaf', label: 'Dependent check', parent: 'root' })
  proposal.taskGraph.edges.push({ kind: 'prerequisite', from: 'task', to: 'second' })
  proposal.contextGraph.bindings.push({ task: 'second', instruction: 'Check the previous report.', contexts: [], tools: [], inheritReports: ['task'], completion: { kind: 'report' } })
  const f = await fixture(t, { config: { supervision: true, supervisionContext: 'reports', direct: { durable: true },
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
    return { text: JSON.stringify({ outcome: 'COMPLETE', summary: 'Prepared a scoped report.', artifacts: [], executionReport: {
      workHistory: ['Considered the active local criterion.'], results: [{ criterion: 'Prepare a scoped report', result: 'The local result is recorded.', artifactRefs: [], testIds: [] }],
      directories: [], tests: [], limitations: ['This is a synthetic protocol exercise.'],
    } }) }
  } })
  const agent = await f.agent('supervised-' + interruptReview)
  await f.h.ctx.commands.execute(agent, '/task-graph Prepare two serial reports.', [], new AbortController().signal)
  await agent.whenIdle()
  assert.deepEqual(f.h.backend.errors, [])
  assert.deepEqual(order, interruptReview ? ['planning', 'worker', 'acceptance', 'controller']
    : ['planning', 'worker', 'acceptance', 'plan-review', 'worker', 'acceptance', 'plan-review', 'controller'], JSON.stringify({ status: f.status(agent), tail: agent.session.snapshotEvents().slice(-8) }))
  assert.equal(f.status(agent).phase, interruptReview ? 'NEEDS_ATTENTION' : 'COMPLETE')
  if (interruptReview) {
    assert.equal(f.runner(agent).status().supervision.phase, 'CHECK_RESULT')
    assert.ok(f.runner(agent).status().taskGraph.active)
  } else assert.equal(f.runner(agent).graph.read().supervision.outcomes.length, 2)
})

test('a committed graph without a successful planner tool receipt never starts execution', async t => {
  let planning = 0, workers = 0
  const f = await fixture(t, { respond: ({ payload }) => {
    if (isPlanner(payload)) return ++planning === 1 ? tool('dynamic_context_submit', { proposal: runtimeProposal([]) }) : { text: 'Submission failed at the receipt boundary.' }
    if (isController(payload)) return { text: 'Requires handoff investigation.' }
    workers++; return { text: 'Must not execute.' }
  } })
  const agent = await f.agent('submit-fault')
  agent.session.append('user/message', user('A task with a controlled fault.'), { surfaceOp: 'append' })
  await f.call(agent, 'dynamic_context_select_mode', { reason: 'Staged task.' })
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
    if (isPlanner(payload)) { planning++; return tool('dynamic_context_submit', { proposal: runtimeProposal([]) }) }
    return { text: 'The committed graph is waiting as selected.' }
  } })
  const handle = await f.h.ctx.agents.create({ sessionId: 'changed-model', meta: { cwd: f.projectRoot },
    agentOptions: { provider: 'old-unavailable-provider', model: 'old-unavailable-model' },
    setup: (_agentCtx, agent) => agent.model.select({ provider: 'dynamic-context-fake', model: 'fake-llama' }),
  })
  f.handles.push(handle)
  await f.h.ctx.commands.execute(handle.agent, '/task-graph Plan a project using the currently selected model.', [], new AbortController().signal); await handle.agent.whenIdle()
  assert.deepEqual(f.h.backend.errors, [])
  assert.equal(planning, 1, JSON.stringify(f.status(handle.agent)))
  assert.equal(f.status(handle.agent).phase, 'WAITING_PLAN_APPROVAL')
})

const validDisposition = () => ({ outcome: 'COMPLETE', summary: 'Delivered the local report.', artifacts: [], executionReport: {
  workHistory: ['Performed this local step.'], results: [{ criterion: 'Local report', result: 'Scoped result prepared.', artifactRefs: [], testIds: [] }],
  directories: [], tests: [], limitations: [],
} })
const supervisedConfig = { supervision: true, supervisionContext: 'reports', direct: { durable: true },
  revision: { policy: { objective: 'Fixture', requirements: [{ id: 'scope', text: 'Follow the task.' }] } } }
function supervisedProposal() {
  const proposal = runtimeProposal([])
  proposal.planningReport = { understanding: 'One local report.', assumptions: [], design: 'One leaf with result review.', acceptanceStrategy: 'Inspect the result.' }
  proposal.contextGraph.bindings[0].completion = { kind: 'report' }
  return proposal
}

for (const auditedPause of [false, true]) test(`no-ready exception runs only after acceptance and plan review, then serially reopens work (auditedPause=${auditedPause})`, async t => {
  const order = []; let workers = 0, handlers = 0
  const f = await fixture(t, { config: supervisedConfig, respond: ({ payload }) => {
    if (isPlanner(payload)) return tool('dynamic_context_submit', { proposal: supervisedProposal() })
    if (isController(payload)) { order.push('controller'); return { text: 'State observed.' } }
    const instruction = payload.messages[0].content
    if (instruction.includes('DYNAMIC_CONTEXT_BLOCKAGE_PAUSE_AUDIT_V1')) {
      order.push('pause-audit'); return { text: JSON.stringify({ verdict: 'APPROVE', reason: 'The requested wait is supported.', issues: [] }) }
    }
    if (instruction.includes('DYNAMIC_CONTEXT_BLOCKAGE_HANDLER_V1')) {
      order.push('blockage'); handlers++
      const input = JSON.parse(payload.messages[1].content), report = input.affectedReports[0]
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
    order.push('worker'); workers++
    const result = validDisposition()
    if (workers === 1) { result.outcome = 'BLOCKED'; result.summary = 'A required input was not inspected.' }
    else assert.match(JSON.stringify(payload.messages), /reworkRequest/)
    return { text: JSON.stringify(result) }
  } })
  const agent = await f.agent('blockage-lifecycle-' + auditedPause)
  await f.h.ctx.commands.execute(agent, '/task-graph Inspect required inputs and report.', [], new AbortController().signal)
  await agent.whenIdle()
  if (auditedPause) {
    assert.deepEqual(order, ['worker', 'accept', 'plan', 'blockage', 'pause-audit'], JSON.stringify(f.status(agent)))
    assert.equal(f.status(agent).phase, 'PAUSED'); assert.equal(f.status(agent).reason, 'BLOCKAGE_REVIEWED_WAIT')
    assert.equal(f.h.runner.interaction.orchestrator.executionView(agent).canResume, true)
    await f.h.runner.interaction.orchestrator.fromView(agent, 'resume', new AbortController().signal)
    await agent.whenIdle()
  }
  assert.deepEqual(f.h.backend.errors, [])
  assert.equal(f.status(agent).phase, 'COMPLETE', JSON.stringify(f.status(agent)))
  assert.equal(workers, 2); assert.equal(f.runner(agent).graph.read().supervision.outcomes.length, 2)
  assert.equal(f.runner(agent).graph.read().graph.events.filter(e => e.type === 'REOPENED').length, 1)
  assert.deepEqual(order.slice(-5), ['blockage', 'worker', 'accept', 'plan', 'controller'])
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
  assert.deepEqual(order, ['worker', 'repair', 'accept', 'plan', 'controller'], JSON.stringify({ status: f.status(agent), tail: agent.session.snapshotEvents().slice(-8) }))
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
  await f.call(agent, 'dynamic_context_select_mode', { reason: 'A project task.' })
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
      return tool('dynamic_context_submit', { proposal: runtimeProposal([]) })
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
  assert.equal(f.status(agent).phase, 'COMPLETE', JSON.stringify({ status: f.status(agent), tail: agent.session.snapshotEvents().slice(-8) }))
  assert.equal(planning, 2); assert.equal(workers, 1)
  assert.deepEqual(f.h.backend.errors, [])
})

test('UI pause completes the current tool batch once and resumes the same leaf; unrelated sessions cannot control it', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers(); let workers = 0, writes = 0
  const f = await fixture(t, { config: { direct: { durable: true } }, setup: ctx => {
    ctx.on('tools/execute', (exec, next) => { if (exec.name === 'write') writes++; return next() })
  }, respond: async ({ payload }) => {
    if (isPlanner(payload)) return tool('dynamic_context_submit', { proposal: runtimeProposal(['write']) })
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
  await registry.controlExecution(agent, { workflowId: view.workflowId, action: 'resume' }); await agent.whenIdle()
  assert.equal(f.status(agent).phase, 'COMPLETE', JSON.stringify({ status: f.status(agent), tail: agent.session.snapshotEvents().slice(-8) }))
  assert.equal(workers, 2); assert.equal(writes, 2)
  assert.equal(f.runner(agent).graph.read().reports[0].attemptId, attempt)
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
  assert.equal(f.status(agent).phase, 'PAUSED', JSON.stringify({ status: f.status(agent), tail: agent.session.snapshotEvents().slice(-8) }))
  assert.deepEqual(order, ['worker', 'accept'])
  await api.controlExecution(agent, { workflowId: view.workflowId, action: 'resume' }); await agent.whenIdle()
  assert.equal(f.status(agent).phase, 'COMPLETE', JSON.stringify({ status: f.status(agent), tail: agent.session.snapshotEvents().slice(-8) }))
  assert.deepEqual(order, ['worker', 'accept', 'plan', 'controller'])
})


test('new preplanner rejects only the missing verification declaration, then commits v1 without an extra execution request', async t => {
  let planning = 0
  const proposal = runtimeProposal([])
  proposal.taskGraph.hierarchy = { version: 1 }
  Object.assign(proposal.taskGraph.nodes[0], { terminal: 'task', acceptance: 'The local user goal' })
  proposal.contextGraph.bindings[0].completion = { kind: 'report' }
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

test('registered tool blockage survives controller retry and reload, then UI continuation consumes receipts without replay', async t => {
  let workers = 0, writes = 0
  const f = await fixture(t, { config: { direct: { durable: true } }, setup: ctx => {
    ctx.on('tools/execute', (exec, next) => {
      if (exec.name !== 'write') return next()
      writes++
      return { isError: true, content: [{ type: 'text', text: 'Fixture store requires repair' }], error: { message: 'Fixture store requires repair' } }
    })
  }, respond: ({ payload }) => {
    if (isPlanner(payload)) return tool('dynamic_context_submit', { proposal: runtimeProposal(['write']) })
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
      return tool('dynamic_context_submit', { proposal: runtimeProposal([]) })
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
    return tool('dynamic_context_submit', { proposal: runtimeProposal([]) })
  } })
  owner = await f.agent('hot-planner-permissions')
  await f.h.ctx.commands.execute(owner, '/task-graph Plan this task', [], new AbortController().signal)
  await owner.whenIdle()
  assert.deepEqual(f.h.backend.errors, [])
  assert.equal(steps, 2); assert.equal(f.status(owner).phase, 'WAITING_PLAN_APPROVAL')
})
