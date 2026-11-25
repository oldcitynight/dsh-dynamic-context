import test from 'node:test'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { KNOWN_SESSION_EVENT_TYPES, Session } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { assertReleasedV4Relationships } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import { createRuntimeHarness, runtimeProposal } from '../testing/runtime-harness.mjs'
import { fixtureTrace } from '../testing/harness.mjs'
import { repairPrematureNativeClose } from '../native-recovery.mjs'
import { recoverDirectCheckpoint } from '../recovery.mjs'
import { digest } from 'dsh-better-task-grapth/core'

async function fixture(t, options = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'direct-lifecycle-')))
  const projectRoot = path.join(root, 'workspace'); fs.mkdirSync(projectRoot)
  const h = await createRuntimeHarness({ projectRoot, directory: path.join(root, 'state'), ...options,
    config: { storageRoot: root, ...options.config } })
  t.after(async () => { await h.close(); fs.rmSync(root, { recursive: true, force: true }) })
  return { ...h, projectRoot, trace: () => fixtureTrace(h.runner) }
}
function validate(trace) {
  assertReleasedV4Relationships({ header: { version: 4, id: trace.sessionId, isSeeded: false },
    events: trace.executionEvents, inheritedEventCount: 0 }, KNOWN_SESSION_EVENT_TYPES)
}
const write = { name: 'write', arguments: { file_path: 'suffix.txt', content: 'must not execute' } }

test('a real foreground timeout returns partial evidence, defers the batch suffix, and lets the model inspect before continuing', async t => {
  const h = await fixture(t, { respond: ({ index, payload }) => {
    if (index === 1) return { tools: [{ name: 'bash', arguments: { description: 'Produce a partial artifact before timeout',
      command: 'printf partial > partial.txt; printf partial-output; sleep 5', timeoutMs: 200 } }, write] }
    if (index === 2) {
      const results = payload.messages.filter(row => row.role === 'tool')
      assert.equal(results.length, 2)
      const timed = JSON.parse(results[0].content)
      assert.equal(timed.execution.timedOut, true); assert.equal(timed.execution.outcome, 'TIMED_OUT')
      assert.match(timed.output, /partial-output/); assert.match(results[1].content, /NOT_EXECUTED/)
      assert.equal(fs.existsSync(path.join(h.projectRoot, 'suffix.txt')), false)
      return { tools: [{ name: 'read', arguments: { file_path: 'partial.txt' } }] }
    }
    assert.match(payload.messages.at(-1).content, /partial/)
    return { text: 'Partial artifact inspected; the timed-out command did not complete its intended work.' }
  } })
  h.runner.submit(runtimeProposal(['bash', 'write', 'read']))
  const result = await h.runner.runNext({ expectedRevision: 1 })
  validate(result.trace)
  assert.equal(h.backend.requests.length, 3)
  assert.equal(fs.readFileSync(path.join(h.projectRoot, 'partial.txt'), 'utf8'), 'partial')
  assert.equal(fs.existsSync(path.join(h.projectRoot, 'suffix.txt')), false)
  assert.equal(result.trace.events.filter(row => row.type === 'tool/shell-timed-out').length, 1)
  assert.equal(result.trace.events.filter(row => row.type === 'tool/deferred').length, 1)
})

