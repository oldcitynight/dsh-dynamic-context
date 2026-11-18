// SPDX-License-Identifier: GPL-3.0-only
import Schema from '@deepseek-ai/schemastery'

const choice = (items, description) => Schema.union(items.map(([value, label]) => Schema.const(value).description(label))).default('configured').description(description)
const limit = (max, description) => Schema.number().step(1).min(-1).max(max).default(-1).description(description + '：-1 沿用配置文件，0 不额外限制。')
export const preferenceSchema = Schema.object({
  permissionMode: choice([['configured', '沿用配置文件'], ['auto', '继承主会话'], ['read-only', '只读上限'], ['workspace-write', '工作区写入上限'], ['danger-full-access', '完整访问上限']], '执行权限（始终不超过主会话授权）'),
  approvalPolicy: choice([['configured', '沿用配置文件'], ['auto', '继承主会话'], ['ask', '允许询问批准'], ['never', '不询问批准']], '工具批准策略'),
  reasoningEffort: choice([['configured', '沿用配置文件'], ['auto', '继承主会话'], ['off', '关闭'], ['low', '低'], ['high', '高'], ['max', '最高']], '推理强度'),
  maxGroupDepth: Schema.number().step(1).min(0).max(16).default(0).description('组嵌套层数，含根层、不含叶任务；0 沿用配置文件。'),
  contextWindow: Schema.union([Schema.const(0).description('沿用配置文件'), Schema.number().step(1).min(131072).max(1048576)]).default(0).description('模型上下文窗口（token）；同步原生压缩阈值，不改变模型实际容量。'),
  maxRequestsPerTask: limit(256, '每角色额外请求次数上限'),
  timeoutMs: Schema.union([Schema.const(-1), Schema.const(0), Schema.number().step(1).min(10).max(1800000)]).default(-1).description('每角色额外超时（毫秒）：-1 沿用配置文件，0 不额外限制。'),
  maxContextCharacters: limit(8388608, '请求上下文字符上限'),
  maxReportCharacters: limit(8388608, '报告字符上限'),
  maxToolOutputCharacters: Schema.union([Schema.const(-1), Schema.const(0), Schema.number().step(1).min(256).max(8388608)]).default(-1).description('工具输出字符上限：-1 沿用配置文件，0 不额外限制。'),
}).description('新任务默认设置：仅在重新启用完整任务图模式时读取；已有任务保留选用的设置。主会话权限变化仍实时生效。')

export const readPreferences = value => structuredClone(preferenceSchema(value?.get ? value.get() : value ?? {}))
export function withPreferences(base, preferences = {}) {
  const value = readPreferences(preferences), config = structuredClone(base)
  if (config.direct) {
    if (value.reasoningEffort !== 'configured') config.direct.reasoningEffort = value.reasoningEffort
    if (config.direct.runtime) {
      if (value.permissionMode !== 'configured') config.direct.runtime.sandboxMode = value.permissionMode
      if (value.approvalPolicy !== 'configured') config.direct.runtime.approvalPolicy = value.approvalPolicy
      if (value.maxToolOutputCharacters !== -1) config.direct.runtime.maxToolOutputCharacters = value.maxToolOutputCharacters || null
    }
    if (value.contextWindow) {
      config.direct.contextWindow = value.contextWindow
      if (config.direct.compaction?.strategy === 'dsh-native') config.direct.compaction.contextWindow = value.contextWindow
    }
  }
  if (value.maxGroupDepth) config.hierarchy = { ...config.hierarchy, maxGroupDepth: value.maxGroupDepth }
  for (const key of ['maxRequestsPerTask', 'timeoutMs', 'maxContextCharacters', 'maxReportCharacters'])
    if (value[key] !== -1) config[key] = value[key] || null
  return config
}

/** Native Settings owns persistence/revisions. The workflow saves its selected
 * preferences separately so a live form edit cannot rewrite a running task. */
export function settingsConfig(validate) {
  const schema = Schema.object({ preferences: preferenceSchema.default({}).volatile() })
  Object.defineProperty(schema, '~standard', { get: () => ({ version: 1, vendor: 'schemastery', validate(input) {
    try {
      const value = schema(input), { preferences, ...base } = value
      if (base.enabled !== false) validate(withPreferences(base, readPreferences(preferences)))
      return { value }
    } catch (error) { return { issues: error.issues ?? [{ message: error.message, path: error.options?.path ?? [] }] } }
  } }) })
  return schema
}
