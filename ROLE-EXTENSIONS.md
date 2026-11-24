# 角色上下文、工具扩展与用户引导协议

### 预装上下文和动态材料的大小

`workflowLimits.preloadBytes` 按 UTF-8 字节计，默认 10,240（10 KiB）。外部 Skill 和插件提供者的文本在装配前校验，每个请求实际生效的替换、追加文本及连接分隔符也要合计校验。超过上限的注册或装配会明确报错。随包职责说明由插件维护。

`workflowLimits.dynamicMaterialBytes` 是一次装配共享事实、执行报告、历史及其他背景材料的总字节预算，默认 65,536 字节。超限时提供来源摘要、字节数、SHA-256 和分页参数。角色后台使用 `dynamic_context_read_evidence`，执行者使用 `dynamic_context_source_read`，控制器和首次规划者使用各自状态或历史工具。应使用当前请求返回的工具和标识，按返回的下一偏移继续读取。配置的模型后端、角色权限及原文可见范围继续生效。


此协议由动态上下文插件提供。任务图基础插件只增加通用的 `suspend` / `resolveSuspension` 事务端口，不包含 Skill、角色或引导业务；未使用端口的独立任务图行为不变。

## 随插件分发的默认上下文

插件配置项 `rolePolicyFile` 指定宿主管理的 JSON 文件。相对路径从 `projectRoot` 解析。每个 `skills[].file` 从该 JSON 文件所在目录解析，可直接指向 Skill 包内的 `SKILL.md`。插件启动时读取正文，去掉 YAML front matter，默认以 `replace` 装配。配置或 Skill 文件变更在下次加载插件时生效。可运行的配置和配套 Skill 在 [examples/role-policy.json](./examples/role-policy.json)。

每条声明指定 `role`，可选 `slot`、`scope`、`priority`、`registrationId`、`skillId` 和 `mode`。缺省槽位为 `role`。每个槽位分别选择优先级最高的替换，再追加匹配声明。多个插件的同优先级声明按插件和注册 ID 排序。宿主保留用户原始输入、目标、实时权限、上下文图事实、证据、历史回执和输出校验。执行者的工作指引附在任务输入中，修订、审计和引导角色的工作指引装入系统消息。

| 角色 | 可替换的默认材料 |
|---|---|
| `controller` | `entry` 模式入口说明、`role` 当前模式与交接指引 |
| `preplanning` | `role` 初始探查、规划与规则编写指引 |
| `executor`、`result_work` | `role` 已装配任务前的工作与报告指引、`runtime` Direct 原生执行环境的随包说明 |
| `unit_planner`、`unit_plan_audit`、`unit_rebaseline`、`unit_audit`、`unit_router`、`baseline_audit`、`result_check`、`result_repair`、`plan_check`、`updater`、`reviewer`、`blockage`、`blockage_audit`、`group_audit`、`scope_plan`、`scope_update`、`scope_audit`、`scope_blockage`、`scope_pause`、`task_reporter`、`progress_reporter`、`guidance_intake`、`guidance_router` | `role` 角色指引、`tools` 报告草稿操作指引、`archive` 证据归档导航 |
| `compaction` | `role` 检查点指引、`archive` 审查资料压缩指引、`image` 图像核验指引 |

`ROLE_CONTEXT_SLOTS` 导出相同目录。使用不存在的角色或该角色没有的槽位会在注册时报告错误。宿主插件可动态生成某个槽位的正文。同步提供者在装配时获得角色、槽位、只读作用域和默认正文，可以返回正文或 `undefined`。需要异步获取材料的插件可先在自己的服务中获取，再由提供者读取。已签发并持久化的角色请求复用当时的装配结果。

```js
ctx.effect(() => ctx.get('dynamicContextRolePrompts').registerProvider({
  pluginId: 'records', registrationId: 'audit-method', role: 'group_audit',
  slot: 'role', mode: 'append', priority: 10,
  assemble: ({ scope }) => methods.get(scope.workflowId),
}))
```

## 角色模型与 API 后端

