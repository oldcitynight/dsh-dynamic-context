# 无可执行叶时的阻塞处理

正常入口是完整联动流程的 `NO_READY_LEAF`。任务图未完成、没有活动叶、验收/补正/计划复查均已结束（`supervision.phase=READY`），且当前没有合法下一叶。已完成的图、仍有可执行叶的图、正在运行或等待验收的尝试继续走原有流程。技术异常、未知工具结果、丢图和损坏账本仍走原有恢复路径，不被改判成业务阻塞。

根层更新者转交其权限内无法解决的问题时，还有显式的 `ROOT_UPDATE_ESCALATED` 入口。诊断会标明转交理由及当前调度状态。任务图插件只增加通用、显式调用的返工接口；独立运行时的工具及全局提示词不增加阻塞处理角色。角色、装配、审核和调度均位于动态上下文插件。

## 状态及三条出口

| 阶段 | 动作 | 下一状态 |
| --- | --- | --- |
| `ANALYZE` | 先读程序诊断、各未完成组的直接卡点与依赖关系，再按需读取本工作流的根或指定组拓扑、任意叶报告、共享事实、执行记录和既往处置 | `REWORK`、`REVISING` 或 `PAUSE_REVIEW` |
| `REWORK` | 核对报告、证据及当前图版本；追加撤回事件，归档原成功报告，撤回相关已执行后继 | 以新 attempt 进入原串行执行流程 |
| `REVISING` | 处理者的理由、选定层级和程序卡点随信号交给独立更新者；候选更改记录经过程序检查及独立图审计 | 提交新双图；无修改/需要用户时将结果送回阻塞处理者 |
| `PAUSE_REVIEW` | 独立审核中断报告及引用原文；退回时提供具体项目、路径及原因 | 退回 `ANALYZE` 或进入 `WAITING_USER` |
| `WAITING_USER` | 主会话显示正常暂停，不继续请求模型 | 用户点击继续或回答恢复问题后重新判断 |

同一独占执行租约覆盖分析、只读检查和决策提交。图变更再次核对 checksum、revision 和控制器权限；分析本身不改变原图和原监督状态。图更新与审计串行执行，审计不继承更新者的思考历史。

暂停申请被批准之前，不进入“审核后等待”。已批准的等待不能由控制模型自行调用 `continue` 解除：工具入口需取得真实用户选择；前端继续按钮本身就是显式恢复。重启或读取状态不会自动启动。技术故障仍记录为意外暂停，需要显式恢复。

## 两个报告模板

模板中的 ID、hash、引用文字须替换为当前输入或只读工具返回的实际值。报告的 `sha256` 是程序提供的完整来源对象的 canonical JSON SHA-256；不要求模型计算文件 SHA。

返工报告：

```json
{"action":"REWORK","report":{"version":1,"findings":[{"taskId":"node_example","attemptId":"attempt_example","reasonCode":"MISSING_REQUIRED_RESULT","criterion":"必须检查全部规定输入","problem":"第二项规定输入未纳入本叶的检查结果","correction":"补做缺失检查并提交新执行报告","evidence":[{"source":"report:attempt_example","sha256":"<来源对象的实际SHA256>","path":"/result/summary","quote":"<该位置实际存在的原文>"}]}]}}
```

新协议允许选择一个真实卡点及其因果链进行返工。选中的旧尝试必须有独立发现，程序会核对依赖级联的实际范围。跨组撤回要选共同上级。已有的 v1 阻塞请求仍按原规则核对所有当前根因。`reasonCode` 可选 `CONTRADICTED_RESULT`、`MISSING_REQUIRED_RESULT`、`INVALID_TEST_EVIDENCE`、`RESOLVED_EXTERNAL_CONDITION`。最后一种还需要当前共享事实或另一个任务的观察作为新增佐证，旧受阻报告不能单独证明阻塞已经消除。

禁止仅以“它未完成导致后续无法推进”为理由打回报告。程序拒绝明确的此类循环理由，并要求实际结果/执行证据、当前 attempt、准确引用及根因覆盖；程序不能仅靠字符串判断证明所有语义结论正确，该判断仍属于阻塞处理角色的责任。

中断报告：

```json
{"action":"PAUSE","report":{"version":1,"summary":"缺少获准范围内的必要输入","constraints":[{"description":"必要输入尚未提供，当前没有可用替代路径","affectedTasks":["node_example"],"evidence":[{"source":"report:attempt_example","sha256":"<来源对象的实际SHA256>","path":"/result/summary","quote":"<该位置实际存在的原文>"}]}],"alternatives":{"rework":"再次执行仍缺少同一输入","replan":"固定验收标准依然需要该输入"},"resumeCondition":"必要输入已由用户提供","requestedUserAction":"提供具体缺失的输入"}}
```

