import test from 'node:test'
import assert from 'node:assert/strict'
import { RolePromptRegistry, RoleToolRegistry, ROLE_BOUNDARY } from '../role-policy.mjs'
const base = { pluginId: 'skill/example', registrationId: 'style', role: 'result_check' }
test('role prompts append or replace deterministically, retain a host boundary, and isolate scope and snapshots', () => {
  const registry = new RolePromptRegistry()
  assert.equal(registry.resolve('result_check', 'original').content, 'original')
  const remove = registry.register({ ...base, mode: 'replace', text: 'replacement', priority: 10, scope: { workflowId: 'wf' } })
  registry.register({ ...base, registrationId: 'extra', mode: 'append', text: 'extra' })
  const pinned = registry.resolve('result_check', 'original', { workflowId: 'wf' })
  assert.equal(pinned.content, 'replacement\n\nextra\n\n' + ROLE_BOUNDARY)
  assert.match(registry.resolve('result_check', 'original', { workflowId: 'other' }).content, /^original/)
  assert.equal(registry.resolve('executor', 'original', { workflowId: 'wf' }).content, 'original')
  assert.throws(() => { pinned.contributions.push({}) }, TypeError)
  remove(); assert.match(registry.resolve('result_check', 'original', { workflowId: 'wf' }).content, /^original/)
  assert.match(pinned.content, /^replacement/)
})
test('registration disposal cannot remove a newer registration; priority ties have a stable plugin/ID order', () => {
  const registry = new RolePromptRegistry(), input = { ...base, mode: 'replace', text: 'first' }
  const dispose = registry.register(input); assert.throws(() => registry.register(input), /ROLE_REGISTRATION_DUPLICATE/)
  dispose(); registry.register({ ...input, text: 'second' }); dispose()
  registry.register({ ...input, pluginId: 'z', text: 'third' })
  assert.match(registry.resolve('result_check', 'base').content, /^third/)
  assert.throws(() => registry.register({ ...input, role: 'unknown' }))
})
test('multiple whitelists intersect and blacklists win; no policy creates a capability', () => {
  const tools = new RoleToolRegistry()
  tools.register({ ...base, mode: 'whitelist', toolIds: ['dynamic_context_read_evidence', 'dynamic_context_search_evidence', 'nonexistent'] })
  tools.register({ ...base, registrationId: 'narrow', mode: 'whitelist', toolIds: ['dynamic_context_read_evidence', 'dynamic_context_search_evidence'] })
  tools.register({ ...base, registrationId: 'deny', mode: 'blacklist', toolIds: ['dynamic_context_search_evidence'] })
  assert.deepEqual(tools.select('result_check', ['dynamic_context_read_evidence', 'dynamic_context_search_evidence', 'write']).allowed, ['dynamic_context_read_evidence'])
  assert.deepEqual(tools.select('executor', ['read', 'write']).allowed, ['read', 'write'])
  assert.equal(tools.select('result_check', []).defaultStrategy, 'whitelist')
  assert.equal(tools.select('executor', []).defaultStrategy, 'blacklist')
})
const extension = (overrides = {}) => ({ pluginId: 'skill/example', registrationId: 'lookup', toolId: 'skill_lookup', roles: ['group_audit'], effect: 'read',
  schema: { type: 'function', function: { name: 'skill_lookup', description: 'Look up scoped evidence', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false } } },
  authorize: () => true, execute: (args, context) => ({ id: args.id, role: context.role, scope: context.scope }), ...overrides })
const call = args => ({ id: 'call1', function: { name: 'skill_lookup', arguments: JSON.stringify(args) } })
test('extension tools enforce effect, schema, host authorization, scope and late revocation', async () => {
  const tools = new RoleToolRegistry()
  assert.throws(() => tools.registerTool(extension({ effect: 'work' })), /ROLE_TOOL_EFFECT_FORBIDDEN/)
  const remove = tools.registerTool(extension({ scope: { scopeId: 'group' } }))
  assert.equal(tools.tools('group_audit', null, { scopeId: 'other' }).tools.length, 0)
  const view = tools.tools('group_audit', null, { scopeId: 'group' })
  assert.equal((await view.execute(call({ id: 'evidence' }))).role, 'group_audit')
  await assert.rejects(view.execute(call({ id: 10 })), /ROLE_TOOL_ARGUMENT_INVALID/)
  tools.register({ ...base, role: 'group_audit', mode: 'blacklist', toolIds: ['skill_lookup'] })
  await assert.rejects(view.execute(call({ id: 'evidence' })), /ROLE_TOOL_DENIED/)
  remove()
})
test('extensions cannot shadow built-in tools or keep executing after disposal', async () => {
  const tools = new RoleToolRegistry(), dispose = tools.registerTool(extension())
  assert.throws(() => tools.tools('group_audit', { tools: [extension().schema] }), /ROLE_TOOL_SHADOW_FORBIDDEN/)
  const view = tools.tools('group_audit', null); dispose(); tools.registerTool(extension())
  await assert.rejects(view.execute(call({ id: 'x' })), /ROLE_TOOL_REGISTRATION_CHANGED/)
  const denied = new RoleToolRegistry(); denied.registerTool(extension({ authorize: () => false }))
  await assert.rejects(denied.tools('group_audit', null).execute(call({ id: 'x' })), /ROLE_TOOL_HOST_PERMISSION_DENIED/)
})

