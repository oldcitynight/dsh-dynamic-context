import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { RoleModelRegistry, bindRoleModel } from '../role-models.mjs'
import { ROLE_CONTRACTS } from '../role-policy.mjs'
import { createRolePolicies } from '../role-configuration.mjs'
import { directRevisionRole, readRoleRecord } from '../revision-runtime.mjs'
import { validateConfig } from '../index.mjs'
import { COMPACTION_INSTRUCTION } from '../dsh-compaction-policy.mjs'
import { startFakeLlama } from '../testing/fake-llama.mjs'
import { startFakeMessages } from '../testing/fake-messages.mjs'
import { createRuntimeHarness, runtimeProposal } from '../testing/runtime-harness.mjs'

const selectable = Object.keys(ROLE_CONTRACTS).filter(role => role !== 'compaction')
const auxiliary = selectable.filter(role => !['controller', 'preplanning', 'executor', 'result_work'].includes(role))
const registration = { pluginId: 'a', registrationId: 'choice', role: 'reviewer' }
const check = (code, fn) => assert.throws(fn, { code })
const endpoint = 'http://127.0.0.1:1/v1/chat/completions'
const base = (root, direct = {}) => validateConfig({ dynamicContextMaxBytes: 8388608, projectRoot: root, directory: root, transport: 'direct',
  provider: 'global-api', model: 'original', systemPrompt: 'Inspect evidence.',
  revision: { policy: { objective: 'Check', requirements: [{ id: 'a', text: 'Check evidence' }] }, maxOutputTokens: 32768 },
  direct: { endpoint, durable: true, apiKeyEnv: 'ORIGINAL_KEY', compaction: { strategy: 'dsh-native', contextWindow: 262144 }, ...direct } })
const request = (role, data = {}) => ({ role, runId: 'revision_' + role + '_' + randomUUID(), signal: new AbortController().signal,
  messages: [{ role: 'system', content: 'Review the supplied evidence.' }, { role: 'user', content: JSON.stringify(data) }] })

test('every independently callable role can select a named or inline backend in the policy file', t => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'model-policy-'))
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }))
  fs.writeFileSync(path.join(projectRoot, 'policy.json'), JSON.stringify({ version: 1, modelBackends: { custom: { model: 'chosen' } },
    roleModels: Object.fromEntries(selectable.map(role => [role, role === 'updater' ? { model: 'inline' } : 'custom'])) }))
  const { models } = createRolePolicies({ projectRoot, rolePolicyFile: 'policy.json' })
  for (const role of selectable) assert.equal(models.resolve(role).backend.model, role === 'updater' ? 'inline' : 'chosen')
  assert.equal(models.list().inherited.compaction, 'triggering-role')
  check('ROLE_MODEL_INHERITED', () => new RoleModelRegistry({}, { compaction: { model: 'separate' } }))
  check('ROLE_MODEL_INHERITED', () => models.register({ ...registration, role: 'compaction', backend: 'custom' }))
  check('ROLE_MODEL_BACKEND_UNKNOWN', () => models.register({ ...registration, backend: 'missing' }))
  check('ROLE_NATIVE_PROVIDER_REQUIRED', () => models.register({ ...registration, role: 'controller', backend: { model: 'm', direct: { endpoint } } }))
  assert.throws(() => new RoleModelRegistry({ private: { model: 'm', direct: { endpoint, apiKey: 'literal' } } }))
  assert.throws(() => new RoleModelRegistry({}, { typo: 'custom' }))
  assert.equal(new RoleModelRegistry().resolve('executor'), null)
})

test('scoped plugin choices resolve deterministically, support disposal, and leave file defaults and inspection immutable', () => {
  const models = new RoleModelRegistry({ manual: { model: 'manual' } }, { reviewer: 'manual' })
  const scope = { workflowId: 'wf', sessionId: 's', taskId: 't', scopeId: 'group' }
  const put = (pluginId, model, priority, additional = {}) => models.register({ ...registration, pluginId, priority, backend: { model }, ...additional })
  const dispose = put('z', 'tie-winner', 2, { scope })
  put('a', 'tie-loser', 2)
  const top = put('b', 'higher-priority', 4, { scope })
  assert.equal(models.resolve('reviewer', scope).backend.model, 'higher-priority')
  top()
  assert.equal(models.resolve('reviewer', scope).backend.model, 'tie-winner')
  for (const field of Object.keys(scope)) assert.equal(models.resolve('reviewer', { ...scope, [field]: 'other' }).backend.model, 'tie-loser')
  assert.throws(() => { models.resolve('reviewer', scope).backend.model = 'mutated' }, TypeError)
  models.list().registrations.splice(0)
  assert.equal(models.list().registrations.length, 2)
  dispose()
  const replacement = put('z', 'new-registration', 8, { scope })
  dispose()
  assert.equal(models.resolve('reviewer', scope).backend.model, 'new-registration')
  replacement()
  assert.equal(models.resolve('reviewer', scope).source.pluginId, 'a')
})

