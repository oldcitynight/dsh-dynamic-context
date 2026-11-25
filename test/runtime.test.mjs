import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import * as RepeatReminder from '@deepseek-ai/dsh-repeat-tool-reminder'
import WebRuntime from '@deepseek-ai/dsh-web'
import { PtcExecutor } from '@deepseek-ai/dsh-tool-executor-ptc'
import { executeFixtureTool, fixtureState } from '../testing/harness.mjs'
import { readStored, namesStored, statStored } from '../workflow-io.mjs'
import { createRuntimeHarness, runtimeProposal } from '../testing/runtime-harness.mjs'
import { startFakeLlama } from '../testing/fake-llama.mjs'

async function fixture(t, options = {}) {
  const storageRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-direct-runtime-')))
  const projectRoot = path.join(storageRoot, 'workspace'); fs.mkdirSync(projectRoot)
  const h = await createRuntimeHarness({ projectRoot, directory: path.join(storageRoot, 'state'), ...options,
    config: { storageRoot, ...options.config } })
  t.after(async () => { await h.close(); fs.rmSync(storageRoot, { recursive: true, force: true }) })
  return { ...h, projectRoot, storageRoot }
}
const tool = (name, args) => ({ tools: [{ name, arguments: name === 'bash' ? { description: 'Inspect isolated validation workspace', ...args } : args }] })
const registered = (ctx, name, execute, extra = {}) => ctx.tools.register(defineTool({ name, description: `Isolated ${name} capability`, parameters: {},
  output: { schema: { type: 'object', properties: {}, additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
  execute, ...extra }))

test('an instruction file changed by an earlier call blocks the remaining tool batch before another effect', async t => {
  const h = await fixture(t, { respond: ({ index }) => index === 1
    ? tool('read', { file_path: 'AGENTS.md' })
    : { tools: [{ name: 'write', arguments: { file_path: 'AGENTS.md', content: 'UPDATED_RULE: do not write protected.txt.' } },
      { name: 'write', arguments: { file_path: 'protected.txt', content: 'must not execute after the rule change' } }] } })
  fs.writeFileSync(path.join(h.projectRoot, 'AGENTS.md'), 'INITIAL_RULE: preserve evidence and follow directory constraints.')
  h.runner.submit(runtimeProposal(['read', 'write']))
  await assert.rejects(h.runner.runNext({ expectedRevision: 1 }), /DIRECT_RUNTIME_INSTRUCTION_CHANGED/)
  assert.equal(fs.readFileSync(path.join(h.projectRoot, 'AGENTS.md'), 'utf8'), 'UPDATED_RULE: do not write protected.txt.')
  assert.equal(fs.existsSync(path.join(h.projectRoot, 'protected.txt')), false)
  assert.equal(h.backend.requests.length, 2)
  assert.equal(h.runner.graph.read().reports.length, 0)
})

test('an instruction file newly created within a tool batch is checked before the next effect', async t => {
  const h = await fixture(t, { respond: () => ({ tools: [
    { name: 'write', arguments: { file_path: 'AGENTS.md', content: 'NEW_RULE: do not write protected.txt.' } },
    { name: 'write', arguments: { file_path: 'protected.txt', content: 'must not execute after the new instruction' } },
  ] }) })
  h.runner.submit(runtimeProposal(['write']))
  await assert.rejects(h.runner.runNext({ expectedRevision: 1 }), /DIRECT_RUNTIME_INSTRUCTION_CHANGED/)
  assert.equal(fs.readFileSync(path.join(h.projectRoot, 'AGENTS.md'), 'utf8'), 'NEW_RULE: do not write protected.txt.')
  assert.equal(fs.existsSync(path.join(h.projectRoot, 'protected.txt')), false)
  assert.equal(h.backend.requests.length, 1)
  assert.equal(h.runner.graph.read().reports.length, 0)
})
function unresolved(h, requests) {
  assert.equal(h.backend.requests.length, requests)
  const state = fixtureState(h.runner)
  assert.equal(state.reports.length, 0)
  assert.ok(state.graph.state.active)
}

test('direct runtime uses real native file tools with a genuine execution Agent and private HTTP history', async t => {
  let ordinal = 0
  const h = await fixture(t, { respond: () => [
    tool('write', { file_path: 'result.txt', content: 'first\n' }),
    tool('read', { file_path: 'result.txt' }),
    tool('edit', { file_path: 'result.txt', old_string: 'first', new_string: 'second' }),
    { text: 'Execution finished; acceptance remains unverified.' },
  ][ordinal++], config: { maxRequestsPerTask: 6 } })
  const counters = { prompt: 0, preStep: 0, model: 0 }
  h.ctx.systemPrompt.section({ name: 'poison', order: -1, complete: true,
    text: () => { counters.prompt++; throw new Error('Default prompt must not execute') } })
  h.ctx.on('agent/pre-step', () => { counters.preStep++; throw new Error('Native model loop must not execute') })
  h.ctx.on('llm/stream', async function* () { counters.model++; throw new Error('Public model API must not execute') })
  h.runner.submit(runtimeProposal(['write', 'read', 'edit']))
  const result = await h.runner.runNext({ expectedRevision: 1 })
  assert.equal(fs.readFileSync(path.join(h.projectRoot, 'result.txt'), 'utf8'), 'second\n')
  assert.equal(h.backend.requests.length, 4)
  assert.deepEqual(counters, { prompt: 0, preStep: 0, model: 0 })
  assert.equal(result.trace.executionHost.role, 'dynamic-leaf-worker')
  assert.equal(result.trace.executionEvents.filter(row => row.type === 'tool/result').length, 3)
  assert.equal(result.trace.executionEvents.findLast(row => row.type === 'turn/end').data.reason.kind, 'completed')
  for (const request of h.backend.requests) {
    assert.deepEqual(request.payload.tools.map(row => row.function.name).sort(), ['edit', 'read', 'write'])
    assert.doesNotMatch(JSON.stringify(request.payload), /UNRELATED_GLOBAL_CONTEXT_MUST_NOT_LEAK|PTC_ONLY/)
  }
  assert.equal(h.ctx.agents.get(result.report.sessionId), undefined)
})

test('real ripgrep and confined shell execute through direct function tools', async t => {
  let ordinal = 0
  const h = await fixture(t, { respond: () => ordinal++ === 0 ? { tools: [
    { name: 'glob', arguments: { pattern: '*.txt' } },
    { name: 'grep', arguments: { pattern: 'SEARCH_FIXTURE_TOKEN', path: 'input.txt' } },
    { name: 'bash', arguments: { description: 'Inspect isolated validation workspace', command: 'pwd', timeoutMs: 1000 } },
    { name: 'dynamic_task_status', arguments: {} },
  ] } : { text: 'Read and shell observations collected.' } })
  fs.writeFileSync(path.join(h.projectRoot, 'input.txt'), 'SEARCH_FIXTURE_TOKEN\n')
  h.runner.submit(runtimeProposal(['glob', 'grep', 'bash', 'dynamic_task_status']))
  const result = await h.runner.runNext({ expectedRevision: 1 })
  const outputs = h.backend.requests[1].payload.messages.filter(row => row.role === 'tool')
  assert.match(outputs[0].content, /input.txt/)
  assert.match(outputs[1].content, /SEARCH_FIXTURE_TOKEN/)
  assert.ok(outputs[2].content.includes(h.projectRoot))
  assert.equal(JSON.parse(outputs[2].content).execution.exitCode, 0)
  assert.equal(JSON.parse(outputs[2].content).execution.sandbox.mode, 'workspace-write')
  assert.match(outputs[3].content, /NOT_EVALUATED/)
  assert.equal(result.trace.executionHost.policy.sandboxMode, 'workspace-write')
})

for (const [name, runtime, requested, expected] of [
  ['read-only filesystem', { sandboxMode: 'read-only' }, tool('write', { file_path: 'blocked.txt', content: 'blocked' }), /denied|read.only/i],
  ['Plan mutation', { plan: true }, tool('write', { file_path: 'blocked.txt', content: 'blocked' }), /DIRECT_RUNTIME_PLAN_READ_ONLY/],
  ['Plan shell', { plan: true }, tool('bash', { command: 'pwd' }), /DIRECT_RUNTIME_PLAN_READ_ONLY/],
  ['permission escalation', {}, tool('write', { file_path: 'blocked.txt', content: 'blocked', sandbox_permissions: 'danger-full-access', justification: 'model request' }), /DIRECT_RUNTIME_ESCALATION_NOT_ALLOWED/],
  ['background shell', {}, tool('bash', { command: 'pwd', run_in_background: true }), /DIRECT_RUNTIME_UNMANAGED_SHELL/],
]) test(`runtime denies ${name} without effects and returns feedback for reconsideration`, async t => {
  const h = await fixture(t, { respond: ({ index, payload }) => index === 1 ? requested : { text: payload.messages.at(-1).content }, config: { direct: { runtime } } })
  h.runner.submit(runtimeProposal([requested.tools[0].name]))
  const result = await h.runner.runNext({ expectedRevision: 1 })
  assert.match(result.report.text, expected)
  assert.equal(h.backend.requests.length, 2)
  assert.equal(fs.existsSync(path.join(h.projectRoot, 'blocked.txt')), false)
})

test('a later malformed call in a batch prevents the earlier write', async t => {
  const h = await fixture(t, { respond: ({ index, payload }) => {
    if (index === 1) return { tools: [
      { name: 'write', arguments: { file_path: 'blocked.txt', content: 'must not execute' } },
      { name: 'read', arguments: { file_path: 42 } },
    ] }
    const rejected = JSON.parse(payload.messages.at(-1).content)
    assert.equal(rejected.execution, 'NOT_EXECUTED')
    assert.equal(rejected.diagnostic.code, 'DIRECT_TOOL_ARGUMENT_SCHEMA_MISMATCH')
    assert.match(rejected.diagnostic.issues[0].path, /tool_calls\/1\/function\/arguments/)
    assert.match(JSON.stringify(rejected.diagnostic), /file_path/)
    return { text: 'The rejected batch had no effects; no work claimed.' }
  } })
  h.runner.submit(runtimeProposal(['write', 'read']))
  await h.runner.runNext({ expectedRevision: 1 })
  assert.equal(h.backend.requests.length, 2)
  assert.equal(fs.existsSync(path.join(h.projectRoot, 'blocked.txt')), false)
})

test('root instructions and required skills are pinned explicitly without default prompt assembly', async t => {
  const h = await fixture(t, { respond: () => ({ text: 'Pinned instructions observed.' }),
    config: { direct: { runtime: { skills: ['fixture-skill'], requiredSkills: ['fixture-skill'], timeZone: 'Asia/Shanghai' } } } })
  fs.writeFileSync(path.join(h.projectRoot, 'AGENTS.md'), 'ROOT_INSTRUCTION_LITERAL_{{unchanged}}')
  h.runner.submit(runtimeProposal([]))
  const result = await h.runner.runNext({ expectedRevision: 1 })
  const facts = result.trace.executionHost
  assert.equal(facts.instructions[0].content, 'ROOT_INSTRUCTION_LITERAL_{{unchanged}}')
  assert.match(facts.requiredSkills[0].content, /SKILL_FIXTURE_BODY/)
  assert.equal(facts.time.timeZone, 'Asia/Shanghai')
  assert.equal(facts.instructions[0].sha256.length, 64)
  assert.match(h.backend.requests[0].payload.messages[0].content, /ROOT_INSTRUCTION_LITERAL_\{\{unchanged\}\}|SKILL_FIXTURE_BODY/)
  assert.deepEqual(h.backend.requests[0].payload.messages.map(row => row.role), ['system', 'user'])
})

test('skill loading exposes only the explicitly allowed catalog and body', async t => {
  const h = await fixture(t, { respond: ({ index }) => index === 1 ? tool('skill', { name: 'fixture-skill' }) : { text: 'Skill loaded.' },
    config: { direct: { runtime: { skills: ['fixture-skill'] } } },
    setup: ctx => ctx.skills.register({ name: 'other-skill', description: 'UNBOUND_SKILL_CATALOG', content: 'UNBOUND_SKILL_BODY', source: 'runtime' }) })
  h.runner.submit(runtimeProposal(['skill']))
  const result = await h.runner.runNext({ expectedRevision: 1 })
  assert.deepEqual(result.trace.executionHost.skills.map(row => row.name), ['fixture-skill'])
  assert.match(JSON.stringify(h.backend.requests[1].payload), /SKILL_FIXTURE_BODY/)
  assert.doesNotMatch(JSON.stringify(h.backend.requests), /UNBOUND_SKILL/)
})

test('directory instructions defer the whole tool batch before any effect and enter as owned tool observations', async t => {
  let h
  h = await fixture(t, { respond: ({ index, payload }) => {
    if (index === 2) {
      assert.equal(fs.existsSync(path.join(h.projectRoot, 'child/output.txt')), false)
      const results = payload.messages.filter(row => row.role === 'tool')
      assert.equal(results.length, 2)
      assert.ok(results.every(row => /DEFERRED_NOT_EXECUTED/.test(row.content)))
      assert.match(results[0].content, /CHILD_INSTRUCTION/)
    }
    return index < 3 ? { tools: [
      { name: 'write', arguments: { file_path: 'child/output.txt', content: 'after instruction delivery' } },
      { name: 'read', arguments: { file_path: 'input.txt' } },
    ] } : { text: 'Instructions loaded, then work executed.' }
  } })
  fs.mkdirSync(path.join(h.projectRoot, 'child'))
  fs.writeFileSync(path.join(h.projectRoot, 'child/AGENTS.md'), 'CHILD_INSTRUCTION: inspect evidence.')
  fs.writeFileSync(path.join(h.projectRoot, 'input.txt'), 'input')
  h.runner.submit(runtimeProposal(['write', 'read']))
  const result = await h.runner.runNext({ expectedRevision: 1 })
  assert.equal(fs.readFileSync(path.join(h.projectRoot, 'child/output.txt'), 'utf8'), 'after instruction delivery')
  assert.equal(result.trace.events.filter(row => row.type === 'tool/deferred').length, 2)
  assert.equal(result.trace.executionEvents.filter(row => row.type === 'tool/result' && row.data.message.isError).length, 2)
  assert.equal(h.backend.requests.at(-1).payload.messages.filter(row => row.role === 'user').length, 1)
})

test('instruction edits during a request stop tool execution', async t => {
  let h
  h = await fixture(t, { respond: () => {
    fs.writeFileSync(path.join(h.projectRoot, 'AGENTS.md'), 'changed instruction')
    return tool('write', { file_path: 'blocked.txt', content: 'must not write' })
  } })
  fs.writeFileSync(path.join(h.projectRoot, 'AGENTS.md'), 'initial instruction')
  h.runner.submit(runtimeProposal(['write']))
  await assert.rejects(h.runner.runNext({ expectedRevision: 1 }), /DIRECT_RUNTIME_INSTRUCTION_CHANGED/)
  unresolved(h, 1)
  assert.equal(fs.existsSync(path.join(h.projectRoot, 'blocked.txt')), false)
})

test('retired instruction quota does not reject a host-supplied project file', async t => {
  const content = 'recorded project rule '.repeat(3200)
  const h = await fixture(t, { respond: ({ payload }) => {
    assert.ok(payload.messages[0].content.includes(content))
    return { text: 'Project rules received.' }
  }, config: { direct: { runtime: { instructionMaxBytes: 256 } } } })
  fs.writeFileSync(path.join(h.projectRoot, 'AGENTS.md'), content)
  h.runner.submit(runtimeProposal([]))
  assert.equal((await h.runner.runNext({ expectedRevision: 1 })).report.text, 'Project rules received.')
})

test('native owner session restrictions cannot be widened by runtime configuration', async t => {
  const h = await fixture(t, { respond: ({ index, payload }) => index === 1 ? tool('write', { file_path: 'blocked.txt', content: 'must not write' }) : { text: payload.messages.at(-1).content } })
  const owner = await h.ctx.agents.create({ sessionId: 'fixture-owner', meta: { cwd: h.projectRoot },
    setup: (_ctx, agent) => setSandboxMode(agent.session, 'read-only') })
  t.after(() => owner.dispose())
  h.runner.submit(runtimeProposal(['write']))
  const result = await h.runner.runNext({ expectedRevision: 1, sourceAgent: owner.agent })
  assert.ok(result.trace.events.some(row => row.type === 'tool/result' && row.data.isError))
  assert.equal(h.backend.requests.length, 2)
  assert.match(h.backend.requests[0].payload.messages[0].content, /"sandboxMode":"read-only"/)
  assert.equal(fs.existsSync(path.join(h.projectRoot, 'blocked.txt')), false)
})

test('native repeat reminders become bounded tool observations without extra user messages', async t => {
  const h = await fixture(t, { respond: ({ index }) => index <= 3 ? tool('read', { file_path: 'input.txt' }) : { text: 'Stopped after repeated read.' },
    setup: ctx => ctx.plugin(RepeatReminder, { thresholds: [3], argumentsPreviewChars: 100 }) })
  fs.writeFileSync(path.join(h.projectRoot, 'input.txt'), 'repeat test')
  h.runner.submit(runtimeProposal(['read']))
  await h.runner.runNext({ expectedRevision: 1 })
  const messages = h.backend.requests.at(-1).payload.messages
  assert.equal(messages.filter(row => row.role === 'user').length, 1)
  assert.match(messages.at(-1).content, /repeat-tool-reminder|tool-observations-only/)
})

test('explicit registered tools support deferred MCP-style definitions without importing server prompts', async t => {
  const h = await fixture(t, { respond: ({ index }) => index === 1 ? tool('mcp_fixture_read', {}) : { text: 'Registered tool result observed.' },
    config: { allowedTools: ['mcp_fixture_read'], direct: { runtime: { registeredTools: ['mcp_fixture_read'], modules: [] } } },
    setup: ctx => {
      registered(ctx, 'mcp_fixture_read', async () => ({ value: 'MCP_FIXTURE_OBSERVATION' }), { deferLoading: true })
      ctx.systemPrompt.section({ name: 'mcp:fixture', order: 5, text: () => { throw new Error('Server instructions are not host policy') } })
    } })
  h.runner.submit(runtimeProposal(['mcp_fixture_read']))
  await h.runner.runNext({ expectedRevision: 1 })
  assert.match(JSON.stringify(h.backend.requests[1].payload), /MCP_FIXTURE_OBSERVATION/)
})

for (const [name, execute] of [
  ['native message submission', async (_args, exec) => { exec.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'unapproved followup' }], source: { kind: 'user' } })); return {} }],
  ['auxiliary model request', async (_args, _exec, ctx) => { for await (const _chunk of ctx.llm.stream({ provider: 'dynamic-context-fake', model: 'fake-llama', messages: [] })) {} return {} }],
  ['nested dispatch', async (_args, exec, ctx) => { await executeFixtureTool(ctx, { name: 'write', arguments: { file_path: 'blocked.txt', content: 'must not execute' }, callId: 'nested', agent: exec.agent, signal: exec.signal }); return {} }],
]) test(`registered adapter cannot escape through ${name}`, async t => {
  const h = await fixture(t, { respond: () => tool('adapter_probe', {}),
    config: { allowedTools: ['adapter_probe', 'write'], direct: { runtime: { registeredTools: ['adapter_probe'] } } },
    setup: ctx => registered(ctx, 'adapter_probe', (args, exec) => execute(args, exec, ctx)) })
  h.runner.submit(runtimeProposal(['adapter_probe', 'write']))
  await assert.rejects(h.runner.runNext({ expectedRevision: 1 }))
  unresolved(h, 1)
  assert.equal(fs.existsSync(path.join(h.projectRoot, 'blocked.txt')), false)
})

