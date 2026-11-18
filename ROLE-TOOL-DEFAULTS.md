# 默认角色工具规则

在代表宿主 DSH 0.2.1-alpha.1 上清点到 46 个原生工具、35 个动态上下文工具和 5 个任务图工具。下表覆盖所有内建角色。动态 MCP 名称、别名和第三方工具可通过公开接口注册。

默认名单是准入规则，不是工具挂载器。最终可用集合 = 已挂载且获宿主/任务授权的能力 ∩ 角色范围 ∩ 插件白名单 − 插件黑名单；运行时还受状态机、任务作用域、路径和模型能力约束。执行/预规划采用黑名单，审查/报告/路由采用白名单。禁止改图的角色不能通过工具名字或 Skill 文本获得改图权限。

所有角色默认允许 read_image。主会话和预规划走原生通道；Direct 执行者及其余角色接入原生附件服务，发送图像实体。模型路由未声明图像能力、附件服务缺失或图片损坏会返回明确错误。普通 workspace_read 对二进制只给身份属于其文本接口行为，视觉检查必须用 read_image。新请求接入新工具；已冻结的旧请求保留旧工具快照。

Direct 内建原生模块覆盖 read/read_image/write/edit、glob/grep、bash、web_search/web_fetch、skill。pwsh、str_replace_editor、load_workspace_dependencies、present、ask_user_question 以及 MCP 资源入口的默认许可不代表 Direct 已有适配；需宿主显式提供并绑定。终审的专用 ZIP 读取支持流式读取大 ZIP，不解压、不执行成员；其他归档格式不是已实现能力。

控制器还受当前模式裁剪：full 模式由程序规划和调度，不能因本表允许控制工具就绕开 dynamic_context_workflow。独立任务图和原生模式不套用后台角色的工作限制。只读角色的报告工具只写自己的申报草稿；图更新最终提交、验收、解除串行锁均由程序接口实施。

模式启用仅接受真实用户 `/task-graph` 指令。`dynamic_context_route_task` 和 `dynamic_context_select_mode` 保留为历史/宿主兼容入口，但不向模型展示，模型调用也会被拒绝。普通讨论和原生 Plan 无需登记路线或选择插件模式。

公开扩展：dynamicContextRolePrompts.register 支持追加/覆盖角色指引；dynamicContextRoleTools.register 只收窄名单，registerTool 须提供角色、作用域、effect、schema、authorize 和 execute。历史压缩只接内建 read_image 与名单收窄，不接受其他执行回调。错误阻塞规则由 dynamicContextToolErrors.register 按工具内部 ID 和具体错误条件登记，不以未知工具错误自动阻塞整个任务。

## 各角色默认许可

### 交互控制器（controller）

策略：白名单。默认允许已分类工具：

`read_image`、`ask_user_question`、`get_goal`、`exit_plan_mode`、`transaction_graph_read`、`transaction_graph_create`、`transaction_graph_begin`、`transaction_graph_finish`、`transaction_graph_skip`、`dynamic_context_route_task`、`dynamic_context_select_mode`、`dynamic_context_graph_status`、`dynamic_context_status`、`dynamic_context_recover_graphs`、`dynamic_context_revise`、`dynamic_context_continue_supervision`、`dynamic_context_run_next`、`dynamic_context_pause`、`dynamic_context_resume`、`dynamic_context_reconcile`、`dynamic_context_maintenance`、`dynamic_context_workflow`、`dynamic_context_submit`

### 首次规划（preplanning）

策略：黑名单。默认允许已分类工具：

`read`、`glob`、`grep`、`read_image`、`web_search`、`web_fetch`、`bash`、`ask_user_question`、`list_mcp_resources`、`list_mcp_resource_templates`、`read_mcp_resource`、`dynamic_context_submit`、`dynamic_context_planning_history`

其余已分类工具默认禁止；未知工具仍需宿主授权与任务绑定，名单不自动创建适配器。

### 叶执行者（executor）

策略：黑名单。默认允许已分类工具：

