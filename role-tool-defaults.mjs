// SPDX-License-Identifier: GPL-3.0-only
// Current native DSH internal IDs plus the two plugins' model-callable tools.
// These policies narrow available host capabilities; they never instantiate a tool.
const workers = ['executor', 'result_work']
const planning = ['preplanning', ...workers]
const auxiliary = ['result_check', 'result_repair', 'plan_check', 'updater', 'reviewer', 'blockage', 'blockage_audit', 'group_audit', 'scope_plan', 'scope_update', 'scope_audit', 'scope_blockage', 'scope_pause', 'task_reporter', 'progress_reporter', 'guidance_intake', 'guidance_router']
const inspection = ['blockage', 'group_audit', 'scope_plan', 'scope_update', 'scope_blockage', 'task_reporter', 'progress_reporter']
const rows = []
const add = (tools, family, allowRoles, reason, origin = 'native') => {
  for (const id of tools.split(' ')) rows.push(Object.freeze({ id, origin, family, allowRoles: Object.freeze([...allowRoles]), reason }))
}
add('propose_action', 'human_question', ['controller'], '把需要人工选择的动作交给主会话用户确认。')
add('apply_patch', 'workspace_work', workers, '仅供已获准的执行角色修改当前工作区。')
add('schedule_view schedule_edit', 'persistent_schedule', [], '角色的任务边界不包含跨会话持久调度。')
add('read glob grep', 'workspace_read', planning, '规划探查或叶内读取；审计者使用其范围内的专用证据读取器。')
add('read_image', 'visual_evidence', ['controller', ...planning, ...auxiliary, 'compaction'], '所有角色可以读取本工作区内的图片证据；需宿主附件服务及图像模型路由，不授予写入、执行或跨任务权限。')
add('web_search web_fetch', 'network_read', planning, '规划或执行所需检索，仍受原生网络权限和任务工具绑定限制。')
add('bash', 'shell', planning, '预规划允许基础条件探查；执行者在叶内运行命令。原生权限和规划命令检查继续生效。')
add('write edit pwsh str_replace_editor load_workspace_dependencies', 'workspace_work', workers, '工作区写入、终端执行或依赖安装只能由执行角色承担。')
add('skill', 'skill_read', workers, '读取已获准的 Skill；不能通过文字授予工具或改变角色。')
add('present', 'presentation', workers, '呈现本叶成果；审查和报告角色复用宿主的报告输出通路。')
add('ask_user_question', 'human_question', ['controller', 'preplanning', ...workers], '必要信息向用户询问；不把用户回答自动转换为验收结论。')
add('get_goal', 'goal_read', ['controller'], '主会话目标由控制层管理；叶执行使用固定任务合同。')
add('exit_plan_mode', 'host_plan_mode', ['controller'], '由主会话退出原生规划模式；后台角色不能擅自解除主会话的规划边界。')
add('list_mcp_resources list_mcp_resource_templates read_mcp_resource', 'external_resource_read', planning, '规划或叶内按需读取已授权外部资料；Direct 需显式绑定宿主适配，不向审查角色提供无范围的外部资源入口。')
add('create_goal update_goal todo_write', 'alternate_plan_mutation', [], '联动状态由任务图状态机持有规划和进度，禁止另建竞争清单或改写主目标。')
add('subagent workflow ralph spawn_teammate send_message wait_agent interrupt_agent list_agents list_subagent_models team_task_create team_task_list team_task_get team_task_update create_worktree', 'alternate_orchestration', [], '隔离角色不另起执行循环、并行代理或跨会话调度；专门联动需要独立适配。')
add('job_output job_list job_kill terminal_open terminal_send terminal_read terminal_signal terminal_close terminal_list', 'persistent_execution', [], '长期终端和后台作业需要生命周期适配，不能绕过当前串行叶和工具回执边界。')
add('schedule_create schedule_list schedule_delete schedule_update', 'persistent_schedule', [], '角色不另建跨会话持久调度。')
add('session_search session_event_search session_trace session_event_trace session_event_read', 'cross_session_read', [], '使用当前工作流的证据工具，不能通过全局会话查询跨任务读私有轨迹。')
add('working_directory cordis_inspect_list cordis_inspect_query', 'host_state', [], '工作目录和宿主配置已固定；角色不能跨越固定工作区或读取宿主内部状态。')
add('run_code', 'alternate_transport', [], '当前 direct 使用原生逐工具协议，不能经另一执行通道绕过可见工具与回执检查。')
add('transaction_graph_read transaction_graph_create transaction_graph_begin transaction_graph_finish transaction_graph_skip', 'task_graph_control', ['controller'], '任务图基础工具由控制层持有；full 模式还受控制器的既有工具限制。', 'task-graph')
add('dynamic_context_route_task dynamic_context_select_mode dynamic_context_graph_status dynamic_context_status dynamic_context_recover_graphs dynamic_context_revise dynamic_context_continue_supervision dynamic_context_run_next dynamic_context_pause dynamic_context_resume dynamic_context_reconcile dynamic_context_maintenance dynamic_context_workflow', 'workflow_control', ['controller'], '只有交互控制层可调度或维护工作流，内建角色只返回其报告。', 'dynamic-context')
add('dynamic_context_submit', 'initial_blueprint', ['controller', 'preplanning'], '首次双图只能经专用提交入口；后续更新由更新与审计事务完成。', 'dynamic-context')
add('dynamic_context_planning_history', 'planning_evidence', ['preplanning'], '只读当前规划绑定的启用前讨论快照，分页回查方案、用户确认与工具证据，不授予额外任务权限。', 'dynamic-context')
add('dynamic_task_status dynamic_context_source_read dynamic_context_source_search dynamic_context_shared_read dynamic_context_shared_update', 'bound_execution_context', workers, '仅绑定叶中的状态、原始证据和共享事实；共享更新不会获得改图权限。', 'dynamic-context')
add('dynamic_context_directory_snapshot', 'directory_identity', [...workers, 'result_repair'], '执行或申报补正可以获取成果目录身份；审计者使用程序提供的静态校验。', 'dynamic-context')
add('dynamic_context_generate_report dynamic_context_read_report dynamic_context_rewrite_report dynamic_context_submit_report', 'role_declaration', [...workers, ...auxiliary], '只生成、检查和局部修改该角色的申报草稿，不能变更成果或代替审计。', 'dynamic-context')
add('dynamic_context_read_evidence dynamic_context_search_evidence', 'role_evidence', auxiliary, '只检索本次角色已经装配并封存的输入。', 'dynamic-context')
add('dynamic_context_select_receipt', 'execution_receipt', ['result_repair'], '从既有执行证据中选择申报引用，不制造测试结果。', 'dynamic-context')
add('dynamic_context_blockage_reports dynamic_context_blockage_report dynamic_context_blockage_shared', 'workflow_evidence', inspection, '只读当前工作流/当前层暴露的报告和证据目录。', 'dynamic-context')
add('dynamic_context_blockage_trace', 'private_execution_evidence', inspection.filter(role => role !== 'scope_plan'), '计划复查默认只看成果报告；更新、终审、阻塞和总结角色可按需核实本层私有轨迹。', 'dynamic-context')
add('dynamic_context_workspace_list dynamic_context_workspace_read dynamic_context_workspace_zip', 'final_artifact_inspection', ['group_audit'], '组级和根级终审核验原始成果；路径与只读权限继续受宿主约束。', 'dynamic-context')
if (new Set(rows.map(row => row.id)).size !== rows.length) throw Error('DUPLICATE_DEFAULT_ROLE_TOOL')
export const ROLE_TOOL_CATALOG = Object.freeze(rows)
const known = new Map(rows.map(row => [row.id, row]))
export function defaultRoleTools(role, strategy, registered = []) {
  const whitelist = rows.filter(row => row.allowRoles.includes(role)).map(row => row.id)
  const blacklist = rows.filter(row => !row.allowRoles.includes(role)).map(row => row.id)
  const extensions = registered.filter(id => !known.has(id))
  const allowed = new Set([...whitelist, ...extensions]), denied = new Set(blacklist)
  return { version: 1, role, strategy, whitelist, blacklist, extensions,
    allows: id => strategy === 'blacklist' ? !denied.has(id) : allowed.has(id) }
}
export function roleToolCoverage(toolIds) {
  return { known: toolIds.filter(id => known.has(id)), unclassified: toolIds.filter(id => !known.has(id)) }
}
