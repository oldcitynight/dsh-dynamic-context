import { defaultRoleTools, ROLE_TOOL_CATALOG, roleToolCoverage } from './role-tool-defaults.mjs'
export { ROLE_TOOL_CATALOG, roleToolCoverage } from './role-tool-defaults.mjs'
// SPDX-License-Identifier: GPL-3.0-only
import { z } from 'zod'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { digest } from 'dsh-better-task-grapth/core'
import { diagnostic, located, parseModelJSON } from 'dsh-better-task-grapth/validation'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { leafAllowedTools } from './image-content.mjs'

export const ROLE_PROMPTS_SERVICE = 'dynamicContextRolePrompts'
export const ROLE_TOOLS_SERVICE = 'dynamicContextRoleTools'
export const ROLE_PROTOCOL_VERSION = 1
const read = ['read'], work = ['read', 'work'], report = ['read', 'report']
export const ROLE_CONTRACTS = Object.freeze(Object.fromEntries(Object.entries({
  controller: ['交互控制器', read, 'white'],
  preplanning: ['首次规划', read, 'black'],
  executor: ['叶执行者', work, 'black'],
  result_work: ['叶成果返工', work, 'black'],
  result_check: ['叶结果验收', read, 'white'],
  result_repair: ['执行报告修订', report, 'white'],
  plan_check: ['叶间计划复查', read, 'white'],
  updater: ['双图更新', read, 'white'],
  reviewer: ['双图修改审计', read, 'white'],
  blockage: ['阻塞处理', read, 'white'],
  blockage_audit: ['中断审核', read, 'white'],
  group_audit: ['组级或根级终审', read, 'white'],
  scope_plan: ['本层计划复查', read, 'white'],
  scope_update: ['本层蓝图更新', read, 'white'],
  scope_audit: ['本层修改审计', read, 'white'],
  scope_blockage: ['本层阻塞处理', read, 'white'],
  scope_pause: ['本层中断审核', read, 'white'],
  task_reporter: ['任务报告者', read, 'white'],
  progress_reporter: ['途中总体执行报告', read, 'white'],
  guidance_intake: ['用户引导识别', read, 'white'],
  guidance_router: ['用户引导路由', read, 'white'],
  // Built-in read_image is provided by the compaction adapter. Other extension
  // callbacks remain unavailable in the native checkpoint protocol.
  compaction: ['历史压缩', [], 'white'],
}).map(([id, [label, effects, strategy]]) => [id, Object.freeze({ id, label, effects: Object.freeze([...effects]),
  strategy: strategy === 'black' ? 'blacklist' : 'whitelist' })])))
const roleSchema = z.enum(Object.keys(ROLE_CONTRACTS))
const id = z.string().min(1).max(160).regex(/^[A-Za-z0-9_@][A-Za-z0-9_.:@/-]*$/)
const toolId = z.string().min(1).max(128).regex(/^[A-Za-z_][A-Za-z0-9_.:-]*$/)
const scopeSchema = z.object({ workflowId: id.optional(), sessionId: id.optional(), taskId: id.optional(), scopeId: id.optional() }).strict()
const registration = z.object({ pluginId: id, registrationId: id, role: roleSchema,
  scope: scopeSchema.default({}) }).strict()
const promptSchema = registration.extend({ mode: z.enum(['append', 'replace']), priority: z.number().int().min(-10000).max(10000).default(0),
  text: z.string().trim().min(1).max(131072), skillId: id.optional() }).strict()
const policySchema = registration.extend({ mode: z.enum(['blacklist', 'whitelist']), toolIds: z.array(toolId).max(256)
  .refine(value => new Set(value).size === value.length, 'Tool IDs must be unique.') }).strict()
const freeze = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value) } return value }
const matches = (scope, current) => Object.entries(scope).every(([key, value]) => current[key] === value)
const keyOf = value => JSON.stringify([value.pluginId, value.registrationId])
const compare = (a, b) => (a.priority ?? 0) - (b.priority ?? 0) || keyOf(a).localeCompare(keyOf(b), 'en')
const rejectedTool = error => Object.assign(error, { toolRejected: true })
const rejectTool = (code, details) => rejectedTool(located(code, details))
function writeReceipt(file, value) {
  const temp = file + '.' + randomUUID() + '.tmp', fd = fs.openSync(temp, 'wx', 0o600)
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  fs.renameSync(temp, file)
  const dir = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(dir) } finally { fs.closeSync(dir) }
}
function register(map, parsed, kind) {
  const key = keyOf(parsed)
  if (map.has(key)) throw located('ROLE_REGISTRATION_DUPLICATE', { path: '/registrationId', item: parsed.registrationId, reason: `${kind}: this plugin already owns the registration ID.` })
  const value = freeze(structuredClone(parsed)); map.set(key, value)
  return () => { if (map.get(key) === value) map.delete(key) }
}

