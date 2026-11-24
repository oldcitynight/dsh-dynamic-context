import { IMAGE_READ_INSTRUCTION } from './image-content.mjs'
import { activeOriginRevision } from './suspension.mjs'
// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs'
import { needsReleaseUpdate } from 'dsh-better-task-grapth/workflow-compatibility'
import { readPluginVersions, readPluginVersionsSync, readWorkflowRelease, readWorkflowReleaseSync } from './recovery-versions.mjs'
import { acceptanceEnabled, archiveCorrectionInput, CORRECTION_SOURCE_TOOL } from './acceptance-protocol.mjs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { SessionId, appendPluginRecord } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import { DynamicContextGraph, fail } from './core.mjs'
import { canonical, digest } from 'dsh-better-task-grapth/core'
import { bridge, adapterReady, composeHooks } from './adapter-bridge.mjs'
import { RequestContract, executionInstructions, deepFreeze, taskPrompt, toolFingerprint, wireTools } from './request-policy.mjs'
import { TOOL_ERROR_POLICY_SERVICE, toolErrorBlock, toolErrorBlocked } from './tool-error-policy.mjs'
import { directConnection, validateConnection } from './direct-connection.mjs'
import { ROLE_MODELS_SERVICE, bindRoleModel, roleReasoningSource } from './role-models.mjs'
import { createRolePolicies, inlineRolePolicySchema, toolPolicyInterface, TOOL_POLICIES_SERVICE } from './role-configuration.mjs'
import { ROLE_PROMPTS_SERVICE, ROLE_TOOLS_SERVICE, rolePrompt, roleTools, roleScope, unitBindingTools } from './role-policy.mjs'
import { applicableGuidance } from './guidance-state.mjs'
import { executionReportDraft, EXECUTION_REPORT_TOOLS } from './execution-report-tools.mjs'
import { runDirect } from './direct-channel.mjs'
import { ExecutionOutput } from './execution-output.mjs'
import { RequestPerformance } from './performance.mjs'
import { directRuntimeSchema, prepareDirectRuntime } from './direct-runtime.mjs'
import { registerControlTools } from './control-tools.mjs'
import { draftsFor } from './rule-editor.mjs'
import { openWorkflowStorage, hasFrozenWorkflow, admitWorkflowRelease, hasStored, graphView, writeStored } from './workflow-io.mjs'
import { DirectJournal, acquireDirectLease } from './durable-store.mjs'
import { connectTaskGraph, requireTaskGraph } from './interop.mjs'
import { SessionInteraction } from './interaction.mjs'
import { GRAPH_COMMIT_RECORD } from './graph-presence.mjs'
import { apiParameters, measureInput, resolveReasoningPolicy } from './api-protocol.mjs'
import { prepareDirectRequest } from './direct-wire.mjs'
import { reconcileActive, collectOrphans } from './administration.mjs'
import { revisionPolicySchema } from './revision.mjs'
import { reviseWorkflow, revisionRecoveryState, abandonRevisionRole } from './revision-runtime.mjs'
import { continueSupervision, superviseResult, supervisionAuthority, assertAuthority, executionFacts } from './supervision-runtime.mjs'
import { isHierarchical } from 'dsh-better-task-grapth/hierarchy'
import { beginHierarchyBlockage, routeReadyUnit } from './hierarchy-runtime.mjs'
import { handleBlockage } from './blockage-runtime.mjs'
import { DEFAULT_MAX_TOKENS } from '@deepseek-ai/dsh-llm-deepseek'
import { recoverDirectCheckpoint } from './recovery.mjs'
import { settingsConfig, readPreferences, deploymentConfig } from './settings.mjs'
import { workflowLimitsSchema, profileUnitLimitReader } from './unit-limits.mjs'
import { nativeLeafImageAvailable } from './image-content.mjs'
import { INHERITED_REPORT_READER, chooseRoleEvidence, inheritedReportCandidate } from './role-input-index.mjs'
import { rolePressureTokens } from './role-context.mjs'
let legacyCompatibility
function knownRecoveryBuilds() {
  return legacyCompatibility ??= JSON.parse(fs.readFileSync(new URL('./recovery-compatibility.json', import.meta.url), 'utf8'))
}

export const name = 'dsh-dynamic-context'
import { assertPreloadBudget } from './role-policy.mjs'
import { executionMaterial, materialBundle, materialView, materialLimit, localSourceSchema, readLocalSource } from './context-budget.mjs'
import { COMPACTION_INSTRUCTION, directContextWindow, nativeCompactSpec } from './dsh-compaction-policy.mjs'

