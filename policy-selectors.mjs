// SPDX-License-Identifier: GPL-3.0-only
import { z } from 'zod'

const scalar = z.union([z.string().max(4096), z.number().finite(), z.boolean(), z.null()])
const pointer = z.string().min(1).max(512).refine(value =>
  /^(?:\/(?:[^~/]|~[01])*)+$/.test(value) && !parts(value).some(key => ['__proto__', 'prototype', 'constructor'].includes(key)),
  'Expected a JSON Pointer to an own field.')
function parts(pointer) { return pointer.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~')) }
export const conditions = z.record(pointer, scalar).refine(value => Object.keys(value).length > 0 && Object.keys(value).length <= 32)
// Match the raw DSH registry key. Provider-specific wire name limits apply
// at transport time, independently of registering an exact policy reference.
export const toolName = z.string().min(1).refine(value => value.trim().length > 0 && !/[\u0000-\u001f\u007f*]/u.test(value), 'Use an exact DSH tool ID.')
export const policyPriority = z.number().int().safe()
export const toolSelector = z.union([toolName, z.object({ toolId: toolName, when: conditions }).strict()])

export function matchesConditions(value, when) {
  return Object.entries(when).every(([path, expected]) => {
    let current = value
    for (const key of parts(path)) {
      if (current === null || typeof current !== 'object' || !Object.hasOwn(current, key)) return false
      current = current[key]
    }
    return current === expected
  })
}
const named = (entry, name) => (typeof entry === 'string' ? entry : entry.toolId) === name
const matches = (entry, args) => typeof entry === 'string' || matchesConditions(args, entry.when)
export function highestPriority(rows) {
  const highest = rows.reduce((value, row) => Math.max(value, row.priority ?? 0), -Infinity)
  return rows.filter(row => (row.priority ?? 0) === highest)
}

// A name can be advertised while only some argument combinations are callable.
// Old toolIds whitelists restrict the entire surface. Appended whitelists
// describe alternatives for one tool; independent tools keep their policies.
export function policyAllows(rows, name, args, dispatch = false, defaultAllowed = true) {
  const candidates = []
  for (const row of rows) {
    const entries = (row.tools ?? row.toolIds).filter(entry => named(entry, name))
    if (entries.length) candidates.push({ ...row, entries })
    else if (row.mode === 'whitelist' && row.combine !== 'append') return false
  }
  let hasAllow = false, matchedAllow = false, canAdd = false
  for (const row of highestPriority(candidates)) {
    if (row.mode === 'blacklist') {
      if (row.entries.some(entry => dispatch ? matches(entry, args) : typeof entry === 'string')) return false
      continue
    }
    const match = row.entries.some(entry => !dispatch || matches(entry, args))
    if (row.combine !== 'append' && !match) return false
    hasAllow = true
    matchedAllow ||= match
    canAdd ||= row.combine === 'append' && match
  }
  return (defaultAllowed || canAdd) && (!hasAllow || matchedAllow)
}
export function snapshotAllowsCall(snapshot, name, args) {
  return snapshot.allowed.includes(name) && policyAllows(snapshot.policies, name, args, true)
}
export function operationRules(snapshot, name) {
  const conditional = new Set(snapshot.policies.flatMap(row => (row.tools ?? []).filter(entry => typeof entry !== 'string').map(entry => entry.toolId)))
  return snapshot.policies.flatMap(({ mode, combine, priority, tools, toolIds }) => {
    const relevant = (tools ?? toolIds).filter(entry => conditional.has(entry.toolId ?? entry) && (!name || named(entry, name)))
    return relevant.length ? [{ mode, combine, priority: priority ?? 0, tools: relevant }] : []
  })
}
