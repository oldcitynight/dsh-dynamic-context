// SPDX-License-Identifier: GPL-3.0-only
import { z } from 'zod'
import { digest } from 'dsh-better-task-grapth/core'
import { deepFreeze } from './request-policy.mjs'
import { ROLE_CONTRACTS } from './role-policy.mjs'

export const TOOL_ERROR_POLICY_SERVICE = 'dynamicContextToolErrors'
const id = z.string().min(1).max(256).regex(/^[A-Za-z0-9_@][A-Za-z0-9_.:@/-]*$/)
const scalar = z.union([z.string().max(4096), z.number().finite(), z.boolean(), z.null()])
const pointer = z.string().max(512).refine(value => /^\/(isError|error|value|meta)(\/[^~\/]*(~[01][^~\/]*)*)*$/.test(value)
  && !value.split('/').some(part => ['__proto__', 'prototype', 'constructor'].includes(part.replace(/~1/g, '/').replace(/~0/g, '~'))), 'Use a JSON pointer into isError, error, value or meta; prototype paths are forbidden.')
const ruleSchema = z.object({
  pluginId: id, ruleId: id, toolId: id,
  role: id.refine(value => Object.hasOwn(ROLE_CONTRACTS, value), 'Use a dynamic-context role ID.').optional(),
  errorCode: z.string().min(1).max(256).optional(),
  when: z.record(pointer, scalar).refine(value => Object.keys(value).length > 0 && Object.keys(value).length <= 32, 'Supply 1 through 32 exact error conditions.').optional(),
  reason: z.string().trim().min(1).max(2048),
}).strict().refine(rule => rule.errorCode !== undefined || rule.when !== undefined, 'Supply an errorCode or exact error conditions.')
const NATIVE_PLUGIN = 'dsh-dynamic-context/native'
const nativeRules = [{ pluginId: NATIVE_PLUGIN, ruleId: 'bash-sandbox-runner-failed', toolId: 'bash', nativeModule: 'shell',
  when: { '/value/kind': 'foreground', '/value/sandbox/runnerFailed': true },
  reason: 'The native shell sandbox runner failed. Inspect the execution environment before explicitly continuing the task.' }]

/** Read only own structured fields. Error prose and substring/prefix guesses
 * never decide whether the whole task must stop. Missing differs from null. */
function lookup(result, path) {
  let value = result
  for (const part of path.slice(1).split('/').map(row => row.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, part)) return { found: false }
    value = value[part]
  }
  return { found: true, value }
}

export function matchToolErrorRules(snapshot, toolId, result, nativeModules = [], role = 'executor', legacy = role === 'executor' || role === 'result_work') {
  const rules = snapshot.rules.filter(rule => rule.toolId === toolId
    && (rule.role === undefined ? legacy : rule.role === role)
    && (!rule.nativeModule || nativeModules.includes(rule.nativeModule))
    && (rule.errorCode === undefined || lookup(result, '/error/info/code').value === rule.errorCode)
    && Object.entries(rule.when ?? {}).every(([path, expected]) => {
      const observed = lookup(result, path)
      return observed.found && observed.value === expected
    }))
  return rules.length ? deepFreeze({ version: 1, role, toolId, policyChecksum: snapshot.checksum,
    rules: structuredClone(rules) }) : null
}

/** Match the same public fields irrespective of the source of a tool result. */
export function roleToolOutcome(value) {
  if (!value?.error) return { isError: false, value }
  const code = typeof value.error === 'string' ? value.error : value.error.code ?? value.diagnostic?.code
  return { isError: true, value, error: { message: value.diagnostic?.reason ?? value.error.message ?? String(value.error),
    ...(code ? { info: { name: 'ToolError', code } } : {}) } }
}

export function toolErrorBlock(snapshot, result, { toolId, role, callId, runId, ordinal, nativeModules, legacy }) {
  const match = matchToolErrorRules(snapshot, toolId, result, nativeModules, role, legacy)
  if (!match) return null
  return deepFreeze({ ...match, callId, ...(runId === undefined ? {} : { runId }),
    id: digest({ role, toolId, callId, runId: runId ?? null, ordinal: ordinal ?? null, result }),
    action: 'BLOCKED', requiresHumanResume: true })
}

export function toolErrorBlocked(block) {
  return Object.assign(new Error('DIRECT_TOOL_ERROR_BLOCKED'), { code: 'DIRECT_TOOL_ERROR_BLOCKED', details: block })
}

/** Host plugin API, deliberately not an Agent tool. Snapshot at each execution
 * boundary: late registration/disposal cannot change a request already running. */
export class ToolErrorPolicy {
  #rules = new Map()
  register(input) {
    const rule = ruleSchema.parse(input)
    if (rule.pluginId === NATIVE_PLUGIN) throw new Error('TOOL_ERROR_RULE_RESERVED_PLUGIN')
    const key = JSON.stringify([rule.pluginId, rule.ruleId])
    if (this.#rules.has(key)) throw new Error('TOOL_ERROR_RULE_ALREADY_REGISTERED')
    const pinned = deepFreeze(structuredClone(rule))
    this.#rules.set(key, pinned)
    return () => { if (this.#rules.get(key) === pinned) this.#rules.delete(key) }
  }
  snapshot() {
    const body = { version: 1, defaultAction: 'RETURN_TO_AGENT', rules: structuredClone([...nativeRules, ...this.#rules.values()])
      .sort((a, b) => JSON.stringify([a.pluginId, a.ruleId]).localeCompare(JSON.stringify([b.pluginId, b.ruleId]))) }
    return deepFreeze({ ...body, checksum: digest(body) })
  }
  list() { return this.snapshot().rules }
}

/** Keep both the renderer's original text and structured native error fields.
 * No unknown error is reclassified as a successful or effect-free operation. */
export function toolErrorContent(result, output) {
  return result.isError || result.error !== undefined
    ? JSON.stringify({ output, isError: Boolean(result.isError), ...(result.error === undefined ? {} : { error: result.error }),
      ...(result.meta === undefined ? {} : { meta: result.meta }), ...(result.value === undefined ? {} : { value: result.value }) })
    : output
}
