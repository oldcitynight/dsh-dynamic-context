import { withPreferences } from './settings.mjs'
// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs'
import path from 'node:path'
import { defineTool as nativeDefineTool } from '@deepseek-ai/dsh-tools'
import { checkedTool } from 'dsh-better-task-grapth/validation'
const defineTool = options => checkedTool(nativeDefineTool, options)
import { scopeParentOf } from '@deepseek-ai/dsh-scope'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { digest, normalizePlan } from 'dsh-better-task-grapth/core'
import { connectTaskGraph } from './interop.mjs'
import { registerControlTools } from './control-tools.mjs'
import { REVISION_CONTEXTS } from './revision.mjs'
import { GRAPH_COMMIT_RECORD } from './graph-presence.mjs'
import { jsonExample } from './format-examples.mjs'
import { WorkflowOrchestrator, MANAGED_GUIDANCE } from './orchestration.mjs'
import { rolePrompt, roleTools, roleScope } from './role-policy.mjs'

export const ROUTE_RECORD = 'plugin:dsh-dynamic-context/route-v1'
const ENTRY_TOOLS = new Set(['dynamic_context_route_task', 'dynamic_context_select_mode', 'dynamic_context_graph_status', 'ask_user_question', 'get_goal', 'present', 'exit_plan_mode', 'read_image'])
const MANAGED_TOOLS = new Set([...ENTRY_TOOLS, 'dynamic_context_workflow', 'dynamic_context_status', 'dynamic_context_recover_graphs', 'dynamic_context_reconcile', 'dynamic_context_maintenance'])
// Retain the legacy registrations for host integrations and historical records,
// but activation is owned by the authenticated human command, never the model.
const COMMAND_ONLY_TOOLS = new Set(['dynamic_context_route_task', 'dynamic_context_select_mode'])
export const MODE_RECORD = 'plugin:dsh-dynamic-context/mode-v1'
export const MODE_OPTIONS = Object.freeze([
  { mode: 'full', label: '启用完整任务图功能（推荐）', description: '规划任务图和上下文图，按叶装配上下文并执行联动监督。' },
  { mode: 'task-graph', label: '启用任务图但不启用动态上下文', description: '使用独立任务图的原有工具和执行方式。' },
  { mode: 'native', label: '不启用任务图', description: '使用原生对话和执行流程。' },
])
const CLASSIC_TOOLS = ['transaction_graph_read', 'transaction_graph_create', 'transaction_graph_begin', 'transaction_graph_finish', 'transaction_graph_skip']
const CONTROLLER_TOOLS = new Set([
  'dynamic_context_select_mode', 'dynamic_context_graph_status',
  'read', 'read_image', 'glob', 'grep', 'web_search', 'web_fetch', 'skill',
  'ask_user_question', 'exit_plan_mode', 'get_goal', 'present',
])
const ADVANCE_TOOLS = new Set(['dynamic_context_run_next', 'dynamic_context_resume',
  'dynamic_context_continue_supervision', 'dynamic_context_revise'])
const PLAN_MODE_DENIAL = 'DYNAMIC_CONTEXT_PLAN_MODE_ACTIVE: use exit_plan_mode or wait for the user to leave plan mode before advancing a leaf or supervision.'
const reject = code => { const error = new Error(code); error.code = code; throw error }
const textOf = message => (message.content ?? []).filter(row => row.type === 'text').map(row => row.text).join('\n')
export const INITIAL_GUIDANCE = `任务图与动态上下文使用指引
本版本只通过用户实际输入 /task-graph [任务说明] 启用任务图。由程序提供“不启用任务图、启用任务图但不启用动态上下文、启用完整任务图功能”三个选项；模型不判断任务规模来启动插件，不自行询问执行模式，也不能代替用户发送指令或调用旧的模式选择/路线登记工具。
未通过指令启用时，按原生 DSH 处理当前请求，保留原生工具、任务清单和 Plan 模式。用户说先讨论、暂不规划或等确认后再开工时，先讨论与必要探查，不把未来的完整交付目标当成本轮规划或执行授权，也不要求先选插件模式。自然语言提到希望使用任务图时，可说明 /task-graph 入口，等待用户实际输入；不要因此停止当前获准的讨论。
已核验的选择和既有图继续有效，重新打开会话不重置或自动重启。独立任务图使用 transaction_graph_* 工具。完整模式由独立预规划角色探查和提交双图，程序交接并串行调度，绑定上下文的独立叶执行者开展正式工作。原生清单不替代已选模式的任务图。用户要求先规划、暂停或等待批准时，停在对应边界；原生 Plan 模式始终独立生效。
缺图时先用 dynamic_context_graph_status 核对历史。原本只有任务图时沿用独立任务图；首次孤立上下文图需要询问是否回退。已提交后缺失或损坏时进入恢复流程，保留进度与活动尝试，不能重新建图、降级或重放。`

