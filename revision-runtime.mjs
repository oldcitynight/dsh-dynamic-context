import { currentPlanningRecord, criteriaInstruction, criteriaReportSources } from './acceptance-protocol.mjs'
import { livePermissionAuthority } from './permissions.mjs'
import { writeStored, readStored, hasStored, statStored } from './workflow-io.mjs'
import { parseModelJSON, diagnostic, feedbackText, validationBoundary } from 'dsh-better-task-grapth/validation'
import { validateReview } from './review-feedback.mjs'
// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs'
import { rolePrompt, roleTools, roleScope, roleMessagesMatch, unitBindingTools } from './role-policy.mjs'
import { bindRoleModel, roleReasoningSource } from './role-models.mjs'
import { withUserGuidance } from './guidance-state.mjs'
import { COMPACTION_INSTRUCTION } from './dsh-compaction-policy.mjs'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { setImmediate as yieldToLoop } from 'node:timers/promises'
import { digest, view, GraphError, revisionOutlook } from 'dsh-better-task-grapth/core'
import { ZodError } from 'zod'
import { assertPreloadBudget } from './role-policy.mjs'
import { RevisionCoordinator, planDefinition, revisionProposalSchema } from './revision.mjs'
import { modificationReportSchema } from './revision-report.mjs'
import { artifactFacts, verifyArtifactFacts, revisionAuthority } from './revision-host.mjs'
import { directAuthHeaders } from './direct-auth.mjs'
import { apiParameters, measureInput, resolveReasoningPolicy } from './api-protocol.mjs'
import { readCompletion, fetchDirectModel, modelTransportRetry } from './direct-http.mjs'
import { IMAGE_WINDOW } from './image-content.mjs'
import { prepareDirectRequest, directEndpoint, directProtocolHeaders } from './direct-wire.mjs'
import { roleToolOutcome, toolErrorBlock, toolErrorBlocked } from './tool-error-policy.mjs'
import { workspaceAuditTools } from './workspace-audit.mjs'
import { imageWireByteBound } from './image-content.mjs'
import { acquireDirectLease } from './durable-store.mjs'
import { fail, describeContextBindings, currentSharedContexts } from './core.mjs'
import { artifactProof, realProjectPath } from './artifacts.mjs'
import { semanticsFor } from './supervision-semantics.mjs'
import { indexesRoleInput } from './role-input-index.mjs'
import { createRoleContext, rolePressureTokens, roleWindow } from './role-context.mjs'
import { executionReportHistory, REPORT_PROTOCOL } from './report-evidence.mjs'
import { createReportDraft, standardReportTemplate, REPORT_GENERATE, REPORT_SUBMIT } from './report-draft.mjs'
import { blueprintDeletionGuidance } from './format-examples.mjs'
import { blockageSituation, decisionHistoryRoles } from './blockage-protocol.mjs'
import { checkRevisionProgress, REVISION_PROGRESS_RULE } from './blockage-diagnosis.mjs'