`read`、`glob`、`grep`、`read_image`、`web_search`、`web_fetch`、`bash`、`write`、`edit`、`pwsh`、`str_replace_editor`、`load_workspace_dependencies`、`skill`、`present`、`ask_user_question`、`list_mcp_resources`、`list_mcp_resource_templates`、`read_mcp_resource`、`dynamic_task_status`、`dynamic_context_source_read`、`dynamic_context_source_search`、`dynamic_context_shared_read`、`dynamic_context_shared_update`、`dynamic_context_directory_snapshot`、`dynamic_context_generate_report`、`dynamic_context_read_report`、`dynamic_context_rewrite_report`、`dynamic_context_submit_report`

其余已分类工具默认禁止；未知工具仍需宿主授权与任务绑定，名单不自动创建适配器。

### 叶成果返工（result_work）

策略：黑名单。默认允许已分类工具：

`read`、`glob`、`grep`、`read_image`、`web_search`、`web_fetch`、`bash`、`write`、`edit`、`pwsh`、`str_replace_editor`、`load_workspace_dependencies`、`skill`、`present`、`ask_user_question`、`list_mcp_resources`、`list_mcp_resource_templates`、`read_mcp_resource`、`dynamic_task_status`、`dynamic_context_source_read`、`dynamic_context_source_search`、`dynamic_context_shared_read`、`dynamic_context_shared_update`、`dynamic_context_directory_snapshot`、`dynamic_context_generate_report`、`dynamic_context_read_report`、`dynamic_context_rewrite_report`、`dynamic_context_submit_report`

其余已分类工具默认禁止；未知工具仍需宿主授权与任务绑定，名单不自动创建适配器。

### 叶结果验收（result_check）

策略：白名单。默认允许已分类工具：

`read_image`、`dynamic_context_generate_report`、`dynamic_context_read_report`、`dynamic_context_rewrite_report`、`dynamic_context_submit_report`、`dynamic_context_read_evidence`、`dynamic_context_search_evidence`

### 执行报告修订（result_repair）

策略：白名单。默认允许已分类工具：

`read_image`、`dynamic_context_directory_snapshot`、`dynamic_context_generate_report`、`dynamic_context_read_report`、`dynamic_context_rewrite_report`、`dynamic_context_submit_report`、`dynamic_context_read_evidence`、`dynamic_context_search_evidence`、`dynamic_context_select_receipt`

### 叶间计划复查（plan_check）

策略：白名单。默认允许已分类工具：

`read_image`、`dynamic_context_generate_report`、`dynamic_context_read_report`、`dynamic_context_rewrite_report`、`dynamic_context_submit_report`、`dynamic_context_read_evidence`、`dynamic_context_search_evidence`

### 双图更新（updater）

策略：白名单。默认允许已分类工具：

`read_image`、`dynamic_context_generate_report`、`dynamic_context_read_report`、`dynamic_context_rewrite_report`、`dynamic_context_submit_report`、`dynamic_context_read_evidence`、`dynamic_context_search_evidence`

### 双图修改审计（reviewer）

策略：白名单。默认允许已分类工具：

`read_image`、`dynamic_context_generate_report`、`dynamic_context_read_report`、`dynamic_context_rewrite_report`、`dynamic_context_submit_report`、`dynamic_context_read_evidence`、`dynamic_context_search_evidence`

### 阻塞处理（blockage）

策略：白名单。默认允许已分类工具：

`read_image`、`dynamic_context_generate_report`、`dynamic_context_read_report`、`dynamic_context_rewrite_report`、`dynamic_context_submit_report`、`dynamic_context_read_evidence`、`dynamic_context_search_evidence`、`dynamic_context_blockage_reports`、`dynamic_context_blockage_report`、`dynamic_context_blockage_shared`、`dynamic_context_blockage_trace`

### 中断审核（blockage_audit）

策略：白名单。默认允许已分类工具：

`read_image`、`dynamic_context_generate_report`、`dynamic_context_read_report`、`dynamic_context_rewrite_report`、`dynamic_context_submit_report`、`dynamic_context_read_evidence`、`dynamic_context_search_evidence`

### 组级或根级终审（group_audit）

策略：白名单。默认允许已分类工具：

