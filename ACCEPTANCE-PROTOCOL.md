# 验收与交付协议 v1（内部待发布）

新规划在 `planningReport.verification` 声明 `version: 1`。仅支持分层、持久化 direct、原生执行宿主及报告模式监督。旧图不自动迁移，初始记录不能通过改图改变。默认预规划说明与提交校验要求符合这些条件的新图声明该协议；每次新预规划持久化版本标记，旧未标记的待继续规划仍保留原提示词与提交条件。直接宿主 API 仍可明确提交旧协议图。为复现旧协议，宿主可显式设置 preplanningAcceptance=false；这个开关只影响新规划，不改已有图的标记或语义。

```json
{"version":1,"requirements":[{"id":"user_goal","origin":"USER","statement":"用户希望得到的使用结果","source":"用户原文或明确出处","verification":"适合该目标的实际验证方式","required":true}],"deliveryRequired":true}
```

`origin` 也可为 `DESIGN` 或 `ASSUMPTION`。固定用户合同仍是权威；初始索引是模型提炼，审查者必须核对原始目标，不把模型自行设定的数量指标当成体验标准。

## 验收当前状态

验收输入同时包含 `acceptanceContext.startContext` 与 `submissionContext`。前者保留启动时状态，后者展开当前叶绑定的上下文闭包，并提供共享事实的 ID、版本、内容摘要和本次更新记录。无关私有上下文不加入。共享事实依然直接更新，不新增审批。验收回执保留快照身份，正式提交前重新检查成果；变化会触发报告更新或新验收，不能替换旧报告的 SHA。

## 退回与独占锁

新协议 `RETURN.issues[]` 每项增加 `correction`：

- `REPORT`：声明、语法、引用或证据说明有问题。使用完整原上下文和原有草稿局部编辑工具。
- `WORK`：已有证据证明当前叶范围内的实际成果缺陷。新执行段修复成果、执行相关检查并重报。
- `PLAN`：当前叶职责无法解决的蓝图缺口。执行者在固定权限内核实并如实申报处置，再进入既有计划/阻塞/组终审路径。这个反馈本身不解锁、不开改图权限。

模板：

```json
{"verdict":"RETURN","reason":"当前结果不满足本叶标准","issues":[{"path":"/submission/summary","item":"本叶验收项","reason":"具体缺陷","expected":"约定结果","observed":"回执或成果中的具体反例","correction":"WORK"}]}
```

混合问题优先处理实际工作（涉及计划时先澄清处置）。证据不足以证明实际缺陷时要求补证，不臆测返工。所有执行段使用相同叶独占锁，单独的目录、日志、请求显示与统计标识；原执行段通过哈希引用保留。暂停恢复读自己的执行段，已完成工具不重放；未知工具结果仍需原有恢复核对。原生模型窗口、压缩阈值和请求控制不变。

实际返工的固定开头只保留当前职责与证据来源；完整反馈、上次报告、历史上下文和所有执行段回执进入当前段的不可变归档。宿主在此阶段提供 `dynamic_context_source_read`，先完整读取反馈和上次报告，再按索引选择相关回执；超过一页时按 `nextOffset` 继续，索引下一页由 `nextMessageIndex` 指定。读出的内容进入可被原生压缩的普通工具历史。此工具只能读取当前段已登记的归档，不能读取任意文件、跨任务取证或增加业务权限。暂停恢复保留归档身份及已完成读取，不重复执行工作。报告补正的完整装填不受此调整影响。

```json
{"archive_id":"使用 correction 中实际的 sourceRead.archive_id","message_index":1,"offset":0,"length":8000,"field":"content"}
```

## 精确回执选择

报告补正新增 `dynamic_context_select_receipt`，只查询本次叶执行链内的不可变回执。

```json
{"query":"测试关键字","offset":0}
```

返回来源 ID、源摘要、预览、匹配位置与下一页偏移。读取或选择精确片段：

```json
{"id":"receipt_实际ID","sourceSha256":"实际摘要","start":0,"end":20}
```

用原有 `dynamic_context_rewrite_report` 把返回的 `evidence` 设置到 `/executionReport/tests/0/evidence`；删除手抄的 `callId/quote`，宿主会解析准确值。索引范围按 UTF-16、末端不包含；不允许跨代理对拆分。旧手动引用仍有效；同名 callId 在多个执行段中重复时须选定来源，不能猜最近一个。回执来自真实记录并不意味着 PASS 的业务解释必然正确。

## 需求证据和交付清单

`executionReport.verification` 每项：

```json
{"requirementId":"user_goal","status":"VERIFIED","method":"CONSUMER_PATH","target":"交付入口","environment":"实际环境与版本","testIds":["consumer"],"limits":[],"conclusion":"证据支持的范围"}
```

`status` 还可为 `LIMITED/NOT_VERIFIED`，须列出限制；`method` 还可为 `STATIC/SIMULATED/REAL_INTERFACE/ANALYSIS`。VERIFIED 必须引用本报告中有真实回执的 PASS 测试，但独立验收仍判断其是否真的证明该目标。最终交付叶须覆盖所有原始需求，普通叶只覆盖适用项。有效根终审 `goalCoverage` 每项包含 requirementId、conclusion（SUPPORTED/LIMITED/NOT_APPLICABLE）、reason 和原始 evidence；单组包装层也在同一终审中覆盖根目标。

```json
{"items":[{"id":"product","path":"dist/product","kind":"directory","sha256":"宿主目录摘要","entrypoints":["README.md"],"requiredFiles":["bin/start"],"externalRequirements":[],"userSteps":["按 README 启动"],"testIds":["consumer"],"consumerCheck":{"root":"consumer-check","testId":"consumer","isolation":"复制实际交付物后从用户入口运行"}}]}
```

此对象位于 `executionReport.delivery`。交付标记为必需时，最终交付叶不能省略。入口和依赖相对交付根。目录检查沿用宿主完整目录摘要；单文件使用 SHA-256。支持直接检查普通单盘 ZIP32（store/deflate）的真实成员、CRC、成员摘要和缺件。ZIP64、加密、符号链接或不支持的压缩格式明确拒绝，须改为有独立摘要的解包交付目录，不静默假定其正确。

消费者目录必须与开发交付目录分开；所有交付成员字节与消费者输入核对。程序不创建或运行消费者检查，不授予审计者执行权限。执行者完成实际测试，验收者结合终端回执核对是否真的使用交付入口、有无未声明的开发环境依赖。复制字节相同本身不能证明运行成功。非安装型任务可不提供 consumerCheck，但应在报告中说明相应验证范围。

组报告向上传递本层证据概要、限制以及终点提交的交付清单，避免把早期已被修改的产物当作最终版本。最终报告者仍只总结已审结果；主会话同时附上程序核验过的交付路径。
