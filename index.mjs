// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import { DynamicContextGraph, fail } from './core.mjs'
import { digest } from 'dsh-bettertaskgraphs/core'
import { bridge, adapterReady, composeHooks } from './adapter-bridge.mjs'
import { RequestContract, deepFreeze, taskPrompt, toolFingerprint } from './request-policy.mjs'
import { runDirect } from './direct-channel.mjs'
import { directRuntimeSchema, prepareDirectRuntime } from './direct-runtime.mjs'
import { registerControlTools } from './control-tools.mjs'
import { DirectJournal, acquireDirectLease } from './durable-store.mjs'
import { connectTaskGraph, requireTaskGraph } from './interop.mjs'
import { SessionInteraction } from './interaction.mjs'
import { GRAPH_COMMIT_RECORD } from './graph-presence.mjs'
import { thinkingEnabled } from './api-protocol.mjs'
import { reconcileActive, collectOrphans } from './administration.mjs'
import { revisionPolicySchema } from './revision.mjs'
import { reviseWorkflow, revisionRecoveryState, abandonRevisionRole } from './revision-runtime.mjs'
import { continueSupervision, superviseResult, supervisionAuthority } from './supervision-runtime.mjs'
import { DEFAULT_MAX_TOKENS } from '@deepseek-ai/dsh-llm-deepseek'