`read_image`、`dynamic_context_generate_report`、`dynamic_context_read_report`、`dynamic_context_rewrite_report`、`dynamic_context_submit_report`、`dynamic_context_read_evidence`、`dynamic_context_search_evidence`、`dynamic_context_blockage_reports`、`dynamic_context_blockage_report`、`dynamic_context_blockage_shared`、`dynamic_context_blockage_trace`、`dynamic_context_workspace_list`、`dynamic_context_workspace_read`、`dynamic_context_workspace_zip`

### 本层计划复查（scope_plan）

策略：白名单。默认允许已分类工具：

`read_image`、`dynamic_context_generate_report`、`dynamic_context_read_report`、`dynamic_context_rewrite_report`、`dynamic_context_submit_report`、`dynamic_context_read_evidence`、`dynamic_context_search_evidence`、`dynamic_context_blockage_reports`、`dynamic_context_blockage_report`、`dynamic_context_blockage_shared`

### 本层蓝图更新（scope_update）

策略：白名单。默认允许已分类工具：

`read_image`、`dynamic_context_generate_report`、`dynamic_context_read_report`、`dynamic_context_rewrite_report`、`dynamic_context_submit_report`、`dynamic_context_read_evidence`、`dynamic_context_search_evidence`、`dynamic_context_blockage_reports`、`dynamic_context_blockage_report`、`dynamic_context_blockage_shared`、`dynamic_context_blockage_trace`

### 本层修改审计（scope_audit）

策略：白名单。默认允许已分类工具：

`read_image`、`dynamic_context_generate_report`、`dynamic_context_read_report`、`dynamic_context_rewrite_report`、`dynamic_context_submit_report`、`dynamic_context_read_evidence`、`dynamic_context_search_evidence`

### 本层阻塞处理（scope_blockage）

策略：白名单。默认允许已分类工具：

`read_image`、`dynamic_context_generate_report`、`dynamic_context_read_report`、`dynamic_context_rewrite_report`、`dynamic_context_submit_report`、`dynamic_context_read_evidence`、`dynamic_context_search_evidence`、`dynamic_context_blockage_reports`、`dynamic_context_blockage_report`、`dynamic_context_blockage_shared`、`dynamic_context_blockage_trace`

### 本层中断审核（scope_pause）

策略：白名单。默认允许已分类工具：

`read_image`、`dynamic_context_generate_report`、`dynamic_context_read_report`、`dynamic_context_rewrite_report`、`dynamic_context_submit_report`、`dynamic_context_read_evidence`、`dynamic_context_search_evidence`

### 任务报告者（task_reporter）

策略：白名单。默认允许已分类工具：

`read_image`、`dynamic_context_generate_report`、`dynamic_context_read_report`、`dynamic_context_rewrite_report`、`dynamic_context_submit_report`、`dynamic_context_read_evidence`、`dynamic_context_search_evidence`、`dynamic_context_blockage_reports`、`dynamic_context_blockage_report`、`dynamic_context_blockage_shared`、`dynamic_context_blockage_trace`

### 途中总体执行报告（progress_reporter）

策略：白名单。默认允许已分类工具：

`read_image`、`dynamic_context_generate_report`、`dynamic_context_read_report`、`dynamic_context_rewrite_report`、`dynamic_context_submit_report`、`dynamic_context_read_evidence`、`dynamic_context_search_evidence`、`dynamic_context_blockage_reports`、`dynamic_context_blockage_report`、`dynamic_context_blockage_shared`、`dynamic_context_blockage_trace`

### 用户引导识别（guidance_intake）

策略：白名单。默认允许已分类工具：

`read_image`、`dynamic_context_generate_report`、`dynamic_context_read_report`、`dynamic_context_rewrite_report`、`dynamic_context_submit_report`、`dynamic_context_read_evidence`、`dynamic_context_search_evidence`

### 用户引导路由（guidance_router）

策略：白名单。默认允许已分类工具：

`read_image`、`dynamic_context_generate_report`、`dynamic_context_read_report`、`dynamic_context_rewrite_report`、`dynamic_context_submit_report`、`dynamic_context_read_evidence`、`dynamic_context_search_evidence`

### 历史压缩（compaction）

策略：白名单。默认允许已分类工具：