test('fatal tool failure closes every declared native pair before ending the step without executing the suffix', async t => {
  const h = await fixture(t, { respond: () => ({ tools: [{ name: 'fail_fixture', arguments: {} }, write] }),
    config: { allowedTools: ['fail_fixture', 'write'], direct: { runtime: { modules: ['filesystem'], registeredTools: ['fail_fixture'] } } },
    setup: ctx => ctx.tools.register(defineTool({ name: 'fail_fixture', description: 'Fail without effects', parameters: {},
      output: { schema: { type: 'object', properties: {}, additionalProperties: true }, render: () => [] }, execute() { throw Error('fixture failure') } })) })
  h.runner.toolErrorPolicy.register({ pluginId: 'test-host', ruleId: 'fixture-failure', toolId: 'fail_fixture',
    when: { '/isError': true, '/error/message': 'fixture failure' }, reason: 'Exercise the blocking boundary and suffix sealing.' })
  h.runner.submit(runtimeProposal(['fail_fixture', 'write']))
  await assert.rejects(h.runner.runNext({ expectedRevision: 1 }), /DIRECT_TOOL_ERROR_BLOCKED/)
  const trace = h.trace(); validate(trace)
  const receipt = trace.executionEvents.find(event => event.type === 'tool/result' && event.data.message.content.some(block => block.text?.includes('outcome=NOT_EXECUTED')))
  assert.ok(receipt); assert.ok(receipt.seq < trace.executionEvents.findLast(event => event.type === 'step/end').seq)
  assert.equal(fs.existsSync(path.join(h.projectRoot, 'suffix.txt')), false)
  assert.equal(h.backend.requests.length, 1)
})

test('cancelling a running tool drains it and seals the unexecuted suffix before native turn closure', async t => {
  const entered = Promise.withResolvers(); let drained = false
  const h = await fixture(t, { respond: () => ({ tools: [{ name: 'wait_fixture', arguments: {} }, write] }),
    config: { allowedTools: ['wait_fixture', 'write'], direct: { runtime: { modules: ['filesystem'], registeredTools: ['wait_fixture'] } } },
    setup: ctx => ctx.tools.register(defineTool({ name: 'wait_fixture', description: 'Wait for cancellation', parameters: {},
      output: { schema: { type: 'object', properties: {}, additionalProperties: true }, render: () => [] }, async execute(_args, exec) {
        entered.resolve(); await new Promise(resolve => exec.signal.addEventListener('abort', resolve, { once: true }))
        drained = true; return { drained: true }
      } })) })
  h.runner.submit(runtimeProposal(['wait_fixture', 'write']))
  const running = assert.rejects(h.runner.runNext({ expectedRevision: 1 }))
  await entered.promise; await h.runner.close(); await running
  assert.equal(drained, true)
  const trace = h.trace(); validate(trace)
  assert.ok(trace.executionEvents.some(event => event.type === 'tool/result' && event.data.message.content.some(block => block.text?.includes('outcome=NOT_EXECUTED'))))
  assert.equal(fs.existsSync(path.join(h.projectRoot, 'suffix.txt')), false)
  assert.equal(h.backend.requests.length, 1)
})

function legacyFixture() {
  const session = Session.create('legacy-worker')
  session.append('turn/start', { turn: 1 }); session.append('step/start', { turn: 1, step: 1 })
  const pinned = { header: session.header, events: session.snapshotEvents(), inheritedEventCount: 0 }
  const calls = ['first', 'suffix'].map(id => ({ id, type: 'function', function: { name: 'bash', arguments: '{}' } }))
  session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createAssistantMessage({
    content: calls.map(call => ({ type: 'tool-call', id: call.id, name: 'bash', arguments: '{}' })), source: { kind: 'model', provider: 'fake', model: 'fake' } }) }, { surfaceOp: 'append' })
  const call = session.append('tool/call', { turn: 1, step: 1, callId: 'first', name: 'bash', arguments: '{}' })
  session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: 'first', isError: false,
    content: [{ type: 'text', text: 'Partial output; timed out.' }] }) }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
  session.append('step/end', { turn: 1, step: 1 }); session.append('turn/end', { turn: 1, reason: { kind: 'aborted' } })
  return { pinned, calls, native: { ...pinned, events: session.snapshotEvents() } }
}

test('known historical premature close is repaired only in a validated inherited copy; unrelated corruption is rejected', () => {
  const { native } = legacyFixture(), before = JSON.stringify(native)
  assert.throws(() => assertReleasedV4Relationships(native, KNOWN_SESSION_EVENT_TYPES), /unresolved tool call suffix/)
  const result = repairPrematureNativeClose(native)
  assert.deepEqual(result.recovered, [{ callId: 'suffix', outcome: 'NOT_EXECUTED' }])
  assertReleasedV4Relationships(result.native, KNOWN_SESSION_EVENT_TYPES)
  assert.equal(JSON.stringify(native), before)
  const damaged = structuredClone(native)
  damaged.events.at(-1).data.reason.kind = 'completed'
  assert.throws(() => repairPrematureNativeClose(damaged), /SHAPE_UNSUPPORTED/)
  damaged.events[1].data.turn = 99
  assert.throws(() => repairPrematureNativeClose(damaged))
})

