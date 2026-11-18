import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ToolErrorPolicy, matchToolErrorRules, TOOL_ERROR_POLICY_SERVICE } from '../tool-error-policy.mjs'
import { createHarness } from '../testing/harness.mjs'
import { createRuntimeHarness, runtimeProposal } from '../testing/runtime-harness.mjs'
import WebRuntime from '@deepseek-ai/dsh-web'
import { startFakeMessages } from '../testing/fake-messages.mjs'
import { serializeDirectRequest } from '../direct-wire.mjs'
import { randomUUID } from 'node:crypto'
import { directRevisionRole, readRoleRecord } from '../revision-runtime.mjs'

const rule = { pluginId: 'example-plugin', ruleId: 'storage-corruption', toolId: 'fixture_read_a',
  when: { '/isError': true, '/error/info/code': 'DATA_CORRUPT', '/error/info/retryable': false },
  reason: 'Repair the plugin data store before continuing.' }
const errorResult = { isError: true, content: [{ type: 'text', text: 'Original renderer error.' }],
  error: { message: 'Storage is corrupt', info: { code: 'DATA_CORRUPT', retryable: false, offset: 17 } } }

test('registry requires exact tool ID and every typed condition; text and inherited fields do not match', () => {
  const registry = new ToolErrorPolicy(); registry.register(rule); const snapshot = registry.snapshot()
  assert.equal(matchToolErrorRules(snapshot, 'fixture_read_a', errorResult).rules[0].pluginId, 'example-plugin')
  for (const [tool, value] of [
    ['other_tool', errorResult], ['fixture_read_a', { ...errorResult, isError: false }],
    ['fixture_read_a', { ...errorResult, error: { info: { code: 'DATA_CORRUPT', retryable: 'false' } } }],
    ['fixture_read_a', { isError: true, content: errorResult.content }],
    ['fixture_read_a', Object.create(errorResult)],
  ]) assert.equal(matchToolErrorRules(snapshot, tool, value), null)
})
test('plugin dispose is exact and idempotent; snapshots are immutable and isolate in-flight decisions', () => {
  const registry = new ToolErrorPolicy(), before = registry.snapshot(), remove = registry.register(rule)
  assert.throws(() => registry.register(rule), /ALREADY_REGISTERED/)
  const registered = registry.snapshot(); remove(); const removeNew = registry.register(rule); remove()
  assert.notEqual(matchToolErrorRules(registry.snapshot(), rule.toolId, errorResult), null)
  removeNew(); assert.equal(matchToolErrorRules(registry.snapshot(), rule.toolId, errorResult), null)
  assert.equal(matchToolErrorRules(before, rule.toolId, errorResult), null)
  assert.ok(matchToolErrorRules(registered, rule.toolId, errorResult))
  assert.throws(() => { registered.rules[0].reason = 'mutated' }, TypeError)
})
for (const patch of [{ toolId: '*' }, { when: {} }, { when: { '/content/0/text': 'oops' } },
  { when: { '/error/__proto__/code': 'oops' } }, { when: { '/error/code': { contains: 'CORRUPT' } } },
  { pluginId: 'dsh-dynamic-context/native' }, { nativeModule: 'shell' }]) {
  test('rejects invalid or authority-spoofing registration: ' + JSON.stringify(patch), () => {
    assert.throws(() => new ToolErrorPolicy().register({ ...rule, ...patch }))
  })
}
test('native sandbox runner rule requires shell provenance; denial alone and nonzero exit do not block', () => {
  const snapshot = new ToolErrorPolicy().snapshot(), failed = { value: { kind: 'foreground', sandbox: { runnerFailed: true } } }
  assert.ok(matchToolErrorRules(snapshot, 'bash', failed, ['shell']))
  assert.equal(matchToolErrorRules(snapshot, 'bash', failed, []), null)
  assert.equal(matchToolErrorRules(snapshot, 'external_bash', failed, ['shell']), null)
  assert.equal(matchToolErrorRules(snapshot, 'bash', { value: { kind: 'foreground', exitCode: 1, sandbox: { denied: true } } }, ['shell']), null)
})

