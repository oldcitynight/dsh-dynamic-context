import { withPreferences } from './settings.mjs'
// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs'
import path from 'node:path'
import { defineTool as nativeDefineTool } from '@deepseek-ai/dsh-tools'
import { checkedTool, located } from 'dsh-better-task-grapth/validation'
const defineTool = options => checkedTool(nativeDefineTool, options)
import { scopeParentOf } from '@deepseek-ai/dsh-scope'
import { appendPluginRecord } from './native-records.mjs'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { digest, normalizePlan } from 'dsh-better-task-grapth/core'
import { connectTaskGraph } from './interop.mjs'
import { ruleSummary } from './rule-editor.mjs'
import { registerControlTools } from './control-tools.mjs'
import { REVISION_CONTEXTS } from './revision.mjs'
import { GRAPH_COMMIT_RECORD } from './graph-presence.mjs'
import { jsonExample } from './format-examples.mjs'
import { ROOT_SETUP } from './unit-baseline.mjs'
import { WorkflowOrchestrator, MANAGED_GUIDANCE } from './orchestration.mjs'
import { boundedSnapshot } from './context-budget.mjs'
import { assertPreloadBudget, rolePrompt, roleTools, roleScope } from './role-policy.mjs'
import { applyNativeRoute, followNativeCompaction, nativeRoleModel, nativeRouteFields } from './role-models.mjs'
import { operationRules } from './policy-selectors.mjs'

export const ROUTE_RECORD = 'plugin:dsh-dynamic-context/route-v1'
const CONTROLLER_MODEL = 'plugin:dsh-dynamic-context/controller-model-v1'
const ENTRY_TOOLS = new Set(['dynamic_context_graph_status', 'ask_user_question', 'get_goal', 'present', 'exit_plan_mode', 'read_image'])
const MANAGED_TOOLS = new Set([...ENTRY_TOOLS, 'dynamic_context_workflow', 'dynamic_context_status', 'dynamic_context_recover_graphs', 'dynamic_context_reconcile', 'dynamic_context_maintenance'])
// Keep the registered IDs identifiable to hosts reading historical calls.
const DISABLED_ENTRY_TOOLS = new Set(['dynamic_context_route_task', 'dynamic_context_select_mode'])
const DISABLED_ENTRY_CODE = 'DYNAMIC_CONTEXT_COMMAND_REQUIRED'
const DISABLED_ENTRY_NOTICE = '旧启动工具开发中暂不可用。用户可输入 /task-graph 选择任务图模式。'
function rejectDisabledEntry() {
  throw located(DISABLED_ENTRY_CODE, { reason: DISABLED_ENTRY_NOTICE })
}
export const MODE_RECORD = 'plugin:dsh-dynamic-context/mode-v1'
export const MODE_OPTIONS = Object.freeze([
  { mode: 'full', label: '启用完整任务图功能（推荐）', description: '建立根单元和上下文，由路由者选择直接执行或递归规划子图。' },
  { mode: 'task-graph', label: '启用任务图但不启用动态上下文', description: '使用独立任务图的原有工具和执行方式。' },
  { mode: 'native', label: '不启用任务图', description: '使用原生对话和执行流程。' },
])
const CLASSIC_TOOLS = ['transaction_graph_read', 'transaction_graph_create', 'transaction_graph_begin', 'transaction_graph_finish', 'transaction_graph_skip']
const CONTROLLER_TOOLS = new Set([
  'dynamic_context_graph_status',
  'read', 'read_image', 'glob', 'grep', 'web_search', 'web_fetch', 'skill',
  'ask_user_question', 'exit_plan_mode', 'get_goal', 'present',
])
const ADVANCE_TOOLS = new Set(['dynamic_context_run_next', 'dynamic_context_resume',
  'dynamic_context_continue_supervision', 'dynamic_context_revise'])