test('native web tools use an explicit provider and keep results in the task history', async t => {
  const h = await fixture(t, { respond: ({ index }) => index === 1 ? { tools: [
    { name: 'web_search', arguments: { queries: ['isolated fixture'] } },
    { name: 'web_fetch', arguments: { url: 'https://fixture.invalid/page' } },
  ] } : { text: 'Source observations received.' },
    config: { allowedTools: ['web_search', 'web_fetch'], direct: { runtime: { modules: ['web'] } } },
    setup: async ctx => {
      await ctx.plugin(WebRuntime)
      ctx.web.registerSearchProvider({ id: 'fixture-search', available: () => true,
        search: async () => ({ sources: [{ url: 'https://fixture.invalid/page', title: 'Fixture', snippet: 'SEARCH_PROVIDER_FIXTURE' }], truncated: false }) })
      ctx.web.registerFetchProvider({ id: 'fixture-fetch', available: () => true,
        fetch: async ({ url }) => ({ url, statusCode: 200, body: { kind: 'text', content: 'FETCH_PROVIDER_FIXTURE' }, truncated: false }) })
    } })
  h.runner.submit(runtimeProposal(['web_search', 'web_fetch']))
  await h.runner.runNext({ expectedRevision: 1 })
  assert.match(JSON.stringify(h.backend.requests[1].payload), /SEARCH_PROVIDER_FIXTURE/)
  assert.match(JSON.stringify(h.backend.requests[1].payload), /FETCH_PROVIDER_FIXTURE/)
})

