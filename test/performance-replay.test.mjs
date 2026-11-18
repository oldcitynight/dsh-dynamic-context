import test from 'node:test'
import assert from 'node:assert/strict'
import { performanceDefinition } from '../performance.mjs'
import { performanceSample, performanceSamples } from '../performance-state.mjs'
import { PERFORMANCE_EVENT, performanceView } from '../performance-common.mjs'

const event = (id, revision, seq, overrides = {}) => ({ type: PERFORMANCE_EVENT, ignorable: true, seq,
  data: { version: 1, sample: { id, revision, kind: 'request', group: 'turn-' + seq % 13,
    startedAt: seq % 29, firstTokenAt: 30, endedAt: 40, state: 'complete', source: 'direct',
    usage: { uncachedInputTokens: seq, outputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 0 }, ...overrides } } })

test('incremental revisions equal the original whole-table fold without mutating earlier cuts', () => {
  let state = performanceDefinition.init(), seq = 0
  const samples = {}, snapshots = []
  let seed = 79813
  const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed >>> 8) % n }
  for (let i = 0; i < 1500; i++) {
    const id = 'observation-' + random(180), revision = random(30)
    const kind = ['request', 'tool', 'aggregate', 'native-anchor'][random(4)]
    const e = event(id, revision, seq++, { kind, state: ['running', 'complete', 'interrupted'][random(3)],
      countsTurn: random(4) !== 0, toolMs: random(200), usage: random(3) ? undefined : {
        uncachedInputTokens: random(100), outputTokens: random(100), cacheReadTokens: 10, cacheWriteTokens: 0 },
      group: 'group-' + random(13), requests: random(5), missingUsage: random(2),
      stats: { turns: random(4), steps: random(5), llmMs: 100 } })
    if (!samples[id] || samples[id].revision < revision) samples[id] = { ...e.data.sample, order: e.seq }
    if (i % 200 === 0) snapshots.push([state, JSON.stringify(state)])
    state = performanceDefinition.apply(state, e)
    assert.deepEqual(state.view, performanceView(samples), 'revision ' + i)
  }
  for (const [prior, saved] of snapshots) assert.equal(JSON.stringify(prior), saved)
  const restored = performanceDefinition.stateSchema.parse(JSON.parse(JSON.stringify(state)))
  assert.deepEqual(restored.view, state.view)
  const next = event('new-after-reload', 1, seq, { startedAt: 10000 })
  samples[next.data.sample.id] = { ...next.data.sample, order: seq }
  assert.deepEqual(performanceDefinition.apply(restored, next).view, performanceView(samples))
})

test('current pressure changes correctly when the previous latest request changes kind or timestamp', () => {
  let state = performanceDefinition.init()
  const samples = {}
  for (const e of [event('a', 1, 1, { startedAt: 10 }), event('b', 1, 2, { startedAt: 20 }),
    event('a', 2, 3, { startedAt: 30 }), event('a', 3, 4, { kind: 'tool', toolMs: 10 }),
    event('b', 2, 5, { kind: 'aggregate', requests: 2, stats: { turns: 1 } }),
    event('__proto__', 1, 6, { startedAt: 50 }), event('constructor', 1, 7, { startedAt: 50 })]) {
    Object.defineProperty(samples, e.data.sample.id, { value: { ...e.data.sample, order: e.seq }, enumerable: true, writable: true, configurable: true })
    state = performanceDefinition.apply(state, e)
    assert.deepEqual(state.view, performanceView(samples))
  }
  assert.equal(performanceSample(state, '__proto__').id, '__proto__')
})

test('large histories keep bounded update paths and replay once across persisted cache reloads', { timeout: 10000 }, () => {
  let state = performanceDefinition.init()
  for (let i = 0; i < 20000; i++) state = performanceDefinition.apply(state, event('request-' + i, 1, i))
  assert.equal(performanceSamples(state).length, 20000)
  assert.ok(state.samples.height < 24)
  const old = state, oldSnapshot = JSON.stringify(old)
  const restored = performanceDefinition.stateSchema.parse(JSON.parse(oldSnapshot))
  const update = event('request-19999', 2, 20001, { state: 'interrupted', usage: null, endedAt: undefined })
  const next = performanceDefinition.apply(restored, update)
  assert.equal(next.view.requests, 20000)
  assert.equal(next.view.missingUsage, 1)
  assert.equal(next.view.stats.steps, 20000)
  assert.equal(performanceDefinition.apply(next, update), next)
  assert.equal(JSON.stringify(old), oldSnapshot)
  assert.equal(performanceDefinition.stateVersion, 2, 'the native cache invalidates the old dictionary layout')
  let copied = 0
  const countNew = (a, b) => { if (a === b || !b) return; copied++; countNew(a?.left, b.left); countNew(a?.right, b.right) }
  countNew(restored.samples, next.samples)
  assert.ok(copied <= state.samples.height, String(copied))
})