test('a Direct route binds a whole connection, preserves operational limits and verifies its saved receipt', () => {
  const config = base('/workspace', { responseModelAliases: ['old-alias'], generation: { seed: 7 } })
  const model = { provider: 'new-api', model: 'alternate', direct: { endpoint: 'http://127.0.0.1:2/v1/chat/completions' } }
  const runner = { roleModels: new RoleModelRegistry({}, { reviewer: model }) }
  const route = bindRoleModel(runner, 'reviewer', {}, config)
  assert.equal(route.config.direct.apiKeyEnv, undefined)
  assert.deepEqual(route.config.direct.generation, {})
  assert.deepEqual(route.config.direct.responseModelAliases, [])
  assert.deepEqual(route.config.direct.compaction, config.direct.compaction)
  assert.equal(route.config.direct.maxRequestBytes, config.direct.maxRequestBytes)
  check('ROLE_MODEL_RECEIPT_CHANGED', () => bindRoleModel(runner, 'reviewer', {}, config, { ...route.receipt, model: 'changed' }))
  check('ROLE_MODEL_RECEIPT_CHANGED', () => bindRoleModel(runner, 'updater', {}, config, route.receipt))
  assert.deepEqual(bindRoleModel({}, 'reviewer', {}, config, route.receipt), route)
  assert.equal(bindRoleModel(runner, 'reviewer', {}, config, null).config, config)
  runner.roleModels = new RoleModelRegistry({}, { reviewer: { provider: 'other-provider', model: 'other' } })
  check('ROLE_MODEL_ENDPOINT_REQUIRED', () => bindRoleModel(runner, 'reviewer', {}, config))
  runner.roleModels = new RoleModelRegistry({}, { reviewer: { model: 'other' } })
  const shared = bindRoleModel(runner, 'reviewer', {}, config).config
  assert.equal(shared.direct.apiKeyEnv, 'ORIGINAL_KEY')
  assert.deepEqual(shared.direct.responseModelAliases, [])
})

test('all auxiliary roles send their selected model to a distinct HTTP backend', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'all-role-models-'))
  const server = await startFakeLlama({ respond: () => ({ text: '{"observed":true}' }) })
  t.after(async () => { await server.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const runner = { ctx: { get() {} }, config: base(root), roleModels: new RoleModelRegistry({}, Object.fromEntries(auxiliary.map(role =>
    [role, { model: role + '-model', provider: 'role-api', direct: { endpoint: server.origin + '/v1/chat/completions' } }]))) }
  for (const role of auxiliary) {
    const input = request(role)
    assert.equal((await directRevisionRole(runner, input)).observed, true)
    assert.equal(server.requests.at(-1).payload.model, role + '-model')
    const record = readRoleRecord(runner, input.runId)
    assert.equal(record.modelRoute.role, role)
    assert.equal(record.modelRoute.source.kind, 'config')
  }
  assert.equal(server.requests.length, auxiliary.length)
  assert.deepEqual(server.errors, [])
})