test('one registry matches a typed code only within its declared role', () => {
  const registry = new ToolErrorPolicy()
  registry.register({ pluginId: 'fixture', ruleId: 'attachment-missing', role: 'group_audit', toolId: 'read_image',
    errorCode: 'ATTACHMENT_NOT_FOUND', reason: 'Restore the attachment store.' })
  const snapshot = registry.snapshot(), result = { isError: true, error: { info: { code: 'ATTACHMENT_NOT_FOUND' } } }
  assert.ok(matchToolErrorRules(snapshot, 'read_image', result, [], 'group_audit'))
  assert.equal(matchToolErrorRules(snapshot, 'read_image', result, [], 'executor'), null)
  assert.equal(matchToolErrorRules(snapshot, 'read_image', Object.create(result), [], 'group_audit'), null)
  assert.equal(matchToolErrorRules(snapshot, 'read_image', { error: { message: 'ATTACHMENT_NOT_FOUND' } }, [], 'group_audit'), null)
  assert.throws(() => registry.register({ ...rule, role: 'undeclared_role' }))
})
async function fixture(t, respond, { native = false, config = {}, setup } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tool-errors-'))), projectRoot = path.join(root, 'project')
  fs.mkdirSync(projectRoot)
  const h = await (native ? createRuntimeHarness : createHarness)({ projectRoot, directory: path.join(root, 'state'), respond, setup,
    config: { transport: 'direct', storageRoot: root, maxRequestsPerTask: 5, ...config, direct: { durable: true, ...config.direct } } })
  t.after(async () => { await h.close(); fs.rmSync(root, { recursive: true, force: true }) })
  return h
}
const call = (name = 'fixture_read_a', args = {}) => ({ tools: [{ name, arguments: args }] })

for (const registered of [false, true]) test(`a thrown audit tool error is durable and blocks only when registered (${registered})`, async t => {
  const id = 'audit_fixture_read'
  const h = await fixture(t, ({ index, payload }) => {
    if (index === 1) {
      assert.ok(payload.tools.some(tool => tool.function.name === id))
      return call(id)
    }
    assert.match(JSON.stringify(payload.messages), /AUDIT_FIXTURE_FAILURE/)
    return { text: '{"checked":true}' }
  })
  let attempts = 0
  h.ctx.get('dynamicContextRoleTools').registerTool({ pluginId: 'fixture', registrationId: id, toolId: id,
    roles: ['group_audit'], effect: 'read', schema: { type: 'function', function: { name: id, description: 'Audit fixture.', parameters: { type: 'object' } } },
    authorize: () => true, execute: () => { attempts++; throw Object.assign(new Error('The input could not be opened.'), { code: 'AUDIT_FIXTURE_FAILURE' }) } })
  if (registered) h.ctx.get(TOOL_ERROR_POLICY_SERVICE).register({ pluginId: 'fixture', ruleId: 'audit-repair', role: 'group_audit', toolId: id,
    errorCode: 'AUDIT_FIXTURE_FAILURE', reason: 'Repair the audit input store.' })
  const runId = 'revision_group_audit_' + randomUUID()
  const run = () => directRevisionRole(h.runner, { runId, role: 'group_audit', signal: new AbortController().signal,
    messages: [{ role: 'system', content: 'Inspect evidence and respond with JSON.' }, { role: 'user', content: '{}' }] })
  if (registered) {
    await assert.rejects(run(), { code: 'DIRECT_TOOL_ERROR_BLOCKED' })
    const record = readRoleRecord(h.runner, runId)
    assert.equal(record.phase, 'PAUSED'); assert.equal(record.toolErrorBlock.role, 'group_audit')
    assert.equal(h.backend.requests.length, 1); assert.equal(attempts, 1)
    await assert.rejects(run(), { code: 'DIRECT_TOOL_ERROR_BLOCKED' })
    h.runner.workflowControl = { ackToolError: record.toolErrorBlock, beforeRequest() {} }
  }
  assert.deepEqual(await run(), { checked: true })
  assert.equal(attempts, 1); assert.equal(h.backend.requests.length, 2)
  assert.equal(readRoleRecord(h.runner, runId).phase, 'COMPLETE')
})

