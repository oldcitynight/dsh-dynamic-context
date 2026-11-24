// SPDX-License-Identifier: GPL-3.0-only
import { runtimeRules } from 'dsh-better-task-grapth/rules'
import { isHierarchical, hierarchyComplete } from 'dsh-better-task-grapth/hierarchy'
import { hierarchyControlSchema, finalReportReceiptSchema } from './hierarchy-protocol.mjs'
import { z } from 'zod'
import { verificationPlanSchema, verificationClaimSchema, deliverySchema, evidenceBindingSchema, acceptanceEnabled } from './acceptance-protocol.mjs'
import { canonical, GraphError } from 'dsh-better-task-grapth/core'
import { DIRECTORY_HASH_SCHEME } from './directory-evidence.mjs'
import { blockageSituation } from './blockage-protocol.mjs'

const nonempty = z.string().refine(value => value.trim().length > 0)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const id = z.string().regex(/^[a-z][a-z0-9_-]{0,79}$/)
const revision = z.number().int().positive()
const fail = code => { throw new GraphError(code) }

export const artifactReference = z.object({ kind: z.literal('artifact'), ref: nonempty, sha256: hash }).strict()
export const planningReportSchema = z.object({ understanding: nonempty, assumptions: z.array(nonempty),
  design: nonempty, acceptanceStrategy: nonempty, verification: verificationPlanSchema.optional() }).strict()
export const directoryReportSchema = z.object({ path: nonempty, subdirectories: z.array(nonempty).default([]),
  files: z.array(z.object({ path: nonempty, sha256: hash }).strict()).optional(),
  hashScheme: z.literal(DIRECTORY_HASH_SCHEME).optional(), sha256: hash.optional(),
}).strict().superRefine((value, ctx) => {
  const issue = (field, message) => ctx.addIssue({ code: 'custom', path: [field], message })
  if (value.hashScheme !== undefined || value.sha256 !== undefined) {
    if (!value.hashScheme) issue('hashScheme', 'Directory SHA requires hashScheme from the host snapshot receipt.')
    if (!value.sha256) issue('sha256', 'Copy the directory SHA from the host snapshot receipt.')
    if (value.files !== undefined) issue('files', 'Choose directory SHA or a recursive manifest for this row; do not mix both formats.')
    if (value.subdirectories.length) issue('subdirectories', 'Directory SHA already includes every descendant directory; omit this manifest field.')
  } else if (!value.files) issue('files', 'Provide a recursive files manifest, or the directory hashScheme and sha256 from dynamic_context_directory_snapshot.')
})
export const executionReportSchema = z.object({ workHistory: z.array(nonempty),
  results: z.array(z.object({ criterion: nonempty, result: nonempty, artifactRefs: z.array(nonempty), testIds: z.array(id) }).strict()),
  directories: z.array(directoryReportSchema),
  tests: z.array(z.object({ id, criterion: nonempty, status: z.enum(['PASS', 'FAIL', 'NOT_RUN']),
    expected: nonempty, observed: nonempty, callId: nonempty.optional(), quote: nonempty.optional(), evidence: evidenceBindingSchema.optional() }).strict()),
  limitations: z.array(nonempty), verification: z.array(verificationClaimSchema).optional(), delivery: deliverySchema.optional(),
}).strict()
export const completionSchema = z.object({ kind: z.enum(['report', 'artifact']), path: nonempty.optional() })
  .strict().refine(value => (value.kind === 'artifact') === Boolean(value.path))
