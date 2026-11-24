# Direct 工具错误策略（本地待发布）

Direct 执行器默认将原生工具的失败结果交给当前 Agent。失败不是成功证明，也不证明没有副作用；宿主不自动重试。原始展示文本、`isError`、结构化 `error`、`meta` 和可用的 `value` 保留在执行证据中。Messages API 使用原生 `is_error`，Chat Completions 将错误信息保留在工具内容中，不发送非标准 `isError` 消息字段。

## 配置文件与整工具规则

随包黑名单在 [policies/tool-errors.json](./policies/tool-errors.json)。`rolePolicyFile` 中的 `toolErrors` 支持 `mode`、`includeDefaults` 和 `rules`。手动加入一个工具名即可匹配该工具报告的全部错误。也可以填写 `toolId`、`errorCode`、`errorType`、`when` 和可选 `role`。省略角色覆盖所有适用角色。错误类型匹配结构化异常名或类型，错误码匹配结构化 code，同时填写时两者都须匹配。普通成功回执继续执行。原生错误标志、结构化错误以及工具显式返回的 `{status:"ERROR"}` 或 `{error:…}` 可识别为失败。已有 `when` 规则也可以明确指认封装在成功结果中的故障。

默认 `mode: "blacklist"` 将命中的错误交给任务图暂停，其余错误连同原工具回执交给当前角色。`mode: "whitelist"` 将未列入白名单的错误交给任务图暂停。文件条目默认加入当前模式的名单，插件通过查询得到的登记入口加入该名单。同一工具 ID 先选最高 `priority` 再匹配错误条件，同优先级的暂停决定优先。省略优先级按 0 处理。`includeDefaults: false` 可去掉随包规则。暂停记录包含工具、角色、调用身份、匹配规则和原因。

```json
{
  "version": 1,
  "toolErrors": {
    "mode": "blacklist",
    "rules": ["archive_commit", { "toolId": "archive_read", "errorType": "StorageError", "errorCode": "E_IO" }]
  }
}
```

## 注册协议

插件通过 Cordis 服务 `dynamicContextToolPolicies` 查询当前策略和登记规则。底层 `dynamicContextToolErrors` 仍提供兼容接口与规则快照。

```js
export const name = 'my-storage-plugin-policy'
export const inject = ['tools', 'dynamicContextToolPolicies']
export function apply(ctx) {
  const toolId = ctx.tools.get('my_storage_read').name
  const target = ctx.get('dynamicContextToolPolicies').forTool(toolId).getStrategy({ target: 'toolErrors' })
  if (target.mode === 'blacklist') ctx.effect(() => target.register({
    pluginId: 'my-storage-plugin',
    registrationId: 'unrecoverable-store-error',
    priority: 20,
    when: {
      '/isError': true,
      '/error/info/code': 'STORE_CORRUPTED',
      '/error/info/retryable': false,
    },
    reason: '存储一致性已失效；修复并核对存储后再明确继续。',
  }))
}
```

- `toolId` 为 DSH 工具注册表中的内部 `definition.name`，不是界面标题、单次 `callId` 或执行 token。Direct 另行固定并核对实际工具定义与执行身份。
- `(pluginId, registrationId)` 标识一条联动声明，底层错误快照将其记作 `ruleId`。`register()` 返回只撤销本条声明的幂等函数，插件可用 `ctx.effect` 管理其生命周期。
- `when` 以 JSON Pointer 精确匹配工具结果的 `isError`、`error`、`value`、`meta` 字段。一个对象内的条件须同时满足。多个候选值可登记在同一优先级的多条规则中。
- 支持字符串、有限数字、布尔、null；缺失字段不等于 null。不支持通配工具名、前缀、子串、正则、任意回调或按渲染文本猜测错误代码。禁止原型链路径。原生异常若没有结构化 code，可用精确 `/error/message`；稳定的错误 code 更适合长期维护。
- 工具也可能以成功封装返回故障状态，例如 `/value/sandbox/runnerFailed`。因此规则不隐式要求 `isError=true`；需要时显式填写该条件。
- `pluginId` 是可信宿主插件的归属标签，不是对插件包身份的安全认证。保留的原生规则命名空间不能被外部注册覆盖。
- `list()` 查看规则，`snapshot()` 返回冻结规则及摘要。每次叶执行或明确接续时固定一份快照；运行中注册/撤销不会回改已经在执行的请求，下一次执行边界生效。旧快照和命中原因始终留存。

## 原生预置规则与程序边界

预置 `bash` 的 `value.kind=foreground && value.sandbox.runnerFailed=true`：原生终端隔离设施本身失败。该规则还要求来自实际启用的原生 shell 模块，外部插件同名工具不会获得原生分类。

以下一般反馈给 Agent：文件不存在、编辑未匹配/匹配歧义、无效编辑、读写权限拒绝、审批拒绝或不可用、搜索和网络失败、无效参数、普通终端错误、被隔离机制成功拒绝的操作、未登记的插件错误。Plan、路径、后台执行和提权等请求被拒绝时，仍不执行操作，返回准确的准入反馈。已确认的写入前拒绝或终端超时仍可延后同批未开始的调用，但不会因而阻塞整个任务。

以下属于宿主控制或执行完整性故障，仍独立停止：用户取消，执行身份/工具定义被替换，嵌套派发，借工具绕过独立模型通道，运行中权限与指令发生变化，隔离完整性失效，以及可信检查点、证据哈希、日志写入故障。这些由实际宿主校验点裁定；第三方工具只是返回同名字串，不会因此升级为宿主故障。普通工具错误也不会获得权限放行。

控制器、预规划、执行、返工、辅助角色与压缩均按实际工具回执执行错误策略。各入口继续独立校验宿主权限、角色输出与状态转换。

## 命中后的状态与恢复

命中后记录工具 ID、调用 ID、规则归属、完整条件、原因和规则快照摘要；原始结果单独保留。journal 写入 `BLOCKED`，主工作流写入 `BLOCKED_TOOL_ERROR`，不再请求下一次模型或执行同批剩余工具。当前叶保留活动尝试及串行锁，不伪造叶完成/失败报告。

主会话的 `start`、`continue`、`approve`、`pause` 均不能消除这个阻塞。重启不自动启动。用户在任务图点击“继续”，才会确认当前阻塞检查点；恢复将已返回的错误与未执行后缀交回模型，不重放工具。受信宿主可用 `resumeActive({ ..., recover: true, acknowledgeToolError: checkpoint.checksum })` 执行同样的明确恢复；确认必须绑定当前检查点，不是通用永久开关。

恢复依赖 durable 检查点。未启用 durable 的失败仍保留 ACTIVE，需受信宿主进行既有人工恢复/核销流程，界面不会伪装成可以安全接续。规则本身继续有效；新的调用再次命中时会再次阻塞并要求新的确认。

## 适配与验证边界

本轮只改当前 DSH `0.2.1-rc.5` 本地维护线；其他维护线待后续适配。运行中的临时 DSH 安装包与会话不被热替换。既有提示词、已提交报告、任务图和真实计费记录不迁移。测试使用 fake backend，不消耗真实 API 额度。
