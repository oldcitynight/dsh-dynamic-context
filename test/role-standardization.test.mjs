// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRolePolicies } from '../role-configuration.mjs'
import { ROLE_CONTRACTS, ROLE_CONTEXT_SLOTS } from '../role-policy.mjs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createScope } from '@deepseek-ai/dsh-scope'
import { ToolErrorPolicy, matchToolErrorRules } from '../tool-error-policy.mjs'
import { createHarness } from '../testing/harness.mjs'
import { runtimeProposal } from '../testing/runtime-harness.mjs'
import { directRevisionRole } from '../revision-runtime.mjs'

function files(t, config) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-role-policy-')))
  let harness
  t.after(async () => {
    try { await harness?.close() } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })
  const projectRoot = path.join(root, 'project'), folder = path.join(root, 'policies')
  fs.mkdirSync(folder)
  fs.mkdirSync(projectRoot)
  fs.writeFileSync(path.join(folder, 'SKILL.md'), '---\nname: fixture-skill\ndescription: fixture metadata\n---\nSTATIC_ROLE_BODY\n')
  const rolePolicyFile = '../policies/roles.json'
  fs.writeFileSync(path.join(folder, 'roles.json'), JSON.stringify({ version: 1, ...config }))
  return { projectRoot, rolePolicyFile, storageRoot: root, directory: path.join(root, 'ledger'), manage(value) { harness = value } }
}
const action = value => ({ toolId: 'records', when: { '/operation': value } })
const issue = (operation, extra = {}) => ({ id: 'call', function: { name: 'records', arguments: JSON.stringify({ operation, ...extra }) } })
const scope = { workflowId: 'workflow_a' }

test('all role context slots support static Skill bodies, scoped providers, immutable snapshots and disposal', t => {
  const skills = Object.entries(ROLE_CONTEXT_SLOTS).flatMap(([role, slots]) =>
    slots.map(slot => ({ role, slot, file: 'SKILL.md' })))
  const options = files(t, { skills }), { prompts } = createRolePolicies(options)
  assert.deepEqual(Object.keys(ROLE_CONTEXT_SLOTS), Object.keys(ROLE_CONTRACTS))
  let version = 1
  for (const { role, slot } of skills) {
    const dispose = prompts.registerProvider({ role, slot, scope, pluginId: 'adapter', registrationId: role + '_' + slot, mode: 'append',
      assemble(input) {
        assert.deepEqual(input, { role, slot, scope, defaultText: 'ORIGINAL' })
        return 'DYNAMIC_' + version
      } })
    const snapshot = prompts.resolve(role, 'ORIGINAL', scope, slot)
    assert.match(snapshot.content, /STATIC_ROLE_BODY\n\nDYNAMIC_1/)
    assert.doesNotMatch(snapshot.content, /fixture metadata|ORIGINAL/)
    version = 2
    assert.match(prompts.resolve(role, 'ORIGINAL', scope, slot).content, /DYNAMIC_2/)
    assert.doesNotMatch(prompts.resolve(role, 'ORIGINAL', {}, slot).content, /DYNAMIC_/)
    dispose(); dispose()
    assert.doesNotMatch(prompts.resolve(role, 'ORIGINAL', scope, slot).content, /DYNAMIC_/)
    assert.match(snapshot.content, /DYNAMIC_1/)
    version = 1
  }
  assert.throws(() => prompts.register({ pluginId: 'x', registrationId: 'bad', role: 'controller', slot: 'archive', mode: 'replace', text: 'bad' }), /ROLE_CONTEXT_SLOT_INVALID/)
  fs.unlinkSync(path.join(options.storageRoot, 'policies', 'SKILL.md'))
  assert.throws(() => createRolePolicies(options), /ENOENT/)
})

