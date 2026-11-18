import test from 'node:test'
import assert from 'node:assert/strict'
import { Config, validateConfig } from '../index.mjs'
import { withPreferences, readPreferences } from '../settings.mjs'
import { directRuntimeSchema } from '../direct-runtime.mjs'
import { permissionModes, effectivePermissions } from '../permissions.mjs'
const base = { projectRoot: '/workspace', directory: '/state', provider: 'fake', model: 'fake-llama', transport: 'direct', systemPrompt: 'Fixed host rules',
  direct: { endpoint: 'http://127.0.0.1:1/chat/completions', durable: true, runtime: {}, compaction: { strategy: 'dsh-native', contextWindow: 131072 } } }

test('native Settings exports editable preferences without dropping ordinary plugin configuration', () => {
  const parsed = Config['~standard'].validate(base)
  assert.equal(parsed.issues, undefined)
  assert.equal(parsed.value.systemPrompt, base.systemPrompt)
  assert.equal(typeof parsed.value.preferences.get, 'function')
  assert.equal(readPreferences(parsed.value.preferences).permissionMode, 'configured')
  assert.deepEqual(withPreferences(base), base)
  assert.equal(Config.dict.preferences.meta.volatile, true)
})

test('defaults inherit the owner and explicit plugin caps cannot exceed it', () => {
  const defaults = directRuntimeSchema.parse({})
  assert.equal(defaults.sandboxMode, 'auto'); assert.equal(defaults.approvalPolicy, 'auto')
  for (const mode of permissionModes) for (const approval of ['ask', 'never']) {
    assert.deepEqual(effectivePermissions(defaults, { mode, approval }, '/workspace'), { sandboxMode: mode, approvalPolicy: approval, plan: false, cwd: '/workspace' })
    assert.equal(effectivePermissions({ ...defaults, sandboxMode: 'read-only' }, { mode, approval }, '/workspace').sandboxMode, 'read-only')
  }
})

test('settings validate the complete effective config before accepting edits', () => {
  assert.ok(Config['~standard'].validate({ ...base, preferences: { contextWindow: 100 } }).issues)
  assert.ok(Config['~standard'].validate({ ...base, preferences: { unknown: true } }).value) // ignored by mapping; cannot alter host fields
  const reserved = { ...base, direct: { ...base.direct, reserveFinalReport: true }, preferences: { maxRequestsPerTask: 0 } }
  assert.ok(Config['~standard'].validate(reserved).issues.some(row => /finite request limit/.test(row.message)))
  const prefs = { permissionMode: 'auto', approvalPolicy: 'auto', maxGroupDepth: 5, contextWindow: 524288,
    maxRequestsPerTask: 0, timeoutMs: 0, maxContextCharacters: 0, maxReportCharacters: 0, maxToolOutputCharacters: 0, reasoningEffort: 'auto' }
  const parsed = Config['~standard'].validate({ ...base, preferences: prefs })
  assert.equal(parsed.issues, undefined)
  const applied = validateConfig(withPreferences(base, readPreferences(parsed.value.preferences)))
  assert.equal(applied.maxRequestsPerTask, null); assert.equal(applied.timeoutMs, null)
  assert.equal(applied.direct.compaction.contextWindow, 524288); assert.equal(applied.direct.contextWindow, 524288)
  assert.equal(applied.direct.runtime.maxToolOutputCharacters, null)
  assert.equal(applied.hierarchy.maxGroupDepth, 5)
})

test('native staged settings map only preference paths and preserve revision conflict protection', async () => {
  const { preferenceScope, preferenceFields } = await import('../settings-client.mjs')
  const { preferenceSchema } = await import('../settings.mjs')
  assert.deepEqual(preferenceFields.map(row => row.key).sort(), Object.keys(preferenceSchema.dict).sort())
  let write
  const scope = preferenceScope({ getSnapshot: () => ({ status: 'ready', writable: true, revision: 7,
    value: { preferences: { maxGroupDepth: 3 } }, base: { preferences: { maxGroupDepth: 0 } }, user: { preferences: { maxGroupDepth: 3 } } }),
    subscribe: () => () => {}, mutate: (...args) => { write = args; return true } })
  assert.equal(scope.getSnapshot().value.maxGroupDepth, 3)
  await scope.mutate([{ op: 'set', path: ['maxGroupDepth'], value: 5 }], 7)
  assert.deepEqual(write, [[{ op: 'set', path: ['preferences', 'maxGroupDepth'], value: 5 }], 7])
})