async function indexInheritedReports({ assembly, config, ctx, meter, journal, signal, schemas }) {
  const candidate = inheritedReportCandidate(assembly.inheritedReports)
  if (!candidate) return { decision: { mode: 'inline', basis: 'no-savings' } }
  const payload = value => ({
    ...config.direct.generation, ...apiParameters(config.direct), model: config.model,
    messages: [{ role: 'system', content: config.systemPrompt }, { role: 'user', content: taskPrompt(value) }],
    tools: wireTools(schemas), max_tokens: config.maxOutputTokens, stream: true, stream_options: { include_usage: true },
  })
  const full = payload(assembly)
  const index = { archiveId: '0'.repeat(64), cards: candidate.cards }
  const indexed = payload({ ...assembly, inheritedReportIndex: index })
  const fullWire = await prepareDirectRequest(full, config, ctx, signal)
  const indexedWire = await prepareDirectRequest(indexed, config, ctx, signal)
  const window = directContextWindow(config)
  const pressure = config.direct.compaction?.strategy === 'dsh-native'
    ? nativeCompactSpec(window, config.maxOutputTokens).thresholdTokens : window ? window - config.maxOutputTokens : Infinity
  const threshold = Math.min(pressure, config.maxInputTokens ?? Infinity)
  const decision = await chooseRoleEvidence({ full, indexed, dynamicMaterialBytes: materialLimit(config),
    threshold: Number.isFinite(threshold) ? threshold : null, maxRequestBytes: config.direct.maxRequestBytes,
    fullBytes: Buffer.byteLength(JSON.stringify(fullWire)), indexedBytes: Buffer.byteLength(JSON.stringify(indexedWire)),
    measure: async value => rolePressureTokens(value, await measureInput(meter, value === full ? fullWire : indexedWire, signal)),
  })
  if (decision.mode === 'inline') return { decision }
  const archive = journal.archive(candidate.messages)
  return { decision: { ...decision, indexedReports: candidate.cards.length },
    index: { ...index, archiveId: archive.id } }
}
export const inject = ['agents', 'sessions', 'sessionProjections', 'tools', 'systemPrompt', 'llm', 'tokenMeter', 'transactionGraph']
const currentConfig = z.object({ storageFormat: z.enum(['auto','files','sqlite']).optional(), projectRoot: z.string(), storageRoot: z.string().optional(), directory: z.string(),
  enabled: z.boolean().default(true),
  rolePolicyFile: z.string().trim().min(1).optional(),
  rolePolicy: inlineRolePolicySchema.optional(),
  workflowLimits: workflowLimitsSchema,
  hierarchy: z.object({ maxGroupDepth: z.number().int().positive() }).strict().optional(),
  provider: z.string().min(1), model: z.string().min(1),
  transport: z.enum(['native-guarded', 'direct']),
  direct: directConnection.extend({
    agentlessTools: z.array(z.string()).refine(values => new Set(values).size === values.length).default([]),
    runtime: directRuntimeSchema.optional(),
    durable: z.boolean().default(false),
    tracePayloads: z.enum(['inline', 'references']).default('inline'),
    maxJournalBytes: z.null().default(null),
    contextWindow: z.number().int().min(131072).max(1048576).optional(),
    compaction: z.union([z.object({ strategy: z.literal('dsh-native'), contextWindow: z.number().int().min(131072).max(1048576) }).strict(),
      z.object({ triggerCharacters: z.number().int().min(1024).max(256000),
      retainRecentExchanges: z.number().int().min(0).max(4).default(0),
      maxCompactions: z.number().int().min(1).max(8).default(4),
      maxCheckpointCharacters: z.number().int().min(1024).max(64000).default(12000),
    }).strict()]).optional(),
    maxRequestBytes: z.number().int().positive().nullable().default(null),
    maxResponseBytes: z.number().int().positive().nullable().default(null),
    streamIdleTimeoutMs: z.number().int().min(1).max(2147483647).optional(),
    reserveFinalReport: z.boolean().default(false),
  }).strict().superRefine(validateConnection).optional(),
  systemPrompt: z.string().min(1), allowedTools: z.array(z.string()).default([]),
  exposeControlTools: z.boolean().default(true),
  interaction: z.object({ mode: z.enum(['interactive', 'host']).default('interactive'),
    orchestration: z.boolean().default(true), commandMode: z.enum(['full', 'ask', 'task-graph', 'native']).optional() }).strict().default({ mode: 'interactive', orchestration: true }),
  supervision: z.boolean().default(false),
  preplanningAcceptance: z.boolean().optional(),
  unitFinalReport: z.boolean().default(true),
  supervisionContext: z.enum(['reports', 'legacy']).default('reports'),
  revision: z.object({ policy: revisionPolicySchema,
    maxOutputTokens: z.number().int().min(1).max(393216).default(DEFAULT_MAX_TOKENS) }).strict().optional(),
  interop: z.object({ enabled: z.literal(true).default(true), workflowId: z.string().regex(/^[a-z][a-z0-9_-]{0,79}$/).optional() }).strict().default({ enabled: true }),
  maxInputTokens: z.number().int().min(1).max(1000000).optional(),
  maxOutputTokens: z.number().int().min(1).max(393216).default(512),
  maxRequestsPerTask: z.number().int().min(1).max(256).nullable().default(4),
  timeoutMs: z.number().int().min(10).max(1800000).nullable().default(10000),
}).strict().superRefine((config, ctx) => {
  if (config.interaction.mode === 'interactive' && config.transport !== 'direct')
    ctx.addIssue({ code: 'custom', message: 'Interactive graph selection requires the direct route; native-guarded is a host-only development comparison' })
  if (config.transport !== 'direct' && [config.maxRequestsPerTask, config.timeoutMs].includes(null))
    ctx.addIssue({ code: 'custom', message: 'Explicitly disabled extra limits require the direct route' })
  if (config.direct?.reserveFinalReport && config.maxRequestsPerTask === null)
    ctx.addIssue({ code: 'custom', message: 'A reserved final request requires a finite request limit' })
  if (config.direct?.tracePayloads === 'references' && !config.direct.durable)
    ctx.addIssue({ code: 'custom', message: 'Referenced trace payloads require durable request storage' })
  if (config.transport === 'direct' && !config.direct) ctx.addIssue({ code: 'custom', message: 'Direct transport requires an explicit endpoint' })
  if (config.supervision && (config.transport !== 'direct' || !config.direct?.durable || !config.revision))
    ctx.addIssue({ code: 'custom', message: 'Supervision requires the durable direct route and a revision policy' })
  if (config.direct?.agentlessTools.some(name => !config.allowedTools.includes(name))) ctx.addIssue({ code: 'custom', message: 'Direct agentless tools must be a subset of host allowedTools' })
  if (config.exposeControlTools && config.transport !== 'direct') ctx.addIssue({ code: 'custom', message: 'Controller tools require the direct route' })
  if (config.direct?.compaction?.strategy === 'dsh-native' && !config.direct.durable)
    ctx.addIssue({ code: 'custom', message: 'Native compaction requires durable request and archive storage' })
  if (config.direct?.compaction && config.direct.compaction.strategy !== 'dsh-native' && (!config.direct.durable || !config.direct.runtime?.modules.includes('state')
      || !config.allowedTools.includes('dynamic_context_source_read'))) ctx.addIssue({ code: 'custom', message: 'Compaction requires durability, the state module and an explicitly allowed source reader' })
  if (config.direct?.compaction && config.direct.compaction.maxCheckpointCharacters >= config.direct.compaction.triggerCharacters)
    ctx.addIssue({ code: 'custom', message: 'Checkpoint limit must be smaller than the history trigger' })
  if (config.maxInputTokens && config.transport !== 'direct') ctx.addIssue({ code: 'custom', message: 'Explicit input token budgets require the direct meter port' })
})
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
// Profiles from older packages may still contain retired quotas.
const configSchema = z.preprocess(input => {
  if (!input || typeof input !== 'object') return input
  const { maxLeafTasks, maxStateBytes, maxContextCharacters, maxReportCharacters, dynamicContextMaxBytes, ...config } = input
  const workflowLimits = { ...(config.hierarchy ? { maxDepth: config.hierarchy.maxGroupDepth } : {}),
    ...(dynamicContextMaxBytes === undefined ? {} : { dynamicMaterialBytes: dynamicContextMaxBytes }), ...config.workflowLimits }
  const normalized = { ...config, workflowLimits }
  if (normalized.direct) {
    normalized.direct = { ...normalized.direct, maxJournalBytes: null }
    for (const key of ['runtime', 'compaction', 'thinking']) if (normalized.direct[key] === null) delete normalized.direct[key]
  } else if (normalized.direct === null) delete normalized.direct
  if (normalized.revision === null) delete normalized.revision
  return normalized
}, currentConfig)
export const validateConfig = input => configSchema.parse(input)
export const Config = settingsConfig(validateConfig, Object.keys(currentConfig.shape).filter(key => key !== 'hierarchy'))
export function durableConfigHash(config, meter, implementation) {
  // Admission and storage limits do not determine executor inputs or permissions.
  const { workflowLimits: { maxUnits, maxDepth, ...materialLimits }, ...rest } = config
  const executionConfig = { ...rest, workflowLimits: materialLimits }
  return digest({ config: JSON.parse(JSON.stringify(executionConfig)), meter: meter ? { version: meter.version, implementation: sha256(Function.prototype.toString.call(meter.measure)),
    observer: meter.observe ? sha256(Function.prototype.toString.call(meter.observe)) : null } : null, code: implementation ?? readPluginVersionsSync() })
}

export async function observeDurableConfigHash(config, meter) {
  return durableConfigHash(config, meter, await readPluginVersions())
}

function checkCheckpointRelease(checkpoint, installed, versionFallback) {
  if (Object.hasOwn(checkpoint, 'workflowCompatibilityEpoch')) {
    needsReleaseUpdate(checkpoint, installed)
    return
  }
  const expected = Object.hasOwn(checkpoint, 'pluginVersions') ? checkpoint.pluginVersions : versionFallback
  if (expected !== undefined && canonical(expected) !== canonical(installed.pluginVersions))
    fail('DIRECT_RESUME_CONFIGURATION_CHANGED', { path: '/continuation/pluginVersions', expected, observed: installed.pluginVersions,
      reason: 'An untagged checkpoint requires the exact saved versions for its first admission.' })
}