test('file and plugin allow rules combine per operation, denials win and disposal cannot widen an issued call', async t => {
  const { tools } = createRolePolicies(files(t, { roleTools: [
    { role: 'group_audit', mode: 'whitelist', tools: [action('read')] },
    { role: 'group_audit', mode: 'blacklist', tools: [{ toolId: 'records', when: { '/options/secret': true } }] }
  ] }))
  const base = { pluginId: 'adapter', role: 'group_audit', scope }
  const allow = tools.register({ ...base, registrationId: 'list', mode: 'whitelist', tools: [action('list')] })
  const executed = []
  const builtins = { tools: [{ type: 'function', function: { name: 'records', parameters: { type: 'object' } } }],
    execute(call) { executed.push(JSON.parse(call.function.arguments)); return 'read' } }
  const view = tools.tools('group_audit', builtins, scope)
  await view.execute(issue('read'))
  await view.execute(issue('list'))
  await assert.rejects(view.execute(issue('list', { options: { secret: true } })), /ROLE_TOOL_DENIED/)
  await assert.rejects(view.execute(issue('edit')), /ROLE_TOOL_DENIED/)
  allow()
  await assert.rejects(view.execute(issue('list')), /ROLE_TOOL_DENIED/)
  tools.register({ ...base, registrationId: 'whole', mode: 'whitelist', tools: ['records'] })
  await assert.rejects(view.execute(issue('edit')), /ROLE_TOOL_DENIED/)
  assert.deepEqual(executed, [{ operation: 'read' }, { operation: 'list' }])
  assert.throws(() => tools.register({ ...base, registrationId: 'bad', mode: 'blacklist', tools: [{ toolId: 'records', when: { '/__proto__/x': true } }] }))
})

test('whole-tool, typed and inverse error policies distinguish successful calls from errors for every role', t => {
  const { errors } = createRolePolicies(files(t, { toolErrors: { mode: 'blacklist', rules: [
    'wild', { toolId: 'typed', errorType: 'StorageError', errorCode: 'E_IO' } ] } }))
  const failure = { isError: true, error: { info: { code: 'E_IO', name: 'StorageError' } } }
  for (const role of Object.keys(ROLE_CONTRACTS)) {
    const match = (id, result) => matchToolErrorRules(errors.snapshot(), id, result, [], role)
    assert.ok(match('wild', { isError: true }))
    assert.ok(match('wild', { value: { status: 'ERROR', code: 'MISSING' } }))
    assert.equal(match('wild', { value: 'SUCCESS' }), null)
    assert.ok(match('typed', failure))
    assert.equal(match('typed', { error: { info: { code: 'E_IO', name: 'Other' } } }), null)
    assert.equal(match('other', failure), null)
  }
  const inverse = new ToolErrorPolicy({ mode: 'whitelist', includeDefaults: false })
  inverse.register({ pluginId: 'p', ruleId: 'agent', list: 'whitelist', toolId: 'read' })
  assert.equal(matchToolErrorRules(inverse.snapshot(), 'read', failure), null)
  assert.ok(matchToolErrorRules(inverse.snapshot(), 'other', failure))
  assert.equal(matchToolErrorRules(inverse.snapshot(), 'other', { isError: false }), null)
  inverse.register({ pluginId: 'p', ruleId: 'bad-store', toolId: 'read', errorCode: 'E_IO' })
  assert.ok(matchToolErrorRules(inverse.snapshot(), 'read', failure))
  const configuredInverse = createRolePolicies(files(t, { toolErrors: { mode: 'whitelist', rules: ['wild'] } })).errors.snapshot()
  assert.equal(matchToolErrorRules(configuredInverse, 'wild', failure), null)
  assert.ok(matchToolErrorRules(configuredInverse, 'other', failure))
})