for (const role of ['reviewer', 'unit_router', 'baseline_audit']) test(role + ' and its compaction keep their Messages endpoint, model and credential through pause and reconfiguration', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-model-'))
  let pause = false
  const summarizing = payload => payload.messages.at(-1).content.at(-1).text?.startsWith(COMPACTION_INSTRUCTION)
  const review = await startFakeMessages({ respond: ({ payload }) => {
    if (summarizing(payload)) { pause = true; return { text: 'Reviewed the archived evidence.' } }
    return { text: '{"observed":true}' }
  } })
  const next = await startFakeLlama({ respond: () => ({ text: '{"changed":true}' }) })
  t.after(async () => { await review.close(); await next.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const registry = new RoleModelRegistry(), keys = []
  const runner = { roleModels: registry, config: base(root, { endpoint: next.origin + '/v1/chat/completions' }),
    ctx: { get: name => name === 'credentials' ? { resolve: async key => { keys.push(key); return { value: 'test-' + key } } } : undefined },
    workflowControl: { beforeRequest() { if (pause) throw Object.assign(new Error('pause'), { code: 'WORKFLOW_PAUSE_REQUESTED' }) } } }
  const remove = registry.register({ ...registration, role, backend: { model: 'review-model', provider: 'review-api',
    direct: { endpoint: review.origin + '/v1/messages', api: 'deepseek', protocol: 'messages', apiKeyEnv: 'REVIEW_KEY', reasoningEffort: 'low' } } })
  const input = request(role, { evidence: 'large evidence '.repeat(24000) })
  await assert.rejects(directRevisionRole(runner, input), { code: 'WORKFLOW_PAUSE_REQUESTED' })
  const previous = readRoleRecord(runner, input.runId)
  assert.equal(previous.phase, 'PAUSED')
  assert.ok(previous.calls.some(row => row.purpose === 'compaction' && row.response))
  remove()
  runner.workflowControl.beforeRequest = () => {}
  assert.equal((await directRevisionRole(runner, input)).observed, true)
  assert.equal(next.requests.length, 0)
  assert.ok(review.requests.some(row => !summarizing(row.payload)))
  assert.ok(review.requests.every(row => row.payload.model === 'review-model' && row.path === '/v1/messages'
    && row.headers['x-api-key'] === 'test-REVIEW_KEY' && row.payload.output_config.effort === 'low'))
  assert.ok(keys.every(key => key === 'REVIEW_KEY'))
  assert.equal(new Set(review.requests.map(row => row.rawBody)).size, review.requests.length)
  const saved = readRoleRecord(runner, input.runId)
  assert.deepEqual(saved.modelRoute, previous.modelRoute)
  assert.ok(!JSON.stringify(saved).includes('test-REVIEW_KEY'))
  assert.equal((await directRevisionRole(runner, request(role))).changed, true)
  assert.equal(next.requests.length, 1)
  assert.equal(next.requests[0].payload.model, 'original')
  assert.deepEqual(review.errors, [])
})

test('a changed policy file affects the next reviewer while SQLite restores the paused reviewer and its original API', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-role-model-')))
  const projectRoot = path.join(root, 'project'), directory = path.join(root, 'state')
  fs.mkdirSync(projectRoot)
  const policy = path.join(projectRoot, 'roles.json')
  let pause = false, h
  const a = await startFakeLlama({ respond: ({ payload }) => {
    if (payload.messages.at(-1).content?.startsWith?.(COMPACTION_INSTRUCTION)) { pause = true; return { text: 'Evidence checkpoint.' } }
    return { text: '{"from":"A"}' }
  } })
  const b = await startFakeLlama({ respond: () => ({ text: '{"from":"B"}' }) })
  t.after(async () => { await h?.close(); await a.close(); await b.close(); fs.rmSync(root, { recursive: true, force: true }) })
  function select(model, api) {
    fs.writeFileSync(policy, JSON.stringify({ version: 1, modelBackends: { audit: { provider: 'audits', model,
      direct: { endpoint: api.origin + '/v1/chat/completions' } } }, roleModels: { reviewer: 'audit' } }))
  }
  const open = () => createRuntimeHarness({ projectRoot, directory, backend: b, config: { storageRoot: root, storageFormat: 'sqlite',
    rolePolicyFile: 'roles.json', dynamicContextMaxBytes: 8388608, direct: { durable: true, compaction: { strategy: 'dsh-native', contextWindow: 262144 } },
    revision: { policy: { objective: 'Inspect', requirements: [{ id: 'a', text: 'Check evidence' }] }, maxOutputTokens: 32768 } } })
  select('audit-a', a)
  h = await open()
  h.runner.submit(runtimeProposal([]))
  h.runner.workflowControl = { beforeRequest() { if (pause) throw Object.assign(new Error('pause'), { code: 'WORKFLOW_PAUSE_REQUESTED' }) } }
  const input = request('reviewer', { evidence: 'large evidence '.repeat(24000) })
  await assert.rejects(directRevisionRole(h.runner, input), { code: 'WORKFLOW_PAUSE_REQUESTED' })
  const recordPath = 'revisions/' + input.runId + '/role.json'
  const pinned = JSON.parse(h.runner.storage.db.read(recordPath)).modelRoute
  assert.equal(pinned.source.kind, 'config')
  assert.equal(pinned.model, 'audit-a')
  assert.equal(fs.existsSync(path.join(directory, recordPath)), false)
  await h.close()
  select('audit-b', b)
  h = await open()
  assert.equal(h.ctx.get('dynamicContextRoleModels').resolve('reviewer').backend.model, 'audit-b')
  assert.equal((await directRevisionRole(h.runner, input)).from, 'A')
  assert.deepEqual(readRoleRecord(h.runner, input.runId).modelRoute, pinned)
  assert.equal(b.requests.length, 0)
  assert.equal((await directRevisionRole(h.runner, request('reviewer'))).from, 'B')
  assert.equal(b.requests[0].payload.model, 'audit-b')
  assert.ok(a.requests.every(row => row.payload.model === 'audit-a'))
})