单元路由者 `unit_router` 与基线审计者 `baseline_audit` 均为独立 Direct 角色。前者决定当前可执行单元直接交给执行者还是先回本层规划，后者核对单个既有单元的旧基线、新基线和修改依据。两者都提供 `role`、`tools`、`archive` 三个上下文槽位。默认工具策略为白名单，允许角色申报、读取当前角色证据及 `read_image`。第三方可登记具有 `read` 效果的工具回调。按 DSH 登记 ID 增减名单、按操作过滤及错误转交沿用下文协议。

以下为 `rolePolicyFile` 的配置示例。Skill 路径相对于配置文件，两个后端可分别指向不同 API。

```json
{
  "version": 1,
  "skills": [
    { "role": "unit_router", "slot": "role", "mode": "replace", "file": "skills/unit-routing/SKILL.md" },
    { "role": "baseline_audit", "slot": "role", "mode": "append", "file": "skills/baseline-review/SKILL.md" }
  ],
  "roleStrategies": { "unit_router": "whitelist", "baseline_audit": "whitelist" },
  "modelBackends": {
    "routing": { "model": "routing-model", "direct": { "endpoint": "http://127.0.0.1:8080/v1/chat/completions" } },
    "audit": { "model": "audit-model", "direct": { "endpoint": "http://127.0.0.1:8081/v1/chat/completions" } }
  },
  "roleModels": { "unit_router": "routing", "baseline_audit": "audit" }
}
```

其他插件可在某个单元上追加审计指引，调整模型，并按宿主工具 ID 登记允许的操作。下例的 `taskId` 取自当前工作流，`audit` 引用上面的后端。对容器的验收基线登记 `scopeId`，对叶的执行指令登记 `taskId`。返回的撤销函数可交给 `ctx.effect` 管理。

```js
const role = 'baseline_audit'
const scope = { workflowId, taskId }
ctx.effect(() => ctx.get('dynamicContextRolePrompts').registerProvider({
  pluginId: 'records', registrationId: 'baseline-method', role, scope,
  slot: 'role', mode: 'append', priority: 20, assemble: () => '逐项核对当前验收指令与原始用户条件。'
}))
ctx.effect(() => ctx.get('dynamicContextRoleModels').register({
  pluginId: 'records', registrationId: 'baseline-model', role, scope, priority: 20, backend: 'audit'
}))
const id = ctx.tools.get('record_store', agent).name
const target = ctx.get('dynamicContextToolPolicies').forTool(id, { agent })
  .getStrategy({ target: 'roleTools', role, scope })
if (target.mode === 'whitelist') ctx.effect(() => target.register({
  pluginId: 'records', registrationId: 'baseline-read', priority: 20, when: { '/operation': 'read' }
}))
```

在 `rolePolicyFile` 指定的 JSON 文件中，`modelBackends` 定义可复用的后端，`roleModels` 按角色 ID 引用后端名，也可直接填写后端对象。上表中有 27 个角色可独立选择模型。`compaction` 始终使用触发角色当次的模型和 API 后端，单独为它配置或登记后端会收到 `ROLE_MODEL_INHERITED`。例如，执行者可在本地 Chat Completions 接口执行并压缩，结果审计者可在另一套 Messages 接口审计并压缩。[完整配置示例](./examples/role-models.json)

| 调用方式 | 配置方式 |
|---|---|
| DSH 原生会话，包括控制器和首次预规划 | `provider` 填 DSH 已登记的提供方 ID，`model` 填该提供方的模型 ID。地址和凭据由这个提供方管理。仅填写 `model` 时沿用当前提供方。|
| Direct 执行、审计与其他独立角色 | 仅填写 `model` 可共用原有连接。切换 API 时填写完整 `direct.endpoint`，按需指定 `api`、`protocol`、`auth`、`apiKeyEnv`、思考与采样设置。新连接只使用其自身的认证设置，`apiKeyEnv` 填凭据引用名。更换 Direct 提供方 ID 须同时指定连接。|

配置文件在插件加载时读取。宿主插件可通过 Cordis 服务 `dynamicContextRoleModels` 动态登记一条选择。`register` 返回撤销函数。`resolve(role, scope)` 返回命中的 `backend`、来源和可选的 `backendId`，返回 `null` 表示沿用宿主已有路线。`list()` 提供文件配置、插件登记和压缩继承关系的副本。可选范围包括 `workflowId`、`sessionId`、`scopeId`、`taskId`，填写的字段须全部匹配。