export const reportSchema = z.object({ taskId: id, attemptId: id, sessionId: nonempty, contextVersion: hash,
  text: nonempty, repairRunId: id.optional(), acceptance: z.literal('UNVERIFIED_MODEL_REPORT'), evidence: z.array(artifactReference).min(1),
}).strict()
export const dispositionSchema = z.object({ outcome: z.enum(['COMPLETE', 'BLOCKED', 'PASS', 'FAILED']), summary: nonempty,
  artifacts: z.array(artifactReference).default([]), failedCallId: nonempty.optional(),
  executionReport: executionReportSchema.optional(),
}).strict()
const checkReceipt = z.object({ runId: id, requestHash: hash, resultHash: hash, submissionHash: hash, acceptanceSnapshotHash: hash.optional() }).strict()
export const supervisionSchema = z.object({
  phase: z.enum(['READY', 'CHECK_RESULT', 'REPAIR_RESULT', 'REWORK_RESULT', 'CHECK_PLAN', 'REVISE', 'HIERARCHY']),
  hierarchy: hierarchyControlSchema.optional(),
  routedUnit: z.object({ taskId: id, revision, runId: id, authorityHash: hash }).strict().optional(),
  rootReferral: z.object({ runId: id, reason: nonempty }).strict().optional(),
  finalReport: finalReportReceiptSchema.optional(),
  outcomes: z.array(z.object({
    taskId: id, attemptId: id, revision, contextVersion: hash, authorityHash: hash,
    result: dispositionSchema, evidence: z.array(artifactReference).min(1),
    check: checkReceipt.nullable(),
  }).strict()),
  pending: z.object({ report: reportSchema, authorityHash: hash }).strict().optional(),
  feedback: nonempty.optional(),
  correction: z.object({ id, route: z.enum(['WORK', 'PLAN']), previousReport: reportSchema }).strict().optional(),
  roleRunId: id.optional(),
  revisionFeedback: z.object({ stage: z.enum(['PROGRAM', 'AUDIT']), updaterRunId: id, updaterHash: hash,
    reviewerRunId: id.optional(), reviewerHash: hash.optional(), programError: nonempty.optional(),
  }).strict().refine(value => value.stage === 'AUDIT'
    ? Boolean(value.reviewerRunId && value.reviewerHash) && !value.programError
    : Boolean(value.programError) && !value.reviewerRunId && !value.reviewerHash).optional(),
  signal: z.object({ revision, contextVersion: hash, attemptId: id, runId: id }).strict().optional(),
}).strict()

export function validateSupervision(state) {
  const control = state.supervision
  if (!control) return
  const { phase, outcomes, pending, feedback, roleRunId, signal } = control
  const active = state.graph.state.active
  if (control.routedUnit && (!state.unitRoleVersion || phase !== 'READY' || active || control.routedUnit.revision !== state.revision
      || !state.graph.state.leaves[control.routedUnit.taskId])) fail('UNIT_ROUTE_RECEIPT_INVALID')
  if (control.rootReferral && (phase !== 'READY' || active || isHierarchical(state.graph.state.plan))) fail('ROOT_UPDATE_REFERRAL_INVALID')
  if ((phase === 'HIERARCHY' || control.hierarchy || control.finalReport) && !isHierarchical(state.graph.state.plan)) fail('HIERARCHY_POLICY_REQUIRED')
  if (phase === 'HIERARCHY' && active || control.hierarchy && phase !== 'HIERARCHY') fail('HIERARCHY_PHASE_INVALID')
  if (control.finalReport && (!(state.graph.state.plan.hierarchy?.version === 2 ? ['PASS', 'FAILED'].includes(runtimeRules(state.graph.state).outcome(state.graph.state.plan.nodes.find(node => node.parent === null).id)) : hierarchyComplete(state.graph.state, state.graph.state.plan.nodes.find(node => node.parent === null).id)) || phase !== 'READY')) fail('HIERARCHY_REPORT_BEFORE_ACCEPTANCE')
  if ((phase === 'REWORK_RESULT') !== Boolean(control.correction) || control.correction && (!acceptanceEnabled(state) || !feedback)) fail('SUPERVISION_CORRECTION_INVALID')
  if (control.correction && canonical(control.correction.previousReport) !== canonical(pending?.report)) fail('SUPERVISION_CORRECTION_SOURCE_MISMATCH')
  const checkingResult = phase === 'CHECK_RESULT' || phase === 'REPAIR_RESULT' || phase === 'REWORK_RESULT'
  if (checkingResult !== Boolean(pending)
      || checkingResult && (pending.report.taskId !== active?.nodeId || pending.report.attemptId !== active?.attemptId
        || pending.report.contextVersion !== state.contexts.version)
      || phase === 'REPAIR_RESULT' && !feedback
      || (phase === 'READY' || phase === 'REVISE') && roleRunId
      || control.revisionFeedback && phase !== 'REVISE'
      || (phase === 'REVISE') !== Boolean(signal)) fail('SUPERVISION_PHASE_INVALID')
  if (phase === 'CHECK_PLAN' || phase === 'REVISE') {
    const last = outcomes.at(-1)
    if (active || last?.revision !== state.revision || last.contextVersion !== state.contexts.version
        || signal && (signal.revision !== state.revision || signal.contextVersion !== last.contextVersion
          || signal.attemptId !== last.attemptId)) fail('SUPERVISION_PLAN_BASE_INVALID')
  }
  if (state.contexts.bindings.some(binding => !binding.completion)) fail('SUPERVISED_LEAF_COMPLETION_REQUIRED')
  const terminal = state.graph.events.filter(event => ['FINISHED', 'RECONCILED'].includes(event.type))
  if (terminal.length !== outcomes.length) fail('SUPERVISION_OUTCOMES_INCOMPLETE')
  for (const [index, entry] of outcomes.entries()) {
    const event = terminal[index]
    if (entry.revision !== event.seq || entry.taskId !== event.data.nodeId || entry.attemptId !== event.data.attemptId
        || canonical(entry.evidence) !== canonical(event.data.evidence)
        || (['COMPLETE','PASS'].includes(entry.result.outcome)) !== (event.data.outcome === 'complete')
        || entry.result.outcome === 'FAILED' && event.data.disposition !== 'FAILED'
        || Boolean(entry.check) !== (event.type === 'FINISHED')) fail('SUPERVISION_OUTCOME_NOT_COMMITTED')
  }
}