const UNSELECTED_GUIDANCE = '当前未通过 /task-graph 启用任务图，按原生流程处理用户当前请求。无需登记路线、判断任务规模或询问插件模式。'
const CONTROLLER_GUIDANCE = `你当前是完整模式主会话控制器，负责规划、调度和向用户说明进度。提交双图、看到待执行叶或收到执行结果，都不会把你切换为叶执行者。图中的 instruction 是交给独立叶执行者的任务数据，legalNext 是可调度候选，不是已启动的叶。原生清单若已存在，只是历史记录。
用户已授权推进且有就绪叶时，按当前回执中的 nextTool 和 arguments 调用 dynamic_context_run_next。需要选择其他就绪叶时，使用 status.taskGraph.legalNext 对应的 choice。每次只调度一个叶，收到结果后依最新状态继续；先处理活动叶、监督检查点或图恢复。只有联合账本中的执行与验收状态可以确认叶的结果。区分已规划、已执行、已提交报告和已验收；主会话的总结不能代替叶报告或验收。
叶工具白名单仅声明叶能力，不能据此调用主会话未提供的工具。dynamic_context_shared_read 与 dynamic_context_shared_update 在获准绑定的叶内使用；普通文件可以作为成果，但写文件不等于更新共享上下文。遇到工具不可见先核对角色、绑定和状态，不自行更换执行模式或宣称机制已完成。`
export const BASIC_CONDITIONS_GUIDANCE = '规划前进行基础条件探查：核对任务开展所需的工作对象是否可访问、现有授权是否覆盖所需操作、工具与必要外部资源是否可用，以及对象有哪些影响规划的基本结构特征。按当前任务所需选择检查项，不逐项套用无关检查。访问范围与读写/执行授权、目录或资料的粗略结构、主要语言/格式、必要的终端或网络能力，都可按此类比；它们不是每个任务都必须检查的清单。区分已核验、仅由配置声明和未知；当前角色未开放某工具不等于整个执行环境缺少该能力。能说明任务能否开展、受哪些限制、缺什么条件，并足以划定叶边界、输入、依赖和验收标准时结束探查。未知且不阻止规划的条件可安排为调查叶；阻止继续的访问或权限缺口先说明并请求必要澄清，不擅自扩权。Bash 可用于终端、网络、工具及目录等基础条件检查，遵守原生权限和审批；选择只读或无副作用检查，不使用命令字符串白名单替代原生权限。不为验证权限而修改真实内容，不提前展开方案研究、批量处理、下载依赖、构建或实施。'
const PLANNING_GUIDANCE = '当前等待双图提交。' + BASIC_CONDITIONS_GUIDANCE + '随后用 dynamic_context_submit 提交双图。planningReport 区分已观察事实、设计选择和待验证假设；上下文按叶所需绑定，共享区承载可复用事实，局部执行指令留在对应 binding。'