test('real role requests replace distributed instructions while preserving task facts and host output checks', async t => {
  const options = files(t, { skills: ['executor', 'reviewer'].map(role => ({ role, file: 'SKILL.md' })) })
  const { projectRoot, directory, storageRoot, rolePolicyFile, manage } = options
  let role = 'executor', assembled = 0
  const h = await createHarness({ projectRoot, directory, config: { transport: 'direct', storageRoot, rolePolicyFile },
    respond({ payload }) {
      const text = JSON.stringify(payload.messages)
      assert.match(text, /STATIC_ROLE_BODY/)
      if (role === 'executor') {
        assert.match(text, /LIVE_BOUND_FACT/)
        assert.doesNotMatch(text, /Execute the active task from the following managed context/)
        return { text: 'Observed the bound fact.' }
      }
      assert.match(payload.messages[0].content, /REGISTERED_REVIEW_CONTEXT/)
      assert.doesNotMatch(payload.messages[0].content, /ORIGINAL_REVIEW_GUIDANCE/)
      assert.equal(JSON.parse(payload.messages[1].content).evidence, 'LIVE_AUDIT_FACT')
      return { text: '{"checked":true}' }
    } })
  manage(h)
  h.ctx.get('dynamicContextRolePrompts').registerProvider({ pluginId: 'context_plugin', registrationId: 'audit', role: 'reviewer',
    mode: 'append', assemble() { assembled++; return 'REGISTERED_REVIEW_CONTEXT' } })
  const graph = runtimeProposal([])
  graph.contextGraph.nodes[0].content = 'LIVE_BOUND_FACT'
  h.runner.submit(graph)
  await h.runner.runNext({ expectedRevision: 1 })
  role = 'reviewer'
  const request = { runId: 'revision_reviewer_' + randomUUID(), role, signal: new AbortController().signal,
    messages: [{ role: 'system', content: 'ORIGINAL_REVIEW_GUIDANCE' }, { role: 'user', content: '{"evidence":"LIVE_AUDIT_FACT"}' }] }
  assert.deepEqual(await directRevisionRole(h.runner, request), { checked: true })
  await directRevisionRole(h.runner, request)
  assert.equal(assembled, 1)
})

test('Direct rejects a partially forbidden batch before its first effect and then dispatches the allowed operation', async t => {
  const { projectRoot, directory, storageRoot, rolePolicyFile, manage } = files(t, { roleStrategies: { executor: 'whitelist' }, roleTools: [
    { role: 'executor', mode: 'whitelist', tools: ['records'] }
  ] })
  const effects = []
  const call = operation => ({ name: 'records', arguments: { operation } })
  const h = await createHarness({ projectRoot, directory,
    config: { storageRoot, rolePolicyFile, transport: 'direct', allowedTools: ['records'], direct: { agentlessTools: ['records'], durable: true } },
    setup(ctx) { ctx.tools.register(defineTool({ name: 'records', description: 'Read or edit records.',
      parameters: { operation: { type: 'string', required: true } },
      output: { schema: { type: 'object', properties: { operation: { type: 'string', required: true } }, additionalProperties: false }, render: (_args, value) => [{ type: 'text', text: value.operation }] },
      execute({ operation }) { effects.push(operation); return { operation } } })) },
    respond({ index, payload }) {
      if (index === 1) return { tools: [call('read'), call('edit')] }
      if (index === 2) {
        assert.match(JSON.stringify(payload.messages), /ROLE_TOOL_DENIED/)
        assert.deepEqual(effects, [])
        return { tools: [call('read')] }
      }
      return { text: 'Read the record.' }
    } })
  manage(h)
  const destination = h.ctx.get('dynamicContextToolPolicies').forTool(h.ctx.tools.get('records').name)
    .getStrategy({ target: 'roleTools', role: 'executor' })
  assert.equal(destination.mode, 'whitelist')
  destination.register({ pluginId: 'records', registrationId: 'limit', priority: 10, when: { '/operation': 'read' } })
  h.runner.submit(runtimeProposal(['records']))
  await h.runner.runNext({ expectedRevision: 1 })
  assert.deepEqual(effects, ['read'])
  assert.deepEqual(h.backend.errors, [])
})