// Hash-only checkpoints predate package identities. Reconstruct their digest from the
// recorded source vectors and the current execution settings without opening old sources.
function matchLegacyCheckpoint(savedHash, config, meter, versions, recover) {
  const { versionTransition, previousCode, permissionInheritanceCode } = knownRecoveryBuilds()
  if (canonical(versionTransition.pluginVersions) !== canonical(versions)) return
  if (durableConfigHash(config, meter, versionTransition.previousCode) === savedHash) return { inputsAndPolicyUnchanged: true }
  if (!recover) return
  for (const code of previousCode) {
    if (durableConfigHash(config, meter, code) === savedHash) return { inputsAndPolicyUnchanged: true }
    if (!permissionInheritanceCode?.includes(new Map(code).get('index.mjs'))
      || config.direct?.runtime?.sandboxMode !== 'auto' || config.direct.runtime.approvalPolicy !== 'auto') continue
    const prior = structuredClone(config)
    prior.direct.runtime.sandboxMode = 'workspace-write'; prior.direct.runtime.approvalPolicy = 'ask'
    if (durableConfigHash(prior, meter, code) === savedHash) return {
      inputsAndPolicyUnchanged: false, otherConfigurationUnchanged: true,
      permissionMigration: { from: { sandboxMode: 'workspace-write', approvalPolicy: 'ask' }, to: { sandboxMode: 'auto', approvalPolicy: 'auto' } },
    }
  }
}

