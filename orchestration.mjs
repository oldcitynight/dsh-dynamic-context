import { acquireDirectLease } from './durable-store.mjs'
import { resolveGuidanceSuspension } from './suspension.mjs'
// SPDX-License-Identifier: GPL-3.0-only
import { appendPluginRecord } from './native-records.mjs'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool as nativeDefineTool } from '@deepseek-ai/dsh-tools'
import { checkedTool } from 'dsh-better-task-grapth/validation'
const defineTool = options => checkedTool(nativeDefineTool, options)
import { digest } from 'dsh-better-task-grapth/core'
import { runPreplanning, recoverPlannerReceipt } from './preplanning.mjs'
import { jsonExample } from './format-examples.mjs'
import { beginHierarchyBlockage, publishHierarchyReport } from './hierarchy-runtime.mjs'
import { blockageStatus } from './blockage-runtime.mjs'
import { UserGuidanceCoordinator } from './user-guidance.mjs'
import { readRoleRecord } from './revision-runtime.mjs'
import { toolErrorBlock } from './tool-error-policy.mjs'

export const LIFECYCLE_RECORD = 'plugin:dsh-dynamic-context/lifecycle-v1'
export const EXECUTION_OPTIONS = Object.freeze([
  { mode: 'auto_start', label: '规划完成后直接执行（推荐）', description: '双图提交后由程序串行执行；仍遵守原生 Plan 模式和操作权限。' },
  { mode: 'await_approval', label: '先展示规划，等我确认', description: '提交双图后停下，确认当前图版本后再开始执行。' },
])
export const MANAGED_GUIDANCE = `你是完整联动流程的交互控制器。独立规划器负责基础条件探查和首次双图提交；程序负责提交后的交接和串行叶调度。你负责澄清真实用户要求、展示规划/进度和说明阻断原因，不代替规划器或叶执行者开展工作，不使用原生任务清单替换任务图。
当前 lifecycle 是程序事实。afterPlanning:auto_start 表示提交后不再额外等待流程批准；await_approval 表示只在提交后请求确认当前图。原生 Plan 模式和每项操作权限独立生效，approvalPolicy:ask 不是规划后必须等待的依据。用户没有说过的“仅规划/等待批准”不得补写进任务或报告。
需要继续中断流程时调用 dynamic_context_workflow(action:continue)；WAITING_PLAN_APPROVAL 调用 action:approve 询问用户，不能自行宣布已获准。缺少首次策略时调用 action:start。NEEDS_ATTENTION 的原因、活动尝试或未决监督必须先核对。COMPLETE 仅表示任务图叶状态完成，不等于 Goal 已独立验收。`
const fail = code => { const error = new Error(code); error.code = code; throw error }
const runtimeMessage = text => createUserMessage({ source: { kind: 'dynamic-context', form: 'notice', summary: '联动流程状态' }, content: [{ type: 'text', text }] })
const holdsNativeStep = row => row?.toolErrorBlock || row?.phase === 'PAUSED' && row.pauseKind === 'normal'
  || row?.executionStarted && row.activity?.stage === 'EXECUTING' && ['NEEDS_ATTENTION', 'PAUSED', 'RECOVERY_REQUIRED'].includes(row.phase)