test('plugins resolve an actual DSH ID, query its destination, then register by priority without supplying a handler', async t => {
  const { projectRoot, directory, storageRoot, rolePolicyFile, manage } = files(t, {
    roleStrategies: { executor: 'whitelist' }, toolErrors: { mode: 'whitelist', includeDefaults: false }
  })
  const h = await createHarness({ projectRoot, directory, config: { storageRoot, rolePolicyFile } })
  manage(h)
  const service = h.ctx.get('dynamicContextToolPolicies'), registry = h.ctx.get('dynamicContextRoleTools')
  const definition = defineTool({ name: 'record_store', description: 'Friendly Records', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: () => 'ok' })
  assert.throws(() => service.forTool(definition.name), /DSH_TOOL_ID_NOT_REGISTERED/)
  const removeTool = h.ctx.tools.register(definition)
  const id = h.ctx.tools.get(definition.name).name
  assert.throws(() => service.forTool('Friendly Records'), /DSH_TOOL_ID_NOT_REGISTERED/)
  const tool = service.forTool(id), destination = tool.getStrategy({ target: 'roleTools', role: 'executor' })
  assert.equal(tool.register, undefined)
  assert.equal(destination.mode, 'whitelist')
  assert.equal(tool.getStrategy({ target: 'roleTools', role: 'preplanning' }).mode, 'blacklist')
  assert.throws(() => tool.getStrategy({ target: 'roleTools' }))
  assert.throws(() => destination.register({ pluginId: 'p', registrationId: 'x', mode: 'blacklist' }))
  const entry = { registrationId: 'records' }
  const strong = destination.register({ ...entry, pluginId: 'audit', when: { '/operation': 'read' }, priority: 20 })
  const weak = destination.register({ ...entry, pluginId: 'legacy', priority: 1 })
  const allowed = operation => registry.admits(registry.select('executor', [id]), id, { operation })
  assert.equal(allowed('read'), true); assert.equal(allowed('edit'), false)
  strong()
  assert.equal(allowed('edit'), true)
  weak()
  assert.equal(allowed('read'), false)

  const errors = h.ctx.get('dynamicContextToolErrors'), transfer = tool.getStrategy({ target: 'toolErrors' })
  assert.equal(transfer.mode, 'whitelist')
  const paused = errorType => Boolean(matchToolErrorRules(errors.snapshot(), id, { isError: true, error: { name: errorType } }))
  const broad = transfer.register({ ...entry, pluginId: 'legacy', priority: 1 })
  const narrow = transfer.register({ ...entry, pluginId: 'audit', priority: 20, errorType: 'CacheError' })
  assert.equal(paused('CacheError'), false); assert.equal(paused('StoreError'), true)
  const tie = errors.register({ pluginId: 'manual', ruleId: 'pause', toolId: id, errorType: 'CacheError', priority: 20 })
  assert.equal(paused('CacheError'), true)
  tie(); narrow()
  assert.equal(paused('StoreError'), false)
  broad()
  assert.equal(paused('StoreError'), true)
  removeTool()
  const replacement = h.ctx.tools.register({ ...definition, description: 'Updated title' })
  assert.throws(() => transfer.register({ ...entry, pluginId: 'stale' }), /DSH_TOOL_REGISTRATION_CHANGED/)
  service.forTool(id).getStrategy({ target: 'toolErrors' }).register({ ...entry, pluginId: 'fresh' })()
  replacement()
  const namespaced = { ...definition, name: '@suite/记录.v1' }, removeNamespaced = h.ctx.tools.register(namespaced)
  const exact = service.forTool(h.ctx.tools.get(namespaced.name).name)
  exact.getStrategy({ target: 'toolErrors' }).register({ ...entry, pluginId: 'exact' })()
  exact.getStrategy({ target: 'roleTools', role: 'executor' }).register({ ...entry, pluginId: 'exact' })()
  removeNamespaced()
  const agent = {}, local = createScope(h.ctx, agent)
  try {
    await local.ctx.plugin({ inject: ['tools'], apply(ctx) { ctx.tools.register({ ...definition, name: 'session_records' }) } })
    assert.throws(() => service.forTool('session_records'), /DSH_TOOL_ID_NOT_REGISTERED/)
    const scoped = service.forTool(h.ctx.tools.get('session_records', agent).name, { agent })
    scoped.getStrategy({ target: 'toolErrors', role: 'reviewer' }).register({ ...entry, pluginId: 'scoped' })()
  } finally { await local.dispose() }
})