const PLAN_MODE_DENIAL = 'DYNAMIC_CONTEXT_PLAN_MODE_ACTIVE: use exit_plan_mode or wait for the user to leave plan mode before advancing a leaf or supervision.'
const reject = code => { const error = new Error(code); error.code = code; throw error }
const textOf = message => (message.content ?? []).filter(row => row.type === 'text').map(row => row.text).join('\n')
export const INITIAL_GUIDANCE = `任务图与动态上下文使用指引
本版本只通过用户实际输入 /task-graph [任务说明] 启用任务图。默认直接进入完整单元流程。若宿主配置了询问模式，使用程序给出的三个选项。旧的模式选择和路线登记工具开发中暂不可用。模型不判断任务规模来启动插件，不自行询问执行模式，也不能代替用户发送指令。
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
    this.controllerPolicies = new WeakMap()
    this.plannerModels = new WeakMap()
    this.controllerModels = new WeakMap()
    this.controllerSteps = new WeakMap()
    this.entries = new Map(); this.filters = new Map(); this.pending = new Set(); this.closed = false
    this.basicConditionsGuidance = BASIC_CONDITIONS_GUIDANCE
    this.lifecycle = new WorkflowOrchestrator(this)
    this.orchestrator = template.config.interaction.orchestration ? this.lifecycle : null
  }
  record(agent) {
    return agent && this.template.taskGraph.sessionRecords.read(agent.session).findLast(({ event }) => event.type === MODE_RECORD
      && event.data.sessionId === agent.session.id)?.event.data
  }
  isController(agent) {
    return Boolean(agent && this.ctx.agents.roots().includes(agent)
      && !agent.session.snapshotEvents().some(row => row.ignorable && row.type === 'plugin:dynamic-context/execution-host-v1'))
  }
  route(agent) {
    return agent.session.snapshotEvents().findLast(row => row.ignorable && row.type === ROUTE_RECORD
      && row.data.sessionId === agent.session.id)?.data
  }
  controllerSnapshot(agent, data) {
    const runner = this.entries.get(agent)?.runner
    if (!runner) return data
    const view = boundedSnapshot(runner, 'controller', data, 'dynamic_context_status')
    if (view.materialSummary && !this.controllerPolicy(agent)?.allowed.includes('dynamic_context_status')) reject('CONTROLLER_MATERIAL_READER_REQUIRED')
    return view
  }
  controllerPrompt(agent, text, slot = 'role') {
    const runner = this.entries.get(agent)?.runner ?? this.template
    const snapshot = rolePrompt(runner, 'controller', text, { sessionId: agent.session.id }, slot)
    const slots = this.controllerPromptSlots ??= new WeakMap()
    const current = slots.get(agent) ?? {}
    current[slot] = snapshot; slots.set(agent, current)
    assertPreloadBudget(...Object.values(current))
    return snapshot.content
  }
  controllerPolicy(agent) {
    if (!this.isController(agent) || this.mode(agent) !== 'full') return null
    const entry = this.entries.get(agent), runner = entry?.runner ?? this.template
    const scope = { ...roleScope(runner), sessionId: agent.session.id }
    const registry = roleTools(runner), parent = scopeParentOf(agent)
    const extra = registry.extensions('controller', scope, runner.config.projectRoot).map(row => row.toolId)
    const linked = registry.linkedIds('controller', scope).filter(id => this.ctx.tools.get(id, parent) || this.ctx.tools.get(id, agent))
    const candidates = this.orchestrator ? [...MANAGED_TOOLS].filter(name => name !== 'present')
      : [...CONTROLLER_TOOLS, ...(entry?.tools.names ?? [])]
    return registry.select('controller', [...candidates, ...extra, ...linked], scope, runner.config.projectRoot)
  }
  controllerRequest(agent, offered) {
    if (!this.isController(agent)) return offered
    const full = this.mode(agent) === 'full'
    const prior = agent.session.snapshotEvents().findLast(row => row.ignorable && row.type === CONTROLLER_MODEL)?.data
    if (!full && !prior?.selected) return offered
    // DSH seeds later requests from the last admitted header. Recover the
    // upstream route before resolving a replacement or removing an override.
    const inherited = prior?.selected && offered.provider === prior.selected.provider && offered.model === prior.selected.model
      ? applyNativeRoute(offered, prior.fallback) : offered
    const runner = this.entries.get(agent)?.runner ?? this.template
    const choice = full && runner.roleModels.resolve('controller', { ...roleScope(runner), sessionId: agent.session.id })
    const selected = nativeRoleModel(inherited, choice)
    if (full) this.controllerModels.set(agent, nativeRouteFields(selected))
    else this.controllerModels.delete(agent)
    const changed = selected.provider !== inherited.provider || selected.model !== inherited.model
    const marker = changed ? { selected: nativeRouteFields(selected), fallback: nativeRouteFields(inherited) } : { selected: null }
    if ((changed || prior?.selected) && digest(marker) !== digest(prior ?? null)) appendPluginRecord(agent.session, CONTROLLER_MODEL, marker)
    return selected
  }
  allowedNames(agent) {
    const policy = this.controllerPolicy(agent)
    return policy ? new Set(policy.allowed) : null
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
    let events
    try { events = this.template.taskGraph.sessionRecords.read(agent.session).map(({ event }) => event) }
    catch (error) { return { state: 'SESSION_PLUGIN_RECORDS_UNAVAILABLE', previouslyCommitted: null, code: error.code ?? error.name } }
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
    ctx.on('agent/pre-step', async ({ agent, turn, step, signal }, next) => {
      if (!this.entries.has(agent)) return next()
      const position = { turn, step, signal, preparing: true }
      this.controllerSteps.set(agent, position)
      try { return await next() } finally { position.preparing = false }
    }, { prepend: true })
    ctx.on('agent/request', async ({ agent, turn, step }, next) => {
      const offered = await next(), position = this.controllerSteps.get(agent)
      if (position?.pinned && this.entries.has(agent) && position.turn === turn && position.step === step)
        return applyNativeRoute(offered, position.pinned)
      return this.controllerRequest(agent, offered)
    }, { prepend: true })
    const interaction = this
    ctx.on('llm/stream', async function* (request, next) {
      if (request.purpose === 'compaction' && request.sessionId) {
        const agent = ctx.agents.get(request.sessionId)
        let route = agent && interaction.plannerModels.get(agent)
        if (!route && interaction.isController(agent) && interaction.mode(agent) === 'full') {
          const position = interaction.controllerSteps.get(agent)
          if (position?.preparing && !position.pinned) {
            // Automatic DSH compaction can run before the ordinary request
            // waterfall. Resolve this step's route once for both calls.
            const { config, preparedCall } = await agent.prepareRequest(position.turn, position.step, position.signal)
            position.pinned = nativeRouteFields(config)
            if (preparedCall?.adapterDefaults?.reasoningEffort) delete position.pinned.reasoningEffort
          }
          route = position?.pinned ?? interaction.controllerModels.get(agent)
            ?? interaction.controllerRequest(agent, agent.session.requestHeader()?.config ?? agent.options)
        }
        followNativeCompaction(request, route)
      }
      yield* next()
    }, { prepend: true })
    // DSH collects schemas before its assemble and pre-step hooks. Update the
    // inherited native mask when a controller policy changes so the next
    // request receives exactly the currently permitted native IDs.
    ctx.effect(() => roleTools(this.template).onPolicyChange(role => {
      if (role === 'controller') for (const agent of this.entries.keys()) this.refresh(agent)
    }))
    ctx.effect(() => this.template.taskGraph.registerSessionPolicy({ id: 'dynamic-context',
      allowClassic: agent => this.mode(agent) === 'task-graph', onRequestGraph: invocation => this.requestGraph(invocation) }))
    ctx.tools.guard(exec => this.guardController(exec))
    // Native restrict() only applies to inherited registrations. Filter the
    // assembled schemas too, using the exact same rule as dispatch admission.
    ctx.on('system-prompt/assemble', async (_assembly, { agent }, next) => {
      if (agent && this.isController(agent) && this.mode(agent) === 'full') this.syncControllerTools(agent)
      const result = await next(), policy = agent && this.controllerPolicy(agent)
      if (policy) this.controllerPolicies.set(agent, policy)
      const allow = policy && new Set(policy.allowed)
      return { ...result, tools: result.tools.filter(row => !DISABLED_ENTRY_TOOLS.has(row.name)
        && (!allow || allow.has(row.name))
        && (row.name !== 'dynamic_context_workflow' || agent && this.mode(agent) === 'full')) }
    })
    this.lifecycle.installControllerErrors()
    this.orchestrator?.install()
    if (this.orchestrator) ctx.tools.register(defineTool({ name: 'dynamic_context_route_task', projectPlanCapability: 'read_or_protocol',
      description: DISABLED_ENTRY_NOTICE,
      parameters: { route: { type: 'string', required: true, enum: ['native', 'project'] }, reason: { type: 'string', required: true } },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: rejectDisabledEntry,
    }))
    ctx.systemPrompt.section({ name: 'dynamic-context:initial-guidance', order: 45,
      text: ({ agent }) => !this.isController(agent) ? '' : this.controllerPrompt(agent, this.orchestrator ? INITIAL_GUIDANCE
        : INITIAL_GUIDANCE.replace('完整模式由独立预规划角色探查和提交双图，程序交接并串行调度，绑定上下文的独立叶执行者开展正式工作。', '当前是手动控制器兼容模式：主会话提交双图并调用 dynamic_context_run_next，独立叶执行者开展正式工作。'), 'entry') })
    ctx.systemPrompt.context({ name: 'dynamic-context:session-mode', order: 47, interpolate: false,
      text: ({ agent }) => {
        if (!agent || !this.isController(agent)) return ''
        const mode = this.mode(agent), entry = this.entries.get(agent)
        const state = { mode, selected: mode === 'recovery' ? null : Boolean(this.record(agent)), activation: 'human-command',
          standaloneGraphPresence: this.basePresence(agent), route: this.route(agent)?.route ?? null }
        if (mode !== 'full' || !entry) return JSON.stringify(state)
          + (mode === 'native' && !state.selected && !state.route ? '\n' + this.controllerPrompt(agent, UNSELECTED_GUIDANCE) : '')
        const runner = entry.runner
        const operations = operationRules(this.controllerPolicy(agent))
        if (operations.length) state.roleToolOperations = operations
        const status = runner.status(), planOnly = this.planOnly(agent)
        if (this.orchestrator) return JSON.stringify(this.controllerSnapshot(agent, { ...state, role: 'controller', workflowId: runner.workflowId,
          lifecycle: this.orchestrator.status(agent), status, planOnly })) + '\n' + this.controllerPrompt(agent, MANAGED_GUIDANCE)
        return JSON.stringify(this.controllerSnapshot(agent, { ...state, role: 'controller', workflowId: runner.config.interop.workflowId, status,
          planOnly, ...this.readyLeafCall(status, planOnly) }))
          + '\n' + this.controllerPrompt(agent, CONTROLLER_GUIDANCE
          + (status.graphPresence.state === 'NEVER_CREATED' ? '\n' + (runner.unitWorkflowVersion === 2 ? ROOT_SETUP : PLANNING_GUIDANCE) : '')
          + (runner.config.revision ? '\n' + REVISION_CONTEXTS.trigger : '')
          + (runner.config.supervision ? '\n每个叶绑定 completion。叶执行者提交成果报告，监督与计划倒查由联动流程串行执行。有待办监督检查点时按状态调用 dynamic_context_continue_supervision。' : ''))
          + (runner.config.revision ? '\n' + JSON.stringify({ policy: runner.config.revision.policy }) : '')
      } })
    ctx.tools.register(defineTool({ name: 'dynamic_context_select_mode',
      description: DISABLED_ENTRY_NOTICE,
      parameters: { reason: { type: 'string', required: true }, reconsider: { type: 'boolean' },
        explicit: { type: 'object', properties: { mode: { type: 'string', required: true, enum: ['native', 'task-graph', 'full'] },
          userMessageId: { type: 'string', required: true }, quote: { type: 'string', required: true } }, additionalProperties: false } },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: rejectDisabledEntry,
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
    const registry = roleTools(runner), metadata = registry.list()
    const inherited = registry.linkedIds('controller', scope).filter(id => this.ctx.tools.get(id, scopeParentOf(agent)))
    const key = digest([metadata, scope, inherited])
    if (previous?.key === key) return
    previous?.disposers.forEach(dispose => dispose())
    const disposers = []
    for (const tool of roleTools(runner).nativeDefinitions('controller', scope, { runner, sourceAgent: agent })) {
      if (this.ctx.tools.get(tool.name, agent)) reject('ROLE_TOOL_SHADOW_FORBIDDEN')
      disposers.push(agent.ctx.tools.register({ ...tool, projectPlanCapability: 'read_or_protocol' }))
    }
    this.roleExtensions.set(agent, { key, disposers })
  }
  guardController({ agent, name, arguments: args }) {
    if (DISABLED_ENTRY_TOOLS.has(name)) return DISABLED_ENTRY_CODE + ': ' + DISABLED_ENTRY_NOTICE
    if (!agent) return
    const allow = this.allowedNames(agent)
    if (allow && !allow.has(name)) return this.mode(agent) === 'full'
      ? `DYNAMIC_CONTEXT_CONTROLLER_TOOL_NOT_ALLOWED: ${name}. The program owns planning and dispatch; use dynamic_context_workflow and inspect lifecycle.`
      : `DYNAMIC_CONTEXT_ROUTE_REQUIRED: ${name}. The user can select the task graph mode with /task-graph.`
    if (allow) {
      if (this.lifecycle.nativeToolBlocks.has(agent) || this.lifecycle.record(agent)?.toolErrorBlock) return 'DIRECT_TOOL_ERROR_BLOCKED'
      const runner = this.entries.get(agent)?.runner ?? this.template
      const policy = this.controllerPolicies.get(agent) ?? this.controllerPolicy(agent)
      if (!roleTools(runner).admits(policy, name, args, runner.config.projectRoot)) return 'ROLE_TOOL_DENIED'
    }
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
    this.controllerSteps.delete(agent)
    this.controllerModels.delete(agent)
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
    const message = createUserMessage({ source: rawInput.trim() ? { kind: 'user' }
      : { kind: 'dynamic-context', form: 'notice', summary: '主动任务图入口' },
      content: [{ type: 'text', text: rawInput.trim() || '任务图模式选择已核验。沿用当前真实任务；尚无任务内容时先询问。' }] })
    if (result.mode === 'full' && this.record(agent)?.unitWorkflowVersion === 2) {
      const hasSystem = agent.session.deriveMessages().some(row => row.role === 'system' && row.source?.kind === 'system-prompt')
      appendPluginRecord(agent.session, 'plugin:dynamic-context/command-delivery-v2', {
        commandId, messageId: message.id, contentHash: digest(message.content), hasSystem,
      })
    }
    agent.steer(message)
    return { kind: 'success', text: `已选择${MODE_OPTIONS.find(row => row.mode === result.mode).label}，要求已交给当前 Agent。` }
  }
  async select(agent, { reason, explicit, reconsider = false }, signal, commandEvidence = {}) {
    this.exact(agent); signal?.throwIfAborted()
    if (typeof reason !== 'string' || !reason.trim()) reject('DYNAMIC_CONTEXT_MODE_REASON_REQUIRED')
    if (this.pending.has(agent)) reject('DYNAMIC_CONTEXT_MODE_QUESTION_PENDING')
    const baseGraphPresence = this.basePresence(agent)
    if (!['PRESENT', 'CREATION_PENDING', 'NEVER_CREATED', 'OUTSIDE_SCOPE'].includes(baseGraphPresence.state))
      return { status: 'RECOVERY_REQUIRED', mode: 'recovery', baseGraphPresence, changed: false }
    const prior = this.record(agent)
    const graphPresence = this.entries.get(agent)?.runner.graphPresence()
    if (graphPresence?.recoveryRequired) return { status: 'RECOVERY_REQUIRED', mode: 'full', graphPresence, changed: false, nextTool: 'dynamic_context_recover_graphs' }
    if (prior && !reconsider) {
      if (prior.mode === 'full') this.mount(agent, prior).admitWorkflowRelease()
      if (prior.mode === 'task-graph') this.template.taskGraph.host.journal(agent.session, { start: true })
      return { mode: prior.mode, alreadySelected: true }
    }
    this.ensureIdle(agent); this.pending.add(agent)
    try {
      const direct = this.explicit(agent, explicit)
      const commandMode = commandEvidence.commandId && (this.template.config.interaction.commandMode ?? 'full')
      const configured = commandMode && commandMode !== 'ask' ? commandMode : null
      const mode = direct ?? configured ?? await this.ask(agent, `请选择本会话的工作模式。${commandEvidence.commandId ? '你已通过 /task-graph 打开此选项。' : reason}`, MODE_OPTIONS, signal)
      if (!mode) return { status: 'NEEDS_USER_CHOICE', mode: this.mode(agent), changed: false }
      return await this.set(agent, mode, { source: direct ? 'explicit-user-message' : configured ? 'human-command' : 'human-question',
        ...commandEvidence, ...(direct ? { userMessageId: explicit.userMessageId, quote: explicit.quote } : {}) }, signal)
    } finally { this.pending.delete(agent) }
  }
  async set(agent, mode, evidence, signal) {
    this.exact(agent); signal?.throwIfAborted(); this.ensureIdle(agent)
    if (mode !== 'native' && !this.template.taskGraph.host.inProject(agent.session)) reject('DYNAMIC_CONTEXT_TASK_GRAPH_PROJECT_UNAVAILABLE')
    const taskOnly = mode === 'full' && Boolean(this.classic(agent))
    if (taskOnly) mode = 'task-graph'
    const row = { version: 1, sessionId: agent.session.id, mode, evidence,
      ...(mode === 'full' ? { unitWorkflowVersion: 2, policy: this.policy(agent, evidence), preferences: this.template.preferences?.() ?? {} } : {}) }
    await this.unmount(agent)
    signal?.throwIfAborted(); this.exact(agent)
    if (mode === 'task-graph') this.template.taskGraph.host.journal(agent.session, { start: true })
    try {
      if (mode === 'full') this.mount(agent, row).admitWorkflowRelease()
      this.template.taskGraph.sessionRecords.append(agent.session, MODE_RECORD, row)
      if (!await this.ctx.sessions.flush(agent.session)) reject('DYNAMIC_CONTEXT_MODE_NOT_DURABLE')
      signal?.throwIfAborted(); this.exact(agent)
    } catch (error) {
      if (mode === 'full') await this.unmount(agent)
      throw error
    }
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
    const config = { ...base, workflowLimits: this.template.currentWorkflowLimits?.() ?? base.workflowLimits, projectRoot, storageRoot: base.storageRoot ?? base.projectRoot,
      directory: path.join(base.directory, 'workflows', key), interop: { enabled: true, workflowId: `workflow_${key.slice(0, 40)}` },
      ...(base.revision ? { revision: { ...base.revision, policy: row.policy } } : {}),
      ...(base.direct?.runtime ? { direct: { ...base.direct, runtime: { ...base.direct.runtime, cwd: '.' } } } : {}) }
    if (row.unitWorkflowVersion === 2) {
      config.supervision = true
      config.supervisionContext = 'reports'
      config.revision = { maxOutputTokens: base.maxOutputTokens, ...base.revision, policy: row.policy }
      config.direct = { ...config.direct, durable: true }
    }
    const runner = this.createRunner(config); runner.unitWorkflowVersion = 2; runner.controller = agent; runner.interaction = this
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
      normalizePlan(proposal.taskGraph, { workflowLimits: this.template.graph.workflowLimits, enableSwitch: this.template.taskGraph.host.enableSwitch })
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
    return { revision: state.revision, contextVersion: state.contexts.version, ...ruleSummary(state.graph.state.plan), status, ...this.readyLeafCall(status, this.planOnly(agent)) }
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
