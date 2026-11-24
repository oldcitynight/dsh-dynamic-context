import { currentPlanningRecord } from './acceptance-protocol.mjs'
// SPDX-License-Identifier: GPL-3.0-only
import { hasStored, readStored, writeStored } from './workflow-io.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { digest } from 'dsh-better-task-grapth/core'
import { located, parseModelJSON } from 'dsh-better-task-grapth/validation'
import { fail } from './core.mjs'
import { acquireDirectLease } from './durable-store.mjs'
import { supervisionAuthority, assertAuthority } from './supervision-runtime.mjs'
import { applicableGuidance } from './guidance-state.mjs'
import { directRevisionRole, readRoleRecord, roleRecordValue, revisionRecoveryState, runJointRevision } from './revision-runtime.mjs'
import { executionReportHistory } from './report-evidence.mjs'
import { validateReview, reviewFeedback } from './review-feedback.mjs'
import { blockageSituation, validateBlockageDecision, verifyReference, lookupPointer,
  BLOCKAGE_INSTRUCTION, WORKFLOW_PAUSE_AUDIT_INSTRUCTION, blockageTemplates, globalBlockageInstruction, globalBlockageDecisionSchema } from './blockage-protocol.mjs'
import { diagnoseBlockage, diagnosticInput, checkGlobalDecision } from './blockage-diagnosis.mjs'
import { readBlockage, saveBlockage, blockageCatalog, blockageInput, blockageTools } from './blockage-evidence.mjs'

const roleId = role => `revision_${role}_${randomUUID()}`
const messages = (instruction, input) => [{ role: 'system', content: instruction }, { role: 'user', content: JSON.stringify(input) }]
const decisionFile = (runner, id) => path.join(runner.config.directory, 'blockage', id + '.json')
function controlRecord(file) {
  const value = readBlockage(file)
  if (value && (value.version !== 1 || !/^blockage_[a-f0-9-]{36}$/.test(value.id)
      || !['ANALYZE','REWORK','REVISING','PAUSE_REVIEW','WAITING_USER','RESOLVED'].includes(value.phase)
      || !Array.isArray(value.decisions) || !/^[a-f0-9]{64}$/.test(value.baseChecksum)
      || !/^[a-f0-9]{64}$/.test(value.authorityHash) || !/^revision_blockage_[a-f0-9-]{36}$/.test(value.handlerRunId)))
    fail('BLOCKAGE_JOURNAL_INVALID', { path: '/blockage-control', reason: 'The saved exception journal is malformed; retain it for inspection instead of inferring a new decision.' })
  return value
}
export function blockageStatus(runner) {
  const control = controlRecord(path.join(runner.config.directory, 'blockage-control.json'))
  return control ? { phase: control.phase, roundId: control.id, baseChecksum: control.baseChecksum,
    rounds: control.decisions.length, ...(control.waitingReport ? { interruption: control.waitingReport } : {}) } : null
}