function save(file, value) {
  if (writeStored(file,JSON.stringify(value)+'\n')) return
  const fd = fs.openSync(file + '.tmp', fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600)
  try { fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  fs.renameSync(file + '.tmp', file)
  const directory = fs.openSync(path.dirname(file), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY)
  try { fs.fsyncSync(directory) } finally { fs.closeSync(directory) }
}
export function contextDefinition(state) {
  const contexts = new Map(state.contexts.nodes.map(node => [node.id, node.key]))
  const tasks = new Map(state.graph.state.plan.nodes.map(node => [node.id, node.key]))
  return { nodes: state.contexts.nodes.map(({ key, content, parents, mutable }) => ({ key, content, parents: parents.map(id => contexts.get(id)),
    ...(mutable ? { mutable: true } : {}) })),
    bindings: state.contexts.bindings.map(row => ({ task: tasks.get(row.taskId), instruction: criteriaInstruction(state, row),
      contexts: row.contexts.map(id => contexts.get(id)), inheritReports: criteriaReportSources(state, row).map(id => tasks.get(id)), tools: row.tools,
      ...(row.baseline ? { baseline: row.baseline } : {}), ...(row.completion ? { completion: row.completion } : {}) })) }
}
const uncertainRole = phase => ['MODEL_PENDING', 'RESPONSE_RECEIVED', 'UNKNOWN_NO_REPLAY'].includes(phase)
const roleId = /^revision_(updater|reviewer|result_check|plan_check|result_repair|blockage|blockage_audit|unit_planner|unit_plan_audit|unit_rebaseline|unit_audit|group_audit|scope_plan|scope_update|scope_audit|task_reporter|progress_reporter|scope_blockage|scope_pause|guidance_intake|guidance_router|unit_router|baseline_audit)_[a-f0-9-]{36}$/
export function readRoleRecord(runner, runId) {
  if (!roleId.test(runId)) fail('REVISION_RECOVERY_SCOPE_REQUIRED')
  const file = path.join(runner.config.directory, 'revisions', runId, 'role.json')
  if (!hasStored(file)) return null
  const record = JSON.parse(readStored(realProjectPath(runner.config.storageRoot ?? runner.config.projectRoot, file, { directory: false })))
  if (record.runId !== runId || digest(record.payload) !== record.requestHash) fail('REVISION_RECOVERY_RECORD_CHANGED')
  for (const call of record.calls ?? []) {
    if (digest(call.payload) !== call.requestHash || call.response && digest(call.response) !== call.responseHash) fail('REVISION_RECOVERY_RECORD_CHANGED')
  }
  return record
}
function savedRoleToolSchemas(record) {
  const byRole = new Map()
  for (const { purpose, payload } of record?.calls ?? []) {
    if (!payload.tools?.length || byRole.has(purpose)) continue
    const schemas = new Map()
    for (const tool of payload.tools) {
      const { name, description, parameters = tool.input_schema } = tool.function ?? tool
      if (typeof name === 'string' && typeof description === 'string' && parameters)
        schemas.set(name, { description, parameters })
    }
    byRole.set(purpose, schemas)
  }
  return byRole
}
export function roleRecordValue(record) {
  return record.submittedReport ?? parseModelJSON(record.response.text, { envelope: true }).value
}
const recoverySummaries = new WeakMap()
const roleFileIdentity = stat => stat && [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')

function* scanRevisionRecovery(runner) {
  if (!runner.config.revision) return
  const directory = path.join(runner.config.directory, 'revisions')
  const previous = recoverySummaries.get(runner), next = new Map()
  for (const entry of fs.existsSync(directory) ? fs.readdirSync(directory, { withFileTypes: true }) : []) {
    if (!entry.isDirectory()) continue
    const file = path.join(directory, entry.name, 'role.json')
    const identity = roleFileIdentity(statStored(file, { bigint: true, throwIfNoEntry: false }))
    if (!identity) continue
    let summary = previous?.get(file)
    if (summary?.identity !== identity) {
      const record = JSON.parse(readStored(file))
      summary = { identity, pending: uncertainRole(record.phase) ? { runId: record.runId,
        role: record.role, phase: record.phase, requestHash: record.requestHash, requiresTrustedReconciliation: true } : null }
      // A concurrent atomic replacement is visible on the next inspection.
      if (roleFileIdentity(statStored(file, { bigint: true, throwIfNoEntry: false })) !== identity) summary.identity = null
    }
    if (summary.identity) next.set(file, summary)
    yield summary.pending ? { ...summary.pending } : null
  }
  recoverySummaries.set(runner, next)
}

export function revisionRecoveryState(runner) {
  return [...scanRevisionRecovery(runner)].filter(Boolean)
}

// Warm the metadata cache in bounded slices. The decision itself still stats
// the current records, including changes made during a yield.
export async function warmRevisionRecovery(runner, signal) {
  let started = performance.now()
  for (const _ of scanRevisionRecovery(runner)) {
    if (performance.now() - started < 32) continue
    await yieldToLoop()
    signal.throwIfAborted()
    started = performance.now()
  }
}

/** Trusted host only. Abandon an unknown auxiliary call, never recover approval
 * or release money. The accounting owner reconciles its reservation separately.
 */
export async function abandonRevisionRole(runner, { expectedRevision, runId, requestHash,
  signal = new AbortController().signal } = {}) {
  if (!runner.config.revision || runner.config.transport !== 'direct' || runner.busy || runner.closed
      || !runner.reconciliationVerifier) fail('REVISION_TRUSTED_RECONCILIATION_REQUIRED')
  if (!roleId.test(runId ?? '') || !/^[a-f0-9]{64}$/.test(requestHash ?? '')) fail('REVISION_RECOVERY_SCOPE_REQUIRED')
  const verifier = runner.reconciliationVerifier, control = new AbortController(), abort = () => control.abort(signal.reason)
  signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort()
  runner.busy = true
  let lease, drained
  runner.drained = new Promise(resolve => { drained = resolve })
  runner.current = { dispose: async () => control.abort(new Error('DYNAMIC_CONTEXT_RUNNER_CLOSED')) }
  try {
    lease = await acquireDirectLease(runner.config.directory)
    control.signal.throwIfAborted()
    const state = runner.graph.read()
    if (!state || state.revision !== expectedRevision) fail('REVISION_STALE_BASE')
    const storageRoot = runner.config.storageRoot ?? runner.config.projectRoot
    const file = realProjectPath(storageRoot, path.join(runner.config.directory, 'revisions', runId, 'role.json'), { directory: false })
    const before = readStored(file), record = JSON.parse(before)
    if (record.runId !== runId || record.requestHash !== requestHash || digest(record.payload) !== requestHash
        || !uncertainRole(record.phase)) fail('REVISION_RECOVERY_RECORD_CHANGED')
    let onAbort, attestation
    try {
      attestation = await Promise.race([
        verifier.verify(Object.freeze({ kind: 'revision-role', runId, role: record.role, requestHash, phase: record.phase,
          expectedRevision, outcome: 'ABANDONED_UNVERIFIED', financialReservationReleased: false, signal: control.signal })),
        new Promise((_, reject) => { onAbort = () => reject(control.signal.reason); control.signal.addEventListener('abort', onAbort, { once: true }); if (control.signal.aborted) onAbort() }),
      ])
    } finally { if (onAbort) control.signal.removeEventListener('abort', onAbort) }
    control.signal.throwIfAborted()
    if (attestation?.confirmedQuiescent !== true || attestation?.abandonRevisionRole !== true
        || !['SETTLED', 'RESERVATION_RETAINED'].includes(attestation.financialStatus)
        || !Array.isArray(attestation.evidence) || !attestation.evidence.length) fail('REVISION_RECOVERY_NOT_ATTESTED')
    for (const ref of attestation.evidence) {
      if (ref.kind !== 'artifact') fail('REVISION_RECOVERY_ARTIFACT_REQUIRED')
      artifactProof(storageRoot, ref, control.signal)
    }
    if (runner.reconciliationVerifier !== verifier || runner.graph.read().checksum !== state.checksum
        || !readStored(file).equals(before)) fail('REVISION_RECOVERY_RECORD_CHANGED')
    const archive = path.join(path.dirname(file), `before-reconciliation-${randomUUID()}.json`)
    if (!writeStored(archive,before,{exclusive:true})) {
      fs.copyFileSync(file, archive, fs.constants.COPYFILE_EXCL)
      const fd=fs.openSync(archive,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW)
      try {fs.fsyncSync(fd)} finally {fs.closeSync(fd)}
    }
    const beforeSha256 = createHash('sha256').update(before).digest('hex')
    save(file, { ...record, phase: 'ABANDONED_UNVERIFIED', reconciliation: { verifierVersion: verifier.version,
      originalPhase: record.phase, originalRecord: { ref: archive, sha256: beforeSha256 }, evidence: structuredClone(attestation.evidence),
      financialStatus: attestation.financialStatus, financialReservationReleased: false, graphChanged: false } })
    runner.publish('revision-role-abandoned')
    return { status: 'ABANDONED_UNVERIFIED', runId, revision: state.revision, graphChanged: false,
      financialReservationReleased: false, originalOutcome: 'UNVERIFIED', goalReached: false }
  } finally {
    signal.removeEventListener('abort', abort); await lease?.release(); runner.current = null; runner.busy = false; drained()
  }
}
export async function directRevisionRole(runner, request) {
  const { ctx } = runner, { runId, role, signal, validateOutput = false, validateResult } = request
  let messages = withUserGuidance(runner, role, request.messages)
  const prior = readRoleRecord(runner, runId)
  const blocked = prior?.toolErrorBlock
  if (blocked && runner.workflowControl?.ackToolError?.id !== blocked.id) throw toolErrorBlocked(blocked)
  const baseMessagesHash = digest(messages), baseInputHash = digest(messages.slice(1))
  let promptSnapshot
  if (roleMessagesMatch(prior, messages)) { messages = prior.payload.messages; promptSnapshot = prior.promptSnapshot }
  else {
    let input = {}; try { input = JSON.parse(messages[1].content) } catch {}
    promptSnapshot = rolePrompt(runner, role, messages[0].content, input)
    messages = [{ ...messages[0], content: promptSnapshot.content }, ...messages.slice(1)]
  }
  const input = JSON.parse(messages[1].content)
  const toolScope = roleScope(runner, { ...input, sessionId: request.sourceAgent?.session?.id ?? input.sessionId })
  const route = bindRoleModel(runner, role, toolScope, runner.config, prior ? prior.modelRoute ?? null : undefined)
  const reasoning = await resolveReasoningPolicy({ config: route.config, ctx,
    sourceAgent: roleReasoningSource(runner.config, route.config, request.sourceAgent ?? runner.controller ?? runner.current?.sourceAgent),
    signal, previous: prior?.reasoningPolicy })
  const { config } = reasoning, { direct } = config
  const returned = value => {
    runner.workflowControl?.beforeCommit?.()
    runner.workflowControl?.roleComplete?.(role, runId, JSON.parse(messages[1].content), value)
    return value
  }
  const directory = path.join(config.directory, 'revisions', runId)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const payload = { ...direct.generation, ...apiParameters(direct), model: config.model, messages,
    max_tokens: config.revision?.maxOutputTokens ?? config.maxOutputTokens, response_format: { type: 'json_object' }, stream: true, stream_options: { include_usage: true } }
  let record = { role, runId, phase: 'PREPARED', requestHash: digest(payload), payload, calls: [], baseMessagesHash, baseInputHash,
    ...(route.receipt ? { modelRoute: route.receipt } : {}),
    ...(promptSnapshot?.contributions.length ? { promptSnapshot } : {}), ...(reasoning.receipt ? { reasoningPolicy: reasoning.receipt } : {}) }
  if (!prior && decisionHistoryRoles.has(role)) {
    const event = runner.graph?.read?.()?.graph?.events?.at(-1)
    if (event) record.graphAnchor = { revision: event.seq, hash: event.hash }
  }
  if (prior) {
    if (prior.role !== role || prior.requestHash !== record.requestHash) fail('REVISION_ROLE_INPUT_CHANGED')
    if (prior.phase === 'COMPLETE' && !request.revalidateCompleted) {
      if (prior.submittedReport) {
        // Reconstruct from the original immutable input and exact provider tool
        // receipts. Never trust a stored materialization without this check.
        const input = JSON.parse(messages[1].content)
        if (!prior.formattedReports && (role !== 'result_repair' || typeof input.previousSubmission !== 'string')) fail('REVISION_ROLE_RECEIPT_INVALID')
        const draft = createReportDraft(role === 'result_repair' ? input.previousSubmission : '{}', { requireReport: config.supervisionContext !== 'legacy',
          ...(prior.formattedReports ? { generate: true, replayReceipts: prior.context.reportDraft.receipts,
            validateResult: value => validateOutput ? validateReview(role, value, input) : value } : {}) })
        const names = new Set(draft.tools.map(tool => tool.function.name))
        for (const call of prior.calls) for (const tool of call.response?.message.tool_calls ?? []) {
          if (names.has(tool.function.name) && !([REPORT_SUBMIT, REPORT_GENERATE].includes(tool.function.name) && call.response.message.tool_calls.length !== 1))
            draft.execute(tool.function.name, tool.function.arguments)
        }
        const value = draft.result()
        if (value === undefined || digest(value) !== prior.resultHash || digest(value) !== digest(prior.submittedReport)
            || digest(draft.snapshot()) !== digest(prior.context.reportDraft)) fail('REVISION_ROLE_RECEIPT_INVALID')
        return returned(value)
      }
      const rawResult = parseModelJSON(prior.response.text, { envelope: true }).value
      const result = digest(rawResult) === prior.resultHash ? rawResult : validateResult
        ? validateResult(rawResult) : validateReview(role, rawResult, JSON.parse(messages[1].content))
      if (prior.response.finish !== 'stop' || prior.response.message.tool_calls?.length || digest(result) !== prior.resultHash)
        fail('REVISION_ROLE_RECEIPT_INVALID')
      return returned(result)
    }
    if (!['PREPARED', 'NOT_SENT', 'PAUSED', 'REJECTED', ...(request.revalidateCompleted ? ['COMPLETE'] : [])].includes(prior.phase)
        && (!runner.workflowControl?.recoverModel || runner.revisionAccounting)) fail('REVISION_ROLE_REQUIRES_RECONCILIATION')
    record = prior
  }
  // An old, uncompressed role may have been rejected before producing any
  // response. Explicit manual recovery may start a new preparation generation,
  // preserving every old uncertain receipt and its financial status unchanged.
  if (prior && !prior.contextPolicyVersion && direct.compaction?.strategy === 'dsh-native'
      && !prior.context?.actions?.length && prior.calls.length && prior.calls.every(row => !row.response)
      && (prior.phase === 'REJECTED' || runner.workflowControl?.recoverModel && !runner.revisionAccounting)) {
    record.contextGenerations ??= []
    record.contextGenerations.push({ generation: (record.contextGeneration ?? 0) + 1,
      reason: 'PREPARE_NATIVE_COMPACTION_BEFORE_ROLE', priorSequences: record.calls.map(row => row.sequence),
      previousPhase: record.phase, unknownOutcomePreserved: true, financialStatus: 'UNCHANGED' })
    record.contextGeneration = record.contextGenerations.at(-1).generation
  }
  if (prior?.inputIndexVersion === 2 && !prior.inputIndex && prior.calls.length) fail('REVISION_ROLE_INDEX_RECEIPT_MISSING')
  if (!prior && indexesRoleInput(role)) record.inputIndexVersion = 2
  if (!prior) record.materialNavigation = true
  record.contextPolicyVersion = 2
  record.structuredToolErrors ??= !prior
  if (blocked) {
    record.acknowledgedToolErrors = [...new Set([...(record.acknowledgedToolErrors ?? []), blocked.id])]
    delete record.toolErrorBlock
    delete record.error
    delete record.validationFeedback
  }
  record.formattedReports ??= !prior
  // Freeze tool wording at issue time so earlier receipts still replay exactly.
  if (record.formattedReports && !prior) {
    record.reportTemplate = [standardReportTemplate(request.messages[0].content), blueprintDeletionGuidance[role]]
      .filter(Boolean).join('\n\n')
  }
  const compactPrompt = prior ? prior.compactionPrompt ?? { contributions: [], content: COMPACTION_INSTRUCTION } : rolePrompt(runner, 'compaction', COMPACTION_INSTRUCTION, JSON.parse(messages[1].content))
  if (compactPrompt.contributions.length) record.compactionPrompt = compactPrompt
  save(path.join(directory, 'role.json'), record)
  const spec = roleWindow(config)
  record.imageTools ??= !prior && Boolean(config.projectRoot && fs.existsSync(config.projectRoot))
  const registry = roleTools(runner)
  if (!prior) record.issuedRolePolicies = Object.fromEntries([role, 'compaction'].map(target =>
    [target, registry.select(target, [], toolScope, config.projectRoot).policies]))
  if (!prior && record.imageTools && registry.extensions(role, toolScope, config.projectRoot).some(row => row.auditArtifacts))
    record.auditArtifacts = true
  const suppliedTools = request.readOnlyTools
  const images = record.imageTools && !suppliedTools?.tools.some(row => row.function.name === 'read_image')
    ? workspaceAuditTools({ ...runner, config }, path.join(directory, 'image-reader'), new Map(), signal, { imagesOnly: true, evidenceDirectory: directory }) : null
  const readOnlyTools = (images || suppliedTools) && { tools: [...(suppliedTools?.tools ?? []), ...(images?.tools ?? [])],
    execute: (tool, ordinal) => images && tool.function.name === 'read_image' ? images.execute(tool, config) : suppliedTools.execute(tool, config, ordinal) }
  const auditArtifacts = record.auditArtifacts ? (images ?? suppliedTools)?.auditArtifacts : undefined
  const persist = () => save(path.join(directory, 'role.json'), record)
  const policy = runner.toolErrorPolicy?.snapshot()
  const imageFailures = new Map(record.imageFailures)
  const reportedImageFailures = new Set(imageFailures.keys())
  const existingResponses = record.calls.length
  const lastRecordedStep = record.calls.at(-1)?.logicalStep ?? existingResponses
  let replayingDelivered = false, legacyImageBatch = false
  const inspectTool = (toolRole, tool, value, ordinal) => {
    if (!policy || replayingDelivered) return
    const block = toolErrorBlock(policy, roleToolOutcome(value), { role: toolRole, toolId: tool.function.name, callId: tool.id, runId, ordinal })
    if (!block || record.acknowledgedToolErrors?.includes(block.id)) return
    throw toolErrorBlocked(block)
  }
  let logicalStep = 0
  const previousAt = position => record.calls.findLast(row => (row.logicalStep ?? row.sequence) === position
    && (row.contextGeneration ?? 0) === (record.contextGeneration ?? 0))
  const unitCapacityNotice = previous => {
    if (previous) return previous.unitLimitNotice ?? previous.leafTaskLimitNotice
    if (!['unit_planner', 'updater', 'scope_update'].includes(role)) return
    const limit = runner.graph?.unitLimit?.()
    if (!limit) return
    return `Current linked-graph unit limit (root included): ${limit.maximum} in the complete graph after merging this proposal with other scopes. Currently committed: ${limit.current}. Use this limit for the next submission. Previous tool receipts record the policy at the time of those calls.`
  }
  const withUnitCapacityNotice = (payload, notice) => {
    if (!notice) return payload
    const [system, ...rest] = payload.messages
    return { ...payload, messages: [{ ...system, content: system.content + '\n\n' + notice }, ...rest] }
  }
  const call = async (preparedPayload, details) => {
    const position = ++logicalStep
    const previous = previousAt(position)
    // The wire for historical calls includes only the notice originally sent.
    const notice = details.purpose === role ? unitCapacityNotice(previous) : undefined
    const normalizedPayload = withUnitCapacityNotice(preparedPayload, notice)
    replayingDelivered = Boolean(previous?.response && previous.sequence < existingResponses)
    const requestImageFailures = new Map()
    legacyImageBatch = replayingDelivered && previous.imageWindow === undefined
    const prepareWire = legacyImageHistory => prepareDirectRequest(normalizedPayload, config, ctx, signal, { legacyImageHistory, failures: imageFailures, replay: previous,
      onFailure(callId, value, key) {
        requestImageFailures.set(key, value)
        if (previous || reportedImageFailures.has(key)) return
        reportedImageFailures.add(key)
        record.imageFailures = [...imageFailures].filter(([key]) => reportedImageFailures.has(key))
        inspectTool(details.purpose === 'compaction' ? 'compaction' : role, { id: callId, function: { name: 'read_image' } }, value, key)
      } })
    let wirePayload = await prepareWire(Boolean(previous && previous.imageWindow === undefined))
    const endpoint = directEndpoint(direct)
    if (previous && previous.requestHash !== digest(wirePayload)) fail('REVISION_RESUME_REQUEST_CHANGED')
    if (previous?.phase === 'COMPLETE' || previous?.response && !runner.revisionAccounting) return previous.response
    if (previous?.phase === 'REJECTED') throw Object.assign(new Error(previous.error), {
      code: previous.error, directReceipt: previous.transportReceipt, providerError: previous.providerError })
    if (previous && previous.imageWindow === undefined) wirePayload = await prepareWire(false)
    const retryTransport = modelTransportRetry(ctx, config.provider, signal, persist)
    let retryOf
    for (;;) {
      runner.workflowControl?.beforeRequest()
      const request = { imageWindow: IMAGE_WINDOW, sequence: record.calls.length + 1, logicalStep: position, contextGeneration: record.contextGeneration ?? 0, ...details, phase: 'PREPARED',
        ...(retryOf ? { retryOf } : {}),
        ...(notice ? { unitLimitNotice: notice } : {}),
        ...(previous ? { resumedFrom: previous.sequence, previousOutcome: previous.phase, financialStatus: 'UNCHANGED' } : {}),
        requestHash: digest(wirePayload), payload: wirePayload, endpoint,
        ...(requestImageFailures.size ? { imageFailures: [...requestImageFailures] } : {}) }
      record.calls.push(request); persist()
      const metadata = { runId, role, directory, sequence: request.sequence, ...details }
      let observed
      try {
        const body = JSON.stringify(wirePayload)
        request.bodySha256 = createHash('sha256').update(body).digest('hex')
        if (direct.maxRequestBytes !== null && Buffer.byteLength(body) > direct.maxRequestBytes) fail('DIRECT_REQUEST_BYTE_LIMIT')
        const measured = await measureInput(runner.inputMeter, wirePayload, signal, config.maxInputTokens)
        request.inputMeasurement = measured ?? { tokens: Math.max(rolePressureTokens(normalizedPayload), normalizedPayload.messages.some(m => m.images?.length) ? imageWireByteBound(wirePayload) : Buffer.byteLength(body)), method: 'utf8-byte-bound' }
        if (spec && rolePressureTokens(normalizedPayload, measured) + wirePayload.max_tokens > spec.contextWindow)
          fail('REVISION_CONTEXT_WINDOW_EXCEEDED_BEFORE_SEND', { contextWindow: spec.contextWindow,
            inputTokens: request.inputMeasurement.tokens, reservedOutputTokens: wirePayload.max_tokens })
        const headers = await directAuthHeaders(ctx, { ...direct, endpoint }, signal)
        runner.workflowControl?.beforeRequest()
        await runner.revisionAccounting?.beforeRequest?.(wirePayload, metadata)
        signal.throwIfAborted()
        runner.workflowControl?.beforeRequest()
        request.phase = 'MODEL_PENDING'; record.phase = 'MODEL_PENDING'; persist()
        runner.activity = { stage: role, kind: 'model', sessionId: null, step: request.sequence, tool: null, at: new Date().toISOString() }
        observed = runner.output?.model({ stage: details.purpose === 'compaction' ? 'compaction' : role, step: request.sequence }, `role:${runId}:${request.sequence}`,
          { payload: normalizedPayload, inputMeasurement: request.inputMeasurement, group: 'role:' + runId })
        const response = await fetchDirectModel(request, { method: 'POST', redirect: 'error', signal,
          headers: { 'content-type': 'application/json', ...directProtocolHeaders(direct, details.purpose), ...headers }, body })
        const completed = await readCompletion(response, { signal, model: config.model, direct,
          maxResponseBytes: direct.maxResponseBytes, onProgress: value => { observed?.progress?.(value); runner.inputMeter?.observe?.(value) }, onDelta: observed?.delta })
        observed?.end('complete', completed.finish, completed.usage)
        request.response = completed; request.responseHash = digest(completed); request.phase = 'RESPONSE_RECEIVED'
        record.phase = 'RESPONSE_RECEIVED'; persist()
        await runner.revisionAccounting?.afterResponse?.(completed, metadata)
        request.phase = 'COMPLETE'; persist()
        runner.activity = { ...runner.activity, kind: 'result', at: new Date().toISOString() }
        return completed
      } catch (error) {
        if (!request.response) observed?.end('interrupted', error.code ?? error.name, error.directReceipt?.usage)
        request.error = error.code ?? error.message
        const notSent = request.phase === 'PREPARED'
        request.phase = notSent ? 'NOT_SENT' : request.response ? 'RESPONSE_RECEIVED'
          : error.code === 'DIRECT_CONTEXT_LENGTH_EXCEEDED' && error.directReceipt?.responseRejected ? 'REJECTED' : 'UNKNOWN_NO_REPLAY'
        if (notSent) error.directReceipt = { ...(error.directReceipt ?? {}), execution: 'NOT_SENT', notSent: true }
        if (error.directReceipt) request.transportReceipt = error.directReceipt
        if (error.providerError) request.providerError = error.providerError
        persist()
        await runner.revisionAccounting?.onFailure?.(error, metadata)
        if (await retryTransport(request, error)) { retryOf = request.sequence; continue }
        throw error
      }
    }
  }
  let context
  const persistCurrentContext = () => {
    if (logicalStep < lastRecordedStep) return
    record.context = context.snapshot(); persist()
  }
  try {
    context = createRoleContext({ config, messages, directory, call, signal, role, materialNavigation: record.materialNavigation === true,
      inspectTool, structuredToolErrors: record.structuredToolErrors,
      contextText: (target, slot, base) => {
        const key = target + '/' + slot
        if (prior) return record.contextSlots?.[key]?.content ?? base
        const snapshot = rolePrompt(runner, target, base, toolScope, slot)
        if (snapshot.contributions.length) (record.contextSlots ??= {})[key] = snapshot
        assertPreloadBudget(target === role ? promptSnapshot : compactPrompt, ...Object.values(record.contextSlots ?? {}).filter(row => row.role === target))
        return snapshot.content
      },
      ...(record.inputIndexVersion === 2 ? { inputIndex: { saved: prior?.inputIndex, save: value => { record.inputIndex = value; persist() } } } : {}),
      formattedReports: record.formattedReports, reportTemplate: record.reportTemplate,
      reportReceipts: prior?.context?.reportDraft?.receipts,
      validateSubmission: raw => {
        let value = validateOutput ? validateReview(role, raw, JSON.parse(messages[1].content)) : raw
        if (validateResult) value = validateResult(value)
        request.validateToolResult?.(value)
        images?.checkCurrent({ action: 'COMPLETE' })
        return value
      },
      compactionInstruction: compactPrompt.content,
      toolPolicy: registry, toolScope,
      toolHostContext: { runner, sourceAgent: request.sourceAgent ?? runner.controller ?? runner.current?.sourceAgent, signal, directory, runId, auditArtifacts,
        issuedRolePolicies: record.issuedRolePolicies, savedToolSchemas: savedRoleToolSchemas(prior), returnToolErrors: true },
      limitImageBatch: () => !legacyImageBatch,
      beforeTool: () => runner.workflowControl?.beforeTool?.(),
      ...(readOnlyTools ? { readOnlyTools } : {}),
      imageTools: record.imageTools,
      directorySnapshots: role === 'result_repair' && config.supervisionContext !== 'legacy'
        && (!prior || !prior.calls?.length || prior.context?.directorySnapshots === true),
      observeTool: (type, data) => {
        if (!replayingDelivered) runner.output?.tool({ stage: role, step: record.calls.length }, type, data, `role:${runId}`)
      },
      measureTokens: async payload => {
        const normalized = { ...direct.generation, ...apiParameters(direct), model: config.model,
          max_tokens: config.revision?.maxOutputTokens ?? config.maxOutputTokens, stream: true, ...payload }
        const measuredPayload = withUnitCapacityNotice(normalized, payload.response_format ? unitCapacityNotice(previousAt(logicalStep + 1)) : undefined)
        return rolePressureTokens(measuredPayload, await measureInput(runner.inputMeter, await prepareDirectRequest(measuredPayload, config, ctx, signal, { failures: imageFailures }), signal))
      } })
    let lastRejection, lastToolRejection, forceCompaction = false, overflowRetries = 0, overflowError, rejectedPayloadHash
    for (;;) {
      const prepared = await context.prepare({ force: forceCompaction })
      forceCompaction = false
      persistCurrentContext()
      if (overflowError && digest(prepared) === rejectedPayloadHash) throw overflowError
      let completed
      try { completed = await call(prepared, { purpose: role }) }
      catch (error) {
        if (error.code !== 'DIRECT_CONTEXT_LENGTH_EXCEEDED' || !error.directReceipt?.responseRejected
            || direct.compaction?.strategy !== 'dsh-native' || overflowRetries >= 1) throw error
        record.overflowRecovery = { sequence: record.calls.length, retry: ++overflowRetries, reason: error.code }
        overflowError = error; rejectedPayloadHash = digest(prepared)
        forceCompaction = true; persist(); continue
      }
      if (completed.finish === 'tool_calls') {
        const rejections = await context.continueRead(completed)
        persistCurrentContext()
        const fingerprint = rejections.length ? digest(rejections) : undefined
        const pausedHere = record.noProgress?.step === logicalStep && record.noProgress.generation === (record.contextGeneration ?? 0)
        if (fingerprint && fingerprint === lastToolRejection && !replayingDelivered && !pausedHere) {
          record.noProgress = { step: logicalStep, generation: record.contextGeneration ?? 0 }
          fail('WORKFLOW_NO_PROGRESS', { reason: 'The role retried the same rejected tool arguments without making progress.',
            role, rejections: rejections.map(({ tool, code }) => ({ tool, code })) })
        }
        lastToolRejection = pausedHere ? undefined : fingerprint
        const submitted = context.submitted()
        if (submitted !== undefined) {
          const receipt = record.calls.findLast(row => (row.logicalStep ?? row.sequence) === logicalStep && (row.contextGeneration ?? 0) === (record.contextGeneration ?? 0))
          if (request.revalidateCompleted && receipt?.validationRejection) {
            const error = new Error(receipt.validationRejection.code); error.diagnostic = receipt.validationRejection
            context.reject(completed, error); continue
          }
          if (request.revalidateCompleted && validateResult) try { validateResult(submitted) } catch (error) {
            if (signal.aborted) throw error
            receipt.validationRejection = diagnostic(error, { stage: role }); persist()
            context.reject(completed, error); continue
          }
          delete record.error; delete record.validationFeedback
          delete record.transportReceipt; delete record.providerError
          record.response = completed; record.submittedReport = submitted
          record.phase = 'COMPLETE'; record.resultHash = digest(submitted); persist()
          return returned(submitted)
        }
        continue
      }
      lastToolRejection = undefined
      record.response = completed; persist()
      if (completed.finish !== 'stop' || completed.message.tool_calls?.length) fail('REVISION_ROLE_TOOLS_FORBIDDEN')
      const recordedCall = record.calls.findLast(row => (row.logicalStep ?? row.sequence) === logicalStep
        && (row.contextGeneration ?? 0) === (record.contextGeneration ?? 0))
      // Filesystem-dependent final checks are time-sensitive. During replay,
      // preserve an earlier rejection verbatim even if files have reverted;
      // otherwise an obsolete response could silently replace the later audit.
      if (request.revalidateCompleted && recordedCall?.validationRejection) {
        const error = new Error(recordedCall.validationRejection.code)
        error.diagnostic = recordedCall.validationRejection
        lastRejection = recordedCall.validationRejection
        context.reject(completed, error); continue
      }
      let value
      try {
        const parsed = parseModelJSON(completed.text, { envelope: true }); record.syntaxRepairs = parsed.repairs
        value = validateOutput ? validateReview(role, parsed.value, JSON.parse(messages[1].content)) : parsed.value
        if (validateResult) value = validateResult(value)
        images?.checkCurrent({ action: 'COMPLETE' })
      } catch (error) {
        if (!validateOutput) throw error
        const feedback = diagnostic(error, { stage: role })
        error.diagnostic = feedback
        error.message = feedbackText(error)
        if (request.revalidateCompleted && recordedCall) recordedCall.validationRejection = feedback
        if (lastRejection && digest(lastRejection) === digest(feedback)) throw error
        lastRejection = feedback; record.lastRejection = feedback; context.reject(completed, error); persist(); continue
      }
      // The individual send receipts retain earlier failures after manual recovery.
      delete record.error; delete record.validationFeedback
      delete record.transportReceipt; delete record.providerError
      record.phase = 'COMPLETE'; record.resultHash = digest(value); persist()
      return returned(value)
    }
  } catch (error) {
    record.error = error.code ?? error.message
    record.validationFeedback = diagnostic(error, { stage: role })
    if (error.code === 'DIRECT_TOOL_ERROR_BLOCKED') record.toolErrorBlock = error.details
    record.phase = ['WORKFLOW_PAUSE_REQUESTED', 'WORKFLOW_GUIDANCE_REQUESTED', 'WORKFLOW_NO_PROGRESS', 'DIRECT_TOOL_ERROR_BLOCKED', 'COMPACTION_THINKING_ONLY_RETRY_EXHAUSTED'].includes(error.code) ? 'PAUSED'
      : record.calls.some(call => ['MODEL_PENDING', 'UNKNOWN_NO_REPLAY', 'RESPONSE_RECEIVED'].includes(call.phase)) ? 'UNKNOWN_NO_REPLAY'
      : record.calls.at(-1)?.phase === 'REJECTED' ? 'REJECTED'
      : record.calls.some(call => call.phase === 'COMPLETE') ? 'INVALID_RESPONSE' : 'NOT_SENT'
    if (error.directReceipt) record.transportReceipt = error.directReceipt
    if (error.providerError) record.providerError = error.providerError
    if (context) record.context = context.snapshot()
    persist()
    runner.output?.interrupt({ prefix: `role:${runId}` })
    throw error
  } finally { images?.close() }
}

export function revisionSnapshot(runner, hostAllowedTools = runner.config.allowedTools) {
  const state = runner.graph.read()
  if (!state) fail('CONTEXT_GRAPH_NOT_SUBMITTED')
  const contextGraph = contextDefinition(state)
  const task = id => state.graph.state.plan.nodes.find(node => node.id === id).key
  const graphView = view(state.graph)
  const sharedContexts = currentSharedContexts(state)
  // Large immutable node text precedes changing state on the wire. The complete
  // graph and state remain present; this changes order only, not authority.
  const snapshot = { contextGraph,
    contextHashes: Object.fromEntries(contextGraph.nodes.map(node => [node.key, digest(node)])),
    ...(sharedContexts.length ? { sharedContexts } : {}),
    taskGraph: planDefinition(state.graph.state.plan),
    revision: state.revision, checksum: state.checksum, linked: true, active: state.graph.state.active,
    hostAllowedTools: [...hostAllowedTools],
    taskStates: Object.fromEntries(state.graph.state.plan.nodes.filter(node => node.kind === 'leaf').map(node => [node.key, state.graph.state.leaves[node.id]])),
    execution: state.graph.state.leaves, reports: state.reports.map(report => ({ ...report, task: task(report.taskId) })),
    invalidatedReports: (state.invalidatedReports ?? []).map(task),
    ...(state.supervision ? {
      contextUse: describeContextBindings(state.contexts, state.graph.state.plan, state.graph.state.leaves, state),
      scheduling: {
        readyAfterReview: graphView.legalNext.map(row => task(row.id)),
        pendingButBlocked: graphView.pendingButBlocked.map(row => ({ task: task(row.id), reason: row.reason,
          unmetPrerequisites: row.unmetPrerequisites.map(task) })),
        semantics: 'Computed before the temporary supervision gate. INCOMPLETE attempts cannot restart and do not satisfy prerequisite edges. Reports alone do not update bindings or dependencies.',
      },
      ...(state.supervision.signal ? { revisionSignal: state.supervision.signal } : {}),
      outcomes: state.supervision.outcomes.map(row => ({
        task: task(row.taskId), attemptId: row.attemptId, contextVersion: row.contextVersion,
        result: row.result, evidence: row.evidence, revision: row.revision,
      })),
      supervisionReview: {
        runtimeSemantics: semanticsFor(state.graph.state.plan),
        requiredBindings: 'Every leaf retains an explicit completion contract: report, or artifact with its path.',
        completionSemantics: 'Every accepted COMPLETE disposition commits an inheritable report, including completion.kind=artifact. Artifact completion adds a required verified file; it never replaces or suppresses the report. BLOCKED and FAILED dispositions do not create a success report. Do not reject inheritReports merely because its predecessor has artifact completion.',
        artifactVerification: 'The host reads current artifact bytes and verifies every submitted SHA-256 before local review and commit. Workers may cite hashes from authorized sources. Requiring a separate hash tool is unnecessary when the host proof already establishes the required byte equality.',
        effectiveness: 'Resolve the evidence-backed problem, preserve the fixed requirements and exclude invalid reports and context pollution.',
        minimality: 'For each change group check whether the same repair would work without it. Reject unnecessary changes and reuse unchanged valid context by hash.',
      },
    } : {}),
  }
  if (state.supervision && runner.config.supervisionContext === 'reports') {
    delete snapshot.execution; delete snapshot.reports; delete snapshot.outcomes
    snapshot.executionReports = executionReportHistory(state)
    snapshot.planningRecord = currentPlanningRecord(state) ?? { status: 'NOT_PROVIDED' }
    snapshot.supervisionReview.mode = REPORT_PROTOCOL
    snapshot.supervisionReview.artifactVerification = 'Acceptance host checks directory membership, hashes and selected test receipt quotes. Planning/revision uses reported results, not tool logs or assembly failures.'
  }
  return snapshot
}

/** The caller holds the workflow lease through the final compare-and-swap. */
export async function runJointRevision(runner, { expectedRevision, facts, verifyFacts, reason, feedback, sourceAgent, signal, blockage, roleRunIds }) {
  if (revisionRecoveryState(runner).some(row => !(blockage && runner.workflowControl?.recoverModel && Object.values(roleRunIds ?? {}).includes(row.runId)))) fail('REVISION_UNKNOWN_ROLE_REQUIRES_RECONCILIATION')
  const verifyBlockage = () => {
    if (!blockage) return
    const state = runner.graph.read(), record = readRoleRecord(runner, blockage.runId)
    if (!blockageSituation(state) || state.checksum !== blockage.baseChecksum || !record || record.phase !== 'COMPLETE'
        || record.role !== 'blockage' || record.requestHash !== blockage.requestHash || record.resultHash !== blockage.resultHash
        || JSON.parse(record.payload.messages[1].content).baseChecksum !== state.checksum
        || digest(roleRecordValue(record)) !== digest({ action: 'REPLAN', ...(blockage.reason === undefined ? {} : { reason: blockage.reason }) }))
      fail('BLOCKAGE_REVISION_SIGNAL_INVALID')
  }
  verifyBlockage()
  if (runner.config.supervision && runner.graph.read().supervision.phase !== 'REVISE' && !blockage) fail('SUPERVISION_REVISION_SIGNAL_REQUIRED')
  const allowedTools = unitBindingTools(runner)
  // A resumed blockage update keeps the original input identity. The host still
  // validates proposed bindings against its current capabilities.
  const priorUpdater = blockage && roleRunIds?.updater && readRoleRecord(runner, roleRunIds.updater)
  const graphState = runner.graph.read().graph.state
  let outlook
  const snapshotTools = priorUpdater
    ? JSON.parse(priorUpdater.payload.messages[1].content).snapshot.hostAllowedTools
    : allowedTools
  const checkTools = proposal => {
    runner.graph.expandRevision(proposal)
    for (const [index, row] of proposal.contextGraph.bindings.entries()) {
      const unauthorized = row.tools.filter(name => !allowedTools.includes(name))
      if (unauthorized.length) fail('CONTEXT_CANNOT_GRANT_TOOL_PERMISSION', { path: `/contextGraph/bindings/${index}/tools`, item: row.task, reason: 'A context binding can select only host-authorized tools.', unauthorized, allowed: allowedTools })
      if (!runner.config.direct.runtime && row.tools.some(name => !runner.config.direct.agentlessTools.includes(name)))
        fail('DIRECT_TOOL_REQUIRES_EXPLICIT_AGENTLESS_PERMISSION', { path: `/contextGraph/bindings/${index}/tools`, item: row.task, reason: 'This worker has no execution Agent; only explicitly agentless tools are permitted.', allowed: runner.config.direct.agentlessTools })
    }
  }
  const adapter = {
    snapshot: () => revisionSnapshot(runner, snapshotTools),
    authority: () => sourceAgent ? livePermissionAuthority(revisionAuthority(runner.ctx, sourceAgent)) : { hostConfig: digest(runner.config) },
    verifyFacts,
    ...(runner.config.supervision ? { rejectProposal(error, calls) {
      const updater = calls.find(call => call.role === 'updater')
      const receipt = updater && readRoleRecord(runner, updater.runId)
      if (!receipt || !['COMPLETE', 'INVALID_RESPONSE'].includes(receipt.phase) || receipt.response?.finish !== 'stop') throw error
      // Environment and implementation failures are not defects a model can
      // repair by proposing another graph. Keep them visible to the host.
      if (!(error instanceof GraphError || error instanceof ZodError
          || error.name === 'DynamicContextError' && typeof error.code === 'string'
          || (error instanceof SyntaxError || error.diagnostic?.category === 'syntax') && receipt.phase === 'INVALID_RESPONSE')) throw error
      return { status: 'REJECT', stage: 'PROGRAM', error: feedbackText(error, { stage: 'graph-program-check' }), diagnostic: diagnostic(error, { stage: 'graph-program-check' }), roles: calls }
    } } : {}),
    prepare(proposal) {
      checkTools(proposal)
      if (!blockage) {
        const prepared = runner.graph.prepareRevision(proposal)
        checkRevisionProgress(outlook, 'REVISE', '/taskGraph', graphState, prepared.plan)
        return prepared
      }
      // A paused exception audit must receive the identical candidate IDs and
      // prepared hash. The existing revision path retains its original allocator.
      let ordinal = 0
      const seed = { base: blockage.baseChecksum, updater: roleRunIds.updater, proposal: digest(proposal) }
      const prepared = runner.graph.prepareRevision(proposal, { id: prefix => `${prefix}_${digest({ ...seed, prefix, ordinal: ++ordinal }).slice(0,40)}` })
      checkRevisionProgress(outlook, 'REVISE', '/taskGraph', graphState, prepared.plan)
      return prepared
    },
    describePrepared(prepared) {
      return describeContextBindings(prepared.contexts, prepared.plan, runner.graph.read().graph.state.leaves, runner.graph.read())
    },
    revalidate(prepared, proposal) {
      verifyBlockage()
      checkTools(proposal)
      if (runner.graph.read().checksum !== prepared.baseChecksum) fail('REVISION_STALE_BASE')
    },
    commit(prepared, review) {
      verifyBlockage()
      const result = runner.graph.commitRevision({ expectedRevision, prepared, review: blockage ? { ...review, blockageSignal: blockage } : review })
      runner.publish('revised')
      return result
    },
  }
  const resumableRoles = runner.workflowControl?.ackToolError?.revisionRoles
  const runs = {}
  let result
  try {
    result = await new RevisionCoordinator({ adapter, policy: runner.config.revision.policy,
      runRole: request => {
        runs[request.role] = request.runId
        if (request.role === 'updater') {
          const saved = priorUpdater || readRoleRecord(runner, request.runId)
          if ((!blockage || blockage.reason !== undefined) && (!saved || JSON.parse(saved.payload.messages[1].content).revisionGuard)) {
            outlook = revisionOutlook(graphState)
            const [system, user] = request.messages, input = JSON.parse(user.content)
            const messages = [{ ...system, content: system.content.replaceAll('NEEDS_USER', 'ESCALATE') + '\n' + REVISION_PROGRESS_RULE
              + '\nREVISE 提交有依据的更改记录和候选蓝图，交由独立审计。NO_CHANGE 说明现有路径。ESCALATE 说明超出本层的约束，根层由程序交回阻塞处理者。' },
              { ...user, content: JSON.stringify({ ...input, revisionGuard: { avoid: 'BLOCK', unchanged: outlook },
                ...(blockage ? { blockageSignal: { runId: blockage.runId, reason: blockage.reason,
                  code: runner.graph.read().supervision.rootReferral ? 'ROOT_UPDATE_ESCALATED' : 'NO_READY_LEAF' } } : {}) }) }]
            return directRevisionRole(runner, { ...request, messages, sourceAgent, validateOutput: true, validateResult: value => {
              if (!['REVISE', 'NO_CHANGE', 'ESCALATE'].includes(value.disposition)) fail('BLUEPRINT_ACTION_REQUIRED', {
                path: '/disposition', reason: 'Submit a REVISE change record, NO_CHANGE, or ESCALATE with reasons.' })
              const submission = revisionProposalSchema.parse(value)
              if (submission.disposition === 'REVISE') {
                const missing = !submission.taskGraph ? '/taskGraph' : !submission.contextGraph ? '/contextGraph' : !submission.evidenceIds.length ? '/evidenceIds' : null
                if (missing) fail('BLUEPRINT_CHANGE_RECORD_REQUIRED', { path: missing, reason: 'Submit the complete candidate graphs with the reason and cited evidence IDs in this same change record.' })
                if (input.snapshot.supervisionReview?.mode === 'report-scoped-v1')
                  validationBoundary({ path: '/modificationReport' }, () => modificationReportSchema.parse(submission.modificationReport))
              }
              checkRevisionProgress(outlook, submission.disposition, '/disposition', graphState)
              return submission
            } })
          }
        }
        return directRevisionRole(runner, { ...request, sourceAgent, validateOutput: true })
      },
    }).run({ expectedRevision, facts, reason, feedback, signal,
      roleRunIds: blockage ? roleRunIds : resumableRoles?.base === runner.graph.read().checksum ? resumableRoles.runs : undefined })
  } catch (error) {
    if (!blockage && error.code === 'DIRECT_TOOL_ERROR_BLOCKED' && Object.values(runs).includes(error.details.runId)) {
      error.details = { ...error.details, revisionRoles: { base: runner.graph.read().checksum, runs } }
    }
    throw error
  }
  const file = path.join(runner.config.directory, 'revisions', 'decision-' + randomUUID() + '.json')
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  save(file, result)
  return result
}

/** Explicit revision entry for workflows using the earlier contract. */
export async function reviseWorkflow(runner, { expectedRevision, evidence, reason, sourceAgent, signal = new AbortController().signal } = {}) {
  if (runner.config.supervision) fail('SUPERVISION_REVISION_SIGNAL_REQUIRED')
  if (!runner.config.revision || runner.config.transport !== 'direct' || runner.closed || runner.busy) fail('REVISION_UNAVAILABLE_OR_BUSY')
  runner.busy = true
  const control = new AbortController(), abort = () => control.abort(signal.reason)
  signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort()
  let lease, drained
  runner.drained = new Promise(resolve => { drained = resolve })
  runner.current = { dispose: async () => control.abort(new Error('DYNAMIC_CONTEXT_RUNNER_CLOSED')) }
  try {
    lease = await acquireDirectLease(runner.config.directory)
    const privateRoots = [runner.config.directory, ...(runner.config.direct.runtime?.privateReadRoots ?? [])]
    const facts = artifactFacts(runner.config.projectRoot, evidence, control.signal, privateRoots)
    return await runJointRevision(runner, { expectedRevision, facts, reason, sourceAgent, signal: control.signal,
      verifyFacts: facts => verifyArtifactFacts(runner.config.projectRoot, facts, control.signal, privateRoots) })
  } finally {
    signal.removeEventListener('abort', abort); await lease?.release()
    runner.current = null; runner.busy = false; drained()
  }
}