test('a disabled conditional tool rejects the fixed direct contract before sending HTTP', async t => {
  const h = await fixture(t, {
    respond: () => ({ text: 'The model must not be called.' }),
    config: { allowedTools: ['web_search'], direct: { runtime: { modules: ['web'] } } },
    setup: async ctx => {
      await ctx.plugin(WebRuntime)
      ctx.web.registerSearchProvider({ id: 'unready-fixture', available: () => true,
        ready: () => false, search: () => { throw new Error('unready provider must not run') } })
    },
  })
  h.runner.submit(runtimeProposal(['web_search']))
  await assert.rejects(h.runner.runNext({ expectedRevision: 1 }), /TASK_TOOL_NOT_AVAILABLE/)
  unresolved(h, 0)
})

test('direct filesystem observations leave ordinary native writes under the deployment policy', async t => {
  const FsTools = await import('@deepseek-ai/dsh-tool-fs')
  let h, owner
  h = await fixture(t, {
    respond: async ({ index }) => {
      if (index !== 1) return { text: 'Direct read recorded.' }
      const ordinary = await executeFixtureTool(h.ctx, { agent: owner.agent, name: 'write',
        callId: 'ordinary-overwrite', arguments: { file_path: 'ordinary.txt', content: 'new' },
        signal: new AbortController().signal })
      assert.equal(ordinary.isError, false)
      return tool('read', { file_path: 'ordinary.txt' })
    },
    setup: ctx => ctx.plugin(FsTools, { readImage: false }),
  })
  owner = await h.ctx.agents.create({ sessionId: 'ordinary-filesystem', meta: { cwd: h.projectRoot } })
  t.after(() => owner.dispose())
  fs.writeFileSync(path.join(h.projectRoot, 'ordinary.txt'), 'old')
  h.runner.submit(runtimeProposal(['read']))
  await h.runner.runNext({ expectedRevision: 1 })
  assert.equal(fs.readFileSync(path.join(h.projectRoot, 'ordinary.txt'), 'utf8'), 'new')
})

for (const decision of ['allowed-once', 'rejected', 'unavailable']) test(`native approval ${decision} is audited inside the direct execution turn`, async t => {
  let effects = 0, prompts = 0
  const h = await fixture(t, { respond: ({ index }) => index === 1 ? tool('gated_fixture', {}) : { text: 'Approval-gated result observed.' },
    approval: 'ask', config: { allowedTools: ['gated_fixture'], direct: { runtime: { modules: [], approvalPolicy: 'ask', registeredTools: ['gated_fixture'] } } },
    setup: ctx => {
      registered(ctx, 'gated_fixture', async () => { effects++; return { completed: true } })
      ctx.on('tools/pre-execute', (exec, next) => exec.name === 'gated_fixture' ? { kind: 'ask', reason: 'Controlled native approval fixture' } : next())
      ctx.on('approval/request', request => { prompts++; assert.equal(ctx.agents.get(request.agent.id), request.agent); return decision })
    } })
  h.runner.submit(runtimeProposal(['gated_fixture']))
  const result = await h.runner.runNext({ expectedRevision: 1 })
  if (decision === 'allowed-once') {
    assert.equal(result.trace.executionEvents.filter(row => row.type === 'approval/asked').length, 1)
    assert.equal(result.trace.executionEvents.find(row => row.type === 'approval/decided').data.outcome, decision)
    assert.equal(effects, 1)
  } else {
    assert.ok(result.trace.events.some(row => row.type === 'tool/result' && row.data.isError))
    assert.equal(effects, 0)
    assert.equal(h.backend.requests.length, 2)
  }
  assert.equal(prompts, 1)
})

test('never approval policy rejects a native ask without contacting an answerer', async t => {
  let prompts = 0, effects = 0
  const h = await fixture(t, { respond: ({ index }) => index === 1 ? tool('gated_fixture', {}) : { text: 'Denied by native approval policy.' },
    config: { allowedTools: ['gated_fixture'], direct: { runtime: { modules: [], registeredTools: ['gated_fixture'] } } },
    setup: ctx => {
      registered(ctx, 'gated_fixture', async () => { effects++; return {} })
      ctx.on('tools/pre-execute', () => ({ kind: 'ask', reason: 'Controlled native approval fixture' }))
      ctx.on('approval/request', () => { prompts++; return 'allowed-once' })
    } })
  h.runner.submit(runtimeProposal(['gated_fixture']))
  const result = await h.runner.runNext({ expectedRevision: 1 })
  assert.ok(result.trace.events.some(row => row.type === 'tool/result' && row.data.isError))
  assert.equal(prompts, 0)
  assert.equal(effects, 0)
  assert.equal(h.backend.requests.length, 2)
})

test('new root instructions appearing during a report stop acceptance', async t => {
  let h
  h = await fixture(t, { respond: () => {
    fs.writeFileSync(path.join(h.projectRoot, 'AGENTS.md'), 'new mandatory instructions')
    return { text: 'Must not commit under unseen instructions.' }
  } })
  h.runner.submit(runtimeProposal([]))
  await assert.rejects(h.runner.runNext({ expectedRevision: 1 }), /DIRECT_RUNTIME_INSTRUCTION_CHANGED/)
  unresolved(h, 1)
})

