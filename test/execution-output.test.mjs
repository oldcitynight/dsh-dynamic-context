import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ExecutionOutput, OUTPUT_RECORD } from '../execution-output.mjs'
import { Session } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { authorityInputs } from '../authority.mjs'
import { readCompletion } from '../direct-http.mjs'

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'execution-output-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return { dir, feed: new ExecutionOutput(dir) }
}
test('display receives validated SSE before completion and preserves interrupted content across restart', async t => {
  const { dir, feed } = fixture(t)
  const model = feed.model({ stage: 'EXECUTING', taskId: 'leaf', step: 1 })
  let push
  const response = new Response(new ReadableStream({ start(controller) { push = controller } }), { headers: { 'content-type': 'text/event-stream' } })
  const encoder = new TextEncoder(), abort = new AbortController()
  const pending = readCompletion(response, { signal: abort.signal, model: 'fixture', direct: { responseModelAliases: [] }, maxResponseBytes: null, onDelta: model.delta })
  push.enqueue(encoder.encode('data: '+JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: '先检查条件，不预判成果。' } }] })+'\n\n'))
  await new Promise(resolve => setImmediate(resolve))
  const first = feed.read(); assert.ok(first.items.some(row => row.kind === 'reasoning' && row.state === 'running' && row.preview.includes('检查条件')))
  abort.abort(); await assert.rejects(pending)
  model.end('interrupted', 'ABORTED')
  const second = new ExecutionOutput(dir).read()
  assert.ok(second.items.some(row => row.kind === 'reasoning' && row.state === 'interrupted'))
  assert.equal(second.items.find(row => row.kind === 'reasoning').preview, first.items.find(row => row.kind === 'reasoning').preview)
})
test('UTF-8 body pages reproduce long terminal results; cursor pages cover all changes and older records', t => {
  const { feed } = fixture(t), meta = { stage: 'EXECUTING', step: 1 }
  const text = '终端输出🧪\n'.repeat(12000)
  feed.tool(meta, 'tool/call', { callId: 'c1', name: 'bash', arguments: { command: 'printf fixture' } }, 'test')
  feed.tool(meta, 'tool/result', { callId: 'c1', name: 'bash', content: text, isError: false }, 'test')
  const row = feed.read().items[0]; assert.equal(row.state, 'complete'); assert.ok(row.previewOffset > 0)
  let offset = 0, whole = ''
  do { const page = feed.body({ itemId: row.id, offset }); whole += page.text; offset = page.nextOffset } while (offset < row.bytes)
  assert.equal(whole, '[arguments]\n{\n  "command": "printf fixture"\n}\n[result]\n' + text + '\n')
  assert.ok(!whole.includes('�'))
  let cursor = feed.read().cursor
  for (let i = 0; i < 94; i++) feed.model(meta).end('complete', 'stop')
  const ids = new Set()
  for (;;) { const page = feed.read({ cursor }); for (const row of page.items) ids.add(row.id); cursor = page.cursor; if (!page.more) break }
  assert.equal(ids.size, 94)
  const latest = feed.read(); assert.equal(latest.items.length, 40); assert.equal(latest.older, true)
  const older = feed.read({ before: latest.items[0].sequence }); assert.equal(older.items.length, 40)
  assert.ok(older.items.every(row => row.sequence < latest.items[0].sequence))
  assert.throws(() => feed.body({ itemId: '../../secret', offset: 0 }), /NOT_FOUND/)
})
test('native tools pair with nested result callId, errors remain errors, observation failure is non-fatal', t => {
  const { feed, dir } = fixture(t), meta = { stage: 'PREPLANNING', sessionId: 'planner' }
  feed.nativeEvent(meta, { type: 'tool/call', data: { step: 1, callId: 'one', name: 'bash', arguments: '{"command":"false"}' } })
  feed.nativeEvent(meta, { type: 'tool/result', data: { step: 1, message: { toolCallId: 'one', isError: true, content: [{ type: 'text', text: 'exit 1' }] } } })
  assert.equal(feed.read().items.length, 1); assert.equal(feed.read().items[0].state, 'error')
  const bad = new ExecutionOutput(path.join(dir, 'file')); fs.writeFileSync(path.join(dir, 'file'), 'not a directory')
  assert.doesNotThrow(() => bad.model(meta).delta({ text: 'still executes' }))
  assert.equal(bad.warning, 'EXECUTION_DISPLAY_WRITE_FAILED')
})
test('a restarted unfinished display never implies that its request or tool succeeded', t => {
  const { feed, dir } = fixture(t)
  feed.tool({ stage: 'EXECUTING' }, 'tool/call', { callId: 'unknown', name: 'write', arguments: { path: 'result' } }, 'task')
  feed.read()
  assert.equal(new ExecutionOutput(dir).read().items[0].state, 'interrupted')
})
test('legacy history imports only owned output without modifying execution evidence or importing prompts', async t => {
  const { feed, dir } = fixture(t), attempt = path.join(dir, 'attempt_legacy')
  fs.mkdirSync(attempt)
  const trace = { assembly: { task: { id: 'leaf' } }, sessionId: 'worker',
    requests: [{ payload: { messages: ['PRIVATE_SYSTEM_PROMPT'], apiKey: 'PRIVATE_KEY' } }],
    events: [{ type: 'assistant/response', time: 2000, data: { reasoning: 'Historical reasoning', text: 'Historical answer', finish: 'stop' } },
      { type: 'tool/call', time: 2001, data: { callId: 'old', name: 'bash', arguments: '{"command":"printf ok"}' } },
      { type: 'tool/result', time: 2002, data: { callId: 'old', name: 'bash', content: 'ok\nexit 0' } }] }
  const file = path.join(attempt, 'trace.json'), bytes = JSON.stringify(trace); fs.writeFileSync(file, bytes)
  let reads = 0, closes = 0
  const runner = { config: { directory: dir }, controller: { session: { id: 'owner' } },
    interaction: { orchestrator: { record: () => ({ plannerSessionId: 'planner' }) } }, ctx: { get: () => ({ open: async (id, access) => {
      assert.equal(id, 'planner'); assert.equal(access, 'read'); reads++
      return { header: { parentSession: 'owner' }, read: async () => ({ events: [
        { type: 'system/message', time: 1000, data: { message: { content: [{ type: 'text', text: 'PRIVATE_SYSTEM_PROMPT' }] } } },
        { type: 'assistant/message', seq: 1, time: 1001, data: { step: 1, message: { content: [{ type: 'reasoning', text: 'Planner reasoning' }] } } },
      ] }), close: async () => { closes++ } }
    } }) } }
  await Promise.all([feed.importHistory(runner), feed.importHistory(runner)])
  const page = feed.read(); assert.ok(page.items.some(row => row.preview === 'Planner reasoning'))
  assert.ok(page.items.some(row => row.kind === 'tool' && row.preview.includes('exit 0')))
  assert.ok(!JSON.stringify(page).includes('PRIVATE_')); assert.equal(fs.readFileSync(file, 'utf8'), bytes)
  const restored = new ExecutionOutput(dir); await restored.importHistory(runner)
  assert.equal(restored.read().items.length, page.items.length); assert.equal(reads, 1); assert.equal(closes, 1)
})

