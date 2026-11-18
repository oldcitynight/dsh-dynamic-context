import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Session } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { planningHistoryRecords, preparePlanningHistory } from '../planning-history.mjs'
import { UserGuidanceCoordinator } from '../user-guidance.mjs'

test('handoff preserves visible discussion, native plan/approval pairs and tool evidence with original source positions', () => {
  const text = value => [{ type: 'text', text: value }]
  const events = [
    { seq: 1, type: 'user/message', data: { id: 'u', source: { kind: 'user' }, content: text('先讨论，不开始规划。') } },
    { seq: 2, type: 'system/message', data: { content: text('GLOBAL_SYSTEM_NOISE') } },
    { seq: 3, type: 'user/message', data: { source: { kind: 'runtime-context' }, content: text('RUNTIME_NOISE') } },
    { seq: 4, type: 'assistant/message', data: { message: { id: 'a', content: [{ type: 'reasoning', text: 'PRIVATE_REASONING' }, ...text('候选方案：蓝图风格。')] } } },
    { seq: 5, type: 'tool/call', data: { callId: 'plan-review', name: 'exit_plan_mode', arguments: '{"plan":"# 蓝图方案"}' } },
    { seq: 6, type: 'tool/result', data: { message: { toolCallId: 'plan-review', content: text('{"approved":true}'), isError: false } } },
    { seq: 8, type: 'user/message', data: { source: { kind: 'user' }, content: text('AFTER_COMMAND') } },
  ]
  const rows = planningHistoryRecords(events, 6)
  assert.deepEqual(rows.map(row => row.seq), [1,4,5,6])
  assert.equal(rows[2].callId, rows[3].callId)
  assert.match(rows[2].text, /蓝图方案/); assert.match(rows[3].text, /approved/)
  assert.doesNotMatch(JSON.stringify(rows), /GLOBAL_SYSTEM_NOISE|RUNTIME_NOISE|PRIVATE_REASONING|AFTER_COMMAND/)
})

test('large discussion stays retrievable by pages; a resumed planner uses its pinned snapshot and detects tampering', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'planning-history-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const session = Session.create('history-owner'), owner = { session }
  const body = '历史材料 '.repeat(9000) + 'NEEDLE 后面的结论不能遗漏。'
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: body }] }), { surfaceOp: 'append' })
  const runner = { config: { directory } }, initial = preparePlanningHistory(runner, owner, 'planner-1')
  assert.equal(initial.context.completeInline, false)
  const exec = { signal: new AbortController().signal }
  const found = initial.tool.execute({ action: 'search', query: 'NEEDLE' }, exec)
  assert.equal(found.messages.length, 1)
  let received = '', offset = 0
  do {
    const page = initial.tool.execute({ action: 'read', message: found.messages[0].index, offset, length: 16000 }, exec)
    received += page.text; offset = page.nextOffset
  } while (offset !== null)
  assert.equal(received, body)
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'LATER_MESSAGE' }] }), { surfaceOp: 'append' })
  const resumed = preparePlanningHistory(runner, owner, 'planner-1', true)
  assert.deepEqual(resumed.descriptor, initial.descriptor)
  assert.equal(resumed.tool.execute({ action: 'search', query: 'LATER_MESSAGE' }, exec).total, 0)
  assert.equal(preparePlanningHistory(runner, owner, 'legacy-planner', true), null)
  fs.appendFileSync(path.join(directory, 'planning-history', initial.descriptor.sha256 + '.json'), ' ')
  assert.throws(() => resumed.tool.execute({ action: 'list' }, exec), /PLANNING_HISTORY_CHANGED/)
})

test('guidance summaries remain lossless JSON from receipt through routing and failure', () => {
  const coordinator = new UserGuidanceCoordinator({ ctx: {} })
  coordinator.records = () => [{ id: 'new', phase: 'RECEIVED' }, { id: 'classified', phase: 'CLASSIFIED', analysis: { level: 'leaf' } },
    { id: 'routed', phase: 'ROUTED', route: { summary: 'Revise the plan' }, jobs: [] }, { id: 'error', phase: 'FAILED', error: { code: 'X' } }]
  const rows = coordinator.summary({})
  assert.deepEqual(JSON.parse(JSON.stringify(rows)), rows)
  assert.deepEqual(rows[0], { id: 'new', phase: 'RECEIVED' })
})