test('an outside symlink write is rejected without effects and can be corrected in the next request', async t => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-runtime-outside-'))
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }))
  const h = await fixture(t, { respond: ({ index, payload }) => {
    if (index === 1) return tool('write', { file_path: 'escape/blocked.txt', content: 'blocked' })
    if (index === 2) {
      const feedback = JSON.parse(payload.messages.at(-1).content)
      assert.equal(feedback.execution, 'DEFERRED_NOT_EXECUTED')
      assert.equal(feedback.code, 'DIRECT_RUNTIME_PATH_OUTSIDE_WORKSPACE')
      assert.equal(feedback.rejectedCall.requestedPath, 'escape/blocked.txt')
      return tool('write', { file_path: 'corrected.txt', content: 'allowed' })
    }
    return { text: 'Corrected the rejected path and wrote the workspace file.' }
  } })
  fs.symlinkSync(outside, path.join(h.projectRoot, 'escape'))
  h.runner.submit(runtimeProposal(['write']))
  const result = await h.runner.runNext({ expectedRevision: 1 })
  assert.equal(fs.existsSync(path.join(outside, 'blocked.txt')), false)
  assert.equal(fs.readFileSync(path.join(h.projectRoot, 'corrected.txt'), 'utf8'), 'allowed')
  assert.equal(result.trace.events.filter(row => row.type === 'tool/deferred').length, 1)
  assert.equal(result.trace.events.filter(row => row.type === 'tool/result').length, 1)
  assert.equal(h.backend.requests.length, 3)
})

for (const name of ['read', 'write', 'edit', 'glob', 'grep']) test(`${name} outside the workspace returns a no-effect error and defers the whole batch`, async t => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-runtime-outside-'))
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }))
  const target = path.join(outside, 'report.json'), sentinel = 'OUTSIDE_REPORT_MUST_NOT_ENTER_CONTEXT'
  fs.writeFileSync(target, sentinel)
  const args = { read: { file_path: target }, write: { file_path: target, content: 'bad overwrite' },
    edit: { file_path: target, old_string: sentinel, new_string: 'bad edit' },
    glob: { pattern: '*', path: outside }, grep: { pattern: 'REPORT', path: outside } }[name]
  let h, executions = 0
  h = await fixture(t, { respond: ({ index, payload }) => {
    if (index === 1) return { tools: [
      { name: 'write', arguments: { file_path: 'deferred.txt', content: 'must wait' } },
      { name, arguments: args },
    ] }
    assert.equal(executions, 0)
    assert.equal(fs.existsSync(path.join(h.projectRoot, 'deferred.txt')), false)
    const results = payload.messages.filter(row => row.role === 'tool')
    assert.equal(results.length, 2)
    for (const row of results) {
      const feedback = JSON.parse(row.content)
      assert.equal(feedback.code, 'DIRECT_RUNTIME_PATH_OUTSIDE_WORKSPACE')
      assert.equal(feedback.affectedCallIds.length, 2)
      assert.equal(feedback.rejectedCall.tool, name)
    }
    if (name !== 'edit') assert.doesNotMatch(JSON.stringify(results), new RegExp(sentinel))
    return { text: 'Rejected tool calls had no effects; no outside evidence was read.' }
  }, setup: ctx => ctx.on('tools/execute', (exec, next) => { executions++; return next() }) })
  h.runner.submit(runtimeProposal([...new Set([name, 'write'])]))
  const result = await h.runner.runNext({ expectedRevision: 1 })
  assert.equal(fs.readFileSync(target, 'utf8'), sentinel)
  assert.equal(result.trace.events.filter(row => row.type === 'tool/deferred').length, 2)
  assert.equal(result.trace.events.filter(row => row.type === 'tool/result').length, 0)
})

test('a path changed by an earlier tool defers only the unexecuted suffix without replay', async t => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-runtime-outside-'))
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }))
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'OUTSIDE_SECRET_NOT_READ')
  let h, moves = 0
  h = await fixture(t, { config: { allowedTools: ['move_fixture', 'read', 'write'],
    direct: { runtime: { modules: ['filesystem', 'state'], registeredTools: ['move_fixture'] } } },
    setup: ctx => registered(ctx, 'move_fixture', async () => {
      moves++
      fs.rmSync(path.join(h.projectRoot, 'alias'), { recursive: true })
      fs.symlinkSync(outside, path.join(h.projectRoot, 'alias'))
      return { moved: true }
    }), respond: ({ index, payload }) => {
      if (index === 1) return { tools: [
        { name: 'move_fixture', arguments: {} },
        { name: 'read', arguments: { file_path: 'alias/secret.txt' } },
        { name: 'write', arguments: { file_path: 'must-not-execute.txt', content: 'bad' } },
      ] }
      const results = payload.messages.filter(row => row.role === 'tool')
      assert.equal(results.length, 3)
      assert.match(results[0].content, /moved/)
      const feedback = JSON.parse(results[1].content)
      assert.deepEqual(feedback.affectedCallIds, results.slice(1).map(row => row.tool_call_id))
      assert.doesNotMatch(JSON.stringify(results), /OUTSIDE_SECRET_NOT_READ/)
      return { text: 'Earlier effect observed once; remaining calls were not executed.' }
    } })
  fs.mkdirSync(path.join(h.projectRoot, 'alias'))
  h.runner.submit(runtimeProposal(['move_fixture', 'read', 'write']))
  await h.runner.runNext({ expectedRevision: 1 })
  assert.equal(moves, 1)
  assert.equal(fs.existsSync(path.join(h.projectRoot, 'must-not-execute.txt')), false)
})

test('read-only Plan allows real file reads', async t => {
  const h = await fixture(t, { respond: ({ index }) => index === 1 ? tool('read', { file_path: 'input.txt' }) : { text: 'Read-only result observed.' },
    config: { direct: { runtime: { plan: true } } } })
  fs.writeFileSync(path.join(h.projectRoot, 'input.txt'), 'PLAN_READ_FIXTURE')
  h.runner.submit(runtimeProposal(['read']))
  await h.runner.runNext({ expectedRevision: 1 })
  assert.match(JSON.stringify(h.backend.requests[1].payload), /PLAN_READ_FIXTURE/)
})

test('controller tools atomically submit, inspect and execute the direct workflow', async t => {
  const h = await fixture(t, { config: { exposeControlTools: true },
    respond: ({ index }) => index === 1 ? tool('read', { file_path: 'input.txt' }) : { text: 'Controller report; acceptance unverified.' } })
  fs.writeFileSync(path.join(h.projectRoot, 'input.txt'), 'CONTROLLER_FIXTURE')
  const owner = await h.ctx.agents.create({ sessionId: 'controller-owner', meta: { cwd: h.projectRoot } })
  t.after(() => owner.dispose())
  const invoke = (name, args, callId) => executeFixtureTool(h.ctx, { agent: owner.agent, name, arguments: args, callId, signal: new AbortController().signal })
  const submitted = await invoke('dynamic_context_submit', { proposal: runtimeProposal(['read']) }, 'controller-submit')
  assert.equal(Boolean(submitted.isError), false)
  assert.equal(submitted.value.revision, 1)
  const status = await invoke('dynamic_context_status', {}, 'controller-status')
  assert.equal(status.value.revision, 1)
  const executed = await invoke('dynamic_context_run_next', { expectedRevision: 1 }, 'controller-run')
  assert.equal(Boolean(executed.isError), false)
  assert.equal(executed.value.report.acceptance, 'UNVERIFIED_MODEL_REPORT')
  assert.equal(executed.value.revision, 3)
  assert.equal(h.backend.requests.length, 2)
})

test('controller tools reject a different workspace before graph submission', async t => {
  const h = await fixture(t, { config: { exposeControlTools: true }, respond: () => ({ text: 'must not run' }) })
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-controller-outside-'))
  t.after(() => fs.rmSync(other, { recursive: true, force: true }))
  const owner = await h.ctx.agents.create({ sessionId: 'outside-controller', meta: { cwd: other } })
  t.after(() => owner.dispose())
  const result = await executeFixtureTool(h.ctx, { agent: owner.agent, name: 'dynamic_context_submit',
    arguments: { proposal: runtimeProposal([]) }, callId: 'outside-submit', signal: new AbortController().signal })
  assert.equal(result.isError, true)
  assert.equal(h.runner.graph.read(), null)
  assert.equal(h.backend.requests.length, 0)
})

test('an execution worker cannot become a workflow controller through a registered tool', async t => {
  const h = await fixture(t, { respond: ({ index, payload }) => index === 1 ? tool('dynamic_context_status', {}) : { text: payload.messages.at(-1).content },
    config: { exposeControlTools: true, allowedTools: ['dynamic_context_status'],
      direct: { runtime: { modules: [], registeredTools: ['dynamic_context_status'] } } } })
  h.runner.submit(runtimeProposal(['dynamic_context_status']))
  const result = await h.runner.runNext({ expectedRevision: 1 })
  assert.ok(!h.backend.requests[0].payload.tools?.some(row => row.function.name === 'dynamic_context_status'))
  assert.ok(result.trace.events.some(row => row.type === 'task/validation-rejected' && row.data.diagnostic.code === 'ROLE_TOOL_DENIED'))
  assert.ok(!result.trace.events.some(row => row.type === 'tool/call'))
  assert.equal(h.backend.requests.length, 2)
})

