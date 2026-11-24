// SPDX-License-Identifier: GPL-3.0-only
// Current native DSH internal IDs plus the two plugins' model-callable tools.
// These policies narrow available host capabilities; they never instantiate a tool.
import defaults from './policies/role-defaults.json' with { type: 'json' }
export const roleStrategies = Object.freeze({ ...defaults.roles })
const rows = defaults.catalog.flatMap(({ tools, roles, ...metadata }) =>
  tools.map(id => Object.freeze({ id, ...metadata, allowRoles: Object.freeze([...roles]) })))
if (new Set(rows.map(row => row.id)).size !== rows.length) throw Error('DUPLICATE_DEFAULT_ROLE_TOOL')
export const ROLE_TOOL_CATALOG = Object.freeze(rows)
const known = new Map(rows.map(row => [row.id, row]))
export function defaultRoleTools(role, strategy, registered = []) {
  const whitelist = rows.filter(row => row.allowRoles.includes(role)).map(row => row.id)
  const blacklist = rows.filter(row => !row.allowRoles.includes(role)).map(row => row.id)
  const extensions = registered.filter(id => !known.has(id))
  const allowed = new Set([...whitelist, ...extensions]), denied = new Set(blacklist)
  return { version: 1, role, strategy, whitelist, blacklist, extensions,
    allows: id => strategy === 'blacklist' ? !denied.has(id) : allowed.has(id) }
}
export function roleToolCoverage(toolIds) {
  return { known: toolIds.filter(id => known.has(id)), unclassified: toolIds.filter(id => !known.has(id)) }
}