test('historical leaf and auxiliary-role compactions keep the same display purpose as live streams', async t => {
  const { feed, dir } = fixture(t)
  const leaf = path.join(dir, 'attempt_compaction'), role = path.join(dir, 'revisions', 'revision_result_repair_fixture')
  fs.mkdirSync(leaf); fs.mkdirSync(role, { recursive: true })
  const inputs = [
    [path.join(leaf, 'trace.json'), { assembly: { task: { id: 'leaf' } }, sessionId: 'worker', events: [
      { type: 'compaction/response', time: 1000, data: { text: 'leaf summary', finish: 'stop' } },
      { type: 'assistant/response', time: 1001, data: { text: 'ordinary leaf answer', finish: 'stop' } },
    ] }],
    [path.join(role, 'role.json'), { role: 'result_repair', runId: 'repair', createdAt: '2026-11-16T00:00:00Z', calls: [
      { sequence: 1, purpose: 'compaction', response: { text: 'role summary', finish: 'stop' } },
      { sequence: 2, purpose: 'result_repair', response: { text: 'ordinary repair answer', finish: 'stop' } },
    ] }],
  ].map(([file, value]) => [file, JSON.stringify(value)])
  for (const [file, bytes] of inputs) fs.writeFileSync(file, bytes)
  await feed.importHistory({ config: { directory: dir } })
  const messages = feed.read().items.filter(row => row.kind === 'message')
  assert.deepEqual(messages.map(row => [row.preview, row.stage]), [
    ['leaf summary', 'compaction'], ['ordinary leaf answer', 'EXECUTING'],
    ['role summary', 'compaction'], ['ordinary repair answer', 'result_repair'],
  ])
  for (const [file, bytes] of inputs) assert.equal(fs.readFileSync(file, 'utf8'), bytes)
  const live = feed.model({ stage: 'compaction', step: 3 }, 'live-compact')
  live.delta({ text: 'live summary' }); live.end()
  const restored = new ExecutionOutput(dir)
  await restored.importHistory({ config: { directory: dir } })
  assert.equal(restored.read().items.filter(row => row.kind === 'message' && row.stage === 'compaction').length, 3)
})