test('runtime task switches inherit only declared reports, not prior file output or private context', async t => {
  const h = await fixture(t, { respond: ({ payload }) => {
    const text = JSON.stringify(payload.messages)
    const taskB = text.includes('B_PRIVATE_CONTEXT')
    if (payload.messages.some(row => row.role === 'tool')) return { text: taskB ? 'B_REPORT' : 'A_DECLARED_REPORT' }
    return tool('read', { file_path: taskB ? 'b.txt' : 'a.txt' })
  } })
  fs.writeFileSync(path.join(h.projectRoot, 'a.txt'), 'A_RAW_TOOL_OUTPUT')
  fs.writeFileSync(path.join(h.projectRoot, 'b.txt'), 'B_RAW_TOOL_OUTPUT')
  const proposal = { taskGraph: { title: 'Runtime isolation', nodes: [
    { key: 'root', kind: 'container', label: 'Root' },
    { key: 'a', kind: 'leaf', label: 'A', parent: 'root' }, { key: 'b', kind: 'leaf', label: 'B', parent: 'root' },
  ], edges: [{ kind: 'prerequisite', from: 'a', to: 'b' }] }, contextGraph: {
    nodes: [{ key: 'a', content: 'A_PRIVATE_CONTEXT', parents: [] }, { key: 'b', content: 'B_PRIVATE_CONTEXT', parents: [] }],
    bindings: [{ task: 'a', instruction: 'Read A and report.', contexts: ['a'], tools: ['read'], inheritReports: [] },
      { task: 'b', instruction: 'Read B and report.', contexts: ['b'], tools: ['read'], inheritReports: ['a'] }],
  } }
  h.runner.submit(proposal)
  const first = await h.runner.runNext({ expectedRevision: 1 })
  const second = await h.runner.runNext({ expectedRevision: 3 })
  assert.notEqual(first.report.sessionId, second.report.sessionId)
  for (const request of h.backend.requests.slice(2)) {
    assert.match(JSON.stringify(request.payload), /A_DECLARED_REPORT|B_PRIVATE_CONTEXT/)
    assert.doesNotMatch(JSON.stringify(request.payload), /A_RAW_TOOL_OUTPUT|A_PRIVATE_CONTEXT/)
  }
})

test('closing the runner cancels and drains a real native tool before removing its execution identity', async t => {
  let started, drained = false
  const entered = new Promise(resolve => { started = resolve })
  const h = await fixture(t, { respond: () => tool('wait_fixture', {}),
    config: { allowedTools: ['wait_fixture'], direct: { runtime: { modules: [], registeredTools: ['wait_fixture'] } } },
    setup: ctx => registered(ctx, 'wait_fixture', async (_args, exec) => {
      started()
      await new Promise(resolve => exec.signal.addEventListener('abort', () => setTimeout(resolve, 30), { once: true }))
      drained = true
      return { drained: true }
    }) })
  h.runner.submit(runtimeProposal(['wait_fixture']))
  const running = h.runner.runNext({ expectedRevision: 1 })
  const rejected = assert.rejects(running)
  await entered
  await h.runner.close()
  await rejected
  assert.equal(drained, true)
  assert.equal(h.runner.busy, false)
  unresolved(h, 1)
})

test('live source policy changes reject the mutation and let the model continue', async t => {
  let owner
  const h = await fixture(t, { respond: ({ index, payload }) => {
    if (index > 1) return { text: JSON.stringify(payload.messages.slice(-2)) }
    setSandboxMode(owner.agent.session, 'read-only')
    return tool('write', { file_path: 'blocked.txt', content: 'must not write' })
  } })
  owner = await h.ctx.agents.create({ sessionId: 'policy-owner', meta: { cwd: h.projectRoot } })
  t.after(() => owner.dispose())
  h.runner.submit(runtimeProposal(['write']))
  const result = await h.runner.runNext({ expectedRevision: 1, sourceAgent: owner.agent })
  assert.match(result.report.text, /read.only|denied/i)
  assert.match(result.report.text, /direct-host-permissions-v1/)
  assert.equal(h.backend.requests.length, 2)
  assert.equal(fs.existsSync(path.join(h.projectRoot, 'blocked.txt')), false)
})

test('new parent instructions stop the direct leaf before its pending tool mutation', async t => {
  let owner
  const h = await fixture(t, { respond: () => {
    owner.agent.session.append('user/message', createUserMessage({ source: { kind: 'user' },
      content: [{ type: 'text', text: 'New current restriction: stop writing.' }] }), { surfaceOp: 'append' })
    return tool('write', { file_path: 'blocked.txt', content: 'must not write' })
  } })
  owner = await h.ctx.agents.create({ sessionId: 'instruction-owner', meta: { cwd: h.projectRoot } })
  t.after(() => owner.dispose())
  h.runner.submit(runtimeProposal(['write']))
  await assert.rejects(h.runner.runNext({ expectedRevision: 1, sourceAgent: owner.agent }), /DIRECT_RUNTIME_POLICY_CHANGED/)
  unresolved(h, 1)
  assert.equal(fs.existsSync(path.join(h.projectRoot, 'blocked.txt')), false)
})

test('host sampling parameters are pinned in every actual direct request', async t => {
  const generation = { temperature: 0.6, top_k: 20, top_p: 0.95, min_p: 0, repeat_penalty: 1, repeat_last_n: 64, seed: 7 }
  const h = await fixture(t, { respond: ({ index }) => index === 1 ? tool('read', { file_path: 'input.txt' }) : { text: 'Sampling contract preserved.' },
    config: { direct: { generation } } })
  fs.writeFileSync(path.join(h.projectRoot, 'input.txt'), 'sampling fixture')
  h.runner.submit(runtimeProposal(['read']))
  await h.runner.runNext({ expectedRevision: 1 })
  for (const request of h.backend.requests) for (const [key, value] of Object.entries(generation)) assert.equal(request.payload[key], value)
})

test('direct native executor overrides an ambient PTC executor for its worker only', async t => {
  const h = await fixture(t, { respond: ({ index }) => index === 1 ? tool('read', { file_path: 'input.txt' }) : { text: 'Native tool result observed.' },
    executor: { inject: ['tools', 'systemPrompt'], apply(ctx) { ctx.tools.setExecutor(new PtcExecutor(ctx)) } } })
  const rootCall = () => executeFixtureTool(h.ctx, { name: 'fixture_read_a', arguments: {}, callId: 'ptc-root',
    signal: new AbortController().signal })
  assert.equal((await rootCall()).isError, true)
  fs.writeFileSync(path.join(h.projectRoot, 'input.txt'), 'NATIVE_PRESENTATION_FIXTURE')
  h.runner.submit(runtimeProposal(['read']))
  await h.runner.runNext({ expectedRevision: 1 })
  assert.deepEqual(h.backend.requests[0].payload.tools.map(row => row.function.name), ['read'])
  assert.match(JSON.stringify(h.backend.requests[1].payload), /NATIVE_PRESENTATION_FIXTURE/)
  assert.doesNotMatch(h.backend.requests[0].payload.messages[0].content, /run_code.*only tool/)
  assert.equal((await rootCall()).isError, true)
})

test('real shell confinement prevents a write outside its execution workspace', async t => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-shell-outside-'))
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }))
  const target = path.join(outside, 'blocked.txt')
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
  const h = await fixture(t, { respond: ({ index }) => index === 1
    ? tool('bash', { command: `printf controlled-fixture > ${quote(target)}`, timeoutMs: 1000 })
    : { text: 'Observed the shell denial; no success claim.' } })
  h.runner.submit(runtimeProposal(['bash']))
  const { trace } = await h.runner.runNext({ expectedRevision: 1 })
  assert.equal(h.backend.requests.length, 2)
  const observation = trace.events.find(row => row.type === 'tool/result')
  assert.ok(observation)
  assert.equal(observation.data.value.sandbox.mode, 'workspace-write')
  assert.ok(observation.data.value.sandbox.enforcement)
  assert.notEqual(observation.data.value.exitCode, 0)
  assert.equal(fs.existsSync(target), false)
})

test('the private graph ledger cannot be overwritten through the migrated shell', async t => {
  let h, committedBytes
  const ledger = runner => runner.storage ? runner.storage.db.read('graph/state')
    : readStored(path.join(runner.config.directory, 'dynamic-context.json'))
  h = await fixture(t, { config: { direct: { durable: true } }, respond: () => {
    const file = path.join(h.runner.config.directory, 'dynamic-context.json')
    committedBytes = ledger(h.runner)
    return tool('bash', { command: `printf forged-ledger > '${file.replaceAll("'", "'\\''")}'`, timeoutMs: 1000 })
  } })
  h.runner.submit(runtimeProposal(['bash']))
  const result = await h.runner.runNext({ expectedRevision: 1, pauseAfterRequests: 1 })
  assert.equal(result.paused, true)
  assert.deepEqual(ledger(h.runner), committedBytes)
  unresolved(h, 1)
})

