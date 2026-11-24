// SPDX-License-Identifier: GPL-3.0-only
import Schema from '@deepseek-ai/schemastery'
import fs from 'node:fs'
import path from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { parse as parseYaml } from 'yaml'
import { createRolePolicies, resolveRolePolicy } from './role-configuration.mjs'
import { defaultWorkflowLimits } from 'dsh-better-task-grapth/workflow-limits'

const choice = (items, description) => Schema.union(items.map(([value, label]) => Schema.const(value).description(label))).default('configured').description(description)
const limit = (max, description) => Schema.number().step(1).min(-1).max(max).default(-1).description(description + '：-1 沿用配置文件，0 不额外限制。')
export const preferenceSchema = Schema.object({
  permissionMode: choice([['configured', '沿用配置文件'], ['auto', '继承主会话'], ['read-only', '只读上限'], ['workspace-write', '工作区写入上限'], ['danger-full-access', '完整访问上限']], '执行权限（始终不超过主会话授权）'),
  approvalPolicy: choice([['configured', '沿用配置文件'], ['auto', '继承主会话'], ['ask', '允许询问批准'], ['never', '不询问批准']], '工具批准策略'),
  reasoningEffort: choice([['configured', '沿用配置文件'], ['auto', '继承主会话'], ['off', '关闭'], ['low', '低'], ['high', '高'], ['max', '最高']], '推理强度'),
  contextWindow: Schema.union([Schema.const(0).description('沿用配置文件'), Schema.number().step(1).min(131072).max(1048576)]).default(0).description('模型上下文窗口（token）；同步原生压缩阈值，不改变模型实际容量。'),
  maxRequestsPerTask: limit(256, '每角色额外请求次数上限'),
  timeoutMs: Schema.union([Schema.const(-1), Schema.const(0), Schema.number().step(1).min(10).max(1800000)]).default(-1).description('每角色额外超时（毫秒）：-1 沿用配置文件，0 不额外限制。'),
}).description('新任务默认设置：仅在重新启用完整任务图模式时读取；已有任务保留选用的设置。主会话权限变化仍实时生效。')

const preferenceDefaults = preferenceSchema({})
export const readPreferences = value => structuredClone(preferenceSchema(value?.get ? value.get() : value ?? {}))
export function withPreferences(base, preferences = {}) {
  const value = readPreferences(preferences), config = structuredClone(base)
  if (config.direct) {
    if (value.reasoningEffort !== 'configured') config.direct.reasoningEffort = value.reasoningEffort
    if (config.direct.runtime) {
      if (value.permissionMode !== 'configured') config.direct.runtime.sandboxMode = value.permissionMode
      if (value.approvalPolicy !== 'configured') config.direct.runtime.approvalPolicy = value.approvalPolicy
    }
    if (value.contextWindow) {
      config.direct.contextWindow = value.contextWindow
      if (config.direct.compaction?.strategy === 'dsh-native') config.direct.compaction.contextWindow = value.contextWindow
    }
  }
  for (const key of ['maxRequestsPerTask', 'timeoutMs'])
    if (value[key] !== -1) config[key] = value[key] || null
  return config
}

// The installed template uses the native DSH home. Explicit file-backed hosts keep their own root.
const installedDefaults = parseYaml(fs.readFileSync(new URL('./cordis.patch.yml', import.meta.url), 'utf8'))[0].insert[0].config
function overlayProfile(base, input) {
  if (!base || !input || typeof base !== 'object' || typeof input !== 'object' || Array.isArray(base) || Array.isArray(input)) return input
  const overrides = Object.fromEntries(Object.entries(input).map(([key, override]) =>
    [key, Object.hasOwn(base, key) ? overlayProfile(base[key], override) : override]))
  return { ...base, ...overrides }
}
export function deploymentConfig(input = {}) {
  // A complete profile owns its transport configuration. An empty or partial installation
  // (including an older disabled-only entry) starts from exactly the bundle's defaults.
  const config = input.transport === undefined ? overlayProfile(installedDefaults, input) : { ...input }
  if (config.workflowLimits?.maxUnits?.get) {
    config.workflowLimits = { ...config.workflowLimits, maxUnits: config.workflowLimits.maxUnits.get() }
  }
  config.projectRoot ??= fs.realpathSync(process.cwd())
  if (config.directory === undefined) {
    config.storageRoot ??= resolveDshHome()
    config.directory = path.join(config.storageRoot, 'dynamic-context')
  }
  return config
}

function checkDeploymentPaths(config) {
  const root = config.storageRoot ?? config.projectRoot
  if (!path.isAbsolute(config.projectRoot) || !fs.statSync(config.projectRoot).isDirectory())
    throw Error('EXPLICIT_REAL_PROJECT_REQUIRED')
  if (!path.isAbsolute(root) || fs.realpathSync(root) !== root || !fs.statSync(root).isDirectory() || !path.isAbsolute(config.directory))
    throw Error('EXPLICIT_ABSOLUTE_STORE_ROOT_REQUIRED')
  const relative = path.relative(root, config.directory)
  if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) throw Error('STORE_OUTSIDE_PROJECT')
  let directory = root
  for (const part of relative.split(path.sep)) {
    directory = path.join(directory, part)
    const info = fs.lstatSync(directory, { throwIfNoEntry: false })
    if (!info) break
    if (!info.isDirectory()) throw Error('STORE_SYMLINK_OR_NOT_DIRECTORY')
  }
}

export function settingsConfig(validate, keys) {
  // Settings projects only declared volatile fields. Return ordinary deployment values
  // so Cordis remounts structural edits; the existing preference references stay live.
  const fields = Object.fromEntries(keys.map(key => [key, Schema.any().volatile()]))
  const limits = Schema.object(Object.fromEntries(Object.entries(defaultWorkflowLimits).map(([key, value]) =>
    [key, Schema.number().step(1).min(key === 'maxUnits' ? 1 : 0).default(value).volatile()])))
  const schema = Schema.object({ ...fields, workflowLimits: limits, preferences: preferenceSchema.default({}).volatile() })
  Object.defineProperty(schema, '~standard', { get: () => ({ version: 1, vendor: 'schemastery', validate(input = {}) {
    try {
      const { preferences, ...raw } = input
      const base = deploymentConfig(raw)
      const parsedPreferences = schema({ preferences }).preferences
      // The form exposes deployment values before per-workflow preferences are applied.
      const value = validate(base)
      const selected = parsedPreferences.get()
      if (Object.keys(selected).some(key => selected[key] !== preferenceDefaults[key])) validate(withPreferences(base, selected))
      if (base.enabled !== false) {
        checkDeploymentPaths(value)
        if (base.rolePolicy || base.rolePolicyFile) {
          const policy = resolveRolePolicy(value)
          createRolePolicies(value, policy)
          if (base.rolePolicyFile) value.rolePolicy = policy
        }
      }
      const resolvedLimits = { ...defaultWorkflowLimits, ...value.workflowLimits }
      const maxUnits = limits({ ...resolvedLimits }).maxUnits
      return { value: { ...value, workflowLimits: { ...resolvedLimits, maxUnits }, preferences: parsedPreferences } }
    } catch (error) { return { issues: error.issues ?? [{ message: error.message, path: error.options?.path ?? [] }] } }
  } }) })
  return schema
}