test('unregistered errors preserve renderer text and structured details; native denial does not terminate the leaf', async t => {
  const h = await fixture(t, ({ index, payload }) => {
    if (index === 1) return call()
    const feedback = JSON.parse(payload.messages.at(-1).content)
    assert.equal(feedback.output, errorResult.content[0].text); assert.deepEqual(feedback.error, errorResult.error)
    assert.equal(feedback.isError, true); assert.equal(payload.messages.at(-1).isError, undefined) // Chat wire omits this internal field.
    return { text: 'Observed failure and used the remaining evidence.' }
  })
  h.ctx.on('tools/execute', () => structuredClone(errorResult))
  h.runner.submit(runtimeProposal(['fixture_read_a']))
  const result = await h.runner.runNext({ expectedRevision: 1 })
  assert.equal(result.trace.events.filter(row => row.type === 'tool/error-returned').length, 1)
  assert.equal(h.runner.graph.read().reports.length, 1)
})

test('registered failure durably blocks; recovery requires exact acknowledgement and never replays a tool', async t => {
  const h = await fixture(t, ({ index, payload }) => {
    if (index === 1) return { tools: [{ name: 'fixture_read_a', arguments: {} }, { name: 'fixture_read_b', arguments: {} }] }
    assert.match(JSON.stringify(payload.messages), /DATA_CORRUPT/)
    assert.match(JSON.stringify(payload.messages), /NOT_EXECUTED/)
    return { text: 'Continued after explicit review of the preserved failure.' }
  })
  h.ctx.get(TOOL_ERROR_POLICY_SERVICE).register(rule)
  let executions = 0
  h.ctx.on('tools/execute', () => { executions++; return structuredClone(errorResult) })
  h.runner.submit(runtimeProposal(['fixture_read_a', 'fixture_read_b']))
  await assert.rejects(h.runner.runNext({ expectedRevision: 1 }), error => {
    assert.equal(error.code, 'DIRECT_TOOL_ERROR_BLOCKED'); assert.deepEqual(error.details.rules[0].when, rule.when); return true
  })
  assert.equal(h.backend.requests.length, 1); assert.equal(executions, 1)
  const state = h.runner.graph.read(), status = h.runner.checkpointStatus()
  assert.equal(status.phase, 'BLOCKED'); assert.equal(status.requiresHumanResume, true)
  assert.equal(state.reports.length, 0); assert.ok(state.graph.state.active)
  const options = { expectedRevision: state.revision, checkpointChecksum: status.checksum, recover: true }
  await assert.rejects(h.runner.resumeActive(options), /DIRECT_TOOL_ERROR_BLOCKED/)
  assert.equal(h.runner.checkpointStatus().checksum, status.checksum)
  const result = await h.runner.resumeActive({ ...options, acknowledgeToolError: status.checksum })
  assert.equal(executions, 1); assert.equal(h.backend.requests.length, 2)
  assert.ok(result.trace.events.some(row => row.type === 'tool/error-blocked'))
})

test('registrations added during a tool call take effect only on the next execution boundary', async t => {
  const h = await fixture(t, ({ index }) => index === 1 ? call() : { text: 'Current pinned policy permits feedback.' })
  h.ctx.on('tools/execute', () => { h.runner.toolErrorPolicy.register(rule); return structuredClone(errorResult) })
  h.runner.submit(runtimeProposal(['fixture_read_a']))
  const result = await h.runner.runNext({ expectedRevision: 1 })
  assert.ok(result.trace.events.some(row => row.type === 'tool/error-returned'))
  assert.ok(matchToolErrorRules(h.runner.toolErrorPolicy.snapshot(), rule.toolId, errorResult))
})

