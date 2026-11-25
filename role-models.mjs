// SPDX-License-Identifier: GPL-3.0-only
import { z } from 'zod'
import { digest } from 'dsh-better-task-grapth/core'
import { located } from 'dsh-better-task-grapth/validation'
import { deepFreeze } from './request-policy.mjs'
import { roleSchema, registration } from './role-policy.mjs'
import { policyPriority } from './policy-selectors.mjs'
import { directConnection, validateConnection } from './direct-connection.mjs'

export const ROLE_MODELS_SERVICE = 'dynamicContextRoleModels'
const name = z.string().trim().min(1).max(256)
const backend = z.object({ provider: name.optional(), model: name, direct: directConnection.superRefine(validateConnection).optional() }).strict()
const reference = z.union([name, backend])
const declaration = registration.extend({ backend: reference, priority: policyPriority.default(0) })
const keyOf = row => JSON.stringify([row.pluginId, row.registrationId])
function checkNativeProvider(backend) {
  if (backend?.direct && !backend.provider) throw located('ROLE_NATIVE_PROVIDER_REQUIRED', { path: '/backend/provider',
    reason: 'Select the DSH provider ID that owns this native API connection. The direct endpoint is used by Direct roles.' })
}
function checkDirectProvider(backend, originalProvider) {
  if (backend?.provider && backend.provider !== originalProvider && !backend.direct) throw located('ROLE_MODEL_ENDPOINT_REQUIRED', {
    path: '/backend/direct/endpoint', item: backend.provider, reason: 'A different Direct provider needs its own API connection and credential reference.' })
}
const assignable = role => {
  roleSchema.parse(role)
  if (role === 'compaction') throw located('ROLE_MODEL_INHERITED', { path: '/role', item: role,
    reason: 'Compaction uses the model and API backend of the role whose context is being compressed.' })
}

export class RoleModelRegistry {
  #backends
  #host
  #defaults = new Map()
  #plugins = new Map()
  constructor(backends = {}, defaults = {}, { provider, transport } = {}) {
    this.#backends = new Map(Object.entries(z.record(name, backend).parse(backends)))
    this.#host = { provider, transport }
    for (const [role, value] of Object.entries(defaults)) {
      assignable(role)
      this.#defaults.set(role, this.#choice(role, reference.parse(value), { kind: 'config' }))
    }
  }
  #choice(role, ref, source) {
    const value = typeof ref === 'string' ? this.#backends.get(ref) : ref
    if (!value) throw located('ROLE_MODEL_BACKEND_UNKNOWN', { path: '/backend', item: ref, allowed: [...this.#backends.keys()] })
    if (role === 'controller' || role === 'preplanning' || this.#host.transport === 'native-guarded') checkNativeProvider(value)
    else if (this.#host.transport === 'direct') checkDirectProvider(value, this.#host.provider)
    return deepFreeze({ backend: structuredClone(value), ...(typeof ref === 'string' ? { backendId: ref } : {}), source })
  }
  register(input) {
    const row = declaration.parse(input)
    assignable(row.role)
    const key = keyOf(row)
    if (this.#plugins.has(key)) throw located('ROLE_REGISTRATION_DUPLICATE', { path: '/registrationId', item: row.registrationId })
    const { pluginId, registrationId, priority } = row
    const entry = { row, choice: this.#choice(row.role, row.backend, { kind: 'plugin', pluginId, registrationId, priority }) }
    this.#plugins.set(key, entry)
    return () => { if (this.#plugins.get(key) === entry) this.#plugins.delete(key) }
  }
  resolve(role, scope = {}) {
    assignable(role)
    let winner
    for (const [key, entry] of this.#plugins) {
      const { row } = entry
      if (row.role !== role || !Object.entries(row.scope).every(([field, value]) => scope[field] === value)) continue
      if (!winner || row.priority > winner.row.priority || row.priority === winner.row.priority && key > keyOf(winner.row)) winner = entry
    }
    return winner?.choice ?? this.#defaults.get(role) ?? null
  }
  list() {
    return structuredClone({ backends: Object.fromEntries(this.#backends), roles: Object.fromEntries(this.#defaults),
      registrations: [...this.#plugins.entries()].sort(([a], [b]) => a < b ? -1 : 1).map(([, entry]) => entry.row),
      inherited: { compaction: 'triggering-role' } })
  }
  credentialEnvironment() {
    return [...this.#backends.values(), ...[...this.#defaults.values()].map(row => row.backend),
      ...[...this.#plugins.values()].map(row => row.choice.backend)].map(row => row.direct?.apiKeyEnv).filter(Boolean)
  }
}

const connectionFields = Object.keys(directConnection.shape)
const connectionOf = direct => Object.fromEntries(connectionFields.filter(key => Object.hasOwn(direct, key)).map(key => [key, direct[key]]))

/** Store only route fields and credential references. A checkpoint binds an
 * effective route independently of later configuration or registration changes. */
export function bindRoleModel(runner, role, scope, base, saved) {
  if (saved === null) return { config: base } // A pre-routing checkpoint retains its original backend.
  let route
  if (saved !== undefined) {
    const { checksum, ...body } = saved
    if (body.version !== 1 || body.role !== role || checksum !== digest(body)) throw located('ROLE_MODEL_RECEIPT_CHANGED', { path: '/modelRoute', item: role })
    route = body
  } else {
    const choice = runner.roleModels?.resolve(role, scope)
    const selected = choice?.backend, provider = selected?.provider ?? base.provider, model = selected?.model ?? base.model
    let direct
    if (base.transport === 'direct') {
      checkDirectProvider(selected, base.provider)
      direct = selected?.direct ?? connectionOf(base.direct)
      if (!selected?.direct && model !== base.model) direct = { ...direct, responseModelAliases: [] }
    } else checkNativeProvider(selected)
    route = { version: 1, role, provider, model, ...(direct ? { direct } : {}), source: choice?.source ?? { kind: 'inherited' },
      ...(choice?.backendId ? { backendId: choice.backendId } : {}) }
  }
  const receipt = deepFreeze({ ...route, checksum: digest(route) })
  const config = { ...base, provider: route.provider, model: route.model }
  if (route.direct) {
    config.direct = { ...base.direct }
    for (const field of connectionFields) delete config.direct[field]
    Object.assign(config.direct, route.direct)
  }
  return { receipt, config }
}

export function roleReasoningSource(base, effective, sourceAgent) {
  if (base.provider === effective.provider && base.model === effective.model && base.direct?.endpoint === effective.direct?.endpoint)
    return sourceAgent
}

export function nativeRoleModel(base, selection) {
  if (!selection) return base
  checkNativeProvider(selection.backend)
  const provider = selection.backend.provider ?? base.provider, model = selection.backend.model
  if (provider === base.provider && model === base.model) return base
  const { reasoningEffort, ...options } = base
  return { ...options, provider, model }
}

export function nativeRouteFields({ provider, model, reasoningEffort }) {
  return { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) }
}

export function applyNativeRoute(options, route) {
  const { reasoningEffort, ...current } = options
  return { ...current, ...route }
}

/** DSH's basic compactor records the same auxiliary options object it streams.
 * Overriding the route here also records the backend actually used in its receipt. */
export function followNativeCompaction(options, route) {
  if (options.purpose === 'compaction' && route?.provider && route?.model) {
    options.provider = route.provider
    options.model = route.model
  }
}