/** Serial runner with a guarded native route or an explicitly configured direct HTTP route. */
export class DynamicContextRuntime {
  constructor(ctx, config, toolErrorPolicy, roleRegistries = {}) {
    const executionConfig = configSchema.parse(config)
    this.ctx = ctx; this.config = deepFreeze(executionConfig)
    this.taskGraph = requireTaskGraph(ctx)
    const prompts = roleRegistries.prompts ?? ctx.get(ROLE_PROMPTS_SERVICE)
    const tools = roleRegistries.tools ?? ctx.get(ROLE_TOOLS_SERVICE)
    const errors = toolErrorPolicy ?? ctx.get(TOOL_ERROR_POLICY_SERVICE)
    const models = roleRegistries.models ?? ctx.get(ROLE_MODELS_SERVICE)
    const fallback = prompts && tools && errors && models ? null : createRolePolicies(this.config)
    this.rolePrompts = prompts ?? fallback.prompts
    this.roleTools = tools ?? fallback.tools
    this.roleModels = models ?? fallback.models
    this.toolErrorPolicy = errors ?? fallback.errors
    this.workflowId = this.config.interop.workflowId ?? `workflow_${digest(this.config.directory).slice(0, 40)}`
    // Conversation mode has a template runner plus one private runner per mounted workflow.
    const template = this.config.interaction.mode !== 'host' && !this.config.interop.workflowId
    this.storage = template ? null : openWorkflowStorage(this.config)
    try {
      if (!template && hasFrozenWorkflow(this.config, this.storage)) {
        // Opening an existing graph adopts a compatible upgrade even when the next unit is idle.
        // Keep blocked graphs inspectable and isolate admission failures to this workflow.
        try { this.admitWorkflowRelease() } catch (error) { if (!this.workflowReleaseBlock) throw error }
      }
      this.graph = new DynamicContextGraph({ ...this.config,
        storeFactory: options => {
          const base = this.taskGraph.createExtensionStore(options)
          return this.storage ? graphView(base,options,this.storage.db) : base
        } })
    } catch (error) { this.storage?.close(); throw error }
    this.busy = false; this.closed = false; this.current = null
    this.listeners = new Set()
    this.output = new ExecutionOutput(this.config.directory, code => ctx.logger?.warn?.(code))
  }
  assertBase() { if (this.closed) fail('DYNAMIC_CONTEXT_RUNNER_CLOSED'); return requireTaskGraph(this.ctx, this.taskGraph) }
  assertController(agent) {
    this.assertBase()
    if (this.config.interaction.mode !== 'host' && (!agent || agent !== this.controller
        || this.ctx.agents.get(agent.id) !== agent || this.interaction?.mode(agent) !== 'full')) fail('DYNAMIC_CONTEXT_FULL_MODE_REQUIRED')
  }
  graphPresence(inspection) {
    const presence = this.graph.store.recoveryPlan(inspection)
    if (presence.state === 'NEVER_CREATED' && this.controller?.session.snapshotEvents().some(event =>
      event.type === GRAPH_COMMIT_RECORD && event.ignorable && event.data.workflowId === this.workflowId))
      return { state: 'GRAPH_AND_WITNESS_LOST_AFTER_COMMIT', previouslyCommitted: true, recoveryRequired: true, canRestore: false }
    return presence
  }
  graphSnapshot(options) {
    const inspection = this.graph.store.inspect(options)
    const graphPresence = this.graphPresence(inspection)
    return { graphPresence, state: graphPresence.recoveryRequired ? null : this.graph.read(inspection) }
  }
  assertWorkflowVersion(state) {
    if (this.unitWorkflowVersion !== 2) return
    if (this.interaction && this.interaction.record(this.controller)?.unitWorkflowVersion !== 2 || state && state.graph.state.plan.hierarchy?.version !== 2)
      fail('LEGACY_WORKFLOW_UNSUPPORTED')
  }
  checkInitialCheckpointRelease(installed) {
    if (!this.config.direct?.durable) return
    const state = this.graphSnapshot().state
    if (!state?.graph.state.active) return
    const directory = this.activeRunDirectory(state)
    if (!hasStored(path.join(directory, 'continuation', 'record-1.json'))) return
    const journal = DirectJournal.open(directory, { attemptId: state.graph.state.active.attemptId })
    const record = journal.latestCheckpoint()
    if (!record) return
    const saved = journal.readCheckpoint(record).state
    // Keep an untagged paused graph eligible for its original installation.
    const fallback = !Object.hasOwn(saved, 'pluginVersions') && !Object.hasOwn(saved, 'workflowCompatibilityEpoch')
      ? knownRecoveryBuilds().versionTransition.pluginVersions : undefined
    checkCheckpointRelease(saved, installed, fallback)
  }
  admitWorkflowRelease(installed, options) {
    try {
      installed ??= readWorkflowReleaseSync()
      admitWorkflowRelease(this.config, this.storage, installed, { ...options,
        beforeFirstFreeze: () => this.checkInitialCheckpointRelease(installed) })
      this.workflowReleaseBlock = null
    } catch (error) {
      if (['WORKFLOW_COMPATIBILITY_EPOCH_MISMATCH', 'WORKFLOW_PLUGIN_DOWNGRADE', 'WORKFLOW_INVALID_FROZEN_RELEASE',
        'WORKFLOW_INVALID_COMPATIBILITY_EPOCH', 'DIRECT_INVALID_PLUGIN_VERSION'].includes(error.code))
        this.workflowReleaseBlock = { code: error.code, message: error.message, ...error.details }
      throw error
    }
  }
  assertGraphEvidence() {
    if (this.graphPresence().recoveryRequired) fail('GRAPH_RECOVERY_REQUIRED')
    if (this.unitWorkflowVersion === 2) this.assertWorkflowVersion(this.graph.read())
  }
  async restoreGraphs({ sourceAgent, expectedWitnessChecksum, signal } = {}) {
    this.assertController(sourceAgent); signal?.throwIfAborted()
    this.admitWorkflowRelease()
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
  reconcileActive(request) { this.assertController(request?.sourceAgent); this.assertGraphEvidence(); this.admitWorkflowRelease(); return reconcileActive(this, request) }
  collectOrphans(request) { this.assertController(request?.sourceAgent); this.assertGraphEvidence(); this.admitWorkflowRelease(); return collectOrphans(this, request) }
  revise(request) { this.assertController(request?.sourceAgent); this.assertGraphEvidence(); this.admitWorkflowRelease(); return reviseWorkflow(this, request) }
  async continueSupervision(request) {
    this.assertController(request?.sourceAgent)
    const { graphPresence, state } = this.graphSnapshot()
    if (graphPresence.recoveryRequired) fail('GRAPH_RECOVERY_REQUIRED')
    this.assertWorkflowVersion(state)
    this.admitWorkflowRelease()
    if (this.workflowControl) return continueSupervision(this, request, state)
    await this.refreshUnitLimit()
    return continueSupervision(this, request)
  }
  async refreshUnitLimit() {
    if (!this.readConfiguredUnitLimit) return
    if (this.busy || this.closed) fail('UNIT_LIMIT_UPDATE_BUSY')
    let maximum
    try { maximum = await this.readConfiguredUnitLimit() }
    catch {
      fail('UNIT_LIMIT_CONFIG_INVALID', { path: '/workflowLimits/maxUnits',
        reason: 'Check the DSH profile configuration. workflowLimits.maxUnits requires a positive integer.' })
    }
    if (this.busy || this.closed) fail('UNIT_LIMIT_UPDATE_BUSY')
    if (maximum !== undefined) this.graph.setMaxUnits(maximum)
  }
  handleBlockage(request) {
    this.assertController(request?.sourceAgent); this.assertGraphEvidence(); this.admitWorkflowRelease()
    if (!isHierarchical(this.graph.read()?.graph.state.plan)) return handleBlockage(this, request)
    if (this.busy || this.closed) fail('HIERARCHY_BLOCKAGE_BUSY')
    if (!beginHierarchyBlockage(this, request)) return Promise.resolve({ status: 'WAITING_USER' })
    const state = this.graph.read()
    return continueSupervision(this, { ...request, expectedRevision: state.revision, checkpointChecksum: state.checksum })
  }
  revisionRecovery() { return this.busy ? [] : revisionRecoveryState(this) }
  abandonRevisionRole(request) { this.assertBase(); this.assertGraphEvidence(); this.admitWorkflowRelease(); return abandonRevisionRole(this, request) }
  registerRevisionAccounting(adapter) {
    if (this.busy || this.revisionAccounting || typeof adapter?.beforeRequest !== 'function'
        || typeof adapter.afterResponse !== 'function' || typeof adapter.onFailure !== 'function') fail('REVISION_ACCOUNTING_ADAPTER_INVALID')
    this.revisionAccounting = adapter
    return () => { if (this.busy) fail('REVISION_ACCOUNTING_IN_USE'); if (this.revisionAccounting === adapter) this.revisionAccounting = null }
  }
  publish(type) {
    if(this.storage && ['paused','group-accepted','result-committed','task-reported'].includes(type))
      void this.storage.backupAtBoundary().catch(error=>this.ctx.logger?.warn?.('WORKFLOW_BACKUP_DEFERRED '+error.code))
    for (const callback of this.listeners) { try { callback({ type }) } catch (error) { this.ctx.logger?.warn?.(`dynamic context listener failed: ${error.code ?? error.name}`) } }
  }
  supervisionStatus(state = this.graph.read()) {
    const control = state?.supervision
    if (!control) return null
    return { phase: control.phase,
      ...(control.hierarchy ? { hierarchy: structuredClone(control.hierarchy) } : {}),
      ...(control.finalReport ? { finalReport: structuredClone(control.finalReport.report) } : {}),
      ...(control.phase === 'READY' ? {} : { checkpointChecksum: state.checksum, needsContinuation: true }),
      ...(control.feedback ? { feedback: control.feedback } : {}),
      outcomes: control.outcomes.map(row => ({
        taskId: row.taskId, attemptId: row.attemptId, revision: row.revision, outcome: row.result.outcome,
      })),
    }
  }
  status({ graphPresence, state } = this.graphSnapshot()) {
    if (this.workflowReleaseBlock) return { transport: this.config.transport, revision: state?.revision ?? 0, graphPresence,
      busy: this.busy, closed: this.closed, legalNext: [], code: this.workflowReleaseBlock.code, workflowReleaseBlock: this.workflowReleaseBlock }
    if (graphPresence.recoveryRequired) return { transport: this.config.transport, busy: this.busy, closed: this.closed,
      graphPresence, legalNext: [], recoveryRequired: true, code: 'GRAPH_RECOVERY_REQUIRED' }
    return { transport: this.config.transport, revision: state?.revision ?? 0, graphPresence,
      busy: this.busy, closed: this.closed, taskGraph: this.graph.status(state),
      unitLimit: this.graph.unitLimit(state),
      ...(this.config.supervision ? { supervision: this.supervisionStatus(state) } : {}),
      contextVersion: state?.contexts.version ?? null,
      revisionRecovery: this.revisionRecovery(),
      reportStates: (state?.reports ?? []).map(report => ({ taskId: report.taskId,
        task: state.graph.state.plan.nodes.find(node => node.id === report.taskId).key,
        contextVersion: report.contextVersion, validity: state.invalidatedReports?.includes(report.taskId) ? 'INVALIDATED' : 'UNVERIFIED' })),
      semanticAcceptance: 'NOT_EVALUATED',
      ...(this.config.direct?.durable ? { continuation: this.checkpointStatus(state) } : {}) }
  }
  activeRunDirectory(state) {
    const active = state?.graph.state.active
    const base = active && path.join(this.config.directory, active.attemptId)
    return state?.supervision?.correction ? base + '_' + state.supervision.correction.id : base
  }
  checkpointStatus(state = this.graph.read()) {
    const active = state?.graph.state.active
    if (!active || !this.config.direct?.durable) return null
    try {
      const journal = DirectJournal.open(this.activeRunDirectory(state), {
        taskId: active.nodeId, attemptId: active.attemptId, contextVersion: state.contexts.version,
        owner: active.owner, graphRevision: activeOriginRevision(state) })
      const { head, checkpoint } = journal.inspectHead()
      return { phase: head?.phase ?? 'NO_CHECKPOINT', checksum: head?.checksum ?? null,
        resumablePhase: (!state.supervision || ['READY', 'REWORK_RESULT'].includes(state.supervision.phase)) && ['READY', 'PAUSED', 'REPORT_READY'].includes(head?.phase),
        recoverable: (!state.supervision || ['READY', 'REWORK_RESULT'].includes(state.supervision.phase)) && Boolean(checkpoint),
        ...(head?.data?.toolErrorBlock ? { toolErrorBlock: head.data.toolErrorBlock, requiresHumanResume: true } : {}),
        exclusiveLeaseRequired: true,
        storageBytes: journal.usage(), maxJournalBytes: this.config.direct.maxJournalBytes }
    } catch (error) { return { phase: 'UNAVAILABLE', resumablePhase: false, error: error.code ?? 'DIRECT_CHECKPOINT_INVALID' } }
  }
  pauseActive({ expectedRevision } = {}) {
    this.assertBase()
    const { graphPresence, state } = this.graphSnapshot()
    if (graphPresence.recoveryRequired) fail('GRAPH_RECOVERY_REQUIRED')
    if (!this.config.direct?.durable || this.config.transport !== 'direct') fail('DIRECT_PAUSE_REQUIRES_DURABILITY')
    if (state?.revision !== expectedRevision || !this.busy || !this.current
        || state.supervision && (!state.graph.state.active || !['READY', 'REWORK_RESULT'].includes(state.supervision.phase))) fail('DIRECT_PAUSE_STALE_OR_NOT_RUNNING')
    this.pauseRequested = true
    return { status: 'PAUSE_REQUESTED', boundary: 'after a complete model/tool exchange' }
  }
  submit(proposal, { sourceAgent } = {}) {
    this.assertController(sourceAgent)
    this.assertGraphEvidence()
    if (this.unitWorkflowVersion === 2 && proposal.taskGraph?.hierarchy?.version !== 2) fail('LEGACY_WORKFLOW_UNSUPPORTED')
    if (this.config.supervision && this.config.supervisionContext === 'reports' && !proposal.planningReport) fail('SUPERVISION_PLANNING_REPORT_REQUIRED')
    if (this.closed || this.busy) fail('DYNAMIC_CONTEXT_RUNNER_UNAVAILABLE')
    const allowedTools = unitBindingTools(this)
    for (const binding of proposal?.contextGraph?.bindings ?? []) {
      const unauthorized = (binding.tools ?? []).filter(tool => !allowedTools.includes(tool))
      if (unauthorized.length) fail('CONTEXT_CANNOT_GRANT_TOOL_PERMISSION', {
        path: '/contextGraph/bindings/' + proposal.contextGraph.bindings.indexOf(binding) + '/tools', reason: 'A context binding cannot grant tools outside the host allowlist.', task: binding.task, field: 'contextGraph.bindings[].tools', unauthorized, allowedTools,
      })
      if (this.config.direct?.compaction && this.config.direct.compaction.strategy !== 'dsh-native' && !(binding.tools ?? []).includes('dynamic_context_source_read')) fail('DIRECT_COMPACTION_REQUIRES_SOURCE_READER_BINDING')
      if (this.config.transport === 'direct' && !this.config.direct.runtime && (binding.tools ?? []).some(tool => !this.config.direct.agentlessTools.includes(tool))) fail('DIRECT_TOOL_REQUIRES_EXPLICIT_AGENTLESS_PERMISSION')
    }
    if (proposal.planningReport?.verification && (this.config.transport !== 'direct' || !this.config.direct?.durable || !this.config.direct.runtime || this.config.supervisionContext !== 'reports' || !proposal.taskGraph.hierarchy)) fail('ACCEPTANCE_PROTOCOL_REQUIRES_HIERARCHICAL_DURABLE_REPORTS', {
      path: '/planningReport/verification', reason: 'Verification v1 requires a hierarchical task graph, report supervision, durable direct transport and its native execution host for scoped correction evidence access.' })
    if (proposal.taskGraph?.ruleVersion || this.ruleDrafts?.read().targets.length) proposal=draftsFor(this).bind(proposal)
    this.admitWorkflowRelease()
    const result = this.graph.submit(proposal,proposal.taskGraph?.ruleVersion ? () => draftsFor(this).read().approval : undefined)
    if (sourceAgent) appendPluginRecord(sourceAgent.session, GRAPH_COMMIT_RECORD, { workflowId: this.workflowId,
      graphId: result.graph.state.plan.id, firstChecksum: result.checksum, revision: result.revision })
    this.publish('created'); return result
  }
  /** Execute one ready leaf. Any uncertain execution keeps ACTIVE and blocks automatic replay. */
  runNext(options = {}) { return this.execute({ ...options, resume: false }) }
  async resumeActive(options = {}) {
    if (!this.workflowControl) await this.refreshUnitLimit()
    return this.execute({ ...options, resume: true })
  }
  async execute({ expectedRevision, choice = 0, signal, sourceAgent, routeOnly = false, pauseAfterRequests, checkpointChecksum, resume, recover = false, correction = false, correctionChecksum, acknowledgeToolError } = {}) {
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
    let lease, journal, continuation, configHash, installedRelease, pluginVersions, authorityHash, correctionInput, durableStarted = false, supervising = false
    this.pauseRequested = false
    this.current = { sourceAgent, dispose: async () => { control.abort(new Error('DYNAMIC_CONTEXT_RUNNER_CLOSED')) } }
    onAbort = () => { control.abort(signal.reason); if (handle) void handle.dispose() }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      if (this.config.transport === 'direct' && this.config.direct.durable) {
        lease = await acquireDirectLease(this.config.directory)
        installedRelease = await readWorkflowRelease()
        pluginVersions = installedRelease.pluginVersions
        this.admitWorkflowRelease(installedRelease, { checkOnly: resume })
        configHash = durableConfigHash(this.config, this.inputMeter, pluginVersions)
      } else this.admitWorkflowRelease()
      control.signal.throwIfAborted()
      const initialState = this.config.supervision || resume ? this.graph.read() : null
      if (this.config.supervision) {
        const state = initialState
        correction ||= acceptanceEnabled(state) && state.supervision.phase === 'REWORK_RESULT'
        if (state && state.supervision.phase !== 'READY' && !correction) fail('SUPERVISION_SCHEDULING_BLOCKED')
        if (correction && (!acceptanceEnabled(state) || state.supervision.phase !== 'REWORK_RESULT' || state.revision !== expectedRevision
          || correctionChecksum && state.checksum !== correctionChecksum)) fail('SUPERVISION_CORRECTION_STALE')
        authorityHash = supervisionAuthority(this, sourceAgent)
        if (state?.unitRoleVersion && !resume && !correction) {
          if (revisionRecoveryState(this).length && !this.workflowControl?.recoverModel) fail('REVISION_UNKNOWN_ROLE_REQUIRES_RECONCILIATION')
          const routed = await routeReadyUnit(this, state, expectedRevision, choice, authorityHash, control.signal,
            (pinned = authorityHash) => assertAuthority(this, pinned, sourceAgent, control.signal))
          if (routed) return routed
          if (routeOnly) return { status: 'UNIT_READY' }
          if (this.workflowControl) this.activity = { stage: 'EXECUTING', kind: 'boundary', sessionId: null, step: 0, tool: null, at: new Date().toISOString() }
        }
      }
      if (routeOnly) fail('UNIT_ROUTE_NOT_READY')
      if (resume) {
        const state = initialState, active = state?.graph.state.active
        if (state?.revision !== expectedRevision || !active) fail('DIRECT_RESUME_STALE_OR_DIFFERENT_ATTEMPT')
        runDirectory = this.activeRunDirectory(state)
        journal = DirectJournal.open(runDirectory, { taskId: active.nodeId, attemptId: active.attemptId,
          contextVersion: state.contexts.version, owner: active.owner, graphRevision: activeOriginRevision(state) })
        const boundary = journal.inspectHead(), { head } = boundary
        if (head?.checksum !== checkpointChecksum) fail('DIRECT_RESUME_CHECKPOINT_CHANGED')
        if (head.data?.toolErrorBlock && acknowledgeToolError !== head.checksum)
          fail('DIRECT_TOOL_ERROR_BLOCKED', head.data.toolErrorBlock)
        if (recover && !['READY', 'PAUSED', 'REPORT_READY'].includes(head.phase)) {
          const recovered = await recoverDirectCheckpoint({ journal, ctx: this.ctx, signal: control.signal, boundary })
          continuation = recovered.state
        } else {
          continuation = await journal.loadResumeCheckpoint(head, { hydratePayloads: this.config.direct.tracePayloads !== 'references', signal: control.signal })
          journal.assertHeadUnchanged(head)
        }
        const versioned = Object.hasOwn(continuation, 'pluginVersions')
        checkCheckpointRelease(continuation, installedRelease)
        // Authenticate settings and meter against the versions used to create the saved hash.
        const savedSettingsHash = versioned && canonical(continuation.pluginVersions) !== canonical(pluginVersions)
          ? durableConfigHash(this.config, this.inputMeter, continuation.pluginVersions) : configHash
        if (continuation.configHash !== configHash || continuation.configHash !== savedSettingsHash) {
          const migration = versioned ? continuation.configHash === savedSettingsHash && { inputsAndPolicyUnchanged: true }
            : matchLegacyCheckpoint(continuation.configHash, this.config, this.inputMeter, pluginVersions, recover)
          if (!migration) fail('DIRECT_RESUME_CONFIGURATION_CHANGED', {
            path: '/continuation/configHash', expected: continuation.configHash, observed: configHash,
            reason: 'The checkpoint does not match the current execution settings, input meter or a known legacy build. This mismatch alone does not prove that the model changed.',
          })
          continuation.trace.events.push({ seq: continuation.trace.events.length, time: Date.now(), type: 'task/code-migration',
            data: { from: continuation.configHash, to: configHash, ...installedRelease, previousPluginVersions: continuation.pluginVersions, ...migration } })
          continuation.configHash = configHash
        }
        if (!Number.isSafeInteger(continuation.nextStep) || continuation.nextStep < 0 || this.config.maxRequestsPerTask !== null && continuation.nextStep > this.config.maxRequestsPerTask) fail('DIRECT_RESUME_STATE_INVALID')
        this.admitWorkflowRelease(installedRelease)
        journal.restoreArchives(continuation.archives)
        this.graph.adoptCheckpoint({ expectedRevision, attemptId: active.attemptId, owner: active.owner })
      } else if (!correction) this.graph.begin({ expectedRevision, choice })
      else { const state = this.graph.read(); this.graph.adoptCheckpoint({ expectedRevision, attemptId: state.graph.state.active.attemptId, owner: state.graph.state.active.owner }) }
      this.publish(resume ? 'resumed' : 'begun')
      const mayIndex = Boolean(lease && !continuation && !correction)
      let assembly = this.graph.assemble(continuation?.assembly)
      if (continuation?.assembly.inheritedReportIndex) assembly = { ...assembly, inheritedReportIndex: continuation.assembly.inheritedReportIndex }
      if (continuation?.assembly.materialSummary) assembly.materialSummary = continuation.assembly.materialSummary
      const background = !continuation && materialBundle(assembly, materialLimit(this.config), executionMaterial)
      if (background && !lease) fail('EXECUTION_MATERIAL_READER_REQUIRED', { tool: INHERITED_REPORT_READER })
      if (correction) {
        assembly = { ...assembly, tools: [...new Set([...assembly.tools, CORRECTION_SOURCE_TOOL])] }
        if (continuation) assembly = { ...assembly, correction: continuation.assembly.correction }
        else {
          const state = this.graph.read(), request = state.supervision.correction
          correctionInput = { request, feedback: state.supervision.feedback, facts: executionFacts(this, request.previousReport, control.signal, state) }
        }
      }
      // Archive navigation is a host-owned read capability for the current
      // execution, independent of task-graph business tool permissions.
      const localSource = !this.config.direct?.runtime && (background || assembly.materialSummary) ? localSourceSchema.name : null
      const nativeArchiveTools = localSource ? [localSource] : this.config.transport === 'direct' && this.config.direct?.runtime
        && (this.config.direct.compaction?.strategy === 'dsh-native' || assembly.unitBaseline || assembly.interruptedWork || background || assembly.materialSummary)
        ? (continuation ? continuation.assembly.tools.filter(name => ['dynamic_context_source_read', 'dynamic_context_source_search'].includes(name))
          : ['dynamic_context_source_read', 'dynamic_context_source_search']) : []
      if (nativeArchiveTools.length) assembly = { ...assembly, tools: [...new Set([...assembly.tools, ...nativeArchiveTools])] }
      const formattedReports = this.config.transport === 'direct' && this.config.direct.runtime && (continuation ? continuation.assembly.formattedReports : Boolean(assembly.reportProtocol || assembly.completion))
      if (formattedReports) assembly = { ...assembly, formattedReports: true, tools: [...new Set([...assembly.tools, ...EXECUTION_REPORT_TOOLS])] }
      // New invocations receive visual evidence access independently of graph
      // authoring. A resumed frozen invocation retains its exact prior tools.
      const imageTools = continuation
        ? this.config.transport === 'direct' && this.config.direct.runtime?.modules.includes('filesystem') && continuation.assembly.imageTools
        : nativeLeafImageAvailable(this.ctx, this.config)
      if (imageTools) assembly = { ...assembly, imageTools: true, tools: [...new Set([...assembly.tools, 'read_image'])] }
      if (imageTools && (continuation ? continuation.assembly.compactionImageTools === false
        : !roleTools(this).select('compaction', ['read_image'], roleScope(this, { task: assembly.task })).allowed.includes('read_image')))
        assembly = { ...assembly, compactionImageTools: false }
      if (continuation?.assembly.interruptedWork) assembly = { ...assembly, interruptedWork: continuation.assembly.interruptedWork }
      const executionRole = correction ? 'result_work' : 'executor'
      const promptPolicy = continuation ? continuation.assembly.rolePrompt ?? { contributions: [] } : rolePrompt(this, executionRole, executionInstructions(assembly), { task: assembly.task })
      if (promptPolicy.contributions.length) assembly = { ...assembly, rolePrompt: promptPolicy, ...(!continuation || continuation.assembly.roleContextVersion === 2 ? { roleContextVersion: 2 } : {}) }
      const compactPrompt = continuation ? continuation.assembly.compactionPrompt ?? { contributions: [] } : rolePrompt(this, 'compaction', COMPACTION_INSTRUCTION, { task: assembly.task })
      if (compactPrompt.contributions.length) assembly = { ...assembly, compactionPrompt: compactPrompt }
      const registry = roleTools(this), policyScope = roleScope(this, { task: assembly.task })
      const compactTools = continuation?.assembly.compactionToolPolicy ?? registry.select('compaction', ['read_image'], policyScope, this.config.projectRoot)
      if (!continuation && imageTools && compactTools.policies.length) assembly = { ...assembly, compactionToolPolicy: compactTools }
      if (continuation?.assembly.compactionToolPolicy) assembly = { ...assembly, compactionToolPolicy: compactTools }
      const imagePrompt = continuation ? continuation.assembly.compactionImagePrompt : imageTools && rolePrompt(this, 'compaction', IMAGE_READ_INSTRUCTION, { task: assembly.task }, 'image')
      assertPreloadBudget(compactPrompt, imagePrompt)
      if (imagePrompt?.contributions?.length) assembly = { ...assembly, compactionImagePrompt: imagePrompt }
      const toolsPolicy = continuation ? continuation.assembly.roleToolPolicy ?? { policies: [] } : roleTools(this).select(executionRole, assembly.tools, roleScope(this, { task: assembly.task }), this.config.projectRoot)
      if (toolsPolicy.policies.length || toolsPolicy.allowed && toolsPolicy.allowed.length !== assembly.tools.length) assembly = { ...assembly, tools: [...toolsPolicy.allowed], roleToolPolicy: toolsPolicy }
      const issuedTools = assembly.roleToolPolicy ?? { role: executionRole, scope: policyScope, allowed: assembly.tools, policies: [] }
      const admitCall = (name, args) => args === undefined
        ? issuedTools.allowed.includes(name) && registry.select(executionRole, [name], policyScope, this.config.projectRoot).allowed.includes(name)
        : registry.admits(issuedTools, name, args, this.config.projectRoot)
      const sessionId = SessionId(`dynamic-context-${randomUUID()}`)
      if (continuation && digest(assembly) !== digest(continuation.assembly)) fail('DIRECT_RESUME_CONTEXT_CHANGED')
      runDirectory = this.activeRunDirectory(this.graph.read())
      if (!resume) {
        if (correction) fs.mkdirSync(path.dirname(runDirectory), { recursive: true, mode: 0o700 })
        fs.mkdirSync(runDirectory, { mode: 0o700 })
      }
      trace = continuation ? structuredClone(continuation.trace) : { schema: 2, source: this.config.transport === 'direct' ? 'plugin-direct-http-task' : 'native-dsh-task-session',
        transport: this.config.transport, sessionId, assembly,
        requests: [], events: [], status: 'STARTED', semanticAcceptance: 'NOT_EVALUATED',
        ...(correction ? { executionSegment: this.graph.read().supervision.correction.id, previousReport: this.graph.read().supervision.correction.previousReport } : {}) }
      if (resume) {
        trace.resumptions ??= []; trace.resumptions.push({ fromSessionId: trace.sessionId, sessionId, checkpointChecksum, time: new Date().toISOString() })
        trace.sessionId = sessionId; trace.status = 'STARTED'
      }
      if (lease && !journal) {
        journal = new DirectJournal(runDirectory, { taskId: assembly.task.id, attemptId: assembly.task.attemptId,
          contextVersion: assembly.contextVersion, owner: this.graph.owner, graphRevision: this.graph.read().revision, sessionId })
        journal.append('PREPARING')
      }
      if (background) {
        if (!assembly.tools.includes(INHERITED_REPORT_READER)) fail('EXECUTION_MATERIAL_READER_REQUIRED', { tool: INHERITED_REPORT_READER })
        const archive = journal.archive([{ role: 'user', content: background.text }])
        const reader = { tool: INHERITED_REPORT_READER, arguments: { archive_id: archive.id, message_index: 0, field: 'content', offset: 0, length: 1024 } }
        const { materialSummary } = materialView(assembly, background, reader, materialLimit(this.config))
        assembly = { ...assembly, materialSummary: { ...materialSummary, omittedFields: background.cards.map(card => card.field) } }
        trace.assembly = assembly
      }
      if (assembly.interruptedWork) {
        if (continuation) assembly = { ...assembly, interruptedWork: continuation.assembly.interruptedWork }
        else {
          const { suspensionSource } = await import('./suspension.mjs')
          const saved = suspensionSource(this, { evidence: assembly.interruptedWork.evidence }, control.signal)
          const archive = journal.archive([{ role: 'user', content: JSON.stringify(saved) }])
          assembly = { ...assembly, interruptedWork: { ...assembly.interruptedWork, sourceRead: { archive_id: archive.id, message_index: 0, offset: 0, length: 8000, field: 'content' } } }
        }
        trace.assembly = assembly
      }
      if (correctionInput) {
        assembly = { ...assembly, correction: archiveCorrectionInput(journal, correctionInput.request, correctionInput.feedback, correctionInput.facts) }
        trace.assembly = assembly
      }
      const modelRoute = bindRoleModel(this, executionRole, policyScope, this.config,
        continuation ? continuation.trace.modelRoute ?? null : undefined)
      if (modelRoute.receipt) trace.modelRoute = modelRoute.receipt
      const reasoning = await resolveReasoningPolicy({ config: modelRoute.config, ctx: this.ctx,
        sourceAgent: roleReasoningSource(this.config, modelRoute.config, sourceAgent ?? this.controller),
        signal: control.signal, previous: continuation?.trace.reasoningPolicy })
      if (reasoning.receipt) trace.reasoningPolicy = reasoning.receipt
      const persist = () => this.saveTrace(runDirectory, trace, 'trace.json', journal)
      persist()
      signal?.throwIfAborted()
      if (this.config.timeoutMs !== null) timer = setTimeout(() => { trace.status = 'TIMEOUT_UNKNOWN'; control.abort(new Error('TASK_TIMEOUT')); if (handle) void handle.dispose() }, this.config.timeoutMs)
      const reportDraft = formattedReports ? executionReportDraft(this, trace, control.signal, persist, correctionInput?.facts?.tools) : null
      const allowedTools = unitBindingTools(this)
      if (this.config.transport === 'direct') execution = await prepareDirectRuntime({ ctx: this.ctx, config: reasoning.config,
        assembly, sessionId, sourceAgent, control, reportTools: reportDraft?.definitions ?? [], resumeState: continuation?.runtime, sourceReader: journal, correctionSource: correction, allowedTools,
        runtimeGuidance: base => {
          if (continuation) return trace.runtimePrompt?.content ?? base
          const snapshot = rolePrompt(this, executionRole, base, { task: assembly.task }, 'runtime')
          assertPreloadBudget(assembly.rolePrompt, snapshot)
          if (snapshot.contributions.length) trace.runtimePrompt = snapshot
          return snapshot.content
        },
        roleExtensions: roleTools(this).nativeDefinitions(executionRole, roleScope(this, { task: assembly.task }),
          { runner: this, sourceAgent, signal: control.signal, directory: runDirectory,
            savedToolSchemas: continuation && new Map([[executionRole, new Map((continuation.trace.contract?.schemas ?? []).map(row => [row.name, row]))]]) }),
        sharedContext: (args, callId) => this.graph.sharedContext(assembly, args, callId, trace.executionSegment), record: (type, data) => {
          trace.events.push({ seq: trace.events.length, time: Date.now(), type, data: structuredClone(data) }); persist()
        } })
      if (execution) this.current.agent = execution.agent
      const scope = execution?.agent, tools = this.ctx.tools.schemas(scope).map(tool => tool.name)
      if (localSource) tools.push(localSource)
      if (assembly.tools.some(tool => (!(correction && tool === CORRECTION_SOURCE_TOOL) && !nativeArchiveTools.includes(tool) && !(formattedReports && EXECUTION_REPORT_TOOLS.includes(tool)) && !allowedTools.includes(tool)) || !tools.includes(tool))) fail('TASK_TOOL_NOT_AVAILABLE')
      if (this.config.transport === 'direct' && !execution && assembly.tools.some(tool => tool !== localSource && !this.config.direct.agentlessTools.includes(tool))) fail('DIRECT_TOOL_REQUIRES_EXPLICIT_AGENTLESS_PERMISSION')
      const schemas = [...this.ctx.tools.schemas(scope).filter(tool => tool.name !== localSource), ...(localSource ? [localSourceSchema] : [])].filter(tool => assembly.tools.includes(tool.name)).map(tool => {
        if (this.config.transport !== 'direct') return tool
        const { deferLoading, ...schema } = tool
        return schema
      })
      const definitions = assembly.tools.map(name => [name, name === localSource ? { name, execute: readLocalSource } : this.ctx.tools.get(name, scope)])
      const requestConfig = deepFreeze(execution ? { ...reasoning.config, systemPrompt: continuation?.history[0]?.content ?? execution.systemPrompt } : reasoning.config)
      if (mayIndex && !assembly.materialSummary && assembly.inheritedReports.length && assembly.tools.includes(INHERITED_REPORT_READER)) {
        const { decision, index } = await indexInheritedReports({ assembly, config: requestConfig, ctx: this.ctx,
          meter: this.inputMeter, journal, signal: control.signal, schemas })
        trace.inheritedReportPlacement = decision
        if (index) {
          assembly = { ...assembly, inheritedReportIndex: index }
          trace.assembly = assembly
        }
      }
      const seed = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: taskPrompt(assembly) }] })
      contract = new RequestContract({ config: requestConfig, assembly, seed, schemas, definitions })
      if (continuation && toolFingerprint(contract) !== continuation.toolFingerprint) fail('DIRECT_RESUME_TOOL_DEFINITIONS_CHANGED')
      trace.contract = { hash: contract.hash, policy: structuredClone(requestConfig), systemPrompt: requestConfig.systemPrompt, seed: structuredClone(seed),
        schemas: structuredClone(schemas), provider: requestConfig.provider, model: requestConfig.model, maxOutputTokens: requestConfig.maxOutputTokens }
      if (execution) trace.executionHost = execution.facts
      persist()
      let reportText
      if (this.config.transport === 'direct') {
        durableStarted = true
        const startingStep = continuation?.nextStep ?? 0
        reportText = await runDirect({ ctx: this.ctx, config: requestConfig, contract, trace, control, persist, execution,
          journal, continuation, configHash, pluginVersions, workflowCompatibilityEpoch: installedRelease?.workflowCompatibilityEpoch, reportDraft, meter: this.inputMeter, output: this.output, toolErrorPolicy: this.toolErrorPolicy, executionRole,
          toolAdmission: admitCall,
          compactionToolAdmission: (name, args) => registry.admits(compactTools, name, args, this.config.projectRoot),
          beforeTool: () => this.workflowControl?.beforeTool?.(),
          userGuidance: () => applicableGuidance(this, executionRole, { task: assembly.task }),
          shouldPause: step => this.pauseRequested || this.workflowControl?.guidancePending?.() || pauseAfterRequests !== undefined && step - startingStep >= pauseAfterRequests })
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
        const nativeErrors = this.toolErrorPolicy.snapshot()
        let blockedTool
        handle = await this.ctx.agents.create({ sessionId, signal: control.signal,
          agentOptions: { provider: requestConfig.provider, model: requestConfig.model, maxTokens: requestConfig.maxOutputTokens },
          setup: async (agentCtx, agent) => {
            await agentCtx.plugin(NativeExecutor)
            appendPluginRecord(agent.session, 'plugin:dynamic-context/execution-host-v1',
              { taskId: assembly.task.id, contextVersion: assembly.contextVersion, transport: 'native-guarded' })
            agentCtx.tools.restrict({ allow: assembly.tools })
            agentCtx.tools.guard(exec => contract.checkExecution(exec, agentCtx.tools)
              ?? (blockedTool || !admitCall(exec.name, exec.arguments) ? 'ROLE_TOOL_DENIED' : undefined))
            agentCtx.on('tools/result', (exec, result) => {
              contract.recordToolResult(exec, result)
              blockedTool ??= toolErrorBlock(nativeErrors, result, { role: executionRole, toolId: exec.name, callId: exec.callId })
              if (blockedTool) exec.agent.cancel({ kind: 'user' }, { keepInbox: true })
            })
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
        if (blockedTool) throw toolErrorBlocked(blockedTool)
        const ended = trace.events.findLast(event => event.type === 'turn/end')
        const assistant = trace.events.findLast(event => event.type === 'assistant/message')
        if (contract.violation) fail(contract.violation)
        if (trace.status !== 'STARTED' || ended?.data.reason.kind !== 'completed' || !assistant) fail('TASK_EXECUTION_UNKNOWN_OR_FAILED')
        if (trace.requests.at(-1)?.finish !== 'stop') fail('TASK_REPORT_DID_NOT_STOP_NORMALLY')
        if (trace.events.some(event => event.type === 'tool/result' && event.data.message.isError)) fail('TASK_TOOL_EXECUTION_FAILED')
        contract.checkNativeMessages(handle.agent.session.deriveMessages(), handle.agent.session)
        reportText = assistant.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('')
      }
      if (!reportText.trim()) fail('TASK_REPORT_EMPTY')
      trace.status = 'RESPONSE_RECEIVED'
      const evidence = this.saveTrace(runDirectory, trace, 'trace.json', journal)
      traceSaved = true
      const report = { taskId: assembly.task.id, attemptId: assembly.task.attemptId, sessionId,
        contextVersion: assembly.contextVersion, text: reportText, acceptance: 'UNVERIFIED_MODEL_REPORT', evidence: [evidence] }
      this.workflowControl?.beforeCommit?.()
      this.workflowControl?.roleComplete?.(correction ? 'result_work' : 'executor', sessionId, { taskId: assembly.task.id }, report)
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
        try { journal.append('BLOCKED', { code: error.code ?? 'DIRECT_EXECUTION_UNKNOWN_OR_FAILED',
          ...(error.code === 'DIRECT_TOOL_ERROR_BLOCKED' ? { toolErrorBlock: error.details } : {}) }) } catch { /* Keep the prior durable fence; never replace it with a guessed outcome. */ }
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
          ...(error.code === 'DIRECT_TOOL_ERROR_BLOCKED' ? { toolErrorBlock: error.details } : {}),
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
    const saved = writeStored(file,bytes)
    if (saved) return { kind:'artifact', ...saved }
    const temporary = path.join(directory, `.trace-${randomUUID()}.tmp`)
    const fd = fs.openSync(temporary, 'wx', 0o600)
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    fs.renameSync(temporary, file)
    const dir = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY)
    try { fs.fsyncSync(dir) } finally { fs.closeSync(dir) }
    return { kind: 'artifact', ref: file, sha256: sha256(bytes) }
  }
  async close() { if (this.closed) return; this.closed = true; if (this.current) await this.current.dispose(); if (this.busy) await this.drained; this.output.interrupt(); this.listeners.clear(); if(this.storage) { try {await this.storage.flushBackup()} finally {this.storage.close()} } }
}

