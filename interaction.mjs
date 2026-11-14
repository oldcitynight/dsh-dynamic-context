// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import { digest, normalizePlan } from 'dsh-bettertaskgraphs/core'
import { connectTaskGraph } from './interop.mjs'
import { registerControlTools } from './control-tools.mjs'
import { REVISION_CONTEXTS } from './revision.mjs'
import { GRAPH_COMMIT_RECORD } from './graph-presence.mjs'

export const MODE_RECORD = 'plugin:dsh-dynamic-context/mode-v1'
export const MODE_OPTIONS = Object.freeze([
  { mode: 'full', label: '启用完整任务图功能（推荐）', description: '规划任务图和上下文图，按叶装配上下文并执行联动监督。' },
  { mode: 'task-graph', label: '启用任务图但不启用动态上下文', description: '使用独立任务图的原有工具和执行方式。' },
  { mode: 'native', label: '不启用任务图', description: '使用原生对话和执行流程。' },
])
const CLASSIC_TOOLS = ['transaction_graph_read', 'transaction_graph_create', 'transaction_graph_begin', 'transaction_graph_finish', 'transaction_graph_skip']
const reject = code => { const error = new Error(code); error.code = code; throw error }
const textOf = message => (message.content ?? []).filter(row => row.type === 'text').map(row => row.text).join('\n')
export const INITIAL_GUIDANCE = `任务图与动态上下文使用指引：先判断当前任务是否为项目级工作，是否存在多步依赖、长期推进或跨阶段保持注意力的需要，以及用户是否明确指定使用任务图或上下文图。普通短任务可直接按原生方式处理，不必为了调用插件扩大任务。
对于初步判断为项目级且用户尚未选择模式的任务，先调用 dynamic_context_select_mode 向用户询问，提供三个选项：不启用任务图；启用任务图但不启用动态上下文；启用完整任务图功能（推荐）。推荐不是授权，未回答不能按推荐项开始。用户已有明确选择时尊重选择，不反复询问；可提供原始用户消息 ID 与原文作为明确选择的依据，工具会核对。
纯任务图使用 transaction_graph_* 原有工具；完整模式先联合规划任务图与上下文图，使用 dynamic_context_submit，再按已提交的叶和上下文推进。先用 dynamic_context_graph_status 区分从未创建与已提交后丢失：原本只有任务图时按纯任务图工作，不凭空补上下文；首次提案只有上下文图时报告错误，并询问是否回退原生流程。已提交的任何图后来缺失或损坏必须暂停推进，进入恢复流程，不能按“从未创建”处理、重新建图或自动降级；恢复原样保留进度和活动尝试，不自动重放工具。上下文图不能脱离任务图执行。全局提示只说明使用规则，不携带任何项目的目标、工作成果或上下文内容。`

