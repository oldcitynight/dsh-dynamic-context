import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Session } from '@deepseek-ai/dsh-session'
import { markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { performanceDefinition, RequestPerformance } from '../performance.mjs'
import { performanceSample, performanceSamples } from '../performance-state.mjs'
import { performanceProjection, normalizeUsage, PERFORMANCE_EVENT } from '../performance-common.mjs'
import { importWorkflowPerformance, historicalNativeTotals } from '../performance-history.mjs'
const wire = (id, revision, overrides = {}) => ({ type: PERFORMANCE_EVENT, ignorable: true, seq: revision, data: { version: 1,
  sample: { id, revision, kind: 'request', group: 'leaf', source: 'direct', startedAt: 100, firstTokenAt: 200,
    endedAt: 1200, state: 'complete', contextWindow: 1000000, usage: normalizeUsage({ prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 60 }), ...overrides } } })
test('all request stages sum distinct buckets once; TPS is token-weighted and windows are never added', () => {
  let state = performanceDefinition.init()
  const stages = ['PREPLANNING', 'EXECUTING', 'result_repair', 'result_check', 'plan_check', 'updater', 'reviewer', 'compaction']
  for (const [i, source] of stages.entries()) {
    const event = wire('req' + i, 1, { source, group: source, startedAt: 100 + i, firstTokenAt: 200 + i, endedAt: 1200 + i })
    state = performanceDefinition.apply(state, event)
    assert.equal(performanceDefinition.apply(state, event), state)
  }
  const merged = performanceProjection('tokenUsage', { uncachedInputTokens: 10, outputTokens: 5, cacheReadTokens: 5, cacheWriteTokens: 0 }, state.view)
  assert.deepEqual(merged, { uncachedInputTokens: 330, outputTokens: 165, cacheReadTokens: 485, cacheWriteTokens: 0 })
  assert.equal(state.view.stats.steps, 8); assert.equal(state.view.stats.turns, 8)
  assert.equal(state.view.stats.decodeTokens / (state.view.stats.decodeMs / 1000), 20)
  assert.deepEqual(performanceProjection('contextPressure', { contextWindow: 500, pressureTokens: 400 }, state.view),
    { contextWindow: 1000000, pressureTokens: 100, projectedTokens: 100 })
  state = performanceDefinition.apply(state, wire('req7', 2, { source: 'compaction', startedAt: 107, usage: null, state: 'interrupted' }))
  assert.equal(state.view.missingUsage, 1); assert.equal(state.view.usage.outputTokens, 140)
  const replay = JSON.parse(JSON.stringify(state))
  assert.equal(performanceDefinition.apply(replay, wire('req7', 1)), replay)
  state = performanceDefinition.apply(state, wire('main', 1, { kind: 'native-anchor', startedAt: 1300 }))
  assert.deepEqual(performanceProjection('contextPressure', { pressureTokens: 50, contextWindow: 200 }, state.view), { pressureTokens: 50, contextWindow: 200 })
})
test('OpenAI inclusive prompt tokens and native disjoint buckets normalize equally', () => {
  assert.deepEqual(normalizeUsage({ prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 60 }),
    normalizeUsage({ inputTokens: 40, outputTokens: 20, cacheReadTokens: 60 }, true))
  assert.equal(normalizeUsage({ prompt_tokens: 10, completion_tokens: 1, prompt_cache_hit_tokens: 20 }), null)
})
test('observation records stay outside model input; ordinary forks are not charged to their parent', () => {
  const root = Session.create('root'), child = Session.create('child', undefined, { version: 4, createdAt: 0, id: 'child', parentSession: 'root', origin: 'subagent', isSeeded: false }), fork = Session.create('fork', undefined, { version: 4, createdAt: 0, id: 'fork', parentSession: 'root', isSeeded: false })
  const sessions = new Map([root, child, fork].map(session => [session.id, session]))
  const monitor = new RequestPerformance({ sessions: { get: id => sessions.get(id), flush: async () => {} } })
  const before = root.deriveMessages()
  const call = monitor.begin(child, 'request', { group: 'child:1' }); call.delta({ reasoning: 'x' }); call.end('complete', { prompt_tokens: 100, completion_tokens: 10 })
  assert.deepEqual(root.deriveMessages(), before)
  assert.equal(root.snapshotEvents().filter(event => event.type === PERFORMANCE_EVENT).length, 2)
  assert.equal(child.snapshotEvents().filter(event => event.type === PERFORMANCE_EVENT).length, 2)
  monitor.begin(fork, 'forkrequest').end('complete')
  assert.equal(root.snapshotEvents().length, 2)
})

test('native auxiliary calls and nested background sessions count once; process recovery does not invent timing', async () => {
  const root = Session.create('root'), child = Session.create('child', undefined,
    { version: 4, createdAt: 0, id: 'child', isSeeded: false, parentSession: 'root', origin: 'subagent' })
  const grandchild = Session.create('grandchild', undefined,
    { version: 4, createdAt: 0, id: 'grandchild', isSeeded: false, parentSession: 'child', origin: 'subagent' })
  const sessions = new Map([root, child, grandchild].map(row => [row.id, row])), hooks = {}
  const stateOf = session => session.snapshotEvents().reduce((state, event) => performanceDefinition.apply(state, event), performanceDefinition.init())
  const monitor = new RequestPerformance({ on: (name, callback) => { hooks[name] = callback },
    sessions: { get: id => sessions.get(id), list: () => [], flush: async () => {} },
    sessionProjections: { register() {}, stateOf, snapshot: () => ({ values: { contextPressure: { contextWindow: 32768, pressureTokens: 20 } } }) } })
  monitor.install()
  async function run(sessionId, purpose, finish = 'stop', native = !purpose) {
    const next = async function* () { yield { type: 'text-delta', text: 'result' }; yield { type: 'usage', usage: { inputTokens: 40, outputTokens: 10, cacheReadTokens: 60 } }; yield { type: 'finish', reason: { kind: finish } } }
    const request = { sessionId, purpose }
    for await (const _ of hooks['llm/stream'](native ? markAgentLoopRequest(request) : request, next)) {}
  }
  await run('root'); await run('root', 'session-title'); await run('root', 'compaction')
  await run('child'); await run('grandchild', undefined, 'error'); await run('root', undefined, 'stop', false)
  const value = stateOf(root).view
  assert.equal(value.requests, 5); assert.equal(value.usage.outputTokens, 50)
  assert.equal(value.stats.turns, 2, 'own auxiliary calls do not invent another native turn; child turns count once')
  assert.equal(stateOf(child).view.requests, 1)
  assert.equal(performanceSamples(stateOf(root)).find(row => row.sessionId === 'grandchild').state, 'interrupted')
  monitor.begin(root, 'unfinished', { group: 'leaf' }).progress({ usage: { prompt_tokens: 12, completion_tokens: 3 } })
  monitor.recover(root)
  const recovered = stateOf(root)
  assert.equal(recovered.view.running, 0)
  assert.equal(performanceSample(recovered, 'unfinished').endedAt, undefined)
  assert.equal(performanceSample(recovered, 'unfinished').usage.outputTokens, 3)
  monitor.ctx.sessionProjections.snapshot = () => { throw Error('observation unavailable') }
  await run('root', 'session-title') // An observation failure must never break the model stream.
})

test('old trace/role/native receipts backfill once without editing evidence or fabricating TPS', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'performance-history-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.mkdirSync(path.join(directory, 'attempt_old')); fs.mkdirSync(path.join(directory, 'revisions/old'), { recursive: true })
  const trace = JSON.stringify({ requests: [{ ordinal: 1, purpose: 'task', status: 'COMPLETE', usage: { prompt_tokens: 100, completion_tokens: 10 } },
    { ordinal: 2, purpose: 'task', status: 'UNKNOWN_OR_FAILED' }], events: [
    { type: 'tool/call', time: 100, data: { callId: 'c' } }, { type: 'tool/result', time: 150, data: { callId: 'c' } }] })
  const role = JSON.stringify({ runId: 'old', role: 'result_check', calls: [{ sequence: 1, phase: 'COMPLETE', response: { usage: { prompt_tokens: 50, completion_tokens: 5 } } }] })
  fs.writeFileSync(path.join(directory, 'attempt_old/trace.json'), trace); fs.writeFileSync(path.join(directory, 'revisions/old/role.json'), role)
  const owner = Session.create('owner'), stateOf = () => owner.snapshotEvents().reduce((state, event) => performanceDefinition.apply(state, event), performanceDefinition.init())
  const ctx = { sessions: { get: id => id === owner.id ? owner : undefined, flush: async () => {} }, sessionProjections: { stateOf } }
  const monitor = new RequestPerformance(ctx); ctx.get = name => name === 'dynamicContextPerformance' ? monitor : undefined
  const runner = { ctx, workflowId: 'workflow', controller: { session: owner }, config: { directory } }
  await importWorkflowPerformance(runner, Date.now() + 1000)
  assert.equal(stateOf().view.requests, 3); assert.equal(stateOf().view.stats.steps, 3); assert.equal(stateOf().view.stats.turns, 2)
  assert.equal(stateOf().view.usage.outputTokens, 15); assert.equal(stateOf().view.missingUsage, 1)
  assert.equal(stateOf().view.stats.decodeMs, 0); assert.equal(stateOf().view.stats.toolMs, 50)
  const count = owner.snapshotEvents().length
  await importWorkflowPerformance(runner, Date.now() + 1000)
  assert.equal(owner.snapshotEvents().length, count)
  assert.equal(fs.readFileSync(path.join(directory, 'attempt_old/trace.json'), 'utf8'), trace)
  assert.equal(fs.readFileSync(path.join(directory, 'revisions/old/role.json'), 'utf8'), role)
  const sample = (type, inputTokens) => ({ type, time: 10, data: { turn: 1, step: 1, usage: { inputTokens, outputTokens: 5 } } })
  const native = historicalNativeTotals([sample('assistant/attempt', 10), sample('assistant/message', 10),
    { type: 'llm/retry-started', data: { turn: 1, step: 1 } }, sample('assistant/message', 20)])
  assert.equal(native.usage.uncachedInputTokens, 30); assert.equal(native.usage.outputTokens, 10); assert.equal(native.requests, 2)
})