```js
const models = ctx.get('dynamicContextRoleModels')
ctx.effect(() => models.register({
  pluginId: 'example.review', registrationId: 'audit-for-workflow',
  role: 'result_check', scope: { workflowId: 'workflow_example' },
  priority: 20, backend: 'audit'
}))
const effective = models.resolve('result_check', { workflowId: 'workflow_example' })
```

匹配的插件登记优先于角色的文件设置。多个插件同时命中时取最高 `priority`，同分时按插件 ID 和登记 ID 的稳定顺序取后者，登记顺序不影响结果。撤销后，新调用使用下一条匹配登记、文件设置或宿主默认。已开始的 Direct 单元和审计将有效连接、模型及凭据引用随检查点保存，重试和恢复继续使用同一份配置。独立预规划会话也保存所选 DSH 提供方与模型。控制器在每次原生请求准备时重新解析，在普通对话中沿用 DSH 的选择。

## 工具功能级准入

随包角色策略与工具清单在 [policies/role-defaults.json](./policies/role-defaults.json)。宿主可在 `rolePolicyFile` 的 `roleStrategies` 以角色 ID 为键设置 `whitelist` 或 `blacklist`，在 `roleTools` 手动追加整工具或参数规则。其他插件使用 Cordis 服务 `dynamicContextToolPolicies`。

先从 DSH 取得当前可见定义的 `name`，再用 `forTool(id)` 绑定该登记 ID。对于登记在特定 Agent 下的工具，读取定义和绑定时传入同一 Agent。随后调用 `getStrategy` 取得目标位置的实际 `mode` 及其 `register` 方法。每次登记都与查询的工具 ID、目标和模式绑定。工具定义在这两步之间被撤销或替换时，调用者须重新绑定和查询。插件自己的 `registrationId` 用于撤销和追溯这一条声明。

```js
const toolId = ctx.tools.get('example_records').name
const tool = ctx.get('dynamicContextToolPolicies').forTool(toolId)
const audit = tool.getStrategy({ target: 'roleTools', role: 'group_audit' })
// 该插件希望审计者可读已核验记录，且禁止修改。
const operation = audit.mode === 'whitelist'
  ? { '/action': 'read', '/options/verified': true } : { '/action': 'edit' }
ctx.effect(() => audit.register({
  pluginId: 'records', registrationId: 'audit-records', priority: 20, when: operation,
}))

const errors = tool.getStrategy({ target: 'toolErrors' })
const errorType = errors.mode === 'blacklist' ? 'CorruptStore' : 'RecordMissing'
ctx.effect(() => errors.register({
  pluginId: 'records', registrationId: 'record-errors', priority: 20, errorType,
}))
```

字符串条目匹配整工具，对象条目按调用参数内的 JSON Pointer 精确匹配。一个对象的条件全部满足才命中。不同条目可代表不同功能，缺失字段与 `null` 有区别。
`priority` 为整数，缺省为 0。每个登记位置按当前角色和作用域，分别选取该工具 ID 的最高优先级，再判断操作或错误条件。因此优先级 20 的“只读”白名单可覆盖优先级 5 的“整个工具”。同级追加白名单合并允许的操作，匹配的同级禁用或暂停优先。撤销最后一条高优先级登记后，下层登记重新生效。其他 ID、其他角色及另一类名单分别计算。

省略 `when` 表示整个工具。显式 `combine: "restrict"` 的白名单还限定整个角色可见的工具范围，旧 `toolIds` 写法保留这一交集语义。工具须已在该角色的宿主环境中挂载，并满足任务绑定、角色权限与宿主授权。模型请求固定签发时的权限，实际派发也检查当前权限。

## Skill 插件扩展

宿主插件通过 `ctx.get('dynamicContextRolePrompts')` 和 `ctx.get('dynamicContextRoleTools')` 注册。注册接口不作为模型工具开放；Skill 文件中的文字本身不能注册权限。

