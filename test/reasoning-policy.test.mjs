import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { apiParameters, mainReasoningEffort, planningReasoningEffort, resolveReasoningPolicy } from '../api-protocol.mjs'
import { validateConfig } from '../index.mjs'
import { createRuntimeHarness, runtimeProposal } from '../testing/runtime-harness.mjs'
import { startFakeLlama } from '../testing/fake-llama.mjs'
import { directRevisionRole, readRoleRecord } from '../revision-runtime.mjs'
import { COMPACTION_INSTRUCTION } from '../dsh-compaction-policy.mjs'

const signal = () => new AbortController().signal
const config = direct => ({ provider: 'fake', model: 'fake-llama', direct: { api: 'deepseek', protocol: 'chat-completions', reasoningEffort: 'auto', ...direct } })
const owner = effort => ({ options: { provider: 'fake', model: 'fake-llama', reasoningEffort: 'low' },
  session: { id: 'main', requestHeader: () => ({ config: { provider: 'fake', model: 'fake-llama', reasoningEffort: effort } }) } })

test('auto is the configuration default and never a literal wire effort', () => {
  const value = validateConfig({ projectRoot: '/workspace', directory: '/state', provider: 'fake', model: 'fake-llama',
    systemPrompt: 'Host', transport: 'direct', direct: { endpoint: 'http://127.0.0.1:1/v1/chat/completions', apiKeyEnv: 'FAKE_KEY' } })
  assert.equal(value.direct.reasoningEffort, 'auto')
  assert.deepEqual(apiParameters(value.direct), {})
  assert.deepEqual(apiParameters({ api: 'deepseek', protocol: 'chat-completions', reasoningEffort: 'auto' }), { thinking: { type: 'enabled' } })
})

for (const effort of ['off', 'low', 'high', 'max']) test('planning and direct roles inherit the admitted main effort: ' + effort, async () => {
  const sourceAgent = owner(effort), input = config()
  assert.equal(await planningReasoningEffort({}, input, sourceAgent, signal()), effort)
  const result = await resolveReasoningPolicy({ config: input, ctx: {}, sourceAgent, signal: signal() })
  assert.equal(result.receipt.source, 'main-conversation'); assert.equal(result.receipt.sourceSessionId, 'main')
  assert.deepEqual(apiParameters(result.config.direct), effort === 'off' ? { thinking: { type: 'disabled' } }
    : { thinking: { type: 'enabled' }, reasoning_effort: effort })
})

test('cleared and adapter-default efforts do not revive stale Agent options', async () => {
  const ctx = { llm: { resolveModelInfo: async () => ({ reasoning: { defaultEffort: 'high' } }) } }
  assert.equal(await mainReasoningEffort(ctx, owner(undefined), signal()), 'high')
  const source = owner('max'); source.session.requestHeader = () => ({ adapterDefaults: { reasoningEffort: true }, config: { provider: 'fake', model: 'fake-llama', reasoningEffort: 'max' } })
  assert.equal(await mainReasoningEffort(ctx, source, signal()), 'high')
  assert.equal(await mainReasoningEffort({}, owner(undefined), signal()), undefined)
})

test('explicit plugin effort and disabled thinking remain intentional overrides', async () => {
  for (const direct of [{ reasoningEffort: 'low' }, { thinking: { type: 'disabled' } }]) {
    const input = config(direct), expected = direct.thinking ? 'off' : 'low'
    assert.equal(await planningReasoningEffort({}, input, owner('max'), signal()), expected)
    const value = await resolveReasoningPolicy({ config: input, ctx: {}, sourceAgent: owner('max'), signal: signal() })
    assert.equal(value.receipt.source, 'plugin-override'); assert.equal(value.receipt.effective.reasoningEffort, expected)
  }
})

test('host-only fallback uses provider metadata; unsupported main efforts are located before sending', async () => {
  const ctx = { llm: { resolveModelInfo: async () => ({ reasoning: { defaultEffort: 'low' } }) } }
  const fallback = await resolveReasoningPolicy({ config: config(), ctx, signal: signal() })
  assert.equal(fallback.receipt.source, 'provider-default'); assert.equal(fallback.config.direct.reasoningEffort, 'low')
  await assert.rejects(resolveReasoningPolicy({ config: config(), ctx: {}, sourceAgent: owner('medium'), signal: signal() }),
    error => error.code === 'INHERITED_REASONING_EFFORT_UNSUPPORTED' && JSON.stringify(error).includes('/direct/reasoningEffort'))
})