test('hierarchical roles and their compaction participate in the same native performance totals', () => {
  const roles=['group_audit','scope_plan','scope_update','scope_audit','scope_blockage','scope_pause','task_reporter','compaction']
  let state=performanceDefinition.init()
  for(const [i,role] of roles.entries()) {
    const event=wire('hierarchy-'+role,1,{source:'direct',group:role,stage:role,startedAt:100+i,firstTokenAt:200+i,endedAt:1200+i})
    state=performanceDefinition.apply(state,event)
    assert.equal(performanceDefinition.apply(state,event),state)
  }
  assert.equal(state.view.requests,8);assert.equal(state.view.stats.steps,8)
  assert.deepEqual(state.view.usage,{uncachedInputTokens:320,outputTokens:160,cacheReadTokens:480,cacheWriteTokens:0})
  assert.equal(state.view.stats.decodeTokens/(state.view.stats.decodeMs/1000),20)
  assert.equal(performanceProjection('contextPressure',null,state.view).contextWindow,1000000)
})

test('a direct request without a native request header gets the exact model window only once', async () => {
  let lookups = 0
  const session = Session.create('direct-without-native-model-header')
  const monitor = new RequestPerformance({
    sessions: { get: () => session, flush: async () => {} },
    llm: { resolveModelInfo: async (provider, model) => {
      assert.deepEqual([provider, model], ['fixture', 'exact'])
      lookups++
      return { context: { contextWindow: 32768 } }
    } }
  })
  const meta = { config: { provider: 'fixture', model: 'exact', direct: {} }, payload: { messages: [] } }
  for (let i=0;i<2;i++) monitor.direct({session}, 'request-'+i, meta).end('complete')
  await new Promise(resolve => setImmediate(resolve))
  const samples = session.snapshotEvents().filter(event => event.type === PERFORMANCE_EVENT).map(event => event.data.sample)
  for (let i=0;i<2;i++) {
    const last = samples.findLast(row => row.id === 'request-'+i)
    assert.equal(last.contextWindow, 32768)
    assert.equal(last.state,'complete')
  }
  assert.equal(lookups,1)
})