test('unit roles negotiate DSH tool IDs with scoped operation policies, priorities and disposal', async t => {
  const { projectRoot, directory, storageRoot, rolePolicyFile, manage } = files(t, { roleStrategies: { unit_router:'blacklist' } })
  const h = await createHarness({ projectRoot, directory, config: { storageRoot, rolePolicyFile } })
  manage(h)
  const registry = h.ctx.get('dynamicContextRoleTools')
  const id = h.ctx.tools.get('fixture_read_a').name
  const tool = h.ctx.get('dynamicContextToolPolicies').forTool(id)
  for (const [role, mode] of [['unit_router','blacklist'],['baseline_audit','whitelist']]) {
    const target = tool.getStrategy({target:'roleTools',role,scope})
    assert.equal(target.mode,mode)
    const weak = target.register({ pluginId:'general',registrationId:role,priority:1 })
    const strong = target.register({ pluginId:'specialist',registrationId:role,priority:5,when:{'/operation':'inspect'} })
    const allowed = (operation, at=scope) => registry.admits(registry.select(role,[id],at),id,{operation})
    assert.equal(allowed('inspect'),mode === 'whitelist')
    assert.equal(allowed('write'),mode === 'blacklist')
    assert.equal(allowed('inspect',{}),mode === 'blacklist')
    strong()
    assert.equal(allowed('write'),mode === 'whitelist')
    weak()
    assert.equal(allowed('inspect'),mode === 'blacklist')
  }
})

test('a whole-ID error registration suspends the graph, then delivers the saved error on explicit resume', async t => {
  const { projectRoot, directory, storageRoot, rolePolicyFile, manage } = files(t, {})
  const id = 'fixture_read_a'
  let effects = 0
  const h = await createHarness({ projectRoot, directory, config: { storageRoot, rolePolicyFile, transport: 'direct', direct: { durable: true } },
    setup(ctx) { ctx.on('tools/execute', (exec, next) => {
      if (exec.name !== id) return next()
      effects++
      return { isError: true, error: { message: 'Fixture store closed.' }, content: [{ type: 'text', text: 'Fixture store closed.' }] }
    }) }, respond({ index, payload }) {
      if (index === 1) return { tools: [{ name: id, arguments: {} }] }
      assert.match(JSON.stringify(payload.messages), /Fixture store closed/)
      return { text: 'Recorded the failure.' }
    } })
  manage(h)
  const destination = h.ctx.get('dynamicContextToolPolicies').forTool(h.ctx.tools.get(id).name).getStrategy({ target: 'toolErrors' })
  assert.equal(destination.mode, 'blacklist')
  destination.register({ pluginId: 'storage', registrationId: 'closed', priority: 10 })
  h.runner.submit(runtimeProposal([id]))
  await assert.rejects(h.runner.runNext({ expectedRevision: 1 }), error => error.code === 'DIRECT_TOOL_ERROR_BLOCKED'
    && error.details.toolId === id && error.details.rules[0].ruleId === 'closed')
  const status = h.runner.checkpointStatus(), options = { expectedRevision: h.runner.graph.read().revision, checkpointChecksum: status.checksum, recover: true }
  assert.equal(status.phase, 'BLOCKED')
  await assert.rejects(h.runner.resumeActive(options), /DIRECT_TOOL_ERROR_BLOCKED/)
  await h.runner.resumeActive({ ...options, acknowledgeToolError: status.checksum })
  assert.equal(effects, 1)
  assert.deepEqual(h.backend.errors, [])
})
