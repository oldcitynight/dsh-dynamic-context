import test from 'node:test'
import assert from 'node:assert/strict'
import { Config, validateConfig } from '../index.mjs'
import { withPreferences, readPreferences } from '../settings.mjs'
import { directRuntimeSchema } from '../direct-runtime.mjs'
import { permissionModes, effectivePermissions } from '../permissions.mjs'
const base = { projectRoot: process.cwd(), directory: process.cwd() + '/.test-settings-state', provider: 'fake', model: 'fake-llama', transport: 'direct', systemPrompt: 'Fixed host rules',
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
  const applied = validateConfig(withPreferences({ ...base, workflowLimits: { maxDepth: 35 } }, readPreferences(parsed.value.preferences)))
  assert.equal(applied.maxRequestsPerTask, null); assert.equal(applied.timeoutMs, null)
  assert.equal(applied.direct.compaction.contextWindow, 524288); assert.equal(applied.direct.contextWindow, 524288)
  assert.equal(Object.hasOwn(applied.direct.runtime, 'maxToolOutputCharacters'), false)
  assert.equal(applied.workflowLimits.maxDepth, 35)
})

test('the settings form covers both deployment and preference paths and preserves nested siblings and revisions', async () => {
  const { configGroups } = await import('../settings-client.mjs')
  const { configFormScope, fieldSpec } = await import('dsh-better-task-grapth/settings-form')
  const fields = configGroups.flatMap(group => group.fields)
  const byKey = new Map(fields.map(field => [field.key, field]))
  assert.equal(byKey.size, fields.length)
  assert.deepEqual([...new Set([...byKey.keys()].map(key => key.split('.')[0]))].sort(), Object.keys(Config.dict).sort())
  for (const key of ['rolePolicy.modelBackends', 'rolePolicy.roleModels', 'rolePolicy.skills', 'rolePolicy.roleTools',
    'rolePolicy.toolErrors.rules', 'direct.runtime.approvalPolicy', 'direct.apiKeyEnv', 'workflowLimits.maxDepth', 'preferences.timeoutMs'])
    assert.ok(byKey.has(key), key)
  let written
  const scope = configFormScope({ getSnapshot: () => ({ value: { direct: { api: 'deepseek' }, workflowLimits: { maxUnits: 512 } },
    user: { direct: { api: 'deepseek' } }, revision: 7 }), mutate: (...args) => { written = args } }, fields)
  assert.equal(scope.getSnapshot().value['workflowLimits.maxUnits'], 512)
  assert.ok(!Object.hasOwn(scope.getSnapshot().user, 'workflowLimits.maxUnits'))
  await scope.mutate([{ op: 'set', path: ['workflowLimits.maxUnits'], value: 513 },
    { op: 'unset', path: ['direct.api'] }], 7)
  assert.deepEqual(written, [[{ op: 'set', path: ['workflowLimits','maxUnits'], value: 513 }, { op: 'unset', path: ['direct','api'] }], 7])
  await scope.mutate([{ op: 'set', path: ['direct.api'], value: 'deepseek' }, { op: 'set', path: ['direct'], value: {} }], 8)
  assert.deepEqual(written[0].map(op => op.path), [['direct'], ['direct','api']])
  const cleared = configFormScope({ getSnapshot: () => ({ value: { direct: {} }, user: { direct: { compaction: null } } }) }, fields)
  assert.equal(cleared.getSnapshot().value['direct.compaction'], null)
  assert.equal(fieldSpec(byKey.get('rolePolicy.modelBackends')).parse('{'), undefined)
  assert.equal(fieldSpec(byKey.get('workflowLimits.maxUnits')).parse('0'), undefined)
  assert.deepEqual(fieldSpec(byKey.get('timeoutMs')).parse('null'), { kind: 'set', value: null })
  assert.equal(fieldSpec(byKey.get('direct.compaction')).parse('null').value, null)
})