test('a resumed operation retains its receipt and a new operation picks up the main change', async () => {
  const first = await resolveReasoningPolicy({ config: config(), ctx: {}, sourceAgent: owner('low'), signal: signal() })
  const resumed = await resolveReasoningPolicy({ config: config(), ctx: {}, sourceAgent: owner('max'), signal: signal(), previous: first.receipt })
  const next = await resolveReasoningPolicy({ config: config(), ctx: {}, sourceAgent: owner('max'), signal: signal() })
  assert.equal(resumed.config.direct.reasoningEffort, 'low'); assert.equal(next.config.direct.reasoningEffort, 'max')
  await assert.rejects(resolveReasoningPolicy({ config: config({ reasoningEffort: 'high' }), ctx: {}, previous: first.receipt, signal: signal() }), /REASONING_POLICY_RECEIPT_CHANGED/)
})

for (const code of ['NO_ADAPTER', 'UNKNOWN_MODEL']) test('standalone direct auto does not require a native model catalog: ' + code, async () => {
  const ctx = { llm: { resolveModelInfo: async () => { throw Object.assign(new Error(code), { code }) } } }
  const value = await resolveReasoningPolicy({ config: config(), ctx, signal: signal() })
  assert.deepEqual(apiParameters(value.config.direct), { thinking: { type: 'enabled' } })
  await assert.rejects(resolveReasoningPolicy({ config: config(), ctx, sourceAgent: owner(undefined), signal: signal() }), { code })
})

test('real direct execution preserves effort across pause and inherits changes for the next leaf', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reasoning-worker-'))), projectRoot = path.join(root, 'project')
  fs.mkdirSync(projectRoot)
  const h = await createRuntimeHarness({ projectRoot, directory: path.join(root, 'state'), config: { storageRoot: root,
    allowedTools: ['dynamic_task_status'], direct: { api: 'deepseek', durable: true, runtime: { modules: ['state'] } } },
    respond: ({ payload, index }) => {
      assert.equal(payload.reasoning_effort, index < 3 ? 'low' : 'max')
      return index === 1 ? { tools: [{ name: 'dynamic_task_status', arguments: {} }] } : { text: 'Recorded result.' }
    } })
  let handle
  t.after(async () => { await handle?.dispose(); await h.close(); fs.rmSync(root, { recursive: true, force: true }) })
  handle = await h.ctx.agents.create({ sessionId: 'main-reasoning', meta: { cwd: projectRoot }, agentOptions: { provider: 'dynamic-context-fake', model: 'fake-llama' } })
  let effort = 'low'
  handle.agent.session.requestHeader = () => ({ config: { provider: 'dynamic-context-fake', model: 'fake-llama', reasoningEffort: effort } })
  const proposal = runtimeProposal(['dynamic_task_status'])
  proposal.taskGraph.nodes.push({ key: 'next', kind: 'leaf', parent: 'root', label: 'Next leaf' })
  proposal.taskGraph.edges.push({ kind: 'prerequisite', from: 'task', to: 'next' })
  proposal.contextGraph.bindings.push({ ...proposal.contextGraph.bindings[0], task: 'next', inheritReports: ['task'] })
  h.runner.submit(proposal)
  const paused = await h.runner.runNext({ expectedRevision: 1, sourceAgent: handle.agent, pauseAfterRequests: 1 })
  assert.equal(paused.paused, true); effort = 'max'
  const continued = await h.runner.resumeActive({ expectedRevision: h.runner.graph.read().revision, sourceAgent: handle.agent, checkpointChecksum: paused.checkpoint.checksum })
  assert.equal(continued.trace.reasoningPolicy.effective.reasoningEffort, 'low')
  const next = await h.runner.runNext({ expectedRevision: h.runner.graph.read().revision, sourceAgent: handle.agent })
  assert.equal(next.trace.reasoningPolicy.effective.reasoningEffort, 'max')
  assert.equal(h.backend.requests.length, 3); assert.deepEqual(h.backend.errors, [])
})

