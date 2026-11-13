// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { fetch } from 'undici'
import { digest, view, GraphError } from 'dsh-bettertaskgraphs/core'
import { ZodError } from 'zod'
import { RevisionCoordinator, planDefinition } from './revision.mjs'
import { artifactFacts, verifyArtifactFacts, revisionAuthority } from './revision-host.mjs'
import { directAuthHeaders } from './direct-auth.mjs'
import { apiParameters, measureInput } from './api-protocol.mjs'
import { readCompletion } from './direct-http.mjs'
import { acquireDirectLease } from './durable-store.mjs'
import { fail, describeContextBindings } from './core.mjs'
import { artifactProof, realProjectPath } from './artifacts.mjs'
import { supervisionSemantics } from './supervision-semantics.mjs'
import { createRoleContext, rolePressureTokens, roleWindow } from './role-context.mjs'
import { executionReportHistory, REPORT_PROTOCOL } from './report-evidence.mjs'

function save(file, value) {
  const fd = fs.openSync(file + '.tmp', fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600)
  try { fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  fs.renameSync(file + '.tmp', file)
  const directory = fs.openSync(path.dirname(file), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY)
  try { fs.fsyncSync(directory) } finally { fs.closeSync(directory) }
}
export function contextDefinition(state) {
  const contexts = new Map(state.contexts.nodes.map(node => [node.id, node.key]))
  const tasks = new Map(state.graph.state.plan.nodes.map(node => [node.id, node.key]))
  return { nodes: state.contexts.nodes.map(({ key, content, parents }) => ({ key, content, parents: parents.map(id => contexts.get(id)) })),
    bindings: state.contexts.bindings.map(row => ({ task: tasks.get(row.taskId), instruction: row.instruction,
      contexts: row.contexts.map(id => contexts.get(id)), inheritReports: row.inheritReports.map(id => tasks.get(id)), tools: row.tools,
      ...(row.completion ? { completion: row.completion } : {}) })) }
}
const uncertainRole = phase => ['MODEL_PENDING', 'RESPONSE_RECEIVED', 'UNKNOWN_NO_REPLAY'].includes(phase)
const roleId = /^revision_(updater|reviewer|result_check|plan_check|result_repair)_[a-f0-9-]{36}$/
export function readRoleRecord(runner, runId) {
  if (!roleId.test(runId)) fail('REVISION_RECOVERY_SCOPE_REQUIRED')
  const file = path.join(runner.config.directory, 'revisions', runId, 'role.json')
  if (!fs.existsSync(file)) return null
  const record = JSON.parse(fs.readFileSync(realProjectPath(runner.config.storageRoot ?? runner.config.projectRoot, file, { directory: false })))
  if (record.runId !== runId || digest(record.payload) !== record.requestHash) fail('REVISION_RECOVERY_RECORD_CHANGED')
  for (const call of record.calls ?? []) {
    if (digest(call.payload) !== call.requestHash || call.response && digest(call.response) !== call.responseHash) fail('REVISION_RECOVERY_RECORD_CHANGED')
  }
  return record
}
export function revisionRecoveryState(runner) {
  if (!runner.config.revision) return []
  const directory = path.join(runner.config.directory, 'revisions'), pending = []
  for (const entry of fs.existsSync(directory) ? fs.readdirSync(directory, { withFileTypes: true }) : []) {
    if (!entry.isDirectory()) continue
    const file = path.join(directory, entry.name, 'role.json')
    if (!fs.existsSync(file)) continue
    const record = JSON.parse(fs.readFileSync(file))
    if (uncertainRole(record.phase)) pending.push({ runId: record.runId,
      role: record.role, phase: record.phase, requestHash: record.requestHash, requiresTrustedReconciliation: true })
  }
  return pending
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
    const before = fs.readFileSync(file), record = JSON.parse(before)
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
        || !Array.isArray(attestation.evidence) || !attestation.evidence.length || attestation.evidence.length > 4) fail('REVISION_RECOVERY_NOT_ATTESTED')
    for (const ref of attestation.evidence) {
      if (ref.kind !== 'artifact') fail('REVISION_RECOVERY_ARTIFACT_REQUIRED')
      artifactProof(storageRoot, ref, control.signal)
    }
    if (runner.reconciliationVerifier !== verifier || runner.graph.read().checksum !== state.checksum
        || !fs.readFileSync(file).equals(before)) fail('REVISION_RECOVERY_RECORD_CHANGED')
    const archive = path.join(path.dirname(file), `before-reconciliation-${randomUUID()}.json`)
    fs.copyFileSync(file, archive, fs.constants.COPYFILE_EXCL)
    const fd = fs.openSync(archive, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
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
  const { config, ctx } = runner, { direct } = config, { runId, role, messages, signal } = request
  const directory = path.join(config.directory, 'revisions', runId)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const payload = { ...direct.generation, ...apiParameters(direct), model: config.model, messages,
    max_tokens: config.revision.maxOutputTokens, response_format: { type: 'json_object' }, stream: true, stream_options: { include_usage: true } }
  const record = { role, runId, phase: 'PREPARED', requestHash: digest(payload), payload, calls: [] }
  const prior = readRoleRecord(runner, runId)
  if (prior) {
    if (prior.role !== role || prior.requestHash !== record.requestHash) fail('REVISION_ROLE_INPUT_CHANGED')
    if (prior.phase === 'COMPLETE') {
      const result = JSON.parse(prior.response.text)
      if (prior.response.finish !== 'stop' || prior.response.message.tool_calls?.length || digest(result) !== prior.resultHash)
        fail('REVISION_ROLE_RECEIPT_INVALID')
      return result
    }
    if (!['PREPARED', 'NOT_SENT'].includes(prior.phase)) fail('REVISION_ROLE_REQUIRES_RECONCILIATION')
  }
  save(path.join(directory, 'role.json'), record)
  const spec = roleWindow(config)
  const persist = () => save(path.join(directory, 'role.json'), record)
  const call = async (wirePayload, details) => {
    const request = { sequence: record.calls.length + 1, ...details, phase: 'PREPARED',
      requestHash: digest(wirePayload), payload: wirePayload }
    record.calls.push(request); persist()
    const headers = await directAuthHeaders(ctx, direct, signal), body = JSON.stringify(wirePayload)
    if (direct.maxRequestBytes !== null && Buffer.byteLength(body) > direct.maxRequestBytes) fail('DIRECT_REQUEST_BYTE_LIMIT')
    const measured = await measureInput(runner.inputMeter, wirePayload, signal, config.maxInputTokens)
    request.inputMeasurement = measured ?? { tokens: rolePressureTokens(wirePayload), method: 'utf8-byte-bound' }
    if (spec && rolePressureTokens(wirePayload, measured) + wirePayload.max_tokens > spec.contextWindow) fail('REVISION_CONTEXT_WINDOW_EXCEEDED_BEFORE_SEND')
    const metadata = { runId, role, directory, sequence: request.sequence, ...details }
    await runner.revisionAccounting?.beforeRequest?.(wirePayload, metadata)
    signal.throwIfAborted()
    request.phase = 'MODEL_PENDING'; record.phase = 'MODEL_PENDING'; persist()
    try {
      const response = await fetch(direct.endpoint, { method: 'POST', redirect: 'error', signal,
        headers: { 'content-type': 'application/json', ...headers }, body })
      const completed = await readCompletion(response, { signal, model: config.model, direct,
        maxResponseBytes: direct.maxResponseBytes, onProgress: runner.inputMeter?.observe })
      request.response = completed; request.responseHash = digest(completed); request.phase = 'RESPONSE_RECEIVED'
      record.phase = 'RESPONSE_RECEIVED'; persist()
      await runner.revisionAccounting?.afterResponse?.(completed, metadata)
      request.phase = 'COMPLETE'; persist()
      return completed
    } catch (error) {
      request.error = error.code ?? error.message
      request.phase = request.response ? 'RESPONSE_RECEIVED' : 'UNKNOWN_NO_REPLAY'
      if (error.directReceipt) request.transportReceipt = error.directReceipt
      if (error.providerError) request.providerError = error.providerError
      persist()
      await runner.revisionAccounting?.onFailure?.(error, metadata)
      throw error
    }
  }
  const context = createRoleContext({ config, messages, directory, call, signal,
    measureTokens: async payload => rolePressureTokens(payload, await measureInput(runner.inputMeter, payload, signal)) })
  try {
    for (;;) {
      const prepared = await context.prepare()
      record.context = context.snapshot(); persist()
      const completed = await call(prepared, { purpose: role })
      if (completed.finish === 'tool_calls') {
        await context.continueRead(completed)
        record.context = context.snapshot(); persist()
        continue
      }
      record.response = completed; persist()
      if (completed.finish !== 'stop' || completed.message.tool_calls?.length) fail('REVISION_ROLE_TOOLS_FORBIDDEN')
      const value = JSON.parse(completed.text)
      record.phase = 'COMPLETE'; record.resultHash = digest(value); persist()
      return value
    }
  } catch (error) {
    record.error = error.code ?? error.message
    record.phase = record.calls.some(call => ['MODEL_PENDING', 'UNKNOWN_NO_REPLAY', 'RESPONSE_RECEIVED'].includes(call.phase)) ? 'UNKNOWN_NO_REPLAY'
      : record.calls.some(call => call.phase === 'COMPLETE') ? 'INVALID_RESPONSE' : 'NOT_SENT'
    if (error.directReceipt) record.transportReceipt = error.directReceipt
    if (error.providerError) record.providerError = error.providerError
    record.context = context.snapshot(); persist()
    throw error
  }
}

export function revisionSnapshot(runner) {
  const state = runner.graph.read()
  if (!state) fail('CONTEXT_GRAPH_NOT_SUBMITTED')
  const contextGraph = contextDefinition(state)
  const task = id => state.graph.state.plan.nodes.find(node => node.id === id).key
  const graphView = view(state.graph)
  // Large immutable node text precedes changing state on the wire. The complete
  // graph and state remain present; this changes order only, not authority.
  const snapshot = { contextGraph,
    contextHashes: Object.fromEntries(contextGraph.nodes.map(node => [node.key, digest(node)])),
    taskGraph: planDefinition(state.graph.state.plan),
    revision: state.revision, checksum: state.checksum, linked: true, active: state.graph.state.active,
    hostAllowedTools: [...runner.config.allowedTools],
    taskStates: Object.fromEntries(state.graph.state.plan.nodes.filter(node => node.kind === 'leaf').map(node => [node.key, state.graph.state.leaves[node.id]])),
    execution: state.graph.state.leaves, reports: state.reports.map(report => ({ ...report, task: task(report.taskId) })),
    invalidatedReports: (state.invalidatedReports ?? []).map(task),
    ...(state.supervision ? {
      contextUse: describeContextBindings(state.contexts, state.graph.state.plan, state.graph.state.leaves),
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
        runtimeSemantics: supervisionSemantics,
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
    snapshot.planningRecord = state.planningRecord ?? { status: 'NOT_PROVIDED' }
    snapshot.supervisionReview.mode = REPORT_PROTOCOL
    snapshot.supervisionReview.artifactVerification = 'Acceptance host checks directory membership, hashes and selected test receipt quotes. Planning/revision uses reported results, not tool logs or assembly failures.'
  }
  return snapshot
}

/** The caller holds the workflow lease through the final compare-and-swap. */
export async function runJointRevision(runner, { expectedRevision, facts, verifyFacts, reason, feedback, sourceAgent, signal }) {
  if (revisionRecoveryState(runner).length) fail('REVISION_UNKNOWN_ROLE_REQUIRES_RECONCILIATION')
  if (runner.config.supervision && runner.graph.read().supervision.phase !== 'REVISE') fail('SUPERVISION_REVISION_SIGNAL_REQUIRED')
  const checkTools = proposal => {
    runner.graph.expandRevision(proposal)
    for (const row of proposal.contextGraph.bindings) {
      if (row.tools.some(name => !runner.config.allowedTools.includes(name))) fail('CONTEXT_CANNOT_GRANT_TOOL_PERMISSION')
      if (!runner.config.direct.runtime && row.tools.some(name => !runner.config.direct.agentlessTools.includes(name)))
        fail('DIRECT_TOOL_REQUIRES_EXPLICIT_AGENTLESS_PERMISSION')
    }
  }
  const adapter = {
    snapshot: () => revisionSnapshot(runner),
    authority: () => sourceAgent ? revisionAuthority(runner.ctx, sourceAgent) : { hostConfig: digest(runner.config) },
    verifyFacts,
    ...(runner.config.supervision ? { rejectProposal(error, calls) {
      const updater = calls.find(call => call.role === 'updater')
      const receipt = updater && readRoleRecord(runner, updater.runId)
      if (!receipt || !['COMPLETE', 'INVALID_RESPONSE'].includes(receipt.phase) || receipt.response?.finish !== 'stop') throw error
      // Environment and implementation failures are not defects a model can
      // repair by proposing another graph. Keep them visible to the host.
      if (!(error instanceof GraphError || error instanceof ZodError
          || error.name === 'DynamicContextError' && typeof error.code === 'string'
          || error instanceof SyntaxError && receipt.phase === 'INVALID_RESPONSE')) throw error
      return { status: 'REJECT', stage: 'PROGRAM', error: error.message ?? error.code, roles: calls }
    } } : {}),
    prepare(proposal) { checkTools(proposal); return runner.graph.prepareRevision(proposal) },
    describePrepared(prepared) {
      return describeContextBindings(prepared.contexts, prepared.plan, runner.graph.read().graph.state.leaves)
    },
    revalidate(prepared, proposal) {
      checkTools(proposal)
      if (runner.graph.read().checksum !== prepared.baseChecksum) fail('REVISION_STALE_BASE')
    },
    commit(prepared, review) {
      const result = runner.graph.commitRevision({ expectedRevision, prepared, review })
      runner.publish('revised')
      return result
    },
  }
  const result = await new RevisionCoordinator({ adapter, policy: runner.config.revision.policy,
    runRole: request => directRevisionRole(runner, request),
  }).run({ expectedRevision, facts, reason, feedback, signal })
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