export function checkSupervisionUpdate(previous, next) {
  const before = previous.supervision, after = next.supervision
  if (!before && !after) return
  if (!before || !after) fail('SUPERVISION_CONFIGURATION_CHANGED')
  if (before.finalReport && canonical(before.finalReport) !== canonical(after.finalReport)) fail('FINAL_REPORT_IMMUTABLE')
  if (previous.revision === next.revision) {
    const transitions = { READY: ['CHECK_RESULT', 'CHECK_PLAN', 'REVISE'], CHECK_RESULT: ['CHECK_RESULT', 'REPAIR_RESULT'],
      REPAIR_RESULT: ['REPAIR_RESULT', 'CHECK_RESULT'], CHECK_PLAN: ['CHECK_PLAN', 'READY', 'REVISE'], REVISE: ['REVISE', 'READY'] }
    if (acceptanceEnabled(previous)) { transitions.CHECK_RESULT.push('REWORK_RESULT'); transitions.REWORK_RESULT = ['REWORK_RESULT', 'CHECK_RESULT'] }
    if (isHierarchical(previous.graph.state.plan)) { transitions.HIERARCHY = ['HIERARCHY', 'READY']; transitions.READY.push('HIERARCHY') }
    if (!transitions[before.phase].includes(after.phase) || canonical(before.outcomes) !== canonical(after.outcomes))
      fail('SUPERVISION_TRANSITION_INVALID')
    if (after.routedUnit) {
      const flow = before.hierarchy
      const router = flow?.stage === 'UNIT_ROUTE' ? before.roleRunId : flow?.stage === 'UPDATE' ? flow.routeRunId : null
      if (flow?.routeTaskId !== after.routedUnit.taskId || router !== after.routedUnit.runId
          || flow.routeAuthority !== after.routedUnit.authorityHash) fail('UNIT_ROUTE_RECEIPT_INVALID')
    }
    if (before.phase === 'REWORK_RESULT' && after.phase === 'REWORK_RESULT' && canonical(before.correction) !== canonical(after.correction)) fail('SUPERVISION_CORRECTION_IMMUTABLE')
    if (before.phase === 'REVISE' && after.phase === 'REVISE' && canonical(before.signal) !== canonical(after.signal))
      fail('SUPERVISION_REVISION_SIGNAL_CHANGED')
    return
  }
  const event = next.graph.events.at(-1)
  if (event.type === 'SUSPENDED') {
    const { outcomes, ...control } = before
    if (!['READY', 'REWORK_RESULT'].includes(before.phase) || after.phase !== 'READY' || canonical(outcomes) !== canonical(after.outcomes)
        || canonical(control) !== canonical(event.data.metadata.supervision)) fail('SUPERVISION_SUSPENSION_INVALID')
    return
  }
  if (event.type === 'SUSPENSION_RESOLVED') {
    const expected = event.data.mode === 'resume' ? { ...previous.graph.state.suspended.metadata.supervision, outcomes: before.outcomes } : before
    if (before.phase !== 'READY' || canonical(after) !== canonical(expected)) fail('SUPERVISION_SUSPENSION_INVALID')
    return
  }
  if (event.type === 'FINISHED' || event.type === 'RECONCILED') {
    if ((event.type === 'FINISHED' ? before.phase !== 'CHECK_RESULT' : !['READY', ...(acceptanceEnabled(previous) ? ['REWORK_RESULT'] : [])].includes(before.phase))
        || after.phase !== (isHierarchical(previous.graph.state.plan) ? 'HIERARCHY' : 'CHECK_PLAN') || after.outcomes.length !== before.outcomes.length + 1
        || canonical(after.outcomes.slice(0, -1)) !== canonical(before.outcomes)
        || event.type === 'FINISHED' && after.outcomes.at(-1).check?.runId !== before.roleRunId)
      fail('SUPERVISION_RESULT_COMMIT_REQUIRED')
  } else if (event.type === 'BEGUN' && previous.unitRoleVersion) {
    const { routedUnit, ...expected } = before
    if (routedUnit?.taskId !== event.data.nodeId || routedUnit.revision !== previous.revision
        || canonical(after) !== canonical(expected)) fail('UNIT_ROUTE_REQUIRED')
  } else if (event.type === 'REVISED') {
    const exception = event.data.review.blockageSignal
    const fromBlockage = exception && before.phase === 'READY' && blockageSituation(previous)
      && exception.baseChecksum === previous.checksum && /^blockage_[a-f0-9-]{36}$/.test(exception.roundId)
      && /^revision_blockage_[a-f0-9-]{36}$/.test(exception.runId)
      && /^[a-f0-9]{64}$/.test(exception.requestHash) && /^[a-f0-9]{64}$/.test(exception.resultHash)
    const hierarchical = isHierarchical(previous.graph.state.plan) && before.phase === 'HIERARCHY' && before.hierarchy?.stage === 'UPDATE_AUDIT'
      && event.data.review.scopeSignal?.scopeId === before.hierarchy.scopeId
      && event.data.review.scopeSignal?.proposalHash === before.hierarchy.proposalHash
    if ((!fromBlockage && !hierarchical && before.phase !== 'REVISE') || after.phase !== (hierarchical ? 'HIERARCHY' : 'READY') || canonical(before.outcomes) !== canonical(after.outcomes))
      fail('SUPERVISION_REVISION_SIGNAL_REQUIRED')
  } else if (isHierarchical(previous.graph.state.plan) && ['SCOPE_REVIEWED', 'REOPENED'].includes(event.type) && before.phase === 'HIERARCHY') {
    if (event.type === 'SCOPE_REVIEWED' && event.data.runId !== before.roleRunId) fail('HIERARCHY_GATE_ROLE_MISMATCH')
    if (after.phase !== (event.type === 'REOPENED' ? 'READY' : 'HIERARCHY') || canonical(before.outcomes) !== canonical(after.outcomes)) fail('HIERARCHY_GATE_TRANSITION_INVALID')
  } else if (event.type === 'REOPENED' && before.rootReferral && before.phase === 'READY') {
    const { rootReferral, ...rest } = before
    if (canonical(rest) !== canonical(after)) fail('SUPERVISION_SCHEDULING_BLOCKED')
  } else if (before.phase !== 'READY' || canonical(before) !== canonical(after)) fail('SUPERVISION_SCHEDULING_BLOCKED')
}