```js
import { ROLE_PROMPTS_SERVICE } from 'dsh-dynamic-context/role-policy'
export const inject = [ROLE_PROMPTS_SERVICE]
export function apply(ctx) {
  const prompts = ctx.get(ROLE_PROMPTS_SERVICE)
  const disposePrompt = prompts.register({
    pluginId: 'example/research-skill', registrationId: 'leaf-research',
    role: 'executor', mode: 'append', priority: 10,
    text: '对于有多种合理实现的开放问题，比较证据与代价后，在本叶边界内自主选择。',
    // scope 可限定 workflowId、sessionId、taskId、scopeId；省略表示全局。
  })
  ctx.on('dispose', disposePrompt)
}
```

`mode: 'replace'` 替换角色的可扩展工作提示词。最高 priority 的替换生效，同优先级按 pluginId/registrationId 稳定排序；全部 append 随后追加。角色 ID、输入范围、输出协议、权限和状态机门控仍由宿主保留。固定用户目标、绑定上下文、共享上下文以及验收数据不会被替换文本删除。

`ROLE_CONTRACTS` 导出全部角色及工具效果上限。包括 controller、preplanning、executor、result_work、result_check、result_repair、plan_check、updater、reviewer、blockage、blockage_audit、group_audit、scope_plan、scope_update、scope_audit、scope_blockage、scope_pause、task_reporter、progress_reporter、guidance_intake、guidance_router、compaction。

初始规划和执行的默认策略为黑名单，审查、报告和路由角色使用白名单。宿主可通过 `tools.defaults(role)` 查询随包规则与已配置的角色策略，或运行 `npm run tools:check` 检查工具覆盖。角色分派会重新检查已签发权限和当前权限。压缩角色按自身名单使用内建 `read_image`，角色提示词与实际能力分别装配。详见[默认 107 个工具 ID 与角色映射](./ROLE-TOOL-DEFAULTS.md)。

所有角色的默认名单均允许 `read_image`。主会话和首次规划复用原生附件通道；Direct 执行者与只读角色也将附件实体送入模型请求。必须具备宿主附件服务及当前模型路由声明的图像输入能力；缺失时返回明确错误，不将文件身份或 OCR 当作已完成视觉核验。权限名单、工具实际挂载、附件传输和模型能力是四个独立条件。新增能力用于新请求序列，已冻结的旧序列保留其原有工具和请求快照。

已经挂载的 DSH 工具可直接用上述 ID 协议登记名单。如果插件还要提供角色专用的执行回调，可沿用 `registerTool`，声明其效果、结构和逐次宿主授权。

```js
const dispose = tools.registerTool({
  pluginId: 'example/research-skill', registrationId: 'lookup-v1',
  toolId: 'example_lookup', roles: ['group_audit'], effect: 'read',
  scope: { workflowId: '实际工作流ID' },
  schema: { type: 'function', function: {
    name: 'example_lookup', description: '读取该工作流中已授权的资料。模板：{"id":"资料ID"}',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
  } },
  authorize: ({ scope, sourceAgent }) => Boolean(sourceAgent && scope.workflowId === '实际工作流ID'),
  execute: async ({ id }, context) => ({ id, text: '从该宿主插件已授权的资料服务读取的结果' }),
})
```

`effect` 为 read、report、work；审计者不能注册 work 工具。不能覆盖内建同名工具。执行者的额外工具还必须得到宿主 allowedTools 和叶绑定的许可。回调是受信任宿主代码，应调用其服务自身的权限入口，声明 read 不构成操作系统隔离。宿主注册不可代替原生权限。工具完成回执在恢复时复用；只存在 STARTED、没有已知结果的调用不会自动重放。

只读扩展若需生成供本次审计查看的文件，在注册时指定 `workspaceRoot`、`effect: 'read'` 和 `auditArtifacts: true`。回调通过 `auditArtifacts.resolveInput(path)` 读取已授权的工作区文件，在 `auditArtifacts.outputDirectory` 下创建自己的子目录并写入成果，然后调用 `auditArtifacts.publish(folder, filenames)`。该方法记录指定文件的 SHA-256 并返回带末尾斜线的引用前缀。将前缀与原文件名拼接即可作为 `read_image` 的 `file_path` 返回给模型。文件名可以包含子目录或省略扩展名，图片格式和读图限制由 DSH 原生工具判定。每个引用只在签发它的审计中有效，文件内容改变后须重新签发。既有审计仍可读取自己的历史引用。