export const name = 'dsh-dynamic-context'
export const inject = ['agents', 'sessions', 'tools', 'systemPrompt', 'llm', 'tokenMeter', 'transactionGraph']
const configSchema = z.object({ projectRoot: z.string(), storageRoot: z.string().optional(), directory: z.string(),
  enabled: z.boolean().default(true),
  provider: z.string().min(1), model: z.string().min(1),
  transport: z.enum(['native-guarded', 'direct']),
  direct: z.object({ endpoint: z.string().refine(value => {
    try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash } catch { return false }
  }, 'Explicit HTTP endpoint without credentials, query or fragment required'),
  auth: z.enum(['api-key', 'deepseek-account']).default('api-key'),
  apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
  api: z.enum(['openai-compatible', 'deepseek']).default('openai-compatible'),
  thinking: z.object({ type: z.enum(['enabled', 'disabled']) }).strict().optional(),
  reasoningEffort: z.enum(['low', 'high', 'max']).optional(),
  responseModelAliases: z.array(z.string().min(1).max(128)).max(8).default([]),
  agentlessTools: z.array(z.string()).max(32).refine(values => new Set(values).size === values.length).default([]),
  runtime: directRuntimeSchema.optional(),
  durable: z.boolean().default(false),
  tracePayloads: z.enum(['inline', 'references']).default('inline'),
  maxJournalBytes: z.number().int().min(1048576).max(8589934592).nullable().default(134217728),
  compaction: z.union([z.object({ strategy: z.literal('dsh-native'), contextWindow: z.number().int().min(131072).max(1048576) }).strict(),
    z.object({ triggerCharacters: z.number().int().min(1024).max(256000),
    retainRecentExchanges: z.number().int().min(0).max(4).default(0),
    maxCompactions: z.number().int().min(1).max(8).default(4),
    maxCheckpointCharacters: z.number().int().min(1024).max(64000).default(12000),
  }).strict()]).optional(),
  generation: z.object({ temperature: z.number().min(0).max(2).optional(), top_p: z.number().min(0).max(1).optional(),
    top_k: z.number().int().min(0).optional(), min_p: z.number().min(0).max(1).optional(),
    repeat_penalty: z.number().positive().optional(), repeat_last_n: z.number().int().min(-1).optional(),
    presence_penalty: z.number().min(-2).max(2).optional(), frequency_penalty: z.number().min(-2).max(2).optional(),
    seed: z.number().int().optional(),
  }).strict().default({}),
  maxRequestBytes: z.number().int().min(1024).max(8 * 1024 * 1024).nullable().default(1024 * 1024),
  maxResponseBytes: z.number().int().min(128).max(8 * 1024 * 1024).nullable().default(2 * 1024 * 1024),
  streamIdleTimeoutMs: z.number().int().min(1).max(2147483647).optional(),
  reserveFinalReport: z.boolean().default(false),
  }).strict().optional(),
  systemPrompt: z.string().min(1).max(16000), allowedTools: z.array(z.string()).max(32).default([]),
  exposeControlTools: z.boolean().default(true),
  interaction: z.object({ mode: z.enum(['interactive', 'host']).default('interactive') }).strict().default({ mode: 'interactive' }),
  supervision: z.boolean().default(false),
  supervisionContext: z.enum(['reports', 'legacy']).default('reports'),
  revision: z.object({ policy: revisionPolicySchema,
    maxOutputTokens: z.number().int().min(1).max(393216).default(DEFAULT_MAX_TOKENS) }).strict().optional(),
  interop: z.object({ enabled: z.literal(true).default(true), workflowId: z.string().regex(/^[a-z][a-z0-9_-]{0,79}$/).optional() }).strict().default({ enabled: true }),
  maxContextCharacters: z.number().int().min(1).max(8388608).nullable().default(64000),
  maxStateBytes: z.number().int().min(1).max(12 * 1024 * 1024).nullable().optional(),
  maxReportCharacters: z.number().int().min(1).max(8388608).nullable().default(16000),
  maxInputTokens: z.number().int().min(1).max(1000000).optional(),
  maxOutputTokens: z.number().int().min(1).max(393216).default(512),
  maxRequestsPerTask: z.number().int().min(1).max(256).nullable().default(4),
  timeoutMs: z.number().int().min(10).max(1800000).nullable().default(10000),
}).strict().superRefine((config, ctx) => {
  if (config.interaction.mode === 'interactive' && config.transport !== 'direct')
    ctx.addIssue({ code: 'custom', message: 'Interactive graph selection requires the direct route; native-guarded is a host-only development comparison' })
  if (config.transport !== 'direct' && [config.maxRequestsPerTask, config.timeoutMs, config.maxContextCharacters, config.maxStateBytes, config.maxReportCharacters].includes(null))
    ctx.addIssue({ code: 'custom', message: 'Explicitly disabled extra limits require the direct route' })
  if (config.direct?.reserveFinalReport && config.maxRequestsPerTask === null)
    ctx.addIssue({ code: 'custom', message: 'A reserved final request requires a finite request limit' })
  if (config.direct?.tracePayloads === 'references' && !config.direct.durable)
    ctx.addIssue({ code: 'custom', message: 'Referenced trace payloads require durable request storage' })
  if (config.transport === 'direct' && !config.direct) ctx.addIssue({ code: 'custom', message: 'Direct transport requires an explicit endpoint' })
  if (config.supervision && (config.transport !== 'direct' || !config.direct?.durable || !config.revision))
    ctx.addIssue({ code: 'custom', message: 'Supervision requires the durable direct route and a revision policy' })
  if (config.direct?.auth === 'deepseek-account') {
    let official = false
    try { official = new URL(config.direct.endpoint).origin === 'https://api.deepseek.com' } catch {}
    if (!official || config.direct.api !== 'deepseek' || config.direct.apiKeyEnv)
      ctx.addIssue({ code: 'custom', message: 'Account authentication requires the official HTTPS DeepSeek endpoint and cannot be combined with an API Key reference' })
  }
  if (config.direct?.agentlessTools.some(name => !config.allowedTools.includes(name))) ctx.addIssue({ code: 'custom', message: 'Direct agentless tools must be a subset of host allowedTools' })
  if (config.exposeControlTools && config.transport !== 'direct') ctx.addIssue({ code: 'custom', message: 'Controller tools require the direct route' })
  if (config.direct?.compaction?.strategy === 'dsh-native' && !config.direct.durable)
    ctx.addIssue({ code: 'custom', message: 'Native compaction requires durable request and archive storage' })
  if (config.direct?.compaction && config.direct.compaction.strategy !== 'dsh-native' && (!config.direct.durable || !config.direct.runtime?.modules.includes('state')
      || !config.allowedTools.includes('dynamic_context_source_read'))) ctx.addIssue({ code: 'custom', message: 'Compaction requires durability, the state module and an explicitly allowed source reader' })
  if (config.direct?.compaction && config.direct.compaction.maxCheckpointCharacters >= config.direct.compaction.triggerCharacters)
    ctx.addIssue({ code: 'custom', message: 'Checkpoint limit must be smaller than the history trigger' })
  if (config.direct?.api !== 'deepseek' && (config.direct?.thinking || config.direct?.reasoningEffort))
    ctx.addIssue({ code: 'custom', message: 'Thinking controls require the explicit DeepSeek protocol' })
  if (config.direct?.api === 'deepseek') {
    if (Object.keys(config.direct.generation).some(key => !['temperature', 'top_p', 'presence_penalty', 'frequency_penalty'].includes(key)))
      ctx.addIssue({ code: 'custom', message: 'Llama-specific generation fields cannot be sent to DeepSeek' })
    if (thinkingEnabled(config.direct) && ['temperature', 'presence_penalty', 'frequency_penalty'].some(key => config.direct.generation[key] !== undefined))
      ctx.addIssue({ code: 'custom', message: 'DeepSeek thinking ignores temperature and presence/frequency penalties; remove these settings' })
  }
  if (config.maxInputTokens && config.transport !== 'direct') ctx.addIssue({ code: 'custom', message: 'Explicit input token budgets require the direct meter port' })
})
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
export const validateConfig = input => configSchema.parse(input)
function durableConfigHash(config, meter) {
  const files = ['index.mjs', 'core.mjs', 'request-policy.mjs', 'direct-channel.mjs', 'direct-http.mjs', 'native-compaction.mjs', 'dsh-compaction-policy.mjs', 'direct-runtime.mjs', 'execution-privacy.mjs', 'durable-store.mjs', 'checkpoints.mjs',
    'control-tools.mjs', 'evidence-policy.mjs', 'adapter-bridge.mjs', 'interop.mjs', 'api-protocol.mjs', 'direct-auth.mjs', 'administration.mjs', 'host.mjs', 'revision-runtime.mjs', 'role-context.mjs', 'report-evidence.mjs', 'supervision-state.mjs', 'supervision-semantics.mjs', 'supervision-runtime.mjs', 'revision.mjs', 'revision-host.mjs', 'revision-report.mjs', 'artifacts.mjs', 'interaction.mjs', 'graph-presence.mjs', 'package.json']
  const external = ['dsh-bettertaskgraphs/core', 'dsh-bettertaskgraphs/store', 'dsh-bettertaskgraphs/host', 'dsh-bettertaskgraphs/interop', 'dsh-bettertaskgraphs/extensions', '@deepseek-ai/dsh-token-meter/estimate']
  return digest({ config: JSON.parse(JSON.stringify(config)), meter: meter ? { version: meter.version, implementation: sha256(Function.prototype.toString.call(meter.measure)),
    observer: meter.observe ? sha256(Function.prototype.toString.call(meter.observe)) : null } : null, code: [
    ...files.map(name => [name, sha256(fs.readFileSync(new URL(name, import.meta.url)))]),
    ...external.map(name => [name, sha256(fs.readFileSync(new URL(import.meta.resolve(name))))]),
  ] })
}