test('durable registered tools replay completed receipts and never repeat an uncertain effect', async t => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'role-tool-receipts-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let effects = 0; const tools = new RoleToolRegistry()
  tools.registerTool(extension({ execute: () => { effects++; return { result: 'recorded' } } }))
  const view = tools.tools('group_audit', null, {}, { directory })
  const first = await view.execute(call({ id: 'x' })); assert.deepEqual(await view.execute(call({ id: 'x' })), first); assert.equal(effects, 1)
  await assert.rejects(view.execute(call({ id: 'different' })), /ROLE_TOOL_RECEIPT_CHANGED/)
  const old = extension().schema.function, updated = new RoleToolRegistry()
  const revised = extension({ execute: () => { effects++; return { result: 'new' } } })
  revised.schema.function.description = 'Updated usage instructions'
  updated.registerTool(revised)
  const savedToolSchemas = new Map([['group_audit', new Map([[old.name, old]])]])
  const resumed = updated.tools('group_audit', null, {}, { directory, savedToolSchemas })
  assert.equal(resumed.tools[0].function.description, old.description)
  assert.deepEqual(await resumed.execute(call({ id: 'x' })), first)
  assert.equal(effects, 1)
  assert.equal(updated.tools('group_audit', null).tools[0].function.description, revised.schema.function.description)
  const changed = new RoleToolRegistry()
  revised.schema.function.parameters.properties.id.minLength = 1
  changed.registerTool(revised)
  const incompatible = changed.tools('group_audit', null, {}, { directory, savedToolSchemas })
  assert.equal(incompatible.tools[0].function.description, revised.schema.function.description)
  await assert.rejects(incompatible.execute(call({ id: 'x' })), /ROLE_TOOL_RECEIPT_CHANGED/)
  const uncertain = new RoleToolRegistry(); uncertain.registerTool(extension({ execute: () => { effects++; throw Error('after effect') } }))
  const next = uncertain.tools('group_audit', null, {}, { directory })
  const pending = { ...call({ id: 'new' }), id: 'call2' }
  await assert.rejects(next.execute(pending), /after effect/)
  await assert.rejects(next.execute(pending), /ROLE_TOOL_OUTCOME_UNKNOWN/); assert.equal(effects, 2)
})

test('a durable tool can reuse only an explicitly registered historical parameter schema', async () => {
  const { function: saved } = extension().schema
  const revised = extension({ execute: (args, { toolSchema }) => ({ args, description: toolSchema.function.description }) })
  delete revised.schema.function.parameters.properties.id
  revised.schema.function.parameters.required = []
  revised.schema.function.description = 'New schema'
  const registry = new RoleToolRegistry()
  registry.registerTool({ ...revised, previousParameters: [saved.parameters] })
  const savedToolSchemas = new Map([['group_audit', new Map([[saved.name, saved]])]])
  const resume = registry.tools('group_audit', null, {}, { savedToolSchemas })
  assert.deepEqual(resume.tools[0].function, saved)
  assert.deepEqual(await resume.execute(call({ id: 'old-shape' })), { args: { id: 'old-shape' }, description: saved.description })
  const fresh = registry.tools('group_audit', null)
  assert.deepEqual(fresh.tools[0].function, revised.schema.function)
  await assert.rejects(fresh.execute(call({ id: 'old-shape' })), /ROLE_TOOL_ARGUMENT_INVALID/)
  saved.parameters.properties.unknown = { type: 'string' }
  const unrelated = registry.tools('group_audit', null, {}, { savedToolSchemas })
  assert.deepEqual(unrelated.tools[0].function, revised.schema.function)
})

test('report tool retains the host format when the work prompt is replaced', async () => {
  const { createReportDraft, standardReportTemplate } = await import('../report-draft.mjs')
  const source = 'Perform an independent review.\n标准模板：{"verdict":"APPROVE","reason":"证据说明","issues":[]}。'
  const registry = new RolePromptRegistry(); registry.register({ ...base, mode: 'replace', text: 'Use this alternative review method.' })
  assert.doesNotMatch(registry.resolve('result_check', source).content, /证据说明/)
  const draft = createReportDraft('{}', { generate: true, template: standardReportTemplate(source), validateResult: value => value })
  assert.match(draft.tools[0].function.description, /证据说明/)
  assert.match(draft.tools[0].function.description, /"issues":\[\]/)
})