/** Extension-owned interaction and ownership; the base supplies generic ports. */
export class SessionInteraction {
  constructor(ctx, template, createRunner) {
    this.ctx = ctx; this.template = template; this.createRunner = createRunner
    this.entries = new Map(); this.filters = new Map(); this.pending = new Set(); this.closed = false
  }
  record(agent) {
    return agent?.session.snapshotEvents().findLast(event => event.type === MODE_RECORD
      && event.ignorable === true && event.data.sessionId === agent.session.id)?.data
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
  isController(agent) {
    const registry = this.ctx.agents
    if (!agent || !registry.roots().includes(agent)) return false
    const { header } = agent.session
    // Fork lineage alone does not make a normal chat a delegated child.
    if (header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0) return false
    return !agent.session.snapshotEvents(agent.session.inheritedEventCount).some(event => event.ignorable === true
      && event.type === 'plugin:dynamic-context/execution-host-v1')
  }
  exact(agent) {
    this.template.assertBase()
    if (this.closed || !this.isController(agent)) reject('DYNAMIC_CONTEXT_ROOT_CONTROLLER_REQUIRED')
  }
  install() {
    const ctx = this.ctx
    ctx.effect(() => this.template.taskGraph.registerSessionPolicy({ id: 'dynamic-context', allowClassic: agent => this.mode(agent) === 'task-graph' }))
    ctx.systemPrompt.section({ name: 'dynamic-context:initial-guidance', order: 45,
      text: ({ agent }) => this.isController(agent) ? INITIAL_GUIDANCE : '' })
    ctx.systemPrompt.context({ name: 'dynamic-context:session-mode', order: 47, interpolate: false,
      text: ({ agent }) => {
        if (!this.isController(agent)) return ''
        const mode = this.mode(agent), entry = this.entries.get(agent)
        const state = { mode, selected: Boolean(this.record(agent)), taskGraphPresent: Boolean(this.classic(agent)), baseGraphPresence: this.basePresence(agent) }
        if (mode !== 'full' || !entry) return JSON.stringify(state)
        const runner = entry.runner
        return JSON.stringify({ ...state, workflowId: runner.config.interop.workflowId, status: runner.status() })
          + (runner.config.revision ? '\n' + REVISION_CONTEXTS.trigger + '\n' + JSON.stringify({ policy: runner.config.revision.policy }) : '')
          + (runner.config.supervision ? '\n每个叶绑定 completion。执行后提交成果报告，监督受理与计划倒查由联动流程串行执行；按 status 的 legalNext 继续。' : '')
      } })
    ctx.tools.register(defineTool({ name: 'dynamic_context_select_mode',
      description: 'Ask the user to choose native, standalone task graph, or full task/context graphs. An existing explicit user choice may be bound using its exact userMessageId and quote; model claims alone cannot approve a mode. Repeated calls return the existing choice unless reconsider=true.',
      parameters: { reason: { type: 'string', required: true }, reconsider: { type: 'boolean' },
        explicit: { type: 'object', properties: { mode: { type: 'string', required: true, enum: ['native', 'task-graph', 'full'] },
          userMessageId: { type: 'string', required: true }, quote: { type: 'string', required: true } }, additionalProperties: false } },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: (args, exec) => this.select(exec.agent, args, exec.signal),
    }), { when: ({ agent }) => this.isController(agent) })
    ctx.tools.register(defineTool({ name: 'dynamic_context_graph_status',
      description: 'Distinguish graphs never created from a previously committed graph that is missing or invalid. Recovery-required workflows cannot be downgraded or recreated.',
      parameters: {}, projectPlanCapability: 'read_or_protocol',
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: (_args, exec) => { this.exact(exec.agent); return { mode: this.mode(exec.agent), base: this.basePresence(exec.agent),
        linked: this.linkedPresence(exec.agent),
        instruction: 'Missing historical graphs require restoration of verified state. Do not start a new graph or infer that previous work never happened.' } },
    }), { when: ({ agent }) => this.isController(agent) })
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
    this.filters.get(agent)?.(); this.filters.delete(agent)
    if (this.mode(agent) !== 'task-graph') {
      const deny = CLASSIC_TOOLS.filter(name => this.ctx.tools.get(name) !== undefined)
      if (deny.length) this.filters.set(agent, agent.ctx.tools.restrict({ deny }))
    }
  }
  async release(agent) {
    this.filters.get(agent)?.(); this.filters.delete(agent)
    const entry = this.entries.get(agent)
    if (!entry) return
    this.entries.delete(agent); entry.tools(); entry.workflow(); await entry.runner.close()
  }
  ensureIdle(agent) {
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
  async ask(agent, question, options, signal) {
    const questions = this.ctx.get('userQuestions')
    if (!questions) reject('DYNAMIC_CONTEXT_USER_QUESTION_SERVICE_REQUIRED')
    const id = 'dynamic-context-mode'
    const answer = await questions.ask({ agent, signal, questions: [{ id, header: '任务执行方式', question,
      options: options.map(({ label, description }) => ({ label, description })), multiSelect: false }] })
    signal?.throwIfAborted(); this.exact(agent)
    const row = answer.answers?.find(item => item.id === id)
    if (!row || row.selected?.length !== 1 || row.custom?.trim()) return null
    return options.find(option => option.label === row.selected[0])?.mode ?? null
  }
  policy(agent) {
    const messages = agent.session.deriveMessages().filter(row => row.role === 'user' && row.source?.kind === 'user')
    if (!messages.length) reject('DYNAMIC_CONTEXT_USER_TASK_CONTRACT_REQUIRED')
    return { objective: '完成本会话用户授权的任务，保持原始约束与验收标准。',
      requirements: messages.map((row, i) => ({ id: `user_${i}`, text: textOf(row) || '[用户消息含非文本内容；必须回看原消息，不能自行推断或放宽约束。]' })) }
  }
  async select(agent, { reason, explicit, reconsider = false }, signal) {
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
      const mode = direct ?? await this.ask(agent, `当前任务判断为需要选择执行方式：${reason}\n是否规划任务图？`, MODE_OPTIONS, signal)
      if (!mode) return { status: 'NEEDS_USER_CHOICE', mode: this.mode(agent), changed: false }
      return await this.set(agent, mode, { source: direct ? 'explicit-user-message' : 'human-question',
        ...(direct ? { userMessageId: explicit.userMessageId, quote: explicit.quote } : {}) }, signal)
    } finally { this.pending.delete(agent) }
  }
  async set(agent, mode, evidence, signal) {
    this.exact(agent); signal?.throwIfAborted(); this.ensureIdle(agent)
    if (mode !== 'native' && !this.template.taskGraph.host.inProject(agent.session)) reject('DYNAMIC_CONTEXT_TASK_GRAPH_PROJECT_UNAVAILABLE')
    const taskOnly = mode === 'full' && Boolean(this.classic(agent))
    if (taskOnly) mode = 'task-graph'
    const row = { version: 1, sessionId: agent.session.id, mode, evidence,
      ...(mode === 'full' && this.template.config.revision ? { policy: this.policy(agent) } : {}) }
    await this.release(agent)
    appendPluginRecord(agent.session, MODE_RECORD, row)
    if (!await this.ctx.sessions.flush(agent.session)) reject('DYNAMIC_CONTEXT_MODE_NOT_DURABLE')
    signal?.throwIfAborted(); this.exact(agent)
    if (mode === 'full') await this.mount(agent, row)
    this.refresh(agent)
    return { mode, ...(taskOnly ? { reason: 'EXISTING_TASK_GRAPH_WITHOUT_CONTEXT', instruction: 'An existing task graph has no context graph. Continue with original task-graph tools; do not fabricate contexts or replace its progress.' } : {}), ...(mode === 'task-graph' ? { nextTool: 'transaction_graph_read' } : {}),
      ...(mode === 'full' ? { nextTool: 'dynamic_context_submit', workflowId: this.entries.get(agent).runner.config.interop.workflowId } : {}) }
  }
  mount(agent, row) {
    if (this.entries.has(agent)) return this.entries.get(agent).runner
    this.exact(agent)
    const key = digest({ id: agent.session.id, createdAt: agent.session.header.createdAt, cwd: agent.session.header.cwd })
    const base = this.template.config, projectRoot = fs.realpathSync(agent.session.header.cwd)
    const config = { ...base, projectRoot, storageRoot: base.storageRoot ?? base.projectRoot,
      directory: path.join(base.directory, 'workflows', key), interop: { enabled: true, workflowId: `workflow_${key.slice(0, 40)}` },
      ...(base.revision ? { revision: { ...base.revision, policy: row.policy } } : {}),
      ...(base.direct?.runtime ? { direct: { ...base.direct, runtime: { ...base.direct.runtime, cwd: '.' } } } : {}) }
    const runner = this.createRunner(config); runner.controller = agent; runner.interaction = this
    const workflow = connectTaskGraph(this.ctx, runner)
    const tools = registerControlTools(agent.ctx, runner, { submit: (proposal, exec) => this.submit(runner, proposal, exec) })
    this.entries.set(agent, { runner, workflow, tools }); return runner
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
    return { revision: state.revision, contextVersion: state.contexts.version, status: runner.status() }
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