/** Process-local scheduling is intentional: persisted intent never starts work on reload. */
export class WorkflowOrchestrator {
  constructor(interaction) {
    this.interaction = interaction; this.ctx = interaction.ctx
    this.queued = new Set(); this.continuations = new Set(); this.running = new Map()
    this.guidance = new UserGuidanceCoordinator(this)
    this.controllerToolErrors = new WeakMap()
    this.nativeToolBlocks = new WeakMap()
  }
  record(agent) {
    return agent.session.snapshotEvents().findLast(row => row.ignorable && row.type === LIFECYCLE_RECORD
      && row.data.sessionId === agent.session.id)?.data
  }
  contractChecksum(agent) {
    const bodies = agent.session.deriveMessages().filter(row => row.role === 'user' && row.source?.kind === 'user')
      .map(row => JSON.stringify(row.content))
    const commandId = this.interaction.record(agent)?.evidence?.commandId
    const command = commandId && agent.session.snapshotEvents().find(row => row.type === 'command/run' && row.data.commandId === commandId)
    if (command?.data.args?.trim()) bodies.push(JSON.stringify([{ type: 'text', text: command.data.args.trim() }]))
    return digest([...new Set(bodies)])
  }
  status(agent) {
    const record = this.record(agent)
    return record ? { ...record, guidance: this.guidance.summary(agent), scheduled: this.queued.has(agent), running: this.running.has(agent),
      restartRequiresContinue: !this.queued.has(agent) && !this.running.has(agent)
        && ['PREPLANNING_QUEUED', 'PREPLANNING', 'PLAN_COMMITTED', 'EXECUTING', 'PAUSE_REQUESTED', 'BLOCKAGE_HANDLING', 'GUIDANCE_INTAKE', 'GUIDANCE_ROUTING', 'GUIDANCE_HANDOVER', 'PROGRESS_REPORT'].includes(record.phase) }
      : { phase: 'NOT_ADOPTED', scheduled: false, running: false }
  }
  executionView(agent) {
    const row = this.status(agent), runner = this.interaction.entries.get(agent)?.runner
    if (!runner || row.phase === 'NOT_ADOPTED') return null
    const control = this.running.get(agent)
    let state = row.running || row.scheduled ? 'running' : row.restartRequiresContinue ? 'interrupted'
      : row.phase === 'PAUSED' ? row.pauseKind === 'normal' ? 'paused' : 'interrupted' : row.phase === 'COMPLETE' ? 'complete'
        : row.phase.startsWith('WAITING_') ? 'waiting' : row.phase === 'NEEDS_ATTENTION' ? 'interrupted' : 'idle'
    if (control?.pauseRequested) state = 'pausing'
    if (row.phase === 'RECOVERY_REQUIRED' || row.toolErrorBlock) state = 'blocked'
    let blockCanResume = false
    const blockReason = row.toolErrorBlock?.rules?.map(rule => `${rule.toolId}: ${rule.reason}`).join('；')
    let reason = blockReason ? blockReason.slice(0, 512) : row.reason ? String(row.reason).slice(0, 512) : null
    try {
      if (runner.graphPresence().recoveryRequired) { state = 'blocked'; reason = 'GRAPH_RECOVERY_REQUIRED' }
      else if (row.toolErrorBlock) blockCanResume = this.canAcknowledge(agent, runner, row.toolErrorBlock, runner.checkpointStatus?.())
    } catch { state = 'blocked'; reason = 'GRAPH_STATE_UNAVAILABLE'; blockCanResume = false }
    const child = control?.planner ?? runner.current?.agent
    let activity = runner.activity ?? row.activity ?? null
    if (child && this.ctx.agents.get(child.id) === child) {
      const last = child.session.snapshotEvents().findLast(event => ['step/start', 'tool/call', 'tool/result', 'assistant/message', 'step/end'].includes(event.type))
      if (last) activity = { stage: control?.planner ? 'PREPLANNING' : 'EXECUTING',
        kind: last.type === 'step/start' ? 'model' : last.type === 'tool/call' ? 'tool' : 'result',
        sessionId: child.session.id, step: last.data.step ?? 0, tool: last.type === 'tool/call' ? last.data.name : null,
        at: new Date(last.time).toISOString() }
    }
    return { workflowId: runner.workflowId, state, phase: row.phase,
      reason,
      pauseKind: state === 'interrupted' ? 'unexpected' : row.pauseKind ?? (state === 'paused' ? 'unexpected' : null),
      canPause: state === 'running', canResume: blockCanResume || ['paused', 'interrupted', 'idle'].includes(state), activity }
  }
  pauseRequested(agent) { return Boolean(this.running.get(agent)?.pauseRequested) }
  guidancePending(agent) { return this.guidance.pending(agent).length > 0 }
  canAcknowledge(agent, runner, block, checkpoint) {
    if (!block.runId) return Boolean(checkpoint?.recoverable && (!block.id || checkpoint.toolErrorBlock?.id === block.id))
    if (block.role === 'controller') return block.runId === agent.session.id
    if (block.role === 'preplanning') return block.runId === this.record(agent)?.plannerSessionId
    const record = readRoleRecord(runner, block.runId)
    return record?.phase === 'PAUSED' && record.toolErrorBlock?.id === block.id
  }
  async fromView(agent, action, signal) {
    const view = this.executionView(agent)
    if (!view || !(action === 'pause' ? view.canPause : view.canResume)) fail('DYNAMIC_CONTEXT_CONTROL_NOT_AVAILABLE')
    await this.control(agent, action === 'resume' ? 'continue' : 'pause', signal, { humanResume: action === 'resume' })
    if (action === 'resume') agent.followup(runtimeMessage('用户点击继续。程序按已保存状态接续工作流；保留原始任务、工具记录和权限。'))
  }
  async save(agent, patch) {
    this.interaction.exact(agent)
    const runner = this.interaction.entries.get(agent)?.runner
    const row = { ...this.record(agent), version: 1, sessionId: agent.session.id,
      workflowId: runner?.workflowId, activity: this.executionView(agent)?.activity ?? null, ...patch, at: new Date().toISOString() }
    appendPluginRecord(agent.session, LIFECYCLE_RECORD, row)
    if (!await this.ctx.sessions.flush(agent.session)) fail('DYNAMIC_CONTEXT_LIFECYCLE_NOT_DURABLE')
    return row
  }
  install() {
    const ctx = this.ctx
    ctx.tools.register(defineTool({ name: 'dynamic_context_workflow', projectPlanCapability: 'read_or_protocol',
      description: 'Read or explicitly continue the program-managed workflow. start asks how to continue after planning; approve asks the user to approve the exact committed graph. continue resumes saved work: an interrupted model request may be retried; tools with missing receipts remain UNKNOWN and are never automatically replayed. pause finishes the current step and prevents further model requests, including compression and reviews. All actions preserve existing graphs and history.\n'
        + jsonExample('Read the lifecycle', { action: 'status' }) + '\n'
        + jsonExample('Continue an interrupted safe boundary', { action: 'continue' }) + '\n'
        + jsonExample('Ask for approval of the current plan', { action: 'approve' }),
      parameters: { action: { type: 'string', required: true, enum: ['status', 'start', 'approve', 'continue', 'pause'] } },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: (args, exec) => this.control(exec.agent, args.action, exec.signal),
    }))
    ctx.on('agent/pre-step', async ({ agent, signal, turn, step }, next) => {
      const decision = await next()
      if (decision.kind !== 'enter') return decision
      if (this.nativeToolBlocks.has(agent) || this.record(agent)?.toolErrorBlock) return { kind: 'reject' }
      const runner = this.interaction.entries.get(agent)?.runner
      if (runner) this.controllerToolErrors.set(agent, runner.toolErrorPolicy.snapshot())
      if (!this.queued.has(agent)) {
        if (this.interaction.isController(agent) && holdsNativeStep(this.record(agent))) return { kind: 'reject' }
        return decision
      }
      await this.drive(agent, signal, { turn, step })
      signal.throwIfAborted()
      if (holdsNativeStep(this.record(agent))) return { kind: 'reject' }
      return { ...decision, messages: [...decision.messages, runtimeMessage(
        '程序已完成本次联动交接。以下状态晚于本步前面的状态快照，以此为准：\n'
        + JSON.stringify({ lifecycle: this.status(agent), status: this.interaction.entries.get(agent)?.runner.status() })
        + '\n' + MANAGED_GUIDANCE)] }
    })
    ctx.on('tools/result', (exec, result) => {
      const { agent } = exec, policy = this.controllerToolErrors.get(agent)
      if (!policy || this.nativeToolBlocks.has(agent) || this.record(agent)?.toolErrorBlock
          || this.interaction.mode(agent) !== 'full') return
      const block = toolErrorBlock(policy, result, { role: 'controller', toolId: exec.name, callId: exec.callId, runId: agent.session.id })
      if (!block) return
      this.queued.delete(agent)
      const settle = (async () => {
        await agent.whenIdle()
        await this.save(agent, { phase: 'BLOCKED_TOOL_ERROR', reason: 'DIRECT_TOOL_ERROR_BLOCKED', pauseKind: null,
          toolErrorBlock: block, toolErrorResumeChecksum: null })
        this.nativeToolBlocks.delete(agent)
      })()
      this.nativeToolBlocks.set(agent, settle)
      agent.cancel({ kind: 'user' }, { keepInbox: true })
      return settle
    })
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'plan/mode' || event.data.active !== false) return
      const agent = ctx.agents.get(session.id)
      if (agent && this.interaction.isController(agent) && this.record(agent)?.phase === 'WAITING_NATIVE_PLAN') this.queued.add(agent)
    })
    ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      if (message.source?.kind !== 'user') return
      const control = this.running.get(agent)
      if (this.interaction.isController(agent) && this.guidance.enqueue(agent, message) && !control) {
        // A real new user message may request a handover. Merely reloading a
        // persisted queue still never starts a workflow automatically.
        this.queued.add(agent); this.continuations.add(agent)
      }
    })
  }
  async configure(agent, signal) {
    const previous = this.record(agent)
    if (previous?.afterPlanning) return previous
    const choice = await this.interaction.ask(agent, '规划完成后如何继续？', EXECUTION_OPTIONS, signal,
      { id: 'dynamic-context-execution', header: '规划后的执行' })
    if (!choice) return null
    const runner = this.interaction.entries.get(agent).runner
    const graph = runner.graph.read()
    const row = await this.save(agent, { phase: graph ? 'PLAN_COMMITTED' : 'PREPLANNING_QUEUED', afterPlanning: choice,
      executionEvidence: { source: 'human-question', questionId: 'dynamic-context-execution', selected: choice },
      taskContractChecksum: this.contractChecksum(agent),
      ...(graph ? { committed: { revision: graph.revision, checksum: graph.checksum } } : {}) })
    this.queued.add(agent)
    return row
  }
  async control(agent, action, signal, { humanResume = false } = {}) {
    this.interaction.exact(agent)
    if (this.interaction.mode(agent) !== 'full') fail('DYNAMIC_CONTEXT_FULL_MODE_REQUIRED')
    const runner = this.interaction.entries.get(agent).runner
    await this.nativeToolBlocks.get(agent)
    if (action === 'status') return this.status(agent)
    if (action === 'pause') {
      if (this.record(agent)?.toolErrorBlock) return this.status(agent)
      this.queued.delete(agent)
      const control = this.running.get(agent)
      if (control) { control.pauseRequested = true; runner.pauseRequested = true }
      await this.save(agent, { phase: control ? 'PAUSE_REQUESTED' : 'PAUSED', reason: 'USER_PAUSE', pauseKind: 'normal' })
      return this.status(agent)
    }
    if (this.running.has(agent)) fail('DYNAMIC_CONTEXT_WORKFLOW_BUSY')
    if (runner.graphPresence().recoveryRequired) return { phase: 'RECOVERY_REQUIRED', nextTool: 'dynamic_context_recover_graphs' }
    const checkpoint = runner.checkpointStatus?.()
    const toolErrorBlock = this.record(agent)?.toolErrorBlock ?? checkpoint?.toolErrorBlock
    if (toolErrorBlock) {
      const canResume = this.canAcknowledge(agent, runner, toolErrorBlock, checkpoint)
      if (!humanResume || !canResume) {
        this.queued.delete(agent)
        await this.save(agent, { phase: 'BLOCKED_TOOL_ERROR', reason: 'DIRECT_TOOL_ERROR_BLOCKED', toolErrorBlock })
        return { ...this.status(agent), requiresHumanResume: true, ...(!canResume ? { requiresHostRecovery: true } : {}),
          instruction: 'A registered tool-error rule blocked this task. Explain the recorded reason and wait for the user to click Continue; do not retry start/continue or dispatch leaves.' }
      }
      await this.save(agent, { toolErrorBlock: null, toolErrorResumeChecksum: toolErrorBlock.runId ? null : checkpoint?.checksum,
        toolErrorAcknowledgement: { source: 'human-view', block: toolErrorBlock, at: new Date().toISOString() } })
    }
    if (!this.record(agent)?.afterPlanning) {
      if (!await this.configure(agent, signal)) return { phase: 'NEEDS_EXECUTION_CHOICE' }
    }
    const row = this.record(agent), graph = runner.graph.read()
    if (action === 'continue' && (row.reason === 'BLOCKAGE_REVIEWED_WAIT' || row.interruption || graph?.supervision?.hierarchy?.stage === 'WAITING_USER')
        && (blockageStatus(runner)?.phase === 'WAITING_USER' || graph?.supervision?.hierarchy?.stage === 'WAITING_USER') && !humanResume) {
      const choice = await this.interaction.ask(agent, '当前已根据中断报告暂停。是否重新判断阻塞并继续？', [
        { mode: 'resume', label: '重新判断并继续', description: '重新检查当前条件，不直接重放旧工具。' },
        { mode: 'wait', label: '继续等待', description: '保留当前状态，等条件满足后手动恢复。' },
      ], signal, { id: 'dynamic-context-blockage-resume', header: '阻塞恢复' })
      if (choice !== 'resume') return this.status(agent)
    }
    if (action === 'approve') {
      if (!graph) fail('DYNAMIC_CONTEXT_PLAN_NOT_COMMITTED')
      const identity = { revision: graph.revision, checksum: graph.checksum }
      const contractChecksum = this.contractChecksum(agent)
      const choice = await this.interaction.ask(agent, `是否执行当前规划（第 ${graph.revision} 版，校验 ${graph.checksum.slice(0, 12)}）？`, [
        { mode: 'approve', label: '确认并开始执行', description: '只批准当前图和当前任务约束；保留原生 Plan 和权限限制。' },
        { mode: 'wait', label: '继续等待', description: '保留规划，不启动执行。' },
      ], signal, { id: 'dynamic-context-plan-approval', header: '规划确认' })
      if (choice !== 'approve') { this.queued.delete(agent); return this.status(agent) }
      const current = runner.graph.read()
      if (current?.checksum !== identity.checksum || this.contractChecksum(agent) !== contractChecksum)
        fail('DYNAMIC_CONTEXT_PLAN_CHANGED_DURING_APPROVAL')
      await this.save(agent, { approved: { ...identity, taskContractChecksum: contractChecksum,
        source: 'human-question', questionId: 'dynamic-context-plan-approval' }, phase: 'PLAN_COMMITTED' })
    } else if (row.phase === 'WAITING_PLAN_APPROVAL') return { ...this.status(agent), nextTool: 'dynamic_context_workflow', arguments: { action: 'approve' } }
    signal?.throwIfAborted()
    if (action === 'continue') this.continuations.add(agent)
    this.queued.add(agent)
    return { ...this.status(agent), instruction: 'The program will continue at the next safe step boundary. Do not dispatch leaves yourself.' }
  }
  async drive(agent, signal, position) {
    if (this.running.has(agent) || !this.queued.delete(agent)) return
    this.interaction.exact(agent)
    const runner = this.interaction.entries.get(agent)?.runner
    if (!runner || !this.record(agent)?.afterPlanning) return
    const control = { abort: new AbortController(), reason: null, pauseRequested: false }
    const combined = AbortSignal.any([signal, control.abort.signal])
    control.signal = combined
    this.running.set(agent, control)
    let continuing = this.continuations.delete(agent)
    let handover = false
    const boundary = () => {
      if (control.pauseRequested) fail('WORKFLOW_PAUSE_REQUESTED')
      if (this.guidancePending(agent)) fail('WORKFLOW_GUIDANCE_REQUESTED')
    }
    const guidanceBoundary = () => { if (this.guidancePending(agent)) fail('WORKFLOW_GUIDANCE_REQUESTED') }
    const paused = async () => {
      if (this.guidancePending(agent) && !control.pauseRequested) fail('WORKFLOW_GUIDANCE_REQUESTED')
      return this.save(agent, { phase: 'PAUSED', reason: 'USER_PAUSE', pauseKind: 'normal' })
    }
    runner.workflowControl = {
      recoverModel: continuing,
      ackToolError: this.record(agent)?.toolErrorAcknowledgement?.block,
      beforeRequest: boundary, beforeTool: guidanceBoundary, beforeCommit: guidanceBoundary,
      guidancePending: () => this.guidancePending(agent),
      roleComplete: (role, runId, input, value) => this.guidance.observeRole(agent, runner, role, runId, input, value),
    }
    try {
      if (this.record(agent)?.toolErrorBlock) return this.status(agent)
      if (runner.graphPresence().recoveryRequired) return await this.save(agent, { phase: 'RECOVERY_REQUIRED' })
      const checkpoint = runner.checkpointStatus?.()
      if (this.guidancePending(agent)) {
        const pendingGuidance = this.guidance.pending(agent)
        if (await this.guidance.handle(agent, runner, combined)) return await this.save(agent,
          { phase: 'PAUSED', reason: 'USER_GUIDANCE_WAIT', pauseKind: 'normal' })
        while (this.guidance.firstJob(agent)?.job.role === 'progress_reporter') await this.guidance.activate(agent, runner)
        const handled = this.guidance.records(agent).filter(row => pendingGuidance.some(prior => prior.id === row.id))
        if (handled.length && handled.every(row => !row.receivedWhileRunning && (row.route?.action === 'reply'
            || row.route?.jobs.every(job => job.role === 'progress_reporter')))) {
          const previous = handled[0].priorLifecycle
          return await this.save(agent, { ...previous, reason: previous.reason ?? 'USER_GUIDANCE_INFORMATION_ONLY' })
        }
        boundary()
        continuing = true
      }
      if (checkpoint?.toolErrorBlock && this.record(agent)?.toolErrorResumeChecksum !== checkpoint.checksum)
        return await this.save(agent, { phase: 'BLOCKED_TOOL_ERROR', reason: 'DIRECT_TOOL_ERROR_BLOCKED', toolErrorBlock: checkpoint.toolErrorBlock })
      if (!runner.graph.read()) {
        const result = await runPreplanning({ orchestrator: this, agent, runner, signal: combined, position })
        boundary()
        if (control.pauseRequested) return await this.save(agent, { phase: 'PAUSED', reason: 'USER_PAUSE', pauseKind: 'normal' })
        if (!result.committed) return await this.save(agent, { phase: 'PLANNING_INCOMPLETE', reason: result.reason })
        // runPreplanning returns only after its tool result, log and Agent teardown.
        const graph = runner.graph.read()
        await this.save(agent, { phase: 'PLAN_COMMITTED', committed: { revision: graph.revision, checksum: graph.checksum },
          plannerReceipt: result.receipt })
        this.guidance.observeRole(agent, runner, 'preplanning', result.receipt?.sessionId, {}, result.receipt ?? { committed: true })
      }
      combined.throwIfAborted()
      let row = this.record(agent), graph = runner.graph.read()
      // A graph left by a crashed planner cannot be inferred to have a durable
      // submit result. Explicit inspection is required before continuation.
      if (row.plannerSessionId && !row.plannerReceipt) {
        const receipt = continuing && await recoverPlannerReceipt(this.ctx, row.plannerSessionId, agent, runner, combined)
        if (!receipt) return await this.save(agent, { phase: 'NEEDS_ATTENTION', reason: 'PLANNER_HANDOFF_NOT_CONFIRMED' })
        row = await this.save(agent, { plannerReceipt: receipt, phase: 'PLAN_COMMITTED' })
      }
      const contractChecksum = this.contractChecksum(agent)
      if (row.afterPlanning === 'await_approval' && (!row.approved
          || !row.executionStarted && (row.approved.checksum !== graph.checksum || row.approved.taskContractChecksum !== contractChecksum)))
        return await this.save(agent, { phase: 'WAITING_PLAN_APPROVAL', reason: 'USER_SELECTED_WAIT' })
      if (this.interaction.planOnly(agent)) return await this.save(agent, { phase: 'WAITING_NATIVE_PLAN', reason: 'NATIVE_PLAN_ACTIVE' })
      // All execution and supervision use the existing serial, durable runner.
      for (;;) {
        combined.throwIfAborted(); this.interaction.exact(agent)
        boundary()
        if (control.pauseRequested) return await this.save(agent, { phase: 'PAUSED', reason: 'USER_PAUSE', pauseKind: 'normal' })
        if (this.interaction.planOnly(agent)) return await this.save(agent, { phase: 'WAITING_NATIVE_PLAN' })
        if (runner.graph.read()?.graph.state.suspended && runner.graph.read().supervision.phase === 'READY') {
          const lease = await acquireDirectLease(runner.config.directory)
          try { const restored = resolveGuidanceSuspension(runner); if (restored?.mode === 'resume') continuing = true } finally { await lease.release() }
        }
        const guided = await this.guidance.activate(agent, runner)
        if (guided?.done) { if (guided.restoreLifecycle) return await this.save(agent, guided.restoreLifecycle); continue }
        const status = runner.status()
        if (status.graphPresence.recoveryRequired || status.revisionRecovery?.length && !runner.workflowControl.recoverModel)
          return await this.save(agent, { phase: 'RECOVERY_REQUIRED', reason: 'GRAPH_OR_REVISION_RECOVERY' })
        if (!status.busy && status.supervision?.hierarchy?.stage === 'WAITING_USER') {
          if (!continuing) return await this.save(agent, { phase: 'PAUSED', reason: 'SCOPE_REVIEWED_WAIT', pauseKind: 'normal', interruption: status.supervision.hierarchy.decision.report })
          const state = runner.graph.read()
          beginHierarchyBlockage(runner, { expectedRevision: state.revision, baseChecksum: state.checksum, resume: true })
          continuing = false
          continue
        }
        if (!status.busy && status.supervision?.needsContinuation) {
          const before = runner.graph.read().supervision
          const continuationResult = await runner.continueSupervision({ expectedRevision: status.revision,
            checkpointChecksum: status.supervision.checkpointChecksum, sourceAgent: agent, signal: combined })
          if (continuationResult?.paused) return await paused()
          // A resume authorizes the saved boundary, not a later independently
          // audited request to wait for new user input.
          if (status.taskGraph?.hierarchyPolicy) continuing = false
          const after = runner.graph.read().supervision
          const rejection = control => {
            try { const detail = JSON.parse(control.feedback.slice(control.feedback.indexOf('{'))); return { code: detail.code, category: detail.category, issues: detail.issues } } catch { return null }
          }
          const repeatedRejection = before.phase === 'REPAIR_RESULT' && after.phase === 'REPAIR_RESULT' && rejection(before) && rejection(after) && digest(rejection(before)) === digest(rejection(after))
          if (repeatedRejection || digest({ ...before, roleRunId: null }) === digest({ ...after, roleRunId: null }))
            return await this.save(agent, { phase: 'NEEDS_ATTENTION', reason: 'SUPERVISION_NO_PROGRESS', pauseKind: 'unexpected' })
          continue
        }
        if (!status.busy && continuing && status.taskGraph?.active && (status.continuation?.resumablePhase || status.continuation?.recoverable)) {
          continuing = false
          // A restored session may still display the preceding planning role.
          // Mark the active leaf before recovery can fail and release the step.
          runner.activity = { stage: 'EXECUTING', kind: 'boundary', sessionId: null, tool: null, at: new Date().toISOString() }
          await this.save(agent, { phase: 'EXECUTING', reason: null, pauseKind: null, executionStarted: true })
          const result = await runner.resumeActive({ expectedRevision: status.revision,
            checkpointChecksum: status.continuation.checksum, recover: true, sourceAgent: agent, signal: combined,
            acknowledgeToolError: this.record(agent)?.toolErrorResumeChecksum })
          if (result.paused) return await paused()
          continue
        }
        if (status.busy || status.taskGraph?.active || status.supervision && status.supervision.phase !== 'READY')
          return await this.save(agent, { phase: 'NEEDS_ATTENTION', reason: 'ACTIVE_ATTEMPT_OR_SUPERVISION',
            checkpoint: status.continuation ?? null })
        const next = guided?.ready && guided.job.role === 'executor' ? status.taskGraph?.legalNext.find(row => row.id === guided.job.taskId) : status.taskGraph?.legalNext[0]
        if (!next) {
          const complete = status.taskGraph?.hierarchyPolicy ? Boolean(status.taskGraph.goalReached && status.supervision?.finalReport)
            : status.taskGraph?.nodes?.filter(node => node.kind === 'container').every(node => node.status === 'COMPLETE')
          if (complete && this.guidance.firstJob(agent)) return await this.save(agent, { phase: 'PAUSED', reason: 'GUIDANCE_ROLE_NOT_READY',
            pauseKind: 'normal', guidanceWait: { job: guided?.job, reason: guided?.reason ?? 'The requested role did not run before completion.' } })
          if (complete && status.taskGraph?.hierarchyPolicy) publishHierarchyReport(runner)
          if (!complete && runner.config.supervision && runner.config.revision && runner.config.transport === 'direct') {
            const base = runner.graph.read()
            await this.save(agent, { phase: 'BLOCKAGE_HANDLING', reason: 'NO_READY_LEAF', pauseKind: null })
            const result = await runner.handleBlockage({ expectedRevision: base.revision, baseChecksum: base.checksum,
              sourceAgent: agent, signal: combined, resume: continuing })
            continuing = false
            if (result.status === 'WAITING_USER') return await this.save(agent, { phase: 'PAUSED',
              reason: 'BLOCKAGE_REVIEWED_WAIT', pauseKind: 'normal', interruption: result.report })
            if (['REWORKED', 'REPLANNED', 'RESULT_COMMITTED', 'TASK_REPORTED'].includes(result.status)) continue
          }
          return await this.save(agent, { phase: complete ? 'COMPLETE' : 'NEEDS_ATTENTION',
            reason: complete ? status.taskGraph?.hierarchyPolicy ? 'ROOT_ACCEPTED_AND_REPORTED' : 'GRAPH_COMPLETE_GOAL_UNVERIFIED' : 'NO_READY_LEAF' })
        }
        await this.save(agent, { phase: 'EXECUTING', reason: null, pauseKind: null, ...(row.interruption ? { interruption: null } : {}), executionStarted: true, dispatch: { revision: status.revision, choice: next.choice, leafId: next.id, rule: 'first-current-legal-choice' } })
        runner.activity = { stage: 'EXECUTING', kind: 'boundary', sessionId: null, step: 0, tool: null, at: new Date().toISOString() }
        if (status.taskGraph?.hierarchyPolicy) continuing = false
        const result = await runner.runNext({ expectedRevision: status.revision, choice: next.choice, sourceAgent: agent, signal: combined })
        if (result.paused) return await paused()
        if (!await this.ctx.sessions.flush(agent.session)) fail('DYNAMIC_CONTEXT_EXECUTION_RECEIPT_NOT_DURABLE')
      }
    } catch (error) {
      // Errors become durable pauses, not successful completion or silent retries.
      if (error.code === 'DIRECT_TOOL_ERROR_BLOCKED') {
        await this.save(agent, { phase: 'BLOCKED_TOOL_ERROR', reason: error.code, pauseKind: null,
          toolErrorBlock: error.details, toolErrorResumeChecksum: null })
        return
      }
      if (error.code === 'WORKFLOW_GUIDANCE_REQUESTED' && !combined.aborted && !control.pauseRequested) {
        handover = true
        await this.save(agent, { phase: 'GUIDANCE_HANDOVER', reason: 'USER_GUIDANCE', pauseKind: null })
      } else {
        const normal = error.code === 'WORKFLOW_PAUSE_REQUESTED' || control.pauseRequested && error.code === 'WORKFLOW_GUIDANCE_REQUESTED'
        await this.save(agent, { phase: normal || combined.aborted ? 'PAUSED' : 'NEEDS_ATTENTION', pauseKind: normal ? 'normal' : 'unexpected',
          reason: normal ? 'USER_PAUSE' : control.reason ?? error.code ?? error.message ?? 'WORKFLOW_FAILED' })
      }
      if (signal.aborted) throw error
    } finally { this.running.delete(agent); runner.workflowControl = null }
    if (handover) { this.queued.add(agent); this.continuations.add(agent); return this.drive(agent, signal, position) }
  }
  cancel(agent) { this.queued.delete(agent); this.continuations.delete(agent); this.running.get(agent)?.abort.abort(new Error('DYNAMIC_CONTEXT_OWNER_DISPOSED')) }
}