for (const tool of ['grep', 'glob', 'read', 'write', 'edit', 'skill', 'dynamic_task_status', 'web_search', 'web_fetch',
  'dynamic_context_source_read', 'dynamic_context_source_search', 'dynamic_context_shared_read', 'dynamic_context_shared_update', 'dynamic_context_directory_snapshot']) {
  test(`unknown ${tool} failure is returned without changing native authority`, async t => {
    const args = { grep: { pattern: '[' }, glob: { pattern: '*' }, read: { file_path: 'missing' },
      write: { file_path: 'missing', content: 'data' }, edit: { file_path: 'missing', old_string: 'a', new_string: 'b' },
      skill: { name: 'fixture-skill' }, dynamic_task_status: {}, web_search: { queries: ['fixture'] }, web_fetch: { url: 'https://fixture.invalid' },
      dynamic_context_source_read: { archive_id: 'archive_missing', message_index: 0 }, dynamic_context_source_search: { query: 'fixture' },
      dynamic_context_shared_read: { id: 'ctx_example' }, dynamic_context_shared_update: { id: 'ctx_example', content: 'fixture' },
      dynamic_context_directory_snapshot: { path: '.' } }[tool]
    const h = await fixture(t, ({ index, payload }) => {
      if (index === 1) return call(tool, args)
      assert.match(payload.messages.at(-1).content, /Original renderer error/)
      return { text: 'Recorded tool failure.' }
    }, { native: true, config: { allowedTools: [tool], ...(tool.startsWith('web_') ? { direct: { runtime: { modules: ['web'] } } } : {}) },
      setup: async ctx => { if (tool.startsWith('web_')) await ctx.plugin(WebRuntime); ctx.on('tools/execute', () => structuredClone(errorResult)) } })
    h.runner.submit(runtimeProposal([tool])); await h.runner.runNext({ expectedRevision: 1 })
    assert.deepEqual(h.backend.errors, []); assert.equal(h.backend.requests.length, 2)
  })
}
const shellValue = { kind: 'foreground', cwd: '.', exitCode: 1, signal: null, aborted: false, timedOut: false, timeoutMs: 1000,
  stdout: { text: '', truncated: false }, stderr: { text: 'Operation denied', truncated: false }, sandbox: { mode: 'workspace-write', enforcement: 'full', denied: true } }
