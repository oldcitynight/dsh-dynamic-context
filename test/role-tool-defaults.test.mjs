import test from 'node:test'
import assert from 'node:assert/strict'
import { RoleToolRegistry, ROLE_CONTRACTS } from '../role-policy.mjs'
import { ROLE_TOOL_CATALOG } from '../role-tool-defaults.mjs'
import { inventoryRoleTools } from '../scripts/check-role-tools.mjs'

test('every current native and plugin tool is classified in every role default', () => {
  const inventory = inventoryRoleTools()
  assert.ok(inventory.native.length >= 46); assert.equal(inventory.plugin.length, 40)
  for (const id of ['exit_plan_mode', 'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource']) assert.ok(inventory.known.includes(id))
  assert.deepEqual(inventory.unparsed, []); assert.deepEqual(inventory.unclassified, [])
  const registry = new RoleToolRegistry(), ids = ROLE_TOOL_CATALOG.map(row => row.id)
  for (const role of Object.keys(ROLE_CONTRACTS)) {
    const policy = registry.defaults(role)
    assert.equal(new Set([...policy.whitelist, ...policy.blacklist]).size, ids.length)
    assert.ok(policy.whitelist.every(id => !policy.blacklist.includes(id)))
    assert.deepEqual([...registry.select(role, ids).allowed].sort(), [...policy.whitelist].sort())
  }
})
test('native work, global scheduling and private history cannot enter auditor or guidance tool surfaces', () => {
  const registry = new RoleToolRegistry(), all = ROLE_TOOL_CATALOG.map(row => row.id)
  for (const role of ['result_check', 'reviewer', 'group_audit', 'scope_audit', 'guidance_intake', 'guidance_router', 'progress_reporter']) {
    const allowed = registry.select(role, all).allowed
    for (const tool of ['write', 'edit', 'bash', 'pwsh', 'subagent', 'run_code', 'todo_write', 'update_goal', 'session_trace', 'terminal_send', 'schedule_create', 'dynamic_context_shared_update', 'dynamic_context_run_next']) assert.ok(!allowed.includes(tool), role + ': ' + tool)
    assert.ok(allowed.includes('dynamic_context_generate_report'))
  }
  assert.ok(registry.select('group_audit', all).allowed.includes('dynamic_context_workspace_zip'))
  assert.ok(!registry.select('result_check', all).allowed.includes('dynamic_context_directory_snapshot'))
  assert.ok(registry.select('preplanning', all).allowed.includes('bash'))
  for (const role of Object.keys(ROLE_CONTRACTS))
    assert.equal(registry.select(role, all).allowed.includes('dynamic_context_planning_history'), role === 'preplanning', role)
  assert.ok(registry.select('controller', all).allowed.includes('exit_plan_mode'))
  assert.ok(!registry.select('preplanning', all).allowed.includes('exit_plan_mode'))
  assert.deepEqual(registry.select('compaction', all).allowed, ['read_image'])
  for (const role of Object.keys(ROLE_CONTRACTS)) assert.ok(registry.select(role, all).allowed.includes('read_image'), role)
})
test('default blacklists leave host-granted work available but reject competing workflow and unknown audit tools', async () => {
  const registry = new RoleToolRegistry(), candidates = ['read', 'write', 'bash', 'todo_write', 'subagent', 'dynamic_context_run_next', 'host_custom_work']
  assert.deepEqual(registry.select('executor', candidates).allowed, ['read', 'write', 'bash', 'host_custom_work'])
  assert.deepEqual(registry.select('group_audit', ['host_custom_work']).allowed, [])
  registry.register({ pluginId: 'test', registrationId: 'pretend-grant', role: 'group_audit', mode: 'whitelist', toolIds: ['write'] })
  assert.deepEqual(registry.select('group_audit', ['write']).allowed, [])
})