/** Extension-owned interaction and ownership; the base supplies generic ports. */
export class SessionInteraction {
  constructor(ctx, template, createRunner) {
    this.ctx = ctx; this.template = template; this.createRunner = createRunner
    this.entries = new Map(); this.filters = new Map(); this.pending = new Set(); this.closed = false
    this.basicConditionsGuidance = BASIC_CONDITIONS_GUIDANCE
    this.orchestrator = template.config.interaction.orchestration ? new WorkflowOrchestrator(this) : null
  }
  record(agent) {
    return agent?.session.snapshotEvents().findLast(event => event.type === MODE_RECORD
      && event.ignorable === true && event.data.sessionId === agent.session.id)?.data
  }
  isController(agent) {
    return Boolean(agent && this.ctx.agents.roots().includes(agent)
      && !agent.session.snapshotEvents().some(row => row.ignorable && row.type === 'plugin:dynamic-context/execution-host-v1'))
  }
  route(agent) {
    return agent.session.snapshotEvents().findLast(row => row.ignorable && row.type === ROUTE_RECORD
      && row.data.sessionId === agent.session.id)?.data
  }
  allowedNames(agent) {
    if (!this.orchestrator || !this.isController(agent)) return null
    if (this.mode(agent) === 'full') {
      const runner = this.entries.get(agent)?.runner ?? this.template, scope = { ...roleScope(runner), sessionId: agent.session.id }
      const extra = roleTools(runner).extensions('controller', scope, runner.config.projectRoot).map(row => row.toolId)
      return new Set(roleTools(runner).select('controller', [...MANAGED_TOOLS, ...extra], scope, runner.config.projectRoot).allowed)
    }
    return null
  }
  classic(agent) {
    if (!agent || this.ctx.agents.get(agent.id) !== agent) return null
    try { return this.template.taskGraph.host.snapshot(agent.session).graph } catch { return null }
  }
  basePresence(agent) {
    if (!agent || this.ctx.agents.get(agent.id) !== agent) return { state: 'OUTSIDE_SCOPE' }
    return this.template.taskGraph.inspectGraphPresence(agent)
  }
  linkedPresence(agent) {
    const entry = this.entries.get(agent)
    if (entry) return entry.runner.graphPresence()
    const events = agent.session.snapshotEvents()
    const key = digest({ id: agent.session.id, createdAt: agent.session.header.createdAt, cwd: agent.session.header.cwd })
    const committed = events.some(event => event.ignorable && event.type === GRAPH_COMMIT_RECORD
      && event.data.workflowId === `workflow_${key.slice(0, 40)}`)
    const selected = events.some(event => event.ignorable && event.type === MODE_RECORD
      && event.data.sessionId === agent.session.id && event.data.mode === 'full')
    // A deliberately inactive workflow is not proof of absence. Its storage is
    // inspected when remounted; a surviving session receipt still proves history.
    return committed || selected ? { state: 'INACTIVE_GRAPH_NOT_INSPECTED', previouslyCommitted: committed ? true : null }
      : { state: 'NEVER_CREATED', previouslyCommitted: false }
  }
  mode(agent) {
    if (!['PRESENT', 'CREATION_PENDING', 'NEVER_CREATED', 'OUTSIDE_SCOPE'].includes(this.basePresence(agent).state)) return 'recovery'
    const record = this.record(agent)
    if (record && !['native', 'task-graph', 'full'].includes(record.mode)) reject('DYNAMIC_CONTEXT_MODE_RECORD_INVALID')
    return record?.mode ?? (this.classic(agent) ? 'task-graph' : 'native')
  }
  exact(agent) {
    this.template.assertBase()
    if (this.closed || !agent || this.ctx.agents.get(agent.id) !== agent
        || !this.isController(agent)) reject('DYNAMIC_CONTEXT_ROOT_CONTROLLER_REQUIRED')
  }
  planOnly(agent) {
    const native = this.ctx.get('planMode')?.get(agent)
    if (native) return native.pending ?? native.active
    return this.ctx.sessionProjections.stateOf(agent.session, 'plan')?.active === true
  }
  readyLeafCall(status, planOnly) {
    const next = status.taskGraph?.legalNext[0]
    if (!next || status.busy || status.closed || status.revisionRecovery?.length || planOnly) return {}
    return { nextTool: 'dynamic_context_run_next', arguments: { expectedRevision: status.revision, choice: next.choice } }
  }
  install() {
    const ctx = this.ctx
    ctx.effect(() => this.template.taskGraph.registerSessionPolicy({ id: 'dynamic-context',
      allowClassic: agent => this.mode(agent) === 'task-graph', onRequestGraph: invocation => this.requestGraph(invocation) }))
    ctx.tools.guard(exec => this.guardController(exec))
    // Native restrict() only applies to inherited registrations. Filter the
    // assembled schemas too, using the exact same rule as dispatch admission.
    ctx.on('system-prompt/assemble', async (_assembly, { agent }, next) => {
      if (agent && this.isController(agent) && this.mode(agent) === 'full') this.syncControllerTools(agent)
      const result = await next(), allow = agent && this.allowedNames(agent)
      return { ...result, tools: result.tools.filter(row => !COMMAND_ONLY_TOOLS.has(row.name)
        && (!allow || allow.has(row.name))
        && (row.name !== 'dynamic_context_workflow' || agent && this.mode(agent) === 'full')) }
    })
    this.orchestrator?.install()
    if (this.orchestrator) ctx.tools.register(defineTool({ name: 'dynamic_context_route_task', projectPlanCapability: 'read_or_protocol',
      description: 'Register the work route before using business tools in a new conversation. native is for a short local task and needs no human mode question. project immediately asks for a mode. Judge the complete delivery scope, dependencies and separate acceptance results; one directory, one artifact or a short prompt is not evidence of a short task. Pure questions need no route. Existing graphs and selected modes remain valid.\n'
        + jsonExample('A single local check', { route: 'native', reason: 'One isolated check with no dependent delivery stages.' }) + '\n'
        + jsonExample('Several dependent deliverables', { route: 'project', reason: 'Preparation, implementation and validation have separate acceptance results.' }),
      parameters: { route: { type: 'string', required: true, enum: ['native', 'project'] }, reason: { type: 'string', required: true } },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: async ({ route, reason }, exec) => {
        this.exact(exec.agent); exec.signal.throwIfAborted()
        if (!reason.trim()) reject('DYNAMIC_CONTEXT_ROUTE_REASON_REQUIRED')
        if (route === 'project') return this.select(exec.agent, { reason }, exec.signal)
        if (this.record(exec.agent) || this.classic(exec.agent)) return { mode: this.mode(exec.agent), changed: false }
        appendPluginRecord(exec.agent.session, ROUTE_RECORD, { version: 1, sessionId: exec.agent.session.id,
          route: 'native', reason, source: 'model-scope-classification' })
        if (!await ctx.sessions.flush(exec.agent.session)) reject('DYNAMIC_CONTEXT_ROUTE_NOT_DURABLE')
        this.refresh(exec.agent)
        return { mode: 'native', selected: false, route: 'native', instruction: 'Short-task route registered; native tools are now available. A later project-sized request still requires mode selection.' }
      },
    }))
    ctx.systemPrompt.section({ name: 'dynamic-context:initial-guidance', order: 45,
      text: ({ agent }) => !this.isController(agent) ? '' : this.orchestrator ? INITIAL_GUIDANCE
        : INITIAL_GUIDANCE.replace('完整模式由独立预规划角色探查和提交双图，程序交接并串行调度，绑定上下文的独立叶执行者开展正式工作。', '当前是手动控制器兼容模式：主会话提交双图并调用 dynamic_context_run_next，独立叶执行者开展正式工作。') })
    ctx.systemPrompt.context({ name: 'dynamic-context:session-mode', order: 47, interpolate: false,
      text: ({ agent }) => {
        if (!agent || !this.isController(agent)) return ''
        const mode = this.mode(agent), entry = this.entries.get(agent)
        const state = { mode, selected: Boolean(this.record(agent)), activation: 'human-command',
          standaloneGraphPresence: this.basePresence(agent), route: this.route(agent)?.route ?? null }
        if (mode !== 'full' || !entry) return JSON.stringify(state)
          + (mode === 'native' && !state.selected && !state.route ? '\n' + UNSELECTED_GUIDANCE : '')
        const runner = entry.runner
        const status = runner.status(), planOnly = this.planOnly(agent)
        if (this.orchestrator) return JSON.stringify({ ...state, role: 'controller', workflowId: runner.workflowId,
          lifecycle: this.orchestrator.status(agent), status, planOnly }) + '\n' + rolePrompt(runner, 'controller', MANAGED_GUIDANCE).content
        return JSON.stringify({ ...state, role: 'controller', workflowId: runner.config.interop.workflowId, status,
          planOnly, ...this.readyLeafCall(status, planOnly) })
          + '\n' + CONTROLLER_GUIDANCE
          + (status.graphPresence.state === 'NEVER_CREATED' ? '\n' + PLANNING_GUIDANCE : '')
          + (runner.config.revision ? '\n' + REVISION_CONTEXTS.trigger + '\n' + JSON.stringify({ policy: runner.config.revision.policy }) : '')
          + (runner.config.supervision ? '\n每个叶绑定 completion。叶执行者提交成果报告，监督与计划倒查由联动流程串行执行。有待办监督检查点时按状态调用 dynamic_context_continue_supervision。' : '')
      } })
    ctx.tools.register(defineTool({ name: 'dynamic_context_select_mode',
      description: 'For a project-sized request, or any explicit user request to use a task graph regardless of task size, ask the user to choose native, standalone task graph, or full task/context graphs before creating a plan or carrying out work. The initial mode:native with selected:false is not a user choice. Graph tools become available after selection; their initial absence is expected. An existing explicit user choice may be bound using its exact userMessageId and quote. Use the actual message ID and verbatim text; if the ID is unavailable, omit explicit and let this tool ask. Never invent a message ID. Repeated calls return the existing choice unless reconsider=true.\n'
        + jsonExample('Ask the user', { reason: 'The project has several dependent stages.' }) + '\n'
        + jsonExample('Bind an explicit choice already present in the conversation', { reason: 'The user chose full mode.',
          explicit: { mode: 'full', userMessageId: 'example-message', quote: '启用完整任务图功能' } }),
      parameters: { reason: { type: 'string', required: true }, reconsider: { type: 'boolean' },
        explicit: { type: 'object', properties: { mode: { type: 'string', required: true, enum: ['native', 'task-graph', 'full'] },
          userMessageId: { type: 'string', required: true }, quote: { type: 'string', required: true } }, additionalProperties: false } },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: (args, exec) => this.select(exec.agent, args, exec.signal),
    }))
    ctx.tools.register(defineTool({ name: 'dynamic_context_graph_status',
      description: 'Distinguish graphs never created from a previously committed graph that is missing or invalid. Recovery is required before continuing a damaged workflow.\n' + jsonExample('Read graph presence', {}),
      parameters: {}, projectPlanCapability: 'read_or_protocol',
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: (_args, exec) => { this.exact(exec.agent); return { mode: this.mode(exec.agent), base: this.basePresence(exec.agent),
        linked: this.linkedPresence(exec.agent),
        instruction: 'Missing historical graphs require restoration of verified state. Do not start a new graph or infer that previous work never happened.' } },
    }))
    ctx.on('agent/created', async ({ agent }) => {
      if (!this.isController(agent)) return
      if (this.mode(agent) === 'full') this.mount(agent, this.record(agent))
      this.refresh(agent)
    })
    ctx.on('agent/disposed', ({ agent }) => this.release(agent))
    for (const agent of ctx.agents.roots().filter(agent => this.isController(agent))) {
      if (this.mode(agent) === 'full') this.mount(agent, this.record(agent))
      this.refresh(agent)
    }
  }
  refresh(agent) {
    this.unfilter(agent)
    const managedAllow = this.allowedNames(agent)
    if (managedAllow) {
      const parent = scopeParentOf(agent)
      const disposers = []
      // A root may already declare native presentation. DSH permits only one
      // declaration per scope; an inherited PTC transport needs the override.
      if (this.ctx.tools.get('run_code', agent)) disposers.push(agent.ctx.tools.presentAs('native'))
      disposers.push(agent.ctx.tools.restrict({
        allow: [...managedAllow].filter(name => this.ctx.tools.get(name, parent) !== undefined) }))
      this.filters.set(agent, () => disposers.reverse().forEach(dispose => dispose()))
      return
    }
    if (this.record(agent)?.mode === 'full') {
      const tools = this.ctx.tools, scoped = agent.ctx.tools
      const disposers = []
      this.filters.set(agent, () => { for (const dispose of disposers.reverse()) dispose() })
      // Web tools live in the preset parent scope. Agent-owned control tools
      // stay visible under a restriction, and the guard covers local additions.
      const parent = scopeParentOf(agent)
      const allow = [...CONTROLLER_TOOLS].filter(name => tools.get(name, parent) !== undefined)
      if (tools.get('run_code', agent)) disposers.push(scoped.presentAs('native'))
      disposers.push(scoped.restrict({ allow }))
      return
    }
    if (this.mode(agent) !== 'task-graph') {
      const deny = CLASSIC_TOOLS.filter(name => this.ctx.tools.get(name) !== undefined)
      if (deny.length) this.filters.set(agent, agent.ctx.tools.restrict({ deny }))
    }
  }
  syncControllerTools(agent) {
    const runner = this.entries.get(agent)?.runner
    if (!runner) return
    this.roleExtensions ??= new Map()
    const previous = this.roleExtensions.get(agent)
    const scope = { ...roleScope(runner), sessionId: agent.session.id }
    const metadata = roleTools(runner).list(), key = digest([metadata, scope])
    if (previous?.key === key) return
    previous?.disposers.forEach(dispose => dispose())
    const disposers = []
    for (const tool of roleTools(runner).nativeDefinitions('controller', scope, { runner, sourceAgent: agent })) {
      if (this.ctx.tools.get(tool.name, agent)) reject('ROLE_TOOL_SHADOW_FORBIDDEN')
      disposers.push(agent.ctx.tools.register({ ...tool, projectPlanCapability: 'read_or_protocol' }))
    }
    this.roleExtensions.set(agent, { key, disposers })
  }
  guardController({ agent, name }) {
    if (!agent) return
    if (COMMAND_ONLY_TOOLS.has(name)) return 'DYNAMIC_CONTEXT_COMMAND_REQUIRED: Only the user /task-graph command can activate or change the mode. Continue the current authorized native discussion or work; do not ask for a plugin mode or retry this legacy tool.'
    const allow = this.allowedNames(agent)
    if (allow && !allow.has(name)) return this.mode(agent) === 'full'
      ? `DYNAMIC_CONTEXT_CONTROLLER_TOOL_NOT_ALLOWED: ${name}. The program owns planning and dispatch; use dynamic_context_workflow and inspect lifecycle.`
      : `DYNAMIC_CONTEXT_ROUTE_REQUIRED: ${name}. Register native for a short task, or select the project mode, before using business tools.`
    if (allow && ADVANCE_TOOLS.has(name) && this.planOnly(agent)) return PLAN_MODE_DENIAL
    if (allow) return
    const entry = this.entries.get(agent)
    if (!entry && (!this.isController(agent) || this.record(agent)?.mode !== 'full')) return
    if (ADVANCE_TOOLS.has(name) && this.planOnly(agent)) return PLAN_MODE_DENIAL
    if (name === 'todo_write')
      return 'DYNAMIC_CONTEXT_CONTROLLER_TOOL_NOT_ALLOWED: todo_write is the native list. Use dynamic_context_submit to submit the task graph and context graph.'
    if (!CONTROLLER_TOOLS.has(name) && !entry?.tools.names.has(name))
      return `DYNAMIC_CONTEXT_CONTROLLER_TOOL_NOT_ALLOWED: ${name} is outside the controller tools. Use read-only planning tools, submit the joint graphs, and dispatch work through dynamic_context_run_next when ready.`
  }
  unfilter(agent) {
    const dispose = this.filters.get(agent)
    this.filters.delete(agent)
    dispose?.()
  }
  async unmount(agent) {
    this.orchestrator?.cancel(agent)
    this.roleExtensions?.get(agent)?.disposers.forEach(dispose => dispose())
    this.roleExtensions?.delete(agent)
    const entry = this.entries.get(agent)
    if (!entry) return
    this.entries.delete(agent); entry.tools.dispose(); entry.workflow(); await entry.runner.close()
  }
  release(agent) {
    this.orchestrator?.cancel(agent)
    this.unfilter(agent)
    return this.unmount(agent)
  }
  ensureIdle(agent) {
    if (this.orchestrator?.running.has(agent)) reject('DYNAMIC_CONTEXT_MODE_CHANGE_REQUIRES_IDLE_BOUNDARY')
    if (this.basePresence(agent).state === 'CREATION_PENDING') reject('DYNAMIC_CONTEXT_MODE_CHANGE_REQUIRES_IDLE_BOUNDARY')
    if (!['PRESENT', 'CREATION_PENDING', 'NEVER_CREATED', 'OUTSIDE_SCOPE'].includes(this.basePresence(agent).state)) reject('TASK_GRAPH_RECOVERY_REQUIRED')
    const classic = this.classic(agent), runner = this.entries.get(agent)?.runner
    runner?.assertGraphEvidence()
    const state = runner?.graph.read()
    if (classic?.active || classic?.pending || runner?.busy || state?.graph.state.active
        || state?.supervision && state.supervision.phase !== 'READY') reject('DYNAMIC_CONTEXT_MODE_CHANGE_REQUIRES_IDLE_BOUNDARY')
  }
  explicit(agent, input) {
    if (!input) return null
    const message = agent.session.deriveMessages().find(row => row.id === input.userMessageId
      && row.role === 'user' && row.source?.kind === 'user')
    if (!message || !input.quote?.trim() || !textOf(message).includes(input.quote)) return null
    const phrases = {
      native: /^(?:不启用任务图|不用任务图|使用原生模式)[。！!\s]*$/,
      'task-graph': /^(?:启用任务图但不启用动态上下文|只使用任务图|只启用任务图)[。！!\s]*$/,
      full: /^(?:启用完整任务图功能(?:（推荐）)?|使用动态上下文|启用动态上下文|使用上下文图)[。！!\s]*$/,
    }
    return input.quote.trim() === textOf(message).trim() && phrases[input.mode]?.test(input.quote.trim()) ? input.mode : null
  }
  async ask(agent, question, options, signal, { id = 'dynamic-context-mode', header = '任务执行方式' } = {}) {
    const questions = this.ctx.get('userQuestions')
    if (!questions) reject('DYNAMIC_CONTEXT_USER_QUESTION_SERVICE_REQUIRED')
    const answer = await questions.ask({ agent, signal, questions: [{ id, header, question,
      options: options.map(({ label, description }) => ({ label, description })), multiSelect: false }] })
    signal?.throwIfAborted(); this.exact(agent)
    const row = answer.answers?.find(item => item.id === id)
    if (!row || row.selected?.length !== 1 || row.custom?.trim()) return null
    return options.find(option => option.label === row.selected[0])?.mode ?? null
  }
  policy(agent, evidence = {}) {
    const messages = agent.session.deriveMessages().filter(row => row.role === 'user' && row.source?.kind === 'user')
    const command = evidence.commandId && agent.session.snapshotEvents().find(row => row.type === 'command/run'
      && row.data.commandId === evidence.commandId && row.data.name === 'task-graph' && row.data.source?.kind === 'user')
    const requirements = messages.map((row, i) => ({ id: `user_${i}`, text: textOf(row) || '[用户消息含非文本内容；必须回看原消息，不能自行推断或放宽约束。]' }))
    if (command) requirements.push({ id: 'task_graph_command', text: command.data.args?.trim() || '用户主动要求使用任务图；若尚无具体任务，先询问任务内容，不得自行虚构任务。' })
    if (!requirements.length) reject('DYNAMIC_CONTEXT_USER_TASK_CONTRACT_REQUIRED')
    return { objective: '完成本会话用户授权的任务，保持原始约束与验收标准。',
      requirements }
  }
  async requestGraph({ agent, commandId, rawInput, signal }) {
    this.exact(agent); signal.throwIfAborted()
    const command = agent.session.snapshotEvents().find(row => row.type === 'command/run'
      && row.data.commandId === commandId && row.data.name === 'task-graph'
      && row.data.args === rawInput && row.data.source?.kind === 'user')
    if (!command) reject('DYNAMIC_CONTEXT_HUMAN_COMMAND_REQUIRED')
    const result = await this.select(agent, { reason: '用户通过 /task-graph 主动要求使用任务图',
      reconsider: this.record(agent)?.mode === 'native' }, signal, { commandId })
    signal.throwIfAborted(); this.exact(agent)
    if (result.status === 'NEEDS_USER_CHOICE' || result.status === 'RECOVERY_REQUIRED')
      return { kind: 'error', text: result.status === 'NEEDS_USER_CHOICE' ? '尚未获得明确选择，本次没有启动规划。' : '历史图需要恢复，本次没有重新规划或重放执行。' }
    // Only the literal command argument is user-authored. Process instructions
    // belong to runtime context, never to a synthesized human task message.
    agent.steer(createUserMessage({ source: rawInput.trim() ? { kind: 'user' }
      : { kind: 'dynamic-context', form: 'notice', summary: '主动任务图入口' },
      content: [{ type: 'text', text: rawInput.trim() || '任务图模式选择已核验。沿用当前真实任务；尚无任务内容时先询问。' }] }))
    return { kind: 'success', text: `已选择${MODE_OPTIONS.find(row => row.mode === result.mode).label}，要求已交给当前 Agent。` }
  }
  async select(agent, { reason, explicit, reconsider = false }, signal, commandEvidence = {}) {
    this.exact(agent); signal?.throwIfAborted()
    if (typeof reason !== 'string' || !reason.trim()) reject('DYNAMIC_CONTEXT_MODE_REASON_REQUIRED')
    if (this.pending.has(agent)) reject('DYNAMIC_CONTEXT_MODE_QUESTION_PENDING')
    const prior = this.record(agent)
    if (!['PRESENT', 'CREATION_PENDING', 'NEVER_CREATED', 'OUTSIDE_SCOPE'].includes(this.basePresence(agent).state))
      return { status: 'RECOVERY_REQUIRED', mode: 'recovery', baseGraphPresence: this.basePresence(agent), changed: false }
    const graphPresence = this.entries.get(agent)?.runner.graphPresence()
    if (graphPresence?.recoveryRequired) return { status: 'RECOVERY_REQUIRED', mode: 'full', graphPresence, changed: false, nextTool: 'dynamic_context_recover_graphs' }
    if (prior && !reconsider) return { mode: prior.mode, alreadySelected: true }
    this.ensureIdle(agent); this.pending.add(agent)
    try {
      const direct = this.explicit(agent, explicit)
      const mode = direct ?? await this.ask(agent, `请选择本会话的工作模式。${commandEvidence.commandId ? '你已通过 /task-graph 打开此选项。' : reason}`, MODE_OPTIONS, signal)
      if (!mode) return { status: 'NEEDS_USER_CHOICE', mode: this.mode(agent), changed: false }
      return await this.set(agent, mode, { source: direct ? 'explicit-user-message' : 'human-question',
        ...commandEvidence, ...(direct ? { userMessageId: explicit.userMessageId, quote: explicit.quote } : {}) }, signal)
    } finally { this.pending.delete(agent) }
  }
  async set(agent, mode, evidence, signal) {
    this.exact(agent); signal?.throwIfAborted(); this.ensureIdle(agent)
    if (mode !== 'native' && !this.template.taskGraph.host.inProject(agent.session)) reject('DYNAMIC_CONTEXT_TASK_GRAPH_PROJECT_UNAVAILABLE')
    const taskOnly = mode === 'full' && Boolean(this.classic(agent))
    if (taskOnly) mode = 'task-graph'
    const row = { version: 1, sessionId: agent.session.id, mode, evidence,
      ...(mode === 'full' ? { policy: this.policy(agent, evidence), preferences: this.template.preferences?.() ?? {} } : {}) }
    await this.unmount(agent)
    signal?.throwIfAborted(); this.exact(agent)
    appendPluginRecord(agent.session, MODE_RECORD, row)
    if (!await this.ctx.sessions.flush(agent.session)) reject('DYNAMIC_CONTEXT_MODE_NOT_DURABLE')
    signal?.throwIfAborted(); this.exact(agent)
    if (mode === 'full') this.mount(agent, row)
    this.refresh(agent)
    const lifecycle = mode === 'full' && this.orchestrator ? await this.orchestrator.configure(agent, signal) : null
    return { mode, ...(this.orchestrator && mode === 'full' ? { lifecycle: lifecycle ?? { phase: 'NEEDS_EXECUTION_CHOICE' },
      instruction: this.orchestrator.queued.has(agent) ? 'Independent planning and program dispatch are scheduled. Do not plan or execute in the controller.'
        : lifecycle ? 'Existing workflow retained without automatic restart. Use dynamic_context_workflow(action:continue) to continue explicitly.'
        : 'Ask for execution preference with dynamic_context_workflow(action:start).' } : {}), ...(taskOnly ? { reason: 'EXISTING_TASK_GRAPH_WITHOUT_CONTEXT', instruction: 'An existing task graph has no context graph. Continue with original task-graph tools; do not fabricate contexts or replace its progress.' } : {}), ...(mode === 'task-graph' ? { nextTool: 'transaction_graph_read' } : {}),
      ...(mode === 'full' && !this.orchestrator ? { nextTool: 'dynamic_context_submit', workflowId: this.entries.get(agent).runner.config.interop.workflowId } : {}) }
  }
  mount(agent, row) {
    if (this.entries.has(agent)) return this.entries.get(agent).runner
    this.exact(agent)
    const key = digest({ id: agent.session.id, createdAt: agent.session.header.createdAt, cwd: agent.session.header.cwd })
    const base = withPreferences(this.template.config, row.preferences), projectRoot = fs.realpathSync(agent.session.header.cwd)
    const config = { ...base, projectRoot, storageRoot: base.storageRoot ?? base.projectRoot,
      directory: path.join(base.directory, 'workflows', key), interop: { enabled: true, workflowId: `workflow_${key.slice(0, 40)}` },
      ...(base.revision ? { revision: { ...base.revision, policy: row.policy } } : {}),
      ...(base.direct?.runtime ? { direct: { ...base.direct, runtime: { ...base.direct.runtime, cwd: '.' } } } : {}) }
    const runner = this.createRunner(config); runner.controller = agent; runner.interaction = this
    const workflow = connectTaskGraph(this.ctx, runner)
    const tools = registerControlTools(agent.ctx, runner, { submit: (proposal, exec) => this.submit(runner, proposal, exec) })
    this.entries.set(agent, { runner, workflow, tools }); runner.output.bindConversation(runner); return runner
  }
  async submit(runner, proposal, exec) {
    const agent = exec.agent; runner.assertController(agent)
    const presence = runner.graphPresence()
    if (presence.recoveryRequired) return { status: 'ERROR', code: 'GRAPH_RECOVERY_REQUIRED', graphPresence: presence, nextTool: 'dynamic_context_recover_graphs' }
    if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) reject('DYNAMIC_CONTEXT_INVALID_GRAPH_PROPOSAL')
    const task = proposal.taskGraph != null, context = proposal.contextGraph != null
    if ((!task || !context) && presence.previouslyCommitted) return { status: 'ERROR', code: 'PARTIAL_UPDATE_REQUIRES_REVISION',
      instruction: 'Both graphs were previously committed. An incomplete replacement proposal cannot discard either graph. Use the revision workflow.' }
    if (!task && context) {
      const mode = await this.ask(agent, '上下文图缺少前置任务图，无法执行。是否回退到原生状态？', [
        { mode: 'native', label: '回退到原生状态', description: '保留现有记录，停止本次动态上下文规划。' },
        { mode: 'keep', label: '不回退，补齐任务图', description: '保持当前模式，修正并重新提交完整双图。' },
      ], exec.signal)
      if (mode === 'native') await this.set(agent, 'native', { source: 'orphan-context-fallback-human-question' }, exec.signal)
      return { status: 'ERROR', code: 'CONTEXT_GRAPH_REQUIRES_TASK_GRAPH', fallback: mode ?? 'AWAITING_EXPLICIT_CHOICE' }
    }
    if (task && !context) {
      normalizePlan(proposal.taskGraph, { enableSwitch: this.template.taskGraph.host.enableSwitch })
      await this.set(agent, 'task-graph', { source: 'task-graph-without-context' }, exec.signal)
      const existing = this.classic(agent)
      return { status: 'TASK_GRAPH_ONLY', mode: 'task-graph', committed: false,
        nextTool: existing ? 'transaction_graph_read' : 'transaction_graph_create',
        arguments: existing ? {} : { expectedRevision: 0, definition: proposal.taskGraph },
        instruction: 'Use the original task-graph tool to commit at its real tool-result boundary. No context was invented and no joint graph was committed.' }
    }
    if (!task) reject('DYNAMIC_CONTEXT_TASK_GRAPH_REQUIRED')
    const state = runner.submit(proposal, { sourceAgent: agent })
    if (!await this.ctx.sessions.flush(agent.session)) reject('DYNAMIC_CONTEXT_GRAPH_RECEIPT_NOT_DURABLE')
    const status = runner.status()
    return { revision: state.revision, contextVersion: state.contexts.version, status, ...this.readyLeafCall(status, this.planOnly(agent)) }
  }
  async close() {
    this.closed = true
    for (const agent of [...this.entries.keys()]) await this.release(agent)
    for (const dispose of this.filters.values()) dispose()
    this.filters.clear()
  }
  async recover(runner, exec) {
    runner.assertController(exec.agent)
    const plan = runner.graphPresence()
    if (!plan.recoveryRequired) return { status: plan.state, changed: false }
    if (!plan.canRestore) {
      await this.ask(exec.agent, '记录表明图曾存在，但当前没有可验证的完整恢复副本。暂停本流程，保留现场以核对原始记录？', [
        { mode: 'keep', label: '保留现场并核查（推荐）', description: '不新建图、不降级、不重放执行。' },
        { mode: 'wait', label: '等待提供恢复副本', description: '保持恢复状态，等待宿主核对可信资料。' },
      ], exec.signal)
      return { status: 'RECOVERY_REQUIRED', changed: false, plan }
    }
    const answer = await this.ask(exec.agent, `图曾经成功提交，现在缺失或损坏。是否恢复已核验的第 ${plan.restoreRevision} 版完整快照？恢复会保留活动尝试，不自动重新执行。`, [
      { mode: 'restore', label: '恢复已核验快照（推荐）', description: '原样恢复两张图、进度、报告和活动尝试。' },
      { mode: 'wait', label: '暂停并保留现场', description: '不恢复、不重新建图、不自动降级。' },
    ], exec.signal)
    if (answer !== 'restore') return { status: 'RECOVERY_REQUIRED', changed: false, plan }
    return runner.restoreGraphs({ sourceAgent: exec.agent, expectedWitnessChecksum: plan.expectedWitnessChecksum, signal: exec.signal })
  }
}