test('runtime refuses a state directory inside the tool workspace before HTTP', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-runtime-unsafe-state-')))
  const h = await createRuntimeHarness({ projectRoot: root, directory: path.join(root, 'state'), respond: () => ({ text: 'must not run' }) })
  t.after(async () => { await h.close(); fs.rmSync(root, { recursive: true, force: true }) })
  h.runner.submit(runtimeProposal([]))
  await assert.rejects(h.runner.runNext({ expectedRevision: 1 }), /DIRECT_RUNTIME_STATE_INSIDE_WORKSPACE/)
  unresolved(h, 0)
})

test('an owner policy update cancels and drains a running native tool', async t => {
  let started, drained = false
  const entered = new Promise(resolve => { started = resolve })
  const h = await fixture(t, { respond: ({ index, payload }) => index === 1 ? tool('wait_fixture', {}) : { text: JSON.stringify(payload.messages.slice(-2)) },
    config: { allowedTools: ['wait_fixture'], direct: { runtime: { modules: [], registeredTools: ['wait_fixture'] } } },
    setup: ctx => registered(ctx, 'wait_fixture', async (_args, exec) => {
      started()
      await new Promise(resolve => exec.signal.addEventListener('abort', resolve, { once: true }))
      drained = true
      return { drained: true }
    }) })
  const owner = await h.ctx.agents.create({ sessionId: 'running-owner', meta: { cwd: h.projectRoot } })
  t.after(() => owner.dispose())
  h.runner.submit(runtimeProposal(['wait_fixture']))
  const running = h.runner.runNext({ expectedRevision: 1, sourceAgent: owner.agent })
  await entered
  setSandboxMode(owner.agent.session, 'read-only')
  const result = await running
  assert.equal(drained, true)
  assert.match(result.report.text, /DIRECT_TOOL_PERMISSION_REVOKED/)
  assert.match(result.report.text, /POSSIBLE_PARTIAL_EFFECTS/)
  assert.equal(h.backend.requests.length, 2)
})

test('a partial shell backend is refused before the first model request', async t => {
  const h = await fixture(t, { respond: () => tool('bash', { command: 'pwd' }) })
  h.ctx.sandbox.confine = async () => ({ argv: ['true'], enforcement: 'partial' })
  h.runner.submit(runtimeProposal(['bash']))
  await assert.rejects(h.runner.runNext({ expectedRevision: 1 }), /DIRECT_RUNTIME_FULL_SHELL_CONFINEMENT_REQUIRED/)
  unresolved(h, 0)
})

test('only a Goal reference is inherited; unbound objective and criteria stay out of worker requests', async t => {
  const h = await fixture(t, { respond: ({ index }) => index === 1 ? tool('dynamic_task_status', {}) : { text: 'Task state observed.' },
    setup: ctx => ctx.provide('goals', { get: () => ({ id: 'fixture-goal', revision: 7, phase: 'active',
      objective: 'UNBOUND_GOAL_OBJECTIVE_PRIVATE', criteria: ['UNBOUND_GOAL_CRITERIA_PRIVATE'] }) }) })
  const owner = await h.ctx.agents.create({ sessionId: 'goal-reference-owner', meta: { cwd: h.projectRoot } })
  t.after(() => owner.dispose())
  h.runner.submit(runtimeProposal(['dynamic_task_status']))
  const result = await h.runner.runNext({ expectedRevision: 1, sourceAgent: owner.agent })
  assert.deepEqual(result.trace.executionHost.ownerGoal, { id: 'fixture-goal', revision: 7, phase: 'active' })
  assert.doesNotMatch(JSON.stringify(h.backend.requests), /UNBOUND_GOAL/)
})

test('explicit host instruction homes retain global rules alongside project rules', async t => {
  const storageRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-instruction-homes-')))
  const projectRoot = path.join(storageRoot, 'workspace'), dshHome = path.join(storageRoot, 'host-dsh'), agentsHome = path.join(storageRoot, 'host-agents')
  for (const directory of [projectRoot, dshHome, agentsHome]) fs.mkdirSync(directory)
  fs.writeFileSync(path.join(dshHome, 'AGENTS.md'), 'HOST_GLOBAL_DSH_RULE')
  fs.writeFileSync(path.join(agentsHome, 'AGENTS.md'), 'HOST_GLOBAL_AGENTS_RULE')
  fs.writeFileSync(path.join(projectRoot, 'AGENTS.md'), 'LOCAL_PROJECT_RULE')
  const h = await createRuntimeHarness({ projectRoot, directory: path.join(storageRoot, 'state'),
    respond: () => ({ text: 'Global and project instructions delivered.' }),
    config: { storageRoot, direct: { runtime: { modules: [], instructionHomes: { dshHome, agentsHome } } } } })
  t.after(async () => { await h.close(); fs.rmSync(storageRoot, { recursive: true, force: true }) })
  h.runner.submit(runtimeProposal([]))
  const result = await h.runner.runNext({ expectedRevision: 1 })
  assert.deepEqual(result.trace.executionHost.instructions.map(row => row.content), ['HOST_GLOBAL_DSH_RULE', 'HOST_GLOBAL_AGENTS_RULE', 'LOCAL_PROJECT_RULE'])
  assert.match(h.backend.requests[0].payload.messages[0].content, /HOST_GLOBAL_DSH_RULE/)
})

test('reserved final request closes with a report after tool work without creating another effect', async t => {
  const h = await fixture(t, { config: { maxRequestsPerTask: 2, direct: { reserveFinalReport: true } },
    respond: ({ index, payload }) => index === 1 ? tool('write', { file_path: 'done.txt', content: 'completed effect' })
      : { text: payload.tool_choice === 'none' ? 'One effect completed. Further verification remains incomplete.' : 'Unexpected request policy.' } })
  h.runner.submit(runtimeProposal(['write']))
  const result = await h.runner.runNext({ expectedRevision: 1 })
  assert.equal(h.backend.requests.length, 2)
  assert.equal(h.backend.requests[0].payload.tool_choice, undefined)
  assert.equal(h.backend.requests[1].payload.tool_choice, 'none')
  assert.equal(fs.readFileSync(path.join(h.projectRoot, 'done.txt'), 'utf8'), 'completed effect')
  assert.match(result.report.text, /remains incomplete/)
  assert.equal(result.report.acceptance, 'UNVERIFIED_MODEL_REPORT')
  assert.equal(h.runner.graph.status().goalReached, false)
})

test('a backend ignoring report-only policy cannot execute its proposed tool effect', async t => {
  const h = await fixture(t, { config: { maxRequestsPerTask: 1, direct: { reserveFinalReport: true } },
    respond: () => tool('write', { file_path: 'forbidden.txt', content: 'must not execute' }) })
  h.runner.submit(runtimeProposal(['write']))
  await assert.rejects(h.runner.runNext({ expectedRevision: 1 }), /DIRECT_REPORT_ONLY_TOOL_CALL_FORBIDDEN/)
  assert.equal(fs.existsSync(path.join(h.projectRoot, 'forbidden.txt')), false)
  assert.equal(h.backend.requests.length, 1)
})

test('no-compression tasks omit unavailable archive instructions and retain honest durable-state guidance', async t => {
  const h = await fixture(t, { respond: () => ({ text: 'Task reviewed.' }) })
  h.runner.submit(runtimeProposal([]))
  await h.runner.runNext({ expectedRevision: 1 })
  const prompt = h.backend.requests[0].payload.messages[0].content
  assert.match(prompt, /requirements-to-evidence checklist/)
  assert.match(prompt, /history compaction and archive source reading are disabled/)
  assert.doesNotMatch(prompt, /use dynamic_context_source_read|sourceRead\.head/)
})

test('an explicitly enlarged character budget can carry a long contract with exact task boundaries', async t => {
  const h = await fixture(t, { config: { maxContextCharacters: 1048576, dynamicContextMaxBytes: 1048576 }, respond: () => ({ text: 'Long task data reviewed; no acceptance inferred.' }) })
  const proposal = runtimeProposal([])
  proposal.contextGraph.nodes = Array.from({ length: 4 }, (_, i) => ({ key: 'block_' + i, content: `contract block ${i}: ` + 'x'.repeat(80000), parents: [] }))
  proposal.contextGraph.bindings[0].contexts = proposal.contextGraph.nodes.map(n => n.key)
  h.runner.submit(proposal)
  const result = await h.runner.runNext({ expectedRevision: 1 })
  assert.ok(h.backend.requests[0].rawBody.length > 256000)
  assert.equal(result.trace.requests[0].validation, 'PASS')
  assert.equal(result.trace.assembly.contexts.length, 4)
})

