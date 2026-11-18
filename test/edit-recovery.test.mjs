import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { digest } from 'dsh-better-task-grapth/core'
import { serializeDirectRequest } from '../direct-wire.mjs'
import { verifyRecoveryRequest, pendingResponseData, recoverDirectCheckpoint } from '../recovery.mjs'
import { wireTools } from '../request-policy.mjs'
import { createRuntimeHarness, runtimeProposal } from '../testing/runtime-harness.mjs'
import { startFakeLlama } from '../testing/fake-llama.mjs'
import { DirectJournal } from '../durable-store.mjs'
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })
const schema = { name: 'read', description: 'Read a scoped file', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } }
function historyFixture(protocol = 'messages') {
  const history = [{ role: 'system', content: 'Preserve protected instructions.' }, { role: 'user', content: 'Inspect the project.' },
    { role: 'assistant', content: null, reasoning_content: 'Read first.', tool_calls: [call('prior', 'read', { file_path: 'file.txt' })],
      messagesReplay: { version: 1, blocks: [{ type: 'thinking', thinking: 'Read first.', signature: 'provider-owned' },
        { type: 'tool_use', id: 'prior', name: 'read', input: { file_path: 'file.txt' } }] } },
    { role: 'tool', tool_call_id: 'prior', content: 'Original content' }, { role: 'user', content: 'Keep reviewing.' }]
  const payload = serializeDirectRequest({ model: 'fake', messages: history, tools: wireTools([schema]), max_tokens: 100 }, { protocol })
  const state = { history, nextStep: 1, usedCallIds: ['prior'], trace: { requests: [], events: [], contract: { schemas: [schema] } } }
  const request = { ordinal: 2, taskOrdinal: 2, purpose: 'task', status: 'COMPLETE', finish: 'tool_calls', payload, bodySha256: sha(payload),
    ...(protocol === 'messages' ? { normalizedHistory: { length: history.length, sha256: digest(history), toolsSha256: digest(wireTools([schema])) } } : {}) }
  return { state, request }
}
for (const protocol of ['messages', 'chat-completions']) test(`recovery compares ${protocol} using its actual wire shape`, () => {
  const { state, request } = historyFixture(protocol)
  verifyRecoveryRequest(request, state)
})
for (const protocol of ['messages', 'chat-completions']) test(`recovery verifies saved ${protocol} image bytes without reopening attachments`, () => {
  const { state, request } = historyFixture(protocol)
  const image = { attachmentId: 'sha256:' + 'a'.repeat(64), mediaType: 'image/png', width: 8, height: 8, bytes: 4 }
  const imageBlock = { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: 'aW1hZ2U=' } }
  state.history[3].images = [image]
  state.history.at(-1).images = [image]
  const tools = wireTools(state.trace.contract.schemas)
  request.normalizedHistory = { protocol, length: state.history.length, sha256: digest(state.history), toolsSha256: digest(tools) }
  request.payload = serializeDirectRequest({ model: 'fake', messages: state.history, tools, max_tokens: 100 }, { protocol },
    new Map([[image.attachmentId, imageBlock]]))
  request.bodySha256 = sha(request.payload)
  verifyRecoveryRequest(request, state)
  const result = protocol === 'messages' ? request.payload.messages.flatMap(row => row.content).find(row => row.type === 'tool_result')
    : request.payload.messages.find(row => row.role === 'tool')
  result.content.pop()
  request.bodySha256 = sha(request.payload)
  assert.throws(() => verifyRecoveryRequest(request, state), { code: 'DIRECT_RECOVERY_HISTORY_DIVERGED' })
})
test('recovery preserves the saved error for a failed image alongside a successful image', () => {
  const { state, request } = historyFixture()
  const failed = { attachmentId: 'sha256:' + 'a'.repeat(64), mediaType: 'image/png', width: 8, height: 8, bytes: 4 }
  const image = { ...failed, attachmentId: 'sha256:' + 'b'.repeat(64) }
  const imageBlock = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' } }
  const failure = { error: 'READ_IMAGE_ATTACHMENT_UNAVAILABLE', attachmentId: failed.attachmentId }
  state.history[3].images = [failed, image]
  const tools = wireTools(state.trace.contract.schemas)
  request.normalizedHistory = { ...request.normalizedHistory, sha256: digest(state.history) }
  const messages = structuredClone(state.history)
  messages[3] = { ...messages[3], content: JSON.stringify(failure), isError: true, images: [image] }
  request.payload = serializeDirectRequest({ model: 'fake', messages, tools, max_tokens: 100 }, { protocol: 'messages' },
    new Map([[image.attachmentId, imageBlock]]))
  request.bodySha256 = sha(request.payload)
  verifyRecoveryRequest(request, state, undefined, [[JSON.stringify(['prior', failed.attachmentId]), failure]])
  assert.throws(() => verifyRecoveryRequest(request, state), { code: 'DIRECT_RECOVERY_HISTORY_DIVERGED' })
})
for (const mutation of ['history', 'system', 'tool', 'normalized', 'body']) test(`Messages recovery still rejects changed ${mutation}`, () => {
  const { state, request } = historyFixture()
  if (mutation === 'history') request.payload.messages[0].content[0].text = 'Foreign task'
  if (mutation === 'system') request.payload.system = 'Foreign authority'
  if (mutation === 'tool') request.payload.tools[0].description = 'Foreign capability'
  if (mutation === 'normalized') request.normalizedHistory.sha256 = '0'.repeat(64)
  if (mutation === 'body') request.payload.max_tokens++
  else request.bodySha256 = sha(request.payload)
  assert.throws(() => verifyRecoveryRequest(request, state), /DIRECT_(RECOVERY_HISTORY_DIVERGED|REQUEST_PAYLOAD_MISMATCH)/)
})
function pendingFixture() {
  const { state, request } = historyFixture()
  const completed = { message: { role: 'assistant', content: null, tool_calls: [call('pending', 'read', { file_path: 'file.txt' })] }, text: '', finish: 'tool_calls' }
  request.responseMessageSha256 = digest(completed.message)
  state.trace.requests.push(request); state.trace.events.push({ seq: 0, type: 'assistant/response', data: completed })
  state.pendingResponse = { version: 1, requestOrdinal: 2, responseEventSeq: 0 }
  return state
}
for (const mutation of ['response', 'executed', 'ordinal', 'duplicate']) test(`pending response rejects ${mutation} before dispatch`, () => {
  const state = pendingFixture()
  if (mutation === 'response') state.trace.events[0].data.message.tool_calls[0].function.arguments = '{}'
  if (mutation === 'executed') state.trace.events.push({ seq: 1, type: 'tool/call', data: { callId: 'pending' } })
  if (mutation === 'ordinal') state.nextStep++
  if (mutation === 'duplicate') state.usedCallIds.push('pending')
  assert.throws(() => pendingResponseData(state), /DIRECT_PENDING_RESPONSE_INVALID/)
})
test('crash after dispatching a saved response becomes UNKNOWN, never a replay', async () => {
  const state = pendingFixture(); state.assembly = { task: 'test' }; state.contractHash = 'contract'; state.approvedCheckpoints = []; state.runtime = null
  state.history.pop()
  const request = state.trace.requests[0]
  request.payload = serializeDirectRequest({ model: 'fake', messages: state.history, tools: wireTools([schema]), max_tokens: 100 }, { protocol: 'messages' })
  request.bodySha256 = sha(request.payload); request.normalizedHistory.length = state.history.length; request.normalizedHistory.sha256 = digest(state.history)
  state.trace.assembly = state.assembly; state.trace.contract.hash = 'contract'
  const trace = structuredClone(state.trace)
  trace.events.push({ seq: 1, type: 'tool/call', data: { callId: 'pending', name: 'read' } })
  const journal = { latestCheckpoint: () => ({ checksum: 'base' }), latest: () => ({ checksum: 'head' }), loadCheckpoint: () => structuredClone(state), readTrace: () => trace }
  const result = await recoverDirectCheckpoint({ journal, ctx: {} })
  assert.deepEqual(result.recovery.calls, [{ callId: 'pending', outcome: 'UNKNOWN' }])
  assert.equal(result.state.pendingResponse, undefined)
  assert.equal(result.state.nextStep, 2)
})
async function fixture(t, respond, setup) {
  const storageRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-edit-recovery-')))
  const projectRoot = path.join(storageRoot, 'workspace'); fs.mkdirSync(projectRoot); fs.writeFileSync(path.join(projectRoot, 'file.txt'), 'original\n')
  const backend = await startFakeLlama({ respond }), opened = []
  t.after(async () => { for (const h of opened) await h.close(); await backend.close(); fs.rmSync(storageRoot, { recursive: true, force: true }) })
  return { backend, projectRoot, async open() { const h = await createRuntimeHarness({ projectRoot, directory: path.join(storageRoot, 'state'), backend, setup,
    config: { storageRoot, maxRequestsPerTask: 6, direct: { durable: true } } }); opened.push(h); return h } }
}
const edit = { name: 'edit', arguments: { file_path: 'file.txt', old_string: 'original', new_string: 'original' } }
test('native no-op edit returns its error, defers later batch effects and allows a corrected edit', async t => {
  const where = await fixture(t, ({ index, payload }) => {
    if (index === 1 || index === 3) {
      if (index === 3) {
        assert.match(payload.messages.at(-2).content, /old_string and new_string must differ/)
        assert.match(payload.messages.at(-1).content, /NOT_EXECUTED/)
        assert.equal(fs.existsSync(path.join(where.projectRoot, 'blocked.txt')), false)
        assert.equal(fs.readFileSync(path.join(where.projectRoot, 'file.txt'), 'utf8'), 'original\n')
      }
      return { tools: [{ name: 'read', arguments: { file_path: 'file.txt' } }] }
    }
    if (index === 2) return { tools: [edit, { name: 'write', arguments: { file_path: 'blocked.txt', content: 'must be deferred' } }] }
    if (index === 4) return { tools: [{ ...edit, arguments: { ...edit.arguments, new_string: 'corrected' } }] }
    return { text: 'Corrected the edit without repeating prior effects.' }
  })
  const h = await where.open(); h.runner.submit(runtimeProposal(['read', 'write', 'edit']))
  const result = await h.runner.runNext({ expectedRevision: 1 })
  assert.equal(fs.readFileSync(path.join(where.projectRoot, 'file.txt'), 'utf8'), 'corrected\n')
  assert.equal(result.trace.events.filter(e => e.type === 'tool/edit-rejected-before-write' && e.data.code === 'FS_EDIT_UNCHANGED_INPUT').length, 1)
  assert.equal(where.backend.requests.length, 5)
})
test('identical arguments do not hide an unrelated native failure', async t => {
  const where = await fixture(t, ({ index, payload }) => index === 1 ? { tools: [edit] } : { text: payload.messages.at(-1).content }, ctx => ctx.on('tools/execute', (exec, next) => exec.name === 'edit'
    ? { isError: true, content: [{ type: 'text', text: 'unrelated error' }], error: { message: 'unrelated error' } } : next()))
  const h = await where.open(); h.runner.submit(runtimeProposal(['edit']))
  const result = await h.runner.runNext({ expectedRevision: 1 })
  assert.match(result.report.text, /unrelated error/)
  assert.equal(result.trace.events.some(row => row.type === 'tool/edit-rejected-before-write'), false)
  assert.equal(where.backend.requests.length, 2)
})
test('host-restored before-tool pause consumes the paid response and resumes after restart without another model request', async t => {
  let edits = 0
  const where = await fixture(t, ({ index, payload }) => {
    if (index === 1) return { tools: [{ name: 'read', arguments: { file_path: 'file.txt' } }] }
    if (index === 2) return { tools: [edit] }
    assert.equal(index, 3); assert.match(payload.messages.at(-1).content, /old_string and new_string must differ/)
    return { text: 'Observed the saved response and continued.' }
  }, ctx => ctx.on('tools/execute', (exec, next) => { if (exec.name === 'edit') edits++; return next() }))
  const first = await where.open(); first.runner.submit(runtimeProposal(['read', 'edit']))
  await first.runner.runNext({ expectedRevision: 1, pauseAfterRequests: 2 })
  const graph = first.runner.graph.read(), active = graph.graph.state.active
  const journal = DirectJournal.open(first.runner.activeRunDirectory(graph), { taskId: active.nodeId, attemptId: active.attemptId,
    contextVersion: graph.contexts.version, owner: active.owner, graphRevision: graph.revision })
  const base = journal.records().filter(row => row.phase === 'READY').map(row => journal.loadCheckpoint(row)).find(row => row.nextStep === 1)
  const current = journal.readTrace(), event = current.events.findLast(row => row.type === 'assistant/response')
  base.trace = current; base.trace.events = current.events.slice(0, event.seq + 1)
  base.trace.executionEvents = base.runtime.native.events
  base.pendingResponse = { version: 1, requestOrdinal: 2, responseEventSeq: event.seq }
  pendingResponseData(base, journal)
  const ticket = journal.checkpoint('PAUSED', base)
  await first.close()
  const second = await where.open()
  const result = await second.runner.resumeActive({ expectedRevision: graph.revision, checkpointChecksum: ticket.checksum })
  assert.equal(where.backend.requests.length, 3); assert.equal(edits, 2) // first rejected call was explicitly rewound; no successful effect was replayed
  assert.equal(fs.readFileSync(path.join(where.projectRoot, 'file.txt'), 'utf8'), 'original\n')
  assert.ok(result.trace.events.some(row => row.type === 'task/response-resumed'))
  assert.equal(result.trace.events.filter(row => row.type === 'tool/result' && row.data.name === 'edit').length, 1)
  assert.equal(result.trace.requests.length, 3)
})