`read_image`

## 逐工具职责依据

| 内部 ID | 功能类别 | 默认许可角色 | 职责依据 |
| --- | --- | --- | --- |
| read | workspace_read | preplanning、executor、result_work | 规划探查或叶内读取；审计者使用其范围内的专用证据读取器。 |
| glob | workspace_read | preplanning、executor、result_work | 规划探查或叶内读取；审计者使用其范围内的专用证据读取器。 |
| grep | workspace_read | preplanning、executor、result_work | 规划探查或叶内读取；审计者使用其范围内的专用证据读取器。 |
| read_image | visual_evidence | controller、preplanning、executor、result_work、result_check、result_repair、plan_check、updater、reviewer、blockage、blockage_audit、group_audit、scope_plan、scope_update、scope_audit、scope_blockage、scope_pause、task_reporter、progress_reporter、guidance_intake、guidance_router、compaction | 所有角色可以读取本工作区内的图片证据；需宿主附件服务及图像模型路由，不授予写入、执行或跨任务权限。 |
| web_search | network_read | preplanning、executor、result_work | 规划或执行所需检索，仍受原生网络权限和任务工具绑定限制。 |
| web_fetch | network_read | preplanning、executor、result_work | 规划或执行所需检索，仍受原生网络权限和任务工具绑定限制。 |
| bash | shell | preplanning、executor、result_work | 预规划允许基础条件探查；执行者在叶内运行命令。原生权限和规划命令检查继续生效。 |
| write | workspace_work | executor、result_work | 工作区写入、终端执行或依赖安装只能由执行角色承担。 |
| edit | workspace_work | executor、result_work | 工作区写入、终端执行或依赖安装只能由执行角色承担。 |
| pwsh | workspace_work | executor、result_work | 工作区写入、终端执行或依赖安装只能由执行角色承担。 |
| str_replace_editor | workspace_work | executor、result_work | 工作区写入、终端执行或依赖安装只能由执行角色承担。 |
| load_workspace_dependencies | workspace_work | executor、result_work | 工作区写入、终端执行或依赖安装只能由执行角色承担。 |
| skill | skill_read | executor、result_work | 读取已获准的 Skill；不能通过文字授予工具或改变角色。 |
| present | presentation | executor、result_work | 呈现本叶成果；审查和报告角色复用宿主的报告输出通路。 |
| ask_user_question | human_question | controller、preplanning、executor、result_work | 必要信息向用户询问；不把用户回答自动转换为验收结论。 |
| get_goal | goal_read | controller | 主会话目标由控制层管理；叶执行使用固定任务合同。 |
| exit_plan_mode | host_plan_mode | controller | 由主会话退出原生规划模式；后台角色不能擅自解除主会话的规划边界。 |
| list_mcp_resources | external_resource_read | preplanning、executor、result_work | 规划或叶内按需读取已授权外部资料；Direct 需显式绑定宿主适配，不向审查角色提供无范围的外部资源入口。 |
| list_mcp_resource_templates | external_resource_read | preplanning、executor、result_work | 规划或叶内按需读取已授权外部资料；Direct 需显式绑定宿主适配，不向审查角色提供无范围的外部资源入口。 |
| read_mcp_resource | external_resource_read | preplanning、executor、result_work | 规划或叶内按需读取已授权外部资料；Direct 需显式绑定宿主适配，不向审查角色提供无范围的外部资源入口。 |
| create_goal | alternate_plan_mutation | 无 | 联动状态由任务图状态机持有规划和进度，禁止另建竞争清单或改写主目标。 |
| update_goal | alternate_plan_mutation | 无 | 联动状态由任务图状态机持有规划和进度，禁止另建竞争清单或改写主目标。 |
| todo_write | alternate_plan_mutation | 无 | 联动状态由任务图状态机持有规划和进度，禁止另建竞争清单或改写主目标。 |
| subagent | alternate_orchestration | 无 | 隔离角色不另起执行循环、并行代理或跨会话调度；专门联动需要独立适配。 |
| workflow | alternate_orchestration | 无 | 隔离角色不另起执行循环、并行代理或跨会话调度；专门联动需要独立适配。 |
| ralph | alternate_orchestration | 无 | 隔离角色不另起执行循环、并行代理或跨会话调度；专门联动需要独立适配。 |
| spawn_teammate | alternate_orchestration | 无 | 隔离角色不另起执行循环、并行代理或跨会话调度；专门联动需要独立适配。 |
| send_message | alternate_orchestration | 无 | 隔离角色不另起执行循环、并行代理或跨会话调度；专门联动需要独立适配。 |
| wait_agent | alternate_orchestration | 无 | 隔离角色不另起执行循环、并行代理或跨会话调度；专门联动需要独立适配。 |
| interrupt_agent | alternate_orchestration | 无 | 隔离角色不另起执行循环、并行代理或跨会话调度；专门联动需要独立适配。 |
| list_agents | alternate_orchestration | 无 | 隔离角色不另起执行循环、并行代理或跨会话调度；专门联动需要独立适配。 |
| list_subagent_models | alternate_orchestration | 无 | 隔离角色不另起执行循环、并行代理或跨会话调度；专门联动需要独立适配。 |
| team_task_create | alternate_orchestration | 无 | 隔离角色不另起执行循环、并行代理或跨会话调度；专门联动需要独立适配。 |
| team_task_list | alternate_orchestration | 无 | 隔离角色不另起执行循环、并行代理或跨会话调度；专门联动需要独立适配。 |
| team_task_get | alternate_orchestration | 无 | 隔离角色不另起执行循环、并行代理或跨会话调度；专门联动需要独立适配。 |
| team_task_update | alternate_orchestration | 无 | 隔离角色不另起执行循环、并行代理或跨会话调度；专门联动需要独立适配。 |
| create_worktree | alternate_orchestration | 无 | 隔离角色不另起执行循环、并行代理或跨会话调度；专门联动需要独立适配。 |
| job_output | persistent_execution | 无 | 长期终端和后台作业需要生命周期适配，不能绕过当前串行叶和工具回执边界。 |
| job_list | persistent_execution | 无 | 长期终端和后台作业需要生命周期适配，不能绕过当前串行叶和工具回执边界。 |
| job_kill | persistent_execution | 无 | 长期终端和后台作业需要生命周期适配，不能绕过当前串行叶和工具回执边界。 |
| terminal_open | persistent_execution | 无 | 长期终端和后台作业需要生命周期适配，不能绕过当前串行叶和工具回执边界。 |
| terminal_send | persistent_execution | 无 | 长期终端和后台作业需要生命周期适配，不能绕过当前串行叶和工具回执边界。 |
| terminal_read | persistent_execution | 无 | 长期终端和后台作业需要生命周期适配，不能绕过当前串行叶和工具回执边界。 |
| terminal_signal | persistent_execution | 无 | 长期终端和后台作业需要生命周期适配，不能绕过当前串行叶和工具回执边界。 |
| terminal_close | persistent_execution | 无 | 长期终端和后台作业需要生命周期适配，不能绕过当前串行叶和工具回执边界。 |
| terminal_list | persistent_execution | 无 | 长期终端和后台作业需要生命周期适配，不能绕过当前串行叶和工具回执边界。 |
| schedule_create | persistent_schedule | 无 | 角色不另建跨会话持久调度。 |
| schedule_list | persistent_schedule | 无 | 角色不另建跨会话持久调度。 |
| schedule_delete | persistent_schedule | 无 | 角色不另建跨会话持久调度。 |
| schedule_update | persistent_schedule | 无 | 角色不另建跨会话持久调度。 |
| session_search | cross_session_read | 无 | 使用当前工作流的证据工具，不能通过全局会话查询跨任务读私有轨迹。 |
| session_event_search | cross_session_read | 无 | 使用当前工作流的证据工具，不能通过全局会话查询跨任务读私有轨迹。 |
| session_trace | cross_session_read | 无 | 使用当前工作流的证据工具，不能通过全局会话查询跨任务读私有轨迹。 |
| session_event_trace | cross_session_read | 无 | 使用当前工作流的证据工具，不能通过全局会话查询跨任务读私有轨迹。 |
| session_event_read | cross_session_read | 无 | 使用当前工作流的证据工具，不能通过全局会话查询跨任务读私有轨迹。 |
| working_directory | host_state | 无 | 工作目录和宿主配置已固定；角色不能跨越固定工作区或读取宿主内部状态。 |
| cordis_inspect_list | host_state | 无 | 工作目录和宿主配置已固定；角色不能跨越固定工作区或读取宿主内部状态。 |
| cordis_inspect_query | host_state | 无 | 工作目录和宿主配置已固定；角色不能跨越固定工作区或读取宿主内部状态。 |
| run_code | alternate_transport | 无 | 当前 direct 使用原生逐工具协议，不能经另一执行通道绕过可见工具与回执检查。 |
| transaction_graph_read | task_graph_control | controller | 任务图基础工具由控制层持有；full 模式还受控制器的既有工具限制。 |
| transaction_graph_create | task_graph_control | controller | 任务图基础工具由控制层持有；full 模式还受控制器的既有工具限制。 |
| transaction_graph_begin | task_graph_control | controller | 任务图基础工具由控制层持有；full 模式还受控制器的既有工具限制。 |
| transaction_graph_finish | task_graph_control | controller | 任务图基础工具由控制层持有；full 模式还受控制器的既有工具限制。 |
| transaction_graph_skip | task_graph_control | controller | 任务图基础工具由控制层持有；full 模式还受控制器的既有工具限制。 |
| dynamic_context_route_task | workflow_control | controller | 只有交互控制层可调度或维护工作流，内建角色只返回其报告。 |
| dynamic_context_select_mode | workflow_control | controller | 只有交互控制层可调度或维护工作流，内建角色只返回其报告。 |
| dynamic_context_graph_status | workflow_control | controller | 只有交互控制层可调度或维护工作流，内建角色只返回其报告。 |
| dynamic_context_status | workflow_control | controller | 只有交互控制层可调度或维护工作流，内建角色只返回其报告。 |
| dynamic_context_recover_graphs | workflow_control | controller | 只有交互控制层可调度或维护工作流，内建角色只返回其报告。 |
| dynamic_context_revise | workflow_control | controller | 只有交互控制层可调度或维护工作流，内建角色只返回其报告。 |
| dynamic_context_continue_supervision | workflow_control | controller | 只有交互控制层可调度或维护工作流，内建角色只返回其报告。 |
| dynamic_context_run_next | workflow_control | controller | 只有交互控制层可调度或维护工作流，内建角色只返回其报告。 |
| dynamic_context_pause | workflow_control | controller | 只有交互控制层可调度或维护工作流，内建角色只返回其报告。 |
| dynamic_context_resume | workflow_control | controller | 只有交互控制层可调度或维护工作流，内建角色只返回其报告。 |
| dynamic_context_reconcile | workflow_control | controller | 只有交互控制层可调度或维护工作流，内建角色只返回其报告。 |
| dynamic_context_maintenance | workflow_control | controller | 只有交互控制层可调度或维护工作流，内建角色只返回其报告。 |
| dynamic_context_workflow | workflow_control | controller | 只有交互控制层可调度或维护工作流，内建角色只返回其报告。 |
| dynamic_context_submit | initial_blueprint | controller、preplanning | 首次双图只能经专用提交入口；后续更新由更新与审计事务完成。 |
| dynamic_context_planning_history | planning_evidence | preplanning | 只读当前规划绑定的启用前讨论快照，分页回查方案、用户确认与工具证据，不授予额外任务权限。 |
| dynamic_task_status | bound_execution_context | executor、result_work | 仅绑定叶中的状态、原始证据和共享事实；共享更新不会获得改图权限。 |
| dynamic_context_source_read | bound_execution_context | executor、result_work | 仅绑定叶中的状态、原始证据和共享事实；共享更新不会获得改图权限。 |
| dynamic_context_source_search | bound_execution_context | executor、result_work | 仅绑定叶中的状态、原始证据和共享事实；共享更新不会获得改图权限。 |
| dynamic_context_shared_read | bound_execution_context | executor、result_work | 仅绑定叶中的状态、原始证据和共享事实；共享更新不会获得改图权限。 |
| dynamic_context_shared_update | bound_execution_context | executor、result_work | 仅绑定叶中的状态、原始证据和共享事实；共享更新不会获得改图权限。 |
| dynamic_context_directory_snapshot | directory_identity | executor、result_work、result_repair | 执行或申报补正可以获取成果目录身份；审计者使用程序提供的静态校验。 |
| dynamic_context_generate_report | role_declaration | executor、result_work、result_check、result_repair、plan_check、updater、reviewer、blockage、blockage_audit、group_audit、scope_plan、scope_update、scope_audit、scope_blockage、scope_pause、task_reporter、progress_reporter、guidance_intake、guidance_router | 只生成、检查和局部修改该角色的申报草稿，不能变更成果或代替审计。 |
| dynamic_context_read_report | role_declaration | executor、result_work、result_check、result_repair、plan_check、updater、reviewer、blockage、blockage_audit、group_audit、scope_plan、scope_update、scope_audit、scope_blockage、scope_pause、task_reporter、progress_reporter、guidance_intake、guidance_router | 只生成、检查和局部修改该角色的申报草稿，不能变更成果或代替审计。 |
| dynamic_context_rewrite_report | role_declaration | executor、result_work、result_check、result_repair、plan_check、updater、reviewer、blockage、blockage_audit、group_audit、scope_plan、scope_update、scope_audit、scope_blockage、scope_pause、task_reporter、progress_reporter、guidance_intake、guidance_router | 只生成、检查和局部修改该角色的申报草稿，不能变更成果或代替审计。 |
| dynamic_context_submit_report | role_declaration | executor、result_work、result_check、result_repair、plan_check、updater、reviewer、blockage、blockage_audit、group_audit、scope_plan、scope_update、scope_audit、scope_blockage、scope_pause、task_reporter、progress_reporter、guidance_intake、guidance_router | 只生成、检查和局部修改该角色的申报草稿，不能变更成果或代替审计。 |
| dynamic_context_read_evidence | role_evidence | result_check、result_repair、plan_check、updater、reviewer、blockage、blockage_audit、group_audit、scope_plan、scope_update、scope_audit、scope_blockage、scope_pause、task_reporter、progress_reporter、guidance_intake、guidance_router | 只检索本次角色已经装配并封存的输入。 |
| dynamic_context_search_evidence | role_evidence | result_check、result_repair、plan_check、updater、reviewer、blockage、blockage_audit、group_audit、scope_plan、scope_update、scope_audit、scope_blockage、scope_pause、task_reporter、progress_reporter、guidance_intake、guidance_router | 只检索本次角色已经装配并封存的输入。 |
| dynamic_context_select_receipt | execution_receipt | result_repair | 从既有执行证据中选择申报引用，不制造测试结果。 |
| dynamic_context_blockage_reports | workflow_evidence | blockage、group_audit、scope_plan、scope_update、scope_blockage、task_reporter、progress_reporter | 只读当前工作流/当前层暴露的报告和证据目录。 |
| dynamic_context_blockage_report | workflow_evidence | blockage、group_audit、scope_plan、scope_update、scope_blockage、task_reporter、progress_reporter | 只读当前工作流/当前层暴露的报告和证据目录。 |
| dynamic_context_blockage_shared | workflow_evidence | blockage、group_audit、scope_plan、scope_update、scope_blockage、task_reporter、progress_reporter | 只读当前工作流/当前层暴露的报告和证据目录。 |
| dynamic_context_blockage_trace | private_execution_evidence | blockage、group_audit、scope_update、scope_blockage、task_reporter、progress_reporter | 计划复查默认只看成果报告；更新、终审、阻塞和总结角色可按需核实本层私有轨迹。 |
| dynamic_context_workspace_list | final_artifact_inspection | group_audit | 组级和根级终审核验原始成果；路径与只读权限继续受宿主约束。 |
| dynamic_context_workspace_read | final_artifact_inspection | group_audit | 组级和根级终审核验原始成果；路径与只读权限继续受宿主约束。 |
| dynamic_context_workspace_zip | final_artifact_inspection | group_audit | 组级和根级终审核验原始成果；路径与只读权限继续受宿主约束。 |