审核只允许有证据支持的等待。退回意见必须包含真实 JSON Pointer、项目和原因，携带原中断报告返回阻塞处理者。批准模板为 `{"verdict":"APPROVE","reason":"证据支持等待","issues":[]}`；退回模板为 `{"verdict":"REJECT","reason":"具体缺项","issues":[{"path":"/submission/summary","item":"中断依据","reason":"缺少哪项证据"}]}`。

分层阻塞处理者在三类报告中都填写实际 `scopeId`。申请改图用 `{"action":"REPLAN","scopeId":"实际组ID","reason":"哪条前置卡住了哪些工作，为何需要本层改图"}`。单层图省略 `scopeId`。程序保留原始申报和来源，更新者独立判断修法。旧协议已经发出的请求沿用其原始格式。

更新者有三个出口。选择更改即提交含候选蓝图、具体改动、依据的更改记录；独立审计批准后才提交至双图。选择维持现状需说明可行路径。若程序预演维持现状会进入 BLOCK，就退回这一判定；候选修改应产生合法的下一步、可用的终审、完成状态，或解除至少一个独立卡点。转交上层时说明本层无法解决的边界。根层上交会回到阻塞处理者，继续保持 BLOCK 和等待用户均由阻塞处理者申请独立审核。

## 角色限定的只读工具

全图拓扑与处置历史仅开放给阻塞处理者。其余角色沿用各自的证据作用域。

| 工具 | 标准调用 |
| --- | --- |
| `dynamic_context_blockage_topology` | `{}` 读取根层，`{"scopeId":"组ID或key"}` 读取指定层的直属拓扑、状态及前置；同一调用加 `"view":"context"` 获取组内上下文绑定 |
| `dynamic_context_blockage_history` | `{"role":"scope_update","limit":10}` 按最近时间列举；用返回的 `source` 读取 `/decision`、`/reason`、`/record` 或 `/graphCommitRevision` |
| `dynamic_context_blockage_reports` | `{"taskId":"实际任务ID","kind":"trace","corrections":true}`，按任务分页发现原始及修订归档 |
| `dynamic_context_blockage_report` | `{"source":"report:attempt_example","path":"/result"}` |
| `dynamic_context_blockage_trace` | `{"source":"trace:attempt_example:0","path":"/events","start":0,"end":4000}` |
| `dynamic_context_blockage_shared` | `{"source":"shared","path":"/current"}` 或 `{"source":"shared","path":"/history"}` |

`path` 是来源内的 JSON Pointer，空字符串表示整个来源。分页位置为 UTF-16，按 `next` 续读；不会切断 Unicode 代理对。返回的 `sourceSha256` 标识完整来源，分页文本不能被误当成全文。只允许已登记的同工作流来源，拒绝任意文件路径、其他会话 ID 和写入。读取错误返回具体原因与参数位置。读取回执单独持久化，暂停后复用原结果，不把新读到的内容冒充旧回执。

新判定引用发起时的任务图事件。回滚后的实例读取历史时会核对事件身份，拒绝已知的未来版本和分叉记录。旧回执保留当时已有的来源与理由，工具用 `historyBinding` 标出依据；未形成判定的请求不能作为已完成决定。

大输入继续使用现有独立角色的分页及原生策略压缩；原文仍可回读，摘要不具有审批效力。没有新增单次请求预算或思考限制，继续使用宿主现有模型参数、窗口和总额度管理。

## 历史保全与恢复

原执行、验收和报告不被覆写。返工新增 `REOPENED` 事件，记录旧 attempt 集合、决策 ID 和不可变报告文件引用；当前成功报告移入 `reportArchive`，旧监督 outcomes 原样保留。被撤回的旧报告不再作为有效完成证据继承。受影响且已经执行的后继一并回到待执行；尚未开始的后继继续遵守原依赖。新尝试收到原局部合同和对应返工依据，任务身份、历史绑定和验收条件保持不变。

`blockage-control.json` 与 `blockage/` 保存新的异常阶段、角色 ID、决策、审核和中断报告。原监督状态结构不新增异常阶段。若提交图后进程才中断，恢复通过确切事件识别已提交结果，不重复提交或重跑旧工具。新异常修图轮次固定其提案 ID 分配，以保持暂停前后的审计输入一致；原修图入口仍使用原有默认分配方式。

宿主显式入口是 `runner.handleBlockage({expectedRevision, baseChecksum, sourceAgent, signal, resume})`。`resume:true` 表示宿主已取得显式恢复意图；完整联动模式由状态机维护该条件。手动 host 模式不因 `runNext` 的返回自动新增模型调用。

已进入新返工历史的工作流不可直接由不认识 `REOPENED` 的旧版读取。本地开发没有向旧活动检查点添加宽松恢复白名单，也不以代码等价为由绕过原有恢复校验；当前运行中的安装与会话应保持原样，部署另择已确认的安全边界。