test('native Chat publication is log-only, restart-idempotent and leaves model input and authority unchanged', async t => {
  const { feed, dir } = fixture(t)
  const session = Session.create('display-owner')
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Authorized work' }] }), { surfaceOp: 'append' })
  session.append('turn/start', { turn: 1 }); session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const controller = { id: 'owner', session }, agents = new Map([['owner', controller]])
  let flushes = 0
  const runner = { controller, workflowId: 'workflow', config: { directory: dir },
    graph: { read: () => ({ graph: { state: { plan: { nodes: [{ id: 'leaf', label: 'Produce result' }] } } } }) },
    ctx: { agents, sessions: { flush: async () => { flushes++; return true } } } }
  const before = session.snapshotEvents(), messages = session.deriveMessages(), authority = authorityInputs(session)
  const model = feed.model({ stage: 'EXECUTING', taskId: 'leaf', step: 1 }, 'request')
  model.delta({ reasoning: 'First part. ' }); feed.flush()
  feed.bindConversation(runner)
  await new Promise(resolve => setImmediate(resolve))
  model.delta({ reasoning: 'Second part.' }); model.end()
  const records = session.snapshotEvents().filter(event => event.type === OUTPUT_RECORD)
  assert.ok(records.every(event => event.ignorable && !event.surfaceOp))
  assert.ok(records.every(event => event.data.turn === 1), 'late observations keep their real owner turn')
  const reasoning = records.filter(event => event.data.row.kind === 'reasoning')
  assert.equal(reasoning[0].data.reset, true)
  assert.equal(reasoning.map(event => event.data.text).join(''), 'First part. Second part.')
  assert.equal(reasoning[1].data.offset, Buffer.byteLength('First part. '))
  assert.equal(reasoning[0].data.row.taskLabel, 'Produce result')
  assert.deepEqual(session.snapshotEvents().slice(0, before.length), before)
  assert.deepEqual(session.deriveMessages(), messages); assert.deepEqual(authorityInputs(session), authority)
  assert.ok(flushes > 0)
  const count = session.snapshotEvents().length
  const restored = new ExecutionOutput(dir); restored.bindConversation(runner)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(session.snapshotEvents().length, count, 'rebind never duplicates persisted observations')
  agents.delete('owner')
  restored.model({ stage: 'EXECUTING' }, 'detached').end()
  assert.equal(session.snapshotEvents().length, count, 'a detached owner cannot receive another session output')
  assert.deepEqual(session.deriveMessages(), messages)
})

test('final task prose resumes a committed display prefix once after restart without changing evidence', t => {
  const {feed,dir}=fixture(t),meta={stage:'task_reporter',step:0},key='hierarchy-final:fixed-run'
  const id=feed.create(meta,'message','完整任务报告',key)
  feed.append(id,'任务总结\n\n');feed.flush()
  const restored=new ExecutionOutput(dir),text='任务总结\n\n已完成交付，保留获准限制。'
  restored.publishText(meta,'完整任务报告',text,key)
  restored.publishText(meta,'完整任务报告',text,key)
  const items=restored.read().items
  assert.equal(items.length,1);assert.equal(items[0].state,'complete')
  assert.equal(restored.body({itemId:id,offset:0}).text,text)
  restored.publishText(meta,'完整任务报告','另一个不匹配的报告',key)
  assert.equal(restored.warning,'EXECUTION_DISPLAY_WRITE_FAILED')
  assert.equal(restored.body({itemId:id,offset:0}).text,text)
})