/** Serial runner with a guarded native route or an explicitly configured direct HTTP route. */
export class DynamicContextRuntime {
  constructor(ctx, config) {
    this.ctx = ctx; this.config = deepFreeze(configSchema.parse(config))
    this.taskGraph = requireTaskGraph(ctx)
    this.workflowId = this.config.interop.workflowId ?? `workflow_${digest(this.config.directory).slice(0, 40)}`
    this.graph = new DynamicContextGraph({ ...this.config, storeFactory: options => this.taskGraph.createExtensionStore(options) })
    this.busy = false; this.closed = false; this.current = null
    this.listeners = new Set()
  }
  assertBase() { if (this.closed) fail('DYNAMIC_CONTEXT_RUNNER_CLOSED'); return requireTaskGraph(this.ctx, this.taskGraph) }
  assertController(agent) {
    this.assertBase()
    if (this.config.interaction.mode !== 'host' && (!agent || agent !== this.controller
        || this.ctx.agents.get(agent.id) !== agent || this.interaction?.mode(agent) !== 'full')) fail('DYNAMIC_CONTEXT_FULL_MODE_REQUIRED')
  }
  graphPresence() {
    const presence = this.graph.store.recoveryPlan()
    if (presence.state === 'NEVER_CREATED' && this.controller && this.taskGraph.sessionRecords.read(this.controller.session).some(({ event }) =>
      event.type === GRAPH_COMMIT_RECORD && event.ignorable && event.data.workflowId === this.workflowId))
      return { state: 'GRAPH_AND_WITNESS_LOST_AFTER_COMMIT', previouslyCommitted: true, recoveryRequired: true, canRestore: false }
    return presence
  }
  assertGraphEvidence() { if (this.graphPresence().recoveryRequired) fail('GRAPH_RECOVERY_REQUIRED') }
  async restoreGraphs({ sourceAgent, expectedWitnessChecksum, signal } = {}) {
    this.assertController(sourceAgent); signal?.throwIfAborted()
    if (this.busy) fail('SERIAL_CONTEXT_RUN_IN_PROGRESS')
    this.busy = true
    let releaseDrain, lease
    this.drained = new Promise(resolve => { releaseDrain = resolve })
    try {
      lease = await acquireDirectLease(this.config.directory)
      signal?.throwIfAborted(); this.assertBase()
      return this.graph.store.restore(expectedWitnessChecksum)
    } finally { await lease?.release(); this.busy = false; releaseDrain() }
  }
  subscribe(callback) { this.listeners.add(callback); return () => this.listeners.delete(callback) }
  registerInputMeter({ version, measure, observe }) {
    if (this.busy || this.inputMeter || typeof version !== 'string' || !version.trim() || version.length > 128 || typeof measure !== 'function') fail('DIRECT_INPUT_METER_REGISTRATION_INVALID')
    if (observe !== undefined && typeof observe !== 'function') fail('DIRECT_INPUT_OBSERVER_INVALID')
    const meter = Object.freeze({ version, measure, ...(observe ? { observe } : {}) }); this.inputMeter = meter
    return () => { if (this.busy) fail('DIRECT_INPUT_METER_IN_USE'); if (this.inputMeter === meter) this.inputMeter = null }
  }
  registerReconciliationVerifier({ version, verify }) {
    if (this.closed || this.busy || this.reconciliationVerifier || typeof version !== 'string' || !version.trim() || version.length > 128 || typeof verify !== 'function') fail('DIRECT_RECONCILIATION_VERIFIER_INVALID')
    const verifier = Object.freeze({ version, verify }); this.reconciliationVerifier = verifier
    return () => { if (this.busy) fail('DIRECT_RECONCILIATION_VERIFIER_IN_USE'); if (this.reconciliationVerifier === verifier) this.reconciliationVerifier = null }
  }
  reconcileActive(request) { this.assertController(request?.sourceAgent); this.assertGraphEvidence(); return reconcileActive(this, request) }
  collectOrphans(request) { this.assertController(request?.sourceAgent); this.assertGraphEvidence(); return collectOrphans(this, request) }
  revise(request) { this.assertController(request?.sourceAgent); this.assertGraphEvidence(); return reviseWorkflow(this, request) }
  continueSupervision(request) { this.assertController(request?.sourceAgent); this.assertGraphEvidence(); return continueSupervision(this, request) }
  revisionRecovery() { return this.busy ? [] : revisionRecoveryState(this) }
  abandonRevisionRole(request) { this.assertBase(); this.assertGraphEvidence(); return abandonRevisionRole(this, request) }
  registerRevisionAccounting(adapter) {
    if (this.busy || this.revisionAccounting || typeof adapter?.beforeRequest !== 'function'
        || typeof adapter.afterResponse !== 'function' || typeof adapter.onFailure !== 'function') fail('REVISION_ACCOUNTING_ADAPTER_INVALID')
    this.revisionAccounting = adapter
    return () => { if (this.busy) fail('REVISION_ACCOUNTING_IN_USE'); if (this.revisionAccounting === adapter) this.revisionAccounting = null }
  }
  publish(type) {
    for (const callback of this.listeners) { try { callback({ type }) } catch (error) { this.ctx.logger?.warn?.(`dynamic context listener failed: ${error.code ?? error.name}`) } }
  }
  supervisionStatus(state = this.graph.read()) {
    const control = state?.supervision
    if (!control) return null
    return { phase: control.phase,
      ...(control.phase === 'READY' ? {} : { checkpointChecksum: state.checksum, needsContinuation: true }),
      ...(control.feedback ? { feedback: control.feedback } : {}),
      outcomes: control.outcomes.map(row => ({
        taskId: row.taskId, attemptId: row.attemptId, revision: row.revision, outcome: row.result.outcome,
      })),
    }
  }
  status() {
    const graphPresence = this.graphPresence()
    if (graphPresence.recoveryRequired) return { transport: this.config.transport, busy: this.busy, closed: this.closed,
      graphPresence, legalNext: [], recoveryRequired: true, code: 'GRAPH_RECOVERY_REQUIRED' }
    const state = this.graph.read()
    return { transport: this.config.transport, revision: state?.revision ?? 0, graphPresence,
      busy: this.busy, closed: this.closed, taskGraph: this.graph.status(state),
      ...(this.config.supervision ? { supervision: this.supervisionStatus(state) } : {}),
      contextVersion: state?.contexts.version ?? null,
      revisionRecovery: this.revisionRecovery(),
      reportStates: (state?.reports ?? []).map(report => ({ taskId: report.taskId,
        task: state.graph.state.plan.nodes.find(node => node.id === report.taskId).key,
        contextVersion: report.contextVersion, validity: state.invalidatedReports?.includes(report.taskId) ? 'INVALIDATED' : 'UNVERIFIED' })),
      semanticAcceptance: 'NOT_EVALUATED',
      ...(this.config.direct?.durable ? { continuation: this.checkpointStatus() } : {}) }
  }
  checkpointStatus() {
    const state = this.graph.read(), active = state?.graph.state.active
    if (!active || !this.config.direct?.durable) return null
    try {
      const journal = DirectJournal.open(path.join(this.config.directory, active.attemptId), {
        taskId: active.nodeId, attemptId: active.attemptId, contextVersion: state.contexts.version,
        owner: active.owner, graphRevision: state.revision }, { maxBytes: this.config.direct.maxJournalBytes })
      const head = journal.latest()
      return { phase: head?.phase ?? 'NO_CHECKPOINT', checksum: head?.checksum ?? null,
        resumablePhase: (!state.supervision || state.supervision.phase === 'READY') && ['READY', 'PAUSED', 'REPORT_READY'].includes(head?.phase),
        exclusiveLeaseRequired: true,
        storageBytes: journal.usage(), maxJournalBytes: this.config.direct.maxJournalBytes }
    } catch (error) { return { phase: 'UNAVAILABLE', resumablePhase: false, error: error.code ?? 'DIRECT_CHECKPOINT_INVALID' } }
  }
  pauseActive({ expectedRevision } = {}) {
    this.assertBase(); this.assertGraphEvidence()
    if (!this.config.direct?.durable || this.config.transport !== 'direct') fail('DIRECT_PAUSE_REQUIRES_DURABILITY')
    const state = this.graph.read()
    if (state?.revision !== expectedRevision || !this.busy || !this.current
        || state.supervision && (!state.graph.state.active || state.supervision.phase !== 'READY')) fail('DIRECT_PAUSE_STALE_OR_NOT_RUNNING')
    this.pauseRequested = true
    return { status: 'PAUSE_REQUESTED', boundary: 'after a complete model/tool exchange' }
  }
  submit(proposal, { sourceAgent } = {}) {
    this.assertController(sourceAgent)
    this.assertGraphEvidence()
    if (this.config.supervision && this.config.supervisionContext === 'reports' && !proposal.planningReport) fail('SUPERVISION_PLANNING_REPORT_REQUIRED')
    if (this.closed || this.busy) fail('DYNAMIC_CONTEXT_RUNNER_UNAVAILABLE')
    for (const binding of proposal?.contextGraph?.bindings ?? []) {
      if ((binding.tools ?? []).some(tool => !this.config.allowedTools.includes(tool))) fail('CONTEXT_CANNOT_GRANT_TOOL_PERMISSION')
      if (this.config.direct?.compaction && this.config.direct.compaction.strategy !== 'dsh-native' && !(binding.tools ?? []).includes('dynamic_context_source_read')) fail('DIRECT_COMPACTION_REQUIRES_SOURCE_READER_BINDING')
      if (this.config.transport === 'direct' && !this.config.direct.runtime && (binding.tools ?? []).some(tool => !this.config.direct.agentlessTools.includes(tool))) fail('DIRECT_TOOL_REQUIRES_EXPLICIT_AGENTLESS_PERMISSION')
    }
    const result = this.graph.submit(proposal)
    if (sourceAgent) this.taskGraph.sessionRecords.append(sourceAgent.session, GRAPH_COMMIT_RECORD, { workflowId: this.workflowId,
      graphId: result.graph.state.plan.id, firstChecksum: result.checksum, revision: result.revision })
    this.publish('created'); return result
  }
  /** Execute one ready leaf. Any uncertain execution keeps ACTIVE and blocks automatic replay. */
  runNext(options = {}) { return this.execute({ ...options, resume: false }) }
  resumeActive(options = {}) { return this.execute({ ...options, resume: true }) }
  async execute({ expectedRevision, choice = 0, signal, sourceAgent, pauseAfterRequests, checkpointChecksum, resume } = {}) {
    this.assertController(sourceAgent)
    this.assertGraphEvidence()
    if (this.closed) fail('DYNAMIC_CONTEXT_RUNNER_CLOSED')
    if (this.busy) fail('SERIAL_CONTEXT_RUN_IN_PROGRESS')
    if ((resume || pauseAfterRequests !== undefined) && (this.config.transport !== 'direct' || !this.config.direct?.durable)) fail('DIRECT_RESUME_REQUIRES_DURABILITY')
    if (pauseAfterRequests !== undefined && (!Number.isSafeInteger(pauseAfterRequests) || pauseAfterRequests < 1)) fail('DIRECT_PAUSE_REQUEST_COUNT')
    if (resume && !/^[a-f0-9]{64}$/.test(checkpointChecksum ?? '')) fail('DIRECT_RESUME_CHECKPOINT_REQUIRED')
    if (this.config.transport === 'native-guarded' && !adapterReady()) fail('NATIVE_WIRE_GUARD_UNAVAILABLE')
    signal?.throwIfAborted()
    this.busy = true
    let resolveDrained
    this.drained = new Promise(resolve => { resolveDrained = resolve })
    const control = new AbortController()
    let handle, execution, timer, onAbort, trace, contract, runDirectory, removeModelGuard, traceSaved = false
    let lease, journal, continuation, configHash, authorityHash, durableStarted = false, supervising = false
    this.pauseRequested = false
    this.current = { dispose: async () => { control.abort(new Error('DYNAMIC_CONTEXT_RUNNER_CLOSED')) } }
    onAbort = () => { control.abort(signal.reason); if (handle) void handle.dispose() }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      if (this.config.transport === 'direct' && this.config.direct.durable) {
        lease = await acquireDirectLease(this.config.directory)
        configHash = durableConfigHash(this.config, this.inputMeter)
      }
      control.signal.throwIfAborted()
      if (this.config.supervision) {
        const state = this.graph.read()
        if (state && state.supervision.phase !== 'READY') fail('SUPERVISION_SCHEDULING_BLOCKED')
        authorityHash = supervisionAuthority(this, sourceAgent)
      }
      if (resume) {
        const state = this.graph.read(), active = state?.graph.state.active
        if (state?.revision !== expectedRevision || !active) fail('DIRECT_RESUME_STALE_OR_DIFFERENT_ATTEMPT')
        runDirectory = path.join(this.config.directory, active.attemptId)
        journal = DirectJournal.open(runDirectory, { taskId: active.nodeId, attemptId: active.attemptId,
          contextVersion: state.contexts.version, owner: active.owner, graphRevision: state.revision }, { maxBytes: this.config.direct.maxJournalBytes })
        const head = journal.latest()
        if (head?.checksum !== checkpointChecksum) fail('DIRECT_RESUME_CHECKPOINT_CHANGED')
        continuation = journal.loadCheckpoint(head, { hydratePayloads: this.config.direct.tracePayloads !== 'references' })
        if (continuation.configHash !== configHash) fail('DIRECT_RESUME_CONFIGURATION_CHANGED')
        if (!Number.isSafeInteger(continuation.nextStep) || continuation.nextStep < 0 || this.config.maxRequestsPerTask !== null && continuation.nextStep > this.config.maxRequestsPerTask) fail('DIRECT_RESUME_STATE_INVALID')
        journal.restoreArchives(continuation.archives)
        this.graph.adoptCheckpoint({ expectedRevision, attemptId: active.attemptId, owner: active.owner })
      } else this.graph.begin({ expectedRevision, choice })
      this.publish(resume ? 'resumed' : 'begun')
      const assembly = this.graph.assemble(), sessionId = SessionId(`dynamic-context-${randomUUID()}`)
      if (continuation && digest(assembly) !== digest(continuation.assembly)) fail('DIRECT_RESUME_CONTEXT_CHANGED')
      runDirectory = path.join(this.config.directory, assembly.task.attemptId)
      if (!resume) fs.mkdirSync(runDirectory, { mode: 0o700 })
      trace = continuation ? structuredClone(continuation.trace) : { schema: 2, source: this.config.transport === 'direct' ? 'plugin-direct-http-task' : 'native-dsh-task-session',
        transport: this.config.transport, sessionId, assembly,
        requests: [], events: [], status: 'STARTED', semanticAcceptance: 'NOT_EVALUATED' }
      if (resume) {
        trace.resumptions ??= []; trace.resumptions.push({ fromSessionId: trace.sessionId, sessionId, checkpointChecksum, time: new Date().toISOString() })
        trace.sessionId = sessionId; trace.status = 'STARTED'
      }
      if (lease && !journal) {
        journal = new DirectJournal(runDirectory, { taskId: assembly.task.id, attemptId: assembly.task.attemptId,
          contextVersion: assembly.contextVersion, owner: this.graph.owner, graphRevision: this.graph.read().revision, sessionId }, { maxBytes: this.config.direct.maxJournalBytes })
        journal.append('PREPARING')
      }
      const persist = () => this.saveTrace(runDirectory, trace, 'trace.json', journal)
      persist()
      signal?.throwIfAborted()
      if (this.config.timeoutMs !== null) timer = setTimeout(() => { trace.status = 'TIMEOUT_UNKNOWN'; control.abort(new Error('TASK_TIMEOUT')); if (handle) void handle.dispose() }, this.config.timeoutMs)
      if (this.config.transport === 'direct') execution = await prepareDirectRuntime({ ctx: this.ctx, config: this.config,
        assembly, sessionId, sourceAgent, control, resumeState: continuation?.runtime, sourceReader: journal, record: (type, data) => {
          trace.events.push({ seq: trace.events.length, time: Date.now(), type, data: structuredClone(data) }); persist()
        } })
      if (execution) this.current.agent = execution.agent
      const scope = execution?.agent, tools = this.ctx.tools.schemas(scope).map(tool => tool.name)
      if (assembly.tools.some(tool => !this.config.allowedTools.includes(tool) || !tools.includes(tool))) fail('TASK_TOOL_NOT_AVAILABLE')
      if (this.config.transport === 'direct' && !execution && assembly.tools.some(tool => !this.config.direct.agentlessTools.includes(tool))) fail('DIRECT_TOOL_REQUIRES_EXPLICIT_AGENTLESS_PERMISSION')
      const schemas = this.ctx.tools.schemas(scope).filter(tool => assembly.tools.includes(tool.name)).map(tool => {
        if (this.config.transport !== 'direct') return tool
        const { deferLoading, ...schema } = tool
        return schema
      })
      const definitions = assembly.tools.map(name => [name, this.ctx.tools.get(name, scope)])
      const seed = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: taskPrompt(assembly) }] })
      const requestConfig = execution ? deepFreeze({ ...this.config, systemPrompt: execution.systemPrompt }) : this.config
      contract = new RequestContract({ config: requestConfig, assembly, seed, schemas, definitions })
      if (continuation && toolFingerprint(contract) !== continuation.toolFingerprint) fail('DIRECT_RESUME_TOOL_DEFINITIONS_CHANGED')
      trace.contract = { hash: contract.hash, policy: structuredClone(requestConfig), systemPrompt: requestConfig.systemPrompt, seed: structuredClone(seed),
        schemas: structuredClone(schemas), provider: this.config.provider, model: this.config.model, maxOutputTokens: this.config.maxOutputTokens }
      if (execution) trace.executionHost = execution.facts
      persist()
      let reportText
      if (this.config.transport === 'direct') {
        durableStarted = true
        const startingStep = continuation?.nextStep ?? 0
        reportText = await runDirect({ ctx: this.ctx, config: requestConfig, contract, trace, control, persist, execution,
          journal, continuation, configHash, meter: this.inputMeter,
          shouldPause: step => this.pauseRequested || pauseAfterRequests !== undefined && step - startingStep >= pauseAfterRequests })
        if (reportText?.paused) {
          await execution?.close()
          if (execution) {
            trace.executionEvents = execution.agent.session.snapshotEvents()
            reportText.continuationState.runtime.native.events = trace.executionEvents
          }
          reportText.continuationState.trace = structuredClone(trace)
          const paused = journal.checkpoint('PAUSED', reportText.continuationState)
          persist()
          this.publish('paused')
          return { paused: true, checkpoint: { phase: paused.phase, checksum: paused.checksum, snapshot: paused.data.snapshot },
            trace, runDirectory, revision: this.graph.read().revision }
        }
        if (execution) { await execution.complete(); trace.executionEvents = structuredClone(execution.agent.session.snapshotEvents()) }
      } else {
        handle = await this.ctx.agents.create({ sessionId, signal: control.signal,
          agentOptions: { provider: this.config.provider, model: this.config.model, maxTokens: this.config.maxOutputTokens },
          setup: agentCtx => {
            agentCtx.tools.presentAs('native')
            agentCtx.tools.restrict({ allow: assembly.tools })
            agentCtx.tools.guard(exec => contract.checkExecution(exec, agentCtx.tools))
            agentCtx.on('tools/result', (exec, result) => { contract.recordToolResult(exec, result) })
            agentCtx.systemPrompt.suppressRuntimeContext()
            agentCtx.systemPrompt.suppressAllRuntimeContext()
            agentCtx.systemPrompt.section({ name: 'project:dynamic-context-host-policy', order: -1000,
              complete: true, interpolate: false, text: this.config.systemPrompt })
            agentCtx.on('system-prompt/assemble', async (_assembly, context, next) => {
              const assembled = await next()
              if (context.agent?.id === sessionId) contract.checkTools(assembled.tools)
              return context.agent?.id === sessionId
                ? { ...assembled, contexts: [] } : assembled
            }, { prepend: true })
            removeModelGuard = this.ctx.on('llm/stream', async function* (options, next) {
              if (options.sessionId !== sessionId) {
                if (this.ctx.agents.currentInitiator()?.id === sessionId) contract.reject('UNAPPROVED_AUXILIARY_MODEL_CALL')
                yield* next(); return
              }
              if (trace.requests.length >= this.config.maxRequestsPerTask) fail('TASK_REQUEST_LIMIT')
              const agent = this.ctx.agents.get(sessionId)
              contract.checkNative(options, agent.session)
              if (!adapterReady()) contract.reject('NATIVE_WIRE_GUARD_UNAVAILABLE')
              const measurement = this.ctx.tokenMeter.measure(agent.session)
              const position = agent.session.snapshotEvents().findLast(event => event.type === 'step/start')?.data
              const request = { messages: structuredClone(options.messages),
                tools: structuredClone(options.tools ?? []), measuredSurfaceSeqs: measurement.nodes.map(row => row.seq),
                requestSurfaceSeqs: [...agent.session.surface.nodes],
                derivesSameMessages: JSON.stringify(options.messages) === JSON.stringify(agent.session.deriveMessages()),
                measuredTokens: measurement.totalTokens, requestHeader: agent.session.requestHeader(),
                turn: position?.turn, step: position?.step, blocks: [], finish: null,
                contractHash: contract.hash, validation: 'PASS', wireValidated: false }
              trace.requests.push(request)
              contract.outputs.push(request)
              persist()
              const hooks = composeHooks(bridge.getStore()?.hooks, { onPayload: payload => {
                if (bridge.getStore()?.hooks !== hooks) contract.reject('NATIVE_ADAPTER_HOOK_SCOPE_CHANGED')
                contract.checkNativeWire(payload, options)
                request.wireValidated = true; request.wireChecksum = digest(payload); persist()
                return deepFreeze(structuredClone(payload))
              } })
              let iterator
              try {
                iterator = bridge.run({ hooks }, () => next()[Symbol.asyncIterator]())
                for (;;) {
                  const item = await bridge.run({ hooks }, () => iterator.next())
                  if (item.done) break
                  contract.recordOutput(request, item.value)
                  yield item.value
                }
                if (!request.wireValidated) contract.reject(contract.violation ?? 'NATIVE_WIRE_GUARD_NOT_OBSERVED')
              } finally {
                try { await bridge.run({ hooks }, () => iterator?.return?.()) }
                finally { persist() }
              }
            }.bind(this))
          },
        })
        this.current = handle
        const actualTools = handle.agent.ctx.tools.schemas(handle.agent).map(tool => tool.name).sort()
        if (JSON.stringify(actualTools) !== JSON.stringify([...assembly.tools].sort())) fail('TASK_TOOL_SCOPE_MISMATCH')
        control.signal.throwIfAborted()
        handle.agent.followup(seed)
        await handle.agent.whenIdle()
        control.signal.throwIfAborted()
        trace.events = structuredClone(handle.agent.session.snapshotEvents())
        const ended = trace.events.findLast(event => event.type === 'turn/end')
        const assistant = trace.events.findLast(event => event.type === 'assistant/message')
        if (contract.violation) fail(contract.violation)
        if (trace.status !== 'STARTED' || ended?.data.reason.kind !== 'completed' || !assistant) fail('TASK_EXECUTION_UNKNOWN_OR_FAILED')
        if (trace.requests.at(-1)?.finish !== 'stop') fail('TASK_REPORT_DID_NOT_STOP_NORMALLY')
        if (trace.events.some(event => event.type === 'tool/result' && event.data.message.isError)) fail('TASK_TOOL_EXECUTION_FAILED')
        contract.checkNativeMessages(handle.agent.session.deriveMessages(), handle.agent.session)
        reportText = assistant.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('')
      }
      if (!reportText.trim() || this.config.maxReportCharacters !== null && reportText.length > this.config.maxReportCharacters) fail('TASK_REPORT_EMPTY_OR_OVER_BUDGET')
      trace.status = 'RESPONSE_RECEIVED'
      const evidence = this.saveTrace(runDirectory, trace, 'trace.json', journal)
      traceSaved = true
      const report = { taskId: assembly.task.id, attemptId: assembly.task.attemptId, sessionId,
        contextVersion: assembly.contextVersion, text: reportText, acceptance: 'UNVERIFIED_MODEL_REPORT', evidence: [evidence] }
      if (this.config.supervision) {
        clearTimeout(timer)
        await execution?.close()
        supervising = true
        const outcome = await superviseResult(this, { report, authorityHash, sourceAgent, signal: control.signal })
        const committed = this.graph.read().reports.find(row => row.attemptId === report.attemptId)
        return { ...outcome, ...(committed ? { report: committed } : {}), trace, runDirectory }
      }
      this.assertBase()
      this.graph.finish({ expectedRevision: this.graph.read().revision, report })
      this.publish('report-committed')
      return { report, trace, runDirectory, revision: this.graph.read().revision }
    } catch (error) {
      if (supervising) {
        this.publish('supervision-blocked')
        throw error
      }
      if (journal && durableStarted) {
        try { journal.append('BLOCKED', { code: error.code ?? 'DIRECT_EXECUTION_UNKNOWN_OR_FAILED' }) } catch { /* Keep the prior durable fence; never replace it with a guessed outcome. */ }
      }
      if (trace) this.publish('blocked')
      if (trace) {
        if (handle) trace.events = structuredClone(handle.agent.session.snapshotEvents())
        if (execution) {
          try { await execution.close() } catch (cleanupError) { trace.cleanupError = cleanupError.code ?? 'DIRECT_RUNTIME_CLEANUP_FAILED' }
          trace.executionEvents = structuredClone(execution.agent.session.snapshotEvents())
        }
        trace.status = trace.status === 'TIMEOUT_UNKNOWN' ? trace.status : 'EXECUTION_UNKNOWN_OR_FAILED'
        trace.error = { code: error.code ?? 'DYNAMIC_CONTEXT_RUN_FAILED',
          message: this.config.transport === 'direct' ? (error.code ?? 'Direct task execution failed') : error.message }
        if (contract?.violation) trace.contractRejection = contract.violation
        this.saveTrace(runDirectory, trace, traceSaved ? 'failure.json' : 'trace.json', journal)
      }
      throw error
    } finally {
      clearTimeout(timer)
      if (onAbort) signal?.removeEventListener('abort', onAbort)
      try { if (handle) await handle.dispose(); if (execution) await execution.close() }
      finally { removeModelGuard?.(); await lease?.release(); this.current = null; this.busy = false; resolveDrained() }
    }
  }
  saveTrace(directory, trace, fileName = 'trace.json', journal) {
    const stored = this.config.direct?.tracePayloads === 'references' && journal ? journal.externalizeTrace(trace) : trace
    const file = path.join(directory, fileName), bytes = JSON.stringify(stored, null, 2) + '\n'
    const temporary = path.join(directory, `.trace-${randomUUID()}.tmp`)
    const fd = fs.openSync(temporary, 'wx', 0o600)
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    fs.renameSync(temporary, file)
    const dir = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY)
    try { fs.fsyncSync(dir) } finally { fs.closeSync(dir) }
    return { kind: 'artifact', ref: file, sha256: sha256(bytes) }
  }
  async close() { this.closed = true; if (this.current) await this.current.dispose(); if (this.busy) await this.drained; this.listeners.clear() }
}

export { DynamicContextRuntime as DynamicContextPrototype }

export function apply(ctx, config) {
  if (config?.enabled === false) return
  const service = new DynamicContextRuntime(ctx, config)
  ctx.provide('dynamicContext', service)
  if (service.config.interaction.mode === 'interactive') {
    service.interaction = new SessionInteraction(ctx, service, options => new DynamicContextRuntime(ctx, options))
    service.interaction.install()
  } else {
    if (service.config.exposeControlTools) registerControlTools(ctx, service)
    ctx.effect(() => connectTaskGraph(ctx, service))
  }
  ctx.on('dispose', async () => { await service.interaction?.close(); await service.close() })
}
