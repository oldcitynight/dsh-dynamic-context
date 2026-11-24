import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { PartialArguments } from '@deepseek-ai/dsh-util-values'
import { DISPLAY_EVENT, executionChatDefinition } from '../client.source.mjs'
import { structuredLabel, structuredParts } from '../client-enhancements.mjs'
import { dynamicToolNames } from '../tool-display-names.mjs'
import defaults from '../policies/role-defaults.json' with { type: 'json' }
const event = (row, text = '', extra = {}) => ({ seq: row.revision, type: DISPLAY_EVENT,
  data: { version: 1, workflowId: 'workflow', row, text, offset: 0, ...extra } })
test('every dynamic-context tool has Chinese and English display names under its exact wire ID', () => {
  const ids = new Set(defaults.catalog.filter(row => row.origin === 'dynamic-context').flatMap(row => row.tools))
  assert.deepEqual(new Set(Object.keys(dynamicToolNames)), ids)
  for (const id of ids) {
    const [zh, en] = dynamicToolNames[id]
    assert.match(zh, /\p{Script=Han}/u, id)
    assert.match(en, /[a-z]/i, id)
    assert.doesNotMatch(en, /\p{Script=Han}/u, id)
    assert.notEqual(en, id)
  }
  assert.deepEqual(dynamicToolNames.dynamic_context_read_rules, ['读取前序规则', 'Read prerequisite rules'])
  assert.ok(ids.has('dynamic_task_status'))
})
test('execution projection reuses native assistant, reasoning and tool nodes with append-only stream state', () => {
  const definition = executionChatDefinition(PartialArguments)
  assert.equal(definition.match({ type: 'assistant/message', data: {} }), null)
  const row = { id: 'row', kind: 'reasoning', stage: 'EXECUTING', step: 1, state: 'running', revision: 1, bytes: 3, at: '2026-11-15T00:00:00Z' }
  const match = { event: event(row, 'one'), location: { kind: 'session' } }
  const context = { key: 'display:row', id: 'workflow:row', start: match, state: definition.start({}, match) }
  context.state = definition.update(context, { event: event({ ...row, revision: 2, bytes: 6, state: 'complete' }, 'two', { offset: 3 }) })
  const view = definition.buildViewNode(context)
  assert.equal(view.target, 'chat'); assert.equal(view.kind, 'assistant-step'); assert.equal(view.groupTree, 'turn')
  assert.deepEqual(view.data.blocks, [{ kind: 'reasoning', text: 'onetwo' }]); assert.equal(view.data.status, 'settled')
  assert.equal(view.data.dynamicContextFold.workflowId, 'workflow')
  assert.equal(view.data.dynamicContextFold.state, 'complete')
  assert.equal(view.data.dynamicContextFold.step, 1)
  context.state = definition.start({}, { event: event({ ...row, kind: 'tool', state: 'complete' }, '', { native: {
    callId: 'call', name: 'bash', argsRaw: '{"command":"printf ok"}', content: [{ type: 'text', text: 'ok\nexit 0' }],
    meta: { cwd: '/project/subdir' }, isError: false } }) })
  const tool = definition.buildViewNode(context)
  assert.equal(tool.kind, 'tool-call'); assert.equal(tool.data.root.kind, 'tool-result')
  assert.ok(tool.data.root.args instanceof PartialArguments); assert.equal(tool.data.root.content[0].text, 'ok\nexit 0')
  assert.deepEqual(tool.data.root.meta, { cwd: '/project/subdir' })
  assert.equal(tool.data.dynamicContextFold.workflowId, 'workflow')
  assert.equal(tool.data.dynamicContextFold.kind, 'tool')
})
test('shipped client reuses native components and has no duplicate stylesheet or task-graph UI registration', () => {
  execFileSync(process.execPath, [new URL('../scripts/build-client.mjs', import.meta.url).pathname, '--check'])
  const source = fs.readFileSync(new URL('../client.source.mjs', import.meta.url), 'utf8')
  assert.ok(!source.includes('slots.register')); assert.ok(!source.includes('createElement'))
  assert.ok(!source.includes('conversation.input.dock')); assert.ok(!source.includes('className'))
  const integration = fs.readFileSync(new URL('../client-enhancements.mjs', import.meta.url), 'utf8')
  assert.ok(!integration.includes('slots.register'))
  assert.ok(integration.includes('primitives.DisclosureRow')); assert.ok(integration.includes('withStatistics(entry.component)'))
})
test('JSON labels distinguish reports and decisions without collapsing ordinary prose', () => {
  assert.equal(structuredLabel('{"executionReport":{}}'), '执行报告 · JSON')
  assert.equal(structuredLabel('{"verdict":"CURRENT"}'), '验收或复查结果 · JSON')
  assert.equal(structuredLabel('This is [ordinary prose].'), null)
  assert.deepEqual(structuredParts('Before\n```json\n{"outcome":"BLOCKED"}\n```\nAfter').map(part => Boolean(part.label)), [false, true, false])
})