export { DynamicContextRuntime as DynamicContextPrototype }

export function apply(ctx, config = {}) {
  if (config?.enabled === false) return
  const { preferences, ...baseConfig } = deploymentConfig(config)
  const maxUnits = config.workflowLimits?.maxUnits
  const liveLimits = () => maxUnits?.get ? { ...baseConfig.workflowLimits, maxUnits: maxUnits.get() } : baseConfig.workflowLimits
  const performance = new RequestPerformance(ctx)
  ctx.provide('dynamicContextPerformance', performance); performance.install()
  const roleRegistries = createRolePolicies(baseConfig)
  const toolErrorPolicy = roleRegistries.errors
  ctx.provide(TOOL_ERROR_POLICY_SERVICE, toolErrorPolicy)
  ctx.provide(ROLE_PROMPTS_SERVICE, roleRegistries.prompts)
  ctx.provide(ROLE_TOOLS_SERVICE, roleRegistries.tools)
  ctx.provide(ROLE_MODELS_SERVICE, roleRegistries.models)
  ctx.provide(TOOL_POLICIES_SERVICE, toolPolicyInterface(ctx.tools, roleRegistries))
  const readMaxUnits = profileUnitLimitReader(ctx, ctx.fiber?.entry?.options?.id ?? name)
  const createRunner = options => {
    const runner = new DynamicContextRuntime(ctx, {
      ...options, workflowLimits: options.workflowLimits ?? liveLimits(),
    }, toolErrorPolicy, roleRegistries)
    runner.readConfiguredUnitLimit = readMaxUnits ?? (maxUnits?.get ? () => maxUnits.get() : undefined)
    return runner
  }
  const service = createRunner(baseConfig)
  service.preferences = () => readPreferences(preferences)
  service.currentWorkflowLimits = liveLimits
  ctx.provide('dynamicContext', service)
  if (service.config.interaction.mode === 'interactive') {
    service.interaction = new SessionInteraction(ctx, service, createRunner)
    service.interaction.install()
  } else {
    if (service.config.exposeControlTools) registerControlTools(ctx, service)
    ctx.effect(() => connectTaskGraph(ctx, service))
  }
  ctx.on('dispose', async () => { await service.interaction?.close(); await service.close() })
}
