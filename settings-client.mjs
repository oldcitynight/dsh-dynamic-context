// SPDX-License-Identifier: GPL-3.0-only
import { installConfigCard, configField, unitLimitFields } from 'dsh-better-task-grapth/settings-form'
export const preferenceFields = [
  { key: 'permissionMode', label: '执行权限', hint: '继承主会话；选定的上限不会扩大主会话授权。', choices: [['configured', '按配置'], ['auto', '继承'], ['read-only', '只读'], ['workspace-write', '工作区'], ['danger-full-access', '完整访问']] },
  { key: 'approvalPolicy', label: '工具批准', hint: '主会话的批准策略始终生效。', choices: [['configured', '按配置'], ['auto', '继承'], ['ask', '可询问'], ['never', '不询问']] },
  { key: 'reasoningEffort', label: '推理强度', hint: '自动继承主会话；明确强度仅适用于 DeepSeek 接口。', choices: [['configured', '按配置'], ['auto', '继承'], ['off', '关闭'], ['low', '低'], ['high', '高'], ['max', '最高']] },
  { key: 'contextWindow', label: '上下文窗口（token）', hint: '0 沿用配置文件；131072–1048576。同步原生压缩阈值，不改变模型实际容量。', min: 131072, max: 1048576, zero: true },
  { key: 'maxRequestsPerTask', label: '每角色额外请求次数上限', min: 1, max: 256, limit: true },
  { key: 'timeoutMs', label: '每角色额外超时（毫秒）', min: 10, max: 1800000, limit: true },
]
export const configGroups = [
  { title: '安装与工作模式', fields: [
    configField('enabled', '启用动态上下文', 'boolean'),
    configField('interaction.commandMode', '/task-graph 的默认模式', 'choice', { choices: ['full', 'ask', 'task-graph', 'native'], labels: ['完整单元工作流', '每次询问新会话', '独立任务图', '原生对话'] }),
    configField('interaction.mode', '运行入口', 'choice', { choices: ['interactive', 'host'] }),
    configField('interaction.orchestration', '程序编排', 'boolean'),
    configField('supervision', '监督执行', 'boolean'), configField('supervisionContext', '监督输入', 'choice', { choices: ['reports','legacy'] }),
    configField('preplanningAcceptance', '预规划验收', 'boolean'), configField('unitFinalReport', '单元最终报告', 'boolean'),
    configField('exposeControlTools', '开放控制工具', 'boolean'), configField('interop.enabled', '任务图联动', 'boolean', { choices: ['true'], labels: ['必需'] }),
    configField('interop.workflowId', '宿主工作流 ID', 'text', { hint: '交互模式为各个会话生成独立 ID。' }),
  ] },
  { title: '单元与材料限制', fields: unitLimitFields },
  { title: '工作目录与存储', fields: [
    configField('projectRoot', '项目根目录'), configField('storageRoot', '私有存储根目录'), configField('directory', '工作流数据目录'),
    configField('storageFormat', '新实例存储格式', 'choice', { choices: ['auto', 'sqlite', 'files'] }),
  ] },
  { title: '模型与 API 连接', fields: [
    configField('provider', '模型提供方'), configField('model', '模型 ID'),
    configField('transport', '请求通道', 'choice', { choices: ['direct', 'native-guarded'] }),
    configField('direct.endpoint', 'API 地址'), configField('direct.api', 'API 类型', 'choice', { choices: ['deepseek', 'openai-compatible'] }),
    configField('direct.protocol', '请求协议', 'choice', { choices: ['auto', 'messages', 'chat-completions'] }),
    configField('direct.auth', '认证方式', 'choice', { choices: ['deepseek-account', 'api-key'] }),
    configField('direct.apiKeyEnv', '凭据名称', 'text', {hint:'填写 DSH 凭据引用或环境变量名。密钥在 DSH 凭据设置中管理。'}),
    configField('direct.thinking', '模型思考设置', 'json', { hint: '{"type":"enabled"} 或 {"type":"disabled"}。' }),
    configField('direct.reasoningEffort', '模型推理强度', 'choice', { choices: ['auto','off','low','high','max'] }),
    configField('direct.responseModelAliases', '响应模型别名列表', 'json'),
    ...Object.entries({ temperature: '温度', top_p: '累积概率', top_k: '候选数', min_p: '最小概率', repeat_penalty: '重复惩罚',
      repeat_last_n: '重复检测长度', presence_penalty: '出现惩罚', frequency_penalty: '频率惩罚', seed: '随机种子' })
      .map(([key, label]) => configField('direct.generation.' + key, label, ['seed','top_k','repeat_last_n'].includes(key) ? 'integer' : 'number')),
  ] },
  { title: '执行、压缩与恢复', fields: [
    configField('systemPrompt', '固定系统提示', 'multiline'), configField('allowedTools', '允许的工具 ID 列表', 'json'),
    configField('maxInputTokens', '输入 token 预算', 'integer'), configField('maxOutputTokens', '输出 token 预算', 'integer'),
    ...[['maxRequestsPerTask','每角色请求次数'], ['timeoutMs','每角色超时（毫秒）'], ['direct.maxRequestBytes','请求字节限制'],
      ['direct.maxResponseBytes','响应字节限制']].map(([key, label]) => configField(key, label, 'integer', { nullable: true, hint: 'null 表示不额外限制。' })),
    configField('direct.streamIdleTimeoutMs', '流式响应空闲超时（毫秒）', 'integer'),
    configField('direct.durable', '持久化检查点', 'boolean'), configField('direct.tracePayloads', '请求记录方式', 'choice', { choices: ['references','inline'] }),
    configField('direct.reserveFinalReport','预留最终报告请求','boolean'), configField('direct.contextWindow','上下文窗口（token）','integer'),
    configField('direct.compaction','压缩策略与参数','json', {hint:'原生策略使用 strategy、contextWindow。字符策略使用 triggerCharacters、retainRecentExchanges、maxCompactions、maxCheckpointCharacters。null 关闭。'}),
    configField('direct.agentlessTools','无执行身份时允许的工具 ID','json'),
    configField('revision.maxOutputTokens','蓝图修订输出 token 数','integer'), configField('revision.policy.objective','蓝图修订目标','multiline'),
    configField('revision.policy.requirements','蓝图修订要求','json',{hint:'每条要求填写 id 和 text。交互工作流会采用用户任务的验收要求。'}),
  ] },
  { title: '执行环境与工具', fields: [
    ...[['modules','原生模块'], ['registeredTools','额外注册的工具 ID'], ['planReadTools','Plan 中允许读取的额外工具'],
      ['skills','允许的 Skill'], ['requiredSkills','必需的 Skill'], ['privateReadRoots','私有只读根目录'], ['toolContextSources','工具上下文来源']]
      .map(([key,label]) => configField('direct.runtime.' + key, label, 'json')),
    ...[['instructions','装载工作区指令'], ['plan','Plan 只读模式'], ['protectPrivatePaths','保护私有路径'], ['nativeRequestControls','原生请求控制']]
      .map(([key,label]) => configField('direct.runtime.' + key, label, 'boolean')),
    configField('direct.runtime.cwd','执行工作目录'), configField('direct.runtime.timeZone','时区'),
    configField('direct.runtime.instructionHomes','指令目录','json',{hint:'包含绝对路径 dshHome 与 agentsHome。'}),
    configField('direct.runtime.sandboxMode','执行权限上限','choice',{choices:['auto','read-only','workspace-write','danger-full-access']}),
    configField('direct.runtime.approvalPolicy','批准策略','choice',{choices:['auto','never','ask']}),
  ] },
  { title: '角色、Skill、工具与报错策略', fields: [
    configField('rolePolicyFile','角色策略文件路径'), configField('rolePolicy.version','角色策略格式版本','integer',{min:1,max:1}),
    ...[['modelBackends','命名模型及 API 后端'],['roleModels','各角色的模型后端'],['roleStrategies','各角色的工具白／黑名单策略'],
      ['skills','角色预装 Skill 登记'],['roleTools','按 DSH 工具 ID、操作和优先级登记']]
      .map(([key,label]) => configField('rolePolicy.' + key,label,'json')),
    configField('rolePolicy.toolErrors.mode','工具报错转交策略','choice',{choices:['blacklist','whitelist']}),
    configField('rolePolicy.toolErrors.includeDefaults','包含内置错误规则','boolean'), configField('rolePolicy.toolErrors.rules','错误类型、工具与转交规则','json'),
  ] },
  { title: '可选配置段', fields: [
    configField('direct.runtime', '完整执行环境配置', 'json', {hint:'可整段设置，null 关闭原生执行身份。'}),
    configField('revision', '完整蓝图修订配置', 'json', {hint:'可整段设置，null 清除修订配置；已启用监督时需要修订策略。'}),
    configField('direct', '完整 Direct 配置', 'json', {hint:'用于切换通道或整段替换；宿主对完整配置做一致性校验。'}),
  ] },
  { title: '新工作流偏好覆盖', fields: preferenceFields.map(f => configField('preferences.' + f.key, f.label, f.choices ? 'choice' : 'integer', {
    hint: f.hint, ...(f.choices ? { choices: f.choices.map(o => o[0]), labels: f.choices.map(o => o[1]) } : {}),
  })) },
]

export function installPreferenceSettings(ctx, React, primitives) {
  installConfigCard(ctx, React, primitives, { id: 'dsh-dynamic-context', title:'动态上下文', en:'Dynamic context', order:55, groups:configGroups,
    description:'新会话使用 /task-graph 进入完整单元流程。单元总数和新任务偏好可以即时保存。修改后端、策略或存储等部署项时，DSH 会重新装载插件。' })
}