test('all independent role kinds use the main effort and keep their own durable receipt', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reasoning-roles-'))
  const backend = await startFakeLlama({ respond: ({ payload }) => { assert.equal(payload.reasoning_effort, 'max'); return { text: '{"observed":true}' } } })
  t.after(async () => { await backend.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const runner = { controller: owner('max'), ctx: { get: () => ({ resolve: async () => ({ value: 'fake-only' }) }) },
    config: validateConfig({ projectRoot: root, directory: root, provider: 'fake', model: 'fake-llama', systemPrompt: 'Host', transport: 'direct',
      revision: { policy: { objective: 'Check', requirements: [{ id: 'a', text: 'Check evidence' }] } },
      direct: { api: 'deepseek', protocol: 'chat-completions', endpoint: backend.origin + '/v1/chat/completions', apiKeyEnv: 'FAKE_KEY', durable: true } }) }
  for (const role of ['updater','reviewer','result_check','plan_check','result_repair','blockage','blockage_audit','group_audit','scope_plan','scope_update','scope_audit','task_reporter','scope_blockage','scope_pause']) {
    const runId = `revision_${role}_${randomUUID()}`
    const result = await directRevisionRole(runner, { role, runId, signal: signal(), messages: [{ role: 'system', content: 'Check the supplied evidence.' }, { role: 'user', content: '{}' }] })
    assert.equal(result.observed, true); assert.equal(readRoleRecord(runner, runId).reasoningPolicy.effective.reasoningEffort, 'max')
  }
  assert.deepEqual(backend.errors, [])
})

test('role compaction shares the inherited policy and exact calls survive a paused restart', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reasoning-compaction-'))
  let pause = false, summaries = 0, mainCalls = 0
  const backend = await startFakeLlama({ respond: ({ payload }) => {
    assert.equal(payload.reasoning_effort, 'low')
    if (payload.messages.at(-1).content?.startsWith?.(COMPACTION_INSTRUCTION)) { summaries++; pause = true; return { text: 'Historical evidence navigation only.' } }
    mainCalls++; return { text: '{"observed":true}' }
  } })
  t.after(async () => { await backend.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const runner = { controller: owner('low'), ctx: { get: () => ({ resolve: async () => ({ value: 'fake-only' }) }) },
    workflowControl: { beforeRequest() { if (pause) throw Object.assign(new Error('WORKFLOW_PAUSE_REQUESTED'), { code: 'WORKFLOW_PAUSE_REQUESTED' }) } },
    config: validateConfig({ projectRoot: root, directory: root, provider: 'fake', model: 'fake-llama', systemPrompt: 'Host', transport: 'direct',
      revision: { policy: { objective: 'Check', requirements: [{ id: 'a', text: 'Check evidence' }] }, maxOutputTokens: 32768 },
      direct: { api: 'deepseek', protocol: 'chat-completions', endpoint: backend.origin + '/v1/chat/completions', apiKeyEnv: 'FAKE_KEY', durable: true,
        compaction: { strategy: 'dsh-native', contextWindow: 262144 }, maxRequestBytes: null, maxResponseBytes: null } }) }
  const runId = `revision_result_check_${randomUUID()}`, request = { runId, role: 'result_check', signal: signal(),
    messages: [{ role: 'system', content: 'Inspect evidence.' }, { role: 'user', content: JSON.stringify({ evidence: 'large evidence '.repeat(24000) }) }] }
  await assert.rejects(directRevisionRole(runner, request), { code: 'WORKFLOW_PAUSE_REQUESTED' })
  const before = summaries; assert.ok(before > 0); pause = false; runner.controller = owner('max')
  // Resume may require further source chunks; only the first auxiliary call pauses.
  runner.workflowControl.beforeRequest = () => {}
  assert.equal((await directRevisionRole(runner, request)).observed, true)
  assert.equal(mainCalls, 1)
  const record = readRoleRecord(runner, runId)
  assert.equal(record.calls.filter(row => row.purpose === 'compaction').length, summaries)
  assert.equal(record.reasoningPolicy.effective.reasoningEffort, 'low')
  assert.deepEqual(backend.errors, [])
})