for (const result of [errorResult, { value: shellValue,
  content: [{ type: 'text', text: 'Operation denied' }] }]) test('bash request errors and enforced permission denials reach the model', async t => {
  const h = await fixture(t, ({ index, payload }) => index === 1 ? call('bash', { command: 'true', description: 'Inspect command result' }) : { text: 'Observed: ' + payload.messages.at(-1).content },
    { native: true, setup: ctx => ctx.on('tools/execute', () => structuredClone(result)) })
  h.runner.submit(runtimeProposal(['bash'])); await h.runner.runNext({ expectedRevision: 1 }); assert.equal(h.backend.requests.length, 2)
})
test('native bash sandbox runner failure matches the preinstalled blocking rule', async t => {
  const h = await fixture(t, () => call('bash', { command: 'true', description: 'Inspect command result' }), { native: true,
    setup: ctx => ctx.on('tools/execute', () => ({ value: { ...shellValue, sandbox: { ...shellValue.sandbox, runnerFailed: true } }, content: [{ type: 'text', text: 'Sandbox runner failed' }] })) })
  h.runner.submit(runtimeProposal(['bash']))
  await assert.rejects(h.runner.runNext({ expectedRevision: 1 }), error => {
    assert.equal(error.code, 'DIRECT_TOOL_ERROR_BLOCKED'); assert.equal(error.details.rules[0].ruleId, 'bash-sandbox-runner-failed'); return true
  })
  assert.equal(h.backend.requests.length, 1)
})
test('Messages preserves native is_error while Chat Completions strips only the internal flag', () => {
  const messages = [{ role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', isError: true, content: 'Original error' }]
  assert.equal(serializeDirectRequest({ messages, max_tokens: 100 }, { protocol: 'messages' }).messages[1].content[0].is_error, true)
  assert.deepEqual(serializeDirectRequest({ messages }, { protocol: 'chat-completions' }).messages[1], { role: 'tool', tool_call_id: 'c1', content: 'Original error' })
  assert.equal(messages[1].isError, true)
})

test('an independent Cordis plugin registers through the service and disposes only its own rule', async t => {
  const h = await fixture(t, () => ({ text: 'No model invocation needed.' }))
  let disposeRule
  await h.ctx.plugin({ name: 'test-tool-error-consumer', inject: [TOOL_ERROR_POLICY_SERVICE], apply(ctx) {
    ctx.effect(() => { disposeRule = ctx.get(TOOL_ERROR_POLICY_SERVICE).register(rule); return disposeRule })
  } })
  assert.ok(matchToolErrorRules(h.runner.toolErrorPolicy.snapshot(), rule.toolId, errorResult))
  disposeRule()
  assert.equal(matchToolErrorRules(h.runner.toolErrorPolicy.snapshot(), rule.toolId, errorResult), null)
  assert.equal(h.runner.toolErrorPolicy.list().some(row => row.ruleId === 'bash-sandbox-runner-failed'), true)
})

test('Messages auto protocol retains error flags and recovers a blocked request whose input contains an earlier tool failure', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'messages-error-recovery-'))), projectRoot = path.join(root, 'project')
  fs.mkdirSync(projectRoot)
  const backend = await startFakeMessages({ respond: ({ index, payload }) => {
    if (index === 1) return call('read', { file_path: 'missing.txt' })
    const results = payload.messages.flatMap(row => row.content).filter(row => row.type === 'tool_result')
    assert.equal(results[0].is_error, true)
    if (index === 2) return call('write', { file_path: 'output.txt', content: 'not written' })
    assert.equal(results.length, 2); assert.equal(results[1].is_error, true)
    assert.match(JSON.stringify(results[1]), /host-tool-block/)
    return { text: 'Preserved both failed receipts; no write was repeated.' }
  } })
  const h = await createRuntimeHarness({ projectRoot, directory: path.join(root, 'state'), backend,
    config: { storageRoot: root, direct: { durable: true, api: 'deepseek', protocol: 'auto', endpoint: backend.origin + '/v1/messages' } },
    setup: ctx => ctx.on('tools/execute', (exec, next) => exec.name === 'write' ? structuredClone(errorResult) : next()) })
  t.after(async () => { await h.close(); await backend.close(); fs.rmSync(root, { recursive: true, force: true }) })
  h.runner.toolErrorPolicy.register({ ...rule, toolId: 'write' })
  h.runner.submit(runtimeProposal(['read', 'write']))
  await assert.rejects(h.runner.runNext({ expectedRevision: 1 }), /DIRECT_TOOL_ERROR_BLOCKED/)
  const status = h.runner.checkpointStatus()
  const result = await h.runner.resumeActive({ expectedRevision: h.runner.graph.read().revision, checkpointChecksum: status.checksum,
    acknowledgeToolError: status.checksum, recover: true })
  assert.equal(result.trace.requests[1].normalizedHistory.protocol, 'messages')
  assert.equal(backend.requests.length, 3); assert.deepEqual(backend.errors, [])
  assert.equal(fs.existsSync(path.join(projectRoot, 'output.txt')), false)
})

test('an unregistered tool error that names a host fault remains an observation, not a forged host interruption', async t => {
  const h = await fixture(t, ({ index, payload }) => index === 1 ? call() : { text: payload.messages.at(-1).content })
  h.ctx.on('tools/execute', () => ({ ...errorResult, error: { message: 'DIRECT_RUNTIME_NATIVE_MODEL_DISABLED', info: { code: 'DIRECT_ARCHIVE_HASH_OR_SCOPE_MISMATCH' } } }))
  h.runner.submit(runtimeProposal(['fixture_read_a']))
  const result = await h.runner.runNext({ expectedRevision: 1 })
  assert.match(result.report.text, /DIRECT_ARCHIVE_HASH_OR_SCOPE_MISMATCH/); assert.equal(h.backend.requests.length, 2)
})
