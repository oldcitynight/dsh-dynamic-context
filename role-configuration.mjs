// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { digest } from 'dsh-better-task-grapth/core'
import { located } from 'dsh-better-task-grapth/validation'
import { RolePromptRegistry, RoleToolRegistry } from './role-policy.mjs'
import { ToolErrorPolicy } from './tool-error-policy.mjs'
import { policyPriority } from './policy-selectors.mjs'
import { RoleModelRegistry } from './role-models.mjs'

export const TOOL_POLICIES_SERVICE = 'dynamicContextToolPolicies'

const targetSchema = z.discriminatedUnion('target', [
  z.object({ target: z.literal('roleTools'), role: z.string(), scope: z.record(z.string(), z.string()).optional() }).strict(),
  z.object({ target: z.literal('toolErrors'), role: z.string().optional() }).strict(),
])
const registration = z.object({ pluginId: z.string(), registrationId: z.string(), priority: policyPriority.default(0),
  when: z.record(z.string(), z.unknown()).optional() }).strict()
const errorRegistration = registration.extend({ errorCode: z.string().optional(), errorType: z.string().optional(), reason: z.string().optional() })

/** Plugin-to-plugin negotiation. Only DSH can supply a tool identity. The
 * destination returned by getStrategy owns the list choice and target ID. */
export function toolPolicyInterface(dshTools, { tools, errors }) {
  return Object.freeze({
    forTool(toolId, { agent } = {}) {
      const definition = typeof toolId === 'string' && dshTools.get(toolId, agent)
      if (!definition || definition.name !== toolId)
        throw located('DSH_TOOL_ID_NOT_REGISTERED', { path: '/toolId', item: toolId, reason: 'Use the exact tool ID visible in this DSH registry scope.' })
      return Object.freeze({ toolId, getStrategy(destination) {
        const { target, role, scope } = targetSchema.parse(destination)
        if (role !== undefined) tools.strategy(role)
        const mode = target === 'roleTools' ? tools.strategy(role) : errors.mode
        return Object.freeze({ toolId, target, role, mode, register(input) {
          if (dshTools.get(toolId, agent) !== definition)
            throw located('DSH_TOOL_REGISTRATION_CHANGED', { path: '/toolId', item: toolId, reason: 'Resolve the current DSH registration and query its destination again.' })
          if (target === 'roleTools') {
            const { when, ...entry } = registration.parse(input)
            return tools.register({ ...entry, role, scope, mode, tools: [when ? { toolId, when } : toolId] })
          }
          const { registrationId: ruleId, ...entry } = errorRegistration.parse(input)
          return errors.register({ ...entry, ruleId, role, toolId, list: mode })
        } })
      } })
    },
  })
}

const configEntry = z.record(z.string(), z.unknown())
export const inlineRolePolicySchema = z.object({
  version: z.literal(1),
  modelBackends: z.record(z.string(), configEntry),
  roleModels: z.record(z.string(), z.union([z.string(), configEntry])),
  roleStrategies: z.record(z.string(), z.enum(['whitelist', 'blacklist'])),
  skills: z.array(configEntry),
  roleTools: z.array(configEntry),
  toolErrors: z.object({ mode: z.enum(['blacklist', 'whitelist']), includeDefaults: z.boolean(),
    rules: z.array(z.union([z.string().min(1), configEntry])) }).partial().strict(),
}).partial().strict()
const configSchema = inlineRolePolicySchema.extend({ version: z.literal(1) })
const owner = 'dsh-dynamic-context/config'

// Map entries override the same ID. An explicitly supplied list replaces the corresponding file list.
export function resolveRolePolicy({ rolePolicyFile, rolePolicy, projectRoot } = {}) {
  const file = rolePolicyFile && path.resolve(projectRoot ?? '.', rolePolicyFile)
  const base = file ? configSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8'))) : { version: 1 }
  const overlay = inlineRolePolicySchema.parse(rolePolicy ?? {})
  return configSchema.parse({
    skills: [], roleTools: [], ...base, ...overlay,
    modelBackends: { ...base.modelBackends, ...overlay.modelBackends },
    roleModels: { ...base.roleModels, ...overlay.roleModels },
    roleStrategies: { ...base.roleStrategies, ...overlay.roleStrategies },
    toolErrors: { rules: [], ...base.toolErrors, ...overlay.toolErrors },
  })
}

// Resolve a host-selected policy before publishing any registry. Its Skill
// files are relative to that policy, independent of the model's workspace.
export function createRolePolicies(options = {}, config = resolveRolePolicy(options)) {
  const { rolePolicyFile, projectRoot, provider, transport, workflowLimits } = options
  const baseDir = rolePolicyFile ? path.dirname(path.resolve(projectRoot ?? '.', rolePolicyFile)) : path.resolve(projectRoot ?? '.')
  const models = new RoleModelRegistry(config.modelBackends, config.roleModels, { provider, transport })
  const prompts = new RolePromptRegistry(workflowLimits?.preloadBytes), tools = new RoleToolRegistry(config.roleStrategies), errors = new ToolErrorPolicy(config.toolErrors)
  for (const { file: skill, ...entry } of config.skills) {
    const location = path.resolve(baseDir, z.string().trim().min(1).parse(skill))
    const text = fs.readFileSync(location, 'utf8').replace(/^\uFEFF/, '').replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '')
    prompts.register({ mode: 'replace', registrationId: 'skill_' + digest([entry, skill]), ...entry, pluginId: owner, text })
  }
  for (const entry of config.roleTools) tools.register({ registrationId: 'tools_' + digest(entry), ...entry, pluginId: owner })
  for (const rule of config.toolErrors.rules) {
    const entry = typeof rule === 'string' ? { toolId: rule } : rule
    errors.register({ ruleId: 'error_' + digest(entry), list: errors.mode, ...entry, pluginId: owner })
  }
  return { prompts, tools, errors, models }
}
