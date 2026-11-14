// SPDX-License-Identifier: GPL-3.0-only
import { z } from 'zod'
import { canonical, GraphError } from 'dsh-better-task-grapth/core'

const nonempty = z.string().refine(value => value.trim().length > 0)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const id = z.string().regex(/^[a-z][a-z0-9_-]{0,79}$/)
const revision = z.number().int().positive()
const fail = code => { throw new GraphError(code) }

export const artifactReference = z.object({ kind: z.literal('artifact'), ref: nonempty.max(512), sha256: hash }).strict()
export const planningReportSchema = z.object({ understanding: nonempty, assumptions: z.array(nonempty),
  design: nonempty, acceptanceStrategy: nonempty }).strict()
export const executionReportSchema = z.object({ workHistory: z.array(nonempty),
  results: z.array(z.object({ criterion: nonempty, result: nonempty, artifactRefs: z.array(nonempty), testIds: z.array(id) }).strict()),
  directories: z.array(z.object({ path: nonempty, subdirectories: z.array(nonempty).default([]), files: z.array(z.object({ path: nonempty, sha256: hash }).strict()) }).strict()),
  tests: z.array(z.object({ id, criterion: nonempty, status: z.enum(['PASS', 'FAIL', 'NOT_RUN']),
    expected: nonempty, observed: nonempty, callId: nonempty.optional(), quote: nonempty.optional() }).strict()),
  limitations: z.array(nonempty),
}).strict()
export const completionSchema = z.object({ kind: z.enum(['report', 'artifact']), path: nonempty.max(512).optional() })
  .strict().refine(value => (value.kind === 'artifact') === Boolean(value.path))
export const reportSchema = z.object({ taskId: id, attemptId: id, sessionId: nonempty.max(128), contextVersion: hash,
  text: nonempty, acceptance: z.literal('UNVERIFIED_MODEL_REPORT'), evidence: z.array(artifactReference).min(1).max(4),
}).strict()
export const dispositionSchema = z.object({ outcome: z.enum(['COMPLETE', 'BLOCKED', 'FAILED']), summary: nonempty,
  artifacts: z.array(artifactReference).default([]), failedCallId: nonempty.optional(),
  executionReport: executionReportSchema.optional(),
}).strict()
const checkReceipt = z.object({ runId: id, requestHash: hash, resultHash: hash, submissionHash: hash }).strict()
export const supervisionSchema = z.object({
  phase: z.enum(['READY', 'CHECK_RESULT', 'REPAIR_RESULT', 'CHECK_PLAN', 'REVISE']),
  outcomes: z.array(z.object({
    taskId: id, attemptId: id, revision, contextVersion: hash, authorityHash: hash,
    result: dispositionSchema, evidence: z.array(artifactReference).min(1).max(4),
    check: checkReceipt.nullable(),
  }).strict()),
  pending: z.object({ report: reportSchema, authorityHash: hash }).strict().optional(),
  feedback: nonempty.optional(),
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
  const checkingResult = phase === 'CHECK_RESULT' || phase === 'REPAIR_RESULT'
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
        || (entry.result.outcome === 'COMPLETE') !== (event.data.outcome === 'complete')
        || entry.result.outcome === 'FAILED' && event.data.disposition !== 'FAILED'
        || Boolean(entry.check) !== (event.type === 'FINISHED')) fail('SUPERVISION_OUTCOME_NOT_COMMITTED')
  }
}

export function checkSupervisionUpdate(previous, next) {
  const before = previous.supervision, after = next.supervision
  if (!before && !after) return
  if (!before || !after) fail('SUPERVISION_CONFIGURATION_CHANGED')
  if (previous.revision === next.revision) {
    const transitions = { READY: ['CHECK_RESULT'], CHECK_RESULT: ['CHECK_RESULT', 'REPAIR_RESULT'],
      REPAIR_RESULT: ['REPAIR_RESULT', 'CHECK_RESULT'], CHECK_PLAN: ['CHECK_PLAN', 'READY', 'REVISE'], REVISE: ['REVISE', 'READY'] }
    if (!transitions[before.phase].includes(after.phase) || canonical(before.outcomes) !== canonical(after.outcomes))
      fail('SUPERVISION_TRANSITION_INVALID')
    if (before.phase === 'REVISE' && after.phase === 'REVISE' && canonical(before.signal) !== canonical(after.signal))
      fail('SUPERVISION_REVISION_SIGNAL_CHANGED')
    return
  }
  const event = next.graph.events.at(-1)
  if (event.type === 'FINISHED' || event.type === 'RECONCILED') {
    if ((event.type === 'FINISHED' ? before.phase !== 'CHECK_RESULT' : before.phase !== 'READY')
        || after.phase !== 'CHECK_PLAN' || after.outcomes.length !== before.outcomes.length + 1
        || canonical(after.outcomes.slice(0, -1)) !== canonical(before.outcomes)
        || event.type === 'FINISHED' && after.outcomes.at(-1).check?.runId !== before.roleRunId)
      fail('SUPERVISION_RESULT_COMMIT_REQUIRED')
  } else if (event.type === 'REVISED') {
    if (before.phase !== 'REVISE' || after.phase !== 'READY' || canonical(before.outcomes) !== canonical(after.outcomes))
      fail('SUPERVISION_REVISION_SIGNAL_REQUIRED')
  } else if (before.phase !== 'READY' || canonical(before) !== canonical(after)) fail('SUPERVISION_SCHEDULING_BLOCKED')
}
