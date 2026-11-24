import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { RoleToolRegistry, ROLE_CONTRACTS } from '../role-policy.mjs'
import { ROLE_TOOL_CATALOG } from '../role-tool-defaults.mjs'
import { inventoryRoleTools } from '../scripts/check-role-tools.mjs'

test('every current native and plugin tool is classified in every role default', () => {
  const inventory = inventoryRoleTools()
  for (const id of ['read', 'edit', 'bash']) assert.ok(inventory.native.includes(id), id)
  assert.deepEqual(inventory.plugin, ROLE_TOOL_CATALOG.filter(row => row.origin !== 'native').map(row => row.id).sort())
  assert.deepEqual(inventory.missingPlugin, [])
  assert.equal(inventory.discoveredCount, new Set(inventory.known).size)
  for (const id of ['exit_plan_mode', 'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource']) assert.ok(inventory.known.includes(id))
  assert.deepEqual(inventory.unparsed, []); assert.deepEqual(inventory.unclassified, [])
  const registry = new RoleToolRegistry(), ids = ROLE_TOOL_CATALOG.map(row => row.id)
  for (const role of Object.keys(ROLE_CONTRACTS)) {
    const policy = registry.defaults(role)
    for (const id of ['dynamic_context_blockage_topology','dynamic_context_blockage_history'])
      assert.equal(policy.whitelist.includes(id), ['blockage','scope_blockage'].includes(role))
    assert.equal(new Set([...policy.whitelist, ...policy.blacklist]).size, ids.length)
    assert.ok(policy.whitelist.every(id => !policy.blacklist.includes(id)))
    assert.deepEqual([...registry.select(role, ids).allowed].sort(), [...policy.whitelist].sort())
  }
})
test('bundled per-role tool lists match the effective default permissions', () => {
  const guide = readFileSync(new URL('../ROLE-TOOL-DEFAULTS.md', import.meta.url), 'utf8')
  const sections = [...guide.matchAll(/^### [^\n]+（([a-z0-9_]+)）\n\n策略：[^\n]+\n\n([^\n]+)/gm)]
  assert.deepEqual(sections.map(match => match[1]).sort(), Object.keys(ROLE_CONTRACTS).sort())
  for (const [, role, list] of sections) {
    const documented = [...list.matchAll(/`([^`]+)`/g)].map(match => match[1])
    const configured = ROLE_TOOL_CATALOG.filter(row => row.allowRoles.includes(role)).map(row => row.id)
    assert.deepEqual(documented.sort(), configured.sort(), role)
  }
  for (const id of ['dynamic_context_route_task', 'dynamic_context_select_mode']) {
    const entry = ROLE_TOOL_CATALOG.find(row => row.id === id)
    assert.deepEqual(entry.allowRoles, [])
    assert.match(entry.reason, /开发中暂不可用/)
    assert.ok(guide.includes(`| ${id} | ${entry.family} |  | ${entry.reason} |`))
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