领域工作步骤和示例放在提供该能力的插件 Skill 中。需要在只读角色中展示时，可在对应工具的说明中引用同一份 Skill 内容，并通过注册时的角色和工作区范围控制可见性。

## 用户引导

真实用户消息进入持久队列；完成当前正在运行的工具，保留结果，在下一次工具调用前交接。思考期间到达的指引可以让该思考返回的旧工具批次全部暂不执行。原始请求、未执行标记、引导原文和分派记录分别保存。

识别阶段判定层次、意图、目标、前提和歧义；路由阶段只派发串行角色，不自行执行工作或验收。多个唤起按队列执行。角色前提不成立时不能伪造报告/候选/审批；精确定位后等待相应阶段。新的明确指引可按 job ID 取代未完成的旧唤起，已经发生的工具效果不会被撤销。引导意图高于旧计划及 Skill 文本，但不会扩大宿主权限或让审计者代替执行者。

分层图中即时改图可挂起当前未完成尝试，直接进入对应层的更新与独立审计。挂起持有串行执行权，不能启动其他叶；证据冻结而不伪造处置报告。任务契约、前置和完整上下文版本均未变时恢复原检查点；否则结束旧尝试的调度资格，在新尝试装入未完成证据入口。历史工具效果仍然真实，应核对后复用，不能因新尝试而盲目重做。旧式平面图仍遵守原来的结果受理和改图前置，不假造分层范围。

“当前进度”“中间总体报告”由 progress_reporter 处理。只读上下文包括当前层状态、相关已受理报告、共享事实和按需执行证据，输出明确标为途中报告，不设置完成或验收状态。原本运行则随后继续；原本暂停则保持暂停。task_reporter 只承担终审后的最终报告，既有正式报告不可被此入口改写。

## 格式化报告工具

所有新 direct 执行报告和内建监督、修改、审计、引导、总结角色提供：

- `dynamic_context_generate_report({report: <当前角色标准对象>})`：生成并检查；须单独调用。
- `dynamic_context_read_report({path: '/指定字段'})`：读取草稿及 revision，也可按文本范围读取。
- `dynamic_context_rewrite_report({expectedRevision, edits:[{op:'set',path:'/字段',value:...}]})`：原子局部修改；支持 remove、唯一文本替换。
- `dynamic_context_submit_report({expectedRevision})`：重新检查并提交，成功后无需再全文输出。

各角色原本的标准模板和完整上下文保留。语法、字段、引用和该角色的程序性检查在工具内运行；拒绝携带路径和原因，草稿保留。目录 SHA 和测试引用仍由程序校验，工具成功不是审计通过。执行报告提交保留真实 tool_calls 终止记录，不伪装成模型 stop 响应。旧的 final JSON 路线和已经冻结的旧请求保留兼容。原生无 direct 执行环境仍使用原报告通路。

若报告工具已返回成功、尚未语义验收时收到用户引导，宿主记录重新开放草稿的边界，允许执行者按新指引局部修改和重新提交。恢复时按原回执和该边界重建草稿，不重新执行工作工具，也不重算旧提交当时的文件校验。已受理报告保持不变。

## 大归档审计

已受理组报告中的工作区观察索引与明确引用的历史观察，可通过 `dynamic_context_blockage_report` 按 `workspace:<审计运行ID>:<序号>` 读取。返回的是当次审计保存并核对身份的只读回执，不会重新打开旧文件路径，也不授予当前工作区读写权限；同一文件较早的已引用分页仍可读取。来源仍受当前组范围过滤，回执缺失或身份变化会返回明确错误。引用中的 JSON Pointer 相对于来源值，例如 `/text` 或 `/fileSha256`，不包含工具返回包装层的 `/value`。

工作区 ZIP 工具改为流式读取和成员校验，取消压缩文件及展开累计的 128 MiB 配额；字节身份工具也无固定文件体积配额。不提取文件，保留路径隔离、只读权限、成员路径/CRC/SHA 校验、分页和取消信号。ZIP32 的格式上限不等于人为配额；ZIP64、分卷、加密等仍返回明确格式限制。16 MiB 文本解码上限、目录分页上限以及可配置的持久日志预算是其他机制，未冒充归档限制一并移除。