/** Only this new exception branch owns this journal. Normal execution never reads it. */
export async function handleBlockage(runner, { expectedRevision, baseChecksum, sourceAgent, resume = false,
  signal = new AbortController().signal } = {}) {
  if (!runner.config.supervision || !runner.config.revision || runner.config.transport !== 'direct' || runner.closed || runner.busy)
    fail('BLOCKAGE_UNAVAILABLE_OR_BUSY')
  signal.throwIfAborted()
  const abort = new AbortController(), combined = AbortSignal.any([signal, abort.signal])
  runner.busy = true
  let lease, drained
  runner.drained = new Promise(resolve => { drained = resolve })
  runner.current = { sourceAgent, dispose: async () => abort.abort(new Error('DYNAMIC_CONTEXT_RUNNER_CLOSED')) }
  try {
    lease = await acquireDirectLease(runner.config.directory)
    combined.throwIfAborted()
    const state = runner.graph.read(), situation = blockageSituation(state)
    if (!state || state.revision !== expectedRevision || state.checksum !== baseChecksum) fail('BLOCKAGE_STALE_BASE')
    const file = path.join(runner.config.directory, 'blockage-control.json')
    let control = controlRecord(file)
    // A process can stop after CAS but before writing its final journal marker.
    // Recognize only our exact durable mutation; never replay the old decision.
    if (control && control.baseChecksum !== state.checksum && control.phase !== 'RESOLVED') {
      const committed = state.graph.events.find(e => e.type === 'REOPENED' && e.data.decisionId === control.id
        || e.type === 'REVISED' && e.data.review.blockageSignal?.roundId === control.id
          && e.data.review.blockageSignal.baseChecksum === control.baseChecksum)
      if (!committed) fail('BLOCKAGE_STALE_JOURNAL')
      control.phase = 'RESOLVED'; control.resolvedRevision = committed.seq
      saveBlockage(file, control); saveBlockage(decisionFile(runner, control.id), control)
    }
    if (!situation) return { status: 'NOT_APPLICABLE' }
    if (control?.phase === 'WAITING_USER') {
      if (!resume) return { status: 'WAITING_USER', report: control.waitingReport }
      control.phase = 'RESOLVED'; control.manualResume = true
      saveBlockage(file, control); saveBlockage(decisionFile(runner, control.id), control)
    }
    if (!control || control.phase === 'RESOLVED') {
      control = { version: 1, protocolVersion: 2, id: 'blockage_' + randomUUID(), baseChecksum: state.checksum,
        ...(control?.manualResume && control.baseChecksum === state.checksum ? { manualReview: true } : {}),
        authorityHash: supervisionAuthority(runner, sourceAgent), phase: 'ANALYZE', decisions: [],
        handlerRunId: roleId('blockage') }
      saveBlockage(file, control)
    }
    const persist = () => { saveBlockage(file, control); saveBlockage(decisionFile(runner, control.id), control) }
    const ownedRoles = [control.handlerRunId, control.auditRunId, ...Object.values(control.revisionRuns ?? {})]
    if (revisionRecoveryState(runner).some(row => !runner.workflowControl?.recoverModel || !ownedRoles.includes(row.runId)))
      fail('BLOCKAGE_UNKNOWN_ROLE_REQUIRES_RECONCILIATION')
    const guidanceHash = digest(applicableGuidance(runner, 'blockage'))
    if (guidanceHash !== (control.guidanceHash ?? digest([]))) {
      control.guidanceGenerations ??= []
      control.guidanceGenerations.push({ guidanceHash: control.guidanceHash ?? digest([]), phase: control.phase,
        handlerRunId: control.handlerRunId, ...(control.auditRunId ? { auditRunId: control.auditRunId } : {}),
        ...(control.revisionRuns ? { revisionRuns: control.revisionRuns } : {}) })
      if (control.phase === 'ANALYZE') control.handlerRunId = roleId('blockage')
      if (control.phase === 'PAUSE_REVIEW') control.auditRunId = roleId('blockage_audit')
      if (control.phase === 'REVISING') control.revisionRuns = { updater: roleId('updater'), reviewer: roleId('reviewer') }
      control.guidanceHash = guidanceHash; persist()
    }
    const unchanged = () => {
      combined.throwIfAborted()
      if (runner.graph.read().checksum !== state.checksum) fail('BLOCKAGE_STALE_BASE')
      if (control.authorityHash !== supervisionAuthority(runner, sourceAgent)) assertAuthority(runner, control.authorityHash, sourceAgent, combined)
    }
    const diagnosis = control.protocolVersion === 2 ? diagnoseBlockage(state, situation, state.supervision.rootReferral) : null
    const catalog = blockageCatalog(runner, state, combined, diagnosis)
    const input = diagnosis ? { ...diagnosticInput(state, diagnosis), baseChecksum: state.checksum }
      : blockageInput(runner, state, situation, catalog)
    const rootReviewed = () => diagnosis && (Boolean(state.supervision.rootReferral && !control.manualReview) || control.decisions.some(row =>
      row.feedback?.stage === 'REVISION' && ['NO_CHANGE', 'ESCALATE'].includes(row.feedback.result?.status)))
    const validated = value => {
      if (!diagnosis) return validateBlockageDecision(value, { state, situation, catalog })
      const decision = globalBlockageDecisionSchema.parse(value)
      if (decision.action === 'REPLAN' && rootReviewed()) throw located('BLOCKAGE_SCOPE_ALREADY_REVIEWED', {
        path: '/action', reason: 'The blueprint was already reviewed in this episode. Choose evidence-backed rework or an audited pause.' })
      checkGlobalDecision({ ...decision, scopeId: diagnosis.rootId }, { state, diagnosis, catalog })
      return decision
    }
    const retry = feedback => {
      const signature = digest({ decision: control.decision, feedback })
      if (control.decisions.some(row => row.signature === signature)) fail('BLOCKAGE_NO_PROGRESS')
      control.decisions.push({ runId: control.handlerRunId, decision: control.decision, feedback, signature })
      control.feedback = { previousDecision: control.decision, ...feedback }
      delete control.decision; delete control.auditRunId; delete control.revisionRuns; delete control.revisionFeedback
      control.handlerRunId = roleId('blockage'); control.phase = 'ANALYZE'; persist()
    }
    for (;;) {
      unchanged()
      if (control.phase === 'ANALYZE') {
        const runId = control.handlerRunId
        const value = await directRevisionRole(runner, { runId, role: 'blockage', signal: combined, validateOutput: true,
          validateResult: validated, readOnlyTools: blockageTools(catalog, path.join(runner.config.directory, 'revisions', runId), combined),
          messages: messages(diagnosis ? globalBlockageInstruction(false) : BLOCKAGE_INSTRUCTION + '\n\n' + blockageTemplates,
            { ...input, ...(rootReviewed() ? { reviewedScopeIds: [diagnosis.rootId] } : {}), ...(control.feedback ? { priorReview: control.feedback } : {}) }) })
        unchanged(); control.decision = validated(value)
        control.phase = value.action === 'REWORK' ? 'REWORK' : value.action === 'REPLAN' ? 'REVISING' : 'PAUSE_REVIEW'
        persist()
      }
      const decision = validated(control.decision)
      const receipt = readRoleRecord(runner, control.handlerRunId)
      if (!receipt || receipt.phase !== 'COMPLETE' || receipt.resultHash !== digest(decision)
          || digest(validated(roleRecordValue(receipt))) !== digest(decision))
        fail('BLOCKAGE_DECISION_RECEIPT_CHANGED')
      if (control.phase === 'REWORK') {
        // Persist the exact decision BEFORE the graph CAS. Graph events reference
        // this immutable file; archive/retry never rewrites accepted reports.
        const proofFile = path.join(runner.config.directory, 'blockage', control.id + '-rework.json')
        const content = JSON.stringify({ roundId: control.id, baseChecksum: state.checksum,
          runId: control.handlerRunId, decision })
        if (hasStored(proofFile)) { if (readStored(proofFile, 'utf8') !== content) fail('BLOCKAGE_DECISION_CHANGED') }
        else {
          fs.mkdirSync(path.dirname(proofFile), { recursive: true, mode: 0o700 })
          if(!writeStored(proofFile,content,{exclusive:true})) {
          const fd = fs.openSync(proofFile, 'wx', 0o600)
          try { fs.writeFileSync(fd, content); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
          const dir = fs.openSync(path.dirname(proofFile), 'r'); try { fs.fsyncSync(dir) } finally { fs.closeSync(dir) }
          }
        }
        unchanged()
        const evidence = [{ kind: 'artifact', ref: proofFile, sha256: createHash('sha256').update(content).digest('hex') }]
        const result = runner.graph.reopenReports({ expectedRevision, baseChecksum, nodeIds: decision.report.findings.map(f => f.taskId),
          decisionId: control.id, evidence })
        control.phase = 'RESOLVED'; control.resolvedRevision = result.revision; persist(); runner.publish('reports-reopened')
        return { status: 'REWORKED', revision: result.revision, report: decision.report }
      }
      if (control.phase === 'PAUSE_REVIEW') {
        if (!control.auditRunId) { control.auditRunId = roleId('blockage_audit'); persist() }
        const evidence = decision.report.constraints.flatMap((c,i) => c.evidence.map((ref,j) => {
          const proof = verifyReference(ref, catalog, `/report/constraints/${i}/evidence/${j}`)
          return { ...proof, value: lookupPointer(catalog.get(ref.source).load(), ref.path) }
        }))
        const auditInput = { contract: runner.config.revision.policy, situation, submission: decision.report,
          evidence, programValidation: { referencesVerified: true, semanticTruth: 'NOT_EVALUATED' } }
        const validate = value => {
          const result = validateReview('reviewer', value, auditInput)
          if (result.verdict === 'APPROVE' && result.violations.length) fail('BLOCKAGE_PAUSE_UNRESOLVED_VIOLATIONS')
          return result
        }
        const review = validate(await directRevisionRole(runner, { runId: control.auditRunId, role: 'blockage_audit',
          messages: messages(WORKFLOW_PAUSE_AUDIT_INSTRUCTION, auditInput), signal: combined, validateOutput: true, validateResult: validate }))
        unchanged(); validated(decision)
        if (review.verdict !== 'APPROVE') { retry({ stage: 'PAUSE_AUDIT', review: JSON.parse(reviewFeedback(review, 'blockage-pause-audit')) }); continue }
        control.phase = 'WAITING_USER'; control.waitingReport = decision.report; control.pauseReview = review; persist()
        runner.publish('blockage-waiting-user')
        return { status: 'WAITING_USER', report: decision.report }
      }
      if (control.phase === 'REVISING') {
        if (!control.revisionRuns) { control.revisionRuns = { updater: roleId('updater'), reviewer: roleId('reviewer') }; persist() }
        const record = readRoleRecord(runner, control.handlerRunId)
        const blockage = { roundId: control.id, baseChecksum: state.checksum, runId: control.handlerRunId,
          requestHash: record.requestHash, resultHash: record.resultHash, ...(decision.reason ? { reason: decision.reason } : {}) }
        const facts = [...executionReportHistory(state).map((report,index) => ({ id: 'report_' + index, text: JSON.stringify(report) })),
          { id: 'planning', text: JSON.stringify(currentPlanningRecord(state) ?? { status: 'NOT_PROVIDED' }) },
          { id: 'contract', text: JSON.stringify(runner.config.revision.policy) }]
        const result = await runJointRevision(runner, { expectedRevision, facts, sourceAgent, signal: combined, blockage,
          roleRunIds: control.revisionRuns, feedback: control.revisionFeedback,
          reason: diagnosis ? '阻塞处理者已提交改图理由。核对 blockageSignal 及固定合同，避免进入 BLOCK。'
            : '阻塞处理者仅发出蓝图复核信号，不提供理由或方向。独立对照既往工作成果、双图、预规划记录和固定合同判断。',
          verifyFacts: unchanged })
        if (result.status === 'COMMITTED') {
          control.phase = 'RESOLVED'; control.resolvedRevision = result.revision; persist()
          return { status: 'REPLANNED', revision: result.revision }
        }
        unchanged()
        if (result.status === 'REJECT') {
          const feedback = { stage: result.stage ?? 'AUDIT', ...(result.proposal === undefined ? {} : { proposal: result.proposal }),
            ...(result.verdict ? { review: result.verdict } : { programError: result.error }) }
          if (digest(feedback) === digest(control.revisionFeedback ?? null)) fail('BLOCKAGE_REVISION_NO_PROGRESS')
          control.revisionFeedback = feedback
          control.decisions.push({ revisionRuns: control.revisionRuns, result })
          control.revisionRuns = { updater: roleId('updater'), reviewer: roleId('reviewer') }; persist(); continue
        }
        retry({ stage: 'REVISION', result }); continue
      }
      fail('BLOCKAGE_PHASE_INVALID')
    }
  } finally {
    await lease?.release(); runner.current = null; runner.busy = false; drained()
  }
}