test('compaction results retain their purpose and exact body across streaming, interruption and history reset', () => {
  const definition = executionChatDefinition(PartialArguments)
  const first = '## 压缩摘要\n', rest = '原始证据仍可检索。\n```json\n{"verdict":"CURRENT"}\n```'
  const row = { id: 'compact', kind: 'message', stage: 'compaction', step: 4, state: 'running', revision: 1,
    bytes: Buffer.byteLength(first), at: '2026-11-16T00:00:00Z' }
  const match = { event: event(row, first), location: { kind: 'session' } }
  const context = { key: 'display:compact', id: 'workflow:compact', start: match, state: definition.start({}, match) }
  let view = definition.buildViewNode(context)
  assert.equal(view.kind, 'assistant-step')
  assert.deepEqual(view.data.dynamicContextOutput, { kind: 'compaction', title: '上下文压缩结果（生成中） · 第 4 步' })
  context.state = definition.update(context, { event: event({ ...row, revision: 2, state: 'complete', bytes: Buffer.byteLength(first + rest) }, rest, { offset: row.bytes }) })
  view = definition.buildViewNode(context)
  assert.equal(view.key, 'display:compact')
  assert.equal(view.data.dynamicContextOutput.title, '上下文压缩结果 · 第 4 步')
  assert.deepEqual(view.data.blocks, [{ kind: 'text', text: first + rest }])
  for (const [state, title] of [['interrupted', '已中断'], ['error', '失败']]) {
    context.state = definition.start({}, { event: event({ ...row, state }, first, { offset: 20, reset: true }) })
    view = definition.buildViewNode(context)
    assert.ok(view.data.dynamicContextOutput.title.includes(title))
    assert.ok(view.data.blocks[0].text.startsWith('〔当前历史窗口中的输出片段〕'))
    assert.ok(view.data.blocks[0].text.endsWith(first))
  }
})

test('compaction disclosure is request metadata, not a classification guessed from prose or JSON', () => {
  const definition = executionChatDefinition(PartialArguments)
  for (const [stage, kind] of [['EXECUTING', 'message'], ['result_repair', 'message'], ['compaction', 'reasoning'], ['compaction', 'model']]) {
    const row = { id: stage + kind, stage, kind, step: 1, state: 'complete', revision: 1, bytes: 1, at: '2026-11-16T00:00:00Z' }
    const match = { event: event(row, '上下文压缩结果\n{"verdict":"CURRENT"}'), location: { kind: 'session' } }
    const view = definition.buildViewNode({ key: row.id, id: row.id, start: match, state: definition.start({}, match) })
    assert.equal(view.data.dynamicContextOutput, undefined)
  }
})

test('hierarchical roles use native chat blocks and distinguish folded decisions from final prose', () => {
  const definition=executionChatDefinition(PartialArguments)
  for(const stage of ['result_work','group_audit','scope_plan','scope_update','scope_audit','scope_blockage','scope_pause','task_reporter']) {
    const row={id:stage,kind:'message',stage,step:1,state:'complete',revision:1,bytes:6,at:'2026-11-16T00:00:00Z'}
    const match={event:event(row,'完成说明'),location:{kind:'session'}}
    const context={key:stage,id:stage,start:match,state:definition.start({},match)}
    const view=definition.buildViewNode(context)
    assert.equal(view.target,'chat');assert.equal(view.kind,'assistant-step')
    assert.equal(view.data.blocks[0].text,'完成说明')
  }
  assert.equal(structuredLabel('{"action":"COMPLETE","children":[]}'),'组级终审报告 · JSON')
  assert.equal(structuredLabel('{"action":"REVISE","modifications":[]}'),'分层蓝图修改报告 · JSON')
  assert.equal(structuredLabel('{"title":"结果","achievements":[],"verification":[]}'),'任务总结报告 · JSON')
  assert.equal(structuredLabel('任务总结\n\n已完成交付，保留获准限制。'),null)
})