test('explicit checkpoint recovery recognizes only the known close defect and preserves completed results and native prefix', async () => {
  const { native, pinned, calls } = legacyFixture()
  const history = [{ role: 'system', content: 'fixture' }, { role: 'user', content: 'work' }]
  const response = { message: { role: 'assistant', content: '', tool_calls: calls }, text: '', finish: 'tool_calls' }
  const state = { assembly: {}, contractHash: 'pinned', history, usedCallIds: [], nextStep: 0,
    runtime: { native: pinned }, trace: { requests: [], events: [] }, approvedCheckpoints: [] }
  const trace = { assembly: {}, contract: { hash: 'pinned' }, sessionId: native.header.id, executionEvents: native.events,
    requests: [{ purpose: 'task', taskOrdinal: 1, ordinal: 1, payload: { messages: history }, bodySha256: createHash('sha256').update(JSON.stringify({ messages: history })).digest('hex'), responseMessageSha256: digest(response.message) }],
    events: [{ seq: 0, type: 'assistant/response', data: response }, { seq: 1, type: 'tool/call', data: { callId: 'first' } },
      { seq: 2, type: 'tool/result', data: { callId: 'first', content: [{ type: 'text', text: 'Partial output; timed out.' }] } }] }
  const original = JSON.stringify({ state, trace })
  const journal = { inspectHead: () => ({ checkpoint: { checksum: 'safe' }, head: { checksum: 'blocked' } }),
    assertHeadUnchanged: head => assert.equal(head.checksum, 'blocked'),
    loadResumeCheckpoint: async record => { assert.equal(record.checksum, 'safe'); return structuredClone(state) },
    readTrace: () => structuredClone(trace) }
  const ctx = { agents: new Map(), get: () => ({ open: async () => { const error = Error('stored log is corrupt: step/end leaves unresolved tool call suffix'); error.name = 'SessionPersistenceCorruptionError'; throw error } }) }
  const recovered = await recoverDirectCheckpoint({ journal, ctx })
  assertReleasedV4Relationships(recovered.state.runtime.native, KNOWN_SESSION_EVENT_TYPES)
  assert.deepEqual(recovered.recovery.legacyNativeClose.recovered, [{ callId: 'suffix', outcome: 'NOT_EXECUTED' }])
  assert.match(recovered.state.history[3].content, /Partial output/)
  assert.match(recovered.state.history[4].content, /NOT_EXECUTED/)
  assert.equal(JSON.stringify({ state, trace }), original)
  const tampered = structuredClone(trace); tampered.executionEvents[0].data.turn = 77
  await assert.rejects(recoverDirectCheckpoint({ journal: { ...journal, readTrace: () => tampered }, ctx }), /stored log is corrupt/)
})

for (const defect of ['invalid-schema', 'duplicate-call-id']) test(`rejected ${defect} response stays in the raw trace without poisoning native lifecycle`, async t => {
  const h = await fixture(t, { respond: () => ({ tools: defect === 'invalid-schema'
    ? [write, { name: 'read', arguments: { file_path: 42 } }]
    : [{ ...write, id: 'duplicate' }, { name: 'read', id: 'duplicate', arguments: { file_path: 'input.txt' } }] }) })
  h.runner.submit(runtimeProposal(['write', 'read']))
  await assert.rejects(h.runner.runNext({ expectedRevision: 1 }))
  const trace = h.trace(); validate(trace)
  assert.ok(trace.events.some(event => event.type === 'assistant/response') || defect === 'duplicate-call-id')
  assert.equal(trace.executionEvents.filter(event => event.type === 'tool/call').length, 0)
  assert.equal(fs.existsSync(path.join(h.projectRoot, 'suffix.txt')), false)
})