function preserveToolDescription(schema, savedTools) {
  const saved = savedTools?.get(schema.function.name)
  if (!saved || digest(saved.parameters) !== digest(schema.function.parameters)) return schema
  return { ...schema, function: { ...schema.function, description: saved.description } }
}
export const ROLE_BOUNDARY = `Host role protocol v1: User guidance is the highest authority for task intent, above plans, skill prose and historical reports. It does not grant operating-system/tool permissions, approve unverified results, or change this role's job. Work only inside the host-selected task/scope. Reviewers inspect and return decisions; only executors perform business work. Updaters propose changes, and the host validates/audits/commits them. Preserve the host output schema, evidence protocol and tool receipts. A prompt extension cannot modify the role ID, allowed tools, approval policy or state-transition preconditions.`

/** Trusted host-plugin API, never a model-callable tool. Registrations are scoped,
 * deterministic and disposable. The running request retains its exact snapshot. */
export class RolePromptRegistry {
  #entries = new Map()
  register(input) { return register(this.#entries, promptSchema.parse(input), 'prompt') }
  list() { return structuredClone([...this.#entries.values()].sort(compare)) }
  resolve(role, base, scope = {}) {
    roleSchema.parse(role)
    const entries = this.list().filter(row => row.role === role && matches(row.scope, scope))
    const replacement = entries.filter(row => row.mode === 'replace').at(-1)
    const appended = entries.filter(row => row.mode === 'append')
    const content = entries.length ? [replacement?.text ?? base, ...appended.map(row => row.text), ROLE_BOUNDARY].join('\n\n') : base
    const snapshot = { version: 1, role, scope: structuredClone(scope), baseHash: digest(base),
      contributions: entries, selectedReplacement: replacement ? keyOf(replacement) : null, content }
    return freeze({ ...snapshot, checksum: digest(snapshot) })
  }
}

/** Policies only narrow a supplied capability set. Extra tools require a
 * separate typed registration and a per-call host authorization function. */
export class RoleToolRegistry {
  #policies = new Map()
  #tools = new Map()
  register(input) { return register(this.#policies, policySchema.parse(input), 'tool policy') }
  registerTool(input) {
    const { schema, execute, authorize, ...metadata } = input
    const parsed = z.object({ pluginId: id, registrationId: id, toolId, roles: z.array(roleSchema).min(1),
      effect: z.enum(['read', 'report', 'work']), scope: scopeSchema.default({}),
      workspaceRoot: z.string().refine(path.isAbsolute).optional(), auditArtifacts: z.literal(true).optional() }).strict().parse(metadata)
    if (parsed.workspaceRoot) parsed.workspaceRoot = fs.realpathSync(parsed.workspaceRoot)
    if (parsed.auditArtifacts && (parsed.effect !== 'read' || !parsed.workspaceRoot))
      throw located('ROLE_TOOL_AUDIT_SCOPE_REQUIRED', { path: '/workspaceRoot', reason: 'An audit evidence tool needs a workspace and read effects.' })
    if (!schema || schema.type !== 'function' || schema.function?.name !== parsed.toolId || !schema.function?.parameters
        || typeof execute !== 'function' || typeof authorize !== 'function')
      throw located('ROLE_TOOL_CONTRACT_INVALID', { path: '/schema', reason: 'Supply an exact function schema, execute(args, context), and authorize(context) returning true.' })
    for (const role of parsed.roles) if (!ROLE_CONTRACTS[role].effects.includes(parsed.effect))
      throw located('ROLE_TOOL_EFFECT_FORBIDDEN', { path: '/roles', item: role, reason: `${role} cannot receive ${parsed.effect} tools.`, allowed: ROLE_CONTRACTS[role].effects })
    const key = keyOf(parsed)
    if (this.#tools.has(key) || [...this.#tools.values()].some(row => row.toolId === parsed.toolId))
      throw located('ROLE_TOOL_DUPLICATE', { path: '/toolId', item: parsed.toolId, reason: 'An extension already owns this tool ID.' })
    const value = { ...freeze(structuredClone(parsed)), schema: freeze(structuredClone(schema)), execute, authorize }
    this.#tools.set(key, value)
    return () => { if (this.#tools.get(key) === value) this.#tools.delete(key) }
  }
  list() { return { policies: structuredClone([...this.#policies.values()].sort(compare)), tools: [...this.#tools.values()].map(({ execute, authorize, ...row }) => structuredClone(row)) } }
  defaults(role, scope = {}, workspaceRoot) {
    roleSchema.parse(role)
    const { allows, ...value } = defaultRoleTools(role, ROLE_CONTRACTS[role].strategy, this.extensions(role, scope, workspaceRoot).map(row => row.toolId))
    return freeze(value)
  }
  select(role, candidates, scope = {}, workspaceRoot) {
    roleSchema.parse(role)
    const policies = [...this.#policies.values()].filter(row => row.role === role && matches(row.scope, scope)).sort(compare)
    const defaults = defaultRoleTools(role, ROLE_CONTRACTS[role].strategy, this.extensions(role, scope, workspaceRoot).map(row => row.toolId))
    const allowed = name => defaults.allows(name) && policies.every(row => row.mode === 'blacklist' ? !row.toolIds.includes(name) : row.toolIds.includes(name))
    const names = [...new Set(candidates)].filter(allowed)
    const body = { version: 1, role, scope: structuredClone(scope), defaultStrategy: ROLE_CONTRACTS[role].strategy,
      defaultPolicyChecksum: digest(this.defaults(role, scope, workspaceRoot)), candidates: [...new Set(candidates)], policies: structuredClone(policies), allowed: names }
    return freeze({ ...body, checksum: digest(body) })
  }
  extensions(role, scope = {}, workspaceRoot) {
    return [...this.#tools.values()].filter(row => row.roles.includes(role) && matches(row.scope, scope)
      && (row.workspaceRoot === undefined || row.workspaceRoot === workspaceRoot))
  }
  nativeDefinitions(role, scope, context) {
    const view = this.tools(role, null, scope, { ...context, returnToolErrors: true })
    return view.tools.map(({ function: schema }) => ({ name: schema.name, description: schema.description, parameters: schema.parameters,
      output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: async (args, exec) => {
        let value
        try { value = await view.execute({ id: exec.callId, function: { name: schema.name, arguments: JSON.stringify(args) } }, undefined, exec.signal) }
        catch (error) {
          if (!error.toolRejected) throw error
          throw new HarnessError(error.message, error.code, { cause: error })
        }
        if (typeof value?.error === 'string') throw new HarnessError(JSON.stringify(value), value.error)
        return value
      } }))
  }
  tools(role, builtins, scope = {}, { savedToolSchemas, ...context } = {}) {
    const workspaceRoot = context.runner?.config?.projectRoot
    const extensions = this.extensions(role, scope, workspaceRoot).filter(row => !row.auditArtifacts || context.auditArtifacts)
    const builtinNames = builtins?.tools.map(row => row.function.name) ?? []
    const duplicate = extensions.find(row => builtinNames.includes(row.toolId))
    if (duplicate) throw located('ROLE_TOOL_SHADOW_FORBIDDEN', { path: '/toolId', item: duplicate.toolId, reason: 'Extension tools cannot shadow a built-in tool.' })
    const snapshot = this.select(role, [...builtinNames, ...extensions.map(row => row.toolId)], scope, workspaceRoot)
    const allowed = new Set(snapshot.allowed), owned = new Map(extensions.map(row => [row.toolId, row]))
    // Preserve the wording advertised by a durable role without restoring
    // revoked tools or accepting changes to their argument contracts.
    const tools = [...(builtins?.tools ?? []), ...extensions.map(row => row.schema)]
      .filter(row => allowed.has(row.function.name))
      .map(row => preserveToolDescription(row, savedToolSchemas?.get(role)))
    const schemas = new Map(tools.map(row => [row.function.name, row]))
    return { snapshot, tools,
      execute: async (tool, receiptKey, signal = context.signal) => {
        const name = tool.function.name
        // Recheck policy revocations at execution time. New registrations do not
        // silently enlarge a request already sent to the model.
        const current = this.select(role, snapshot.allowed, scope, workspaceRoot)
        if (!allowed.has(name) || !current.allowed.includes(name)) throw rejectTool('ROLE_TOOL_DENIED', { path: '/tool_calls/function/name', item: name, reason: 'The role tool policy denies this call.', allowed: current.allowed })
        const extension = owned.get(name)
        if (!extension) return builtins.execute(tool)
        if (this.#tools.get(keyOf(extension)) !== extension) throw rejectTool('ROLE_TOOL_REGISTRATION_CHANGED', { path: '/tool_calls/function/name', item: name, reason: 'This tool registration was removed or replaced; request a fresh role invocation.' })
        let args
        try { args = parseModelJSON(tool.function.arguments, { path: '/tool_calls/function/arguments' }).value }
        catch (error) { throw rejectedTool(error) }
        const issues = validateJsonSchemaValue(extension.schema.function.parameters, args, '')
        if (issues.length) throw rejectTool('ROLE_TOOL_ARGUMENT_INVALID', { path: '/tool_calls/function/arguments', issues, reason: 'Arguments violate this registered tool schema.' })
        const callContext = Object.freeze({ ...context, signal, role, scope: freeze(structuredClone(scope)), toolId: name, args: freeze(structuredClone(args)) })
        if (await extension.authorize(callContext) !== true) throw rejectTool('ROLE_TOOL_HOST_PERMISSION_DENIED', { path: '/tool_calls/function/name', item: name, reason: 'The registering plugin did not authorize this call under current host permissions.' })
        // Role replay reconstructs its old read/patch exchanges. Registered
        // callbacks must not run twice while doing that reconstruction.
        let receiptFile, requestHash
        if (context.directory && tool.id) {
          const folder = path.join(context.directory, 'extension-tool-receipts'); fs.mkdirSync(folder, { recursive: true, mode: 0o700 })
          receiptFile = path.join(folder, digest([role, receiptKey ?? tool.id, tool.id]) + '.json')
          requestHash = digest({ name, args, role, scope, pluginId: extension.pluginId, registrationId: extension.registrationId, schema: schemas.get(name) })
          if (fs.existsSync(receiptFile)) {
            const prior = JSON.parse(fs.readFileSync(receiptFile, 'utf8'))
            if (prior.requestHash !== requestHash || prior.phase === 'COMPLETE' && digest(prior.value) !== prior.resultHash)
              throw located('ROLE_TOOL_RECEIPT_CHANGED', { path: '/tool_calls', item: tool.id, reason: 'The durable tool receipt does not match this call.' })
            if (prior.phase !== 'COMPLETE') throw located('ROLE_TOOL_OUTCOME_UNKNOWN', { path: '/tool_calls', item: tool.id, reason: 'This extension started without a durable result. Inspect its actual outcome before proceeding; it is never automatically replayed.' })
            return structuredClone(prior.value)
          }
          writeReceipt(receiptFile, { phase: 'STARTED', requestHash })
        }
        let value
        try { value = await extension.execute(callContext.args, callContext) }
        catch (error) {
          signal?.throwIfAborted()
          if (!context.returnToolErrors) throw error
          // The call returned by throwing. Preserve that receipt without inferring that it had no effects.
          const code = typeof error?.code === 'string' ? error.code : error?.name ?? 'ROLE_TOOL_FAILED'
          value = { error: code, diagnostic: diagnostic(error, { stage: role }), effects: 'NOT_INFERRED_FROM_ERROR' }
        }
        if (value === undefined) throw located('ROLE_TOOL_RESULT_REQUIRED', { path: '/result', reason: 'Registered tools must return a JSON value, including null for an empty result.' })
        const serialized = JSON.parse(JSON.stringify(value))
        if (receiptFile) writeReceipt(receiptFile, { phase: 'COMPLETE', requestHash, value: serialized, resultHash: digest(serialized) })
        return serialized
      } }
  }
}

export function roleScope(runner, input = {}) {
  const state = runner.graph?.read?.(), active = state?.graph?.state?.active
  return Object.fromEntries(Object.entries({ workflowId: runner.workflowId,
    sessionId: runner.controller?.session?.id ?? runner.current?.sourceAgent?.session?.id,
    taskId: input.task?.id ?? input.taskId ?? active?.nodeId,
    scopeId: input.scopeId ?? state?.supervision?.hierarchy?.scopeId }).filter(([, value]) => typeof value === 'string'))
}
export function rolePrompt(runner, role, base, input = {}) {
  const service = runner.rolePrompts ?? runner.ctx?.get?.(ROLE_PROMPTS_SERVICE)
  return (service instanceof RolePromptRegistry ? service : new RolePromptRegistry()).resolve(role, base, roleScope(runner, input))
}
export function roleTools(runner) {
  const service = runner.roleTools ?? runner.ctx?.get?.(ROLE_TOOLS_SERVICE)
  return service instanceof RoleToolRegistry ? service : new RoleToolRegistry()
}
export function workspaceLeafTools(runner) {
  const { config } = runner
  if (config.transport !== 'direct' || !config.direct?.runtime) return []
  const registry = roleTools(runner), root = config.projectRoot
  const scope = { workflowId: runner.workflowId, sessionId: runner.controller?.session?.id }
  const names = registry.extensions('executor', scope, root).filter(row => row.workspaceRoot).map(row => row.toolId)
  return names.length ? registry.select('executor', names, scope, root).allowed : []
}
export function leafBindingTools(runner) {
  return [...new Set([...leafAllowedTools(runner.ctx, runner.config), ...workspaceLeafTools(runner)])]
}
export function roleMessagesMatch(record, messages) {
  return record && (record.baseMessagesHash === digest(messages) || digest(record.payload.messages) === digest(messages))
}
export function roleInputsMatch(record, messages) {
  return record && (record.baseInputHash === digest(messages.slice(1)) || digest(record.payload.messages.slice(1)) === digest(messages.slice(1)))
}