test('native stale-version rejection preserves external bytes until a fresh read and new edit', async t => {
  let file
  const h = await fixture(t, { config: { maxRequestsPerTask: 6 }, respond: ({ index }) => {
    if (index === 1 || index === 3) return tool('read', { file_path: 'existing.txt' })
    if (index === 2) {
      fs.writeFileSync(file, 'external update')
      return tool('edit', { file_path: 'existing.txt', old_string: 'original', new_string: 'wrong overwrite' })
    }
    if (index === 4) {
      assert.equal(fs.readFileSync(file, 'utf8'), 'external update')
      return tool('edit', { file_path: 'existing.txt', old_string: 'external update', new_string: 'intentional update' })
    }
    return { text: 'Updated using a fresh observation; external change was preserved until then.' }
  } })
  file = path.join(h.projectRoot, 'existing.txt'); fs.writeFileSync(file, 'original')
  h.runner.submit(runtimeProposal(['read', 'edit']))
  const result = await h.runner.runNext({ expectedRevision: 1 })
  assert.equal(fs.readFileSync(file, 'utf8'), 'intentional update')
  const rejected = result.trace.events.filter(e => e.type === 'tool/observation-required')
  assert.equal(rejected.length, 1)
  assert.equal(rejected[0].data.code, 'FS_STALE_VERSION')
  assert.equal(rejected[0].data.effects, 'NOT_EXECUTED')
})

test('a large uncompressed tool batch crosses 1 MiB without changing source roles or losing tool pairing', async t => {
  const backend = await startFakeLlama({ maxRequestBytes: 8 * 1024 * 1024, respond: ({ index }) => index === 1
    ? { tools: Array.from({ length: 8 }, (_, part) => ({ name: 'archive_fixture', arguments: { part } })) }
    : index < 18 ? { tools: [{ name: 'dynamic_task_status', arguments: {} }] }
      : { text: 'All eight immutable source parts are present. This is transport evidence only.' } })
  t.after(() => backend.close())
  const h = await fixture(t, { backend, config: { allowedTools: ['archive_fixture', 'dynamic_task_status'], timeoutMs: 120000, maxRequestsPerTask: 20, maxContextCharacters: 8388608, direct: { durable: true, maxRequestBytes: 8388608,
    maxJournalBytes: 536870912, runtime: { modules: ['state'], registeredTools: ['archive_fixture'], maxToolOutputCharacters: 256000 } } },
    setup: ctx => ctx.tools.register(defineTool({ name: 'archive_fixture', description: 'Immutable isolated source chunk',
      parameters: { part: { type: 'integer', required: true } },
      output: { schema: { type: 'object', properties: { text: { type: 'string' } }, additionalProperties: false }, render: (_args, value) => [{ type: 'text', text: value.text }] },
      execute: async ({ part }) => ({ text: `SOURCE_PART_${part}:` + 'historical observation '.repeat(10000) }) })) })
  h.runner.submit(runtimeProposal(['archive_fixture', 'dynamic_task_status']))
  const result = await h.runner.runNext({ expectedRevision: 1 })
  assert.equal(backend.requests.length, 18)
  assert.ok(Buffer.byteLength(backend.requests[1].rawBody) > 1024 * 1024)
  assert.equal(backend.requests[1].payload.messages.filter(m => m.role === 'tool').length, 8)
  assert.equal(backend.requests[1].payload.messages.filter(m => m.role === 'user').length, 1)
  assert.equal(result.trace.events.filter(e => e.type === 'history/compacted').length, 0)
  const continuation = path.join(h.runner.config.directory, result.report.attemptId, 'continuation')
  const files = namesStored(continuation)
  assert.equal(files.filter(f => /^request-/.test(f)).length, 18)
  const snapshots = files.filter(f => /^snapshot-/.test(f)).map(f => statStored(path.join(continuation, f)).size)
  assert.ok(Math.max(...snapshots) < 32 * 1024 * 1024)
})

test('one complete large source observation reaches the next request without truncation', async t => {
  const text = 'complete immutable source observation '.repeat(50000)
  const backend = await startFakeLlama({ maxRequestBytes: 8388608, respond: ({ index }) => index === 1
    ? { tools: [{ name: 'large_source', arguments: {} }] } : { text: 'Full source received; this is transport evidence.' } })
  t.after(() => backend.close())
  const h = await fixture(t, { backend, config: { allowedTools: ['large_source'], maxContextCharacters: 8388608,
    direct: { durable: true, maxRequestBytes: 8388608, runtime: { modules: ['state'], registeredTools: ['large_source'], maxToolOutputCharacters: 8388608 } } },
    setup: ctx => registered(ctx, 'large_source', async () => ({ text }), { output: {
      schema: { type: 'object', properties: { text: { type: 'string' } }, additionalProperties: false }, render: (_args, value) => [{ type: 'text', text: value.text }] } }) })
  h.runner.submit(runtimeProposal(['large_source']))
  const result = await h.runner.runNext({ expectedRevision: 1 })
  assert.equal(backend.requests[1].payload.messages.at(-1).content, text)
  assert.equal(result.trace.events.filter(e => e.type === 'history/compacted').length, 0)
})

for (const [code, originalText, badSearch] of [
  ['FS_EDIT_NOT_FOUND', 'original\n', 'absent'],
  ['FS_AMBIGUOUS_EDIT', 'same\nsame\n', 'same'],
]) test(`native ${code} preserves bytes and prior effects, defers the batch suffix, and admits a deliberate correction`, async t => {
  let h
  h = await fixture(t, { config: { maxRequestsPerTask: 6, direct: { durable: true } }, respond: ({ index, payload }) => {
    if (index === 1 || index === 3) {
      if (index === 3) {
        assert.equal(fs.readFileSync(path.join(h.projectRoot, 'existing.txt'), 'utf8'), originalText)
        assert.equal(fs.readFileSync(path.join(h.projectRoot, 'prefix.txt'), 'utf8'), 'preserved')
        assert.equal(fs.existsSync(path.join(h.projectRoot, 'suffix.txt')), false)
        assert.match(payload.messages.at(-1).content, /NOT_EXECUTED.*preceding native file change/)
      }
      return tool('read', { file_path: 'existing.txt' })
    }
    if (index === 2) return { tools: [
      { name: 'write', arguments: { file_path: 'prefix.txt', content: 'preserved' } },
      { name: 'edit', arguments: { file_path: 'existing.txt', old_string: badSearch, new_string: 'bad' } },
      { name: 'write', arguments: { file_path: 'suffix.txt', content: 'must be deferred' } },
    ] }
    if (index === 4) return tool('edit', { file_path: 'existing.txt', old_string: originalText, new_string: 'correct\n' })
    return { text: 'Applied a new edit after the explicit pre-write rejection.' }
  } })
  fs.writeFileSync(path.join(h.projectRoot, 'existing.txt'), originalText)
  h.runner.submit(runtimeProposal(['read', 'write', 'edit']))
  const result = await h.runner.runNext({ expectedRevision: 1 })
  assert.equal(fs.readFileSync(path.join(h.projectRoot, 'existing.txt'), 'utf8'), 'correct\n')
  assert.equal(fs.existsSync(path.join(h.projectRoot, 'suffix.txt')), false)
  assert.equal(result.trace.events.filter(e => e.type === 'tool/result' && e.data.name === 'write').length, 1)
  const failure = result.trace.events.find(e => e.type === 'tool/edit-rejected-before-write')
  assert.equal(failure.data.code, code); assert.equal(failure.data.effects, 'NOT_EXECUTED')
  assert.equal(result.trace.events.filter(e => e.type === 'tool/deferred').length, 1)
  const facts = result.trace.executionHost
  assert.equal(facts.activeLeaf.key, result.trace.assembly.task.key)
  assert.equal(facts.activeLeaf.instruction, result.trace.assembly.task.instruction)
  assert.deepEqual(facts.activeLeaf.completion, result.trace.assembly.completion)
})

for (const ambiguous of [false, true]) test(`direct tool syntax ${ambiguous ? 'returns an exact ambiguity and resumes from durable feedback' : 'normalizes unambiguous text before one effect'}`, async t => {
  const h = await fixture(t, { config: { direct: { durable: true } }, respond: ({ index, payload }) => {
    if (index === 1) return { tools: [{ name: 'write', argumentsText: ambiguous
      ? '{"file_path":"result.txt","content":"literal\\q"}'
      : '{"file_path":"result.txt","content":"line\nbreak",}' }] }
    if (ambiguous && index === 2) {
      const detail = JSON.parse(payload.messages.at(-1).content)
      assert.equal(detail.diagnostic.code, 'MODEL_JSON_AMBIGUOUS_ESCAPE')
      assert.equal(detail.execution, 'NOT_EXECUTED')
      assert.ok(detail.diagnostic.issues[0].location.column > 1)
      return tool('write', { file_path: 'result.txt', content: 'literal\\q' })
    }
    return { text: 'The fixture write completed.' }
  } })
  h.runner.submit(runtimeProposal(['write']))
  let result = await h.runner.runNext({ expectedRevision: 1, ...(ambiguous ? { pauseAfterRequests: 1 } : {}) })
  if (ambiguous) {
    assert.equal(result.paused, true)
    assert.equal(fs.existsSync(path.join(h.projectRoot, 'result.txt')), false)
    const status = h.runner.status()
    result = await h.runner.resumeActive({ expectedRevision: status.revision, checkpointChecksum: status.continuation.checksum })
  }
  assert.equal(fs.readFileSync(path.join(h.projectRoot, 'result.txt'), 'utf8'), ambiguous ? 'literal\\q' : 'line\nbreak')
  assert.equal(result.trace.events.filter(row => row.type === 'tool/result').length, 1)
  assert.equal(h.backend.requests.length, ambiguous ? 3 : 2)
  assert.ok(result.trace.events.some(row => row.type === (ambiguous ? 'task/validation-rejected' : 'tool/arguments-normalized')))
})

