# dsh-dynamic-context：动态上下文与受控请求通道

本构建版本为 `0.1.1-rc.41`。适用宿主和配套版本见 [兼容清单](DSH-COMPATIBILITY.json)。

分支 `0.2.2-rc.1` 对应 npm 标签 `latest`，适用于 DSH `0.2.2-rc.1`、`0.2.2-alpha.3`，Node.js 要求为 `>=24.9.0`。请在同一 DSH profile 先安装 `dsh-better-task-grapth@0.3.1-rc.41`，再安装 `dsh-dynamic-context@0.1.1-rc.41`。Bundle 初装默认关闭，完成配置并启用后为新对话提供会话模式选择。

前置插件：[dsh-better-task-grapth](https://github.com/oldcitynight/dsh-better-task-grapth)。开源协议为 GPL-3.0-only；复制的 DeepSeek 压缩策略另保留原 MIT 声明。验证范围和独立测试方法见 [VALIDATION.md](VALIDATION.md)。GitHub 源码发布与 npm 包发布是不同步骤，当前候选可从源码构建安装包。

## 从源码构建

```sh
git clone https://github.com/oldcitynight/dsh-dynamic-context.git
cd dsh-dynamic-context
npm ci
mkdir -p .test-tmp
TMPDIR="$PWD/.test-tmp" npm test
npm run pack:bundle
```

源码构建依赖任务图 `0.3.1-rc.41`。该版本发布前，先将同一批次的任务图 tarball 加入 npm 缓存，再执行 npm ci。运行配置见 `examples/`。

候选包的独立支持范围是 direct。`native-guarded` 仅为开发对照，依赖另行安装的 context-guard wire hook；干净 DSH 没有该补丁时，在认领任务和创建执行 Agent 前拒绝运行。发布包不修改 DSH 适配器来启用该对照通道。

本插件按任务图串行装配上下文，显式选择 `native-guarded` 或 `direct` 通道。前者使用独立 DSH 原生会话并校验请求；后者由插件维护独立对话记录，构造 JSON 后直接发送 HTTP/SSE 请求。direct 现可使用真实 DSH 执行身份承接工具和权限服务，模型请求仍由插件管理。包内自动化测试使用随机本地端口的 fake llama 服务，不加载或转发真实模型；工作区另有显式执行、记录费用的 DeepSeek API 验收脚本。

## 已实现的范围

- 通过程序接口 `submit({ taskGraph, contextGraph })` 一次提交任务图、上下文节点和逐任务绑定。复用 `dsh-better-task-grapth` 的公开核心、持久化与 CAS；两张图及报告位于一个原子提交的私有文件中。
- 上下文节点可继承其他上下文节点。程序生成 ID，检查引用、循环和重复绑定；装配时按父节点先行的顺序去重展开，仅包含当前叶任务声明的上下文。
- 每个任务绑定自己的操作说明、上下文集合、前序报告和可见工具。报告继承只允许引用任务依赖中的前序叶任务，并在使用时核对已提交状态及原始执行记录的 SHA256。报告文本由程序原样复制。
- 宿主通过 `systemPrompt` 提供完整固定约束，通过 `allowedTools` 给出权限上限。上下文图不能声明 system/developer 角色，也不能扩大工具权限；模型侧工具可见范围和执行时限制使用同一份任务绑定。
- 每个任务使用独立历史，只继承明确声明的报告。`native-guarded` 将材料作为日志化用户消息交给 DSH；`direct` 使用插件私有的 system/user/assistant/tool 历史，记录实际发送字节的 SHA256。
- 完成的报告、上下文版本、实际请求、会话事件与带 hash 的执行记录持久保存。关闭运行器后可以继续尚未开始的任务。断流、取消、超时、工具错误、输出截断、空报告和请求上限均保留 ACTIVE，阻止自动重放和依赖任务推进。
- direct 可显式启用持久检查点、协作式暂停和安全边界恢复，以及带原文归档的提取式历史压缩。已确认完成的工具不会因恢复而重放；结果未知的 HTTP 或工具调用继续阻塞。

## 请求校验

### 运行中共享上下文

在联合提案的 `contextGraph.nodes` 中为可更新的数据节点添加 `mutable: true`，例如 `{key:"reference_location",content:"docs/index.md",parents:[],mutable:true}`。通过现有上下文绑定将它分配给需要该事实的叶。在 direct 执行的 `state` 模块、宿主 `allowedTools` 和该叶的工具绑定中启用以下能力。

- `dynamic_context_shared_update({id, content, reason?})` 直接应用新内容，返回稳定 ID、递增版本及本次修改的回执。程序记录原值、各次修订和对应的叶与调用。修改即生效，无事实审核或审批步骤。
- `dynamic_context_shared_read({id, revision?})` 读取当前内容或指定历史版本，并返回最新版本号。新叶装入其所绑定节点的当前内容。正在执行的叶从工具回执取得更新，已发送的消息、旧报告及恢复时的初始上下文保留原版本。

共享条目是项目数据。调整任务范围、依赖、验收标准或工具授权由原有图修订渠道处理。旧版本已有的普通节点沿用静态语义，可在结构修订时为后续叶添加可更新的节点。报告修复继续装入完整的本叶执行证据。

### 请求契约

任务开始时固定上下文版本、宿主提示、初始任务消息、完整工具定义、模型路由和输出上限，生成请求契约 hash。原生通道在模型调用入口校验以下内容：

- 系统提示必须与宿主提供的完整策略一致，用户消息只能是本任务的初始材料；额外 user/developer 消息拒绝发送。
- 工具名称、描述和参数 schema 必须匹配任务快照；额外声明提供器或装配回调不能扩大或替换工具定义。
- 历史 assistant 内容必须对应本运行器观察到的模型输出，工具结果必须对应已记录的模型调用与实际工具执行结果，并保持调用配对及顺序。
- 模型、provider、输出上限以及包含系统提示、工具 schema 和历史的输入字符预算均参与检查。
- 在已安装适配器的 `onPayload` 入口再次核对 wire 消息与工具，并拒绝校验之后新增的适配器 hook 作用域。不具备此入口的适配器拒绝运行该原生通道。

原生插件侧的 `suppressAllRuntimeContext` 可以禁止注册运行时上下文补入，`complete` 可以替换最终系统提示；但 DSH 仍会收集工具提供器、求值其他系统段并运行装配监听器，可能因多个 complete 提示或提供器异常而失败。因此这组公共接口不能完全停用默认策略。`native-guarded` 用于兼容性验证，遇到冲突或输入不符合契约时停止，不能通过忽略错误来强行运行。

## 直接发送通道

`direct` 不调用 `systemPrompt.assemble/refreshContext`、`agents.followup`、`agent/pre-step`、`ctx.llm.stream` 或 PiAiAdapter。插件根据已经提交的上下文图构造请求，校验、序列化并记录请求后，通过明确配置的 endpoint 直接 POST。不会根据原生通道是否失败自动切换。只有显式启用下述原生压缩适配时，才允许一次服务端明确返回 `context_length_exceeded` 后的压缩恢复；未知请求、普通 HTTP 错误及工具效果不自动重试。可通过 `direct.generation` 显式固定 temperature、top_p、top_k、min_p、repeat_penalty、repeat_last_n、presence_penalty、frequency_penalty、seed；这些字段进入请求契约，不能覆盖模型、消息、工具或输出上限。

直接通道在每次 HTTP 请求前保存 SENT 记录；支持有大小上限的 SSE、工具参数分片、取消与超时。非正常结束、断流、不完整协议、重定向和错误响应均停止推进。凭据只能从显式配置的引用解析，不写入执行记录；指定引用缺失时拒绝发送。

直接通道通过 DSH 的原生批量执行 API 逐个执行已校验调用，沿用原生审批与 guard。每次发送前按实际模型路由解析工具可用性，由插件保存调用及结果记录。文件观察策略作用于 direct 执行会话。模型批次的工具名称、调用 ID、JSON 形状和参数 schema 在第一个工具产生效果前整体校验，原生运行时随后再次逐调用验证。工具身份、作用域与参数在执行前核对，嵌套或重复派发、工具中绕回原生模型 API、注册表热变更均会停止任务。

未配置 `direct.runtime` 时保留原 agentless 模式：不创建 Agent，只允许另列入 `direct.agentlessTools` 的工具，许可默认为空。此模式不能借用 Agent 专属沙盒和审批；不要把 Shell、PTC 或正式任务图提交工具加入该白名单。工具追加上下文和提前结案均拒绝传递。

agentless 模式的 `sessionId` 只是执行记录关联 ID；配置 `direct.runtime` 时，它对应真实的执行 Session。两种模式都以插件私有历史和实际 wire 字节为请求来源；没有冒充原生 replay token meter，实际 token 计量和性能收益需要另行验证。

## direct 执行服务迁移

文件与搜索工具的路径及符号链接目标必须位于工作区内，需用这些工具回读的临时报告也应保存在工作区。`DIRECT_RUNTIME_PATH_OUTSIDE_WORKSPACE` 是执行前的路径拒绝：rc.23 通过工具反馈返回 `DEFERRED_NOT_EXECUTED`、被拒路径、工作区及准确的 `affectedCallIds`，让模型自行修改请求；不会执行被拒调用、擅自改写路径或重放先前成功操作。同批剩余调用整体延后，并纳入持久化检查点。私有状态访问、宿主权限或指令变更、未知效果等错误仍按原规则停止。

`direct-runtime.mjs` 通过公开 API 创建真实 Agent/Session，但只作为工具执行身份：不挂载整套 Web 预设、不启动原生模型循环；其 followup/inject/steer 被拒绝。工具在单独能力作用域中注册，worker 只继承任务绑定的子集，避免同一层注册的工具绕过限制。请求中的系统提示由宿主约束和显式事实生成，不调用默认提供器。

| 模块 | 已接入的能力 |
| --- | --- |
| `filesystem` | 原生 `read`、`write`、`edit`，保留原生原子写入、观察版本、错误与差异元数据 |
| `search` | 原生 `glob`、`grep`，使用真实 ripgrep 子进程 |
| `shell` | 原生前台 `bash`，保留真实工作目录、审批、取消和文件写沙盒；发送前要求完整沙盒能力，返回显式 exitCode 与沙盒事实 |
| `web` | 原生 `web_search`、`web_fetch`；使用宿主已配置的 Web 服务 |
| `skills` | 只暴露显式 `skills` 名单；`skill` 返回已加载正文及 hash，`requiredSkills` 在首次请求前加载 |
| `state` | `dynamic_task_status` 返回当前叶任务、声明报告引用和关联 Goal 的 ID/revision/phase；`dynamic_context_source_read` 读取当前尝试的压缩归档；不隐式复制完整目标和验收材料，不会完成 Goal |
| `registeredTools` | 显式接入宿主已经注册的工具，例如经过审核的 MCP 或历史读取适配器；定义和 schema 仍会固定和验证，不自动导入服务器提示词 |

每个 worker 设置独立的工作目录、沙盒和审批状态。`runNext({ sourceAgent })` 可以关联真实控制器，沙盒只能收窄，审批 never 不会变为 ask，父级 Plan 的只读含义继续生效。父级权限、Goal 或当前 user/developer/system 输入改变时会取消执行；工具必须完成取消清理后才移除执行身份。额外 Plan 只读分类只接受显式注册的外部工具，不能把已知写入或 Shell 工具重新标成只读。

共同规则包括项目根及适用目录的 `AGENTS.md` / `CLAUDE.md` 和 local 文件、宿主 DSH_HOME / DSH_AGENTS_HOME 的全局指令、时间与时区、任务身份和证据含义。可通过 `instructionHomes` 显式指定指令根；测试使用独立的合成目录。指令正文及来源 hash 固定保存，不插值、不静默截断。首次预检覆盖整个工具批次，后续每次调用前再校验尚未执行的部分。新增适用指令通过工具观察交付，`affectedCallIds` 标明未执行的调用；已完成的前缀有真实效果，不能重放。改变、删除已有指令或在已校验目录中新增指令文件会在下一调用前停止任务。文件工具按目标目录、Shell 按显式 workdir 发现规则，不解析任意 Shell 脚本内部的全部文件访问。

只有经许可的重复工具提醒会转换为带来源的 tool 观察，不追加默认 user 消息；未知附加上下文、提前结案、多媒体结果仍拒绝。外部工具需要自己的参数和权限约束，不能仅凭名字宣称它已受文件沙盒管理。当前原型仍使用文本模型协议；技能理解、真实 MCP/历史后端、真实 Web 服务及实际模型表现须分别验收。

## 工作区与执行记录分离

执行服务模式要求 `directory` 位于整个 `projectRoot` 之外，即使 `runtime.cwd` 只是项目子目录。`storageRoot` 给出已有、规范化的状态根目录，`directory` 必须是它的真实子目录；状态记录、CAS、证据 hash 和报告继承继续使用原有存储校验。未配置 storageRoot 的旧模式仍默认使用 projectRoot。

runtime 的沙盒只接受 read-only 或 workspace-write；即使宿主默认 full access，worker 也按显式选择的较窄模式运行。Shell 不允许后台驻留或参数提权。Linux 下状态目录还不能位于原生执行器可能开放写入的 `/tmp` 中。文件工具访问路径限制在工作区内。

`runtime.protectPrivatePaths` 默认 true，保护 `storageRoot`、执行状态目录及可选的 `privateReadRoots`（最多 16 个已有绝对目录）。状态根包含工作区时，仅重新开放当前工作区，其他私有子目录保持隐藏。原生文件工具拒绝凭据路径、临时文件及符号链接别名；Shell 和搜索使用每次工具调用独立的 Linux 挂载视图，私有目录为空且只读，当前工作区保留原权限。DSH 托管凭据的专用父目录采用只读快照，保留非秘密工具链/配置，排除凭据、锁及原子替换临时文件；宿主刷新凭据不会把新文件暴露给正在运行的命令。宿主模型请求继续在此视图之外读取已登录凭据。

Shell/搜索的这项保护要求 Linux 及可用的 `/usr/bin/bwrap`，不可用时在模型请求前拒绝；仅文件工具不需要进程挂载能力。自定义凭据文件应位于专用目录，不能直接放在项目根或其祖先目录。可信宿主可显式设置 `protectPrivatePaths: false` 保留旧行为，记录会标明关闭。它保护指定私有路径，仍允许普通宿主文件与工具链读取；不提供通用网络隔离、同用户进程隔离或所有秘密自动发现。外部工具/远程 MCP 的内部权限仍由各自宿主管理。包装只在该 direct 工具调用的异步作用域内生效，不更改其他聊天的默认发送、工具与读取策略。

适配器会使用真实审批服务，保留 approval/asked 与 approval/decided 日志；无答复通道时拒绝，不伪造授权。Goal、TODO、正式事务图与动态报告提交仍有不同含义；叶任务没有因此获得控制器的状态写权限。

## 控制器入口

默认 `interaction.mode: interactive`。全局只提供选择指引、`dynamic_context_select_mode` 和 `dynamic_context_graph_status`；任务专属合同与运行工具在用户选择完整功能后只装入该会话。模型判断项目级、多步依赖或用户明确指定使用图时调用选择入口，提供“不启用任务图”“启用任务图但不启用动态上下文”“启用完整任务图功能（推荐）”。没有答复不选择推荐项；可核验的直接用户指令可免重复询问。

完整模式按原始会话标识、创建时间与项目目录分配独立双图。`dynamic_context_submit`、`dynamic_context_status`、`dynamic_context_run_next` 使用最新 revision 和真实控制器；worker 及同项目其他会话不能调用。关闭完整模式只允许在无活动叶、无待办监督且图状态完整的边界。默认 `exposeControlTools: true`；该开关用于 host 模式是否暴露控制工具，interactive 模式始终按用户选择动态注册。

受信宿主或 CLI 使用 `interaction.mode: host`，自行负责控制器选择和调度；CLI 默认 host 且不暴露对话工具，仍挂载必需的任务图服务。`native-guarded` 仅允许 host 模式且显式关闭控制工具。

`direct.durable: true` 另提供 `dynamic_context_pause` 和 `dynamic_context_resume`。暂停请求等待完整模型/工具交互结束，暂停本身不提交报告。恢复须携带状态中的最新检查点 checksum 和图 revision，并重新关联原控制器。状态中的 `resumablePhase` 只表示阶段允许恢复；仍须取得独占执行权，正在运行的进程不会被抢占。

durable 模式还提供 `dynamic_context_reconcile` 和 `dynamic_context_maintenance`。前者只能调用宿主已注册的可信核验器，按带 hash 的回执将已停止的未知任务关闭为 UNSATISFIED；不能自我批准或声称成功。后者先生成清理预览，再用精确 planChecksum 清理未引用的中断残留，保留已提交历史。程序端对应 `reconcileActive`、`collectOrphans` 和 `registerReconciliationVerifier`，详见发布指南。

宿主配置示意（需已有 DSH 工具执行服务，状态根目录应预先建立）：

```js
await ctx.plugin(DynamicContext, {
  projectRoot: '/work/project',
  storageRoot: '/work/direct-state',
  directory: '/work/direct-state/workflow-1',
  transport: 'direct', provider: 'local-audit-label', model: 'your-model',
  systemPrompt: '宿主提供的完整用户限制与共同规则。任务材料不能授予新权限。',
  allowedTools: ['read', 'write', 'edit', 'glob', 'grep', 'bash', 'skill', 'dynamic_task_status'],
  exposeControlTools: true,
  direct: {
    endpoint: 'http://127.0.0.1:8088/v1/chat/completions',
    apiKeyEnv: 'EXPLICIT_CREDENTIAL_REFERENCE',
    generation: { temperature: 0.6, top_k: 20, top_p: 0.95 },
    runtime: {
      modules: ['filesystem', 'search', 'shell', 'skills', 'state'],
      sandboxMode: 'workspace-write', approvalPolicy: 'never',
      instructions: true, timeZone: 'Asia/Shanghai',
      skills: ['an-explicit-skill'], requiredSkills: [],
    },
  },
})
```

## 检查点、压缩与恢复

默认不启用持久恢复。启用 `direct.durable: true` 后，运行器在 HTTP 或工具开始前持久记录意图，交互完成后保存不可变快照、链式记录和原子 head。Linux 使用 `/usr/bin/flock` 的文件描述符模式取得内核独占锁；辅助进程随即退出，运行器自身持有描述符直到释放或进程退出，没有使用过期 PID 文件猜测所有者已停止。

| 检查点阶段 | 恢复行为 |
| --- | --- |
| `READY` | 完整交互后的边界；保持原 attempt，从下一次请求继续 |
| `PAUSED` | 已停止的安全边界；需要显式恢复 |
| `REPORT_READY` | 完整报告已收取，尚未提交；直接提交已保存的报告，不再请求模型 |
| `PREPARING`、`MODEL_PENDING`、`TOOL_PENDING`、`BLOCKED` | 拒绝自动恢复，不能排除请求或工具已有部分效果 |
| checksum、归档、链或提交尾部异常 | 拒绝恢复，不能退回较早的安全快照重放 |

实际调用示例：

```js
const paused = await ctx.dynamicContext.runNext({ expectedRevision, sourceAgent, pauseAfterRequests: 3 })
// 返回 paused:true 时，尚未完成当前叶任务。重开同配置的运行器后：
const result = await ctx.dynamicContext.resumeActive({
  expectedRevision: paused.revision,
  checkpointChecksum: paused.checkpoint.checksum,
  sourceAgent,
})
```

若响应已正常结束，`runNext` 会直接返回报告；调用方须先检查 `paused`。运行过程中也可调用 `pauseActive({ expectedRevision })` 请求在下一安全边界暂停。普通 `runNext` 不接管已有 ACTIVE，恢复必须走显式接口。请求次数、已使用调用 ID 和压缩次数按整个任务累计；`timeoutMs` 按每次执行/恢复计时。

恢复时重新核对上下文、配置、插件和复用的本地策略源文件、工具定义、当前控制器权限/输入/Goal、目录指令与技能。新建真实原生 Session，以公开 fork/seed 接口继承旧事件并记录来源，保留同一逻辑 attempt；当前时间与物理 Session ID 重新采样。**原生文件观察 gate 是内存状态，不随 Session 事件恢复**：编辑或覆盖既有文件前必须重新 `read`；归档中的读写结果不算新的文件观察。更换原生运行时安装或外部工具的隐含配置须重新验收，函数/声明指纹不证明闭包和外部服务完全相同。

原有提取式压缩需另外配置下列字段，并在宿主 `allowedTools` 和每个叶任务绑定中都显式加入 `dynamic_context_source_read`，同时启用 `state` 模块：

```js
direct: {
  // endpoint、runtime 等仍需按上例声明
  durable: true,
  compaction: {
    triggerCharacters: 14000,
    retainRecentExchanges: 0,
    maxCompactions: 4,
    maxCheckpointCharacters: 10000,
  },
}
```

触发条件是可变历史超过阈值，或整个请求将超出输入字符预算。只在完整工具交互边界压缩，保留最初 system 和任务绑定；旧 assistant/tool 原文写入当前 attempt 专属归档。生成的提取式检查点保留调用配对、参数和结果 hash、局部预览、来源角色、观察到的验收词与历史证据含义；后续发现的目录指令和已加载技能正文完整保留。无法容纳这些约束或无法缩短输入时停止，不截断约束。连续压缩保留此前归档引用，恢复后仍可回读第一次归档。

`dynamic_context_source_read({ archive_id, message_index, offset, length, field })` 按 UTF-16 字符位置读取 `content` 或 `tool_calls`，单次最多 8000 字符。归档 ID 是完整文件的 SHA256，仅当前任务尝试已登记的 ID 可读取；后继任务即使知道 ID，也不能借此取得前序原始工具历史。任务间仍只继承声明的报告。检查点明确标为程序生成的历史资料，不能成为新的用户授权或当前 PASS 结论。

提取式策略将 `context-memory` 的纯证据标签/角色规则随包分发，不调用辅助模型。输入预算与测量均针对同一份 direct 消息和工具定义，但字符数不是模型 token 数。批量快照/归档受 `direct.maxJournalBytes` 约束，默认 128 MiB，预留小型意图/对账记录空间；`collectOrphans` 仅回收无引用残留，完整已提交历史不自动删除。

## 原生压缩适配（工作区未发布）

可选择 `direct.compaction: { strategy: 'dsh-native', contextWindow: 1048576 }` 并开启 `direct.durable`。以官方 DSH DeepSeek 默认通道为对照时，还应显式使用 `maxOutputTokens: 256000`、`direct.thinking: { type: 'enabled' }` 和 `direct.reasoningEffort: 'high'`，并为百万窗口配置足够的字符、HTTP 和持久化容量。窗口必须来自实际模型目录，不应把 DSH 的回退容量或模型输出能力误当作当前路由的请求默认值。

DSH rc.5 的触发线为 `floor(min(0.8W, W - O - 65536))`，尾部保留量为 `floor((W - O) * 0.16)`。`W=1048576, O=256000` 时分别为 **727040** 和 **126812**。direct 每次都显式发送输出上限，因此输出预留直接取 `maxOutputTokens`，不允许另填矛盾的预留值。

策略先调用同版本 DSH 的公开文本 token 估算器判断压力，再按原生规则裁剪超过 8192 个 Unicode 码点的工具结果（保留头 4096、尾 1024）；仍有压力时保留完整的近期工具交互，并调用模型摘要。摘要指令和检查点开场白逐字复制 pristine rc.5，附 MIT 许可；辅助请求保留原 system、任务前缀和工具定义，输出上限为原生 65536。所有辅助调用进入费用观察器和持久记录，摘要中的工具调用不执行。

适配差异：初始任务绑定在 B 组继续保持固定；检查点增加宿主来源信息和完整驻留规则；尾部重复当前任务绑定（不重复大块上下文和历史报告），防止旧工具调用形式主导续作；压缩失败停止而不静默带病继续。文本压力估算使用匹配的已知 usage 和 DSH 启发式，消息变动会使旧 usage 锚失效；这不是原生 Session replay 投影的完全复刻。图片、原生手动压缩入口及原生会话投影互操作不在此适配范围内。没有默认加入归档读取工具；需要回读时仍须显式授权 `dynamic_context_source_read`。

宿主可通过 `registerInputMeter({ version, measure, observe })` 实现统一费用保护。5 元烟测先按完整输入窗口及原生输出上限预留费用，再按最终 usage 结算；流式字节数不是 token 数，不再用于提前截断输出或思考。可选同步 `observe` 回调用于在费率变化时重算总额度占用，不另设单次或阶段额度。辅助请求和普通请求共享连续 `ordinal`；普通工具循环另记 `taskOrdinal`。出现未知回执时不应释放费用占用或自动重放。

2026-11-10 追加到累计 5 元后，三轮官方默认参数的真实压缩与续作均达到严格 **24/24**，覆盖两种条款分布和完整原始日志；原始日志轮摘要请求实际输入 712,597 tokens。复用同一摘要与尾部、仅移除任务提醒的负对照再次请求历史工具，未交付答案，事实保持程度无法评分。保留尾部任务提醒；这只是当前合成重放场景的结果，不能证明长任务注意力或普遍收益。详细证据见工作区 `docs/audits/dynamic-context-native-compaction-20261110-cny5/REPORT.md`。

前轮 23/24 及缺最终 usage 的请求继续封存，旧未知费用占用未释放。本轮通过的是“原生窗口、压缩策略与语义续作”烟测；连续压缩、真实工具续作及完整公开运行入口仍须分别验证，预算仅按总金额控制的正式 A/B 运行器也尚未完成。当前适配仍为工作区未发布内容，原 rc.4 封包不变。

## 任务图联动与 DeepSeek 协议

`interop.enabled` 只能为 true。任务图服务为必需依赖，未就绪时插件等待，服务丢失或替换后阻止后续执行。插件按契约 `dsh-taskgraph-workflow-v1` 注册一个工作流；`interop.workflowId` 可显式指定，否则按状态目录生成。服务加载先后顺序均可，重复工作流标识拒绝覆盖。`ctx.transactionGraph.dispatchWorkflow(controllerAgent, reference, operation, request, signal)` 使用同一个联合账本执行操作；原来的正式事务账本和 Web 面板不被镜像或改写。公共调用示例见配套任务图包 README。

`direct.api: deepseek` 显式启用 DeepSeek Chat Completions 协议。可用 `thinking: {type:'enabled'|'disabled'}` 和 `reasoningEffort: 'low'|'high'|'max'`；省略 thinking 时显式发送 enabled。各轮 assistant 的 `reasoning_content` 原样回传，归档保留原始推理字段并可按范围读取。工具调用缺少所需推理收据时停止。Llama 专用采样参数和 thinking 模式下被服务端忽略的 temperature/频率惩罚会在本地配置验证时拒绝，避免配置看似生效。协议依据见 [DeepSeek 官方文档](https://api-docs.deepseek.com/guides/thinking_mode/)。

`responseModelAliases` 可显式允许服务端返回的模型别名，默认只接受配置模型；不自动扩展。记录服务端 request ID、response ID 和 usage，凭据不进入记录。显式输出上限支持到 393216；官方 DSH DeepSeek 提供器默认值是 256000（不是模型能力上限），单次执行超时可配置到 30 分钟；任务总请求数默认 4，可显式配置到 256。可选 `direct.reserveFinalReport` 使最后一次请求只允许报告，任何意外工具调用在产生效果前拒绝。

关闭压缩的大任务示例为 `examples/deepseek-no-compaction.patch.yml`：128 次调用、32K 输出、8,388,608 UTF-16 字符和 4 GiB 持久记录预算。输入字符、8 MiB 请求字节、实际模型 token 窗口及货币额度分别管理，不把字符数称为 token 数。完整请求在持久检查点中按 hash 引用独立文件，恢复时校验原始发送体；这是无损存储去重，不是上下文压缩。

宿主可注册 `registerInputMeter({version, measure})`，回调收到冻结的实际 payload 和取消信号，返回 `{tokens, method:'exact'|'estimate'}`。返回值连同计量器版本进入记录，版本/实现指纹参与恢复配置校验。只有 exact 才能满足可选 `maxInputTokens` 的硬预算；没有计量器或只给估计时拒绝使用该预算。服务端 usage 与发送前测量分开记录。

## 运行

在项目目录运行：

```bash
npm run dynamic-context:test
npm run dynamic-context:runtime-demo
npm run dynamic-context:continuation-demo
npm run dynamic-context:demo
npm run dynamic-context:audit
```

`runtime-demo` 演示真实文件读写编辑、搜索、沙盒命令、技能、目录指令延后和任务状态，包含 A → B → C 三个独立任务与 9 次 fake 请求，保存实际产物、wire、Session 事件与验证文件。旧 `demo` 保留 agentless 合成工具及原生通道对照，默认 direct，共 5 次请求。可指定新的输出目录：

`continuation-demo` 演示连续两次压缩、已加载技能保留、真实写入后暂停、重建运行器恢复、第一次归档源文回读、重新观察后编辑和下一任务的报告隔离，共 2 项任务、9 次 fake 请求。进程 SIGKILL、未知效果阻塞和并发持锁拒绝另由 `continuation.test.mjs` 验证。

```bash
npm run dynamic-context:demo -- --transport native-guarded
npm run dynamic-context:demo -- --transport direct --output .tmp/my-new-direct-demo
npm run dynamic-context:runtime-demo -- --output .tmp/my-new-runtime-demo
npm run dynamic-context:continuation-demo -- --output .tmp/my-new-continuation-demo
npm run dynamic-context:audit -- --output .tmp/my-new-transport-audit
```

输出目录必须是项目内尚不存在的目录。默认在 `.tmp/` 下创建独立目录。现有 Web 配置、会话数据库、已安装任务图和 llama 服务不会被修改。

独立安装包的 `npm test` 运行自包含的 direct 与图/权限测试；`npm run test:comparison` 单独运行依赖外部 wire hook 的原生对照。未安装 hook 时可用 `npm run audit:direct` 核验 direct 的六种注入条件；工作区根目录的完整测试仍包含原生对照。

包内另提供 `createDirectHost` 和 `dsh-dynamic-context` 命令用于独立 API 验收，不启动 Web、不加载原生模型适配器，也不内置 fake 凭据。CLI 使用配置的环境变量凭据；Web 宿主继续可使用其原有 credentials 服务。`check --config FILE` 只验证配置和凭据是否存在，不请求模型。`run` 必须另给 `--proposal FILE --output NEW_DIRECTORY --execute`；`resume` 另需精确暂停票据文件。执行记录标为未做语义验收，不能从收到回答直接推导 PASS。

## 程序接口

`index.mjs` 导出 Cordis 插件与 `DynamicContextPrototype`。配置需要显式提供 `transport`、真实项目根、独立状态目录、模型标签、完整宿主提示及工具权限上限。`direct` 另需完整的 `direct.endpoint`，可配置凭据引用、generation、runtime 或旧 agentlessTools，以及请求与响应字节上限；不会自动读取 provider 的 endpoint。`provider` 在直接通道仅作审计标签，实际目标由 endpoint 决定。

启用后，宿主通过 `ctx.dynamicContext.submit(proposal)` 提交双图，通过 `ctx.dynamicContext.status()` 读取状态，通过 `ctx.dynamicContext.runNext({ expectedRevision, choice, signal, sourceAgent })` 执行一项就绪任务。sourceAgent 的输入只用于变化校验，不把其完整历史复制给 worker；宿主仍需在系统规则和双图中声明当前授权范围。`runtime-demo.mjs` 是实际工具接入示例，`testing/scenario.mjs` 与 `testing/harness.mjs` 保留最小合成配置。

当前仅接受一个根容器及其直接叶任务，叶任务之间使用 prerequisite 边。上下文图版本在首次提交后固定。任务进入 ACTIVE 先于模型请求；全部结果及执行记录保存之后才提交报告。模型报告始终标为 `UNVERIFIED_MODEL_REPORT`；任务图 COMPLETE 仅表示本次正常响应及报告提交完成，不能表示目标验收通过。

## 原型边界

这是独立、可安装的候选发布包，已提供联合建图、真实工具执行与任务图联动接口。现有生产事务图账本不参与动态执行；模型报告不因此取得正式事务证据或 Goal 验收资格。Web 界面仍由宿主原有入口提供。

direct 私有历史已验证连续压缩、有限安全边界恢复、可信宿主对账和任务切换。原生同一会话投影与原生压缩器互操作、任意 ACTIVE 自动判定成功、条件分支、实时上下文修改和真实模型质量仍未验收。原生 wire 校验暂限定文本及原生工具调用，未验收推理历史和多媒体的 provider 投影；直接通道也不等于完整 DSH Agent 功能。

fake llama 的回答、usage 数字均为合成数据，只验证上下文传递、请求与状态转换；不能据此判断模型理解能力、准确率、注意力改善或真实 token 成本收益。本原型不自动安装到现有 Web profile。

恢复验收针对本机 Linux 的单个进程 SIGKILL 和同一可信运行时安装；未做系统断电、文件系统损坏、跨机器迁移或真实模型服务器回执对账。结果未知的执行需要人工/宿主核对实际回执，不提供“强制成功恢复”开关。

## 总额度实验配置（未发布的工作区版本）

显式 `null` 可关闭 `maxRequestsPerTask`、整任务 `timeoutMs`、`maxContextCharacters`、`maxStateBytes`、`maxReportCharacters`、`direct.maxRequestBytes`、`direct.maxResponseBytes`、`direct.maxJournalBytes` 与 `direct.runtime.maxToolOutputCharacters` 的附加上限；省略配置仍使用原默认值。无界调用不能与 `direct.reserveFinalReport` 同用。`direct.runtime.nativeRequestControls: true` 使用原生 Shell 的 60 秒默认值、600 秒允许最大值及工具自身超时；`direct.streamIdleTimeoutMs` 可单独保留原生式流空闲控制，不充当整任务截止时间。

`direct.tracePayloads: references` 需要 durable 模式：每个实际请求完整保存在原文文件，trace/checkpoint 引用其路径和 SHA-256，内存只保留最新请求载荷。恢复仍逐一校验原文；未知请求/工具效果、图校验、路径权限和原子提交不因取消数量/体积上限而放宽。磁盘、内存及原生工具本身的能力边界仍存在。

正式实验准备使用独立、固定版本的原生 DSH A 入口，以及任务图联动 B 入口；配置、费用规则、评分和隔离边界见仓库 `experiments/dynamic-context-ab-v1/README.md`。该实验在共同外层文件系统隔离中运行；因本机内核拒绝嵌套用户命名空间，B 的实验配置显式关闭重复的 `protectPrivatePaths`。这只保护未挂载的宿主/对方/评分材料，不隐藏该臂自身的 `/state`，任务禁止读写该目录。插件默认私有路径保护仍启用；该实验不验证其对恶意 Shell 的防护。现有 rc.4 交付包未替换。

## 叶处置监督（0.1.0-rc.6）

自 0.1.0-rc.6 起，可在新建 durable direct 工作流中配置 `supervision: true`。每叶声明 `completion`，执行者提交 COMPLETE、BLOCKED 或 FAILED 的结构化请求。先受理本叶结果，再在持久化的调度门槛内倒查整图。只有版本绑定的复核信号会启动更新和独立审计。控制器通过 `continueSupervision`、`dynamic_context_continue_supervision` 或 workflow `continue_supervision` 恢复精确检查点。详见仓库 `docs/WORKFLOW_SUPERVISION_20261111.md`。

## 双角色联合修订（0.1.0-rc.5）

配置 `revision: {policy: {objective, requirements:[{id,text}]}}` 后，程序接口 `runner.revise({expectedRevision,reason,evidence,sourceAgent,signal})`、控制器工具 `dynamic_context_revise` 与 workflow v1 的 `revise` 操作接入同一流程。policy 由宿主从当前授权任务初始化，不能由上下文改写或沿用到无关任务。evidence 为项目内的 `{kind:'artifact',ref,sha256}` 列表；私有账本、凭据、符号链接和硬链接不能作为向模型发送的证据。

updater 与 reviewer 使用各自新请求和独立运行标识，严格串行。后者不接收前者的对话/思考历史，只读取固定合同、原图、证据、完整提案及程序校验结果。拒绝理由可由控制器作为下一轮待审反馈，仍须重新审批。上下文不会授予工具权限，审批也不会完成 Goal。

修改只能在没有活动任务的安全边界提交。程序保留已执行节点和使用过的上下文闭包；修正未来任务时使用新节点。两张图、审批收据、旧上下文版本和失效报告状态在同一 CAS 中提交；批准 hash 绑定实际完整候选内容。审批期间证据、授权或 revision 变化都会拒绝提交。

报告仍绑定实际执行时的 contextVersion。`invalidateReports` 会传递到依赖这些报告的已提交报告，未来绑定不得继承失效报告。历史记录保留，不将原失败/未验收结果改写为成功。未修改上下文可按 `{key,retain:true,sha256}` 引用，由程序核验并复制原文。每个角色请求及结果在私有 `revisions/` 目录中持久记录，未知模型结果阻止再次请求。

`status()` 和 workflow 读取结果公开上下文版本与报告的 INVALIDATED / UNVERIFIED 状态。SHA 只证明证据文件身份和完整性，不能代替语义验证。未知角色请求由 `revisionRecovery()` 提供元数据，仅受信宿主可通过 `abandonRevisionRole()` 及专用对账证明将其封存为 ABANDONED_UNVERIFIED；原记录按字节归档，图不改变，费用预占不由插件释放。模型没有这个恢复入口。

配置后，控制器得到修订触发说明与当前合同；worker 得到提交证据及阻塞报告的说明，不取得控制器工具。完整设计见仓库 `docs/GRAPH_REVISION_WORKFLOW_20261111.md`。真实模型质量和边界仍以专项报告为准。

## 缺图与恢复

| 可验证状态 | 处理 |
| --- | --- |
| 从未提交双图，只有任务图提案 | 切换为独立任务图，返回原有 create/read 工具及参数；由真实原生工具边界提交，不虚构上下文 |
| 从未提交双图，只有上下文图 | 报错，询问是否回退原生；无答复不回退 |
| 既有独立任务图，没有上下文图 | 继续原有任务图；明确提示尚未进入双图模式，不替换进度 |
| 双图曾提交，任务图、上下文图或文件后来缺失/损坏 | 阻止推进、重建和自动降级，展示恢复状态 |
| 存在已核验提交快照 | 用户确认后原样恢复双图、报告、版本和活动尝试；保留损坏文件，不自动继续执行 |
| 提交见证缺失、冲突、首次提交中断，或无可靠恢复副本 | 保留现场，等待核对；不能推断为从未创建 |

每次联合状态修改保存 PREPARED/COMMITTED 见证及完整已提交快照，见证位于 storageRoot 下 `.dsh/workflow-witnesses-v1/`，与图文件分离。交互提交另向原生会话保存工作流提交收据。`dynamic_context_recover_graphs` 只在用户确认和排他锁成立时恢复精确快照；活动或未知尝试不解锁、不重放。单张图的后续缺失提案不能抹掉历史图，必须走修订流程。

旧 rc.23 文件没有新见证，读取时返回需要核对的状态，不自动导入、重建或跨版本恢复活动请求。旧版本实验保留在原环境。若图、见证及会话收据全部被删除，系统无法凭空证明曾有历史；应从外部备份核查。见证和副本是完整性与恢复依据，不是对同用户恶意篡改的签名证明。