for (const mode of ['read-only', 'workspace-write', 'danger-full-access']) test(`auto runtime inherits the main conversation ${mode} permissions`, async t => {
  const h = await fixture(t, { config: { direct: { runtime: { sandboxMode: 'auto', approvalPolicy: 'auto' } } },
    respond: ({ index, payload }) => index === 1 ? tool('write', { file_path: 'auto.txt', content: 'inherited' }) : { text: JSON.stringify(payload.messages.slice(-1)) } })
  const owner = await h.ctx.agents.create({ sessionId: 'auto-owner-' + mode, meta: { cwd: h.projectRoot } })
  t.after(() => owner.dispose()); setSandboxMode(owner.agent.session, mode)
  h.runner.submit(runtimeProposal(['write']))
  const result = await h.runner.runNext({ expectedRevision: 1, sourceAgent: owner.agent })
  assert.equal(result.trace.executionHost.policy.sandboxMode, mode)
  assert.equal(fs.existsSync(path.join(h.projectRoot, 'auto.txt')), mode !== 'read-only')
})

test('full main permissions allow external ordinary files while privacy protection remains active', async t => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-external-'))
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }))
  let h
  h = await fixture(t, { mode: 'danger-full-access', config: { direct: { runtime: { sandboxMode: 'auto' } } },
    respond: ({ index, payload }) => index === 1 ? tool('write', { file_path: path.join(outside, 'file.txt'), content: 'external-allowed' })
      : index === 2 ? tool('bash', { workdir: outside, command: 'printf shell-allowed > shell.txt' })
        : index === 3 ? tool('read', { file_path: path.join(h.storageRoot, 'host-only.txt') }) : { text: JSON.stringify(payload.messages.slice(-2)) } })
  fs.writeFileSync(path.join(h.storageRoot, 'host-only.txt'), 'MUST_REMAIN_PRIVATE')
  h.runner.submit(runtimeProposal(['write', 'bash', 'read']))
  const result = await h.runner.runNext({ expectedRevision: 1 })
  assert.equal(fs.readFileSync(path.join(outside, 'file.txt'), 'utf8'), 'external-allowed')
  assert.equal(fs.readFileSync(path.join(outside, 'shell.txt'), 'utf8'), 'shell-allowed')
  assert.match(result.report.text, /DIRECT_RUNTIME_PRIVATE_PATH_DENIED/)
  assert.doesNotMatch(result.report.text, /MUST_REMAIN_PRIVATE/)
})

test('loosening main permissions between serial tools updates the next tool without replay', async t => {
  let owner, writes = 0
  const h = await fixture(t, { config: { direct: { runtime: { sandboxMode: 'auto' } } },
    respond: ({ index }) => index === 1 ? { tools: [
      { name: 'read', arguments: { file_path: 'input.txt' } },
      { name: 'write', arguments: { file_path: 'new.txt', content: 'once' } },
    ] } : { text: 'Continued after host permission update.' },
    setup: ctx => ctx.on('tools/execute', async (exec, next) => {
      const result = await next()
      if (exec.name === 'read') setSandboxMode(owner.agent.session, 'workspace-write')
      if (exec.name === 'write') writes++
      return result
    }) })
  owner = await h.ctx.agents.create({ sessionId: 'expanding-owner', meta: { cwd: h.projectRoot } })
  t.after(() => owner.dispose()); setSandboxMode(owner.agent.session, 'read-only')
  fs.writeFileSync(path.join(h.projectRoot, 'input.txt'), 'read first')
  h.runner.submit(runtimeProposal(['read', 'write']))
  await h.runner.runNext({ expectedRevision: 1, sourceAgent: owner.agent })
  assert.equal(writes, 1); assert.equal(fs.readFileSync(path.join(h.projectRoot, 'new.txt'), 'utf8'), 'once')
  assert.match(JSON.stringify(h.backend.requests[1].payload.messages), /direct-host-permissions-v1/)
})

test('a main approval-policy change cancels pending approval without cancelling the task', async t => {
  let entered, effects = 0
  const waiting = new Promise(resolve => { entered = resolve })
  const h = await fixture(t, { approval: 'ask', config: { allowedTools: ['gated_fixture'], direct: { runtime: { modules: [], sandboxMode: 'auto', approvalPolicy: 'auto', registeredTools: ['gated_fixture'] } } },
    respond: ({ index, payload }) => index === 1 ? tool('gated_fixture', {}) : { text: JSON.stringify(payload.messages.slice(-2)) },
    setup: ctx => {
      registered(ctx, 'gated_fixture', async () => { effects++; return {} })
      ctx.on('tools/pre-execute', (exec, next) => exec.name === 'gated_fixture' ? { kind: 'ask', reason: 'Live approval test' } : next())
      ctx.on('approval/request', async request => {
        entered()
        await new Promise(resolve => request.signal.aborted ? resolve() : request.signal.addEventListener('abort', resolve, { once: true }))
        return 'rejected'
      })
    } })
  const owner = await h.ctx.agents.create({ sessionId: 'approval-owner', meta: { cwd: h.projectRoot } })
  t.after(() => owner.dispose()); h.runner.submit(runtimeProposal(['gated_fixture']))
  const result = h.runner.runNext({ expectedRevision: 1, sourceAgent: owner.agent })
  await waiting; setApprovalPolicy(owner.agent.session, 'never')
  assert.match((await result).report.text, /DIRECT_TOOL_PERMISSION_REVOKED/)
  assert.equal(effects, 0); assert.equal(h.backend.requests.length, 2)
})

test('a paused direct request resumes under changed owner permissions without replaying completed effects', async t => {
  let writes = 0
  const h = await fixture(t, { config: { direct: { durable: true, runtime: { sandboxMode: 'auto' } } },
    respond: ({ index, payload }) => index === 1 ? tool('write', { file_path: 'once.txt', content: 'once' })
      : { text: JSON.stringify(payload.messages.slice(-2)) },
    setup: ctx => ctx.on('tools/execute', (exec, next) => { if (exec.name === 'write') writes++; return next() }) })
  const owner = await h.ctx.agents.create({ sessionId: 'paused-policy-owner', meta: { cwd: h.projectRoot } })
  t.after(() => owner.dispose()); h.runner.submit(runtimeProposal(['write']))
  const pause = await h.runner.runNext({ expectedRevision: 1, sourceAgent: owner.agent, pauseAfterRequests: 1 })
  assert.equal(pause.paused, true); setSandboxMode(owner.agent.session, 'read-only')
  const result = await h.runner.resumeActive({ expectedRevision: 2, sourceAgent: owner.agent, checkpointChecksum: pause.checkpoint.checksum })
  assert.match(result.report.text, /direct-host-permissions-v1/)
  assert.match(result.report.text, /read-only/)
  assert.equal(writes, 1); assert.equal(h.backend.requests.length, 2)
})

test('supervision accepts only live permission differences, retaining task authority', async t => {
  const { assertAuthority, supervisionAuthority } = await import('../supervision-runtime.mjs')
  const h = await fixture(t, { respond: () => ({ text: 'unused' }), config: { direct: { runtime: { sandboxMode: 'auto', approvalPolicy: 'auto' } } } })
  const owner = await h.ctx.agents.create({ sessionId: 'supervision-permissions-owner', meta: { cwd: h.projectRoot } })
  t.after(() => owner.dispose())
  const config = structuredClone(h.runner.config)
  config.direct.runtime.sandboxMode = 'workspace-write'; config.direct.runtime.approvalPolicy = 'ask'
  const before = supervisionAuthority({ ...h.runner, config }, owner.agent)
  setSandboxMode(owner.agent.session, 'read-only')
  assertAuthority(h.runner, before, owner.agent, new AbortController().signal)
  assert.throws(() => assertAuthority({ ...h.runner, config: { ...h.runner.config, model: 'changed' } }, before, owner.agent, new AbortController().signal), /SUPERVISION_AUTHORITY_CHANGED/)
  owner.agent.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Changed scope must still be handled as guidance.' }] }), { surfaceOp: 'append' })
  assert.throws(() => assertAuthority(h.runner, before, owner.agent, new AbortController().signal), /SUPERVISION_AUTHORITY_CHANGED/)
})
